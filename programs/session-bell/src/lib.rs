//! SESSION BELL — the NYSE open and close as Pyth Pro prints, verified on
//! chain and kept.
//!
//! A tokenized share trades around the clock; the share behind it has two
//! prices a day that everyone agrees on, the open and the close. Anything that
//! settles "at the close" needs to know, on chain and after the fact, what
//! the close was. This program records it: for each listing and each trading
//! day, one `Print` for the open and one for the close, taken from a
//! Pyth-signed message and checked against a written rule (`rules.rs`).
//!
//! ## How a print gets in
//!
//! Anyone may post. A post carries a Pyth Pro message in its instruction data
//! at a fixed place, preceded in the same transaction by an Ed25519
//! instruction that checks the signature over that message's payload:
//!
//! ```text
//!   post_print data:  disc[8] | u32 len | message[len] | day i64 | kind u8 | ed25519_ix u16
//!                                        ^ byte 12
//! ```
//!
//! The handler parses the message and applies the rule first, so a candidate
//! that cannot win costs nothing to refuse. It then asks the configured
//! verifier — Pyth's Lazer program, or a copy of it holding a test signer —
//! to confirm the signature and that the signer is trusted and unexpired.
//! Last, it requires the `VerifiedMessage` that the verifier returns to equal
//! its own parse, byte for byte. The price stored is the price Pyth signed,
//! and this program's own parse is never trusted by itself.
//!
//! A later close or an earlier open replaces a stored print until the
//! deadline. After it, `finalize_print` freezes a posted print, and
//! `mark_missing` records that nobody posted one. Both are permissionless and
//! both are final.
//!
//! ## What a print is not
//!
//! It is Pyth's aggregate at the bell, not the exchange's official auction
//! price, and a print verified by anything other than Pyth's own program
//! carries `FLAG_SIMULATED` for as long as it exists.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{get_return_data, invoke},
    sysvar,
};

pub mod errors;
pub mod lazer;
pub mod rules;
pub mod state;

use errors::BellError;
use rules::Kind;
use state::*;

declare_id!("BeLLKXJwhSH6YXYQLc8xLd11GxJUvoaT1h9zCadymJv4");

/// Pyth's Lazer (Pyth Pro) program: one address on mainnet and devnet.
pub const PYTH_LAZER_ID: Pubkey = pubkey!("pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt");

/// `sha256("global:verify_message")[..8]`, pinned by a test below.
pub const VERIFY_MESSAGE_DISCRIMINATOR: [u8; 8] = [180, 193, 120, 55, 189, 135, 203, 83];

/// The verifier keeps its trusted signers at this PDA.
pub const VERIFIER_STORAGE_SEED: &[u8] = b"storage";

#[program]
pub mod session_bell {
    use super::*;

    /// Create the config. Once, and only by the program's upgrade authority:
    /// whoever holds the config chooses which signatures count.
    pub fn init_config(ctx: Context<InitConfig>, params: Params) -> Result<()> {
        require!(params.valid(), BellError::BadParams);
        check_verifier(&ctx.accounts.verifier, &ctx.accounts.verifier_storage)?;

        let c = &mut ctx.accounts.config;
        c.version = BELL_VERSION;
        c.bump = ctx.bumps.config;
        c.admin = ctx.accounts.admin.key();
        c.pending_admin = Pubkey::default();
        c.verifier = ctx.accounts.verifier.key();
        c.verifier_storage = ctx.accounts.verifier_storage.key();
        c.simulated = c.verifier != PYTH_LAZER_ID;
        c.params = params;
        c.listings = 0;
        emit!(ConfigInitialized { admin: c.admin, verifier: c.verifier, simulated: c.simulated, params });
        Ok(())
    }

    /// Change the rule's parameters. A print already open keeps the window
    /// and deadline it opened with.
    pub fn set_params(ctx: Context<Admin>, params: Params) -> Result<()> {
        require!(params.valid(), BellError::BadParams);
        ctx.accounts.config.params = params;
        emit!(ParamsSet { params });
        Ok(())
    }

    /// Point at a different verifier: Pyth's own program the day a Pyth Pro
    /// key exists. `simulated` follows the verifier and cannot be set.
    pub fn set_verifier(ctx: Context<SetVerifier>) -> Result<()> {
        check_verifier(&ctx.accounts.verifier, &ctx.accounts.verifier_storage)?;
        let c = &mut ctx.accounts.config;
        c.verifier = ctx.accounts.verifier.key();
        c.verifier_storage = ctx.accounts.verifier_storage.key();
        c.simulated = c.verifier != PYTH_LAZER_ID;
        emit!(VerifierSet { verifier: c.verifier, verifier_storage: c.verifier_storage, simulated: c.simulated });
        Ok(())
    }

    /// First half of a two-step handover. The default key cancels.
    pub fn transfer_admin(ctx: Context<Admin>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.config.pending_admin = new_admin;
        emit!(AdminTransferStarted { admin: ctx.accounts.config.admin, pending_admin: new_admin });
        Ok(())
    }

    /// Second half: the new admin signs, so a typo cannot orphan the config.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        let from = c.admin;
        c.admin = c.pending_admin;
        c.pending_admin = Pubkey::default();
        emit!(AdminTransferred { from, to: c.admin });
        Ok(())
    }

    /// Add a symbol and the Pyth Pro feeds that make up its bell. The equity
    /// feed is fixed from here on: changing it would change what every past
    /// print means.
    pub fn register_listing(
        ctx: Context<RegisterListing>,
        symbol: [u8; 16],
        equity_feed: u32,
        rr_feed: u32,
        token_feed: u32,
        index_feed: u32,
        mint: Pubkey,
    ) -> Result<()> {
        require!(valid_symbol(&symbol), BellError::BadSymbol);
        require!(valid_feeds(equity_feed, rr_feed, token_feed, index_feed), BellError::BadFeeds);

        let l = &mut ctx.accounts.listing;
        l.version = BELL_VERSION;
        l.bump = ctx.bumps.listing;
        l.active = true;
        l.symbol = symbol;
        l.equity_feed = equity_feed;
        l.rr_feed = rr_feed;
        l.token_feed = token_feed;
        l.index_feed = index_feed;
        l.mint = mint;
        l.prints = 0;
        l.missing = 0;
        l.created_at = Clock::get()?.unix_timestamp;
        l.active_since = l.created_at;
        ctx.accounts.config.listings = ctx.accounts.config.listings.saturating_add(1);
        emit!(ListingRegistered { listing: l.key(), symbol, equity_feed, rr_feed, token_feed, index_feed, mint });
        Ok(())
    }

    /// Stop or resume recording a listing. Existing prints are untouched;
    /// bells that pass while it is off belong to nobody.
    pub fn set_listing_active(ctx: Context<SetListingActive>, active: bool) -> Result<()> {
        let l = &mut ctx.accounts.listing;
        if active && !l.active {
            l.active_since = Clock::get()?.unix_timestamp;
        }
        l.active = active;
        emit!(ListingActiveSet { listing: l.key(), active });
        Ok(())
    }

    /// Post a Pyth Pro message as the open or close of `day`, or improve on
    /// the one stored. Permissionless.
    pub fn post_print(
        ctx: Context<PostPrint>,
        message: Vec<u8>,
        day: i64,
        kind: u8,
        ed25519_ix: u16,
    ) -> Result<()> {
        let kind = Kind::from_u8(kind).ok_or(BellError::BadKind)?;
        let bell = rules::bell_ts(day, kind).ok_or(BellError::NoBell)?;
        require!(bell >= ctx.accounts.listing.active_since, BellError::NotListedAtBell);
        let clock = Clock::get()?;
        let params = ctx.accounts.config.params;

        // A print is judged by the window it opened with, even if the
        // parameters have changed since.
        let fresh = ctx.accounts.print.version == 0;
        let (window, deadline) = if fresh {
            (rules::window(bell, kind, &params), rules::deadline(bell, kind, &params))
        } else {
            let p = &ctx.accounts.print;
            require!(p.version == BELL_VERSION, BellError::VersionMismatch);
            require!(p.status == STATUS_PROVISIONAL, BellError::PrintClosed);
            (rules::Window { start_us: p.window_start_us, end_us: p.window_end_us }, p.deadline)
        };
        require!(clock.unix_timestamp < deadline, BellError::PostingClosed);

        // The cheap refusals first: read the candidate and apply the rule.
        let msg = lazer::parse_message(&message).map_err(errors::bad_message)?;
        let payload = lazer::parse_payload(msg.payload).map_err(errors::bad_payload)?;
        let (equity_feed, rr_feed, token_feed, index_feed) = {
            let l = &ctx.accounts.listing;
            (l.equity_feed, l.rr_feed, l.token_feed, l.index_feed)
        };
        let feed = payload.feed(equity_feed).ok_or(BellError::FeedMissing)?;
        let equity = rules::accept(feed, payload.timestamp_us, window, &params).map_err(BellError::from)?;
        if !fresh {
            require!(
                rules::better(kind, ctx.accounts.print.equity.feed_ts_us, equity.feed_ts_us),
                BellError::NotBetter
            );
        }

        // Then the signature: the verifier checks it and the signer, and what
        // it says it verified must be exactly what was parsed above.
        verify_with_verifier(&ctx.accounts, &message, ed25519_ix)?;
        bind_to_verified(&ctx.accounts.config.verifier, &msg)?;

        let aux = |id: u32| match id {
            0 => Quote::absent(0),
            id => payload.feed(id).map(Quote::from_feed).unwrap_or(Quote::absent(id)),
        };
        let (rr, token, index) = (aux(rr_feed), aux(token_feed), aux(index_feed));
        let divergence = rules::divergence_bps(&equity, &rr, &token);

        let simulated = ctx.accounts.config.simulated;
        let verifier = ctx.accounts.config.verifier;
        let listing_key = ctx.accounts.listing.key();
        let print_key = ctx.accounts.print.key();
        let poster = ctx.accounts.poster.key();

        let p = &mut ctx.accounts.print;
        if fresh {
            p.version = BELL_VERSION;
            p.bump = ctx.bumps.print;
            p.status = STATUS_PROVISIONAL;
            p.kind = kind.as_u8();
            p.listing = listing_key;
            p.day = day;
            p.bell_ts = bell;
            p.window_start_us = window.start_us;
            p.window_end_us = window.end_us;
            p.deadline = deadline;
            p.method_version = params.method_version;
            p.finalized_at = 0;
        }
        p.posts = p.posts.saturating_add(1);
        p.channel = payload.channel;
        p.equity = equity;
        p.rr = rr;
        p.token = token;
        p.index = index;
        p.divergence_bps = divergence.unwrap_or(0);
        p.flags = if simulated { FLAG_SIMULATED } else { 0 }
            | match divergence {
                Some(d) if d.unsigned_abs() > params.max_divergence_bps as u64 => {
                    FLAG_DIVERGENCE_KNOWN | FLAG_DIVERGENT
                }
                Some(_) => FLAG_DIVERGENCE_KNOWN,
                None => 0,
            };
        p.message_ts_us = payload.timestamp_us;
        p.signer = Pubkey::new_from_array(msg.public_key);
        p.verifier = verifier;
        p.poster = poster;
        p.slot = clock.slot;
        p.posted_at = clock.unix_timestamp;

        if fresh {
            let l = &mut ctx.accounts.listing;
            l.prints = l.prints.saturating_add(1);
        }
        emit!(PrintPosted {
            print: print_key,
            listing: listing_key,
            day,
            kind: kind.as_u8(),
            price: equity.price,
            conf: equity.conf,
            expo: equity.expo,
            publishers: equity.publishers,
            feed_ts_us: equity.feed_ts_us,
            message_ts_us: payload.timestamp_us,
            replaced: !fresh,
            simulated,
            poster,
        });
        Ok(())
    }

    /// Freeze a posted print once its deadline has passed. Permissionless.
    pub fn finalize_print(ctx: Context<FinalizePrint>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let key = ctx.accounts.print.key();
        let p = &mut ctx.accounts.print;
        require!(p.version == BELL_VERSION, BellError::VersionMismatch);
        require!(p.status == STATUS_PROVISIONAL, BellError::PrintClosed);
        require!(now >= p.deadline, BellError::TooEarly);
        p.status = STATUS_FINAL;
        p.finalized_at = now;
        emit!(PrintFinalized {
            print: key,
            listing: p.listing,
            day: p.day,
            kind: p.kind,
            price: p.equity.price,
            expo: p.equity.expo,
            feed_ts_us: p.equity.feed_ts_us,
            posts: p.posts,
            simulated: p.flags & FLAG_SIMULATED != 0,
        });
        Ok(())
    }

    /// Record that a bell passed with no print. Permissionless, only after
    /// the deadline, and only where no print exists: the account's creation
    /// is the check, since `init` fails on an address already in use.
    pub fn mark_missing(ctx: Context<MarkMissing>, day: i64, kind: u8) -> Result<()> {
        let k = Kind::from_u8(kind).ok_or(BellError::BadKind)?;
        let bell = rules::bell_ts(day, k).ok_or(BellError::NoBell)?;
        require!(bell >= ctx.accounts.listing.active_since, BellError::NotListedAtBell);
        let params = ctx.accounts.config.params;
        let deadline = rules::deadline(bell, k, &params);
        let clock = Clock::get()?;
        require!(clock.unix_timestamp >= deadline, BellError::TooEarly);

        let window = rules::window(bell, k, &params);
        let simulated = ctx.accounts.config.simulated;
        let verifier = ctx.accounts.config.verifier;
        let caller = ctx.accounts.caller.key();
        let listing_key = ctx.accounts.listing.key();
        let print_key = ctx.accounts.print.key();
        let l = &mut ctx.accounts.listing;
        l.prints = l.prints.saturating_add(1);
        l.missing = l.missing.saturating_add(1);
        let (equity_feed, rr_feed, token_feed, index_feed) = (l.equity_feed, l.rr_feed, l.token_feed, l.index_feed);

        let p = &mut ctx.accounts.print;
        p.version = BELL_VERSION;
        p.bump = ctx.bumps.print;
        p.status = STATUS_MISSING;
        p.kind = k.as_u8();
        p.flags = if simulated { FLAG_SIMULATED } else { 0 };
        p.channel = 0;
        p.posts = 0;
        p.method_version = params.method_version;
        p.listing = listing_key;
        p.day = day;
        p.bell_ts = bell;
        p.window_start_us = window.start_us;
        p.window_end_us = window.end_us;
        p.deadline = deadline;
        p.equity = Quote::absent(equity_feed);
        p.rr = Quote::absent(rr_feed);
        p.token = Quote::absent(token_feed);
        p.index = Quote::absent(index_feed);
        p.divergence_bps = 0;
        p.message_ts_us = 0;
        p.signer = Pubkey::default();
        p.verifier = verifier;
        p.poster = caller;
        p.slot = clock.slot;
        p.posted_at = clock.unix_timestamp;
        p.finalized_at = clock.unix_timestamp;
        emit!(PrintMissing { print: print_key, listing: listing_key, day, kind: k.as_u8(), simulated });
        Ok(())
    }
}

/// The storage account must be the verifier's `["storage"]` PDA and already
/// belong to it, so the config never records a verifier with no signers.
fn check_verifier(verifier: &AccountInfo, storage: &AccountInfo) -> Result<()> {
    let (pda, _) = Pubkey::find_program_address(&[VERIFIER_STORAGE_SEED], verifier.key);
    require_keys_eq!(storage.key(), pda, BellError::WrongVerifierStorage);
    require_keys_eq!(*storage.owner, *verifier.key, BellError::WrongVerifierStorage);
    Ok(())
}

/// CPI into `verify_message(message_data, ed25519_instruction_index,
/// signature_index = 0)`. The verifier loads *this* instruction from the
/// instructions sysvar and requires `message` to sit in its data exactly
/// where the Ed25519 instruction's offsets say, which is byte 12.
fn verify_with_verifier(a: &PostPrint, message: &[u8], ed25519_ix: u16) -> Result<()> {
    let mut data = Vec::with_capacity(8 + 4 + message.len() + 3);
    data.extend_from_slice(&VERIFY_MESSAGE_DISCRIMINATOR);
    data.extend_from_slice(&(message.len() as u32).to_le_bytes());
    data.extend_from_slice(message);
    data.extend_from_slice(&ed25519_ix.to_le_bytes());
    data.push(0);
    let ix = Instruction {
        program_id: a.verifier.key(),
        accounts: vec![
            AccountMeta::new(a.poster.key(), true),
            AccountMeta::new_readonly(a.verifier_storage.key(), false),
            AccountMeta::new(a.verifier_treasury.key(), false),
            AccountMeta::new_readonly(a.system_program.key(), false),
            AccountMeta::new_readonly(a.instructions.key(), false),
        ],
        data,
    };
    invoke(
        &ix,
        &[
            a.poster.to_account_info(),
            a.verifier_storage.to_account_info(),
            a.verifier_treasury.to_account_info(),
            a.system_program.to_account_info(),
            a.instructions.to_account_info(),
            a.verifier.to_account_info(),
        ],
    )?;
    Ok(())
}

/// What the verifier returns: `VerifiedMessage { public_key, payload }`.
#[derive(AnchorDeserialize)]
struct Verified {
    public_key: Pubkey,
    payload: Vec<u8>,
}

/// Require the verifier's own account of what it verified to match the
/// message this program parsed.
fn bind_to_verified(verifier: &Pubkey, msg: &lazer::Message) -> Result<()> {
    let (from, data) = get_return_data().ok_or(BellError::NoVerification)?;
    require_keys_eq!(from, *verifier, BellError::NoVerification);
    let v = Verified::try_from_slice(&data).map_err(|_| BellError::NoVerification)?;
    require!(
        v.public_key.to_bytes() == msg.public_key && v.payload.as_slice() == msg.payload,
        BellError::VerificationMismatch
    );
    Ok(())
}

/* ── accounts ─────────────────────────────────────────────────────────────── */

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = BellConfig::SIZE, seeds = [BellConfig::SEED], bump)]
    pub config: Box<Account<'info, BellConfig>>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ BellError::NotUpgradeAuthority)]
    pub program: Program<'info, crate::program::SessionBell>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ BellError::NotUpgradeAuthority)]
    pub program_data: Box<Account<'info, ProgramData>>,
    /// CHECK: any executable program; its storage is checked in the handler.
    #[account(executable)]
    pub verifier: UncheckedAccount<'info>,
    /// CHECK: checked in the handler against the verifier's PDA and owner.
    pub verifier_storage: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Admin<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [BellConfig::SEED],
        bump = config.bump,
        has_one = admin @ BellError::Unauthorized,
        constraint = config.version == BELL_VERSION @ BellError::VersionMismatch,
    )]
    pub config: Box<Account<'info, BellConfig>>,
}

#[derive(Accounts)]
pub struct SetVerifier<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [BellConfig::SEED],
        bump = config.bump,
        has_one = admin @ BellError::Unauthorized,
        constraint = config.version == BELL_VERSION @ BellError::VersionMismatch,
    )]
    pub config: Box<Account<'info, BellConfig>>,
    /// CHECK: any executable program; its storage is checked in the handler.
    #[account(executable)]
    pub verifier: UncheckedAccount<'info>,
    /// CHECK: checked in the handler against the verifier's PDA and owner.
    pub verifier_storage: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(
        mut,
        seeds = [BellConfig::SEED],
        bump = config.bump,
        constraint = config.pending_admin != Pubkey::default()
            && config.pending_admin == new_admin.key() @ BellError::NotPendingAdmin,
    )]
    pub config: Box<Account<'info, BellConfig>>,
}

#[derive(Accounts)]
#[instruction(symbol: [u8; 16])]
pub struct RegisterListing<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [BellConfig::SEED],
        bump = config.bump,
        has_one = admin @ BellError::Unauthorized,
        constraint = config.version == BELL_VERSION @ BellError::VersionMismatch,
    )]
    pub config: Box<Account<'info, BellConfig>>,
    #[account(init, payer = admin, space = Listing::SIZE, seeds = [Listing::SEED, symbol.as_ref()], bump)]
    pub listing: Box<Account<'info, Listing>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetListingActive<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [BellConfig::SEED], bump = config.bump, has_one = admin @ BellError::Unauthorized)]
    pub config: Box<Account<'info, BellConfig>>,
    #[account(mut, seeds = [Listing::SEED, listing.symbol.as_ref()], bump = listing.bump)]
    pub listing: Box<Account<'info, Listing>>,
}

// `init_if_needed` on the print, and why it is safe here: the print is a PDA
// of (listing, day, kind), so there is one address per bell and nobody can
// occupy another; and a second post never resets it — an existing print is
// only ever replaced field by field, by a candidate `rules::better` prefers,
// and only while it is provisional.
#[derive(Accounts)]
#[instruction(message: Vec<u8>, day: i64, kind: u8)]
pub struct PostPrint<'info> {
    #[account(mut)]
    pub poster: Signer<'info>,
    #[account(
        seeds = [BellConfig::SEED],
        bump = config.bump,
        constraint = config.version == BELL_VERSION @ BellError::VersionMismatch,
    )]
    pub config: Box<Account<'info, BellConfig>>,
    #[account(
        mut,
        seeds = [Listing::SEED, listing.symbol.as_ref()],
        bump = listing.bump,
        constraint = listing.active @ BellError::ListingInactive,
    )]
    pub listing: Box<Account<'info, Listing>>,
    #[account(
        init_if_needed,
        payer = poster,
        space = Print::SIZE,
        seeds = [Print::SEED, listing.key().as_ref(), &day.to_le_bytes(), &[kind]],
        bump,
    )]
    pub print: Box<Account<'info, Print>>,
    /// CHECK: the program this instruction CPIs into; must be the configured one.
    #[account(address = config.verifier @ BellError::WrongVerifier)]
    pub verifier: UncheckedAccount<'info>,
    /// CHECK: the verifier's storage as recorded; the verifier re-derives it.
    #[account(address = config.verifier_storage @ BellError::WrongVerifier)]
    pub verifier_storage: UncheckedAccount<'info>,
    /// CHECK: receives the verifier's fee; the verifier checks it against its storage.
    #[account(mut)]
    pub verifier_treasury: UncheckedAccount<'info>,
    /// CHECK: address-checked.
    #[account(address = sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FinalizePrint<'info> {
    #[account(
        mut,
        seeds = [Print::SEED, print.listing.as_ref(), &print.day.to_le_bytes(), &[print.kind]],
        bump = print.bump,
    )]
    pub print: Box<Account<'info, Print>>,
}

#[derive(Accounts)]
#[instruction(day: i64, kind: u8)]
pub struct MarkMissing<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(
        seeds = [BellConfig::SEED],
        bump = config.bump,
        constraint = config.version == BELL_VERSION @ BellError::VersionMismatch,
    )]
    pub config: Box<Account<'info, BellConfig>>,
    #[account(
        mut,
        seeds = [Listing::SEED, listing.symbol.as_ref()],
        bump = listing.bump,
        constraint = listing.active @ BellError::ListingInactive,
    )]
    pub listing: Box<Account<'info, Listing>>,
    #[account(
        init,
        payer = caller,
        space = Print::SIZE,
        seeds = [Print::SEED, listing.key().as_ref(), &day.to_le_bytes(), &[kind]],
        bump,
    )]
    pub print: Box<Account<'info, Print>>,
    pub system_program: Program<'info, System>,
}

/* ── events ───────────────────────────────────────────────────────────────── */

#[event]
pub struct ConfigInitialized {
    pub admin: Pubkey,
    pub verifier: Pubkey,
    pub simulated: bool,
    pub params: Params,
}

#[event]
pub struct ParamsSet {
    pub params: Params,
}

#[event]
pub struct VerifierSet {
    pub verifier: Pubkey,
    pub verifier_storage: Pubkey,
    pub simulated: bool,
}

#[event]
pub struct AdminTransferStarted {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
}

#[event]
pub struct AdminTransferred {
    pub from: Pubkey,
    pub to: Pubkey,
}

#[event]
pub struct ListingRegistered {
    pub listing: Pubkey,
    pub symbol: [u8; 16],
    pub equity_feed: u32,
    pub rr_feed: u32,
    pub token_feed: u32,
    pub index_feed: u32,
    pub mint: Pubkey,
}

#[event]
pub struct ListingActiveSet {
    pub listing: Pubkey,
    pub active: bool,
}

#[event]
pub struct PrintPosted {
    pub print: Pubkey,
    pub listing: Pubkey,
    pub day: i64,
    pub kind: u8,
    pub price: i64,
    pub conf: i64,
    pub expo: i16,
    pub publishers: u16,
    pub feed_ts_us: u64,
    pub message_ts_us: u64,
    pub replaced: bool,
    pub simulated: bool,
    pub poster: Pubkey,
}

#[event]
pub struct PrintFinalized {
    pub print: Pubkey,
    pub listing: Pubkey,
    pub day: i64,
    pub kind: u8,
    pub price: i64,
    pub expo: i16,
    pub feed_ts_us: u64,
    pub posts: u16,
    pub simulated: bool,
}

#[event]
pub struct PrintMissing {
    pub print: Pubkey,
    pub listing: Pubkey,
    pub day: i64,
    pub kind: u8,
    pub simulated: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::hash::hash;
    use anchor_lang::{Discriminator, InstructionData};

    fn global(name: &str) -> [u8; 8] {
        hash(format!("global:{name}").as_bytes()).to_bytes()[..8].try_into().unwrap()
    }

    #[test]
    fn the_verifier_discriminator_is_pyths() {
        assert_eq!(VERIFY_MESSAGE_DISCRIMINATOR, global("verify_message"));
    }

    #[test]
    fn instruction_discriminators_follow_anchor() {
        assert_eq!(instruction::PostPrint::DISCRIMINATOR, global("post_print"));
        assert_eq!(instruction::FinalizePrint::DISCRIMINATOR, global("finalize_print"));
        assert_eq!(instruction::MarkMissing::DISCRIMINATOR, global("mark_missing"));
    }

    /// The message starts at byte 12 of `post_print`'s data: the Ed25519
    /// instruction a poster builds depends on it.
    #[test]
    fn the_message_sits_at_byte_12() {
        let message = vec![0xAB; 150];
        let data = instruction::PostPrint { message: message.clone(), day: 20_720, kind: 1, ed25519_ix: 0 }.data();
        assert_eq!(&data[..8], &global("post_print"));
        assert_eq!(u32::from_le_bytes(data[8..12].try_into().unwrap()), 150);
        assert_eq!(&data[12..162], &message[..]);
        assert_eq!(i64::from_le_bytes(data[162..170].try_into().unwrap()), 20_720);
        assert_eq!(data[170], 1);
        assert_eq!(u16::from_le_bytes(data[171..173].try_into().unwrap()), 0);
        assert_eq!(data.len(), 173);
    }

    #[test]
    fn the_pyth_program_id_is_the_published_one() {
        assert_eq!(PYTH_LAZER_ID.to_string(), "pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt");
        let (storage, _) = Pubkey::find_program_address(&[VERIFIER_STORAGE_SEED], &PYTH_LAZER_ID);
        assert_eq!(storage.to_string(), "3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL");
    }
}
