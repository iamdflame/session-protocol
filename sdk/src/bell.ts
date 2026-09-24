/* ───────────────────────────────────────────────────────────────────────────
   The bell: Pyth Pro prints at the NYSE open and close.

   Everything a client needs to read and write programs/session-bell: its
   addresses, the rule's bell times, the Pyth Pro message codec, the Ed25519
   instruction Pyth's verifier expects, account decoders and instruction
   builders.

   It runs in a browser as well as in Node: no Buffer, no node:crypto. What it
   precomputes is pinned by a test — the discriminators by
   tests/bell.test.ts, the print layout by tests/vectors/print-account.json
   (written by the program's own serializer), the codec by
   tests/vectors/lazer.json (written by Pyth's own encoder), and the bell
   times by tests/vectors/bells.json (written by the program's rules.rs).
   ─────────────────────────────────────────────────────────────────────────── */

import {
  ComputeBudgetProgram, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction,
} from '@solana/web3.js';
import { civilFromDays, earlyCloses, etOffset, holidays, isDST, SEC_PER_DAY, weekdayFromDays } from './calendar.ts';

export const BELL_PROGRAM_ID = new PublicKey('BeLLKXJwhSH6YXYQLc8xLd11GxJUvoaT1h9zCadymJv4');
/** Pyth's Lazer (Pyth Pro) verifier: one address on mainnet and devnet. */
export const PYTH_LAZER_PROGRAM_ID = new PublicKey('pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt');
/** Its `["storage"]` PDA, where the trusted signers and the fee treasury live. */
export const PYTH_LAZER_STORAGE = new PublicKey('3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL');
export const ED25519_PROGRAM_ID = new PublicKey('Ed25519SigVerify111111111111111111111111111');
export const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

/** `sha256("global:<name>")[..8]`, recomputed by tests/bell.test.ts. */
export const BELL_DISCRIMINATOR: Record<string, number[]> = {
  init_config:        [23, 235, 115, 232, 168, 96, 1, 231],
  set_params:         [27, 234, 178, 52, 147, 2, 187, 141],
  set_verifier:       [186, 247, 191, 131, 148, 158, 213, 63],
  transfer_admin:     [42, 242, 66, 106, 228, 10, 111, 156],
  accept_admin:       [112, 42, 45, 90, 116, 181, 13, 170],
  register_listing:   [52, 194, 155, 208, 215, 44, 148, 233],
  set_listing_active: [197, 68, 14, 217, 62, 57, 28, 145],
  post_print:         [61, 242, 59, 14, 220, 67, 46, 51],
  finalize_print:     [53, 176, 173, 19, 37, 140, 101, 49],
  mark_missing:       [72, 183, 147, 73, 249, 115, 228, 213],
};

/** The verifier's own instructions: Pyth's Lazer program, or a copy of it. */
export const LAZER_DISCRIMINATOR: Record<'initialize' | 'update' | 'verify_message', number[]> = {
  initialize:     [175, 175, 109, 31, 13, 152, 155, 237],
  update:         [219, 200, 88, 176, 158, 63, 253, 127],
  verify_message: [180, 193, 120, 55, 189, 135, 203, 83],
};

/** `sha256("account:<Name>")[..8]`. `Storage` is the Lazer program's. */
export const BELL_ACCOUNT: Record<'BellConfig' | 'Listing' | 'Print' | 'Storage', number[]> = {
  BellConfig: [232, 147, 157, 246, 86, 251, 241, 165],
  Listing:    [218, 32, 50, 73, 43, 134, 26, 58],
  Print:      [112, 154, 148, 62, 26, 67, 88, 141],
  Storage:    [209, 117, 255, 185, 196, 175, 68, 9],
};

export const BELL_VERSION = 1;
export const KIND = { open: 0, close: 1 } as const;
export type BellKind = keyof typeof KIND;
export const kindName = (k: number): BellKind => (k === 0 ? 'open' : 'close');

export const STATUS = ['provisional', 'final', 'missing'] as const;
export type PrintStatus = (typeof STATUS)[number];

export const FLAG_SIMULATED = 1;
export const FLAG_DIVERGENCE_KNOWN = 2;
export const FLAG_DIVERGENT = 4;

export const SESSION = ['regular', 'preMarket', 'postMarket', 'overNight', 'closed'] as const;
/** A feed the message did not report a session for. */
export const SESSION_UNREPORTED = 255;

/* ── bytes ───────────────────────────────────────────────────────────────── */

const u8 = (v: number) => Uint8Array.of(v & 0xff);
const u16 = (v: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b; };
const u32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const i16 = (v: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, v, true); return b; };
const u64 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b; };
const i64 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, v, true); return b; };
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const disc = (name: string) => Uint8Array.from(BELL_DISCRIMINATOR[name]);

/* ── the rule's calendar (rules.rs) ──────────────────────────────────────── */

/** 2020-01-01 and 2200-01-01. Outside them the program says there is no bell. */
export const MIN_DAY = 18_262;
export const MAX_DAY = 84_006;

/** `session_core::calendar::day_session_bounds`: UTC seconds of the open and
 *  close of an Eastern-time day, or null if it is not a trading day. */
export function daySessionBounds(day: number): [number, number] | null {
  const w = weekdayFromDays(day);
  const { y } = civilFromDays(day);
  if (w === 0 || w === 6 || holidays(y).has(day)) return null;
  const closeSec = earlyCloses(y).has(day) ? 13 * 3600 : 16 * 3600;
  // A midday probe: DST flips at 02:00 on a Sunday and trading days are weekdays.
  const probe = day * SEC_PER_DAY + 12 * 3600 + 5 * 3600;
  const off = isDST(probe) ? -4 * 3600 : -5 * 3600;
  return [day * SEC_PER_DAY + 9 * 3600 + 1800 - off, day * SEC_PER_DAY + closeSec - off];
}

/** `rules::bell_ts`: the bell in unix seconds, or null when there is none. */
export function bellTs(day: number, kind: BellKind): number | null {
  if (!Number.isInteger(day) || day < MIN_DAY || day >= MAX_DAY) return null;
  const b = daySessionBounds(day);
  return b ? (kind === 'open' ? b[0] : b[1]) : null;
}

/** The Eastern-time day a unix second falls on. */
export const etDay = (ts: number): number => Math.floor((ts + etOffset(ts)) / SEC_PER_DAY);

export interface BellParams {
  minPublishers: number;
  maxConfBps: number;
  closeLeadSecs: number;
  openWindowSecs: number;
  finalizeAfterSecs: number;
  maxDivergenceBps: number;
  methodVersion: number;
}

/** Method v1, `Params::V1` in state.rs. */
export const PARAMS_V1: BellParams = {
  minPublishers: 1, maxConfBps: 25, closeLeadSecs: 10, openWindowSecs: 60,
  finalizeAfterSecs: 300, maxDivergenceBps: 300, methodVersion: 1,
};

/** `rules::window`: inclusive microsecond bounds on the feed timestamp. */
export function bellWindow(bell: number, kind: BellKind, p: BellParams = PARAMS_V1): { startUs: bigint; endUs: bigint } {
  const b = BigInt(bell) * 1_000_000n;
  return kind === 'close'
    ? { startUs: b - BigInt(p.closeLeadSecs) * 1_000_000n, endUs: b }
    : { startUs: b, endUs: b + BigInt(p.openWindowSecs) * 1_000_000n };
}

/** `rules::deadline`: posting closes, and freezing opens, at this second. */
export function bellDeadline(bell: number, kind: BellKind, p: BellParams = PARAMS_V1): number {
  return (kind === 'close' ? bell : bell + p.openWindowSecs) + p.finalizeAfterSecs;
}

/** Why a candidate is not the bell price: the names `rules::Reject` maps to. */
export type BellReject =
  | 'MissingProperty' | 'NonPositivePrice' | 'BadExponent' | 'TooFewPublishers'
  | 'NotRegularSession' | 'ConfidenceTooWide' | 'OutsideWindow' | 'FeedAfterMessage';

/** `rules::accept`, so a poster never pays to send what the program refuses. */
export function bellAccept(
  f: LazerFeed, messageTsUs: bigint, w: { startUs: bigint; endUs: bigint }, p: BellParams = PARAMS_V1,
): BellReject | null {
  if (f.price === null) return 'MissingProperty';
  if (f.price <= 0n) return 'NonPositivePrice';
  if (f.exponent === null) return 'MissingProperty';
  if (f.exponent < -18 || f.exponent > 12) return 'BadExponent';
  if (f.publishers === null) return 'MissingProperty';
  if (f.publishers < p.minPublishers) return 'TooFewPublishers';
  if (f.session === null) return 'MissingProperty';
  if (f.session !== 0) return 'NotRegularSession';
  if (f.confidence === null || f.confidence <= 0n) return 'MissingProperty';
  if (f.confidence * 10_000n > BigInt(p.maxConfBps) * f.price) return 'ConfidenceTooWide';
  if (f.feedTsUs === null) return 'MissingProperty';
  if (f.feedTsUs < w.startUs || f.feedTsUs > w.endUs) return 'OutsideWindow';
  if (messageTsUs < f.feedTsUs) return 'FeedAfterMessage';
  return null;
}

/** `rules::better`: strict, so an equal timestamp never replaces. */
export const bellBetter = (kind: BellKind, oldTsUs: bigint, newTsUs: bigint): boolean =>
  kind === 'close' ? newTsUs > oldTsUs : newTsUs < oldTsUs;

export function encodeBellParams(p: BellParams): Uint8Array {
  return concat(
    u16(p.minPublishers), u16(p.maxConfBps), u32(p.closeLeadSecs), u32(p.openWindowSecs),
    u32(p.finalizeAfterSecs), u16(p.maxDivergenceBps), u16(p.methodVersion),
  );
}

/* ── addresses ───────────────────────────────────────────────────────────── */

const enc = new TextEncoder();

/** `NVDA` → 16 zero-padded bytes; the same check `valid_symbol` makes. */
export function symbolBytes(s: string): Uint8Array {
  if (!/^[A-Z0-9.-]{1,16}$/.test(s)) throw new Error(`bad symbol ${JSON.stringify(s)}`);
  const out = new Uint8Array(16);
  out.set(enc.encode(s));
  return out;
}

export const symbolString = (b: Uint8Array): string => {
  const end = b.indexOf(0);
  return new TextDecoder().decode(end < 0 ? b : b.subarray(0, end));
};

export const bellConfigPda = (program = BELL_PROGRAM_ID): [PublicKey, number] =>
  PublicKey.findProgramAddressSync([enc.encode('bell-config')], program);

export const listingPda = (symbol: string, program = BELL_PROGRAM_ID): [PublicKey, number] =>
  PublicKey.findProgramAddressSync([enc.encode('listing'), symbolBytes(symbol)], program);

export const printPda = (listing: PublicKey, day: number, kind: BellKind, program = BELL_PROGRAM_ID): [PublicKey, number] =>
  PublicKey.findProgramAddressSync([enc.encode('print'), listing.toBytes(), i64(BigInt(day)), u8(KIND[kind])], program);

export const verifierStoragePda = (verifier: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([enc.encode('storage')], verifier)[0];

export const programDataPda = (program = BELL_PROGRAM_ID): PublicKey =>
  PublicKey.findProgramAddressSync([program.toBytes()], BPF_LOADER_UPGRADEABLE)[0];

/* ── Pyth Pro messages (lazer.rs) ────────────────────────────────────────── */

export const SOLANA_FORMAT_MAGIC = 2_182_742_457;
export const PAYLOAD_FORMAT_MAGIC = 2_479_346_549;
export const MESSAGE_HEADER_LEN = 4 + 64 + 32 + 2;
export const MAX_FEEDS = 8;

/** The same names as `LazerError` in lazer.rs; tests/vectors/lazer.json
 *  holds both to them. */
export type LazerErrorCode =
  | 'Truncated' | 'BadFormatMagic' | 'BadLength' | 'BadPayloadMagic' | 'TooManyFeeds'
  | 'DuplicateFeed' | 'DuplicateProperty' | 'UnknownProperty' | 'BadSession' | 'BadFlag' | 'TrailingBytes';

export class LazerError extends Error {
  readonly code: LazerErrorCode;
  constructor(code: LazerErrorCode, detail = '') {
    super(`pyth pro: ${code}${detail ? ` (${detail})` : ''}`);
    this.code = code;
  }
}

export interface LazerMessage { signature: Uint8Array; publicKey: Uint8Array; payload: Uint8Array }

export interface LazerFeed {
  feedId: number;
  price: bigint | null;
  bestBid: bigint | null;
  bestAsk: bigint | null;
  publishers: number | null;
  exponent: number | null;
  confidence: bigint | null;
  /** 0 regular, 1 pre-market, 2 post-market, 3 overnight, 4 closed. */
  session: number | null;
  emaPrice: bigint | null;
  emaConfidence: bigint | null;
  /** When Pyth generated this feed's price. The rule reads this, not the
   *  message timestamp: a shut market's price is carried forward. */
  feedTsUs: bigint | null;
}

export interface LazerPayload { timestampUs: bigint; channel: number; feeds: LazerFeed[] }

class Reader {
  private at = 0;
  private readonly b: Uint8Array;
  private readonly dv: DataView;
  constructor(b: Uint8Array) { this.b = b; this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  private need(n: number): number {
    if (this.at + n > this.b.length) throw new LazerError('Truncated', `need ${n} at ${this.at} of ${this.b.length}`);
    const a = this.at;
    this.at += n;
    return a;
  }
  take(n: number): Uint8Array { const a = this.need(n); return this.b.slice(a, a + n); }
  u8(): number { return this.dv.getUint8(this.need(1)); }
  u16(): number { return this.dv.getUint16(this.need(2), true); }
  i16(): number { return this.dv.getInt16(this.need(2), true); }
  u32(): number { return this.dv.getUint32(this.need(4), true); }
  u64(): bigint { return this.dv.getBigUint64(this.need(8), true); }
  i64(): bigint { return this.dv.getBigInt64(this.need(8), true); }
  nonzero(): bigint | null { const v = this.i64(); return v === 0n ? null : v; }
  flag(): boolean {
    const f = this.u8();
    if (f > 1) throw new LazerError('BadFlag', String(f));
    return f === 1;
  }
  get done(): boolean { return this.at === this.b.length; }
}

/** Split a Solana-format message; its declared length must be exact. */
export function parseLazerMessage(data: Uint8Array): LazerMessage {
  const r = new Reader(data);
  if (r.u32() !== SOLANA_FORMAT_MAGIC) throw new LazerError('BadFormatMagic');
  const signature = r.take(64);
  const publicKey = r.take(32);
  const len = r.u16();
  if (data.length !== MESSAGE_HEADER_LEN + len) throw new LazerError('BadLength', `${data.length} vs ${MESSAGE_HEADER_LEN + len}`);
  return { signature, publicKey, payload: r.take(len) };
}

/** Read a payload exactly as lazer.rs does, refusing what it refuses. */
export function parseLazerPayload(data: Uint8Array): LazerPayload {
  const r = new Reader(data);
  if (r.u32() !== PAYLOAD_FORMAT_MAGIC) throw new LazerError('BadPayloadMagic');
  const timestampUs = r.u64();
  const channel = r.u8();
  const count = r.u8();
  if (count > MAX_FEEDS) throw new LazerError('TooManyFeeds', String(count));
  const feeds: LazerFeed[] = [];
  for (let i = 0; i < count; i++) {
    const feedId = r.u32();
    if (feeds.some((f) => f.feedId === feedId)) throw new LazerError('DuplicateFeed', String(feedId));
    const f: LazerFeed = {
      feedId, price: null, bestBid: null, bestAsk: null, publishers: null, exponent: null,
      confidence: null, session: null, emaPrice: null, emaConfidence: null, feedTsUs: null,
    };
    const props = r.u8();
    let seen = 0;
    for (let j = 0; j < props; j++) {
      const id = r.u8();
      if (id > 12) throw new LazerError('UnknownProperty', String(id));
      if (seen & (1 << id)) throw new LazerError('DuplicateProperty', String(id));
      seen |= 1 << id;
      switch (id) {
        case 0: f.price = r.nonzero(); break;
        case 1: f.bestBid = r.nonzero(); break;
        case 2: f.bestAsk = r.nonzero(); break;
        case 3: f.publishers = r.u16(); break;
        case 4: f.exponent = r.i16(); break;
        case 5: f.confidence = r.nonzero(); break;
        case 6: if (r.flag()) r.i64(); break;
        case 7: case 8: if (r.flag()) r.u64(); break;
        case 9: {
          const s = r.i16();
          if (s < 0 || s > 4) throw new LazerError('BadSession', String(s));
          f.session = s;
          break;
        }
        case 10: f.emaPrice = r.nonzero(); break;
        case 11: f.emaConfidence = r.nonzero(); break;
        case 12: f.feedTsUs = r.flag() ? r.u64() : null; break;
      }
    }
    feeds.push(f);
  }
  if (!r.done) throw new LazerError('TrailingBytes');
  return { timestampUs, channel, feeds };
}

/** Pyth's encoder, for the properties a bell reads, in Pyth's property
 *  order. Used by the poster's simulated mode; a real post carries bytes
 *  Pyth wrote. */
export function encodeLazerPayload(p: LazerPayload): Uint8Array {
  const parts: Uint8Array[] = [u32(PAYLOAD_FORMAT_MAGIC), u64(p.timestampUs), u8(p.channel), u8(p.feeds.length)];
  for (const f of p.feeds) {
    const props: Uint8Array[] = [];
    const price = (id: number, v: bigint | null) => { if (v !== null) props.push(concat(u8(id), i64(v))); };
    price(0, f.price);
    price(1, f.bestBid);
    price(2, f.bestAsk);
    if (f.publishers !== null) props.push(concat(u8(3), u16(f.publishers)));
    if (f.exponent !== null) props.push(concat(u8(4), i16(f.exponent)));
    price(5, f.confidence);
    if (f.session !== null) props.push(concat(u8(9), i16(f.session)));
    price(10, f.emaPrice);
    price(11, f.emaConfidence);
    if (f.feedTsUs !== null) props.push(concat(u8(12), u8(1), u64(f.feedTsUs)));
    parts.push(u32(f.feedId), u8(props.length), ...props);
  }
  return concat(...parts);
}

export function encodeLazerMessage(signature: Uint8Array, publicKey: Uint8Array, payload: Uint8Array): Uint8Array {
  if (signature.length !== 64 || publicKey.length !== 32) throw new Error('signature is 64 bytes and key 32');
  if (payload.length > 0xffff) throw new Error('payload longer than a u16 length');
  return concat(u32(SOLANA_FORMAT_MAGIC), signature, publicKey, u16(payload.length), payload);
}

/** An exact decimal string for a Pyth mantissa and exponent: no floats. */
export function decimalPrice(mantissa: bigint, expo: number): string {
  const neg = mantissa < 0n;
  const digits = (neg ? -mantissa : mantissa).toString();
  let s: string;
  if (expo >= 0) s = digits + '0'.repeat(expo);
  else {
    const places = -expo;
    const padded = digits.padStart(places + 1, '0');
    s = `${padded.slice(0, padded.length - places)}.${padded.slice(padded.length - places)}`;
  }
  return neg ? `-${s}` : s;
}

/* ── the Ed25519 instruction ─────────────────────────────────────────────── */

/**
 * Pyth's `createEd25519Instruction(message, instructionIndex, startingOffset)`:
 * one signature, whose signature, key and payload all live in instruction
 * `instructionIndex` with the message starting at `startingOffset`. For a
 * post that is the `post_print` instruction and byte 12. The verifier
 * requires every index to name the post itself.
 */
export function ed25519Ix(message: Uint8Array, instructionIndex: number, startingOffset = 12): TransactionInstruction {
  const sig = startingOffset + 4;
  const pk = sig + 64;
  const sizeAt = pk + 32;
  const dataAt = sizeAt + 2;
  const size = new DataView(message.buffer, message.byteOffset).getUint16(sizeAt - startingOffset, true);
  const data = concat(
    u8(1), u8(0),
    u16(sig), u16(instructionIndex), u16(pk), u16(instructionIndex), u16(dataAt), u16(size), u16(instructionIndex),
  );
  return new TransactionInstruction({ programId: ED25519_PROGRAM_ID, keys: [], data: data as Buffer });
}

/* ── accounts ────────────────────────────────────────────────────────────── */

class Cur {
  private at: number;
  private readonly b: Uint8Array;
  private readonly dv: DataView;
  constructor(b: Uint8Array, at = 0) { this.b = b; this.at = at; this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  private need(n: number): number {
    if (this.at + n > this.b.length) throw new Error(`bell account truncated at ${this.at} (+${n} of ${this.b.length})`);
    const a = this.at;
    this.at += n;
    return a;
  }
  u8(): number { return this.dv.getUint8(this.need(1)); }
  bool(): boolean { return this.u8() !== 0; }
  u16(): number { return this.dv.getUint16(this.need(2), true); }
  i16(): number { return this.dv.getInt16(this.need(2), true); }
  u32(): number { return this.dv.getUint32(this.need(4), true); }
  u64(): bigint { return this.dv.getBigUint64(this.need(8), true); }
  i64(): bigint { return this.dv.getBigInt64(this.need(8), true); }
  bytes(n: number): Uint8Array { const a = this.need(n); return this.b.slice(a, a + n); }
  key(): PublicKey { return new PublicKey(this.bytes(32)); }
}

function expectAccount(data: Uint8Array, name: keyof typeof BELL_ACCOUNT): Cur {
  const want = BELL_ACCOUNT[name];
  if (data.length < 8 || want.some((b, i) => data[i] !== b)) throw new Error(`not a ${name} account`);
  if (name !== 'Storage' && data[8] !== BELL_VERSION) {
    throw new Error(`${name} version ${data[8]}, expected ${BELL_VERSION}; refusing to decode`);
  }
  return new Cur(data, 8);
}

export interface BellConfig {
  version: number; bump: number; simulated: boolean;
  admin: PublicKey; pendingAdmin: PublicKey; verifier: PublicKey; verifierStorage: PublicKey;
  params: BellParams; listings: number;
}

export function decodeBellConfig(data: Uint8Array): BellConfig {
  const c = expectAccount(data, 'BellConfig');
  return {
    version: c.u8(), bump: c.u8(), simulated: c.bool(),
    admin: c.key(), pendingAdmin: c.key(), verifier: c.key(), verifierStorage: c.key(),
    params: {
      minPublishers: c.u16(), maxConfBps: c.u16(), closeLeadSecs: c.u32(), openWindowSecs: c.u32(),
      finalizeAfterSecs: c.u32(), maxDivergenceBps: c.u16(), methodVersion: c.u16(),
    },
    listings: c.u32(),
  };
}

export interface Listing {
  version: number; bump: number; active: boolean; symbol: string;
  equityFeed: number; rrFeed: number; tokenFeed: number; indexFeed: number;
  mint: PublicKey; prints: bigint; missing: bigint; createdAt: number; activeSince: number;
}

export function decodeListing(data: Uint8Array): Listing {
  const c = expectAccount(data, 'Listing');
  return {
    version: c.u8(), bump: c.u8(), active: c.bool(), symbol: symbolString(c.bytes(16)),
    equityFeed: c.u32(), rrFeed: c.u32(), tokenFeed: c.u32(), indexFeed: c.u32(),
    mint: c.key(), prints: c.u64(), missing: c.u64(), createdAt: Number(c.i64()), activeSince: Number(c.i64()),
  };
}

export interface Quote {
  feedId: number; price: bigint; conf: bigint; expo: number; publishers: number;
  /** A `SESSION` index, or `SESSION_UNREPORTED`. */
  session: number;
  present: boolean;
  feedTsUs: bigint;
}

export interface Print {
  version: number; bump: number; status: PrintStatus; kind: BellKind; flags: number; channel: number;
  posts: number; methodVersion: number; listing: PublicKey; day: number; bellTs: number;
  windowStartUs: bigint; windowEndUs: bigint; deadline: number;
  equity: Quote; rr: Quote; token: Quote; index: Quote;
  divergenceBps: bigint; messageTsUs: bigint; signer: PublicKey; verifier: PublicKey; poster: PublicKey;
  slot: bigint; postedAt: number; finalizedAt: number;
  /** From `flags`: verified by something other than Pyth's own program. */
  simulated: boolean;
}

/** Offset of `listing` in a print, for a `getProgramAccounts` memcmp. */
export const PRINT_LISTING_OFFSET = 8 + 6 + 2 + 2;

export function decodePrint(data: Uint8Array): Print {
  const c = expectAccount(data, 'Print');
  const quote = (): Quote => ({
    feedId: c.u32(), price: c.i64(), conf: c.i64(), expo: c.i16(), publishers: c.u16(),
    session: c.u8(), present: c.bool(), feedTsUs: c.u64(),
  });
  const head = {
    version: c.u8(), bump: c.u8(), status: STATUS[c.u8()] ?? 'provisional', kind: kindName(c.u8()),
    flags: c.u8(), channel: c.u8(), posts: c.u16(), methodVersion: c.u16(), listing: c.key(),
    day: Number(c.i64()), bellTs: Number(c.i64()), windowStartUs: c.u64(), windowEndUs: c.u64(),
    deadline: Number(c.i64()),
  };
  const body = {
    equity: quote(), rr: quote(), token: quote(), index: quote(),
    divergenceBps: c.i64(), messageTsUs: c.u64(), signer: c.key(), verifier: c.key(), poster: c.key(),
    slot: c.u64(), postedAt: Number(c.i64()), finalizedAt: Number(c.i64()),
  };
  return { ...head, ...body, simulated: (head.flags & FLAG_SIMULATED) !== 0 };
}

export interface LazerStorage {
  topAuthority: PublicKey; treasury: PublicKey; feeLamports: bigint;
  trustedSigners: { key: PublicKey; expiresAt: number }[];
}

/** The verifier's storage: who it trusts, until when, and where its fee goes. */
export function decodeLazerStorage(data: Uint8Array): LazerStorage {
  const c = expectAccount(data, 'Storage');
  const topAuthority = c.key();
  const treasury = c.key();
  const feeLamports = c.u64();
  const n = c.u8();
  const trustedSigners: LazerStorage['trustedSigners'] = [];
  for (let i = 0; i < 5; i++) {
    const key = c.key();
    const expiresAt = Number(c.i64());
    if (i < n) trustedSigners.push({ key, expiresAt });
  }
  return { topAuthority, treasury, feeLamports, trustedSigners };
}

/* ── instructions ────────────────────────────────────────────────────────── */

const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });
const ix = (keys: ReturnType<typeof w>[], data: Uint8Array, program = BELL_PROGRAM_ID) =>
  new TransactionInstruction({ programId: program, keys, data: data as Buffer });

export function initConfigIx(a: { admin: PublicKey; verifier: PublicKey; params?: BellParams; program?: PublicKey }) {
  const program = a.program ?? BELL_PROGRAM_ID;
  return ix([
    w(a.admin, true), w(bellConfigPda(program)[0]), r(program), r(programDataPda(program)),
    r(a.verifier), r(verifierStoragePda(a.verifier)), r(SystemProgram.programId),
  ], concat(disc('init_config'), encodeBellParams(a.params ?? PARAMS_V1)), program);
}

export function setParamsIx(a: { admin: PublicKey; params: BellParams; program?: PublicKey }) {
  const program = a.program ?? BELL_PROGRAM_ID;
  return ix([r(a.admin, true), w(bellConfigPda(program)[0])], concat(disc('set_params'), encodeBellParams(a.params)), program);
}

export function setVerifierIx(a: { admin: PublicKey; verifier: PublicKey; program?: PublicKey }) {
  const program = a.program ?? BELL_PROGRAM_ID;
  return ix([
    r(a.admin, true), w(bellConfigPda(program)[0]), r(a.verifier), r(verifierStoragePda(a.verifier)),
  ], disc('set_verifier'), program);
}

export function transferAdminIx(a: { admin: PublicKey; newAdmin: PublicKey; program?: PublicKey }) {
  const program = a.program ?? BELL_PROGRAM_ID;
  return ix([r(a.admin, true), w(bellConfigPda(program)[0])], concat(disc('transfer_admin'), a.newAdmin.toBytes()), program);
}

export function acceptAdminIx(a: { newAdmin: PublicKey; program?: PublicKey }) {
  const program = a.program ?? BELL_PROGRAM_ID;
  return ix([r(a.newAdmin, true), w(bellConfigPda(program)[0])], disc('accept_admin'), program);
}

export interface ListingFeeds { equity: number; rr?: number; token?: number; index?: number }

export function registerListingIx(a: { admin: PublicKey; symbol: string; feeds: ListingFeeds; mint?: PublicKey; program?: PublicKey }) {
  const program = a.program ?? BELL_PROGRAM_ID;
  const f = a.feeds;
  return ix([
    w(a.admin, true), w(bellConfigPda(program)[0]), w(listingPda(a.symbol, program)[0]), r(SystemProgram.programId),
  ], concat(
    disc('register_listing'), symbolBytes(a.symbol),
    u32(f.equity), u32(f.rr ?? 0), u32(f.token ?? 0), u32(f.index ?? 0),
    (a.mint ?? PublicKey.default).toBytes(),
  ), program);
}

export function setListingActiveIx(a: { admin: PublicKey; symbol: string; active: boolean; program?: PublicKey }) {
  const program = a.program ?? BELL_PROGRAM_ID;
  return ix([
    r(a.admin, true), r(bellConfigPda(program)[0]), w(listingPda(a.symbol, program)[0]),
  ], concat(disc('set_listing_active'), u8(a.active ? 1 : 0)), program);
}

/* The verifier's administration. Pyth runs these for its own instance; the
   devnet copy in tools/lazer-devnet is run by whoever deployed it. */

export function lazerInitializeIx(a: { verifier: PublicKey; payer: PublicKey; topAuthority: PublicKey; treasury: PublicKey }) {
  return ix([w(a.payer, true), w(verifierStoragePda(a.verifier)), r(SystemProgram.programId)],
    concat(Uint8Array.from(LAZER_DISCRIMINATOR.initialize), a.topAuthority.toBytes(), a.treasury.toBytes()), a.verifier);
}

/** Trust `signer` until `expiresAt` (unix seconds); 0 removes it. */
export function lazerUpdateIx(a: { verifier: PublicKey; topAuthority: PublicKey; signer: PublicKey; expiresAt: number }) {
  return ix([r(a.topAuthority, true), w(verifierStoragePda(a.verifier))],
    concat(Uint8Array.from(LAZER_DISCRIMINATOR.update), a.signer.toBytes(), i64(BigInt(a.expiresAt))), a.verifier);
}

/** Byte offset of the message inside `post_print`'s data. */
export const POST_PRINT_MESSAGE_OFFSET = 12;

export interface PostPrintArgs {
  poster: PublicKey;
  symbol: string;
  day: number;
  kind: BellKind;
  /** A Solana-format Pyth Pro message, exactly as Pyth delivered it. */
  message: Uint8Array;
  verifier: PublicKey;
  /** The verifier's fee treasury, from its storage (`decodeLazerStorage`). */
  treasury: PublicKey;
  program?: PublicKey;
}

export function postPrintIx(a: PostPrintArgs, ed25519Index: number) {
  const program = a.program ?? BELL_PROGRAM_ID;
  const listing = listingPda(a.symbol, program)[0];
  return ix([
    w(a.poster, true), r(bellConfigPda(program)[0]), w(listing), w(printPda(listing, a.day, a.kind, program)[0]),
    r(a.verifier), r(verifierStoragePda(a.verifier)), w(a.treasury), r(SYSVAR_INSTRUCTIONS_PUBKEY),
    r(SystemProgram.programId),
  ], concat(
    disc('post_print'), u32(a.message.length), a.message, i64(BigInt(a.day)), u8(KIND[a.kind]), u16(ed25519Index),
  ), program);
}

/**
 * The instructions a post needs, in the order the verifier checks them:
 * an optional compute budget, Pyth's Ed25519 instruction pointing at the
 * post, then the post. Put nothing between them — the indices are baked in.
 */
export function postPrintIxs(a: PostPrintArgs & { computeUnits?: number }): TransactionInstruction[] {
  const pre = a.computeUnits ? [ComputeBudgetProgram.setComputeUnitLimit({ units: a.computeUnits })] : [];
  const edAt = pre.length;
  return [...pre, ed25519Ix(a.message, edAt + 1, POST_PRINT_MESSAGE_OFFSET), postPrintIx(a, edAt)];
}

export function finalizePrintIx(a: { symbol: string; day: number; kind: BellKind; program?: PublicKey }) {
  const program = a.program ?? BELL_PROGRAM_ID;
  const listing = listingPda(a.symbol, program)[0];
  return ix([w(printPda(listing, a.day, a.kind, program)[0])], disc('finalize_print'), program);
}

export function markMissingIx(a: { caller: PublicKey; symbol: string; day: number; kind: BellKind; program?: PublicKey }) {
  const program = a.program ?? BELL_PROGRAM_ID;
  const listing = listingPda(a.symbol, program)[0];
  return ix([
    w(a.caller, true), r(bellConfigPda(program)[0]), w(listing), w(printPda(listing, a.day, a.kind, program)[0]),
    r(SystemProgram.programId),
  ], concat(disc('mark_missing'), i64(BigInt(a.day)), u8(KIND[a.kind])), program);
}
