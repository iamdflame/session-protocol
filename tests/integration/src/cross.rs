//! The exchange harness: session-cross beside the bell, on the real NVDAx.
//!
//! The xStock is the real NVDAx mint, captured from mainnet
//! (`tests/vectors/issuer-mints.json`) and installed at its real address. Only
//! its mint and freeze authorities are swapped for a test key, so the test
//! can issue tokens. Every extension is the real one: the scaled-UI
//! multiplier, the pause switch, the permanent delegate, the hook slot and
//! the metadata. The quote is a classic 6-decimal mint standing in for USDC.
//! Prints come from the bell harness: messages from Pyth's encoder, verified
//! by Pyth's own program.

use super::*;
use base64::Engine;
use session_core::cross as math;

pub const CROSS: &str = "Crosf1CpgcEs6G6SiX2B7KMR4hxVcE2FGU2r53a3RK9K";
pub const CROSS_SO: &str = "../../target/deploy/session_cross.so";
pub const NVDAX: &str = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
pub const TOKEN_2022: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
pub const SPL_TOKEN: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
pub const ATA: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

pub const BUY: u8 = 0;
pub const SELL: u8 = 1;
pub const LEG_QUOTE: u8 = 1;
pub const LEG_RAW: u8 = 2;
pub const LEGS: u8 = 3;

pub const COLLECTING: u8 = 0;
pub const CONFIRMING: u8 = 1;
pub const AUCTION: u8 = 2;
pub const SETTLING: u8 = 3;
pub const CANCELLED: u8 = 4;

/// One whole NVDAx in raw atoms, and one USDC in quote atoms.
pub const NVDAX_1: u64 = 100_000_000;
pub const USDC_1: u64 = 1_000_000;

#[derive(Clone, Copy)]
pub struct MarketParams {
    pub freeze_secs: u32,
    pub auction_secs: u32,
    pub cancel_after_secs: u32,
    pub max_fee_bps: u16,
    pub min_order_quote: u64,
    pub min_order_raw: u64,
    pub max_side_quote: u64,
    pub max_side_raw: u64,
    pub rr_tolerance_bps: u16,
    pub multiplier_guard_secs: u32,
    pub accept_simulated: bool,
}

pub const PARAMS: MarketParams = MarketParams {
    freeze_secs: 120,
    auction_secs: 120,
    cancel_after_secs: 21_600,
    max_fee_bps: 100,
    min_order_quote: USDC_1,
    min_order_raw: NVDAX_1 / 100,
    max_side_quote: 1_000_000 * USDC_1,
    max_side_raw: 10_000 * NVDAX_1,
    rr_tolerance_bps: 1,
    multiplier_guard_secs: 900,
    accept_simulated: false,
};

impl MarketParams {
    pub fn bytes(&self) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&self.freeze_secs.to_le_bytes());
        v.extend_from_slice(&self.auction_secs.to_le_bytes());
        v.extend_from_slice(&self.cancel_after_secs.to_le_bytes());
        v.extend_from_slice(&self.max_fee_bps.to_le_bytes());
        v.extend_from_slice(&self.min_order_quote.to_le_bytes());
        v.extend_from_slice(&self.min_order_raw.to_le_bytes());
        v.extend_from_slice(&self.max_side_quote.to_le_bytes());
        v.extend_from_slice(&self.max_side_raw.to_le_bytes());
        v.extend_from_slice(&self.rr_tolerance_bps.to_le_bytes());
        v.extend_from_slice(&self.multiplier_guard_secs.to_le_bytes());
        v.push(self.accept_simulated as u8);
        v
    }
}

/// The real NVDAx mint's bytes, with its mint and freeze authorities (and
/// supply) replaced.
pub fn nvdax_bytes(authority: &Address) -> Vec<u8> {
    let doc: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string("../vectors/issuer-mints.json").unwrap()).unwrap();
    let mut d = base64::engine::general_purpose::STANDARD.decode(doc["nvdax"]["base64"].as_str().unwrap()).unwrap();
    // COption<Pubkey> mint authority, u64 supply, u8 decimals, bool init,
    // COption<Pubkey> freeze authority
    d[0..4].copy_from_slice(&1u32.to_le_bytes());
    d[4..36].copy_from_slice(authority.as_ref());
    d[36..44].copy_from_slice(&0u64.to_le_bytes());
    d[46..50].copy_from_slice(&1u32.to_le_bytes());
    d[50..82].copy_from_slice(authority.as_ref());
    d
}

/// Offset of a Token-2022 extension's body in mint bytes.
pub fn extension(d: &[u8], ty: u16) -> Option<usize> {
    let mut at = 166;
    while at + 4 <= d.len() {
        let t = u16::from_le_bytes([d[at], d[at + 1]]);
        let len = u16::from_le_bytes([d[at + 2], d[at + 3]]) as usize;
        if t == ty {
            return Some(at + 4);
        }
        if t == 0 && len == 0 {
            return None;
        }
        at += 4 + len;
    }
    None
}

pub fn ata(owner: &Address, mint: &Address, program: &Address) -> Address {
    pda(&[owner.as_ref(), program.as_ref(), mint.as_ref()], &addr(ATA))
}

pub struct CrossEnv {
    pub bell: Env,
    pub program: Address,
    pub config: Address,
    pub treasury: Keypair,
    pub issuer: Keypair,
    pub mint: Address,
    pub usdc: Address,
    pub market: Address,
    pub raw_escrow: Address,
    pub quote_escrow: Address,
}

impl CrossEnv {
    /// The bell with Pyth's verifier and NVDA listed against the real NVDAx
    /// mint; the exchange with its config and an NVDAx/USDC market. The clock
    /// stands an hour before the 24 September open.
    pub fn new() -> CrossEnv {
        CrossEnv::with(PARAMS)
    }

    pub fn with(params: MarketParams) -> CrossEnv {
        let mut bell = Env::bare();
        let lazer = bell.lazer;
        bell.init_config(lazer).unwrap();
        let mint = addr(NVDAX);
        ok(bell.register_mint("NVDA", [EQUITY, RR, TOKEN, INDEX], mint), "register NVDA");
        bell.listing = pda(&[b"listing", &symbol("NVDA")], &bell.bell);

        let program = addr(CROSS);
        bell.svm.add_program_from_file(program, CROSS_SO).expect("run `npm run build:program` first");
        bell.set_upgrade_authority_of(&program);

        let issuer = Keypair::new();
        bell.svm.airdrop(&issuer.pubkey(), 10_000_000_000).unwrap();
        let rent = |svm: &LiteSVM, n: usize| svm.minimum_balance_for_rent_exemption(n);
        let nvdax = nvdax_bytes(&issuer.pubkey());
        let lamports = rent(&bell.svm, nvdax.len());
        bell.svm
            .set_account(mint, solana_account::Account { lamports, data: nvdax, owner: addr(TOKEN_2022), executable: false, rent_epoch: 0 })
            .unwrap();
        // a classic mint: authority, supply 0, 6 decimals, initialised, no freeze authority
        let usdc = Keypair::new().pubkey();
        let mut d = vec![0u8; 82];
        d[0..4].copy_from_slice(&1u32.to_le_bytes());
        d[4..36].copy_from_slice(issuer.pubkey().as_ref());
        d[44] = 6;
        d[45] = 1;
        let lamports = rent(&bell.svm, 82);
        bell.svm
            .set_account(usdc, solana_account::Account { lamports, data: d, owner: addr(SPL_TOKEN), executable: false, rent_epoch: 0 })
            .unwrap();

        let config = pda(&[b"cross-config"], &program);
        let market = pda(&[b"market", mint.as_ref()], &program);
        let mut env = CrossEnv {
            bell,
            program,
            config,
            treasury: Keypair::new(),
            issuer,
            mint,
            usdc,
            market,
            raw_escrow: pda(&[b"raw-escrow", market.as_ref()], &program),
            quote_escrow: pda(&[b"quote-escrow", market.as_ref()], &program),
        };
        ok(env.init_config(), "cross config");
        ok(env.create_market(params), "create market");
        env
    }

    pub fn send_as(&mut self, who: &Keypair, ixs: &[Instruction]) -> Res {
        self.bell.send(ixs, who)
    }

    fn ix(&self, name: &str, accounts: Vec<AccountMeta>, args: &[u8]) -> Instruction {
        let mut data = disc("global", name).to_vec();
        data.extend_from_slice(args);
        Instruction { program_id: self.program, accounts, data }
    }

    pub fn init_config(&mut self) -> Res {
        let admin = self.bell.admin.insecure_clone();
        let ix = self.ix(
            "init_config",
            vec![
                AccountMeta::new(admin.pubkey(), true),
                AccountMeta::new(self.config, false),
                AccountMeta::new_readonly(self.program, false),
                AccountMeta::new_readonly(pda(&[self.program.as_ref()], &bpf_loader_upgradeable::ID), false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            self.treasury.pubkey().as_ref(),
        );
        self.send_as(&admin, &[ix])
    }

    pub fn create_market(&mut self, p: MarketParams) -> Res {
        let admin = self.bell.admin.insecure_clone();
        let ix = self.ix(
            "create_market",
            vec![
                AccountMeta::new(admin.pubkey(), true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new(self.market, false),
                AccountMeta::new_readonly(self.bell.listing, false),
                AccountMeta::new_readonly(self.mint, false),
                AccountMeta::new_readonly(self.usdc, false),
                AccountMeta::new_readonly(addr(TOKEN_2022), false),
                AccountMeta::new_readonly(addr(SPL_TOKEN), false),
                AccountMeta::new(self.raw_escrow, false),
                AccountMeta::new(self.quote_escrow, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            &p.bytes(),
        );
        self.send_as(&admin, &[ix])
    }

    /// A funded participant with both token accounts: `nvdax` raw atoms and
    /// `usdc` quote atoms.
    pub fn trader(&mut self, nvdax: u64, usdc: u64) -> Keypair {
        let k = Keypair::new();
        self.bell.svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        for (mint, program, amount) in [(self.mint, addr(TOKEN_2022), nvdax), (self.usdc, addr(SPL_TOKEN), usdc)] {
            let account = ata(&k.pubkey(), &mint, &program);
            let create = Instruction {
                program_id: addr(ATA),
                accounts: vec![
                    AccountMeta::new(k.pubkey(), true),
                    AccountMeta::new(account, false),
                    AccountMeta::new_readonly(k.pubkey(), false),
                    AccountMeta::new_readonly(mint, false),
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(program, false),
                ],
                data: vec![1],
            };
            ok(self.send_as(&k, &[create]), "create ata");
            if amount > 0 {
                let mut data = vec![7u8];
                data.extend_from_slice(&amount.to_le_bytes());
                let mint_to = Instruction {
                    program_id: program,
                    accounts: vec![
                        AccountMeta::new(mint, false),
                        AccountMeta::new(account, false),
                        AccountMeta::new_readonly(self.issuer.pubkey(), true),
                    ],
                    data,
                };
                let issuer = self.issuer.insecure_clone();
                ok(self.send_as(&issuer, &[mint_to]), "mint to");
            }
        }
        k
    }

    pub fn raw_ata(&self, owner: &Address) -> Address {
        ata(owner, &self.mint, &addr(TOKEN_2022))
    }

    pub fn quote_ata(&self, owner: &Address) -> Address {
        ata(owner, &self.usdc, &addr(SPL_TOKEN))
    }

    /// A token account's balance, or 0 if it does not exist.
    pub fn balance(&self, account: &Address) -> u64 {
        match self.bell.svm.get_account(account) {
            Some(a) if a.data.len() >= 72 => u64::from_le_bytes(a.data[64..72].try_into().unwrap()),
            _ => 0,
        }
    }

    pub fn cross_addr(&self, day: i64, kind: u8) -> Address {
        pda(&[b"cross", self.market.as_ref(), &day.to_le_bytes(), &[kind]], &self.program)
    }

    pub fn order_addr(&self, cross: &Address, owner: &Address, nonce: u16) -> Address {
        pda(&[b"order", cross.as_ref(), owner.as_ref(), &nonce.to_le_bytes()], &self.program)
    }

    pub fn offer_addr(&self, cross: &Address, maker: &Address, nonce: u16) -> Address {
        pda(&[b"offer", cross.as_ref(), maker.as_ref(), &nonce.to_le_bytes()], &self.program)
    }

    fn side_accounts(&self, side: u8) -> (Address, Address, Address) {
        if side == BUY {
            (self.usdc, self.quote_escrow, addr(SPL_TOKEN))
        } else {
            (self.mint, self.raw_escrow, addr(TOKEN_2022))
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn place(&mut self, who: &Keypair, day: i64, kind: u8, nonce: u16, side: u8, amount: u64, limit_e8: u64) -> Res {
        let cross = self.cross_addr(day, kind);
        let (mint, escrow, program) = self.side_accounts(side);
        let source = ata(&who.pubkey(), &mint, &program);
        let mut args = Vec::new();
        args.extend_from_slice(&day.to_le_bytes());
        args.push(kind);
        args.extend_from_slice(&nonce.to_le_bytes());
        args.push(side);
        args.extend_from_slice(&amount.to_le_bytes());
        args.extend_from_slice(&limit_e8.to_le_bytes());
        let ix = self.ix(
            "place_order",
            vec![
                AccountMeta::new(who.pubkey(), true),
                AccountMeta::new(self.market, false),
                AccountMeta::new(cross, false),
                AccountMeta::new(self.order_addr(&cross, &who.pubkey(), nonce), false),
                AccountMeta::new_readonly(self.mint, false),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new(source, false),
                AccountMeta::new(escrow, false),
                AccountMeta::new_readonly(program, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            &args,
        );
        let who = who.insecure_clone();
        self.send_as(&who, &[ix])
    }

    pub fn cancel(&mut self, who: &Keypair, day: i64, kind: u8, nonce: u16, side: u8) -> Res {
        let cross = self.cross_addr(day, kind);
        let (mint, escrow, program) = self.side_accounts(side);
        let ix = self.ix(
            "cancel_order",
            vec![
                AccountMeta::new(who.pubkey(), true),
                AccountMeta::new_readonly(self.market, false),
                AccountMeta::new(cross, false),
                AccountMeta::new(self.order_addr(&cross, &who.pubkey(), nonce), false),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new(ata(&who.pubkey(), &mint, &program), false),
                AccountMeta::new(escrow, false),
                AccountMeta::new_readonly(program, false),
            ],
            &[],
        );
        let who = who.insecure_clone();
        self.send_as(&who, &[ix])
    }

    fn cranker(&self) -> Keypair {
        self.bell.poster.insecure_clone()
    }

    pub fn price(&mut self, day: i64, kind: u8) -> Res {
        let cross = self.cross_addr(day, kind);
        let print = pda(&[b"print", self.bell.listing.as_ref(), &day.to_le_bytes(), &[kind]], &self.bell.bell);
        let ix = self.ix(
            "price_cross",
            vec![
                AccountMeta::new(cross, false),
                AccountMeta::new_readonly(self.market, false),
                AccountMeta::new_readonly(print, false),
                AccountMeta::new_readonly(self.mint, false),
            ],
            &[],
        );
        let c = self.cranker();
        self.send_as(&c, &[ix])
    }

    pub fn cancel_cross(&mut self, day: i64, kind: u8) -> Res {
        let cross = self.cross_addr(day, kind);
        let ix = self.ix("cancel_cross", vec![AccountMeta::new(cross, false), AccountMeta::new_readonly(self.market, false)], &[]);
        let c = self.cranker();
        self.send_as(&c, &[ix])
    }

    pub fn confirm(&mut self, day: i64, kind: u8, orders: &[Address]) -> Res {
        let cross = self.cross_addr(day, kind);
        let mut accounts = vec![AccountMeta::new(cross, false), AccountMeta::new_readonly(self.market, false)];
        accounts.extend(orders.iter().map(|o| AccountMeta::new(*o, false)));
        let ix = self.ix("confirm_orders", accounts, &[]);
        let c = self.cranker();
        self.send_as(&c, &[ix])
    }

    /// `side` is what the maker escrows: SELL for raw tokens, BUY for quote.
    #[allow(clippy::too_many_arguments)]
    pub fn offer(&mut self, maker: &Keypair, day: i64, kind: u8, nonce: u16, side: u8, size: u64, fee_bps: u16) -> Res {
        let cross = self.cross_addr(day, kind);
        let (mint, escrow, program) = self.side_accounts(side);
        let mut args = Vec::new();
        args.extend_from_slice(&nonce.to_le_bytes());
        args.extend_from_slice(&size.to_le_bytes());
        args.extend_from_slice(&fee_bps.to_le_bytes());
        let ix = self.ix(
            "post_offer",
            vec![
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new_readonly(self.market, false),
                AccountMeta::new(cross, false),
                AccountMeta::new(self.offer_addr(&cross, &maker.pubkey(), nonce), false),
                AccountMeta::new_readonly(self.mint, false),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new(ata(&maker.pubkey(), &mint, &program), false),
                AccountMeta::new(escrow, false),
                AccountMeta::new_readonly(program, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            &args,
        );
        let maker = maker.insecure_clone();
        self.send_as(&maker, &[ix])
    }

    pub fn clear(&mut self, day: i64, kind: u8) -> Res {
        let ix = self.ix("clear", vec![AccountMeta::new(self.cross_addr(day, kind), false)], &[]);
        let c = self.cranker();
        self.send_as(&c, &[ix])
    }

    fn settle_accounts(&self, cross: Address, account: Address, owner: Address) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new(self.bell.poster.pubkey(), true),
            AccountMeta::new_readonly(self.market, false),
            AccountMeta::new(cross, false),
            AccountMeta::new(account, false),
            AccountMeta::new(owner, false),
            AccountMeta::new(self.raw_ata(&owner), false),
            AccountMeta::new(self.quote_ata(&owner), false),
            AccountMeta::new(self.raw_escrow, false),
            AccountMeta::new(self.quote_escrow, false),
            AccountMeta::new_readonly(self.mint, false),
            AccountMeta::new_readonly(self.usdc, false),
            AccountMeta::new_readonly(addr(TOKEN_2022), false),
            AccountMeta::new_readonly(addr(SPL_TOKEN), false),
            AccountMeta::new_readonly(addr(ATA), false),
            AccountMeta::new_readonly(system_program::ID, false),
        ]
    }

    pub fn settle_order(&mut self, day: i64, kind: u8, owner: &Address, nonce: u16, legs: u8) -> Res {
        let cross = self.cross_addr(day, kind);
        let accounts = self.settle_accounts(cross, self.order_addr(&cross, owner, nonce), *owner);
        let ix = self.ix("settle_order", accounts, &[legs]);
        let c = self.cranker();
        self.send_as(&c, &[ix])
    }

    pub fn settle_offer(&mut self, day: i64, kind: u8, maker: &Address, nonce: u16, legs: u8) -> Res {
        let cross = self.cross_addr(day, kind);
        let accounts = self.settle_accounts(cross, self.offer_addr(&cross, maker, nonce), *maker);
        let ix = self.ix("settle_offer", accounts, &[legs]);
        let c = self.cranker();
        self.send_as(&c, &[ix])
    }

    pub fn close_cross(&mut self, day: i64, kind: u8) -> Res {
        let cross = self.cross_addr(day, kind);
        let created_by = CrossView::read(self, day, kind).expect("cross").created_by;
        let t = self.treasury.pubkey();
        let ix = self.ix(
            "close_cross",
            vec![
                AccountMeta::new(self.bell.poster.pubkey(), true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new_readonly(self.market, false),
                AccountMeta::new(cross, false),
                AccountMeta::new(created_by, false),
                AccountMeta::new_readonly(t, false),
                AccountMeta::new(self.raw_ata(&t), false),
                AccountMeta::new(self.quote_ata(&t), false),
                AccountMeta::new(self.raw_escrow, false),
                AccountMeta::new(self.quote_escrow, false),
                AccountMeta::new_readonly(self.mint, false),
                AccountMeta::new_readonly(self.usdc, false),
                AccountMeta::new_readonly(addr(TOKEN_2022), false),
                AccountMeta::new_readonly(addr(SPL_TOKEN), false),
                AccountMeta::new_readonly(addr(ATA), false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            &[],
        );
        let c = self.cranker();
        self.send_as(&c, &[ix])
    }

    /// Post a close print at `feed_ts_us` and freeze it, as the bell would.
    pub fn ring_close(&mut self, e: &Equity) {
        self.bell.set_time(CLOSE + 1);
        let msg = self.bell.close_msg(e);
        ok(self.bell.post(&msg, DAY, CLOSE_KIND), "post the close");
        self.bell.set_time(CLOSE + 300);
        ok(self.bell.finalize(DAY, CLOSE_KIND), "finalize the close");
    }

    /// Rewrite the mint's bytes, as the issuer's own instructions would.
    pub fn edit_mint(&mut self, f: impl FnOnce(&mut Vec<u8>)) {
        let mut a = self.bell.svm.get_account(&self.mint).unwrap();
        f(&mut a.data);
        self.bell.svm.set_account(self.mint, a).unwrap();
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.edit_mint(|d| {
            let at = extension(d, 26).expect("NVDAx is pausable");
            d[at + 32] = paused as u8;
        });
    }
}

/// A cross account, field by field in declaration order.
#[derive(Debug)]
pub struct CrossView {
    pub phase: u8,
    pub kind: u8,
    pub crowded: u8,
    pub simulated: bool,
    pub bell_ts: i64,
    pub created_by: Address,
    pub price_e8: u64,
    pub multiplier_wad: u128,
    pub price_wad: u128,
    pub n_orders: u32,
    pub n_confirmed: u32,
    pub n_settled: u32,
    pub buy_in: u64,
    pub sell_in: u64,
    pub auction_end: i64,
    pub n_offers: u32,
    pub clearing: math::Clearing,
    pub quote_in: u64,
    pub quote_out: u64,
    pub raw_in: u64,
    pub raw_out: u64,
}

impl CrossView {
    pub fn read(env: &CrossEnv, day: i64, kind: u8) -> Option<CrossView> {
        let a = env.bell.svm.get_account(&env.cross_addr(day, kind))?;
        if a.data.is_empty() || a.owner != env.program {
            return None;
        }
        assert_eq!(&a.data[..8], &disc("account", "Cross"));
        let mut c = Cur(&a.data[8..]);
        let (_version, _bump, phase, kind, crowded) = (c.u8(), c.u8(), c.u8(), c.u8(), c.u8());
        let simulated = c.u8() == 1;
        let _market = c.key();
        let _day = c.i64();
        let bell_ts = c.i64();
        let created_by = c.key();
        let _print = c.key();
        let _mantissa = c.i64();
        let _expo = c.i16();
        let price_e8 = c.u64();
        let multiplier_wad = c.u128();
        let price_wad = c.u128();
        let (n_orders, n_confirmed, n_settled) = (c.u32(), c.u32(), c.u32());
        let (_buy_total, _sell_total) = (c.u64(), c.u64());
        let (buy_in, sell_in) = (c.u64(), c.u64());
        let auction_end = c.i64();
        let (n_offers, _n_offers_settled) = (c.u32(), c.u32());
        for _ in 0..math::LADDER {
            c.u64();
        }
        let fee_bps = c.u16();
        let maker_price_wad = c.u128();
        let marginal_fee_bps = c.u16();
        let (marginal_need, marginal_cap) = (c.u128(), c.u128());
        let (buy_spent, buy_tokens, sell_spent, sell_quote) = (c.u128(), c.u128(), c.u128(), c.u128());
        let (quote_in, quote_out, raw_in, raw_out) = (c.u64(), c.u64(), c.u64(), c.u64());
        let clearing = math::Clearing {
            crowded: match crowded {
                1 => math::Crowded::Buyers,
                2 => math::Crowded::Sellers,
                _ => math::Crowded::Balanced,
            },
            price_wad,
            fee_bps,
            maker_price_wad,
            marginal_fee_bps,
            marginal_need,
            marginal_cap,
            buy_in: buy_in as u128,
            buy_spent,
            buy_tokens,
            sell_in: sell_in as u128,
            sell_spent,
            sell_quote,
        };
        Some(CrossView {
            phase,
            kind,
            crowded,
            simulated,
            bell_ts,
            created_by,
            price_e8,
            multiplier_wad,
            price_wad,
            n_orders,
            n_confirmed,
            n_settled,
            buy_in,
            sell_in,
            auction_end,
            n_offers,
            clearing,
            quote_in,
            quote_out,
            raw_in,
            raw_out,
        })
    }
}
