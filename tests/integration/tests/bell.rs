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


use bell_integration::*;
use ed25519_dalek::SigningKey;
use pyth_lazer_protocol::{api::MarketSession, message::SolanaMessage, payload::PayloadPropertyValue as P, Price};
use solana_instruction::{error::InstructionError, Instruction};
use solana_keypair::Keypair;
use solana_sdk_ids::ed25519_program;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;

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
