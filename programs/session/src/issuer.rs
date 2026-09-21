//! What the issuer of the underlying can do to this vault, read from the mint.
//!
//! Every real xStock and PreStock is a Token-2022 mint with extensions, and
//! four of them are powers over the vault's inventory that no program can
//! override:
//!
//! | extension           | what it means for a vault holding the token       |
//! |---------------------|---------------------------------------------------|
//! | `TransferHook`      | once a hook program is set, every transfer needs  |
//! |                     | accounts this program does not pass — the CPI     |
//! |                     | would simply fail                                 |
//! | `PausableConfig`    | the issuer can stop all transfers; settlement's   |
//! |                     | handoff cannot be filled                          |
//! | freeze authority    | the vault's own token account can be frozen       |
//! | `PermanentDelegate` | the issuer can move the inventory out at any time |
//!
//! A fifth, `TransferFeeConfig`, is not a power to detect but a number to
//! account for: a transfer into the vault arrives short by the fee, and a
//! vault that credited the sent amount would be insolvent by that much on
//! every fill.
//!
//! The rule elsewhere in this program is *halt, don't guess*. Applied here it
//! means: read these before touching inventory, and when the issuer has acted,
//! stop with a named reason rather than let a CPI fail in the dark or keep
//! marking a frozen account as solvent.
//!
//! The pinned `spl-token-2022` predates two of these extensions, so the TLV
//! is walked here directly. Type ids are stable; layouts are pinned by tests
//! against the real NVDAx and OPENAI mints.

use anchor_lang::prelude::Pubkey;

/// Classic SPL Token. A mint owned by it has no extensions at all.
pub const SPL_TOKEN: Pubkey = anchor_lang::solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022: Pubkey = anchor_lang::solana_program::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// `ExtensionType` discriminants, as Token-2022 defines them.
pub const EXT_TRANSFER_FEE_CONFIG: u16 = 1;
pub const EXT_NON_TRANSFERABLE: u16 = 9;
pub const EXT_DEFAULT_ACCOUNT_STATE: u16 = 6;
pub const EXT_PERMANENT_DELEGATE: u16 = 12;
pub const EXT_TRANSFER_HOOK: u16 = 14;
pub const EXT_SCALED_UI_AMOUNT: u16 = 25;
pub const EXT_PAUSABLE: u16 = 26;

/// A Token-2022 mint is the 82-byte base, padded to the 165-byte account
/// length, then one account-type byte, then TLV entries.
const MINT_BASE_LEN: usize = 82;
const ACCOUNT_LEN: usize = 165;
const TLV_START: usize = ACCOUNT_LEN + 1;
const ACCOUNT_TYPE_MINT: u8 = 1;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum IssuerError {
    /// Not a mint this program can read.
    NotAMint,
    /// TLV entry runs past the end of the account.
    Malformed,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct IssuerState {
    pub token_2022: bool,
    /// A hook program is set. Every transfer of this mint now needs the
    /// hook's extra accounts, which this program does not pass.
    pub hook_program: Option<Pubkey>,
    /// The extension exists (the issuer *can* pause), and whether it has.
    pub pausable: bool,
    pub paused: bool,
    /// The fee in force this epoch, in basis points, and its cap in atoms.
    /// Zero when there is no fee extension.
    pub transfer_fee_bps: u16,
    pub transfer_fee_max: u64,
    pub permanent_delegate: Option<Pubkey>,
    /// A UI multiplier is configured: balances a person reads differ from
    /// atoms. Accounting stays in atoms; only display changes.
    pub scaled_ui: bool,
    /// New token accounts start frozen.
    pub default_frozen: bool,

    // ── what a token account for this mint needs ─────────────────────────
    //
    // Three mint extensions oblige every token account of that mint to carry
    // a matching one, which makes the account longer. Tracked separately from
    // the fields above because the *presence* of the extension is what
    // matters, not its value: a transfer fee of zero still lengthens the
    // account, and a hook slot with no program set still does.
    pub has_transfer_fee_config: bool,
    pub non_transferable: bool,
    /// The transfer-hook extension exists, whether or not a program is set.
    pub hook_slot: bool,
}

fn key_at(d: &[u8], at: usize) -> Option<Pubkey> {
    let b: [u8; 32] = d.get(at..at + 32)?.try_into().ok()?;
    if b == [0u8; 32] { None } else { Some(Pubkey::new_from_array(b)) }
}
fn u16_at(d: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(d.get(at..at + 2)?.try_into().ok()?))
}
fn u64_at(d: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_le_bytes(d.get(at..at + 8)?.try_into().ok()?))
}

/// Read the issuer's powers off a mint account's bytes.
///
/// `epoch` selects which of the two transfer-fee schedules is in force, the
/// same way the token program does.
pub fn inspect_mint(data: &[u8], owner: &Pubkey, epoch: u64) -> Result<IssuerState, IssuerError> {
    if data.len() < MINT_BASE_LEN {
        return Err(IssuerError::NotAMint);
    }
    if *owner == SPL_TOKEN {
        return Ok(IssuerState::default());
    }
    if *owner != TOKEN_2022 {
        return Err(IssuerError::NotAMint);
    }
    let mut s = IssuerState { token_2022: true, ..IssuerState::default() };
    // A 2022 mint with no extensions is just the base.
    if data.len() <= TLV_START {
        return Ok(s);
    }
    if data[ACCOUNT_LEN] != ACCOUNT_TYPE_MINT {
        return Err(IssuerError::NotAMint);
    }

    let mut at = TLV_START;
    while at + 4 <= data.len() {
        let ty = u16_at(data, at).ok_or(IssuerError::Malformed)?;
        let len = u16_at(data, at + 2).ok_or(IssuerError::Malformed)? as usize;
        if ty == 0 && len == 0 {
            break; // uninitialised tail
        }
        let body = at + 4;
        let end = body.checked_add(len).ok_or(IssuerError::Malformed)?;
        let d = data.get(body..end).ok_or(IssuerError::Malformed)?;

        match ty {
            EXT_TRANSFER_HOOK => {
                // authority: 32, program_id: 32
                s.hook_slot = true;
                s.hook_program = key_at(d, 32);
            }
            EXT_PAUSABLE => {
                // authority: 32, paused: 1
                s.pausable = true;
                s.paused = d.get(32).copied().unwrap_or(0) != 0;
            }
            EXT_TRANSFER_FEE_CONFIG => {
                s.has_transfer_fee_config = true;
                // config_authority: 32, withdraw_withheld_authority: 32,
                // withheld_amount: 8, older { epoch 8, max 8, bps 2 },
                // newer { epoch 8, max 8, bps 2 }
                let older = 72;
                let newer = 90;
                let newer_epoch = u64_at(d, newer).ok_or(IssuerError::Malformed)?;
                let pick = if epoch >= newer_epoch { newer } else { older };
                s.transfer_fee_max = u64_at(d, pick + 8).ok_or(IssuerError::Malformed)?;
                s.transfer_fee_bps = u16_at(d, pick + 16).ok_or(IssuerError::Malformed)?;
            }
            EXT_PERMANENT_DELEGATE => {
                s.permanent_delegate = key_at(d, 0);
            }
            EXT_SCALED_UI_AMOUNT => {
                s.scaled_ui = true;
            }
            EXT_NON_TRANSFERABLE => {
                s.non_transferable = true;
            }
            EXT_DEFAULT_ACCOUNT_STATE => {
                // AccountState: 0 uninitialised, 1 initialised, 2 frozen
                s.default_frozen = d.first().copied() == Some(2);
            }
            _ => {}
        }
        at = end;
    }
    Ok(s)
}

/// The fee Token-2022 takes off a transfer of `amount`: `ceil(amount × bps /
/// 10_000)`, capped. Mirrors `TransferFee::calculate_fee`.
pub fn transfer_fee(s: &IssuerState, amount: u64) -> u64 {
    if s.transfer_fee_bps == 0 || amount == 0 {
        return 0;
    }
    let raw = (amount as u128 * s.transfer_fee_bps as u128).div_ceil(10_000) as u64;
    raw.min(s.transfer_fee_max)
}

/// How long a token account for this mint must be.
///
/// This exists because Anchor cannot work it out. Its `init` asks
/// `StateWithExtensions::get_extension_types()`, which calls
/// `ExtensionType::try_from` on every entry it finds and returns
/// `InvalidAccountData` for one the pinned `spl-token-2022` has never heard
/// of. Both NVDAx and OPENAI carry two such extensions, so Anchor cannot size
/// — and therefore cannot create — a vault's token account for either. The
/// asset the protocol exists for was uncreatable, one layer below the
/// token-program check.
///
/// The mapping is small and comes from `get_required_init_account_extensions`:
/// only three mint extensions oblige an account extension, and all three are
/// old enough to be known. An unrecognised extension is skipped here, and if
/// a future one ever does oblige an account extension the length will be
/// short and `InitializeAccount3` will refuse — loudly, at vault creation,
/// which is the right place to find out.
pub fn required_account_len(s: &IssuerState) -> Result<usize, IssuerError> {
    use anchor_spl::token_2022::spl_token_2022::{
        extension::ExtensionType, state::Account,
    };
    if !s.token_2022 {
        return Ok(165);
    }
    let mut ext = Vec::new();
    if s.has_transfer_fee_config {
        ext.push(ExtensionType::TransferFeeAmount);
    }
    if s.non_transferable {
        ext.push(ExtensionType::NonTransferableAccount);
        ext.push(ExtensionType::ImmutableOwner);
    }
    if s.hook_slot {
        ext.push(ExtensionType::TransferHookAccount);
    }
    ExtensionType::try_calculate_account_len::<Account>(&ext).map_err(|_| IssuerError::Malformed)
}

/// Why the vault must stop. The number is the `detail` in the halt event.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Condition {
    HookSet = 1,
    Paused = 2,
    VaultFrozen = 3,
    /// The vault's token account holds less than the books say it owns.
    /// Nothing but a permanent delegate can do that.
    Seized = 4,
}

/// The first condition that holds, if any. `frozen` and `balance` describe
/// the vault's own token account for the underlying.
pub fn condition(s: &IssuerState, frozen: bool, balance: u64, owned: u64) -> Option<Condition> {
    if s.hook_program.is_some() {
        Some(Condition::HookSet)
    } else if s.paused {
        Some(Condition::Paused)
    } else if frozen {
        Some(Condition::VaultFrozen)
    } else if balance < owned {
        Some(Condition::Seized)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::pubkey::Pubkey;

    fn fixture(name: &str) -> (Vec<u8>, Pubkey) {
        let doc: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string("../../tests/vectors/issuer-mints.json").unwrap(),
        )
        .unwrap();
        let m = &doc[name];
        let bytes = base64_decode(m["base64"].as_str().unwrap());
        let owner: Pubkey = m["owner"].as_str().unwrap().parse().unwrap();
        assert_eq!(bytes.len(), m["len"].as_u64().unwrap() as usize);
        (bytes, owner)
    }

    // Enough of base64 for a test fixture; no dependency for it.
    pub(super) fn base64_decode(s: &str) -> Vec<u8> {
        const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = Vec::new();
        let mut buf = 0u32;
        let mut bits = 0;
        for c in s.bytes() {
            if c == b'=' { break; }
            let v = T.iter().position(|&t| t == c).unwrap() as u32;
            buf = (buf << 6) | v;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((buf >> bits) as u8);
                buf &= (1 << bits) - 1;
            }
        }
        out
    }

    /// The real NVDAx mint: a permanent delegate, a pause switch (off), a
    /// hook slot (unset), a UI multiplier, no transfer fee.
    #[test]
    fn reads_nvdax() {
        let (d, owner) = fixture("nvdax");
        let s = inspect_mint(&d, &owner, 800).unwrap();
        assert!(s.token_2022);
        assert_eq!(s.hook_program, None, "NVDAx has a hook slot but no program — the day that changes, this fails");
        assert!(s.pausable && !s.paused);
        assert!(s.permanent_delegate.is_some());
        assert!(s.scaled_ui);
        assert_eq!(s.transfer_fee_bps, 0);
        assert!(!s.default_frozen);
        assert_eq!(condition(&s, false, 100, 100), None);
    }

    /// The real OPENAI PreStock: everything NVDAx has, plus a transfer fee
    /// with no cap — 50 bp until epoch 1039, 100 bp from it. The issuer
    /// changed it the week this was written, which is the point of reading
    /// the schedule rather than a number.
    #[test]
    fn reads_openai_including_the_fee() {
        let (d, owner) = fixture("openai");
        assert_eq!(inspect_mint(&d, &owner, 1038).unwrap().transfer_fee_bps, 50);
        let s = inspect_mint(&d, &owner, 1039).unwrap();
        assert_eq!(s.transfer_fee_bps, 100);
        assert_eq!(s.transfer_fee_max, u64::MAX);
        assert!(s.pausable && !s.paused && s.scaled_ui && s.permanent_delegate.is_some());
        assert_eq!(s.hook_program, None);
        // 1% of a fill, rounded up, exactly as the token program takes it
        assert_eq!(transfer_fee(&s, 1_000_000_000), 10_000_000);
        assert_eq!(transfer_fee(&s, 1), 1);
        assert_eq!(transfer_fee(&s, 0), 0);
        assert_eq!(transfer_fee(&s, 12_345), 124);
    }

    #[test]
    fn a_classic_mint_has_no_powers() {
        let (d, owner) = fixture("usdc");
        let s = inspect_mint(&d, &owner, 800).unwrap();
        assert_eq!(s, IssuerState::default());
        assert_eq!(transfer_fee(&s, 1_000_000), 0);
    }

    #[test]
    fn the_fee_cap_applies() {
        let s = IssuerState { transfer_fee_bps: 100, transfer_fee_max: 5, ..IssuerState::default() };
        assert_eq!(transfer_fee(&s, 1_000_000), 5);
    }

    /// Synthetic TLV: a hook program set, and the mint paused.
    #[test]
    fn detects_a_hook_and_a_pause() {
        let mut d = vec![0u8; TLV_START];
        d[ACCOUNT_LEN] = ACCOUNT_TYPE_MINT;
        // TransferHook: authority(32) + program(32)
        d.extend_from_slice(&EXT_TRANSFER_HOOK.to_le_bytes());
        d.extend_from_slice(&64u16.to_le_bytes());
        d.extend_from_slice(&[0u8; 32]);
        d.extend_from_slice(&[7u8; 32]);
        // Pausable: authority(32) + paused(1)
        d.extend_from_slice(&EXT_PAUSABLE.to_le_bytes());
        d.extend_from_slice(&33u16.to_le_bytes());
        d.extend_from_slice(&[0u8; 32]);
        d.push(1);
        let s = inspect_mint(&d, &TOKEN_2022, 0).unwrap();
        assert_eq!(s.hook_program, Some(Pubkey::new_from_array([7u8; 32])));
        assert!(s.paused);
        assert_eq!(condition(&s, false, 0, 0), Some(Condition::HookSet));
        let unhooked = IssuerState { hook_program: None, ..s };
        assert_eq!(condition(&unhooked, false, 0, 0), Some(Condition::Paused));
    }

    #[test]
    fn a_frozen_or_emptied_vault_account_is_a_condition() {
        let s = IssuerState::default();
        assert_eq!(condition(&s, true, 100, 100), Some(Condition::VaultFrozen));
        assert_eq!(condition(&s, false, 99, 100), Some(Condition::Seized));
        assert_eq!(condition(&s, false, 100, 100), None);
        // surplus is not a seizure
        assert_eq!(condition(&s, false, 101, 100), None);
    }

    #[test]
    fn the_older_fee_schedule_applies_before_the_newer_epoch() {
        let mut d = vec![0u8; TLV_START];
        d[ACCOUNT_LEN] = ACCOUNT_TYPE_MINT;
        d.extend_from_slice(&EXT_TRANSFER_FEE_CONFIG.to_le_bytes());
        d.extend_from_slice(&108u16.to_le_bytes());
        d.extend_from_slice(&[0u8; 72]);                 // authorities + withheld
        d.extend_from_slice(&10u64.to_le_bytes());       // older.epoch
        d.extend_from_slice(&u64::MAX.to_le_bytes());    // older.max
        d.extend_from_slice(&50u16.to_le_bytes());       // older.bps
        d.extend_from_slice(&20u64.to_le_bytes());       // newer.epoch
        d.extend_from_slice(&u64::MAX.to_le_bytes());    // newer.max
        d.extend_from_slice(&100u16.to_le_bytes());      // newer.bps
        assert_eq!(inspect_mint(&d, &TOKEN_2022, 15).unwrap().transfer_fee_bps, 50);
        assert_eq!(inspect_mint(&d, &TOKEN_2022, 20).unwrap().transfer_fee_bps, 100);
    }

    #[test]
    fn truncated_tlv_is_refused_not_misread() {
        let mut d = vec![0u8; TLV_START];
        d[ACCOUNT_LEN] = ACCOUNT_TYPE_MINT;
        d.extend_from_slice(&EXT_TRANSFER_HOOK.to_le_bytes());
        d.extend_from_slice(&64u16.to_le_bytes());
        d.extend_from_slice(&[1u8; 10]); // claims 64, has 10
        assert_eq!(inspect_mint(&d, &TOKEN_2022, 0), Err(IssuerError::Malformed));
        assert_eq!(inspect_mint(&[0u8; 10], &TOKEN_2022, 0), Err(IssuerError::NotAMint));
        assert_eq!(inspect_mint(&[0u8; 82], &Pubkey::new_unique(), 0), Err(IssuerError::NotAMint));
    }
}

#[cfg(test)]
mod anchor_can_read_the_real_thing {
    use super::*;
    use anchor_spl::token_2022::spl_token_2022::{
        extension::StateWithExtensions, state::Mint,
    };

    fn fixture(name: &str) -> (Vec<u8>, Pubkey) {
        let doc: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string("../../tests/vectors/issuer-mints.json").unwrap(),
        )
        .unwrap();
        let m = &doc[name];
        (super::tests::base64_decode(m["base64"].as_str().unwrap()),
         m["owner"].as_str().unwrap().parse().unwrap())
    }

    /// Account validation for `InterfaceAccount<'info, Mint>` unpacks through
    /// `StateWithExtensions`, so whether the real assets can be *held at all*
    /// is decided here, before a line of any handler runs.
    ///
    /// The pinned `spl-token-2022` (6.0.0, via anchor-spl 0.31) knows
    /// extensions only up to `ConfidentialMintBurn`; NVDAx and OPENAI both
    /// carry `ScaledUiAmountConfig` (25) and `PausableConfig` (26), which it
    /// has never heard of. It reads them anyway — unknown TLV entries are
    /// skipped rather than refused — and this test exists to catch the day
    /// that stops being true, because the failure mode would be a vault that
    /// cannot deserialise the asset it exists for.
    #[test]
    fn the_real_mints_deserialise_despite_extensions_the_crate_predates() {
        for name in ["nvdax", "openai"] {
            let (data, _) = fixture(name);
            let m = StateWithExtensions::<Mint>::unpack(&data)
                .unwrap_or_else(|e| panic!("{name} no longer deserialises: {e:?}"));
            assert!(m.base.is_initialized, "{name}");
        }
    }

    /// Decimals are what the vault stores off the mint, and reading them from
    /// the wrong offset silently misprices every boundary by a power of ten.
    #[test]
    fn decimals_agree_between_the_two_parsers() {
        for (name, expect) in [("nvdax", 8u8), ("openai", 9), ("usdc", 6)] {
            let (data, owner) = fixture(name);
            let anchor = StateWithExtensions::<Mint>::unpack(&data).unwrap().base.decimals;
            assert_eq!(anchor, expect, "{name} via spl-token-2022");
            // this program's own parser reads the same byte
            let _ = inspect_mint(&data, &owner, 1_039).unwrap();
            assert_eq!(data[44], expect, "{name} at the base offset");
        }
    }

    #[test]
    fn a_classic_mint_still_unpacks() {
        let (data, _) = fixture("usdc");
        assert!(StateWithExtensions::<Mint>::unpack(&data).is_ok());
    }

    /// The one that actually bites.
    ///
    /// `unpack` succeeds because it does not enumerate the extensions.
    /// `get_extension_types` does, calling `ExtensionType::try_from` on every
    /// TLV entry, and an entry the pinned crate has never heard of is
    /// `InvalidAccountData` rather than an entry to skip.
    ///
    /// Anchor calls exactly that when it sizes a token account under `init`:
    /// mint extensions → required account extensions → length. So
    /// `initialize_vault` cannot create a vault's token account for any mint
    /// carrying `ScaledUiAmountConfig` or `PausableConfig` — which is to say,
    /// for a real xStock. This is the audit's "the program cannot hold the
    /// asset" one layer deeper than the token-program check that was fixed
    /// first, and it is the reason `underlying_vault` is created by hand.
    #[test]
    fn enumerating_a_real_xstocks_extensions_is_what_fails() {
        use anchor_spl::token_2022::spl_token_2022::extension::BaseStateWithExtensions;
        for name in ["nvdax", "openai"] {
            let (data, _) = fixture(name);
            let m = StateWithExtensions::<Mint>::unpack(&data).unwrap();
            assert!(
                m.get_extension_types().is_err(),
                "{name}: get_extension_types now succeeds — the pinned \
                 spl-token-2022 has learned these extensions, and the manual \
                 token-account creation in lib.rs can go back to Anchor's init"
            );
        }
        // Classic and extension-light mints are unaffected, which is why this
        // went unnoticed: every devnet stand-in until now was one of those.
        let (usdc, _) = fixture("usdc");
        assert!(StateWithExtensions::<Mint>::unpack(&usdc).unwrap().get_extension_types().is_ok());
    }
}

#[cfg(test)]
mod account_sizing {
    use super::*;
    use anchor_spl::token_2022::spl_token_2022::{
        extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
        state::{Account, Mint},
    };

    fn fixture(name: &str) -> (Vec<u8>, Pubkey) {
        let doc: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string("../../tests/vectors/issuer-mints.json").unwrap(),
        )
        .unwrap();
        let m = &doc[name];
        (super::tests::base64_decode(m["base64"].as_str().unwrap()),
         m["owner"].as_str().unwrap().parse().unwrap())
    }

    /// The real assets, sized. NVDAx has a hook slot (no program) so its
    /// accounts carry `TransferHookAccount`; OPENAI has that and a transfer
    /// fee, so it carries `TransferFeeAmount` too. Neither is 165 bytes, and
    /// allocating 165 is what a naive implementation does.
    #[test]
    fn the_real_assets_need_more_than_a_bare_token_account() {
        let (nv, owner) = fixture("nvdax");
        let n = required_account_len(&inspect_mint(&nv, &owner, 1_039).unwrap()).unwrap();
        assert!(n > 165, "NVDAx accounts are {n} bytes");

        let (oa, oowner) = fixture("openai");
        let o = required_account_len(&inspect_mint(&oa, &oowner, 1_039).unwrap()).unwrap();
        assert!(o > n, "OPENAI adds a transfer fee on top: {o} vs {n}");

        let (us, uowner) = fixture("usdc");
        assert_eq!(required_account_len(&inspect_mint(&us, &uowner, 1_039).unwrap()).unwrap(), 165,
            "a classic mint is a bare token account");
    }

    /// And the number is the one the token program itself would compute.
    ///
    /// For a mint the pinned crate *can* enumerate, both paths must agree —
    /// that is the check that this hand-rolled mapping has not drifted from
    /// `get_required_init_account_extensions`.
    #[test]
    fn it_agrees_with_the_token_program_wherever_the_crate_can_still_enumerate() {
        // A synthetic mint with a transfer fee and a hook: both known, so the
        // library can be asked for a second opinion.
        let mut d = vec![0u8; 166];
        d[44] = 6;    // decimals
        d[45] = 1;    // is_initialized — unpack refuses the account without it
        d[165] = 1;   // AccountType::Mint
        d.extend_from_slice(&EXT_TRANSFER_FEE_CONFIG.to_le_bytes());
        d.extend_from_slice(&108u16.to_le_bytes());
        d.extend_from_slice(&[0u8; 108]);
        d.extend_from_slice(&EXT_TRANSFER_HOOK.to_le_bytes());
        d.extend_from_slice(&64u16.to_le_bytes());
        d.extend_from_slice(&[0u8; 64]);

        let mine = required_account_len(&inspect_mint(&d, &TOKEN_2022, 0).unwrap()).unwrap();

        let m = StateWithExtensions::<Mint>::unpack(&d).unwrap();
        let theirs = ExtensionType::try_calculate_account_len::<Account>(
            &ExtensionType::get_required_init_account_extensions(&m.get_extension_types().unwrap()),
        )
        .unwrap();
        assert_eq!(mine, theirs, "the hand-rolled mapping has drifted");
    }
}
