//! SESSION — splitting a tokenized equity into the hours arbitrage works
//! and the hours it does not.
//!
//! A tokenized share trades 24/7, but the stock behind it trades for 6.5 hours.
//! During those hours an arbitrageur can hedge the token against the real share
//! and the two stay pinned; outside them nobody can, and the token drifts. Those
//! are two different assets wearing one ticker, and this program separates them
//! into `X.NIGHT` and `X.DAY`.
//!
//! Exactly one class holds the stock at a time; the other holds quote. At each
//! session boundary the inventory changes hands, and because a day-holder wants
//! to be flat at precisely the instant a night-holder wants to be long, that
//! handoff is a book entry rather than a trade. Only the *difference in size*
//! between the two sides ever reaches a market.
//!
//! ## Safety model
//!
//! Every caller is assumed adversarial and every input hostile.
//!
//! - **Balances are tracked, never read.** Anyone can transfer into the vault's
//!   token accounts; a vault that derived its position from `amount` would
//!   absorb those transfers into its accounting. The excess is surplus, and
//!   surplus is skimmable, never spendable.
//! - **Solvency is asserted, not assumed.** Every value-moving instruction ends
//!   by proving assets still cover claims.
//! - **The session is tracked, never inferred.** See `machine.rs`.
//! - **Ambiguity halts.** When the vault cannot know who is owed what — a missed
//!   boundary, an unfilled handoff, a contradiction with the calendar — it stops
//!   and waits for an operator rather than guessing.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

pub mod calendar;
pub mod errors;
pub mod fixed;
pub mod funding;
pub mod machine;
pub mod ops;
pub mod oracle;
pub mod settle;
pub mod state;

use calendar::{session_at, Session};
use errors::SessionError;
use fixed::{mul_div_floor, WAD};
use machine::Decision;
use ops::OpError;
use oracle::{effective_session, parse_price_update, Quote};
use settle::{settle, value_of};
use state::*;

declare_id!("8gWC37AFvgnPMAZSqiimbkpqPVhF3PrA1rao5agVKqKZ");

/// The Pyth Solana Receiver. Every price account the vault reads must be owned
/// by this program, or it is just bytes somebody wrote.
pub const PYTH_RECEIVER: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

#[program]
pub mod session {
    use super::*;

    /// Create a vault for one underlying, with both share classes.
    pub fn initialize_vault(ctx: Context<InitializeVault>, p: VaultParams) -> Result<()> {
        p.validate()?;
        require_keys_neq!(
            ctx.accounts.underlying_mint.key(),
            ctx.accounts.quote_mint.key(),
            SessionError::BadParameter
        );
        require!(p.mark_feed_id != p.equity_feed_id, SessionError::BadParameter);
        require!(
            ctx.accounts.underlying_mint.decimals <= 18 && ctx.accounts.quote_mint.decimals <= 18,
            SessionError::BadParameter
        );

        let now = Clock::get()?.unix_timestamp;

        // Both feeds are read at creation, so a vault can never be initialised
        // pointing at an account that does not exist or does not match.
        let mark_q = read_quote(&ctx.accounts.mark_price_update, &p.mark_feed_id)?;
        let _equity_q = read_quote(&ctx.accounts.equity_price_update, &p.equity_feed_id)?;

        let v = &mut ctx.accounts.vault;
        v.version = VAULT_VERSION;
        v.bump = ctx.bumps.vault;
        v.authority = ctx.accounts.authority.key();
        v.pending_authority = Pubkey::default();

        v.underlying_mint = ctx.accounts.underlying_mint.key();
        v.quote_mint = ctx.accounts.quote_mint.key();
        v.underlying_vault = ctx.accounts.underlying_vault.key();
        v.quote_vault = ctx.accounts.quote_vault.key();
        v.underlying_decimals = ctx.accounts.underlying_mint.decimals;
        v.quote_decimals = ctx.accounts.quote_mint.decimals;
        v.owned_underlying = 0;
        v.owned_quote = 0;

        v.night_mint = ctx.accounts.night_mint.key();
        v.day_mint = ctx.accounts.day_mint.key();
        v.mark_feed_id = p.mark_feed_id;
        v.equity_feed_id = p.equity_feed_id;
        v.apply_params(&p);

        // Both classes start at parity: one quote atom buys one share atom.
        v.night_nav = WAD;
        v.day_nav = WAD;
        v.pending_delta = 0;
        v.cum_funding_night = 0;
        v.cum_fill_incentive = 0;
        v.total_minted_night = 0;
        v.total_minted_day = 0;
        v.boundary_count = 0;
        v.flags = 0;
        v.halted = false;
        v.halt_reason = HaltReason::None;

        v.last_mark = oracle::check_mark(
            &mark_q, now, 0, v.underlying_decimals, v.quote_decimals, &v.guards(),
        )
        .map_err(map_oracle)?;

        // Seed from the calendar so the first real boundary is a genuine flip
        // rather than an artefact of when the vault happened to be created.
        let s = session_at(now);
        v.set_last_session(s);
        v.exposed = class_for(s).into();
        v.last_boundary_ts = now;

        emit!(VaultInitialized {
            vault: v.key(),
            authority: v.authority,
            underlying_mint: v.underlying_mint,
            quote_mint: v.quote_mint,
            night_mint: v.night_mint,
            day_mint: v.day_mint,
            mark: v.last_mark,
            exposed: v.exposed,
            ts: now,
        });
        Ok(())
    }

    /// Deposit quote and receive shares of a class, at that class's NAV.
    ///
    /// Only permitted while the class is parked, so issuance never has to buy or
    /// sell stock and therefore never moves the market.
    pub fn mint_shares(ctx: Context<MintShares>, class: Class, quote_amount: u64) -> Result<()> {
        let v = &ctx.accounts.vault;
        v.check_live()?;
        require!(!v.paused(PAUSE_MINT), SessionError::Paused);
        require_keys_eq!(ctx.accounts.class_mint.key(), v.mint_of(class), SessionError::WrongMint);

        // Every rule about how much is minted lives in `ops`, where it is
        // property-tested. Nothing is recomputed here.
        let nav = v.nav_of(class);
        let plan = ops::plan_mint(&v.view(), class.into(), quote_amount).map_err(map_op)?;
        let shares = plan.shares;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_quote.to_account_info(),
                    to: ctx.accounts.quote_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            quote_amount,
        )?;

        let seeds = vault_seeds(v);
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.class_mint.to_account_info(),
                    to: ctx.accounts.user_shares.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[&seeds[..]],
            ),
            shares,
        )?;

        let (night_supply, day_supply) = supplies_after(
            &ctx.accounts.night_mint, &ctx.accounts.day_mint, class, shares as i128,
        )?;

        let v = &mut ctx.accounts.vault;
        v.owned_quote = plan.owned_quote_after;
        match class {
            Class::Night => v.total_minted_night = v.total_minted_night.saturating_add(shares),
            Class::Day => v.total_minted_day = v.total_minted_day.saturating_add(shares),
        }

        assert_solvent(v, night_supply, day_supply)?;

        emit!(SharesMinted {
            vault: v.key(),
            user: ctx.accounts.user.key(),
            class,
            quote_in: quote_amount,
            shares_out: shares,
            nav,
            owned_quote: v.owned_quote,
        });
        Ok(())
    }

    /// Burn shares of a parked class and take the quote back at NAV.
    pub fn redeem_shares(ctx: Context<RedeemShares>, class: Class, shares: u64) -> Result<()> {
        let v = &ctx.accounts.vault;
        v.check_live()?;
        require!(!v.paused(PAUSE_REDEEM), SessionError::Paused);
        require_keys_eq!(ctx.accounts.class_mint.key(), v.mint_of(class), SessionError::WrongMint);

        let nav = v.nav_of(class);
        let plan = ops::plan_redeem(&v.view(), class.into(), shares).map_err(map_op)?;
        let quote_out = plan.quote_out;

        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.class_mint.to_account_info(),
                    from: ctx.accounts.user_shares.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            shares,
        )?;

        let seeds = vault_seeds(v);
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.quote_vault.to_account_info(),
                    to: ctx.accounts.user_quote.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[&seeds[..]],
            ),
            quote_out,
        )?;

        let (night_supply, day_supply) = supplies_after(
            &ctx.accounts.night_mint, &ctx.accounts.day_mint, class, -(shares as i128),
        )?;

        let v = &mut ctx.accounts.vault;
        v.owned_quote = plan.owned_quote_after;

        assert_solvent(v, night_supply, day_supply)?;

        emit!(SharesRedeemed {
            vault: v.key(),
            user: ctx.accounts.user.key(),
            class,
            shares_in: shares,
            quote_out,
            nav,
            owned_quote: v.owned_quote,
        });
        Ok(())
    }

    /// Settle a session boundary. Permissionless: anyone may crank it.
    ///
    /// Idempotent by construction — it refuses unless exactly one boundary has
    /// elapsed. When the vault cannot know who is owed what it **halts and
    /// returns success**, so the halt persists. Returning an error would revert
    /// the transaction and lose the very state an operator needs to see.
    pub fn settle_boundary(ctx: Context<SettleBoundary>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        {
            let v = &ctx.accounts.vault;
            require!(v.version == VAULT_VERSION, SessionError::VersionMismatch);
            require!(!v.halted, SessionError::Halted);
        }

        // The calendar proposes; the equity feed disposes. A feed that has gone
        // quiet during a nominal session means an unencoded holiday or a halt.
        let equity_feed = ctx.accounts.vault.equity_feed_id;
        let equity_q = read_quote(&ctx.accounts.equity_price_update, &equity_feed)?;
        let guards = ctx.accounts.vault.guards();
        let calendar = session_at(now);
        let effective = effective_session(calendar, equity_q.publish_time, now, &guards);

        // A silent equity-feed outage would otherwise let NIGHT earn through
        // what should be DAY sessions, indefinitely and invisibly.
        if calendar == Session::Open && effective == Session::Closed {
            let quiet = now.saturating_sub(equity_q.publish_time);
            if quiet > ctx.accounts.vault.max_unexpected_closed_secs as i64 {
                return halt_and_succeed(
                    &mut ctx.accounts.vault, HaltReason::Inconsistent, now, quiet,
                );
            }
        }

        match machine::decide(
            ctx.accounts.vault.last_session(),
            ctx.accounts.vault.last_boundary_ts,
            now,
        ) {
            Decision::UpToDate => return Err(SessionError::NoBoundary.into()),
            Decision::Stale { missed } => {
                return halt_and_succeed(
                    &mut ctx.accounts.vault, HaltReason::MissedBoundary, now, missed as i64,
                );
            }
            Decision::Inconsistent => {
                return halt_and_succeed(
                    &mut ctx.accounts.vault, HaltReason::Inconsistent, now, 0,
                );
            }
            Decision::Settle { .. } => {}
        }

        let night_supply = ctx.accounts.night_mint.supply;
        let day_supply = ctx.accounts.day_mint.supply;

        let v = &ctx.accounts.vault;
        let total_value = value_of(night_supply, v.night_nav)
            .and_then(|a| value_of(day_supply, v.day_nav).map(|b| a.saturating_add(b)))
            .ok_or(SessionError::MathOverflow)?;

        // Carrying an unfilled handoff into a new boundary means real inventory
        // no longer matches what NAV claims. Small residues are tolerable; a
        // large one is not, and must never be silently overwritten.
        if v.pending_delta != 0 && total_value > 0 {
            let residue = v.pending_delta.unsigned_abs();
            let bps = mul_div_floor(residue, 10_000, total_value).unwrap_or(u128::MAX);
            if bps > v.max_carry_delta_bps as u128 {
                let detail = v.pending_delta.clamp(i64::MIN as i128, i64::MAX as i128) as i64;
                return halt_and_succeed(
                    &mut ctx.accounts.vault, HaltReason::UnfilledHandoff, now, detail,
                );
            }
        }

        let mark_feed = v.mark_feed_id;
        let mark_q = read_quote(&ctx.accounts.mark_price_update, &mark_feed)?;
        let mark = oracle::check_mark(
            &mark_q, now, v.last_mark, v.underlying_decimals, v.quote_decimals, &guards,
        )
        .map_err(map_oracle)?;

        let nav_state = v.nav_state(night_supply, day_supply);
        let out = settle(&nav_state, mark, &v.funding_params())
            .map_err(|_| error!(SessionError::MathOverflow))?;

        // A loss the exposed class cannot absorb has nowhere to go. Applying it
        // would wipe that class to zero and silently take the remainder out of
        // the other class's backing, so the vault stops instead — with nothing
        // written, so an operator sees the state that produced it.
        if out.shortfall > 0 {
            let detail = out.shortfall.min(i64::MAX as u128) as i64;
            return halt_and_succeed(&mut ctx.accounts.vault, HaltReason::BadDebt, now, detail);
        }

        let v = &mut ctx.accounts.vault;
        v.night_nav = out.night_nav;
        v.day_nav = out.day_nav;
        v.exposed = out.exposed.into();
        v.set_last_session(effective);
        v.last_mark = mark;
        v.last_boundary_ts = now;
        v.boundary_count = v.boundary_count.saturating_add(1);
        // Carry, never overwrite: a residue from the previous boundary is still
        // owed and stays owed.
        v.pending_delta = v
            .pending_delta
            .checked_add(out.handoff_delta)
            .ok_or(SessionError::MathOverflow)?;
        v.cum_funding_night = v.cum_funding_night.saturating_add(out.funding);

        assert_solvent(v, night_supply, day_supply)?;

        emit!(BoundarySettled {
            vault: v.key(),
            ts: now,
            boundary: v.boundary_count,
            exposed: v.exposed,
            mark,
            night_nav: v.night_nav,
            day_nav: v.day_nav,
            night_supply,
            day_supply,
            funding: out.funding,
            pending_delta: v.pending_delta,
            owned_underlying: v.owned_underlying,
            owned_quote: v.owned_quote,
        });
        Ok(())
    }

    /// Fill part or all of the outstanding imbalance at the oracle mark.
    ///
    /// When the two classes are the same size this never runs — the handoff was
    /// already a book entry. When they are not, rather than routing through an
    /// AMM and paying spread, the vault offers the difference at the mark plus a
    /// small incentive and lets arbitrageurs compete for it.
    ///
    /// The incentive is charged to the class that *caused* the imbalance by
    /// being larger, not taken from the vault at large. Otherwise every fill
    /// would quietly erode backing for both classes.
    pub fn fill_handoff(
        ctx: Context<FillHandoff>,
        underlying_amount: u64,
        max_quote_in: u64,
        min_quote_out: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let v = &ctx.accounts.vault;
        v.check_live()?;
        require!(!v.paused(PAUSE_FILL), SessionError::Paused);

        let mark_feed = v.mark_feed_id;
        let mark_q = read_quote(&ctx.accounts.mark_price_update, &mark_feed)?;
        let mark = oracle::check_mark(
            &mark_q, now, v.last_mark, v.underlying_decimals, v.quote_decimals, &v.guards(),
        )
        .map_err(map_oracle)?;

        let night_supply = ctx.accounts.night_mint.supply;
        let day_supply = ctx.accounts.day_mint.supply;

        // Sizing, pricing, the fee payer and every bound are decided in `ops`.
        let plan = ops::plan_fill(&v.view(), mark, underlying_amount, night_supply, day_supply)
            .map_err(map_op)?;

        // The caller's own protection, which only they can specify.
        if plan.buying {
            require!(plan.quote_amount >= min_quote_out, SessionError::SlippageExceeded);
        } else {
            require!(plan.quote_amount <= max_quote_in, SessionError::SlippageExceeded);
        }

        let seeds = vault_seeds(v);
        let (u_delta, q_delta) = if plan.buying {
            // The vault is short stock: the filler sells it underlying and is
            // paid a little above the mark.
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.filler_underlying.to_account_info(),
                        to: ctx.accounts.underlying_vault.to_account_info(),
                        authority: ctx.accounts.filler.to_account_info(),
                    },
                ),
                underlying_amount,
            )?;
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.quote_vault.to_account_info(),
                        to: ctx.accounts.filler_quote.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    &[&seeds[..]],
                ),
                plan.quote_amount,
            )?;
            (underlying_amount as i64, -(plan.quote_amount as i64))
        } else {
            // The vault is long stock it no longer needs: the filler buys it a
            // little below the mark.
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.filler_quote.to_account_info(),
                        to: ctx.accounts.quote_vault.to_account_info(),
                        authority: ctx.accounts.filler.to_account_info(),
                    },
                ),
                plan.quote_amount,
            )?;
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.underlying_vault.to_account_info(),
                        to: ctx.accounts.filler_underlying.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    &[&seeds[..]],
                ),
                underlying_amount,
            )?;
            (-(underlying_amount as i64), plan.quote_amount as i64)
        };

        let v = &mut ctx.accounts.vault;
        v.owned_underlying = plan.owned_underlying_after;
        v.owned_quote = plan.owned_quote_after;
        v.pending_delta = plan.pending_delta_after;

        // The incentive is charged to the larger class, whose size created the
        // imbalance. Taken from the vault at large it would erode backing for
        // both classes on every fill — a slow drain toward insolvency that no
        // single transaction would look wrong.
        if plan.fee_per_share > 0 {
            match plan.fee_payer {
                settle::ShareClass::Night => {
                    v.night_nav = v.night_nav.saturating_sub(plan.fee_per_share)
                }
                settle::ShareClass::Day => {
                    v.day_nav = v.day_nav.saturating_sub(plan.fee_per_share)
                }
            }
            v.cum_fill_incentive = v.cum_fill_incentive.saturating_add(plan.incentive as u64);
        }

        assert_solvent(v, night_supply, day_supply)?;

        emit!(HandoffFilled {
            vault: v.key(),
            filler: ctx.accounts.filler.key(),
            underlying_delta: u_delta,
            quote_delta: q_delta,
            incentive_paid: plan.incentive as u64,
            remaining_delta: v.pending_delta,
            owned_underlying: v.owned_underlying,
            owned_quote: v.owned_quote,
        });
        Ok(())
    }

    /// Sweep tokens transferred in without going through `mint_shares`.
    ///
    /// These are not the vault's to spend and must never count as backing;
    /// skimming keeps owned balances and real balances reconcilable.
    pub fn skim_surplus(ctx: Context<SkimSurplus>) -> Result<()> {
        let v = &ctx.accounts.vault;
        let u_surplus = ctx.accounts.underlying_vault.amount.saturating_sub(v.owned_underlying);
        let q_surplus = ctx.accounts.quote_vault.amount.saturating_sub(v.owned_quote);
        require!(u_surplus > 0 || q_surplus > 0, SessionError::NothingToSkim);

        let seeds = vault_seeds(v);
        if u_surplus > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.underlying_vault.to_account_info(),
                        to: ctx.accounts.dest_underlying.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    &[&seeds[..]],
                ),
                u_surplus,
            )?;
        }
        if q_surplus > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.quote_vault.to_account_info(),
                        to: ctx.accounts.dest_quote.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    &[&seeds[..]],
                ),
                q_surplus,
            )?;
        }
        emit!(SurplusSkimmed { vault: v.key(), underlying: u_surplus, quote: q_surplus });
        Ok(())
    }

    /// Re-anchor a halted vault and resume.
    ///
    /// Halting means the program could not determine who was owed what. Code
    /// cannot resolve that on its own — someone has to decide, from off-chain
    /// marks, where the vault restarts. This records that decision explicitly
    /// rather than pretending it did not happen.
    pub fn resolve_halt(ctx: Context<Admin>, ack: HaltReason) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let v = &mut ctx.accounts.vault;
        require!(v.halted, SessionError::NotHalted);
        // The operator must name the condition being cleared, so a halt for a
        // new reason cannot be cleared by a stale, already-signed transaction.
        require!(v.halt_reason == ack, SessionError::HaltReasonMismatch);

        let s = session_at(now);
        v.set_last_session(s);
        v.exposed = class_for(s).into();
        v.last_boundary_ts = now;
        v.halted = false;
        v.halt_reason = HaltReason::None;

        emit!(VaultResumed { vault: v.key(), ts: now, mark: v.last_mark, exposed: v.exposed });
        Ok(())
    }

    /// Stop the vault deliberately.
    pub fn halt(ctx: Context<Admin>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let v = &mut ctx.accounts.vault;
        v.halted = true;
        v.halt_reason = HaltReason::Operator;
        emit!(VaultHalted { vault: v.key(), reason: HaltReason::Operator, ts: now, detail: 0 });
        Ok(())
    }

    pub fn set_flags(ctx: Context<Admin>, flags: u8) -> Result<()> {
        require!(flags & !PAUSE_ALL == 0, SessionError::BadParameter);
        ctx.accounts.vault.flags = flags;
        Ok(())
    }

    /// Update tunables. Identity, mints and feeds are immutable by design —
    /// changing what a vault tracks is a new vault, not a parameter change.
    pub fn set_params(ctx: Context<Admin>, p: VaultParams) -> Result<()> {
        p.validate()?;
        let v = &mut ctx.accounts.vault;
        require!(p.mark_feed_id == v.mark_feed_id, SessionError::ImmutableField);
        require!(p.equity_feed_id == v.equity_feed_id, SessionError::ImmutableField);
        v.apply_params(&p);
        emit!(ParamsChanged { vault: v.key(), authority: v.authority });
        Ok(())
    }

    /// Propose a new authority. It takes effect only once the proposed key
    /// accepts, so a mistyped address cannot strand the vault.
    pub fn transfer_authority(ctx: Context<Admin>, next: Pubkey) -> Result<()> {
        require_keys_neq!(next, Pubkey::default(), SessionError::BadParameter);
        ctx.accounts.vault.pending_authority = next;
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        require_keys_neq!(v.pending_authority, Pubkey::default(), SessionError::Unauthorized);
        require_keys_eq!(
            v.pending_authority,
            ctx.accounts.next_authority.key(),
            SessionError::Unauthorized
        );
        v.authority = v.pending_authority;
        v.pending_authority = Pubkey::default();
        Ok(())
    }
}

/* ── parameters ──────────────────────────────────────────────────────────── */

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct VaultParams {
    pub mark_feed_id: [u8; 32],
    pub equity_feed_id: [u8; 32],
    pub funding_k_bps: u32,
    pub funding_max_bps: u32,
    pub max_stale_secs: u32,
    pub max_conf_bps: u16,
    pub max_move_bps: u16,
    pub equity_quiet_secs: u32,
    pub fill_incentive_bps: u16,
    pub max_carry_delta_bps: u16,
    pub max_unexpected_closed_secs: u32,
}

impl VaultParams {
    /// Every bound here guards a value that would be dangerous set carelessly,
    /// so the program refuses rather than trusting the operator.
    pub fn validate(&self) -> Result<()> {
        require!(self.funding_k_bps <= 50_000, SessionError::BadParameter);
        require!(self.funding_max_bps <= 1_000, SessionError::BadParameter);
        require!((1..=3_600).contains(&self.max_stale_secs), SessionError::BadParameter);
        require!(
            self.max_conf_bps > 0 && self.max_conf_bps <= 2_000,
            SessionError::BadParameter
        );
        require!(
            self.max_move_bps > 0 && self.max_move_bps <= 9_000,
            SessionError::BadParameter
        );
        require!((60..=86_400).contains(&self.equity_quiet_secs), SessionError::BadParameter);
        require!(self.fill_incentive_bps <= 500, SessionError::BadParameter);
        require!(self.max_carry_delta_bps <= 2_000, SessionError::BadParameter);
        require!(
            (3_600..=604_800).contains(&self.max_unexpected_closed_secs),
            SessionError::BadParameter
        );
        Ok(())
    }
}

impl Vault {
    fn apply_params(&mut self, p: &VaultParams) {
        self.funding_k_bps = p.funding_k_bps;
        self.funding_max_bps = p.funding_max_bps;
        self.max_stale_secs = p.max_stale_secs;
        self.max_conf_bps = p.max_conf_bps;
        self.max_move_bps = p.max_move_bps;
        self.equity_quiet_secs = p.equity_quiet_secs;
        self.fill_incentive_bps = p.fill_incentive_bps;
        self.max_carry_delta_bps = p.max_carry_delta_bps;
        self.max_unexpected_closed_secs = p.max_unexpected_closed_secs;
    }

    fn check_live(&self) -> Result<()> {
        require!(self.version == VAULT_VERSION, SessionError::VersionMismatch);
        require!(!self.halted, SessionError::Halted);
        Ok(())
    }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/// Which class should hold the stock during a given session.
pub const fn class_for(session: Session) -> settle::ShareClass {
    match session {
        Session::Closed => settle::ShareClass::Night,
        Session::Open => settle::ShareClass::Day,
    }
}

/// Assets must cover claims. Asserted after every instruction that moves value.
///
/// Assets are the vault's *owned* balances marked at the last settled price —
/// never the token account balances, which anyone can inflate by transfer.
pub fn assert_solvent(v: &Vault, night_supply: u64, day_supply: u64) -> Result<()> {
    let assets = mul_div_floor(v.owned_underlying as u128, v.last_mark, WAD)
        .ok_or(SessionError::MathOverflow)?
        .checked_add(v.owned_quote as u128)
        .ok_or(SessionError::MathOverflow)?;
    let claims = value_of(night_supply, v.night_nav)
        .ok_or(SessionError::MathOverflow)?
        .checked_add(value_of(day_supply, v.day_nav).ok_or(SessionError::MathOverflow)?)
        .ok_or(SessionError::MathOverflow)?;
    require!(assets >= claims, SessionError::Insolvent);
    Ok(())
}

/// Supplies as they stand *after* a mint or burn in this instruction.
///
/// `Account<Mint>` is deserialised at instruction entry, so its `supply` is the
/// pre-CPI figure. Using it directly would check solvency against a supply that
/// no longer exists.
fn supplies_after(
    night: &Account<Mint>,
    day: &Account<Mint>,
    class: Class,
    delta: i128,
) -> Result<(u64, u64)> {
    let apply = |s: u64| -> Result<u64> {
        let v = s as i128 + delta;
        require!(v >= 0 && v <= u64::MAX as i128, SessionError::MathOverflow);
        Ok(v as u64)
    };
    Ok(match class {
        Class::Night => (apply(night.supply)?, day.supply),
        Class::Day => (night.supply, apply(day.supply)?),
    })
}

fn apply_i64(base: u64, delta: i64) -> Result<u64> {
    let v = base as i128 + delta as i128;
    require!(v >= 0 && v <= u64::MAX as i128, SessionError::MathOverflow);
    Ok(v as u64)
}

fn halt_and_succeed(
    v: &mut Account<Vault>,
    reason: HaltReason,
    ts: i64,
    detail: i64,
) -> Result<()> {
    v.halted = true;
    v.halt_reason = reason;
    emit!(VaultHalted { vault: v.key(), reason, ts, detail });
    Ok(())
}

fn vault_seeds(v: &Vault) -> [&[u8]; 4] {
    [
        Vault::SEED,
        v.underlying_mint.as_ref(),
        v.quote_mint.as_ref(),
        std::slice::from_ref(&v.bump),
    ]
}

/// Read a Pyth price update without imposing a staleness rule.
///
/// The equity feed is *expected* to be stale for 17 hours a day — that is the
/// signal, not a fault — so staleness is judged by the caller.
///
/// Three checks are not optional: the account must be owned by the Pyth
/// receiver, it must parse as a price update, and the feed id must match the
/// vault's configuration. Skip any one and a caller can settle a vault against
/// a price of their choosing.
fn read_quote(ai: &AccountInfo, expect: &[u8; 32]) -> Result<Quote> {
    require_keys_eq!(*ai.owner, PYTH_RECEIVER, SessionError::WrongOracleOwner);
    let data = ai.try_borrow_data()?;
    let update = parse_price_update(&data).map_err(map_oracle)?;
    require!(update.feed_id == *expect, SessionError::WrongFeed);
    Ok(update.quote)
}

/// Policy failures carry their own meaning; flattening them into one error
/// would make an operator guess which of a dozen guards fired.
fn map_op(e: OpError) -> Error {
    match e {
        OpError::NotParked => error!(SessionError::ClassNotParked),
        OpError::ZeroAmount => error!(SessionError::ZeroAmount),
        OpError::AmountTooSmall => error!(SessionError::AmountTooSmall),
        OpError::NavCollapsed => error!(SessionError::NavCollapsed),
        OpError::Overflow => error!(SessionError::MathOverflow),
        OpError::Insolvent => error!(SessionError::Insolvent),
        OpError::NothingToFill => error!(SessionError::NothingToFill),
        OpError::FillTooLarge => error!(SessionError::FillTooLarge),
        OpError::InsufficientQuote => error!(SessionError::InsufficientQuote),
        OpError::InsufficientFreeQuote => error!(SessionError::InsufficientFreeQuote),
        OpError::InsufficientUnderlying => error!(SessionError::InsufficientUnderlying),
        OpError::NoFeePayer => error!(SessionError::NoFeePayer),
        OpError::SlippageExceeded => error!(SessionError::SlippageExceeded),
    }
}

fn map_oracle(e: oracle::OracleError) -> Error {
    use oracle::OracleError as O;
    match e {
        O::NonPositivePrice => error!(SessionError::BadOraclePrice),
        O::Stale => error!(SessionError::StaleOracle),
        O::Uncertain => error!(SessionError::UncertainOracle),
        O::MoveTooLarge => error!(SessionError::MoveTooLarge),
        O::BadExponent => error!(SessionError::BadExponent),
        O::WrongAccount => error!(SessionError::NotAPriceUpdate),
        O::Malformed => error!(SessionError::MalformedPriceUpdate),
        O::Overflow => error!(SessionError::MathOverflow),
    }
}

/* ── accounts ────────────────────────────────────────────────────────────── */

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = Vault::SIZE,
        seeds = [Vault::SEED, underlying_mint.key().as_ref(), quote_mint.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    pub underlying_mint: Account<'info, Mint>,
    pub quote_mint: Account<'info, Mint>,

    #[account(
        init, payer = authority, seeds = [b"night", vault.key().as_ref()], bump,
        mint::decimals = quote_mint.decimals, mint::authority = vault,
    )]
    pub night_mint: Account<'info, Mint>,

    #[account(
        init, payer = authority, seeds = [b"day", vault.key().as_ref()], bump,
        mint::decimals = quote_mint.decimals, mint::authority = vault,
    )]
    pub day_mint: Account<'info, Mint>,

    #[account(
        init, payer = authority, seeds = [b"underlying", vault.key().as_ref()], bump,
        token::mint = underlying_mint, token::authority = vault,
    )]
    pub underlying_vault: Account<'info, TokenAccount>,

    #[account(
        init, payer = authority, seeds = [b"quote", vault.key().as_ref()], bump,
        token::mint = quote_mint, token::authority = vault,
    )]
    pub quote_vault: Account<'info, TokenAccount>,

    /// CHECK: owner, layout and feed id are all verified in `read_quote`.
    pub mark_price_update: UncheckedAccount<'info>,
    /// CHECK: owner, layout and feed id are all verified in `read_quote`.
    pub equity_price_update: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct MintShares<'info> {
    #[account(mut, seeds = [Vault::SEED, vault.underlying_mint.as_ref(), vault.quote_mint.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub class_mint: Account<'info, Mint>,
    #[account(address = vault.night_mint)]
    pub night_mint: Account<'info, Mint>,
    #[account(address = vault.day_mint)]
    pub day_mint: Account<'info, Mint>,
    #[account(mut, address = vault.quote_vault)]
    pub quote_vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = user_quote.mint == vault.quote_mint @ SessionError::WrongMint)]
    pub user_quote: Account<'info, TokenAccount>,
    #[account(mut, constraint = user_shares.mint == class_mint.key() @ SessionError::WrongMint)]
    pub user_shares: Account<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RedeemShares<'info> {
    #[account(mut, seeds = [Vault::SEED, vault.underlying_mint.as_ref(), vault.quote_mint.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub class_mint: Account<'info, Mint>,
    #[account(address = vault.night_mint)]
    pub night_mint: Account<'info, Mint>,
    #[account(address = vault.day_mint)]
    pub day_mint: Account<'info, Mint>,
    #[account(mut, address = vault.quote_vault)]
    pub quote_vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = user_quote.mint == vault.quote_mint @ SessionError::WrongMint)]
    pub user_quote: Account<'info, TokenAccount>,
    #[account(mut, constraint = user_shares.mint == class_mint.key() @ SessionError::WrongMint)]
    pub user_shares: Account<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SettleBoundary<'info> {
    #[account(mut, seeds = [Vault::SEED, vault.underlying_mint.as_ref(), vault.quote_mint.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(address = vault.night_mint)]
    pub night_mint: Account<'info, Mint>,
    #[account(address = vault.day_mint)]
    pub day_mint: Account<'info, Mint>,
    /// CHECK: owner, layout and feed id are all verified in `read_quote`.
    /// 24/7 price of the token itself — what the vault's assets are worth.
    pub mark_price_update: UncheckedAccount<'info>,
    /// CHECK: owner, layout and feed id are all verified in `read_quote`.
    /// Real-equity feed. Publishes only while the market is open, so its
    /// silence is what tells the vault the market has shut.
    pub equity_price_update: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct FillHandoff<'info> {
    #[account(mut, seeds = [Vault::SEED, vault.underlying_mint.as_ref(), vault.quote_mint.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, address = vault.underlying_vault)]
    pub underlying_vault: Account<'info, TokenAccount>,
    #[account(mut, address = vault.quote_vault)]
    pub quote_vault: Account<'info, TokenAccount>,
    #[account(address = vault.night_mint)]
    pub night_mint: Account<'info, Mint>,
    #[account(address = vault.day_mint)]
    pub day_mint: Account<'info, Mint>,
    #[account(mut, constraint = filler_underlying.mint == vault.underlying_mint @ SessionError::WrongMint)]
    pub filler_underlying: Account<'info, TokenAccount>,
    #[account(mut, constraint = filler_quote.mint == vault.quote_mint @ SessionError::WrongMint)]
    pub filler_quote: Account<'info, TokenAccount>,
    pub filler: Signer<'info>,
    /// CHECK: owner, layout and feed id are all verified in `read_quote`.
    pub mark_price_update: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SkimSurplus<'info> {
    #[account(has_one = authority @ SessionError::Unauthorized,
              seeds = [Vault::SEED, vault.underlying_mint.as_ref(), vault.quote_mint.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    pub authority: Signer<'info>,
    #[account(mut, address = vault.underlying_vault)]
    pub underlying_vault: Account<'info, TokenAccount>,
    #[account(mut, address = vault.quote_vault)]
    pub quote_vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = dest_underlying.mint == vault.underlying_mint @ SessionError::WrongMint)]
    pub dest_underlying: Account<'info, TokenAccount>,
    #[account(mut, constraint = dest_quote.mint == vault.quote_mint @ SessionError::WrongMint)]
    pub dest_quote: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Admin<'info> {
    #[account(mut, has_one = authority @ SessionError::Unauthorized,
              seeds = [Vault::SEED, vault.underlying_mint.as_ref(), vault.quote_mint.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(mut, seeds = [Vault::SEED, vault.underlying_mint.as_ref(), vault.quote_mint.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    pub next_authority: Signer<'info>,
}
