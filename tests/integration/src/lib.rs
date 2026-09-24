//! The bell harness: Pyth's verifier, session-bell, and everything a test
//! needs to post a print through them. `tests/bell.rs` tests the bell with
//! it; `tests/cross.rs` builds the exchange on top of it.

pub use byteorder::LE;
use ed25519_dalek::{Signer as _, SigningKey};
pub use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
pub use pyth_lazer_protocol::{
    api::MarketSession,
    message::SolanaMessage,
    payload::{PayloadData, PayloadFeedData, PayloadPropertyValue as P},
    time::TimestampUs,
    ChannelId, Price, PriceFeedId,
};
pub use sha2::{Digest, Sha256};
pub use solana_address::Address;
pub use solana_clock::Clock;
pub use solana_instruction::{error::InstructionError, AccountMeta, Instruction};
pub use solana_keypair::Keypair;
pub use solana_message::Message;
pub use solana_sdk_ids::{bpf_loader_upgradeable, compute_budget, ed25519_program, system_program, sysvar};
pub use solana_signer::Signer;
pub use solana_transaction::Transaction;
pub use solana_transaction_error::TransactionError;

pub type Res = Result<TransactionMetadata, FailedTransactionMetadata>;

pub const LAZER: &str = "pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt";
pub const BELL: &str = "BeLLKXJwhSH6YXYQLc8xLd11GxJUvoaT1h9zCadymJv4";
pub const MEMO: &str = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
pub const BELL_SO: &str = "../../target/deploy/session_bell.so";

/// The verifier under test: Pyth's mainnet binary by default, or any build
/// of it named by `BELL_VERIFIER_SO` and `BELL_VERIFIER_ID` — which is how
/// the devnet copy in tools/lazer-devnet is held to the same cases.
pub fn verifier() -> (Address, String) {
    match (std::env::var("BELL_VERIFIER_ID"), std::env::var("BELL_VERIFIER_SO")) {
        (Ok(id), Ok(so)) => (addr(&id), so),
        _ => (addr(LAZER), "fixtures/pyth_lazer.so".into()),
    }
}

// Pyth Pro feed ids for NVDA.
pub const EQUITY: u32 = 1314; // Equity.US.NVDA/USD
pub const RR: u32 = 1832; // Crypto.NVDAX/NVDA.RR
pub const TOKEN: u32 = 1833; // Crypto.NVDAX/USD
pub const INDEX: u32 = 3188; // Equity.Index.NVDA/USD

/// Thursday 24 September 2026, EDT.
pub const DAY: i64 = 20_720;
pub const OPEN: i64 = 1_790_256_600; // 13:30 UTC = 09:30 ET
pub const CLOSE: i64 = 1_790_280_000; // 20:00 UTC = 16:00 ET
pub const SATURDAY: i64 = 20_722;
pub const THANKSGIVING: i64 = 20_783;

pub const US: u64 = 1_000_000;
pub const OPEN_KIND: u8 = 0;
pub const CLOSE_KIND: u8 = 1;

pub fn addr(s: &str) -> Address {
    s.parse().unwrap()
}

pub fn disc(ns: &str, name: &str) -> [u8; 8] {
    Sha256::digest(format!("{ns}:{name}").as_bytes())[..8].try_into().unwrap()
}

pub fn pda(seeds: &[&[u8]], program: &Address) -> Address {
    Address::find_program_address(seeds, program).0
}

/* ── Pyth messages, built with Pyth's encoder ─────────────────────────────── */

#[derive(Clone)]
pub struct Equity {
    pub price: i64,
    pub conf: i64,
    pub publishers: u16,
    pub session: MarketSession,
    pub feed_ts: u64,
}

impl Equity {
    pub fn at(feed_ts: u64) -> Equity {
        Equity { price: 22_406_000_000, conf: 1_100_000, publishers: 9, session: MarketSession::Regular, feed_ts }
    }
    pub fn props(&self) -> Vec<P> {
        vec![
            P::Price(Price::from_mantissa(self.price).ok()),
            P::Confidence(Price::from_mantissa(self.conf).ok()),
            P::Exponent(-8),
            P::PublisherCount(self.publishers),
            P::MarketSession(self.session),
            P::FeedUpdateTimestamp(Some(TimestampUs::from_micros(self.feed_ts))),
        ]
    }
}

pub fn simple(price: i64, ts: u64) -> Vec<P> {
    vec![
        P::Price(Price::from_mantissa(price).ok()),
        P::Exponent(-8),
        P::FeedUpdateTimestamp(Some(TimestampUs::from_micros(ts))),
    ]
}

pub fn payload(msg_ts: u64, feeds: Vec<(u32, Vec<P>)>) -> Vec<u8> {
    let data = PayloadData {
        timestamp_us: TimestampUs::from_micros(msg_ts),
        channel_id: ChannelId::FIXED_RATE_200,
        feeds: feeds
            .into_iter()
            .map(|(id, properties)| PayloadFeedData { feed_id: PriceFeedId(id), properties })
            .collect(),
    };
    let mut out = Vec::new();
    data.serialize::<LE>(&mut out).unwrap();
    out
}

/// The four NVDA feeds, as one subscription would deliver them.
pub fn nvda(e: &Equity, msg_ts: u64) -> Vec<u8> {
    payload(
        msg_ts,
        vec![
            (EQUITY, e.props()),
            (RR, simple(100_170_000, msg_ts)),
            (TOKEN, simple(22_441_000_000, msg_ts)),
            (INDEX, simple(22_405_000_000, msg_ts)),
        ],
    )
}

pub fn sign(key: &SigningKey, payload: Vec<u8>) -> Vec<u8> {
    let signature = key.sign(&payload).to_bytes();
    let m = SolanaMessage { payload, signature, public_key: key.verifying_key().to_bytes() };
    let mut out = Vec::new();
    m.serialize(&mut out).unwrap();
    out
}

/// Pyth's `createEd25519Instruction(message, instructionIndex, startingOffset)`.
pub fn ed25519_ix(message: &[u8], ix_index: u16, start: u16) -> Instruction {
    let sig = start + 4;
    let pk = sig + 64;
    let size_at = pk + 32;
    let data_at = size_at + 2;
    let size = u16::from_le_bytes(message[(size_at - start) as usize..(data_at - start) as usize].try_into().unwrap());
    let mut data = vec![1u8, 0u8];
    for v in [sig, ix_index, pk, ix_index, data_at, size, ix_index] {
        data.extend_from_slice(&v.to_le_bytes());
    }
    Instruction { program_id: ed25519_program::ID, accounts: vec![], data }
}

pub fn cu_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction { program_id: compute_budget::ID, accounts: vec![], data }
}

/* ── the environment ──────────────────────────────────────────────────────── */

#[derive(Clone, Copy)]
pub struct Params {
    pub min_publishers: u16,
    pub max_conf_bps: u16,
    pub close_lead_secs: u32,
    pub open_window_secs: u32,
    pub finalize_after_secs: u32,
    pub max_divergence_bps: u16,
    pub method_version: u16,
}

pub const V1: Params = Params {
    min_publishers: 1,
    max_conf_bps: 25,
    close_lead_secs: 10,
    open_window_secs: 60,
    finalize_after_secs: 300,
    max_divergence_bps: 300,
    method_version: 1,
};

impl Params {
    pub fn bytes(&self) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&self.min_publishers.to_le_bytes());
        v.extend_from_slice(&self.max_conf_bps.to_le_bytes());
        v.extend_from_slice(&self.close_lead_secs.to_le_bytes());
        v.extend_from_slice(&self.open_window_secs.to_le_bytes());
        v.extend_from_slice(&self.finalize_after_secs.to_le_bytes());
        v.extend_from_slice(&self.max_divergence_bps.to_le_bytes());
        v.extend_from_slice(&self.method_version.to_le_bytes());
        v
    }
}

pub struct Env {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub poster: Keypair,
    pub signer: SigningKey,
    pub lazer: Address,
    pub bell: Address,
    pub storage: Address,
    pub treasury: Address,
    pub config: Address,
    pub listing: Address,
}

pub fn symbol(s: &str) -> [u8; 16] {
    let mut out = [0u8; 16];
    out[..s.len()].copy_from_slice(s.as_bytes());
    out
}

impl Env {
    /// Both programs loaded, Pyth's storage initialised with the test key
    /// trusted, the config created and NVDA registered before the 24
    /// September open. The clock is then set just after that day's close.
    pub fn new() -> Env {
        let mut env = Env::bare();
        let lazer = env.lazer;
        env.init_config(lazer).unwrap();
        env.register("NVDA", [EQUITY, RR, TOKEN, INDEX]).unwrap();
        env.listing = pda(&[b"listing", &symbol("NVDA")], &env.bell);
        env.set_time(CLOSE + 1);
        env
    }

    /// Programs and Pyth's storage, but no config yet.
    pub fn bare() -> Env {
        let mut svm = LiteSVM::new();
        let (lazer, lazer_so) = verifier();
        let bell = addr(BELL);
        svm.add_program_from_file(lazer, &lazer_so).expect("run ./fetch.sh first");
        svm.add_program_from_file(bell, BELL_SO).expect("run `npm run build:program` at the repository root first");

        let admin = Keypair::new();
        let poster = Keypair::new();
        let treasury = Keypair::new().pubkey();
        for who in [admin.pubkey(), poster.pubkey(), treasury] {
            svm.airdrop(&who, 100_000_000_000).unwrap();
        }
        let signer = SigningKey::from_bytes(&[7u8; 32]);
        let storage = pda(&[b"storage"], &lazer);
        let config = pda(&[b"bell-config"], &bell);

        let mut env = Env {
            svm,
            admin,
            poster,
            signer,
            lazer,
            bell,
            storage,
            treasury,
            config,
            listing: Address::default(),
        };
        env.set_upgrade_authority();
        // Everything is registered an hour before Thursday's open.
        env.set_time(OPEN - 3_600);

        // Pyth's own initialize and update, as Pyth runs them on mainnet.
        let admin_key = env.admin.pubkey();
        let mut data = disc("global", "initialize").to_vec();
        data.extend_from_slice(admin_key.as_ref());
        data.extend_from_slice(treasury.as_ref());
        let ix = Instruction {
            program_id: lazer,
            accounts: vec![
                AccountMeta::new(admin_key, true),
                AccountMeta::new(storage, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            data,
        };
        env.send_admin(&[ix]).expect("lazer initialize");
        let key = env.signer.verifying_key().to_bytes();
        env.trust(key, i64::MAX).expect("lazer update");
        env
    }

    pub fn set_upgrade_authority(&mut self) {
        let bell = self.bell;
        self.set_upgrade_authority_of(&bell);
    }

    /// Make the admin the upgrade authority of `program`, as a real deploy
    /// would: LiteSVM installs programs with none.
    pub fn set_upgrade_authority_of(&mut self, program: &Address) {
        let pd = pda(&[program.as_ref()], &bpf_loader_upgradeable::ID);
        let mut acc = self.svm.get_account(&pd).unwrap();
        // UpgradeableLoaderState::ProgramData { slot, upgrade_authority_address }:
        // u32 tag, u64 slot, then Option<Pubkey> at byte 12.
        acc.data[12] = 1;
        acc.data[13..45].copy_from_slice(self.admin.pubkey().as_ref());
        self.svm.set_account(pd, acc).unwrap();
    }

    pub fn trust(&mut self, key: [u8; 32], expires_at: i64) -> Res {
        let mut data = disc("global", "update").to_vec();
        data.extend_from_slice(&key);
        data.extend_from_slice(&expires_at.to_le_bytes());
        let ix = Instruction {
            program_id: self.lazer,
            accounts: vec![AccountMeta::new_readonly(self.admin.pubkey(), true), AccountMeta::new(self.storage, false)],
            data,
        };
        self.send_admin(&[ix])
    }

    pub fn set_time(&mut self, unix: i64) {
        let mut c: Clock = self.svm.get_sysvar();
        c.unix_timestamp = unix;
        c.slot += 1;
        self.svm.set_sysvar(&c);
    }

    pub fn send(&mut self, ixs: &[Instruction], payer: &Keypair) -> Res {
        let tx = Transaction::new(&[payer], Message::new(ixs, Some(&payer.pubkey())), self.svm.latest_blockhash());
        let r = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        r
    }

    pub fn send_admin(&mut self, ixs: &[Instruction]) -> Res {
        let admin = self.admin.insecure_clone();
        self.send(ixs, &admin)
    }

    pub fn send_poster(&mut self, ixs: &[Instruction]) -> Res {
        let poster = self.poster.insecure_clone();
        self.send(ixs, &poster)
    }

    pub fn init_config_as(&mut self, who: &Keypair, verifier: Address, verifier_storage: Address, p: Params) -> Res {
        let mut data = disc("global", "init_config").to_vec();
        data.extend_from_slice(&p.bytes());
        let ix = Instruction {
            program_id: self.bell,
            accounts: vec![
                AccountMeta::new(who.pubkey(), true),
                AccountMeta::new(self.config, false),
                AccountMeta::new_readonly(self.bell, false),
                AccountMeta::new_readonly(pda(&[self.bell.as_ref()], &bpf_loader_upgradeable::ID), false),
                AccountMeta::new_readonly(verifier, false),
                AccountMeta::new_readonly(verifier_storage, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            data,
        };
        let who = who.insecure_clone();
        self.send(&[ix], &who)
    }

    pub fn init_config(&mut self, verifier: Address) -> Res {
        let admin = self.admin.insecure_clone();
        let storage = pda(&[b"storage"], &verifier);
        self.init_config_as(&admin, verifier, storage, V1)
    }

    pub fn register(&mut self, sym: &str, feeds: [u32; 4]) -> Res {
        self.register_mint(sym, feeds, Address::from([9u8; 32]))
    }

    pub fn register_mint(&mut self, sym: &str, feeds: [u32; 4], mint: Address) -> Res {
        let s = symbol(sym);
        let mut data = disc("global", "register_listing").to_vec();
        data.extend_from_slice(&s);
        for f in feeds {
            data.extend_from_slice(&f.to_le_bytes());
        }
        data.extend_from_slice(mint.as_ref());
        let ix = Instruction {
            program_id: self.bell,
            accounts: vec![
                AccountMeta::new(self.admin.pubkey(), true),
                AccountMeta::new(self.config, false),
                AccountMeta::new(pda(&[b"listing", &s], &self.bell), false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            data,
        };
        self.send_admin(&[ix])
    }

    pub fn set_active(&mut self, active: bool) -> Res {
        let mut data = disc("global", "set_listing_active").to_vec();
        data.push(active as u8);
        let ix = Instruction {
            program_id: self.bell,
            accounts: vec![
                AccountMeta::new_readonly(self.admin.pubkey(), true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new(self.listing, false),
            ],
            data,
        };
        self.send_admin(&[ix])
    }

    pub fn print_addr(&self, day: i64, kind: u8) -> Address {
        pda(&[b"print", self.listing.as_ref(), &day.to_le_bytes(), &[kind]], &self.bell)
    }

    pub fn post_ix(&self, message: &[u8], day: i64, kind: u8, ed25519_at: u16) -> Instruction {
        let mut data = disc("global", "post_print").to_vec();
        data.extend_from_slice(&(message.len() as u32).to_le_bytes());
        data.extend_from_slice(message);
        data.extend_from_slice(&day.to_le_bytes());
        data.push(kind);
        data.extend_from_slice(&ed25519_at.to_le_bytes());
        let verifier: Address = self.config_verifier();
        Instruction {
            program_id: self.bell,
            accounts: vec![
                AccountMeta::new(self.poster.pubkey(), true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new(self.listing, false),
                AccountMeta::new(self.print_addr(day, kind), false),
                AccountMeta::new_readonly(verifier, false),
                AccountMeta::new_readonly(pda(&[b"storage"], &verifier), false),
                AccountMeta::new(self.treasury, false),
                AccountMeta::new_readonly(sysvar::instructions::ID, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            data,
        }
    }

    pub fn config_verifier(&self) -> Address {
        let acc = self.svm.get_account(&self.config).unwrap();
        // disc 8, version, bump, simulated, admin 32, pending 32, then verifier
        Address::try_from(&acc.data[8 + 3 + 64..8 + 3 + 96]).unwrap()
    }

    /// The layout a real poster sends: compute budget, then Pyth's Ed25519
    /// instruction, then the post, whose data holds the message at byte 12.
    pub fn post(&mut self, message: &[u8], day: i64, kind: u8) -> Res {
        let ixs = [cu_limit(400_000), ed25519_ix(message, 2, 12), self.post_ix(message, day, kind, 1)];
        self.send_poster(&ixs)
    }

    pub fn close_msg(&self, e: &Equity) -> Vec<u8> {
        sign(&self.signer, nvda(e, e.feed_ts + 150_000))
    }

    pub fn finalize(&mut self, day: i64, kind: u8) -> Res {
        let ix = Instruction {
            program_id: self.bell,
            accounts: vec![AccountMeta::new(self.print_addr(day, kind), false)],
            data: disc("global", "finalize_print").to_vec(),
        };
        self.send_poster(&[ix])
    }

    pub fn mark_missing(&mut self, day: i64, kind: u8) -> Res {
        let mut data = disc("global", "mark_missing").to_vec();
        data.extend_from_slice(&day.to_le_bytes());
        data.push(kind);
        let ix = Instruction {
            program_id: self.bell,
            accounts: vec![
                AccountMeta::new(self.poster.pubkey(), true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new(self.listing, false),
                AccountMeta::new(self.print_addr(day, kind), false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            data,
        };
        self.send_poster(&[ix])
    }

    pub fn print(&self, day: i64, kind: u8) -> Option<PrintView> {
        let acc = self.svm.get_account(&self.print_addr(day, kind))?;
        if acc.data.is_empty() {
            return None;
        }
        assert_eq!(acc.owner, self.bell);
        assert_eq!(&acc.data[..8], &disc("account", "Print"));
        Some(PrintView::decode(&acc.data[8..]))
    }

    pub fn listing_counts(&self) -> (u64, u64) {
        let d = self.svm.get_account(&self.listing).unwrap().data;
        // disc 8, version, bump, active, symbol 16, 4 feeds, mint 32, prints, missing
        let at = 8 + 3 + 16 + 16 + 32;
        (u64::from_le_bytes(d[at..at + 8].try_into().unwrap()), u64::from_le_bytes(d[at + 8..at + 16].try_into().unwrap()))
    }
}

/* ── reading a print back, field by field, in declaration order ───────────── */

#[derive(Debug, Clone, Copy)]
pub struct QuoteView {
    pub feed_id: u32,
    pub price: i64,
    pub conf: i64,
    pub expo: i16,
    pub publishers: u16,
    pub session: u8,
    pub present: bool,
    pub feed_ts_us: u64,
}

#[derive(Debug)]
#[allow(dead_code)]
pub struct PrintView {
    pub version: u8,
    pub bump: u8,
    pub status: u8,
    pub kind: u8,
    pub flags: u8,
    pub channel: u8,
    pub posts: u16,
    pub method_version: u16,
    pub listing: Address,
    pub day: i64,
    pub bell_ts: i64,
    pub window_start_us: u64,
    pub window_end_us: u64,
    pub deadline: i64,
    pub equity: QuoteView,
    pub rr: QuoteView,
    pub token: QuoteView,
    pub index: QuoteView,
    pub divergence_bps: i64,
    pub message_ts_us: u64,
    pub signer: [u8; 32],
    pub verifier: Address,
    pub poster: Address,
    pub slot: u64,
    pub posted_at: i64,
    pub finalized_at: i64,
}

pub struct Cur<'a>(&'a [u8]);

impl<'a> Cur<'a> {
    pub fn take<const N: usize>(&mut self) -> [u8; N] {
        let (h, t) = self.0.split_at(N);
        self.0 = t;
        h.try_into().unwrap()
    }
    pub fn u8(&mut self) -> u8 {
        self.take::<1>()[0]
    }
    pub fn u16(&mut self) -> u16 {
        u16::from_le_bytes(self.take())
    }
    pub fn i16(&mut self) -> i16 {
        i16::from_le_bytes(self.take())
    }
    pub fn u32(&mut self) -> u32 {
        u32::from_le_bytes(self.take())
    }
    pub fn u64(&mut self) -> u64 {
        u64::from_le_bytes(self.take())
    }
    pub fn i64(&mut self) -> i64 {
        i64::from_le_bytes(self.take())
    }
    pub fn u128(&mut self) -> u128 {
        u128::from_le_bytes(self.take())
    }
    pub fn key(&mut self) -> Address {
        Address::from(self.take::<32>())
    }
    pub fn quote(&mut self) -> QuoteView {
        QuoteView {
            feed_id: self.u32(),
            price: self.i64(),
            conf: self.i64(),
            expo: self.i16(),
            publishers: self.u16(),
            session: self.u8(),
            present: self.u8() == 1,
            feed_ts_us: self.u64(),
        }
    }
}

impl PrintView {
    pub fn decode(d: &[u8]) -> PrintView {
        let mut c = Cur(d);
        PrintView {
            version: c.u8(),
            bump: c.u8(),
            status: c.u8(),
            kind: c.u8(),
            flags: c.u8(),
            channel: c.u8(),
            posts: c.u16(),
            method_version: c.u16(),
            listing: c.key(),
            day: c.i64(),
            bell_ts: c.i64(),
            window_start_us: c.u64(),
            window_end_us: c.u64(),
            deadline: c.i64(),
            equity: c.quote(),
            rr: c.quote(),
            token: c.quote(),
            index: c.quote(),
            divergence_bps: c.i64(),
            message_ts_us: c.u64(),
            signer: c.take::<32>(),
            verifier: c.key(),
            poster: c.key(),
            slot: c.u64(),
            posted_at: c.i64(),
            finalized_at: c.i64(),
        }
    }
}

pub const PROVISIONAL: u8 = 0;
pub const FINAL: u8 = 1;
pub const MISSING: u8 = 2;
pub const FLAG_SIMULATED: u8 = 1;
pub const FLAG_DIVERGENCE_KNOWN: u8 = 2;

/* ── assertions ───────────────────────────────────────────────────────────── */

pub fn ok(r: Res, what: &str) -> TransactionMetadata {
    match r {
        Ok(m) => m,
        Err(f) => panic!("{what} failed: {:?}\n{}", f.err, f.meta.logs.join("\n")),
    }
}

/// Fails, and a log line names why.
pub fn refused(r: Res, needle: &str) {
    match r {
        Ok(m) => panic!("expected a refusal naming {needle:?}; it succeeded:\n{}", m.logs.join("\n")),
        Err(f) => assert!(
            f.meta.logs.iter().any(|l| l.contains(needle)),
            "expected {needle:?} in the logs; got {:?}\n{}",
            f.err,
            f.meta.logs.join("\n")
        ),
    }
}

pub fn anchor(code: &str) -> String {
    format!("Error Code: {code}.")
}

pub mod cross;
