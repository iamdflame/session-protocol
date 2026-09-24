//! SESSION CROSS: orders that fill at the bell.
//!
//! Orders are placed any time before a bell and filled at one price: the
//! bell's print from `session-bell`, times the xStock's own multiplier (a raw
//! token is `multiplier` shares). Buyers and sellers are netted at that
//! price, and the matched part pays no fee. If one side is larger, makers
//! fill the difference in a short uniform-price auction. `docs/CROSS.md` is
//! the specification, and `session_core::cross` is the arithmetic, pure and
//! property-tested. This program moves tokens by it and by nothing else.
//!
//! ## Lifecycle
//!
//! ```text
//! place / cancel ──(bell − freeze)──► price_cross ──► confirm_orders ──► [auction] ──► clear ──► settle ──► close
//!                                         └── missing print, multiplier anomaly, timeout ──► cancelled ──► refunds
//! ```
//!
//! Everything after `place_order` is permissionless. Settlement order cannot
//! change anyone's result: each order and offer settles from totals fixed at
//! clearing.
//!
//! ## Safety model
//!
//! - **Escrow is tracked, never read.** Each cross records every atom it put
//!   into the market's shared escrow and every atom it paid out, and no
//!   settlement may pay out more than its cross put in (`EscrowOverdrawn`).
//! - **The book freezes before the bell.** Nobody can react to a price they
//!   can see coming, because the price is unknown until the book is closed.
//! - **Refunds are always reachable.** A cancelled cross refunds everyone.
//!   Settlement has a quote leg and a token leg, settled independently, so an
//!   issuer pause of the xStock can delay token legs but never a quote refund.
//!   The admin can stop new orders and nothing else.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_spl::associated_token::{self, AssociatedToken};
use anchor_spl::token_interface::{self as token, Mint, TokenAccount, TokenInterface, TransferChecked};
use session_bell::state::{Print, FLAG_SIMULATED, STATUS_FINAL, STATUS_MISSING};
use session_core::fixed::{abs_diff, WAD};
use session_core::xstock;

pub mod errors;
pub mod state;

use errors::CrossError;
use state::*;

declare_id!("Crosf1CpgcEs6G6SiX2B7KMR4hxVcE2FGU2r53a3RK9K");

/// Why a cross was cancelled, in its `CrossCancelled` event.
pub const CANCEL_PRINT_MISSING: u8 = 1;
pub const CANCEL_MULTIPLIER_NEAR_BELL: u8 = 2;
pub const CANCEL_BAD_MULTIPLIER: u8 = 3;
pub const CANCEL_RR_MISMATCH: u8 = 4;
pub const CANCEL_UNPRICEABLE: u8 = 5;
pub const CANCEL_NO_PRINT_IN_TIME: u8 = 6;

#[program]
pub mod session_cross {
    use super::*;

    /// Create the config. Once, and only by the program's upgrade authority.
    pub fn init_config(ctx: Context<InitConfig>, treasury: Pubkey) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.version = CROSS_VERSION;
        c.bump = ctx.bumps.config;
        c.admin = ctx.accounts.admin.key();
        c.pending_admin = Pubkey::default();
        c.treasury = treasury;
        Ok(())
    }

    pub fn transfer_admin(ctx: Context<Admin>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.config.pending_admin = new_admin;
        Ok(())
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.admin = c.pending_admin;
        c.pending_admin = Pubkey::default();
        Ok(())
    }

    /// Open a market for one xStock, priced by one session-bell listing.
    pub fn create_market(ctx: Context<CreateMarket>, params: MarketParams) -> Result<()> {
        require!(params.valid(), CrossError::BadParams);
        // A market holding real value prices the listing's own mint. A
        // sandbox may price a fixture mint off a real listing's prints.
        if !params.accept_simulated {
            require_keys_eq!(ctx.accounts.listing.mint, ctx.accounts.mint.key(), CrossError::ListingMintMismatch);
        }
        let flags = mint_flags(&ctx.accounts.mint.to_account_info())?;
        require!(!flags.refuses_escrow(), CrossError::MintRefusesEscrow);
        let quote_flags = mint_flags(&ctx.accounts.quote_mint.to_account_info())?;
        require!(!quote_flags.refuses_escrow(), CrossError::MintRefusesEscrow);

        let market_key = ctx.accounts.market.key();
        create_escrow(
            &ctx.accounts.raw_escrow,
            &ctx.accounts.mint.to_account_info(),
            &market_key,
            &ctx.accounts.admin,
            &ctx.accounts.mint_program,
            &ctx.accounts.system_program,
            Market::RAW_ESCROW_SEED,
            ctx.bumps.raw_escrow,
        )?;
        create_escrow(
            &ctx.accounts.quote_escrow,
            &ctx.accounts.quote_mint.to_account_info(),
            &market_key,
            &ctx.accounts.admin,
            &ctx.accounts.quote_program,
            &ctx.accounts.system_program,
            Market::QUOTE_ESCROW_SEED,
            ctx.bumps.quote_escrow,
        )?;

        let m = &mut ctx.accounts.market;
        m.version = CROSS_VERSION;
        m.bump = ctx.bumps.market;
        m.active = true;
        m.listing = ctx.accounts.listing.key();
        m.mint = ctx.accounts.mint.key();
        m.mint_decimals = ctx.accounts.mint.decimals;
        m.mint_program = ctx.accounts.mint_program.key();
        m.quote_mint = ctx.accounts.quote_mint.key();
        m.quote_decimals = ctx.accounts.quote_mint.decimals;
        m.quote_program = ctx.accounts.quote_program.key();
        m.raw_escrow = ctx.accounts.raw_escrow.key();
        m.quote_escrow = ctx.accounts.quote_escrow.key();
        m.params = params;
        m.crosses = 0;
        m.orders = 0;
        emit!(MarketCreated { market: market_key, listing: m.listing, mint: m.mint, quote_mint: m.quote_mint, params });
        Ok(())
    }

    /// Change a market's parameters, or stop and resume new orders. Nothing
    /// here can touch a cross already under way: prices, clearing and
    /// refunds follow their own rules.
    pub fn set_market(ctx: Context<SetMarket>, params: MarketParams, active: bool) -> Result<()> {
        require!(params.valid(), CrossError::BadParams);
        let m = &mut ctx.accounts.market;
        if !params.accept_simulated {
            require_keys_eq!(ctx.accounts.listing.mint, m.mint, CrossError::ListingMintMismatch);
        }
        m.params = params;
        m.active = active;
        Ok(())
    }

    /// Place an order in the cross at `day`'s `kind` bell: quote atoms to
    /// spend (a buy) or raw atoms to sell, and optionally the worst share
    /// price accepted. The first order of a cross creates it.
    pub fn place_order(
        ctx: Context<PlaceOrder>,
        day: i64,
        kind: u8,
        nonce: u16,
        side: u8,
        amount: u64,
        limit_e8: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let m = &ctx.accounts.market;
        require!(m.version == CROSS_VERSION, CrossError::VersionMismatch);
        require!(m.active, CrossError::MarketInactive);
        require!(side == SIDE_BUY || side == SIDE_SELL, CrossError::BadSide);
        let k = session_bell::rules::Kind::from_u8(kind).ok_or(CrossError::NoBell)?;
        let bell = session_bell::rules::bell_ts(day, k).ok_or(CrossError::NoBell)?;
        require!(now < bell - m.params.freeze_secs as i64, CrossError::Frozen);

        let (mint, escrow, program, min, cap) = if side == SIDE_BUY {
            (m.quote_mint, m.quote_escrow, m.quote_program, m.params.min_order_quote, m.params.max_side_quote)
        } else {
            (m.mint, m.raw_escrow, m.mint_program, m.params.min_order_raw, m.params.max_side_raw)
        };
        require_keys_eq!(ctx.accounts.side_mint.key(), mint, CrossError::WrongAccount);
        require_keys_eq!(ctx.accounts.escrow.key(), escrow, CrossError::WrongAccount);
        require_keys_eq!(ctx.accounts.side_program.key(), program, CrossError::WrongAccount);
        require!(amount >= min, CrossError::OrderTooSmall);
        require!(!mint_flags(&ctx.accounts.raw_mint)?.refuses_escrow(), CrossError::MintRefusesEscrow);

        let market_key = m.key();
        let c = &mut ctx.accounts.cross;
        if c.version == 0 {
            c.version = CROSS_VERSION;
            c.bump = ctx.bumps.cross;
            c.phase = PHASE_COLLECTING;
            c.kind = kind;
            c.market = market_key;
            c.day = day;
            c.bell_ts = bell;
            c.created_by = ctx.accounts.owner.key();
            ctx.accounts.market.crosses = ctx.accounts.market.crosses.saturating_add(1);
        }
        require!(c.version == CROSS_VERSION, CrossError::VersionMismatch);
        require!(c.phase == PHASE_COLLECTING, CrossError::NotCollecting);
        if side == SIDE_BUY {
            c.buy_total = c.buy_total.checked_add(amount).ok_or(CrossError::Overflow)?;
            require!(c.buy_total <= cap, CrossError::SideFull);
            c.quote_in = c.quote_in.checked_add(amount).ok_or(CrossError::Overflow)?;
        } else {
            c.sell_total = c.sell_total.checked_add(amount).ok_or(CrossError::Overflow)?;
            require!(c.sell_total <= cap, CrossError::SideFull);
            c.raw_in = c.raw_in.checked_add(amount).ok_or(CrossError::Overflow)?;
        }
        c.n_orders = c.n_orders.checked_add(1).ok_or(CrossError::Overflow)?;

        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.side_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.source.to_account_info(),
                    mint: ctx.accounts.side_mint.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.side_mint.decimals,
        )?;

        let o = &mut ctx.accounts.order;
        o.version = CROSS_VERSION;
        o.bump = ctx.bumps.order;
        o.side = side;
        o.status = ORDER_OPEN;
        o.legs = 0;
        o.cross = ctx.accounts.cross.key();
        o.owner = ctx.accounts.owner.key();
        o.nonce = nonce;
        o.amount = amount;
        o.limit_e8 = limit_e8;
        o.placed_at = now;
        ctx.accounts.market.orders = ctx.accounts.market.orders.saturating_add(1);
        emit!(OrderPlaced {
            cross: o.cross,
            order: o.key(),
            owner: o.owner,
            day,
            kind,
            side,
            amount,
            limit_e8,
        });
        Ok(())
    }

    /// Withdraw an order before the freeze. The escrow comes back whole.
    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let m = &ctx.accounts.market;
        let c = &mut ctx.accounts.cross;
        let o = &ctx.accounts.order;
        require!(c.phase == PHASE_COLLECTING, CrossError::NotCollecting);
        require!(now < c.bell_ts - m.params.freeze_secs as i64, CrossError::Frozen);
        let (mint, escrow, program) = side_accounts(m, o.side);
        require_keys_eq!(ctx.accounts.side_mint.key(), mint, CrossError::WrongAccount);
        require_keys_eq!(ctx.accounts.escrow.key(), escrow, CrossError::WrongAccount);
        require_keys_eq!(ctx.accounts.side_program.key(), program, CrossError::WrongAccount);
        require_keys_eq!(ctx.accounts.destination.owner, o.owner, CrossError::WrongDestination);

        if o.side == SIDE_BUY {
            c.buy_total -= o.amount;
            c.quote_out = c.quote_out.checked_add(o.amount).ok_or(CrossError::Overflow)?;
            require!(c.quote_out <= c.quote_in, CrossError::EscrowOverdrawn);
        } else {
            c.sell_total -= o.amount;
            c.raw_out = c.raw_out.checked_add(o.amount).ok_or(CrossError::Overflow)?;
            require!(c.raw_out <= c.raw_in, CrossError::EscrowOverdrawn);
        }
        c.n_orders -= 1;
        pay_out(
            m,
            &ctx.accounts.side_program,
            &ctx.accounts.escrow.to_account_info(),
            &ctx.accounts.side_mint.to_account_info(),
            &ctx.accounts.destination.to_account_info(),
            &ctx.accounts.market.to_account_info(),
            o.amount,
            ctx.accounts.side_mint.decimals,
        )?;
        emit!(OrderCancelled { cross: c.key(), order: o.key(), owner: o.owner, amount: o.amount });
        Ok(())
    }

    /// Price the cross from the bell's final print, or cancel it if the
    /// print is missing or the multiplier cannot be trusted at the bell.
    /// Permissionless.
    pub fn price_cross(ctx: Context<PriceCross>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let m = &ctx.accounts.market;
        let p = &ctx.accounts.print;
        let print_key = p.key();
        let c = &mut ctx.accounts.cross;
        require!(c.phase == PHASE_COLLECTING, CrossError::NotCollecting);

        if p.status == STATUS_MISSING {
            return cancel(c, CANCEL_PRINT_MISSING);
        }
        require!(p.status == STATUS_FINAL, CrossError::PrintNotFinal);
        let simulated = p.flags & FLAG_SIMULATED != 0;
        require!(!simulated || m.params.accept_simulated, CrossError::SimulatedPrint);

        // The multiplier in force at the bell, unless an activation falls
        // close enough to it (or after it, before now) to make "the
        // multiplier at the bell" a guess.
        let flags = mint_flags(&ctx.accounts.raw_mint)?;
        let multiplier_wad = match flags.scaled_ui {
            None => WAD,
            Some(s) => {
                let guard = m.params.multiplier_guard_secs as i64;
                let near = s.new_effective_ts >= c.bell_ts - guard && s.new_effective_ts <= now.max(c.bell_ts + guard);
                if near {
                    return cancel(c, CANCEL_MULTIPLIER_NEAR_BELL);
                }
                match xstock::multiplier_wad(s.bits_at(c.bell_ts)) {
                    Some(w) => w,
                    None => return cancel(c, CANCEL_BAD_MULTIPLIER),
                }
            }
        };

        // Pyth's redemption rate, when the print carries it, must agree.
        if p.rr.present {
            let agrees = rate_wad(p.rr.price, p.rr.expo)
                .map(|rr| abs_diff(rr, multiplier_wad).saturating_mul(10_000) <= (m.params.rr_tolerance_bps as u128).saturating_mul(multiplier_wad))
                .unwrap_or(false);
            if !agrees {
                return cancel(c, CANCEL_RR_MISMATCH);
            }
        }

        let (Some(x), Some(e8)) = (
            xstock::price_per_raw_wad(p.equity.price, p.equity.expo, multiplier_wad, m.quote_decimals, m.mint_decimals),
            xstock::price_e8(p.equity.price, p.equity.expo),
        ) else {
            return cancel(c, CANCEL_UNPRICEABLE);
        };

        c.print = print_key;
        c.price_mantissa = p.equity.price;
        c.price_expo = p.equity.expo;
        c.price_e8 = e8;
        c.multiplier_wad = multiplier_wad;
        c.price_wad = x;
        c.simulated = simulated;
        c.priced_at = now;
        c.phase = PHASE_CONFIRMING;
        emit!(CrossPriced {
            cross: c.key(),
            print: print_key,
            price_mantissa: p.equity.price,
            price_expo: p.equity.expo,
            multiplier_wad,
            price_wad: x,
            simulated,
        });
        if c.n_orders == 0 {
            finish_book(c, now, m.params.auction_secs)?;
        }
        Ok(())
    }

    /// Cancel a cross whose print never came. Permissionless, once
    /// `cancel_after_secs` have passed since the bell.
    pub fn cancel_cross(ctx: Context<CancelCross>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.cross;
        require!(c.phase == PHASE_COLLECTING, CrossError::NotCollecting);
        require!(now > c.bell_ts + ctx.accounts.market.params.cancel_after_secs as i64, CrossError::TooEarlyToCancel);
        cancel(c, CANCEL_NO_PRINT_IN_TIME)
    }

    /// Check a batch of orders (the remaining accounts) against their limits
    /// at the cross's price. When the last is confirmed, the book is final:
    /// a balanced cross clears at once, an imbalanced one opens its auction.
    /// Permissionless, idempotent per order.
    pub fn confirm_orders<'info>(ctx: Context<'_, '_, 'info, 'info, ConfirmOrders<'info>>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let auction_secs = ctx.accounts.market.params.auction_secs;
        let c = &mut ctx.accounts.cross;
        require!(c.phase == PHASE_CONFIRMING, CrossError::NotConfirming);
        let cross_key = c.key();
        for ai in ctx.remaining_accounts.iter() {
            let mut o: Account<'info, Order> = Account::try_from(ai)?;
            require_keys_eq!(o.cross, cross_key, CrossError::WrongCross);
            if o.status != ORDER_OPEN {
                continue;
            }
            if in_band(o.side, o.limit_e8, c.price_e8) {
                o.status = ORDER_IN_BAND;
                if o.side == SIDE_BUY {
                    c.buy_in = c.buy_in.checked_add(o.amount).ok_or(CrossError::Overflow)?;
                } else {
                    c.sell_in = c.sell_in.checked_add(o.amount).ok_or(CrossError::Overflow)?;
                }
            } else {
                o.status = ORDER_OUT_OF_BAND;
            }
            c.n_confirmed += 1;
            o.exit(&crate::ID)?;
        }
        if c.n_confirmed == c.n_orders {
            finish_book(c, now, auction_secs)?;
        }
        Ok(())
    }

    /// Offer to fill the crowded side: raw tokens to sell to crowded buyers,
    /// or quote to buy from crowded sellers, at `fee_bps`. Firm: an offer
    /// cannot be withdrawn, only filled or refunded after clearing.
    pub fn post_offer(ctx: Context<PostOffer>, nonce: u16, size: u64, fee_bps: u16) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let m = &ctx.accounts.market;
        let c = &mut ctx.accounts.cross;
        require!(c.phase == PHASE_AUCTION && now < c.auction_end, CrossError::AuctionClosed);
        require!(fee_bps <= m.params.max_fee_bps, CrossError::FeeTooHigh);
        // makers supply what the crowded side wants
        let side = if c.crowded == CROWDED_BUYERS { SIDE_SELL } else { SIDE_BUY };
        let (mint, escrow, program) = side_accounts(m, side);
        require_keys_eq!(ctx.accounts.side_mint.key(), mint, CrossError::WrongSide);
        require_keys_eq!(ctx.accounts.escrow.key(), escrow, CrossError::WrongAccount);
        require_keys_eq!(ctx.accounts.side_program.key(), program, CrossError::WrongAccount);
        let min = if side == SIDE_SELL { m.params.min_order_raw } else { m.params.min_order_quote };
        require!(size >= min, CrossError::OrderTooSmall);
        require!(!mint_flags(&ctx.accounts.raw_mint)?.refuses_escrow(), CrossError::MintRefusesEscrow);

        let bucket = &mut c.ladder[fee_bps as usize];
        *bucket = bucket.checked_add(size).ok_or(CrossError::Overflow)?;
        if side == SIDE_SELL {
            c.raw_in = c.raw_in.checked_add(size).ok_or(CrossError::Overflow)?;
        } else {
            c.quote_in = c.quote_in.checked_add(size).ok_or(CrossError::Overflow)?;
        }
        c.n_offers = c.n_offers.checked_add(1).ok_or(CrossError::Overflow)?;

        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.side_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.source.to_account_info(),
                    mint: ctx.accounts.side_mint.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                    authority: ctx.accounts.maker.to_account_info(),
                },
            ),
            size,
            ctx.accounts.side_mint.decimals,
        )?;

        let o = &mut ctx.accounts.offer;
        o.version = CROSS_VERSION;
        o.bump = ctx.bumps.offer;
        o.side = c.crowded;
        o.legs = 0;
        o.fee_bps = fee_bps;
        o.cross = c.key();
        o.maker = ctx.accounts.maker.key();
        o.nonce = nonce;
        o.size = size;
        o.posted_at = now;
        emit!(OfferPosted { cross: o.cross, offer: o.key(), maker: o.maker, fee_bps, size });
        Ok(())
    }

    /// Clear the cross once its auction has ended. Permissionless.
    pub fn clear(ctx: Context<Clear>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.cross;
        require!(c.phase == PHASE_AUCTION, CrossError::AuctionClosed);
        require!(now >= c.auction_end, CrossError::AuctionOpen);
        let r = session_core::cross::clear(c.price_wad, c.buy_in as u128, c.sell_in as u128, &c.ladder)
            .ok_or(CrossError::Overflow)?;
        c.store(&r);
        c.phase = PHASE_SETTLING;
        c.cleared_at = now;
        emit_cleared(c);
        Ok(())
    }

    /// Pay an order's owner what the clearing gives it: the quote leg, the
    /// token leg, or both (`legs`). Each leg settles once; the order closes
    /// when both have. Permissionless: the caller pays for any token account
    /// the owner lacks.
    pub fn settle_order(ctx: Context<SettleOrder>, legs: u8) -> Result<()> {
        let c = &ctx.accounts.cross;
        require!(c.phase == PHASE_SETTLING || c.phase == PHASE_CANCELLED, CrossError::NotSettling);
        let o = &ctx.accounts.order;
        let (quote_owed, raw_owed) = owed_to_order(c, o)?;
        let (quote_leg, raw_leg) = (legs & LEG_QUOTE != 0 && o.legs & LEG_QUOTE == 0, legs & LEG_RAW != 0 && o.legs & LEG_RAW == 0);

        let a = &ctx.accounts;
        if quote_leg && quote_owed > 0 {
            settle_leg(a.market.as_ref(), &a.cranker, &a.owner.to_account_info(), &a.owner_quote, &a.quote_escrow.to_account_info(), &a.quote_mint, &a.quote_program, &a.associated_token_program, &a.system_program, quote_owed)?;
        }
        if raw_leg && raw_owed > 0 {
            settle_leg(a.market.as_ref(), &a.cranker, &a.owner.to_account_info(), &a.owner_raw, &a.raw_escrow.to_account_info(), &a.raw_mint, &a.raw_program, &a.associated_token_program, &a.system_program, raw_owed)?;
        }

        let c = &mut ctx.accounts.cross;
        let o = &mut ctx.accounts.order;
        if quote_leg {
            c.quote_out = c.quote_out.checked_add(quote_owed).ok_or(CrossError::Overflow)?;
            require!(c.quote_out <= c.quote_in, CrossError::EscrowOverdrawn);
            o.legs |= LEG_QUOTE;
        }
        if raw_leg {
            c.raw_out = c.raw_out.checked_add(raw_owed).ok_or(CrossError::Overflow)?;
            require!(c.raw_out <= c.raw_in, CrossError::EscrowOverdrawn);
            o.legs |= LEG_RAW;
        }
        if quote_leg || raw_leg {
            emit!(OrderSettled {
                cross: c.key(),
                order: o.key(),
                owner: o.owner,
                quote: if quote_leg { quote_owed } else { 0 },
                raw: if raw_leg { raw_owed } else { 0 },
            });
        }
        if o.legs == LEGS_ALL {
            c.n_settled += 1;
            ctx.accounts.order.close(ctx.accounts.owner.to_account_info())?;
        }
        Ok(())
    }

    /// Pay a maker what the clearing gives its offer. As `settle_order`.
    pub fn settle_offer(ctx: Context<SettleOffer>, legs: u8) -> Result<()> {
        let c = &ctx.accounts.cross;
        require!(c.phase == PHASE_SETTLING, CrossError::NotSettling);
        let o = &ctx.accounts.offer;
        let (quote_owed, raw_owed) = owed_to_offer(c, o)?;
        let (quote_leg, raw_leg) = (legs & LEG_QUOTE != 0 && o.legs & LEG_QUOTE == 0, legs & LEG_RAW != 0 && o.legs & LEG_RAW == 0);

        let a = &ctx.accounts;
        if quote_leg && quote_owed > 0 {
            settle_leg(a.market.as_ref(), &a.cranker, &a.maker.to_account_info(), &a.maker_quote, &a.quote_escrow.to_account_info(), &a.quote_mint, &a.quote_program, &a.associated_token_program, &a.system_program, quote_owed)?;
        }
        if raw_leg && raw_owed > 0 {
            settle_leg(a.market.as_ref(), &a.cranker, &a.maker.to_account_info(), &a.maker_raw, &a.raw_escrow.to_account_info(), &a.raw_mint, &a.raw_program, &a.associated_token_program, &a.system_program, raw_owed)?;
        }

        let c = &mut ctx.accounts.cross;
        let o = &mut ctx.accounts.offer;
        if quote_leg {
            c.quote_out = c.quote_out.checked_add(quote_owed).ok_or(CrossError::Overflow)?;
            require!(c.quote_out <= c.quote_in, CrossError::EscrowOverdrawn);
            o.legs |= LEG_QUOTE;
        }
        if raw_leg {
            c.raw_out = c.raw_out.checked_add(raw_owed).ok_or(CrossError::Overflow)?;
            require!(c.raw_out <= c.raw_in, CrossError::EscrowOverdrawn);
            o.legs |= LEG_RAW;
        }
        if quote_leg || raw_leg {
            emit!(OfferSettled {
                cross: c.key(),
                offer: o.key(),
                maker: o.maker,
                quote: if quote_leg { quote_owed } else { 0 },
                raw: if raw_leg { raw_owed } else { 0 },
            });
        }
        if o.legs == LEGS_ALL {
            c.n_offers_settled += 1;
            ctx.accounts.offer.close(ctx.accounts.maker.to_account_info())?;
        }
        Ok(())
    }

    /// Close a cross whose every order and offer has settled: its rounding
    /// dust goes to the treasury and its rent back to whoever paid it.
    pub fn close_cross(ctx: Context<CloseCross>) -> Result<()> {
        let c = &ctx.accounts.cross;
        require!(c.phase == PHASE_SETTLING || c.phase == PHASE_CANCELLED, CrossError::NotSettling);
        require!(c.n_settled == c.n_orders && c.n_offers_settled == c.n_offers, CrossError::Unsettled);
        let raw_dust = c.raw_in.checked_sub(c.raw_out).ok_or(CrossError::EscrowOverdrawn)?;
        let quote_dust = c.quote_in.checked_sub(c.quote_out).ok_or(CrossError::EscrowOverdrawn)?;
        let a = &ctx.accounts;
        let treasury = a.treasury.to_account_info();
        if raw_dust > 0 {
            settle_leg(a.market.as_ref(), &a.cranker, &treasury, &a.treasury_raw, &a.raw_escrow.to_account_info(), &a.raw_mint, &a.raw_program, &a.associated_token_program, &a.system_program, raw_dust)?;
        }
        if quote_dust > 0 {
            settle_leg(a.market.as_ref(), &a.cranker, &treasury, &a.treasury_quote, &a.quote_escrow.to_account_info(), &a.quote_mint, &a.quote_program, &a.associated_token_program, &a.system_program, quote_dust)?;
        }
        emit!(CrossClosed { cross: c.key(), raw_dust, quote_dust });
        Ok(())
    }
}

/* ── the rules, applied ───────────────────────────────────────────────────── */

fn cancel(c: &mut Account<Cross>, reason: u8) -> Result<()> {
    c.phase = PHASE_CANCELLED;
    emit!(CrossCancelled { cross: c.key(), reason });
    Ok(())
}

/// The book is final. A balanced (or empty) cross clears at once; an
/// imbalanced one opens its auction.
fn finish_book(c: &mut Account<Cross>, now: i64, auction_secs: u32) -> Result<()> {
    let probe = session_core::cross::clear(c.price_wad, c.buy_in as u128, c.sell_in as u128, &c.ladder)
        .ok_or(CrossError::Overflow)?;
    if probe.crowded == session_core::cross::Crowded::Balanced {
        c.store(&probe);
        c.phase = PHASE_SETTLING;
        c.cleared_at = now;
        emit_cleared(c);
    } else {
        c.crowded = if probe.crowded == session_core::cross::Crowded::Buyers { CROWDED_BUYERS } else { CROWDED_SELLERS };
        c.phase = PHASE_AUCTION;
        c.auction_end = now + auction_secs as i64;
        emit!(AuctionOpened { cross: c.key(), crowded: c.crowded, buy_in: c.buy_in, sell_in: c.sell_in, auction_end: c.auction_end });
    }
    Ok(())
}

fn emit_cleared(c: &Cross) {
    emit!(CrossCleared {
        market: c.market,
        day: c.day,
        kind: c.kind,
        crowded: c.crowded,
        fee_bps: c.fee_bps,
        price_wad: c.price_wad,
        buy_in: c.buy_in,
        buy_spent: c.buy_spent as u64,
        buy_tokens: c.buy_tokens as u64,
        sell_in: c.sell_in,
        sell_spent: c.sell_spent as u64,
        sell_quote: c.sell_quote as u64,
    });
}

/// (quote, raw) the order's owner is owed. A cancelled cross, an order out
/// of band, or one never confirmed gets its escrow back whole.
fn owed_to_order(c: &Cross, o: &Order) -> Result<(u64, u64)> {
    if c.phase == PHASE_CANCELLED || o.status != ORDER_IN_BAND {
        return Ok(if o.side == SIDE_BUY { (o.amount, 0) } else { (0, o.amount) });
    }
    let clearing = c.clearing();
    let amount = o.amount as u128;
    let to_u64 = |v: u128| u64::try_from(v).map_err(|_| error!(CrossError::Overflow));
    if o.side == SIDE_BUY {
        // the unspent quote back, and the raw atoms bought
        let (spent, got) = session_core::cross::buyer_leg(amount, &clearing).ok_or(CrossError::Overflow)?;
        Ok((to_u64(amount - spent)?, to_u64(got)?))
    } else {
        // the quote received, and the unsold raw atoms back
        let (spent, got) = session_core::cross::seller_leg(amount, &clearing).ok_or(CrossError::Overflow)?;
        Ok((to_u64(got)?, to_u64(amount - spent)?))
    }
}

/// (quote, raw) the maker is owed for its offer.
fn owed_to_offer(c: &Cross, o: &Offer) -> Result<(u64, u64)> {
    let size = o.size as u128;
    let (given, received) = session_core::cross::maker_leg(size, o.fee_bps, &c.clearing()).ok_or(CrossError::Overflow)?;
    let back = u64::try_from(size - given).map_err(|_| CrossError::Overflow)?;
    let received = u64::try_from(received).map_err(|_| CrossError::Overflow)?;
    // a token offer gets its unfilled tokens back and quote for the rest; a
    // quote offer the reverse
    Ok(if o.side == CROWDED_BUYERS { (received, back) } else { (back, received) })
}

/// A Pyth rate as WAD, rounded down.
fn rate_wad(price: i64, expo: i16) -> Option<u128> {
    if price <= 0 {
        return None;
    }
    let k = 18 + expo as i32;
    if k >= 0 {
        (price as u128).checked_mul(10u128.checked_pow(k as u32)?)
    } else {
        Some(price as u128 / 10u128.checked_pow((-k) as u32)?)
    }
}

fn mint_flags(ai: &AccountInfo) -> Result<xstock::IssuerFlags> {
    let data = ai.try_borrow_data()?;
    xstock::issuer_flags(&data).map_err(|_| error!(CrossError::NotAMint))
}

fn side_accounts(m: &Market, side: u8) -> (Pubkey, Pubkey, Pubkey) {
    if side == SIDE_BUY {
        (m.quote_mint, m.quote_escrow, m.quote_program)
    } else {
        (m.mint, m.raw_escrow, m.mint_program)
    }
}

/* ── moving tokens ────────────────────────────────────────────────────────── */

fn market_seeds(m: &Market) -> [&[u8]; 3] {
    [Market::SEED, m.mint.as_ref(), std::slice::from_ref(&m.bump)]
}

#[allow(clippy::too_many_arguments)]
fn pay_out<'info>(
    m: &Market,
    program: &Interface<'info, TokenInterface>,
    escrow: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    market: &AccountInfo<'info>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    let seeds = market_seeds(m);
    token::transfer_checked(
        CpiContext::new_with_signer(
            program.to_account_info(),
            TransferChecked { from: escrow.clone(), mint: mint.clone(), to: to.clone(), authority: market.clone() },
            &[&seeds[..]],
        ),
        amount,
        decimals,
    )
}

/// Pay `amount` from escrow to `owner`'s associated token account for
/// `mint`, creating it first (at the caller's expense) if it does not exist.
#[allow(clippy::too_many_arguments)]
fn settle_leg<'info>(
    market: &Account<'info, Market>,
    payer: &Signer<'info>,
    owner: &AccountInfo<'info>,
    ata: &UncheckedAccount<'info>,
    escrow: &AccountInfo<'info>,
    mint: &InterfaceAccount<'info, Mint>,
    program: &Interface<'info, TokenInterface>,
    ata_program: &Program<'info, AssociatedToken>,
    system_program: &Program<'info, System>,
    amount: u64,
) -> Result<()> {
    let expected = associated_token::get_associated_token_address_with_program_id(owner.key, &mint.key(), program.key);
    require_keys_eq!(ata.key(), expected, CrossError::WrongDestination);
    if ata.data_is_empty() {
        associated_token::create_idempotent(CpiContext::new(
            ata_program.to_account_info(),
            associated_token::Create {
                payer: payer.to_account_info(),
                associated_token: ata.to_account_info(),
                authority: owner.clone(),
                mint: mint.to_account_info(),
                system_program: system_program.to_account_info(),
                token_program: program.to_account_info(),
            },
        ))?;
    }
    pay_out(market, program, escrow, &mint.to_account_info(), &ata.to_account_info(), &market.to_account_info(), amount, mint.decimals)
}

/// Create a market's escrow token account at its PDA, owned by the market.
/// Its length comes from the token program itself (`GetAccountDataSize`),
/// which knows every extension a Token-2022 mint obliges its accounts to carry.
#[allow(clippy::too_many_arguments)]
fn create_escrow<'info>(
    account: &UncheckedAccount<'info>,
    mint: &AccountInfo<'info>,
    market: &Pubkey,
    payer: &Signer<'info>,
    token_program: &Interface<'info, TokenInterface>,
    system_program: &Program<'info, System>,
    seed: &[u8],
    bump: u8,
) -> Result<()> {
    use anchor_lang::solana_program::program::invoke_signed;
    use anchor_lang::solana_program::system_instruction;
    use anchor_spl::token_2022::spl_token_2022;

    require!(account.data_is_empty(), CrossError::WrongAccount);
    let len = if *token_program.key == anchor_spl::token::ID {
        165
    } else {
        invoke(
            &spl_token_2022::instruction::get_account_data_size(token_program.key, mint.key, &[])?,
            &[mint.clone(), token_program.to_account_info()],
        )?;
        let (who, bytes) = anchor_lang::solana_program::program::get_return_data().ok_or(error!(CrossError::NotAMint))?;
        require_keys_eq!(who, *token_program.key, CrossError::NotAMint);
        let n: [u8; 8] = bytes.get(..8).ok_or(error!(CrossError::NotAMint))?.try_into().map_err(|_| error!(CrossError::NotAMint))?;
        u64::from_le_bytes(n) as usize
    };
    require!(len >= 165, CrossError::NotAMint);
    let seeds: [&[u8]; 3] = [seed, market.as_ref(), std::slice::from_ref(&bump)];
    invoke_signed(
        &system_instruction::create_account(payer.key, account.key, Rent::get()?.minimum_balance(len), len as u64, token_program.key),
        &[payer.to_account_info(), account.to_account_info(), system_program.to_account_info()],
        &[&seeds[..]],
    )?;
    let ix = spl_token_2022::instruction::initialize_account3(token_program.key, account.key, mint.key, market)?;
    invoke(&ix, &[account.to_account_info(), mint.clone(), token_program.to_account_info()])?;
    Ok(())
}

/* ── accounts ─────────────────────────────────────────────────────────────── */

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = CrossConfig::SIZE, seeds = [CrossConfig::SEED], bump)]
    pub config: Box<Account<'info, CrossConfig>>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ CrossError::NotUpgradeAuthority)]
    pub program: Program<'info, crate::program::SessionCross>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ CrossError::NotUpgradeAuthority)]
    pub program_data: Box<Account<'info, ProgramData>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Admin<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CrossConfig::SEED], bump = config.bump, has_one = admin @ CrossError::Unauthorized)]
    pub config: Box<Account<'info, CrossConfig>>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CrossConfig::SEED],
        bump = config.bump,
        constraint = config.pending_admin != Pubkey::default()
            && config.pending_admin == new_admin.key() @ CrossError::NotPendingAdmin,
    )]
    pub config: Box<Account<'info, CrossConfig>>,
}

#[derive(Accounts)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CrossConfig::SEED], bump = config.bump, has_one = admin @ CrossError::Unauthorized)]
    pub config: Box<Account<'info, CrossConfig>>,
    #[account(init, payer = admin, space = Market::SIZE, seeds = [Market::SEED, mint.key().as_ref()], bump)]
    pub market: Box<Account<'info, Market>>,
    pub listing: Box<Account<'info, session_bell::state::Listing>>,
    #[account(mint::token_program = mint_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mint::token_program = quote_program)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    pub mint_program: Interface<'info, TokenInterface>,
    pub quote_program: Interface<'info, TokenInterface>,
    /// CHECK: created here, at its PDA
    #[account(mut, seeds = [Market::RAW_ESCROW_SEED, market.key().as_ref()], bump)]
    pub raw_escrow: UncheckedAccount<'info>,
    /// CHECK: created here, at its PDA
    #[account(mut, seeds = [Market::QUOTE_ESCROW_SEED, market.key().as_ref()], bump)]
    pub quote_escrow: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetMarket<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CrossConfig::SEED], bump = config.bump, has_one = admin @ CrossError::Unauthorized)]
    pub config: Box<Account<'info, CrossConfig>>,
    #[account(mut, seeds = [Market::SEED, market.mint.as_ref()], bump = market.bump, has_one = listing)]
    pub market: Box<Account<'info, Market>>,
    pub listing: Box<Account<'info, session_bell::state::Listing>>,
}

#[derive(Accounts)]
#[instruction(day: i64, kind: u8, nonce: u16)]
pub struct PlaceOrder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [Market::SEED, market.mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(
        init_if_needed,
        payer = owner,
        space = Cross::SIZE,
        seeds = [Cross::SEED, market.key().as_ref(), &day.to_le_bytes(), &[kind]],
        bump,
    )]
    pub cross: Box<Account<'info, Cross>>,
    #[account(
        init,
        payer = owner,
        space = Order::SIZE,
        seeds = [Order::SEED, cross.key().as_ref(), owner.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub order: Box<Account<'info, Order>>,
    /// CHECK: the xStock, read for the issuer's switches whichever side this is
    #[account(address = market.mint @ CrossError::WrongAccount)]
    pub raw_mint: UncheckedAccount<'info>,
    /// The mint of the order's side: the quote for a buy, the xStock for a sell.
    pub side_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = side_mint, token::authority = owner, token::token_program = side_program)]
    pub source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    pub side_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [Market::SEED, market.mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, has_one = market @ CrossError::WrongAccount)]
    pub cross: Box<Account<'info, Cross>>,
    #[account(
        mut,
        close = owner,
        has_one = owner @ CrossError::NotOwner,
        has_one = cross @ CrossError::WrongCross,
    )]
    pub order: Box<Account<'info, Order>>,
    pub side_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = side_mint, token::token_program = side_program)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    pub side_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct PriceCross<'info> {
    #[account(mut, has_one = market @ CrossError::WrongAccount)]
    pub cross: Box<Account<'info, Cross>>,
    pub market: Box<Account<'info, Market>>,
    /// The bell's print for this cross's listing, day and kind: the seeds
    /// bind it, and Anchor checks it is session-bell's own account.
    #[account(
        seeds = [Print::SEED, market.listing.as_ref(), &cross.day.to_le_bytes(), &[cross.kind]],
        bump = print.bump,
        seeds::program = session_bell::ID,
    )]
    pub print: Box<Account<'info, Print>>,
    /// CHECK: the xStock, read for its multiplier
    #[account(address = market.mint @ CrossError::WrongAccount)]
    pub raw_mint: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CancelCross<'info> {
    #[account(mut, has_one = market @ CrossError::WrongAccount)]
    pub cross: Box<Account<'info, Cross>>,
    pub market: Box<Account<'info, Market>>,
}

#[derive(Accounts)]
pub struct ConfirmOrders<'info> {
    #[account(mut, has_one = market @ CrossError::WrongAccount)]
    pub cross: Box<Account<'info, Cross>>,
    pub market: Box<Account<'info, Market>>,
}

#[derive(Accounts)]
#[instruction(nonce: u16)]
pub struct PostOffer<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    pub market: Box<Account<'info, Market>>,
    #[account(mut, has_one = market @ CrossError::WrongAccount)]
    pub cross: Box<Account<'info, Cross>>,
    #[account(
        init,
        payer = maker,
        space = Offer::SIZE,
        seeds = [Offer::SEED, cross.key().as_ref(), maker.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub offer: Box<Account<'info, Offer>>,
    /// CHECK: the xStock, read for the issuer's switches
    #[account(address = market.mint @ CrossError::WrongAccount)]
    pub raw_mint: UncheckedAccount<'info>,
    pub side_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = side_mint, token::authority = maker, token::token_program = side_program)]
    pub source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    pub side_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Clear<'info> {
    #[account(mut)]
    pub cross: Box<Account<'info, Cross>>,
}

#[derive(Accounts)]
pub struct SettleOrder<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(seeds = [Market::SEED, market.mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, has_one = market @ CrossError::WrongAccount)]
    pub cross: Box<Account<'info, Cross>>,
    #[account(mut, has_one = cross @ CrossError::WrongCross, has_one = owner @ CrossError::NotOwner)]
    pub order: Box<Account<'info, Order>>,
    /// CHECK: the order's owner; receives the order's rent when it closes
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    /// CHECK: the owner's associated token account for the xStock; checked and created in `settle_leg`
    #[account(mut)]
    pub owner_raw: UncheckedAccount<'info>,
    /// CHECK: the owner's associated token account for the quote; as above
    #[account(mut)]
    pub owner_quote: UncheckedAccount<'info>,
    #[account(mut, address = market.raw_escrow @ CrossError::WrongAccount)]
    pub raw_escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = market.quote_escrow @ CrossError::WrongAccount)]
    pub quote_escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = market.mint @ CrossError::WrongAccount)]
    pub raw_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = market.quote_mint @ CrossError::WrongAccount)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = market.mint_program @ CrossError::WrongAccount)]
    pub raw_program: Interface<'info, TokenInterface>,
    #[account(address = market.quote_program @ CrossError::WrongAccount)]
    pub quote_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleOffer<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(seeds = [Market::SEED, market.mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, has_one = market @ CrossError::WrongAccount)]
    pub cross: Box<Account<'info, Cross>>,
    #[account(mut, has_one = cross @ CrossError::WrongCross, has_one = maker @ CrossError::NotOwner)]
    pub offer: Box<Account<'info, Offer>>,
    /// CHECK: the offer's maker; receives the offer's rent when it closes
    #[account(mut)]
    pub maker: UncheckedAccount<'info>,
    /// CHECK: checked and created in `settle_leg`
    #[account(mut)]
    pub maker_raw: UncheckedAccount<'info>,
    /// CHECK: checked and created in `settle_leg`
    #[account(mut)]
    pub maker_quote: UncheckedAccount<'info>,
    #[account(mut, address = market.raw_escrow @ CrossError::WrongAccount)]
    pub raw_escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = market.quote_escrow @ CrossError::WrongAccount)]
    pub quote_escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = market.mint @ CrossError::WrongAccount)]
    pub raw_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = market.quote_mint @ CrossError::WrongAccount)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = market.mint_program @ CrossError::WrongAccount)]
    pub raw_program: Interface<'info, TokenInterface>,
    #[account(address = market.quote_program @ CrossError::WrongAccount)]
    pub quote_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseCross<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(seeds = [CrossConfig::SEED], bump = config.bump)]
    pub config: Box<Account<'info, CrossConfig>>,
    #[account(seeds = [Market::SEED, market.mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, has_one = market @ CrossError::WrongAccount, close = created_by)]
    pub cross: Box<Account<'info, Cross>>,
    /// CHECK: gets the cross's rent back
    #[account(mut, address = cross.created_by @ CrossError::WrongAccount)]
    pub created_by: UncheckedAccount<'info>,
    /// CHECK: the treasury the config names
    #[account(address = config.treasury @ CrossError::WrongAccount)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: checked and created in `settle_leg`
    #[account(mut)]
    pub treasury_raw: UncheckedAccount<'info>,
    /// CHECK: checked and created in `settle_leg`
    #[account(mut)]
    pub treasury_quote: UncheckedAccount<'info>,
    #[account(mut, address = market.raw_escrow @ CrossError::WrongAccount)]
    pub raw_escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = market.quote_escrow @ CrossError::WrongAccount)]
    pub quote_escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = market.mint @ CrossError::WrongAccount)]
    pub raw_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = market.quote_mint @ CrossError::WrongAccount)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = market.mint_program @ CrossError::WrongAccount)]
    pub raw_program: Interface<'info, TokenInterface>,
    #[account(address = market.quote_program @ CrossError::WrongAccount)]
    pub quote_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/* ── events ───────────────────────────────────────────────────────────────── */

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub listing: Pubkey,
    pub mint: Pubkey,
    pub quote_mint: Pubkey,
    pub params: MarketParams,
}

#[event]
pub struct OrderPlaced {
    pub cross: Pubkey,
    pub order: Pubkey,
    pub owner: Pubkey,
    pub day: i64,
    pub kind: u8,
    pub side: u8,
    pub amount: u64,
    pub limit_e8: u64,
}

#[event]
pub struct OrderCancelled {
    pub cross: Pubkey,
    pub order: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct CrossPriced {
    pub cross: Pubkey,
    pub print: Pubkey,
    pub price_mantissa: i64,
    pub price_expo: i16,
    pub multiplier_wad: u128,
    pub price_wad: u128,
    pub simulated: bool,
}

#[event]
pub struct CrossCancelled {
    pub cross: Pubkey,
    pub reason: u8,
}

#[event]
pub struct AuctionOpened {
    pub cross: Pubkey,
    pub crowded: u8,
    pub buy_in: u64,
    pub sell_in: u64,
    pub auction_end: i64,
}

#[event]
pub struct OfferPosted {
    pub cross: Pubkey,
    pub offer: Pubkey,
    pub maker: Pubkey,
    pub fee_bps: u16,
    pub size: u64,
}

#[event]
pub struct CrossCleared {
    pub market: Pubkey,
    pub day: i64,
    pub kind: u8,
    pub crowded: u8,
    pub fee_bps: u16,
    pub price_wad: u128,
    pub buy_in: u64,
    pub buy_spent: u64,
    pub buy_tokens: u64,
    pub sell_in: u64,
    pub sell_spent: u64,
    pub sell_quote: u64,
}

#[event]
pub struct OrderSettled {
    pub cross: Pubkey,
    pub order: Pubkey,
    pub owner: Pubkey,
    pub quote: u64,
    pub raw: u64,
}

#[event]
pub struct OfferSettled {
    pub cross: Pubkey,
    pub offer: Pubkey,
    pub maker: Pubkey,
    pub quote: u64,
    pub raw: u64,
}

#[event]
pub struct CrossClosed {
    pub cross: Pubkey,
    pub raw_dust: u64,
    pub quote_dust: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rates() {
        assert_eq!(rate_wad(100_170_000, -8), Some(1_001_700_000_000_000_000));
        assert_eq!(rate_wad(1, 0), Some(WAD));
        assert_eq!(rate_wad(0, -8), None);
        assert_eq!(rate_wad(-1, -8), None);
    }
}
