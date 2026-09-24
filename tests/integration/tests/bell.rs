//! session-bell end to end, against Pyth's own verifier.
//!
//! Every message here is built by Pyth's encoder (`pyth-lazer-protocol`
//! 0.46.0), signed by a key this test holds, and checked by the Lazer program
//! exactly as deployed on mainnet (`./fetch.sh` dumps it). The test key is
//! made a trusted signer through the verifier's own `update` instruction —
//! the one step that differs from a real post, where the signer is Pyth's.
//!
//! Run: `./fetch.sh && cargo test` here, after `npm run build:program` at the
//! repository root.

use byteorder::LE;
use ed25519_dalek::{Signer as _, SigningKey};
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use pyth_lazer_protocol::{
    api::MarketSession,
    message::SolanaMessage,
    payload::{PayloadData, PayloadFeedData, PayloadPropertyValue as P},
    time::TimestampUs,
    ChannelId, Price, PriceFeedId,
};
use sha2::{Digest, Sha256};
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{error::InstructionError, AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_sdk_ids::{bpf_loader_upgradeable, compute_budget, ed25519_program, system_program, sysvar};
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;

type Res = Result<TransactionMetadata, FailedTransactionMetadata>;

const LAZER: &str = "pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt";
const BELL: &str = "BeLLKXJwhSH6YXYQLc8xLd11GxJUvoaT1h9zCadymJv4";
const MEMO: &str = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const BELL_SO: &str = "../../target/deploy/session_bell.so";

/// The verifier under test: Pyth's mainnet binary by default, or any build
/// of it named by `BELL_VERIFIER_SO` and `BELL_VERIFIER_ID` — which is how
/// the devnet copy in tools/lazer-devnet is held to the same cases.
fn verifier() -> (Address, String) {
    match (std::env::var("BELL_VERIFIER_ID"), std::env::var("BELL_VERIFIER_SO")) {
        (Ok(id), Ok(so)) => (addr(&id), so),
        _ => (addr(LAZER), "fixtures/pyth_lazer.so".into()),
    }
}

// Pyth Pro feed ids for NVDA.
const EQUITY: u32 = 1314; // Equity.US.NVDA/USD
const RR: u32 = 1832; // Crypto.NVDAX/NVDA.RR
const TOKEN: u32 = 1833; // Crypto.NVDAX/USD
const INDEX: u32 = 3188; // Equity.Index.NVDA/USD

/// Thursday 24 September 2026, EDT.
const DAY: i64 = 20_720;
const OPEN: i64 = 1_790_256_600; // 13:30 UTC = 09:30 ET
const CLOSE: i64 = 1_790_280_000; // 20:00 UTC = 16:00 ET
const SATURDAY: i64 = 20_722;
const THANKSGIVING: i64 = 20_783;

const US: u64 = 1_000_000;
const OPEN_KIND: u8 = 0;
const CLOSE_KIND: u8 = 1;

fn addr(s: &str) -> Address {
    s.parse().unwrap()
}

fn disc(ns: &str, name: &str) -> [u8; 8] {
    Sha256::digest(format!("{ns}:{name}").as_bytes())[..8].try_into().unwrap()
}

fn pda(seeds: &[&[u8]], program: &Address) -> Address {
    Address::find_program_address(seeds, program).0
}

/* ── Pyth messages, built with Pyth's encoder ─────────────────────────────── */

#[derive(Clone)]
struct Equity {
    price: i64,
    conf: i64,
    publishers: u16,
    session: MarketSession,
    feed_ts: u64,
}

impl Equity {
    fn at(feed_ts: u64) -> Equity {
        Equity { price: 22_406_000_000, conf: 1_100_000, publishers: 9, session: MarketSession::Regular, feed_ts }
    }
    fn props(&self) -> Vec<P> {
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

fn simple(price: i64, ts: u64) -> Vec<P> {
    vec![
        P::Price(Price::from_mantissa(price).ok()),
        P::Exponent(-8),
        P::FeedUpdateTimestamp(Some(TimestampUs::from_micros(ts))),
    ]
}

fn payload(msg_ts: u64, feeds: Vec<(u32, Vec<P>)>) -> Vec<u8> {
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
fn nvda(e: &Equity, msg_ts: u64) -> Vec<u8> {
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

fn sign(key: &SigningKey, payload: Vec<u8>) -> Vec<u8> {
    let signature = key.sign(&payload).to_bytes();
    let m = SolanaMessage { payload, signature, public_key: key.verifying_key().to_bytes() };
    let mut out = Vec::new();
    m.serialize(&mut out).unwrap();
    out
}

/// Pyth's `createEd25519Instruction(message, instructionIndex, startingOffset)`.
fn ed25519_ix(message: &[u8], ix_index: u16, start: u16) -> Instruction {
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

fn cu_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction { program_id: compute_budget::ID, accounts: vec![], data }
}

/* ── the environment ──────────────────────────────────────────────────────── */

#[derive(Clone, Copy)]
struct Params {
    min_publishers: u16,
    max_conf_bps: u16,
    close_lead_secs: u32,
    open_window_secs: u32,
    finalize_after_secs: u32,
    max_divergence_bps: u16,
    method_version: u16,
}

const V1: Params = Params {
    min_publishers: 1,
    max_conf_bps: 25,
    close_lead_secs: 10,
    open_window_secs: 60,
    finalize_after_secs: 300,
    max_divergence_bps: 300,
    method_version: 1,
};

impl Params {
    fn bytes(&self) -> Vec<u8> {
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

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    poster: Keypair,
    signer: SigningKey,
    lazer: Address,
    bell: Address,
    storage: Address,
    treasury: Address,
    config: Address,
    listing: Address,
}

fn symbol(s: &str) -> [u8; 16] {
    let mut out = [0u8; 16];
    out[..s.len()].copy_from_slice(s.as_bytes());
    out
}

impl Env {
    /// Both programs loaded, Pyth's storage initialised with the test key
    /// trusted, the config created and NVDA registered before the 24
    /// September open. The clock is then set just after that day's close.
    fn new() -> Env {
        let mut env = Env::bare();
        let lazer = env.lazer;
        env.init_config(lazer).unwrap();
        env.register("NVDA", [EQUITY, RR, TOKEN, INDEX]).unwrap();
        env.listing = pda(&[b"listing", &symbol("NVDA")], &env.bell);
        env.set_time(CLOSE + 1);
        env
    }

    /// Programs and Pyth's storage, but no config yet.
    fn bare() -> Env {
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

    fn set_upgrade_authority(&mut self) {
        let pd = pda(&[self.bell.as_ref()], &bpf_loader_upgradeable::ID);
        let mut acc = self.svm.get_account(&pd).unwrap();
        // UpgradeableLoaderState::ProgramData { slot, upgrade_authority_address }:
        // u32 tag, u64 slot, then Option<Pubkey> at byte 12.
        acc.data[12] = 1;
        acc.data[13..45].copy_from_slice(self.admin.pubkey().as_ref());
        self.svm.set_account(pd, acc).unwrap();
    }

    fn trust(&mut self, key: [u8; 32], expires_at: i64) -> Res {
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

    fn set_time(&mut self, unix: i64) {
        let mut c: Clock = self.svm.get_sysvar();
        c.unix_timestamp = unix;
        c.slot += 1;
        self.svm.set_sysvar(&c);
    }

    fn send(&mut self, ixs: &[Instruction], payer: &Keypair) -> Res {
        let tx = Transaction::new(&[payer], Message::new(ixs, Some(&payer.pubkey())), self.svm.latest_blockhash());
        let r = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        r
    }

    fn send_admin(&mut self, ixs: &[Instruction]) -> Res {
        let admin = self.admin.insecure_clone();
        self.send(ixs, &admin)
    }

    fn send_poster(&mut self, ixs: &[Instruction]) -> Res {
        let poster = self.poster.insecure_clone();
        self.send(ixs, &poster)
    }

    fn init_config_as(&mut self, who: &Keypair, verifier: Address, verifier_storage: Address, p: Params) -> Res {
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

    fn init_config(&mut self, verifier: Address) -> Res {
        let admin = self.admin.insecure_clone();
        let storage = pda(&[b"storage"], &verifier);
        self.init_config_as(&admin, verifier, storage, V1)
    }

    fn register(&mut self, sym: &str, feeds: [u32; 4]) -> Res {
        let s = symbol(sym);
        let mut data = disc("global", "register_listing").to_vec();
        data.extend_from_slice(&s);
        for f in feeds {
            data.extend_from_slice(&f.to_le_bytes());
        }
        data.extend_from_slice(&[9u8; 32]); // mint
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

    fn set_active(&mut self, active: bool) -> Res {
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

    fn print_addr(&self, day: i64, kind: u8) -> Address {
        pda(&[b"print", self.listing.as_ref(), &day.to_le_bytes(), &[kind]], &self.bell)
    }

    fn post_ix(&self, message: &[u8], day: i64, kind: u8, ed25519_at: u16) -> Instruction {
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

    fn config_verifier(&self) -> Address {
        let acc = self.svm.get_account(&self.config).unwrap();
        // disc 8, version, bump, simulated, admin 32, pending 32, then verifier
        Address::try_from(&acc.data[8 + 3 + 64..8 + 3 + 96]).unwrap()
    }

    /// The layout a real poster sends: compute budget, then Pyth's Ed25519
    /// instruction, then the post, whose data holds the message at byte 12.
    fn post(&mut self, message: &[u8], day: i64, kind: u8) -> Res {
        let ixs = [cu_limit(400_000), ed25519_ix(message, 2, 12), self.post_ix(message, day, kind, 1)];
        self.send_poster(&ixs)
    }

    fn close_msg(&self, e: &Equity) -> Vec<u8> {
        sign(&self.signer, nvda(e, e.feed_ts + 150_000))
    }

    fn finalize(&mut self, day: i64, kind: u8) -> Res {
        let ix = Instruction {
            program_id: self.bell,
            accounts: vec![AccountMeta::new(self.print_addr(day, kind), false)],
            data: disc("global", "finalize_print").to_vec(),
        };
        self.send_poster(&[ix])
    }

    fn mark_missing(&mut self, day: i64, kind: u8) -> Res {
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

    fn print(&self, day: i64, kind: u8) -> Option<PrintView> {
        let acc = self.svm.get_account(&self.print_addr(day, kind))?;
        if acc.data.is_empty() {
            return None;
        }
        assert_eq!(acc.owner, self.bell);
        assert_eq!(&acc.data[..8], &disc("account", "Print"));
        Some(PrintView::decode(&acc.data[8..]))
    }

    fn listing_counts(&self) -> (u64, u64) {
        let d = self.svm.get_account(&self.listing).unwrap().data;
        // disc 8, version, bump, active, symbol 16, 4 feeds, mint 32, prints, missing
        let at = 8 + 3 + 16 + 16 + 32;
        (u64::from_le_bytes(d[at..at + 8].try_into().unwrap()), u64::from_le_bytes(d[at + 8..at + 16].try_into().unwrap()))
    }
}

/* ── reading a print back, field by field, in declaration order ───────────── */

#[derive(Debug, Clone, Copy)]
struct QuoteView {
    feed_id: u32,
    price: i64,
    conf: i64,
    expo: i16,
    publishers: u16,
    session: u8,
    present: bool,
    feed_ts_us: u64,
}

#[derive(Debug)]
#[allow(dead_code)]
struct PrintView {
    version: u8,
    bump: u8,
    status: u8,
    kind: u8,
    flags: u8,
    channel: u8,
    posts: u16,
    method_version: u16,
    listing: Address,
    day: i64,
    bell_ts: i64,
    window_start_us: u64,
    window_end_us: u64,
    deadline: i64,
    equity: QuoteView,
    rr: QuoteView,
    token: QuoteView,
    index: QuoteView,
    divergence_bps: i64,
    message_ts_us: u64,
    signer: [u8; 32],
    verifier: Address,
    poster: Address,
    slot: u64,
    posted_at: i64,
    finalized_at: i64,
}

struct Cur<'a>(&'a [u8]);

impl<'a> Cur<'a> {
    fn take<const N: usize>(&mut self) -> [u8; N] {
        let (h, t) = self.0.split_at(N);
        self.0 = t;
        h.try_into().unwrap()
    }
    fn u8(&mut self) -> u8 {
        self.take::<1>()[0]
    }
    fn u16(&mut self) -> u16 {
        u16::from_le_bytes(self.take())
    }
    fn i16(&mut self) -> i16 {
        i16::from_le_bytes(self.take())
    }
    fn u32(&mut self) -> u32 {
        u32::from_le_bytes(self.take())
    }
    fn u64(&mut self) -> u64 {
        u64::from_le_bytes(self.take())
    }
    fn i64(&mut self) -> i64 {
        i64::from_le_bytes(self.take())
    }
    fn key(&mut self) -> Address {
        Address::from(self.take::<32>())
    }
    fn quote(&mut self) -> QuoteView {
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
    fn decode(d: &[u8]) -> PrintView {
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

const PROVISIONAL: u8 = 0;
const FINAL: u8 = 1;
const MISSING: u8 = 2;
const FLAG_SIMULATED: u8 = 1;
const FLAG_DIVERGENCE_KNOWN: u8 = 2;

/* ── assertions ───────────────────────────────────────────────────────────── */

fn ok(r: Res, what: &str) -> TransactionMetadata {
    match r {
        Ok(m) => m,
        Err(f) => panic!("{what} failed: {:?}\n{}", f.err, f.meta.logs.join("\n")),
    }
}

/// Fails, and a log line names why.
fn refused(r: Res, needle: &str) {
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

fn anchor(code: &str) -> String {
    format!("Error Code: {code}.")
}

/* ── the cases ────────────────────────────────────────────────────────────── */

#[test]
fn a_valid_close_is_stored_with_every_field() {
    let mut env = Env::new();
    let feed_ts = CLOSE as u64 * US - 200_000; // 15:59:59.8
    let msg = env.close_msg(&Equity::at(feed_ts));
    let meta = ok(env.post(&msg, DAY, CLOSE_KIND), "post");
    println!("ok post_print: {} CU", meta.compute_units_consumed);

    let p = env.print(DAY, CLOSE_KIND).expect("print exists");
    assert_eq!(p.version, 1);
    assert_eq!(p.status, PROVISIONAL);
    assert_eq!(p.kind, CLOSE_KIND);
    assert_eq!(p.posts, 1);
    assert_eq!(p.method_version, 1);
    assert_eq!(p.listing, env.listing);
    assert_eq!(p.day, DAY);
    assert_eq!(p.bell_ts, CLOSE);
    assert_eq!(p.window_start_us, (CLOSE - 10) as u64 * US);
    assert_eq!(p.window_end_us, CLOSE as u64 * US);
    assert_eq!(p.deadline, CLOSE + 300);
    assert_eq!(p.channel, 3, "fixed_rate@200ms");

    let e = p.equity;
    assert_eq!((e.feed_id, e.price, e.conf, e.expo, e.publishers, e.session, e.present), (EQUITY, 22_406_000_000, 1_100_000, -8, 9, 0, true));
    assert_eq!(e.feed_ts_us, feed_ts);
    assert_eq!((p.rr.feed_id, p.rr.price, p.rr.present), (RR, 100_170_000, true));
    assert_eq!((p.token.feed_id, p.token.price), (TOKEN, 22_441_000_000));
    assert_eq!((p.index.feed_id, p.index.price), (INDEX, 22_405_000_000));
    assert_eq!(p.rr.session, 255, "not reported for that feed");

    // 224.41 against 224.06 × 1.0017 = 224.440902: −1.38 bps
    assert_eq!(p.divergence_bps, -1);
    assert_eq!(p.flags & FLAG_DIVERGENCE_KNOWN, FLAG_DIVERGENCE_KNOWN);
    assert_eq!(p.flags & FLAG_SIMULATED != 0, env.lazer != addr(LAZER), "simulated exactly when not Pyth's program id");

    assert_eq!(p.message_ts_us, feed_ts + 150_000);
    assert_eq!(p.signer, env.signer.verifying_key().to_bytes());
    assert_eq!(p.verifier, env.lazer);
    assert_eq!(p.poster, env.poster.pubkey());
    assert_eq!(p.posted_at, CLOSE + 1);
    assert_eq!(p.finalized_at, 0);
    assert_eq!(env.listing_counts(), (1, 0));
    println!("ok a valid close is stored with every field");
}

#[test]
fn the_verifier_charges_its_fee_to_the_poster() {
    let mut env = Env::new();
    let before = env.svm.get_balance(&env.treasury).unwrap();
    let msg = env.close_msg(&Equity::at(CLOSE as u64 * US - 1));
    ok(env.post(&msg, DAY, CLOSE_KIND), "post");
    assert_eq!(env.svm.get_balance(&env.treasury).unwrap(), before + 1, "Pyth's 1-lamport fee");
    println!("ok the verifier's fee reaches its treasury");
}

#[test]
fn a_later_close_replaces_an_earlier_one_never_the_reverse() {
    let mut env = Env::new();
    let base = CLOSE as u64 * US;
    let early = env.close_msg(&Equity::at(base - 5 * US));
    let late = env.close_msg(&Equity { price: 22_410_000_000, ..Equity::at(base - US) });
    let middle = env.close_msg(&Equity::at(base - 3 * US));

    ok(env.post(&early, DAY, CLOSE_KIND), "early");
    ok(env.post(&late, DAY, CLOSE_KIND), "late replaces early");
    let p = env.print(DAY, CLOSE_KIND).unwrap();
    assert_eq!((p.equity.price, p.equity.feed_ts_us, p.posts), (22_410_000_000, base - US, 2));

    refused(env.post(&middle, DAY, CLOSE_KIND), &anchor("NotBetter"));
    refused(env.post(&late, DAY, CLOSE_KIND), &anchor("NotBetter"));
    let p = env.print(DAY, CLOSE_KIND).unwrap();
    assert_eq!((p.equity.feed_ts_us, p.posts), (base - US, 2));
    assert_eq!(env.listing_counts(), (1, 0), "a replacement is not a new print");
    println!("ok a later close replaces; an earlier or equal one is refused");
}

#[test]
fn an_earlier_open_replaces_a_later_one_never_the_reverse() {
    let mut env = Env::new();
    env.set_time(OPEN + 30);
    let base = OPEN as u64 * US;
    let msg = |env: &Env, ts: u64| sign(&env.signer, nvda(&Equity::at(ts), ts + 50_000));

    let later = msg(&env, base + 2 * US);
    let first = msg(&env, base + 100_000);
    let after = msg(&env, base + 5 * US);
    ok(env.post(&later, DAY, OPEN_KIND), "later open");
    ok(env.post(&first, DAY, OPEN_KIND), "earlier open replaces");
    refused(env.post(&after, DAY, OPEN_KIND), &anchor("NotBetter"));
    let p = env.print(DAY, OPEN_KIND).unwrap();
    assert_eq!((p.equity.feed_ts_us, p.posts, p.bell_ts), (base + 100_000, 2, OPEN));
    assert_eq!(p.deadline, OPEN + 60 + 300);

    let before_open = msg(&env, base - 1);
    refused(env.post(&before_open, DAY, OPEN_KIND), &anchor("OutsideWindow"));
    let past_window = msg(&env, base + 60 * US + 1);
    refused(env.post(&past_window, DAY, OPEN_KIND), &anchor("OutsideWindow"));
    println!("ok an earlier open replaces; the open window is [09:30, 09:31]");
}

#[test]
fn a_signer_pyth_does_not_trust_is_refused() {
    let mut env = Env::new();
    let stranger = SigningKey::from_bytes(&[8u8; 32]);
    let msg = sign(&stranger, nvda(&Equity::at(CLOSE as u64 * US - 1), CLOSE as u64 * US));
    refused(env.post(&msg, DAY, CLOSE_KIND), "NotTrustedSigner");
    assert!(env.print(DAY, CLOSE_KIND).is_none());
    println!("ok an untrusted signer is refused by Pyth's verifier");
}

#[test]
fn an_expired_signer_is_refused() {
    let mut env = Env::new();
    let key = env.signer.verifying_key().to_bytes();
    ok(env.trust(key, CLOSE), "expire the signer at the close");
    let msg = env.close_msg(&Equity::at(CLOSE as u64 * US - 1));
    refused(env.post(&msg, DAY, CLOSE_KIND), "NotTrustedSigner");
    println!("ok an expired signer is refused by Pyth's verifier");
}

#[test]
fn one_changed_byte_fails_the_signature() {
    let mut env = Env::new();
    let mut msg = env.close_msg(&Equity::at(CLOSE as u64 * US - 1));
    // flip one bit of the last feed's price, 20 bytes from the end
    let at = msg.len() - 20;
    msg[at] ^= 1;
    let r = env.post(&msg, DAY, CLOSE_KIND);
    match r {
        Err(f) => assert_eq!(
            f.err,
            TransactionError::InstructionError(1, InstructionError::Custom(2)),
            "the Ed25519 precompile (instruction 1) rejects the signature\n{}",
            f.meta.logs.join("\n")
        ),
        Ok(_) => panic!("a tampered message was accepted"),
    }
    println!("ok one changed byte fails the Ed25519 precompile");
}

#[test]
fn a_signature_over_one_message_cannot_vouch_for_another() {
    // The attack the instruction indices exist for. Pyth genuinely signed X.
    // The attacker puts X, with its signature, inside the Ed25519
    // instruction's own data — so the precompile passes — and posts Y: the
    // same bytes with the price changed, carrying X's signature. Every offset
    // lines up with where Y sits in the post, so only the check that the
    // signature was verified over *this* instruction's bytes stands between
    // Y and the chain.
    let mut env = Env::new();
    let ts = CLOSE as u64 * US - 1;
    let genuine = env.close_msg(&Equity::at(ts));
    let forged_payload = nvda(&Equity { price: 99_999_000_000, ..Equity::at(ts) }, ts + 150_000);
    let mut forged = Vec::new();
    SolanaMessage {
        payload: forged_payload,
        signature: genuine[4..68].try_into().unwrap(),
        public_key: genuine[68..100].try_into().unwrap(),
    }
    .serialize(&mut forged)
    .unwrap();
    assert_eq!(forged.len(), genuine.len());

    // header (2 + 7 × u16) is 16 bytes, so X minus its magic lands with the
    // signature at 16, the key at 80 and the payload at 114: the same
    // offsets Y has in the post.
    let size = u16::from_le_bytes(genuine[100..102].try_into().unwrap());
    let mut data = vec![1u8, 0u8];
    for v in [16u16, u16::MAX, 80, u16::MAX, 114, size, u16::MAX] {
        data.extend_from_slice(&v.to_le_bytes());
    }
    data.extend_from_slice(&genuine[4..]);

    // First line of defence: Pyth reads everything after the Ed25519 header
    // as 14-byte offset records, so an instruction carrying anything else is
    // refused before an offset is looked at.
    let unpadded = Instruction { program_id: ed25519_program::ID, accounts: vec![], data: data.clone() };
    let ixs = [cu_limit(400_000), unpadded, env.post_ix(&forged, DAY, CLOSE_KIND, 1)];
    refused(env.send_poster(&ixs), "InvalidEd25519InstructionDataLength");

    // Padded to a whole number of records, the attack gets past that and
    // meets the check that matters: the signature was verified over another
    // instruction's bytes.
    while (data.len() - 2) % 14 != 0 {
        data.push(0);
    }
    let vouching = Instruction { program_id: ed25519_program::ID, accounts: vec![], data };
    let ixs = [cu_limit(400_000), vouching, env.post_ix(&forged, DAY, CLOSE_KIND, 1)];
    refused(env.send_poster(&ixs), "InvalidInstructionIndex");
    assert!(env.print(DAY, CLOSE_KIND).is_none());
    println!("ok a signature over one message cannot vouch for another");
}

#[test]
fn an_ed25519_instruction_that_does_not_precede_the_post_is_refused() {
    let mut env = Env::new();
    let msg = env.close_msg(&Equity::at(CLOSE as u64 * US - 1));
    // point `ed25519_ix` at the post itself
    let ixs = [cu_limit(400_000), ed25519_ix(&msg, 2, 12), env.post_ix(&msg, DAY, CLOSE_KIND, 2)];
    refused(env.send_poster(&ixs), "Ed25519InstructionMustPrecedeCurrentInstruction");
    println!("ok the Ed25519 instruction must precede the post");
}

#[test]
fn the_post_works_without_a_compute_budget_instruction() {
    let mut env = Env::new();
    let msg = env.close_msg(&Equity::at(CLOSE as u64 * US - 1));
    let ixs = [ed25519_ix(&msg, 1, 12), env.post_ix(&msg, DAY, CLOSE_KIND, 0)];
    let meta = ok(env.send_poster(&ixs), "post at index 1");
    println!("ok the post fits the default budget: {} CU", meta.compute_units_consumed);
}

#[test]
fn each_rule_refuses_on_chain() {
    let mut env = Env::new();
    let ts = CLOSE as u64 * US - 1_000_000;
    let cases: Vec<(Vec<u8>, &str)> = vec![
        (sign(&env.signer, payload(ts, vec![(RR, simple(1, ts))])), "FeedMissing"),
        (env.close_msg(&Equity { session: MarketSession::PreMarket, ..Equity::at(ts) }), "NotRegularSession"),
        (env.close_msg(&Equity { session: MarketSession::PostMarket, ..Equity::at(ts) }), "NotRegularSession"),
        (env.close_msg(&Equity { publishers: 0, ..Equity::at(ts) }), "TooFewPublishers"),
        (env.close_msg(&Equity { conf: 56_015_001, ..Equity::at(ts) }), "ConfidenceTooWide"),
        (env.close_msg(&Equity { price: -5, ..Equity::at(ts) }), "NonPositivePrice"),
        (env.close_msg(&Equity::at(CLOSE as u64 * US + 1)), "OutsideWindow"),
        (env.close_msg(&Equity::at((CLOSE - 10) as u64 * US - 1)), "OutsideWindow"),
        (sign(&env.signer, nvda(&Equity::at(ts), ts - 1)), "FeedAfterMessage"),
        (
            sign(&env.signer, payload(ts, vec![(EQUITY, vec![P::Price(Price::from_mantissa(1).ok()), P::Exponent(-8)])])),
            "MissingProperty",
        ),
    ];
    for (msg, want) in cases {
        refused(env.post(&msg, DAY, CLOSE_KIND), &anchor(want));
    }
    assert!(env.print(DAY, CLOSE_KIND).is_none(), "no refused candidate leaves a print behind");
    println!("ok each rule refuses on chain, and a refusal leaves no account");
}

#[test]
fn a_price_dated_past_the_chain_clock_is_refused() {
    // A test signer can date a message anything; Pyth cannot sign a price it
    // has not produced. Either way a bell is not posted before it rings.
    let mut env = Env::new();
    let msg = env.close_msg(&Equity::at(CLOSE as u64 * US - 1)); // 15:59:59.999999
    env.set_time(CLOSE - 200);
    refused(env.post(&msg, DAY, CLOSE_KIND), &anchor("FeedFromTheFuture"));
    assert!(env.print(DAY, CLOSE_KIND).is_none());
    env.set_time(CLOSE - 100); // within the two-minute allowance for clock drift
    ok(env.post(&msg, DAY, CLOSE_KIND), "a price 100s ahead of a lagging clock");
    println!("ok a price dated past the chain's clock (+120s) is refused");
}

#[test]
fn no_bell_on_a_weekend_or_a_holiday() {
    let mut env = Env::new();
    let msg = env.close_msg(&Equity::at(CLOSE as u64 * US - 1));
    refused(env.post(&msg, SATURDAY, CLOSE_KIND), &anchor("NoBell"));
    refused(env.post(&msg, THANKSGIVING, CLOSE_KIND), &anchor("NoBell"));
    refused(env.post(&msg, DAY, 2), &anchor("BadKind"));
    // the right bytes for the wrong day are simply outside that day's window
    refused(env.post(&msg, DAY + 1, CLOSE_KIND), &anchor("OutsideWindow"));
    println!("ok no bell on a weekend or a holiday");
}

#[test]
fn the_deadline_closes_posting_and_opens_finalising() {
    let mut env = Env::new();
    let msg = env.close_msg(&Equity::at(CLOSE as u64 * US - 1));
    ok(env.post(&msg, DAY, CLOSE_KIND), "post");
    refused(env.finalize(DAY, CLOSE_KIND), &anchor("TooEarly"));

    env.set_time(CLOSE + 300);
    let later = env.close_msg(&Equity::at(CLOSE as u64 * US));
    refused(env.post(&later, DAY, CLOSE_KIND), &anchor("PostingClosed"));
    ok(env.finalize(DAY, CLOSE_KIND), "finalize at the deadline");
    let p = env.print(DAY, CLOSE_KIND).unwrap();
    assert_eq!((p.status, p.finalized_at), (FINAL, CLOSE + 300));

    refused(env.post(&later, DAY, CLOSE_KIND), &anchor("PrintClosed"));
    refused(env.finalize(DAY, CLOSE_KIND), &anchor("PrintClosed"));
    refused(env.mark_missing(DAY, CLOSE_KIND), "already in use");
    println!("ok the deadline closes posting; a final print cannot change");
}

#[test]
fn a_bell_nobody_posted_is_marked_missing_once() {
    let mut env = Env::new();
    refused(env.mark_missing(DAY, CLOSE_KIND), &anchor("TooEarly"));
    env.set_time(CLOSE + 299);
    refused(env.mark_missing(DAY, CLOSE_KIND), &anchor("TooEarly"));
    env.set_time(CLOSE + 300);
    ok(env.mark_missing(DAY, CLOSE_KIND), "mark missing");
    let p = env.print(DAY, CLOSE_KIND).unwrap();
    assert_eq!((p.status, p.bell_ts, p.posts, p.finalized_at), (MISSING, CLOSE, 0, CLOSE + 300));
    assert!(!p.equity.present);
    assert_eq!(p.equity.feed_id, EQUITY);
    assert_eq!(env.listing_counts(), (1, 1));

    refused(env.mark_missing(DAY, CLOSE_KIND), "already in use");
    let msg = env.close_msg(&Equity::at(CLOSE as u64 * US - 1));
    refused(env.post(&msg, DAY, CLOSE_KIND), &anchor("PrintClosed"));
    refused(env.finalize(DAY, CLOSE_KIND), &anchor("PrintClosed"));
    refused(env.mark_missing(SATURDAY, CLOSE_KIND), &anchor("NoBell"));
    println!("ok a bell nobody posted is marked missing, once");
}

#[test]
fn a_bell_passed_while_inactive_belongs_to_nobody() {
    let mut env = Env::new();
    ok(env.set_active(false), "deactivate");
    let msg = env.close_msg(&Equity::at(CLOSE as u64 * US - 1));
    refused(env.post(&msg, DAY, CLOSE_KIND), &anchor("ListingInactive"));

    // Back on a second after the close: that close was not this listing's,
    // so it can be neither posted nor marked missing.
    ok(env.set_active(true), "reactivate");
    refused(env.post(&msg, DAY, CLOSE_KIND), &anchor("NotListedAtBell"));
    env.set_time(CLOSE + 300);
    refused(env.mark_missing(DAY, CLOSE_KIND), &anchor("NotListedAtBell"));

    // The next bell is.
    let friday_close = CLOSE + 86_400;
    env.set_time(friday_close + 1);
    let friday = env.close_msg(&Equity::at(friday_close as u64 * US - 1));
    ok(env.post(&friday, DAY + 1, CLOSE_KIND), "Friday's close");
    println!("ok a bell passed while a listing was off belongs to nobody");
}

#[test]
fn a_new_listing_cannot_be_given_a_missed_past() {
    let mut env = Env::new();
    // Wednesday's close, long past its deadline, a day before NVDA was listed
    refused(env.mark_missing(DAY - 1, CLOSE_KIND), &anchor("NotListedAtBell"));
    refused(env.mark_missing(18_500, CLOSE_KIND), &anchor("NotListedAtBell"));
    assert_eq!(env.listing_counts(), (0, 0));
    println!("ok a listing registered today cannot be given years of missed bells");
}

#[test]
fn only_the_upgrade_authority_creates_the_config() {
    let mut env = Env::bare();
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 10_000_000_000).unwrap();
    let (storage, lazer) = (env.storage, env.lazer);
    refused(env.init_config_as(&stranger, lazer, storage, V1), &anchor("NotUpgradeAuthority"));
    let admin = env.admin.insecure_clone();
    refused(env.init_config_as(&admin, lazer, Keypair::new().pubkey(), V1), &anchor("WrongVerifierStorage"));
    refused(
        env.init_config_as(&admin, lazer, storage, Params { max_conf_bps: 5_000, ..V1 }),
        &anchor("BadParams"),
    );
    ok(env.init_config_as(&admin, lazer, storage, V1), "init");
    refused(env.init_config_as(&admin, lazer, storage, V1), "already in use");
    println!("ok only the upgrade authority creates the config, once");
}

#[test]
fn any_other_verifier_marks_the_config_simulated_and_cannot_forge() {
    let mut env = Env::bare();
    let memo = addr(MEMO);
    // A storage account at the memo program's ["storage"] PDA, owned by it,
    // so the config accepts memo as a "verifier".
    let storage = pda(&[b"storage"], &memo);
    env.svm
        .set_account(storage, solana_account::Account { lamports: 10_000_000, data: vec![0; 8], owner: memo, executable: false, rent_epoch: 0 })
        .unwrap();
    ok(env.init_config(memo), "init with memo as verifier");
    let cfg = env.svm.get_account(&env.config).unwrap();
    assert_eq!(cfg.data[8 + 2], 1, "simulated");

    ok(env.register("NVDA", [EQUITY, RR, TOKEN, INDEX]), "register");
    env.listing = pda(&[b"listing", &symbol("NVDA")], &env.bell);
    env.set_time(CLOSE + 1);
    let msg = env.close_msg(&Equity::at(CLOSE as u64 * US - 1));
    let r = env.post(&msg, DAY, CLOSE_KIND);
    assert!(r.is_err(), "a verifier that is not Pyth's cannot produce a print");
    assert!(env.print(DAY, CLOSE_KIND).is_none());
    println!("ok any other verifier is flagged simulated and cannot forge a print");
}
