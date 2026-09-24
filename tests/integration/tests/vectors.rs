//! Golden Pyth Pro messages, built by Pyth's own encoder.
//!
//! Every valid case below is a `PayloadData` serialised by `pyth-lazer-protocol`
//! 0.46.0 and wrapped by its `SolanaMessage`, signed by a fixed key. Its
//! expected fields are read from the `PayloadData` that went *in*, never from a
//! parser, so `programs/session-bell/src/lazer.rs` and `sdk/src/bell.ts` are
//! each held to Pyth's encoder rather than to each other.
//!
//! The malformed cases start from a valid encoding and break one thing each,
//! and name the error both parsers must return.
//!
//! Writes `tests/vectors/lazer.json`. Deterministic: Ed25519 signatures are,
//! and nothing here reads a clock, so a re-run changes nothing.

use byteorder::LE;
use ed25519_dalek::{Signer as _, SigningKey};
use pyth_lazer_protocol::{
    api::MarketSession,
    message::SolanaMessage,
    payload::{PayloadData, PayloadFeedData, PayloadPropertyValue as P},
    time::{DurationUs, TimestampUs},
    ChannelId, Price, PriceFeedId, Rate,
};
use serde_json::{json, Value};

const SOLANA_FORMAT_MAGIC: u32 = 2_182_742_457;
const PAYLOAD_FORMAT_MAGIC: u32 = 2_479_346_549;

fn key() -> SigningKey {
    SigningKey::from_bytes(&[42u8; 32])
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn price(m: i64) -> Option<Price> {
    Some(Price::from_mantissa(m).unwrap())
}

fn ts(us: u64) -> Option<TimestampUs> {
    Some(TimestampUs::from_micros(us))
}

fn encode(data: &PayloadData) -> Vec<u8> {
    let mut out = Vec::new();
    data.serialize::<LE>(&mut out).unwrap();
    out
}

fn wrap(payload: Vec<u8>) -> Vec<u8> {
    let k = key();
    let signature = k.sign(&payload).to_bytes();
    let m = SolanaMessage { payload, signature, public_key: k.verifying_key().to_bytes() };
    let mut out = Vec::new();
    m.serialize(&mut out).unwrap();
    out
}

fn payload(ts_us: u64, channel: ChannelId, feeds: Vec<(u32, Vec<P>)>) -> PayloadData {
    PayloadData {
        timestamp_us: TimestampUs::from_micros(ts_us),
        channel_id: channel,
        feeds: feeds
            .into_iter()
            .map(|(id, properties)| PayloadFeedData { feed_id: PriceFeedId(id), properties })
            .collect(),
    }
}

/// What a parser must read from a feed: straight from the properties that
/// were encoded. 64-bit values are strings, so JavaScript reads them exactly.
fn expect_feed(f: &PayloadFeedData) -> Value {
    let s = |v: Option<i64>| v.map(|x| Value::String(x.to_string())).unwrap_or(Value::Null);
    let mut e = json!({
        "feed_id": f.feed_id.0,
        "price": null, "best_bid": null, "best_ask": null, "publishers": null, "exponent": null,
        "confidence": null, "session": null, "ema_price": null, "ema_confidence": null, "feed_ts_us": null,
    });
    for p in &f.properties {
        let m = |x: &Option<Price>| s(x.map(|p| p.mantissa_i64()));
        match p {
            P::Price(x) => e["price"] = m(x),
            P::BestBidPrice(x) => e["best_bid"] = m(x),
            P::BestAskPrice(x) => e["best_ask"] = m(x),
            P::PublisherCount(n) => e["publishers"] = json!(n),
            P::Exponent(x) => e["exponent"] = json!(x),
            P::Confidence(x) => e["confidence"] = m(x),
            P::MarketSession(x) => e["session"] = json!(i16::from(*x)),
            P::EmaPrice(x) => e["ema_price"] = m(x),
            P::EmaConfidence(x) => e["ema_confidence"] = m(x),
            P::FeedUpdateTimestamp(x) => {
                e["feed_ts_us"] = x.map(|t| Value::String(t.as_micros().to_string())).unwrap_or(Value::Null)
            }
            // funding: read past, not reported
            P::FundingRate(_) | P::FundingTimestamp(_) | P::FundingRateInterval(_) => {}
        }
    }
    e
}

fn valid(name: &str, data: PayloadData) -> Value {
    let message = wrap(encode(&data));
    json!({
        "name": name,
        "message": hex(&message),
        "ok": true,
        "timestamp_us": data.timestamp_us.as_micros().to_string(),
        "channel": data.channel_id.0,
        "feeds": data.feeds.iter().map(expect_feed).collect::<Vec<_>>(),
    })
}

fn broken(name: &str, message: Vec<u8>, layer: &str, error: &str) -> Value {
    json!({ "name": name, "message": hex(&message), "ok": false, "layer": layer, "error": error })
}

fn equity(ts_us: u64) -> Vec<P> {
    vec![
        P::Price(price(22_406_000_000)),
        P::Confidence(price(1_100_000)),
        P::Exponent(-8),
        P::PublisherCount(9),
        P::MarketSession(MarketSession::Regular),
        P::FeedUpdateTimestamp(ts(ts_us)),
    ]
}

fn simple(m: i64, ts_us: u64) -> Vec<P> {
    vec![P::Price(price(m)), P::Exponent(-8), P::FeedUpdateTimestamp(ts(ts_us))]
}

/// The 24 September 2026 close, as one NVDA subscription delivers it.
fn nvda_close() -> PayloadData {
    let t = 1_790_279_999_800_000;
    payload(
        t + 150_000,
        ChannelId::FIXED_RATE_200,
        vec![
            (1314, equity(t)),
            (1832, simple(100_170_000, t + 100_000)),
            (1833, simple(22_441_000_000, t + 120_000)),
            (3188, simple(22_405_000_000, t + 140_000)),
        ],
    )
}

/// Re-sign a hand-edited payload, so only the payload is wrong.
fn resign(p: Vec<u8>) -> Vec<u8> {
    wrap(p)
}

#[test]
fn emit_lazer_vectors() {
    let mut cases = Vec::new();

    // ── what Pyth's encoder produces ──────────────────────────────────────
    cases.push(valid("nvda close: equity, redemption rate, token, 24/7 index", nvda_close()));
    cases.push(valid(
        "every property on one feed, funding included",
        payload(
            1_790_000_000_000_001,
            ChannelId::REAL_TIME,
            vec![(
                7,
                vec![
                    P::Price(price(-123_456)),
                    P::BestBidPrice(price(99)),
                    P::BestAskPrice(price(101)),
                    P::PublisherCount(65_535),
                    P::Exponent(-12),
                    P::Confidence(price(5)),
                    P::FundingRate(Some(Rate::from_mantissa(-42))),
                    P::FundingTimestamp(ts(1_790_000_000_000_000)),
                    P::FundingRateInterval(Some(DurationUs::from_micros(28_800_000_000))),
                    P::MarketSession(MarketSession::OverNight),
                    P::EmaPrice(price(100)),
                    P::EmaConfidence(price(3)),
                    P::FeedUpdateTimestamp(ts(1_789_999_999_999_999)),
                ],
            )],
        ),
    ));
    cases.push(valid(
        "absent optionals: no price, no confidence, no timestamp, no funding",
        payload(
            5,
            ChannelId::FIXED_RATE_1000,
            vec![(
                1314,
                vec![
                    P::Price(None),
                    P::BestBidPrice(None),
                    P::Confidence(None),
                    P::FundingRate(None),
                    P::FundingTimestamp(None),
                    P::FundingRateInterval(None),
                    P::EmaPrice(None),
                    P::FeedUpdateTimestamp(None),
                    P::MarketSession(MarketSession::Closed),
                ],
            )],
        ),
    ));
    cases.push(valid("no feeds at all", payload(1, ChannelId::FIXED_RATE_50, vec![])));
    cases.push(valid(
        "eight feeds, the most the program reads",
        payload(9, ChannelId::FIXED_RATE_200, (1..=8).map(|i| (i, simple(i as i64 * 1000, 8))).collect()),
    ));
    cases.push(valid(
        "each market session",
        payload(
            2,
            ChannelId::FIXED_RATE_200,
            [
                MarketSession::Regular,
                MarketSession::PreMarket,
                MarketSession::PostMarket,
                MarketSession::OverNight,
                MarketSession::Closed,
            ]
            .into_iter()
            .enumerate()
            .map(|(i, s)| (100 + i as u32, vec![P::MarketSession(s)]))
            .collect(),
        ),
    ));
    cases.push(valid(
        "extremes: i64 and u64 bounds, i16 bounds",
        payload(
            u64::MAX,
            ChannelId(255),
            vec![
                (u32::MAX, vec![P::Price(price(i64::MAX)), P::Exponent(i16::MAX), P::FeedUpdateTimestamp(ts(u64::MAX))]),
                (0, vec![P::Price(price(i64::MIN)), P::Exponent(i16::MIN), P::PublisherCount(0)]),
            ],
        ),
    ));
    cases.push(valid(
        "properties in reverse order",
        payload(
            3,
            ChannelId::FIXED_RATE_200,
            vec![(1314, equity(2).into_iter().rev().collect())],
        ),
    ));

    // ── one thing broken each ─────────────────────────────────────────────
    let good = encode(&nvda_close());
    let good_msg = wrap(good.clone());

    let mut p = good.clone();
    p.push(0);
    cases.push(broken("a byte after the last feed", resign(p), "payload", "TrailingBytes"));

    for cut in [3usize, 12, 14, 17, 20, 25, good.len() - 1] {
        cases.push(broken(
            &format!("payload cut to {cut} bytes"),
            resign(good[..cut].to_vec()),
            "payload",
            "Truncated",
        ));
    }

    let mut p = good.clone();
    p[0..4].copy_from_slice(&(PAYLOAD_FORMAT_MAGIC ^ 1).to_le_bytes());
    cases.push(broken("wrong payload magic", resign(p), "payload", "BadPayloadMagic"));

    cases.push(broken(
        "nine feeds, one more than the program reads",
        wrap(encode(&payload(9, ChannelId::FIXED_RATE_200, (1..=9).map(|i| (i, simple(1, 1))).collect()))),
        "payload",
        "TooManyFeeds",
    ));
    cases.push(broken(
        "the same feed twice",
        wrap(encode(&payload(9, ChannelId::FIXED_RATE_200, vec![(1314, simple(1, 1)), (1314, simple(2, 2))]))),
        "payload",
        "DuplicateFeed",
    ));
    cases.push(broken(
        "the same property twice",
        wrap(encode(&payload(9, ChannelId::FIXED_RATE_200, vec![(1314, vec![P::Exponent(-8), P::Exponent(-5)])]))),
        "payload",
        "DuplicateProperty",
    ));

    // Property ids sit right after the feed header: magic 4, ts 8, channel 1,
    // count 1, feed id 4, property count 1.
    let first_prop = 4 + 8 + 1 + 1 + 4 + 1;
    let mut p = good.clone();
    assert_eq!(p[first_prop], 0, "the first equity property is the price");
    p[first_prop] = 13;
    cases.push(broken("a property id Pyth has not defined", resign(p), "payload", "UnknownProperty"));

    let session_only = encode(&payload(1, ChannelId::FIXED_RATE_200, vec![(1, vec![P::MarketSession(MarketSession::Regular)])]));
    let mut p = session_only.clone();
    let at = p.len() - 2;
    p[at] = 5;
    cases.push(broken("a market session outside 0..=4", resign(p), "payload", "BadSession"));

    let ts_only = encode(&payload(1, ChannelId::FIXED_RATE_200, vec![(1, vec![P::FeedUpdateTimestamp(ts(77))])]));
    let mut p = ts_only.clone();
    let at = p.len() - 9;
    assert_eq!(p[at], 1, "present flag");
    p[at] = 2;
    cases.push(broken("an optional's present flag that is neither 0 nor 1", resign(p), "payload", "BadFlag"));

    let mut m = good_msg.clone();
    m[0..4].copy_from_slice(&(SOLANA_FORMAT_MAGIC ^ 1).to_le_bytes());
    cases.push(broken("wrong message magic", m, "message", "BadFormatMagic"));

    let mut m = good_msg.clone();
    m.push(0);
    cases.push(broken("a byte after the payload", m, "message", "BadLength"));

    let m = good_msg[..good_msg.len() - 1].to_vec();
    cases.push(broken("a message one byte short of its declared length", m, "message", "BadLength"));

    cases.push(broken("a message cut inside its header", good_msg[..60].to_vec(), "message", "Truncated"));

    // ── the Ed25519 instruction a poster puts in front of the post ────────
    // Pyth's `Ed25519SignatureOffsets::new(message, 2, 12)` and
    // `ed25519_program_args`: the message at byte 12 of instruction 2.
    let (start, ix) = (12u16, 2u16);
    let sig = start + 4;
    let pk = sig + 64;
    let size_at = pk + 32;
    let data_at = size_at + 2;
    let size = u16::from_le_bytes(good_msg[100..102].try_into().unwrap());
    let mut ed = vec![1u8, 0u8];
    for v in [sig, ix, pk, ix, data_at, size, ix] {
        ed.extend_from_slice(&v.to_le_bytes());
    }

    let doc = json!({
        "note": "Generated by `cargo test --test vectors` in tests/integration, with pyth-lazer-protocol 0.46.0's encoder. Do not edit.",
        "signer": hex(&key().verifying_key().to_bytes()),
        "cases": cases,
        "ed25519": {
            "message_case": 0,
            "instruction_index": ix,
            "starting_offset": start,
            "data": hex(&ed),
        },
    });
    let text = serde_json::to_string_pretty(&doc).unwrap() + "\n";
    std::fs::write("../vectors/lazer.json", text).unwrap();
    println!("ok wrote {} lazer vectors", doc["cases"].as_array().unwrap().len());
}
