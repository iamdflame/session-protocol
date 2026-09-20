//! SESSION — splitting a tokenized equity into the hours arbitrage works
//! and the hours it does not.
//!
//! A tokenized share trades 24/7, but the stock behind it only trades for 6.5
//! hours a day. During those hours an arbitrageur can hedge the token against
//! the real share and the two stay pinned together. Outside them nobody can,
//! and the token is free to drift. Those are two genuinely different assets
//! wearing one ticker, and this program separates them.
//!
//! A vault holding `X` issues `X.NIGHT` and `X.DAY`. Exactly one of them holds
//! the stock at any moment; the other holds quote. At each session boundary the
//! inventory changes hands — and because a day-holder wants to be flat at
//! precisely the instant a night-holder wants to be long, that handoff is an
//! internal book entry rather than a trade. Only the difference in size between
//! the two sides ever reaches a market.
//!
//! That is the whole reason this is possible here. Harvesting the session
//! premium through a brokerage means ~250 round trips a year and the spread
//! eats the edge. Here the round trip is bookkeeping.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

pub mod calendar;
pub mod errors;
pub mod fixed;
pub mod funding;
pub mod oracle;
pub mod settle;
pub mod state;

use calendar::session_at;
use errors::SessionError;
use fixed::{mul_div_floor, WAD};
use oracle::{effective_session, parse_price_update, Quote};
use settle::settle;
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
        require!(p.funding_max_bps <= 1_000, SessionError::BadParameter);
        require!(p.max_conf_bps <= 2_000, SessionError::BadParameter);
        require!(p.fill_incentive_bps <= 500, SessionError::BadParameter);

        let now = Clock::get()?.unix_timestamp;
        let v = &mut ctx.accounts.vault;

        v.bump = ctx.bumps.vault;
        v.authority = ctx.accounts.authority.key();
        v.underlying_mint = ctx.accounts.underlying_mint.key();
        v.quote_mint = ctx.accounts.quote_mint.key();
        v.underlying_vault = ctx.accounts.underlying_vault.key();
        v.quote_vault = ctx.accounts.quote_vault.key();
        v.underlying_decimals = ctx.accounts.underlying_mint.decimals;
        v.quote_decimals = ctx.accounts.quote_mint.decimals;
        v.night_mint = ctx.accounts.night_mint.key();
        v.day_mint = ctx.accounts.day_mint.key();
        v.mark_feed_id = p.mark_feed_id;
        v.equity_feed_id = p.equity_feed_id;

        v.funding_k_bps = p.funding_k_bps;
        v.funding_max_bps = p.funding_max_bps;
        v.max_stale_secs = p.max_stale_secs;
        v.max_conf_bps = p.max_conf_bps;
        v.max_move_bps = p.max_move_bps;
        v.equity_quiet_secs = p.equity_quiet_secs;
        v.fill_incentive_bps = p.fill_incentive_bps;

        // Both classes start at parity: one quote atom buys one share atom.
        v.night_nav = WAD;
        v.day_nav = WAD;
        v.pending_delta = 0;
        v.cum_funding_night = 0;
        v.boundary_count = 0;
        v.paused = false;

        // Seed exposure from the calendar so the first real boundary is a genuine
        // flip rather than an artefact of when the vault happened to be created.
        let mark_q = read_quote(&ctx.accounts.mark_price_update.to_account_info(), &v.mark_feed_id)?;
        v.last_mark = oracle::check_mark(
            &mark_q, now, 0, v.underlying_decimals, v.quote_decimals, &v.guards(),
        )
        .map_err(map_oracle)?;
        v.exposed = class_for(session_at(now)).into();
        v.last_boundary_ts = now;

        Ok(())
    }

    /// Deposit quote and receive shares of a class, at that class's NAV.
    ///
    /// Only permitted while the class is parked, so issuance never has to buy
    /// or sell stock and therefore never moves the market.
    pub fn mint_shares(ctx: Context<MintShares>, class: Class, quote_amount: u64) -> Result<()> {
        let v = &ctx.accounts.vault;
        require!(!v.paused, SessionError::Paused);
        require!(quote_amount > 0, SessionError::ZeroAmount);
        require!(v.is_parked(class), SessionError::ClassNotParked);
        require_keys_eq!(ctx.accounts.class_mint.key(), mint_for(v, class), SessionError::WrongFeed);

        let nav = v.nav_of(class);
        let shares = mul_div_floor(quote_amount as u128, WAD, nav)
            .ok_or(SessionError::MathOverflow)?;
        require!(shares > 0 && shares <= u64::MAX as u128, SessionError::MathOverflow);

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
            shares as u64,
        )?;

        emit!(SharesMinted {
            vault: v.key(),
            class,
            quote_in: quote_amount,
            shares_out: shares as u64,
            nav,
        });
        Ok(())
    }

    /// Burn shares of a parked class and take the quote back at NAV.
    pub fn redeem_shares(ctx: Context<RedeemShares>, class: Class, shares: u64) -> Result<()> {
        let v = &ctx.accounts.vault;
        require!(!v.paused, SessionError::Paused);
        require!(shares > 0, SessionError::ZeroAmount);
        require!(v.is_parked(class), SessionError::ClassNotParked);
        require_keys_eq!(ctx.accounts.class_mint.key(), mint_for(v, class), SessionError::WrongFeed);

        let nav = v.nav_of(class);
        let quote_out = mul_div_floor(shares as u128, nav, WAD)
            .ok_or(SessionError::MathOverflow)?;
        require!(quote_out > 0 && quote_out <= u64::MAX as u128, SessionError::MathOverflow);

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
            quote_out as u64,
        )?;

        emit!(SharesRedeemed {
            vault: v.key(),
            class,
            shares_in: shares,
            quote_out: quote_out as u64,
            nav,
        });
        Ok(())
    }

    /// Settle a session boundary. Permissionless: anyone may crank it, and it
    /// only does anything when the session has genuinely changed.
    pub fn settle_boundary(ctx: Context<SettleBoundary>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let v = &ctx.accounts.vault;
        require!(!v.paused, SessionError::Paused);

        // The calendar proposes; the equity feed disposes. If the US equity feed
        // has gone quiet during what the calendar calls a session, the market is
        // shut — an unencoded holiday, or a halt — and the vault believes the feed.
        let equity_q = read_quote(&ctx.accounts.equity_price_update.to_account_info(), &v.equity_feed_id)?;
        let session = effective_session(session_at(now), equity_q.publish_time, now, &v.guards());
        let should_be: Class = class_for(session).into();
        require!(should_be != v.exposed, SessionError::NoBoundary);

        let mark_q = read_quote(&ctx.accounts.mark_price_update.to_account_info(), &v.mark_feed_id)?;
        let mark = oracle::check_mark(
            &mark_q, now, v.last_mark, v.underlying_decimals, v.quote_decimals, &v.guards(),
        )
        .map_err(map_oracle)?;

        let nav_state = v.nav_state(
            ctx.accounts.night_mint.supply,
            ctx.accounts.day_mint.supply,
        );
        let out = settle(&nav_state, mark, &v.funding_params())
            .map_err(|_| error!(SessionError::MathOverflow))?;

        let v = &mut ctx.accounts.vault;
        v.night_nav = out.night_nav;
        v.day_nav = out.day_nav;
        v.exposed = out.exposed.into();
        v.last_mark = mark;
        v.last_boundary_ts = now;
        v.boundary_count = v.boundary_count.saturating_add(1);
        v.pending_delta = out.handoff_delta;
        v.cum_funding_night = v.cum_funding_night.saturating_add(out.funding);

        emit!(BoundarySettled {
            vault: v.key(),
            ts: now,
            boundary: v.boundary_count,
            exposed: v.exposed,
            mark,
            night_nav: v.night_nav,
            day_nav: v.day_nav,
            funding: out.funding,
            pending_delta: v.pending_delta,
        });
        Ok(())
    }

    /// Fill part or all of the outstanding imbalance at the oracle mark.
    ///
    /// When the two classes are the same size this never runs — the handoff was
    /// already a book entry. When they are not, the vault has to convert the
    /// difference, and rather than routing through an AMM and paying spread it
    /// simply offers the trade at the mark plus a small incentive. Arbitrageurs
    /// compete to take it, which is cheaper than a swap and has no routing
    /// dependency to break.
    pub fn fill_handoff(ctx: Context<FillHandoff>, underlying_amount: u64, min_quote_out: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let v = &ctx.accounts.vault;
        require!(!v.paused, SessionError::Paused);
        require!(v.pending_delta != 0, SessionError::NothingToFill);
        require!(underlying_amount > 0, SessionError::ZeroAmount);

        let mark_q = read_quote(&ctx.accounts.mark_price_update.to_account_info(), &v.mark_feed_id)?;
        let mark = oracle::check_mark(
            &mark_q, now, v.last_mark, v.underlying_decimals, v.quote_decimals, &v.guards(),
        )
        .map_err(map_oracle)?;

        let gross = mul_div_floor(underlying_amount as u128, mark, WAD)
            .ok_or(SessionError::MathOverflow)?;
        let incentive = mul_div_floor(gross, v.fill_incentive_bps as u128, 10_000)
            .ok_or(SessionError::MathOverflow)?;
        let seeds = vault_seeds(v);

        if v.pending_delta > 0 {
            // The vault is short stock: the filler sells it underlying and is paid
            // slightly above the mark.
            require!(gross <= v.pending_delta as u128, SessionError::FillTooLarge);
            let quote_out = gross
                .checked_add(incentive)
                .ok_or(SessionError::MathOverflow)?;
            require!(quote_out as u64 >= min_quote_out, SessionError::SlippageExceeded);

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
                quote_out as u64,
            )?;

            let v = &mut ctx.accounts.vault;
            v.pending_delta -= gross as i128;
            emit!(HandoffFilled {
                vault: v.key(),
                filler: ctx.accounts.filler.key(),
                underlying_delta: underlying_amount as i64,
                quote_delta: -(quote_out as i64),
                remaining_delta: v.pending_delta,
            });
        } else {
            // The vault is long stock it no longer needs: the filler buys it,
            // slightly below the mark.
            require!(gross <= (-v.pending_delta) as u128, SessionError::FillTooLarge);
            let quote_in = gross
                .checked_sub(incentive)
                .ok_or(SessionError::MathOverflow)?;

            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.filler_quote.to_account_info(),
                        to: ctx.accounts.quote_vault.to_account_info(),
                        authority: ctx.accounts.filler.to_account_info(),
                    },
                ),
                quote_in as u64,
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

            let v = &mut ctx.accounts.vault;
            v.pending_delta += gross as i128;
            emit!(HandoffFilled {
                vault: v.key(),
                filler: ctx.accounts.filler.key(),
                underlying_delta: -(underlying_amount as i64),
                quote_delta: quote_in as i64,
                remaining_delta: v.pending_delta,
            });
        }
        Ok(())
    }

    pub fn set_paused(ctx: Context<Admin>, paused: bool) -> Result<()> {
        ctx.accounts.vault.paused = paused;
        Ok(())
    }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

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
}

fn mint_for(v: &Vault, class: Class) -> Pubkey {
    match class {
        Class::Night => v.night_mint,
        Class::Day => v.day_mint,
    }
}

fn vault_seeds(v: &Vault) -> [&[u8]; 4] {
    [
        Vault::SEED,
        v.underlying_mint.as_ref(),
        v.quote_mint.as_ref(),
        std::slice::from_ref(&v.bump),
    ]
}

/// Read a Pyth price update, without imposing a staleness rule.
///
/// The equity feed is *expected* to be stale for 17 hours a day — that is the
/// signal, not a fault — so staleness is judged by the caller rather than by
/// the accessor.
///
/// Two checks are not optional. The account must be owned by the Pyth receiver,
/// or anyone could pass bytes they wrote themselves; and the feed id must match
/// the one the vault was configured with, or a vault could be settled against
/// some other asset's price.
fn read_quote(ai: &AccountInfo, expect: &[u8; 32]) -> Result<Quote> {
    require_keys_eq!(*ai.owner, PYTH_RECEIVER, SessionError::WrongFeed);
    let data = ai.try_borrow_data()?;
    let update = parse_price_update(&data).map_err(map_oracle)?;
    require!(update.feed_id == *expect, SessionError::WrongFeed);
    Ok(update.quote)
}

fn map_oracle(e: oracle::OracleError) -> Error {
    use oracle::OracleError as O;
    match e {
        O::NonPositivePrice => error!(SessionError::BadOraclePrice),
        O::Stale => error!(SessionError::StaleOracle),
        O::Uncertain => error!(SessionError::UncertainOracle),
        O::MoveTooLarge => error!(SessionError::MoveTooLarge),
        O::BadExponent => error!(SessionError::BadExponent),
        O::WrongAccount | O::Malformed => error!(SessionError::WrongFeed),
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

    /// CHECK: owner and feed id are verified in `read_quote`.
    pub mark_price_update: UncheckedAccount<'info>,

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
    #[account(mut, address = vault.quote_vault)]
    pub quote_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_quote: Account<'info, TokenAccount>,
    #[account(mut)]
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
    #[account(mut, address = vault.quote_vault)]
    pub quote_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_quote: Account<'info, TokenAccount>,
    #[account(mut)]
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
    /// CHECK: owner and feed id are verified in `read_quote`.
    /// 24/7 price of the token itself — what the vault's assets are worth.
    pub mark_price_update: UncheckedAccount<'info>,
    /// CHECK: owner and feed id are verified in `read_quote`.
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
    #[account(mut)]
    pub filler_underlying: Account<'info, TokenAccount>,
    #[account(mut)]
    pub filler_quote: Account<'info, TokenAccount>,
    pub filler: Signer<'info>,
    /// CHECK: owner and feed id are verified in `read_quote`.
    pub mark_price_update: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Admin<'info> {
    #[account(mut, has_one = authority, seeds = [Vault::SEED, vault.underlying_mint.as_ref(), vault.quote_mint.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    pub authority: Signer<'info>,
}
