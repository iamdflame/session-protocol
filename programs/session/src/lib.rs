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
// token_interface, not token: the assets this vault is for are Token-2022
// mints. Every real xStock — NVDAx, SPYx — is Token-2022 with extensions, and
// `Account<'info, token::Mint>` owner-checks against the classic SPL Token
// program, so the previous types could not so much as *deserialise* the mint
// this protocol exists to hold. The interface accepts either program and the
// account carries which one it is.
use anchor_spl::token_interface::{
    self as token, Burn, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked,
};
use anchor_spl::token_2022::spl_token_2022::state::AccountState;

pub mod calendar;
pub mod errors;
pub mod fixed;
pub mod funding;
pub mod issuer;
pub mod machine;
pub mod ops;
pub mod oracle;
pub mod recap;
pub mod settle;
pub mod state;

use calendar::{session_at, Session};
use anchor_lang::solana_program::hash::hashv;
use errors::SessionError;
use fixed::{mul_div_floor, WAD};
use machine::Decision;
use ops::OpError;
use oracle::{effective_session, parse_price_update, MarkWindow, PriceUpdate, Verification};
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
    ///
    /// Permissionless: whoever pays becomes this vault's authority, and that
    /// authority reaches this vault's tunables and nothing else. One vault per
    /// (underlying, quote) pair, by PDA.
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        p: VaultParams,
        symbol: String,
        session_kind: u8,
    ) -> Result<()> {
        p.validate()?;
        require!(
            session_kind == SESSION_EQUITY || session_kind == SESSION_EVENT,
            SessionError::BadParameter
        );
        require!(
            !symbol.is_empty() && symbol.len() <= 8 && symbol.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()),
            SessionError::BadParameter
        );
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

        // A mint whose issuer has already set a hook or paused it, or whose
        // new accounts start frozen, cannot be custodied. Refuse now rather
        // than mint shares against inventory that can never move.
        require!(
            issuer_condition(
                0,
                &ctx.accounts.underlying_mint.to_account_info(),
                &ctx.accounts.underlying_vault,
            )?
            .is_none(),
            SessionError::IssuerAction
        );

        // Both feeds are read at creation, so a vault can never be initialised
        // pointing at an account that does not exist or does not match.
        let mark_u = read_quote(&ctx.accounts.mark_price_update, &p.mark_feed_id)?;
        let _equity_u = read_quote(&ctx.accounts.equity_price_update, &p.equity_feed_id)?;
        require_recent_post(&mark_u, p.max_posted_slot_age)?;
        let mark_q = mark_u.quote;

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

        v.session_kind = session_kind;
        v.symbol = [0u8; 8];
        v.symbol[..symbol.len()].copy_from_slice(symbol.as_bytes());
        v.fill_paused_until = 0;
        v.last_recap_ts = 0;
        v.recap_count = 0;
        // Until a detector key is set, the authority is it.
        v.detector_authority = ctx.accounts.authority.key();
        v.share_token_program = ctx.accounts.quote_token_program.key();

        v.last_mark = oracle::check_mark(
            &mark_q,
            MarkWindow::now(now, v.max_stale_secs),
            0,
            v.underlying_decimals,
            v.quote_decimals,
            &v.guards(),
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

        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.quote_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.user_quote.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    to: ctx.accounts.quote_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            quote_amount,
            v.quote_decimals,
        )?;

        let seeds = vault_seeds(v);
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.quote_token_program.to_account_info(),
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
                ctx.accounts.quote_token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.class_mint.to_account_info(),
                    from: ctx.accounts.user_shares.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            shares,
        )?;

        let seeds = vault_seeds(v);
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.quote_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.quote_vault.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    to: ctx.accounts.user_quote.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[&seeds[..]],
            ),
            quote_out,
            v.quote_decimals,
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

        // The issuer acted: a hook, a pause, a freeze, or inventory moved out
        // under a permanent delegate. There is nothing to settle against and
        // no guessing about it — stop with the reason, keep the state.
        if let Some(c) = issuer_condition(
            ctx.accounts.vault.owned_underlying,
            &ctx.accounts.underlying_mint.to_account_info(),
            &ctx.accounts.underlying_vault,
        )? {
            return halt_and_succeed(&mut ctx.accounts.vault, HaltReason::IssuerAction, now, c as i64);
        }

        // The calendar proposes; the equity feed disposes. A feed that has gone
        // quiet during a nominal session means an unencoded holiday or a halt.
        let equity_feed = ctx.accounts.vault.equity_feed_id;
        // No posted-slot bound on the equity feed: it is *expected* to sit
        // unwritten for seventeen hours a day. Its age is the signal.
        let equity_q = read_quote(&ctx.accounts.equity_price_update, &equity_feed)?.quote;
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

        let boundary_ts = match machine::decide(
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
            Decision::Settle { at, .. } => at,
        };

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
        let mark_u = read_quote(&ctx.accounts.mark_price_update, &mark_feed)?;
        require_recent_post(&mark_u, v.max_posted_slot_age)?;
        // The price *at the bell*, not the price at the crank. A crank an hour
        // late reading the live feed has a number that is fresh and wrong; the
        // window around `boundary_ts` refuses it, and the keeper posts the
        // print from the bell instead.
        let mark = oracle::check_mark(
            &mark_u.quote,
            MarkWindow::at_bell(boundary_ts, v.max_bell_lead_secs, v.max_stale_secs),
            v.last_mark,
            v.underlying_decimals,
            v.quote_decimals,
            &guards,
        )
        .map_err(map_oracle)?;

        // A move past max_move_bps is a jump. It settles — the exposed class
        // wears it, which is the product — and ordinary fills pause for a
        // cooling period so the residual is not swept up at a price the
        // market has not yet absorbed. Only a loss the class cannot cover
        // halts, below.
        let jump_bps = oracle::move_bps(mark, v.last_mark).map_err(map_oracle)?;
        let jumped = v.last_mark > 0 && jump_bps > v.max_move_bps as u128;

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
        // The bell, not the crank. A crank that lands an hour late must not
        // charge the incoming class that hour: the session it is being paid
        // for began when the calendar says it began. The mark, too, was
        // required to come from the bell's own window above.
        v.last_boundary_ts = boundary_ts;
        v.boundary_count = v.boundary_count.saturating_add(1);
        // Carry, never overwrite: a residue from the previous boundary is still
        // owed and stays owed.
        v.pending_delta = v
            .pending_delta
            .checked_add(out.handoff_delta)
            .ok_or(SessionError::MathOverflow)?;
        v.cum_funding_night = v.cum_funding_night.saturating_add(out.funding);
        if jumped {
            v.fill_paused_until = now.saturating_add(2 * v.auction_secs as i64);
        }

        assert_solvent(v, night_supply, day_supply)?;

        if jumped {
            emit!(JumpSettled {
                vault: v.key(),
                ts: now,
                move_bps: jump_bps.min(u32::MAX as u128) as u32,
                mark,
                fills_paused_until: v.fill_paused_until,
            });
        }

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
        require!(v.version == VAULT_VERSION, SessionError::VersionMismatch);
        // A residue is the one thing a fill fixes, so a halt *for* a residue
        // must not block it. Every other halt does.
        require!(
            !v.halted || matches!(v.halt_reason, HaltReason::UnfilledHandoff | HaltReason::BadDebt),
            SessionError::Halted
        );
        require!(!v.paused(PAUSE_FILL), SessionError::Paused);
        require!(now >= v.fill_paused_until, SessionError::FillsPaused);

        let mark_feed = v.mark_feed_id;
        let mark_u = read_quote(&ctx.accounts.mark_price_update, &mark_feed)?;
        require_recent_post(&mark_u, v.max_posted_slot_age)?;
        // A fill is priced now, so the window trails the clock.
        let mark = oracle::check_mark(
            &mark_u.quote,
            MarkWindow::now(now, v.max_stale_secs),
            v.last_mark,
            v.underlying_decimals,
            v.quote_decimals,
            &v.guards(),
        )
        .map_err(map_oracle)?;

        let night_supply = ctx.accounts.night_mint.supply;
        let day_supply = ctx.accounts.day_mint.supply;

        // A fill is a transfer of the underlying; an issuer condition is a
        // clear refusal here rather than a halt, because the caller pays the
        // fee and the next settlement will halt the vault with the reason.
        let mint_ai = ctx.accounts.underlying_mint.to_account_info();
        let issuer = {
            let data = mint_ai.try_borrow_data()?;
            issuer::inspect_mint(&data, mint_ai.owner, Clock::get()?.epoch)
                .map_err(|_| error!(SessionError::NotAMint))?
        };
        let frozen = ctx.accounts.underlying_vault.state == AccountState::Frozen;
        require!(
            issuer::condition(&issuer, frozen, ctx.accounts.underlying_vault.amount, v.owned_underlying).is_none(),
            SessionError::IssuerAction
        );

        // A transfer *into* the vault arrives short by the mint's transfer
        // fee. The vault credits — and pays for — what it receives, never
        // what was sent; a filler delivering into a fee-bearing mint is paid
        // for the net. On the way out the vault's books lose exactly what it
        // sends and the fee is the receiver's.
        let buying = v.pending_delta > 0;
        let fee_in = if buying { issuer::transfer_fee(&issuer, underlying_amount) } else { 0 };
        let credited = underlying_amount.checked_sub(fee_in).ok_or(SessionError::MathOverflow)?;
        require!(credited > 0, SessionError::AmountTooSmall);

        // Sizing, pricing, the fee payer and every bound are decided in `ops`.
        let plan = ops::plan_fill(&v.view(), mark, credited, night_supply, day_supply)
            .map_err(map_op)?;
        let before = ctx.accounts.underlying_vault.amount;

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
            token::transfer_checked(
                CpiContext::new(
                    ctx.accounts.underlying_token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.filler_underlying.to_account_info(),
                        mint: ctx.accounts.underlying_mint.to_account_info(),
                        to: ctx.accounts.underlying_vault.to_account_info(),
                        authority: ctx.accounts.filler.to_account_info(),
                    },
                ),
                underlying_amount,
                v.underlying_decimals,
            )?;
            token::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.quote_token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.quote_vault.to_account_info(),
                        mint: ctx.accounts.quote_mint.to_account_info(),
                        to: ctx.accounts.filler_quote.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    &[&seeds[..]],
                ),
                plan.quote_amount,
                v.quote_decimals,
            )?;
            // Defence in depth: the fee was computed from the mint's own
            // schedule; the balance delta says what actually arrived.
            ctx.accounts.underlying_vault.reload()?;
            let arrived = ctx.accounts.underlying_vault.amount.saturating_sub(before);
            require!(arrived == credited, SessionError::TransferFeeMismatch);
            (credited as i64, -(plan.quote_amount as i64))
        } else {
            // The vault is long stock it no longer needs: the filler buys it a
            // little below the mark.
            token::transfer_checked(
                CpiContext::new(
                    ctx.accounts.quote_token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.filler_quote.to_account_info(),
                        mint: ctx.accounts.quote_mint.to_account_info(),
                        to: ctx.accounts.quote_vault.to_account_info(),
                        authority: ctx.accounts.filler.to_account_info(),
                    },
                ),
                plan.quote_amount,
                v.quote_decimals,
            )?;
            token::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.underlying_token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.underlying_vault.to_account_info(),
                        mint: ctx.accounts.underlying_mint.to_account_info(),
                        to: ctx.accounts.filler_underlying.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    &[&seeds[..]],
                ),
                underlying_amount,
                v.underlying_decimals,
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
            token::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.underlying_token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.underlying_vault.to_account_info(),
                        mint: ctx.accounts.underlying_mint.to_account_info(),
                        to: ctx.accounts.dest_underlying.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    &[&seeds[..]],
                ),
                u_surplus,
                v.underlying_decimals,
            )?;
        }
        if q_surplus > 0 {
            token::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.quote_token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.quote_vault.to_account_info(),
                        mint: ctx.accounts.quote_mint.to_account_info(),
                        to: ctx.accounts.dest_quote.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    &[&seeds[..]],
                ),
                q_surplus,
                v.quote_decimals,
            )?;
        }
        emit!(SurplusSkimmed { vault: v.key(), underlying: u_surplus, quote: q_surplus });
        Ok(())
    }

    /// Replay the boundaries a halted vault missed, one supplied mark each.
    ///
    /// The calendar decides which boundaries those are and `settle()` — the
    /// same function the live path runs — applies each one. The operator
    /// chooses nothing but the prices; every attested price is bounded, and
    /// a price backed by a Pyth update from that bell's window (one account
    /// per entry in `remaining_accounts`, in order) is not the operator's
    /// choice at all. A loss the exposed class cannot cover stops the replay
    /// unless `absorb_shortfall` names the only place it can go, and the
    /// receipt says so.
    ///
    /// The vault stays halted afterwards; `resolve_halt` resumes it once the
    /// books are current.
    pub fn recap<'info>(
        ctx: Context<'_, '_, 'info, 'info, Recap<'info>>,
        entries: Vec<RecapEntry>,
        absorb_shortfall: bool,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let v = &ctx.accounts.vault;
        require!(v.version == VAULT_VERSION, SessionError::VersionMismatch);
        require!(v.halted, SessionError::NotHalted);
        // A vault whose stored state contradicts the calendar has nothing to
        // replay *from*. That one is an upgrade, not a recap.
        require!(v.halt_reason != HaltReason::Inconsistent, SessionError::RecapNotApplicable);
        require!(!entries.is_empty() && entries.len() <= 32, SessionError::BadParameter);

        // Verified mode is all-or-nothing: one Pyth account per entry, or none.
        let pyth = ctx.remaining_accounts;
        let verified = match pyth.len() {
            0 => false,
            n if n == entries.len() => true,
            _ => return Err(SessionError::RecapMismatch.into()),
        };
        require!(verified || !v.require_verified_recap, SessionError::RecapUnverified);

        let mut input: Vec<recap::Entry> = Vec::with_capacity(entries.len());
        for (i, e) in entries.iter().enumerate() {
            if verified {
                let u = read_quote(&pyth[i], &v.mark_feed_id)?;
                require_recent_post(&u, v.max_posted_slot_age)?;
                // The window is the check; the move bound is Pyth's problem.
                let mark = oracle::check_mark(
                    &u.quote,
                    MarkWindow::at_bell(e.boundary_ts, v.max_bell_lead_secs, v.max_stale_secs),
                    0,
                    v.underlying_decimals,
                    v.quote_decimals,
                    &v.guards(),
                )
                .map_err(map_oracle)?;
                require!(mark == e.mark, SessionError::RecapMismatch);
            }
            input.push(recap::Entry { boundary_ts: e.boundary_ts, mark: e.mark, verified });
        }

        let night_supply = ctx.accounts.night_mint.supply;
        let day_supply = ctx.accounts.day_mint.supply;
        let out = recap::replay(&recap::Input {
            last_session: v.last_session(),
            last_boundary_ts: v.last_boundary_ts,
            state: v.nav_state(night_supply, day_supply),
            pending_delta: v.pending_delta,
            funding: v.funding_params(),
            max_move_bps: v.max_move_bps,
            absorb_shortfall,
            now,
            entries: &input,
        })
        .map_err(map_recap)?;

        let from_ts = v.last_boundary_ts;
        let v = &mut ctx.accounts.vault;
        v.night_nav = out.night_nav;
        v.day_nav = out.day_nav;
        v.exposed = out.exposed.into();
        v.last_mark = out.last_mark;
        v.set_last_session(out.last_session);
        v.last_boundary_ts = out.last_boundary_ts;
        v.boundary_count = v.boundary_count.saturating_add(out.boundaries as u64);
        v.pending_delta = out.pending_delta;
        v.cum_funding_night = v.cum_funding_night.saturating_add(out.funding);
        v.last_recap_ts = now;
        v.recap_count = v.recap_count.saturating_add(1);

        assert_solvent(v, night_supply, day_supply)?;

        // A receipt: everything needed to audit the replay from the event
        // alone, including a hash of exactly what the operator submitted.
        let mut bytes = Vec::with_capacity(entries.len() * 24);
        for e in &entries {
            bytes.extend_from_slice(&e.boundary_ts.to_le_bytes());
            bytes.extend_from_slice(&e.mark.to_le_bytes());
        }
        emit!(Recapped {
            vault: v.key(),
            ts: now,
            from_ts,
            to_ts: out.last_boundary_ts,
            boundaries: out.boundaries,
            verified,
            absorbed: out.absorbed,
            unabsorbed: out.unabsorbed,
            entries_hash: hashv(&[&bytes]).to_bytes(),
            exposed: v.exposed,
            night_nav: v.night_nav,
            day_nav: v.day_nav,
            pending_delta: v.pending_delta,
            funding: out.funding,
        });
        Ok(())
    }

    /// Resume a halted vault whose books are current.
    ///
    /// This writes nothing to the accounting. It refuses while boundaries are
    /// unaccounted for (`recap` first), while a handoff residue is larger than
    /// the carry limit (`fill_handoff` first — allowed during these halts for
    /// exactly this reason), and while an issuer condition still holds. The
    /// operator names the condition being cleared so a stale, already-signed
    /// transaction cannot clear a newer halt.
    pub fn resolve_halt(ctx: Context<ResolveHalt>, ack: HaltReason) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let v = &ctx.accounts.vault;
        require!(v.version == VAULT_VERSION, SessionError::VersionMismatch);
        require!(v.halted, SessionError::NotHalted);
        require!(v.halt_reason == ack, SessionError::HaltReasonMismatch);

        // Current means at most one boundary has elapsed since the last one
        // settled — that one, the next crank settles in the ordinary way.
        match machine::decide(v.last_session(), v.last_boundary_ts, now) {
            Decision::Stale { .. } => return Err(SessionError::RecapRequired.into()),
            Decision::Inconsistent => return Err(SessionError::RecapNotApplicable.into()),
            _ => {}
        }

        let night_supply = ctx.accounts.night_mint.supply;
        let day_supply = ctx.accounts.day_mint.supply;
        let total_value = value_of(night_supply, v.night_nav)
            .and_then(|a| value_of(day_supply, v.day_nav).map(|b| a.saturating_add(b)))
            .ok_or(SessionError::MathOverflow)?;
        if v.pending_delta != 0 && total_value > 0 {
            let residue = v.pending_delta.unsigned_abs();
            let bps = mul_div_floor(residue, 10_000, total_value).unwrap_or(u128::MAX);
            require!(bps <= v.max_carry_delta_bps as u128, SessionError::ResidueTooLarge);
        }

        // Whatever the halt was for, the issuer's powers are re-read: a
        // vault does not resume into a hook, a pause, a freeze or a seizure.
        require!(
            issuer_condition(
                v.owned_underlying,
                &ctx.accounts.underlying_mint.to_account_info(),
                &ctx.accounts.underlying_vault,
            )?
            .is_none(),
            SessionError::IssuerAction
        );

        let v = &mut ctx.accounts.vault;
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

/// One missed boundary, as the operator submits it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct RecapEntry {
    pub boundary_ts: i64,
    /// Quote atoms per underlying atom, WAD-scaled — `Vault::last_mark`'s units.
    pub mark: u128,
}

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
    // ── v2 ──
    pub max_posted_slot_age: u32,
    pub max_bell_lead_secs: u32,
    pub max_premium_bps: u16,
    pub auction_secs: u32,
    pub incentive_ramp: [u16; 3],
    pub require_verified_recap: bool,
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
        // A slot is ~400ms; 9,000 is an hour. Wider than that and the bound
        // stops meaning "recently posted".
        require!((1..=9_000).contains(&self.max_posted_slot_age), SessionError::BadParameter);
        require!(self.max_bell_lead_secs <= 3_600, SessionError::BadParameter);
        require!(self.max_premium_bps <= 5_000, SessionError::BadParameter);
        require!((30..=3_600).contains(&self.auction_secs), SessionError::BadParameter);
        require!(
            self.incentive_ramp.iter().all(|&b| b <= 500)
                && self.incentive_ramp[0] <= self.incentive_ramp[1]
                && self.incentive_ramp[1] <= self.incentive_ramp[2],
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
        self.max_posted_slot_age = p.max_posted_slot_age;
        self.max_bell_lead_secs = p.max_bell_lead_secs;
        self.max_premium_bps = p.max_premium_bps;
        self.auction_secs = p.auction_secs;
        self.incentive_ramp = p.incentive_ramp;
        self.require_verified_recap = p.require_verified_recap;
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
    night: &InterfaceAccount<Mint>,
    day: &InterfaceAccount<Mint>,
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

/// The first issuer condition holding against this vault's underlying, if any.
fn issuer_condition(
    owned: u64,
    mint: &AccountInfo,
    vault_ata: &InterfaceAccount<TokenAccount>,
) -> Result<Option<issuer::Condition>> {
    let data = mint.try_borrow_data()?;
    let s = issuer::inspect_mint(&data, mint.owner, Clock::get()?.epoch)
        .map_err(|_| error!(SessionError::NotAMint))?;
    let frozen = vault_ata.state == AccountState::Frozen;
    Ok(issuer::condition(&s, frozen, vault_ata.amount, owned))
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
fn read_quote(ai: &AccountInfo, expect: &[u8; 32]) -> Result<PriceUpdate> {
    require_keys_eq!(*ai.owner, PYTH_RECEIVER, SessionError::WrongOracleOwner);
    let data = ai.try_borrow_data()?;
    let update = parse_price_update(&data).map_err(map_oracle)?;
    require!(update.feed_id == *expect, SessionError::WrongFeed);
    // A `Partial(n)` update has been checked against only n of the Wormhole
    // guardian set. Anyone may post one, and it lands in an account this
    // program's owner and feed checks both accept — so refusing it here is the
    // only thing standing between a cheaply-attested price and everyone's NAV.
    // Parsing the level and then discarding it was the whole gap.
    require!(
        update.verification == Verification::Full,
        SessionError::PartialVerification
    );
    Ok(update)
}

/// The account must have been *written* recently, not just carry a recent
/// publish time. Anyone can post any valid Pyth update into an account they
/// own; this stops an old posting being left around and read as current long
/// after the fact. Never applied to the equity feed, whose silence is the
/// point.
fn require_recent_post(u: &PriceUpdate, max_age_slots: u32) -> Result<()> {
    let slot = Clock::get()?.slot;
    require!(
        slot.saturating_sub(u.posted_slot) <= max_age_slots as u64,
        SessionError::PostedSlotStale
    );
    Ok(())
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

fn map_recap(e: recap::RecapError) -> Error {
    use recap::RecapError as R;
    match e {
        R::Empty => error!(SessionError::BadParameter),
        R::Mismatch | R::Future => error!(SessionError::RecapMismatch),
        R::MoveTooLarge => error!(SessionError::MoveTooLarge),
        R::Shortfall => error!(SessionError::RecapShortfall),
        R::ZeroMark => error!(SessionError::BadOraclePrice),
        R::Overflow => error!(SessionError::MathOverflow),
    }
}

fn map_oracle(e: oracle::OracleError) -> Error {
    use oracle::OracleError as O;
    match e {
        O::NonPositivePrice => error!(SessionError::BadOraclePrice),
        O::Stale => error!(SessionError::StaleOracle),
        O::AfterWindow => error!(SessionError::MarkOutsideWindow),
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
    // Boxed: `try_accounts` for this struct deserialises every account onto a
    // 4 KiB SBF stack frame, and with the full vault state plus four mints and
    // two token accounts it overran by 8 bytes. Overrunning is undefined
    // behaviour on chain, not a warning. Heap-allocating the largest one is the
    // standard Anchor fix and changes nothing about the account itself.
    pub vault: Box<Account<'info, Vault>>,

    pub underlying_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    // The share classes are created under the *quote* program, which is the
    // ordinary SPL one for a USDC-quoted vault. They are this program's own
    // mints with no extensions, so there is nothing to gain from 2022 and a
    // great deal of wallet compatibility to lose.
    #[account(
        init, payer = authority, seeds = [b"night", vault.key().as_ref()], bump,
        mint::decimals = quote_mint.decimals, mint::authority = vault,
        mint::token_program = quote_token_program,
    )]
    pub night_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init, payer = authority, seeds = [b"day", vault.key().as_ref()], bump,
        mint::decimals = quote_mint.decimals, mint::authority = vault,
        mint::token_program = quote_token_program,
    )]
    pub day_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init, payer = authority, seeds = [b"underlying", vault.key().as_ref()], bump,
        token::mint = underlying_mint, token::authority = vault,
        token::token_program = underlying_token_program,
    )]
    pub underlying_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init, payer = authority, seeds = [b"quote", vault.key().as_ref()], bump,
        token::mint = quote_mint, token::authority = vault,
        token::token_program = quote_token_program,
    )]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: owner, layout and feed id are all verified in `read_quote`.
    pub mark_price_update: UncheckedAccount<'info>,
    /// CHECK: owner, layout and feed id are all verified in `read_quote`.
    pub equity_price_update: UncheckedAccount<'info>,

    // Two programs, because a real vault needs two: NVDAx is Token-2022 and
    // USDC is the classic SPL program. Assuming one covers both is what made
    // the original design unable to hold the asset it was written for.
    pub underlying_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct MintShares<'info> {
    #[account(mut, seeds = [Vault::SEED, vault.underlying_mint.as_ref(), vault.quote_mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut)]
    pub class_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = vault.night_mint)]
    pub night_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = vault.day_mint)]
    pub day_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = vault.quote_vault)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    // Owner as well as mint. A wrong-owner CPI fails anyway, but only after
    // the signature exists: without this a caller can be induced to sign a
    // mint whose shares land in someone else's account.
    #[account(mut,
        constraint = user_quote.mint == vault.quote_mint @ SessionError::WrongMint,
        constraint = user_quote.owner == user.key() @ SessionError::WrongOwner)]
    pub user_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut,
        constraint = user_shares.mint == class_mint.key() @ SessionError::WrongMint,
        constraint = user_shares.owner == user.key() @ SessionError::WrongOwner)]
    pub user_shares: Box<InterfaceAccount<'info, TokenAccount>>,
    pub user: Signer<'info>,

    // `transfer_checked` takes the mint, which is how Token-2022 validates a
    // transfer against the extensions the mint actually carries. Pinned by
    // address so it cannot be substituted for one with friendlier decimals.
    #[account(address = vault.quote_mint @ SessionError::WrongMint)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RedeemShares<'info> {
    #[account(mut, seeds = [Vault::SEED, vault.underlying_mint.as_ref(), vault.quote_mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut)]
    pub class_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = vault.night_mint)]
    pub night_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = vault.day_mint)]
    pub day_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = vault.quote_vault)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    // Owner as well as mint. A wrong-owner CPI fails anyway, but only after
    // the signature exists: without this a caller can be induced to sign a
    // mint whose shares land in someone else's account.
    #[account(mut,
        constraint = user_quote.mint == vault.quote_mint @ SessionError::WrongMint,
        constraint = user_quote.owner == user.key() @ SessionError::WrongOwner)]
    pub user_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut,
        constraint = user_shares.mint == class_mint.key() @ SessionError::WrongMint,
        constraint = user_shares.owner == user.key() @ SessionError::WrongOwner)]
    pub user_shares: Box<InterfaceAccount<'info, TokenAccount>>,
    pub user: Signer<'info>,

    // `transfer_checked` takes the mint, which is how Token-2022 validates a
    // transfer against the extensions the mint actually carries. Pinned by
    // address so it cannot be substituted for one with friendlier decimals.
    #[account(address = vault.quote_mint @ SessionError::WrongMint)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SettleBoundary<'info> {
    #[account(mut, seeds = [Vault::SEED, vault.underlying_mint.as_ref(), vault.quote_mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(address = vault.night_mint)]
    pub night_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = vault.day_mint)]
    pub day_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: owner, layout and feed id are all verified in `read_quote`.
    /// 24/7 price of the token itself — what the vault's assets are worth.
    pub mark_price_update: UncheckedAccount<'info>,
    /// CHECK: owner, layout and feed id are all verified in `read_quote`.
    /// Real-equity feed. Publishes only while the market is open, so its
    /// silence is what tells the vault the market has shut.
    pub equity_price_update: UncheckedAccount<'info>,
    // The issuer's powers are read off the mint, and a seizure or freeze off
    // the vault's own token account, before any accounting is touched.
    #[account(address = vault.underlying_mint @ SessionError::WrongMint)]
    pub underlying_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = vault.underlying_vault)]
    pub underlying_vault: Box<InterfaceAccount<'info, TokenAccount>>,
}

#[derive(Accounts)]
pub struct FillHandoff<'info> {
    #[account(mut, seeds = [Vault::SEED, vault.underlying_mint.as_ref(), vault.quote_mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, address = vault.underlying_vault)]
    pub underlying_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = vault.quote_vault)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = vault.night_mint)]
    pub night_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = vault.day_mint)]
    pub day_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut,
        constraint = filler_underlying.mint == vault.underlying_mint @ SessionError::WrongMint,
        constraint = filler_underlying.owner == filler.key() @ SessionError::WrongOwner)]
    pub filler_underlying: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut,
        constraint = filler_quote.mint == vault.quote_mint @ SessionError::WrongMint,
        constraint = filler_quote.owner == filler.key() @ SessionError::WrongOwner)]
    pub filler_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    pub filler: Signer<'info>,
    /// CHECK: owner, layout and feed id are all verified in `read_quote`.
    pub mark_price_update: UncheckedAccount<'info>,

    // `transfer_checked` takes the mint, which is how Token-2022 validates a
    // transfer against the extensions the mint actually carries. Pinned by
    // address so it cannot be substituted for one with friendlier decimals.
    #[account(address = vault.underlying_mint @ SessionError::WrongMint)]
    pub underlying_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = vault.quote_mint @ SessionError::WrongMint)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    // Both, because this instruction moves both assets.
    pub underlying_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SkimSurplus<'info> {
    #[account(has_one = authority @ SessionError::Unauthorized,
              seeds = [Vault::SEED, vault.underlying_mint.as_ref(), vault.quote_mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    pub authority: Signer<'info>,
    #[account(mut, address = vault.underlying_vault)]
    pub underlying_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = vault.quote_vault)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, constraint = dest_underlying.mint == vault.underlying_mint @ SessionError::WrongMint)]
    pub dest_underlying: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, constraint = dest_quote.mint == vault.quote_mint @ SessionError::WrongMint)]
    pub dest_quote: Box<InterfaceAccount<'info, TokenAccount>>,

    // `transfer_checked` takes the mint, which is how Token-2022 validates a
    // transfer against the extensions the mint actually carries. Pinned by
    // address so it cannot be substituted for one with friendlier decimals.
    #[account(address = vault.underlying_mint @ SessionError::WrongMint)]
    pub underlying_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = vault.quote_mint @ SessionError::WrongMint)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    // Both, because this instruction moves both assets.
    pub underlying_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Recap<'info> {
    #[account(mut, has_one = authority @ SessionError::Unauthorized,
              seeds = [Vault::SEED, vault.underlying_mint.as_ref(), vault.quote_mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    pub authority: Signer<'info>,
    #[account(address = vault.night_mint)]
    pub night_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = vault.day_mint)]
    pub day_mint: Box<InterfaceAccount<'info, Mint>>,
    // remaining_accounts: optionally one Pyth price update per entry, in order.
}

#[derive(Accounts)]
pub struct ResolveHalt<'info> {
    #[account(mut, has_one = authority @ SessionError::Unauthorized,
              seeds = [Vault::SEED, vault.underlying_mint.as_ref(), vault.quote_mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    pub authority: Signer<'info>,
    #[account(address = vault.night_mint)]
    pub night_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = vault.day_mint)]
    pub day_mint: Box<InterfaceAccount<'info, Mint>>,
    // The issuer checks in `resolve_halt` read these; a halt for an issuer
    // condition cannot be cleared while the condition holds.
    #[account(address = vault.underlying_mint @ SessionError::WrongMint)]
    pub underlying_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = vault.underlying_vault)]
    pub underlying_vault: Box<InterfaceAccount<'info, TokenAccount>>,
}

#[derive(Accounts)]
pub struct Admin<'info> {
    #[account(mut, has_one = authority @ SessionError::Unauthorized,
              seeds = [Vault::SEED, vault.underlying_mint.as_ref(), vault.quote_mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(mut, seeds = [Vault::SEED, vault.underlying_mint.as_ref(), vault.quote_mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    pub next_authority: Signer<'info>,
}
