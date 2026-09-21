/* ───────────────────────────────────────────────────────────────────────────
   Vault account decoding and address derivation.

   The layout here is pinned to the program by `tests/vectors/vault-account.json`,
   which the Rust side emits from a real serialized `Vault`. Layout drift between
   a program and its client is a classic production failure: the client reads a
   field at the wrong offset, reports a number that looks plausible, and an
   operator acts on it. Pinning the bytes turns that into a failing test.
   ─────────────────────────────────────────────────────────────────────────── */

import { PublicKey } from '@solana/web3.js';

export const PROGRAM_ID = new PublicKey('8gWC37AFvgnPMAZSqiimbkpqPVhF3PrA1rao5agVKqKZ');
export const PYTH_RECEIVER = new PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');

export const CLASS = ['night', 'day'] as const;
export type ClassName = (typeof CLASS)[number];

export const HALT_REASON = [
  'None', 'MissedBoundary', 'UnfilledHandoff', 'Insolvent', 'BadDebt', 'Inconsistent', 'Operator', 'IssuerAction',
] as const;

/** `VaultHalted.detail` for an `IssuerAction` halt. */
export const ISSUER_CONDITION = { 1: 'transfer hook set', 2: 'mint paused', 3: 'vault account frozen', 4: 'inventory seized' } as const;

/** What a session is for a vault: NYSE hours, or the next discrete print. */
export const SESSION_EQUITY = 0;
export const SESSION_EVENT = 1;
export type SessionKind = typeof SESSION_EQUITY | typeof SESSION_EVENT;
export const SESSION_KIND = ['equity', 'event'] as const;

/**
 * The class names a vault's two mints wear. One program, one pair of mints;
 * an event session calls them NOW/THEN because there is no day or night to
 * speak of, only the stretch between prints.
 */
export const classLabel = (kind: SessionKind, c: ClassName): string =>
  kind === SESSION_EVENT ? (c === 'night' ? 'THEN' : 'NOW') : c.toUpperCase();

export const PAUSE_MINT = 1;
export const PAUSE_REDEEM = 2;
export const PAUSE_FILL = 4;

/* ── addresses ───────────────────────────────────────────────────────────── */

export const vaultPda = (underlyingMint: PublicKey, quoteMint: PublicKey): [PublicKey, number] =>
  PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), underlyingMint.toBuffer(), quoteMint.toBuffer()],
    PROGRAM_ID,
  );

const child = (seed: string, vault: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from(seed), vault.toBuffer()], PROGRAM_ID);

export const protocolPda = (): [PublicKey, number] =>
  PublicKey.findProgramAddressSync([Buffer.from('protocol')], PROGRAM_ID);
export const schedulePda = (v: PublicKey) => child('schedule', v);

/** One auction per bell: the boundary timestamp is part of the seed. */
export const auctionPda = (vault: PublicKey, boundaryTs: number): [PublicKey, number] => {
  const ts = new Uint8Array(8);
  new DataView(ts.buffer).setBigInt64(0, BigInt(boundaryTs), true);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('auction'), vault.toBuffer(), ts], PROGRAM_ID,
  );
};
export const bidPda = (auction: PublicKey, bidder: PublicKey): [PublicKey, number] =>
  PublicKey.findProgramAddressSync(
    [Buffer.from('bid'), auction.toBuffer(), bidder.toBuffer()], PROGRAM_ID,
  );
export const detectorPda = (v: PublicKey) => child('detector', v);

export const nightMintPda = (v: PublicKey) => child('night', v);
export const dayMintPda = (v: PublicKey) => child('day', v);
export const underlyingVaultPda = (v: PublicKey) => child('underlying', v);
export const quoteVaultPda = (v: PublicKey) => child('quote', v);

/* ── decoding ────────────────────────────────────────────────────────────── */

class Cursor {
  private b: Uint8Array;
  private at: number;
  constructor(b: Uint8Array, at = 0) { this.b = b; this.at = at; }
  private take(n: number): Uint8Array {
    if (this.at + n > this.b.length) {
      throw new Error(`vault account truncated at offset ${this.at} (+${n} of ${this.b.length})`);
    }
    const s = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return s;
  }
  u8(): number { return this.take(1)[0]; }
  bool(): boolean { return this.u8() !== 0; }
  bytes(n: number): Uint8Array { return Uint8Array.from(this.take(n)); }
  key(): PublicKey { return new PublicKey(this.take(32)); }
  private uint(n: number): bigint {
    const s = this.take(n);
    let v = 0n;
    for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(s[i]);
    return v;
  }
  private int(n: number): bigint {
    const u = this.uint(n);
    const bits = BigInt(n * 8);
    return u >= 1n << (bits - 1n) ? u - (1n << bits) : u;
  }
  u16(): number { return Number(this.uint(2)); }
  u32(): number { return Number(this.uint(4)); }
  i32(): number { return Number(this.int(4)); }
  u64(): bigint { return this.uint(8); }
  u128(): bigint { return this.uint(16); }
  i64(): bigint { return this.int(8); }
  i128(): bigint { return this.int(16); }
  get offset(): number { return this.at; }
}

export interface Vault {
  version: number;
  bump: number;
  authority: PublicKey;
  pendingAuthority: PublicKey;
  underlyingMint: PublicKey;
  quoteMint: PublicKey;
  underlyingVault: PublicKey;
  quoteVault: PublicKey;
  underlyingDecimals: number;
  quoteDecimals: number;
  ownedUnderlying: bigint;
  ownedQuote: bigint;
  nightMint: PublicKey;
  dayMint: PublicKey;
  markFeedId: Uint8Array;
  equityFeedId: Uint8Array;
  nightNav: bigint;
  dayNav: bigint;
  lastMark: bigint;
  exposed: ClassName;
  lastSessionOpen: boolean;
  lastBoundaryTs: number;
  boundaryCount: bigint;
  pendingDelta: bigint;
  fundingKBps: number;
  fundingMaxBps: number;
  maxStaleSecs: number;
  maxConfBps: number;
  maxMoveBps: number;
  equityQuietSecs: number;
  fillIncentiveBps: number;
  maxCarryDeltaBps: number;
  maxUnexpectedClosedSecs: number;
  flags: number;
  halted: boolean;
  haltReason: string;
  cumFundingNight: bigint;
  cumFillIncentive: bigint;
  totalMintedNight: bigint;
  totalMintedDay: bigint;
  // ── v2 ──
  sessionKind: SessionKind;
  symbol: string;
  maxPostedSlotAge: number;
  maxBellLeadSecs: number;
  maxPremiumBps: number;
  auctionSecs: number;
  incentiveRamp: [number, number, number];
  requireVerifiedRecap: boolean;
  fillPausedUntil: number;
  lastRecapTs: number;
  recapCount: number;
  detectorAuthority: PublicKey;
  shareTokenProgram: PublicKey;
  creator: PublicKey;
  createdAt: number;
  /** Posted to an open auction: never backing, always reclaimable. */
  escrowedQuote: bigint;
  escrowedUnderlying: bigint;
  /** Whether the desk shows it. The chain is permissionless either way. */
  curated: boolean;
}

export const VAULT_VERSION = 2;

/** NUL-padded ASCII, as `Vault::symbol` stores it. */
const symbolOf = (b: Uint8Array): string => {
  const end = b.indexOf(0);
  return new TextDecoder().decode(end < 0 ? b : b.subarray(0, end));
};

/**
 * Decode a vault account. Field order mirrors the Rust struct exactly, because
 * borsh serialises in declaration order and nothing else pins the two together.
 */
export function decodeVault(data: Uint8Array): Vault {
  // The version is the first byte after the discriminator. Check it before
  // reading anything else: an older layout is shorter, and walking it with
  // this decoder would report "truncated" instead of the actual problem.
  if (data.length > 8 && data[8] !== VAULT_VERSION) {
    throw new Error(`vault version ${data[8]}, expected ${VAULT_VERSION}; refusing to decode`);
  }
  const c = new Cursor(data, 8); // skip the anchor discriminator

  const v: Vault = {
    version: c.u8(),
    bump: c.u8(),
    authority: c.key(),
    pendingAuthority: c.key(),
    underlyingMint: c.key(),
    quoteMint: c.key(),
    underlyingVault: c.key(),
    quoteVault: c.key(),
    underlyingDecimals: c.u8(),
    quoteDecimals: c.u8(),
    ownedUnderlying: c.u64(),
    ownedQuote: c.u64(),
    nightMint: c.key(),
    dayMint: c.key(),
    markFeedId: c.bytes(32),
    equityFeedId: c.bytes(32),
    nightNav: c.u128(),
    dayNav: c.u128(),
    lastMark: c.u128(),
    exposed: CLASS[c.u8()] ?? 'night',
    lastSessionOpen: c.bool(),
    lastBoundaryTs: Number(c.i64()),
    boundaryCount: c.u64(),
    pendingDelta: c.i128(),
    fundingKBps: c.u32(),
    fundingMaxBps: c.u32(),
    maxStaleSecs: c.u32(),
    maxConfBps: c.u16(),
    maxMoveBps: c.u16(),
    equityQuietSecs: c.u32(),
    fillIncentiveBps: c.u16(),
    maxCarryDeltaBps: c.u16(),
    maxUnexpectedClosedSecs: c.u32(),
    flags: c.u8(),
    halted: c.bool(),
    haltReason: HALT_REASON[c.u8()] ?? 'Unknown',
    cumFundingNight: c.i128(),
    cumFillIncentive: c.u64(),
    totalMintedNight: c.u64(),
    totalMintedDay: c.u64(),
    sessionKind: c.u8() as SessionKind,
    symbol: symbolOf(c.bytes(8)),
    maxPostedSlotAge: c.u32(),
    maxBellLeadSecs: c.u32(),
    maxPremiumBps: c.u16(),
    auctionSecs: c.u32(),
    incentiveRamp: [c.u16(), c.u16(), c.u16()],
    requireVerifiedRecap: c.bool(),
    fillPausedUntil: Number(c.i64()),
    lastRecapTs: Number(c.i64()),
    recapCount: c.u32(),
    detectorAuthority: c.key(),
    shareTokenProgram: c.key(),
    creator: c.key(),
    createdAt: Number(c.i64()),
    escrowedQuote: c.u64(),
    escrowedUnderlying: c.u64(),
    curated: c.bool(),
  };

  // An account written by a different program version must not be read as if
  // it were this one — the fields would decode to plausible nonsense.
  if (v.version !== VAULT_VERSION) {
    throw new Error(`vault version ${v.version}, expected ${VAULT_VERSION}; refusing to decode`);
  }
  return v;
}

/* ── the registry and the event clocks ───────────────────────────────────── */

export interface Protocol {
  version: number;
  bump: number;
  curator: PublicKey;
  vaultCount: bigint;
}

export function decodeProtocol(data: Uint8Array): Protocol {
  const c = new Cursor(data, 8);
  return { version: c.u8(), bump: c.u8(), curator: c.key(), vaultCount: c.u64() };
}

export interface ScheduledEvent {
  ts: number;
  windowSecs: number;
  kind: number;
}

export const EVENT_KIND = ['tender', 'round', 'valuation', 'other'] as const;

export interface EventSchedule {
  version: number;
  bump: number;
  vault: PublicKey;
  /** Only the slots actually set; empty ones are dropped. */
  events: ScheduledEvent[];
  updatedAt: number;
}

export function decodeSchedule(data: Uint8Array): EventSchedule {
  const c = new Cursor(data, 8);
  const version = c.u8(), bump = c.u8(), vault = c.key();
  const events: ScheduledEvent[] = [];
  for (let i = 0; i < 8; i++) {
    const ts = Number(c.i64()), windowSecs = c.u32(), kind = c.u8();
    if (ts > 0) events.push({ ts, windowSecs, kind });
  }
  return { version, bump, vault, events, updatedAt: Number(c.i64()) };
}

export interface DetectorReading {
  version: number;
  bump: number;
  vault: PublicKey;
  poster: PublicKey;
  mark: bigint;
  executable: bigint;
  ts: number;
  posts: bigint;
}

export function decodeDetector(data: Uint8Array): DetectorReading {
  const c = new Cursor(data, 8);
  return {
    version: c.u8(), bump: c.u8(), vault: c.key(), poster: c.key(),
    mark: c.u128(), executable: c.u128(), ts: Number(c.i64()), posts: c.u64(),
  };
}

export interface Auction {
  version: number;
  bump: number;
  vault: PublicKey;
  boundaryTs: number;
  closesAt: number;
  vaultBuys: boolean;
  wantedUnderlying: bigint;
  bidUnderlying: bigint;
  bids: number;
  clearingMark: bigint;
  fillRatio: bigint;
  closed: boolean;
  claimedUnderlying: bigint;
}

export function decodeAuction(data: Uint8Array): Auction {
  const c = new Cursor(data, 8);
  return {
    version: c.u8(), bump: c.u8(), vault: c.key(),
    boundaryTs: Number(c.i64()), closesAt: Number(c.i64()), vaultBuys: c.bool(),
    wantedUnderlying: c.u64(), bidUnderlying: c.u64(), bids: c.u32(),
    clearingMark: c.u128(), fillRatio: c.u128(), closed: c.bool(), claimedUnderlying: c.u64(),
  };
}

export interface Bid {
  version: number;
  bump: number;
  auction: PublicKey;
  bidder: PublicKey;
  underlying: bigint;
  escrowed: bigint;
  ts: number;
}

export function decodeBid(data: Uint8Array): Bid {
  const c = new Cursor(data, 8);
  return {
    version: c.u8(), bump: c.u8(), auction: c.key(), bidder: c.key(),
    underlying: c.u64(), escrowed: c.u64(), ts: Number(c.i64()),
  };
}

/** What a bid wins and gets back. Mirrors `auction::award`. */
export function award(
  a: Pick<Auction, 'fillRatio' | 'clearingMark' | 'vaultBuys'>, bidUnderlying: bigint, escrowed: bigint,
): { underlying: bigint; quote: bigint; refund: bigint } {
  const WAD = 10n ** 18n;
  const underlying = (bidUnderlying * a.fillRatio) / WAD;
  const quote = a.vaultBuys
    ? (underlying * a.clearingMark) / WAD
    : (underlying * a.clearingMark + WAD - 1n) / WAD;
  const spent = a.vaultBuys ? underlying : quote;
  return { underlying, quote, refund: escrowed > spent ? escrowed - spent : 0n };
}

/** How far `executable` sits from `mark`, in bp. Mirrors `event::premium_bps`. */
export function premiumBps(d: { mark: bigint; executable: bigint }): number {
  if (d.mark === 0n || d.executable === 0n) return 0;
  const diff = d.executable > d.mark ? d.executable - d.mark : d.mark - d.executable;
  return Number((diff * 10_000n) / d.mark);
}

/* ── Pyth price update ───────────────────────────────────────────────────── */

export interface PythQuote {
  feedId: Uint8Array;
  price: bigint;
  conf: bigint;
  expo: number;
  publishTime: number;
}

const PRICE_UPDATE_V2_DISC = Uint8Array.from([34, 241, 35, 99, 157, 126, 244, 205]);

/**
 * Mirrors `oracle::parse_price_update`. Parsing is sequential rather than
 * fixed-offset because `verification_level` is a borsh enum and therefore
 * variable width — a fixed-offset reader silently misreads every `Partial`
 * update.
 */
export function decodePythQuote(data: Uint8Array): PythQuote {
  for (let i = 0; i < 8; i++) {
    if (data[i] !== PRICE_UPDATE_V2_DISC[i]) throw new Error('not a Pyth PriceUpdateV2 account');
  }
  const c = new Cursor(data, 8);
  c.key();                                // write_authority
  const level = c.u8();
  if (level === 0) c.u8();                // Partial { num_signatures }
  else if (level !== 1) throw new Error('unknown Pyth verification level');

  return {
    feedId: c.bytes(32),
    price: c.i64(),
    conf: c.u64(),
    expo: c.i32(),
    publishTime: Number(c.i64()),
  };
}

/** Quote atoms per underlying atom, WAD-scaled — mirrors `oracle::normalize`. */
export function normalizeMark(
  q: PythQuote, underlyingDecimals: number, quoteDecimals: number,
): bigint {
  if (q.price <= 0n) throw new Error('non-positive oracle price');
  const WAD = 10n ** 18n;
  let numPow = q.expo + quoteDecimals;
  let denPow = underlyingDecimals;
  if (numPow < 0) { denPow -= numPow; numPow = 0; }
  return (q.price * WAD * 10n ** BigInt(numPow)) / 10n ** BigInt(denPow);
}

/**
 * What a fill pays right now, in basis points — mirrors `Vault::incentive_at`.
 *
 * The incentive is not `fillIncentiveBps`; it is a ramp. A residual nobody
 * took at 10 bp is offered at 25 after one auction window and 50 after two,
 * because the vault would rather pay for the fill than carry the imbalance
 * into the next bell. `fillIncentiveBps` is only the tier the vault was
 * initialised with.
 *
 * Reading the flat field instead is not a cosmetic error: a keeper sizing a
 * fill against 10 bp when the chain is charging 25 asks the vault to pay more
 * quote than it holds, and the program refuses the whole fill. That is
 * exactly what happened at this protocol's first real bell.
 */
export function incentiveAt(
  v: Pick<Vault, 'incentiveRamp' | 'auctionSecs' | 'lastBoundaryTs'>,
  now: number,
): number {
  const since = now - v.lastBoundaryTs;
  const w = v.auctionSecs;
  if (w <= 0 || since < w) return v.incentiveRamp[0];
  if (since < 2 * w) return v.incentiveRamp[1];
  return v.incentiveRamp[2];
}
