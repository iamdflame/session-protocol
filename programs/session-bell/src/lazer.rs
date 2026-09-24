//! Pyth Pro messages, read the way Pyth writes them.
//!
//! Pyth Pro (formerly Lazer) delivers prices as signed binary messages. The
//! Solana format is
//!
//! ```text
//!   u32 LE  2182742457            format magic
//!   [u8;64] Ed25519 signature
//!   [u8;32] signer public key
//!   u16 LE  payload length
//!   payload
//! ```
//!
//! and the payload, little-endian throughout for Solana, is
//!
//! ```text
//!   u32  2479346549               payload magic
//!   u64  timestamp_us             when Pyth produced this message
//!   u8   channel
//!   u8   feed count
//!   per feed:
//!     u32  feed id (Pyth Pro's numeric id, e.g. 1314 = Equity.US.NVDA/USD)
//!     u8   property count
//!     per property: u8 id, then its value
//! ```
//!
//! Property ids and value encodings are Pyth's, from `pyth-lazer-protocol`
//! 0.46.0 (`PayloadData::serialize`), and `tests/vectors/lazer.json` pins this
//! parser to that encoder byte for byte:
//!
//! | id | property              | value                                |
//! |----|-----------------------|--------------------------------------|
//! | 0  | price                 | i64, 0 = none                        |
//! | 1  | best bid              | i64, 0 = none                        |
//! | 2  | best ask              | i64, 0 = none                        |
//! | 3  | publisher count       | u16                                  |
//! | 4  | exponent              | i16                                  |
//! | 5  | confidence            | i64, 0 = none                        |
//! | 6  | funding rate          | u8 present flag, then i64 if present |
//! | 7  | funding timestamp     | u8 present flag, then u64 if present |
//! | 8  | funding interval      | u8 present flag, then u64 if present |
//! | 9  | market session        | i16: 0 regular, 1 pre-market, 2 post-market, 3 overnight, 4 closed |
//! | 10 | EMA price             | i64, 0 = none                        |
//! | 11 | EMA confidence        | i64, 0 = none                        |
//! | 12 | feed update timestamp | u8 present flag, then u64 if present |
//!
//! Nothing here checks a signature. The bytes this parses are authenticated
//! by the Pyth Lazer program before the handler reads them; this module only
//! refuses anything it cannot read exactly, because the input is hostile and
//! a half-read price is worse than none.

pub const SOLANA_FORMAT_MAGIC: u32 = 2_182_742_457;
pub const PAYLOAD_FORMAT_MAGIC: u32 = 2_479_346_549;
pub const SIGNATURE_LEN: usize = 64;
pub const PUBKEY_LEN: usize = 32;
/// Magic, signature, public key and the payload length.
pub const MESSAGE_HEADER_LEN: usize = 4 + SIGNATURE_LEN + PUBKEY_LEN + 2;
/// A subscription per listing carries four feeds (equity, redemption rate,
/// token, 24/7 index). Twice that is room without being a place to hide work.
pub const MAX_FEEDS: usize = 8;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LazerError {
    /// The bytes ran out before the structure did.
    Truncated,
    /// Not a Solana-format Pyth Pro message.
    BadFormatMagic,
    /// The declared payload length does not match what follows it.
    BadLength,
    /// The payload does not start with Pyth's payload magic.
    BadPayloadMagic,
    TooManyFeeds,
    /// The same feed appears twice in one payload. Which one is the price?
    DuplicateFeed,
    /// The same property appears twice in one feed.
    DuplicateProperty,
    /// A property id this parser does not know. Pyth adding a property is a
    /// reason to update the parser, not to guess at its width.
    UnknownProperty(u8),
    /// A market session value outside 0..=4.
    BadSession(i16),
    /// A present flag that is neither 0 nor 1.
    BadFlag(u8),
    /// Bytes after the last feed.
    TrailingBytes,
}

/// A Solana-format Pyth Pro message, split into its parts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Message<'a> {
    pub signature: &'a [u8],
    pub public_key: [u8; 32],
    pub payload: &'a [u8],
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MarketSession {
    Regular,
    PreMarket,
    PostMarket,
    OverNight,
    Closed,
}

impl MarketSession {
    pub fn from_wire(v: i16) -> Result<Self, LazerError> {
        Ok(match v {
            0 => Self::Regular,
            1 => Self::PreMarket,
            2 => Self::PostMarket,
            3 => Self::OverNight,
            4 => Self::Closed,
            other => return Err(LazerError::BadSession(other)),
        })
    }

    pub fn to_wire(self) -> i16 {
        match self {
            Self::Regular => 0,
            Self::PreMarket => 1,
            Self::PostMarket => 2,
            Self::OverNight => 3,
            Self::Closed => 4,
        }
    }
}

/// One feed's properties, each present only if the subscription asked for it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FeedUpdate {
    pub feed_id: u32,
    pub price: Option<i64>,
    pub best_bid: Option<i64>,
    pub best_ask: Option<i64>,
    pub publishers: Option<u16>,
    pub exponent: Option<i16>,
    pub confidence: Option<i64>,
    pub session: Option<MarketSession>,
    pub ema_price: Option<i64>,
    pub ema_confidence: Option<i64>,
    /// When Pyth last generated this feed's price. Since March 2026 a feed
    /// whose market is shut carries its last price forward, so this — not
    /// the message timestamp — is when the price is *from*.
    pub feed_ts_us: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Payload {
    pub timestamp_us: u64,
    pub channel: u8,
    pub count: usize,
    pub feeds: [FeedUpdate; MAX_FEEDS],
}

impl Payload {
    pub fn feed(&self, id: u32) -> Option<&FeedUpdate> {
        self.feeds[..self.count].iter().find(|f| f.feed_id == id)
    }
}

struct Reader<'a> {
    d: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], LazerError> {
        let end = self.at.checked_add(n).ok_or(LazerError::Truncated)?;
        let s = self.d.get(self.at..end).ok_or(LazerError::Truncated)?;
        self.at = end;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, LazerError> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, LazerError> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().map_err(|_| LazerError::Truncated)?))
    }
    fn i16(&mut self) -> Result<i16, LazerError> {
        Ok(i16::from_le_bytes(self.take(2)?.try_into().map_err(|_| LazerError::Truncated)?))
    }
    fn u32(&mut self) -> Result<u32, LazerError> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().map_err(|_| LazerError::Truncated)?))
    }
    fn u64(&mut self) -> Result<u64, LazerError> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().map_err(|_| LazerError::Truncated)?))
    }
    fn i64(&mut self) -> Result<i64, LazerError> {
        Ok(i64::from_le_bytes(self.take(8)?.try_into().map_err(|_| LazerError::Truncated)?))
    }
    /// Pyth's `Option<Price>`: a mantissa where zero means absent.
    fn nonzero_i64(&mut self) -> Result<Option<i64>, LazerError> {
        let v = self.i64()?;
        Ok(if v == 0 { None } else { Some(v) })
    }
    fn flag(&mut self) -> Result<bool, LazerError> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            other => Err(LazerError::BadFlag(other)),
        }
    }
    fn flagged_u64(&mut self) -> Result<Option<u64>, LazerError> {
        Ok(if self.flag()? { Some(self.u64()?) } else { None })
    }
    fn flagged_i64(&mut self) -> Result<Option<i64>, LazerError> {
        Ok(if self.flag()? { Some(self.i64()?) } else { None })
    }
    fn done(&self) -> bool {
        self.at == self.d.len()
    }
}

/// Split a Solana-format message. The payload length must account for every
/// byte after the header, exactly.
pub fn parse_message(data: &[u8]) -> Result<Message<'_>, LazerError> {
    let mut r = Reader { d: data, at: 0 };
    if r.u32()? != SOLANA_FORMAT_MAGIC {
        return Err(LazerError::BadFormatMagic);
    }
    let signature = r.take(SIGNATURE_LEN)?;
    let mut public_key = [0u8; 32];
    public_key.copy_from_slice(r.take(PUBKEY_LEN)?);
    let len = r.u16()? as usize;
    if data.len() != MESSAGE_HEADER_LEN + len {
        return Err(LazerError::BadLength);
    }
    let payload = r.take(len)?;
    Ok(Message { signature, public_key, payload })
}

/// Read a payload, refusing anything it cannot account for completely.
pub fn parse_payload(data: &[u8]) -> Result<Payload, LazerError> {
    let mut r = Reader { d: data, at: 0 };
    if r.u32()? != PAYLOAD_FORMAT_MAGIC {
        return Err(LazerError::BadPayloadMagic);
    }
    let timestamp_us = r.u64()?;
    let channel = r.u8()?;
    let count = r.u8()? as usize;
    if count > MAX_FEEDS {
        return Err(LazerError::TooManyFeeds);
    }
    let mut feeds = [FeedUpdate::default(); MAX_FEEDS];
    for i in 0..count {
        let feed_id = r.u32()?;
        if feeds[..i].iter().any(|f| f.feed_id == feed_id) {
            return Err(LazerError::DuplicateFeed);
        }
        let mut f = FeedUpdate { feed_id, ..FeedUpdate::default() };
        let props = r.u8()?;
        let mut seen: u16 = 0;
        for _ in 0..props {
            let id = r.u8()?;
            if id > 12 {
                return Err(LazerError::UnknownProperty(id));
            }
            let bit = 1u16 << id;
            if seen & bit != 0 {
                return Err(LazerError::DuplicateProperty);
            }
            seen |= bit;
            match id {
                0 => f.price = r.nonzero_i64()?,
                1 => f.best_bid = r.nonzero_i64()?,
                2 => f.best_ask = r.nonzero_i64()?,
                3 => f.publishers = Some(r.u16()?),
                4 => f.exponent = Some(r.i16()?),
                5 => f.confidence = r.nonzero_i64()?,
                // Funding is for perpetuals. Read so the cursor stays exact;
                // nothing a bell settles on uses it.
                6 => {
                    r.flagged_i64()?;
                }
                7 | 8 => {
                    r.flagged_u64()?;
                }
                9 => f.session = Some(MarketSession::from_wire(r.i16()?)?),
                10 => f.ema_price = r.nonzero_i64()?,
                11 => f.ema_confidence = r.nonzero_i64()?,
                12 => f.feed_ts_us = r.flagged_u64()?,
                _ => unreachable!("ids above 12 are refused before the match"),
            }
        }
        feeds[i] = f;
    }
    if !r.done() {
        return Err(LazerError::TrailingBytes);
    }
    Ok(Payload { timestamp_us, channel, count, feeds })
}

/* ── an encoder, for tests and for building fixtures ─────────────────────── */

/// What a feed contributes to an encoded payload, in Pyth's property order.
#[cfg(test)]
pub fn encode_feed(out: &mut Vec<u8>, f: &FeedUpdate) {
    let mut props: Vec<(u8, Vec<u8>)> = Vec::new();
    let opt = |v: Option<i64>| v.unwrap_or(0).to_le_bytes().to_vec();
    if f.price.is_some() { props.push((0, opt(f.price))); }
    if f.best_bid.is_some() { props.push((1, opt(f.best_bid))); }
    if f.best_ask.is_some() { props.push((2, opt(f.best_ask))); }
    if let Some(p) = f.publishers { props.push((3, p.to_le_bytes().to_vec())); }
    if let Some(e) = f.exponent { props.push((4, e.to_le_bytes().to_vec())); }
    if f.confidence.is_some() { props.push((5, opt(f.confidence))); }
    if let Some(s) = f.session { props.push((9, s.to_wire().to_le_bytes().to_vec())); }
    if f.ema_price.is_some() { props.push((10, opt(f.ema_price))); }
    if f.ema_confidence.is_some() { props.push((11, opt(f.ema_confidence))); }
    if let Some(t) = f.feed_ts_us {
        let mut v = vec![1u8];
        v.extend_from_slice(&t.to_le_bytes());
        props.push((12, v));
    }
    out.extend_from_slice(&f.feed_id.to_le_bytes());
    out.push(props.len() as u8);
    for (id, v) in props {
        out.push(id);
        out.extend_from_slice(&v);
    }
}

#[cfg(test)]
pub fn encode_payload(timestamp_us: u64, channel: u8, feeds: &[FeedUpdate]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&PAYLOAD_FORMAT_MAGIC.to_le_bytes());
    out.extend_from_slice(&timestamp_us.to_le_bytes());
    out.push(channel);
    out.push(feeds.len() as u8);
    for f in feeds {
        encode_feed(&mut out, f);
    }
    out
}

/// Wrap a payload as a Solana-format message with the given signature bytes.
#[cfg(test)]
pub fn encode_message(signature: &[u8; 64], public_key: &[u8; 32], payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(MESSAGE_HEADER_LEN + payload.len());
    out.extend_from_slice(&SOLANA_FORMAT_MAGIC.to_le_bytes());
    out.extend_from_slice(signature);
    out.extend_from_slice(public_key);
    out.extend_from_slice(&(payload.len() as u16).to_le_bytes());
    out.extend_from_slice(payload);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn nvda(ts: u64) -> FeedUpdate {
        FeedUpdate {
            feed_id: 1314,
            price: Some(22_406_000_000),
            confidence: Some(1_100_000),
            exponent: Some(-8),
            publishers: Some(9),
            session: Some(MarketSession::Regular),
            feed_ts_us: Some(ts),
            ..FeedUpdate::default()
        }
    }

    #[test]
    fn round_trips_a_bell_payload() {
        let feeds = [
            nvda(1_790_000_000_000_000),
            FeedUpdate { feed_id: 1832, price: Some(100_000_000), exponent: Some(-8), ..FeedUpdate::default() },
        ];
        let raw = encode_payload(1_790_000_000_200_000, 1, &feeds);
        let p = parse_payload(&raw).unwrap();
        assert_eq!(p.timestamp_us, 1_790_000_000_200_000);
        assert_eq!(p.channel, 1);
        assert_eq!(p.count, 2);
        assert_eq!(*p.feed(1314).unwrap(), feeds[0]);
        assert_eq!(*p.feed(1832).unwrap(), feeds[1]);
        assert!(p.feed(1833).is_none());
    }

    #[test]
    fn a_message_splits_into_its_parts_and_its_length_must_be_exact() {
        let payload = encode_payload(5, 1, &[nvda(4)]);
        let msg = encode_message(&[7u8; 64], &[9u8; 32], &payload);
        let m = parse_message(&msg).unwrap();
        assert_eq!(m.signature, &[7u8; 64][..]);
        assert_eq!(m.public_key, [9u8; 32]);
        assert_eq!(m.payload, &payload[..]);

        let mut long = msg.clone();
        long.push(0);
        assert_eq!(parse_message(&long), Err(LazerError::BadLength));
        assert_eq!(parse_message(&msg[..msg.len() - 1]), Err(LazerError::BadLength));
        let mut wrong = msg.clone();
        wrong[0] ^= 1;
        assert_eq!(parse_message(&wrong), Err(LazerError::BadFormatMagic));
    }

    #[test]
    fn zero_means_absent_for_prices_and_confidence() {
        let f = FeedUpdate { feed_id: 1, price: Some(0), confidence: Some(0), ..FeedUpdate::default() };
        let raw = encode_payload(1, 1, &[f]);
        let p = parse_payload(&raw).unwrap();
        assert_eq!(p.feed(1).unwrap().price, None);
        assert_eq!(p.feed(1).unwrap().confidence, None);
    }

    #[test]
    fn refuses_what_it_cannot_account_for() {
        let good = encode_payload(1, 1, &[nvda(1)]);

        let mut trailing = good.clone();
        trailing.push(0);
        assert_eq!(parse_payload(&trailing), Err(LazerError::TrailingBytes));

        let mut magic = good.clone();
        magic[3] ^= 0x80;
        assert_eq!(parse_payload(&magic), Err(LazerError::BadPayloadMagic));

        // an unknown property id: rewrite the first property id to 13
        let mut unknown = good.clone();
        let first_prop = 4 + 8 + 1 + 1 + 4 + 1;
        unknown[first_prop] = 13;
        assert_eq!(parse_payload(&unknown), Err(LazerError::UnknownProperty(13)));

        let dup = encode_payload(1, 1, &[nvda(1), nvda(2)]);
        assert_eq!(parse_payload(&dup), Err(LazerError::DuplicateFeed));

        let mut many = Vec::new();
        many.extend_from_slice(&PAYLOAD_FORMAT_MAGIC.to_le_bytes());
        many.extend_from_slice(&1u64.to_le_bytes());
        many.push(1);
        many.push((MAX_FEEDS + 1) as u8);
        assert_eq!(parse_payload(&many), Err(LazerError::TooManyFeeds));
    }

    #[test]
    fn a_session_outside_the_five_is_refused() {
        let mut raw = encode_payload(1, 1, &[FeedUpdate { feed_id: 1, session: Some(MarketSession::Closed), ..FeedUpdate::default() }]);
        let at = raw.len() - 2;
        raw[at] = 5;
        assert_eq!(parse_payload(&raw), Err(LazerError::BadSession(5)));
    }

    #[test]
    fn funding_properties_are_read_and_skipped_exactly() {
        // hand-built: one feed with funding rate (present), funding timestamp
        // (absent), funding interval (present), then a price
        let mut raw = Vec::new();
        raw.extend_from_slice(&PAYLOAD_FORMAT_MAGIC.to_le_bytes());
        raw.extend_from_slice(&42u64.to_le_bytes());
        raw.push(1);
        raw.push(1);
        raw.extend_from_slice(&7u32.to_le_bytes());
        raw.push(4);
        raw.push(6); raw.push(1); raw.extend_from_slice(&(-5i64).to_le_bytes());
        raw.push(7); raw.push(0);
        raw.push(8); raw.push(1); raw.extend_from_slice(&3_600_000_000u64.to_le_bytes());
        raw.push(0); raw.extend_from_slice(&123i64.to_le_bytes());
        let p = parse_payload(&raw).unwrap();
        assert_eq!(p.feed(7).unwrap().price, Some(123));

        let mut bad_flag = raw.clone();
        let flag_at = 4 + 8 + 1 + 1 + 4 + 1 + 1;
        bad_flag[flag_at] = 2;
        assert_eq!(parse_payload(&bad_flag), Err(LazerError::BadFlag(2)));
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(4000))]

        /// The input is attacker-chosen. It must never panic.
        #[test]
        fn never_panics(raw in proptest::collection::vec(any::<u8>(), 0..600)) {
            let _ = parse_payload(&raw);
            let _ = parse_message(&raw);
        }

        /// With both magics right, the rest is still hostile.
        #[test]
        fn never_panics_behind_valid_magics(tail in proptest::collection::vec(any::<u8>(), 0..400)) {
            let mut raw = PAYLOAD_FORMAT_MAGIC.to_le_bytes().to_vec();
            raw.extend_from_slice(&tail);
            let _ = parse_payload(&raw);
        }

        /// Every proper prefix of a valid payload is refused: a price is read
        /// whole or not at all.
        #[test]
        fn every_truncation_is_refused(cut in 0usize..200) {
            let good = encode_payload(9, 1, &[nvda(8), FeedUpdate { feed_id: 1832, price: Some(1), exponent: Some(-8), ..FeedUpdate::default() }]);
            if cut < good.len() {
                prop_assert!(parse_payload(&good[..cut]).is_err());
            }
        }

        /// Whatever fields a feed carries, encoding and parsing agree.
        #[test]
        fn encode_then_parse_is_identity(
            price in any::<i64>(), conf in any::<i64>(), expo in any::<i16>(),
            pubs in any::<u16>(), sess in 0i16..5, ts in any::<u64>(), msg_ts in any::<u64>(),
            with_price in any::<bool>(), with_ts in any::<bool>(),
        ) {
            let f = FeedUpdate {
                feed_id: 1314,
                price: if with_price && price != 0 { Some(price) } else { None },
                confidence: if conf != 0 { Some(conf) } else { None },
                exponent: Some(expo),
                publishers: Some(pubs),
                session: Some(MarketSession::from_wire(sess).unwrap()),
                feed_ts_us: if with_ts { Some(ts) } else { None },
                ..FeedUpdate::default()
            };
            let raw = encode_payload(msg_ts, 1, &[f]);
            let p = parse_payload(&raw).unwrap();
            prop_assert_eq!(*p.feed(1314).unwrap(), f);
            prop_assert_eq!(p.timestamp_us, msg_ts);
        }
    }
}
