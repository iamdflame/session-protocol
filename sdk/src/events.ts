/* ───────────────────────────────────────────────────────────────────────────
   The vault's own events, decoded.

   A ledger that lists signatures and calls every one of them "tx" is a list
   of links, not a record. What happened — who minted, what a boundary
   settled at, which class wore a jump, what a recap replayed and on whose
   word — is in the events the program emits, and Anchor puts those in the
   transaction logs as `Program data: <base64>` with an 8-byte discriminator
   of `sha256("event:<Name>")[..8]`.

   Decoding them here means the site shows receipts rather than hashes, and
   means anyone can reconstruct a vault's whole history from the chain
   without trusting this repository's copy of it.

   Field order mirrors `state.rs` exactly, because borsh serialises in
   declaration order and nothing else pins the two together. `tests/events`
   recomputes every discriminator and checks every layout.
   ─────────────────────────────────────────────────────────────────────────── */

import { PublicKey } from '@solana/web3.js';
import { CLASS, HALT_REASON, type ClassName } from './vault.ts';

/** `sha256("event:<Name>")[..8]`, precomputed so this runs in a browser. */
export const EVENT_DISCRIMINATOR: Record<string, number[]> = {
  VaultInitialized: [180, 43, 207, 2, 18, 71, 3, 75],
  BoundarySettled: [188, 91, 193, 113, 193, 3, 3, 76],
  SharesMinted: [127, 139, 238, 41, 118, 47, 122, 39],
  SharesRedeemed: [232, 166, 7, 56, 67, 19, 42, 117],
  HandoffFilled: [50, 198, 34, 234, 81, 149, 52, 30],
  VaultHalted: [180, 47, 189, 116, 100, 182, 92, 154],
  VaultResumed: [208, 173, 238, 64, 33, 63, 226, 151],
  ParamsChanged: [174, 49, 9, 64, 58, 171, 241, 24],
  SurplusSkimmed: [8, 168, 203, 123, 177, 208, 181, 151],
  Recapped: [106, 146, 163, 81, 106, 129, 105, 242],
  JumpSettled: [129, 169, 210, 151, 219, 130, 104, 234],
  AuctionOpened: [25, 230, 140, 215, 100, 193, 14, 70],
  AuctionBid: [113, 186, 124, 132, 210, 152, 98, 191],
  AuctionCleared: [14, 162, 105, 210, 219, 36, 142, 160],
  AuctionClaimed: [58, 64, 122, 93, 22, 43, 40, 141],
  VaultCurated: [87, 205, 152, 46, 241, 243, 32, 178],
  ScheduleSet: [144, 221, 214, 78, 222, 207, 219, 253],
  DetectorPosted: [136, 161, 204, 79, 34, 105, 197, 193],
};

type Kind = 'key' | 'u8' | 'bool' | 'u32' | 'u64' | 'i64' | 'u128' | 'i128' | 'class' | 'halt' | 'hash';

/** Field order mirrors `state.rs`. Changing one without the other is the bug. */
const LAYOUT: Record<string, [string, Kind][]> = {
  VaultInitialized: [
    ['vault', 'key'], ['authority', 'key'], ['underlyingMint', 'key'], ['quoteMint', 'key'],
    ['nightMint', 'key'], ['dayMint', 'key'], ['mark', 'u128'], ['exposed', 'class'], ['ts', 'i64'],
  ],
  BoundarySettled: [
    ['vault', 'key'], ['ts', 'i64'], ['boundary', 'u64'], ['exposed', 'class'], ['mark', 'u128'],
    ['nightNav', 'u128'], ['dayNav', 'u128'], ['nightSupply', 'u64'], ['daySupply', 'u64'],
    ['funding', 'i128'], ['pendingDelta', 'i128'], ['ownedUnderlying', 'u64'], ['ownedQuote', 'u64'],
  ],
  SharesMinted: [
    ['vault', 'key'], ['user', 'key'], ['class', 'class'], ['quoteIn', 'u64'],
    ['sharesOut', 'u64'], ['nav', 'u128'], ['ownedQuote', 'u64'],
  ],
  SharesRedeemed: [
    ['vault', 'key'], ['user', 'key'], ['class', 'class'], ['sharesIn', 'u64'],
    ['quoteOut', 'u64'], ['nav', 'u128'], ['ownedQuote', 'u64'],
  ],
  HandoffFilled: [
    ['vault', 'key'], ['filler', 'key'], ['underlyingDelta', 'i64'], ['quoteDelta', 'i64'],
    ['incentivePaid', 'u64'], ['remainingDelta', 'i128'], ['ownedUnderlying', 'u64'], ['ownedQuote', 'u64'],
  ],
  VaultHalted: [['vault', 'key'], ['reason', 'halt'], ['ts', 'i64'], ['detail', 'i64']],
  VaultResumed: [['vault', 'key'], ['ts', 'i64'], ['mark', 'u128'], ['exposed', 'class']],
  ParamsChanged: [['vault', 'key'], ['authority', 'key']],
  SurplusSkimmed: [['vault', 'key'], ['underlying', 'u64'], ['quote', 'u64']],
  Recapped: [
    ['vault', 'key'], ['ts', 'i64'], ['fromTs', 'i64'], ['toTs', 'i64'], ['boundaries', 'u32'],
    ['verified', 'bool'], ['absorbed', 'u128'], ['unabsorbed', 'u128'], ['entriesHash', 'hash'],
    ['exposed', 'class'], ['nightNav', 'u128'], ['dayNav', 'u128'], ['pendingDelta', 'i128'], ['funding', 'i128'],
  ],
  JumpSettled: [
    ['vault', 'key'], ['ts', 'i64'], ['moveBps', 'u32'], ['mark', 'u128'], ['fillsPausedUntil', 'i64'],
  ],
  AuctionOpened: [
    ['vault', 'key'], ['auction', 'key'], ['boundaryTs', 'i64'], ['closesAt', 'i64'],
    ['vaultBuys', 'bool'], ['wantedUnderlying', 'u64'],
  ],
  AuctionBid: [
    ['vault', 'key'], ['bidder', 'key'], ['underlying', 'u64'], ['escrowed', 'u64'],
    ['totalBid', 'u64'], ['bids', 'u32'],
  ],
  AuctionCleared: [
    ['vault', 'key'], ['auction', 'key'], ['mark', 'u128'], ['fillRatio', 'u128'],
    ['underlying', 'u64'], ['quote', 'u64'], ['bids', 'u32'],
  ],
  AuctionClaimed: [
    ['vault', 'key'], ['bidder', 'key'], ['underlying', 'u64'], ['quote', 'u64'], ['refund', 'u64'],
  ],
  VaultCurated: [['vault', 'key'], ['curator', 'key'], ['curated', 'bool'], ['ts', 'i64']],
  ScheduleSet: [['vault', 'key'], ['authority', 'key'], ['events', 'u8'], ['ts', 'i64']],
  DetectorPosted: [
    ['vault', 'key'], ['poster', 'key'], ['mark', 'u128'], ['executable', 'u128'],
    ['premiumBps', 'u32'], ['ts', 'i64'],
  ],
};

const SIZE: Record<Kind, number> = {
  key: 32, u8: 1, bool: 1, u32: 4, u64: 8, i64: 8, u128: 16, i128: 16, class: 1, halt: 1, hash: 32,
};

export interface VaultEvent {
  name: string;
  fields: Record<string, unknown>;
}

function read(kind: Kind, b: Uint8Array, at: number): unknown {
  const slice = b.subarray(at, at + SIZE[kind]);
  switch (kind) {
    case 'key': return new PublicKey(slice);
    case 'hash': return Array.from(slice, x => x.toString(16).padStart(2, '0')).join('');
    case 'bool': return slice[0] !== 0;
    case 'u8': return slice[0];
    case 'class': return (CLASS[slice[0]] ?? 'night') as ClassName;
    case 'halt': return HALT_REASON[slice[0]] ?? 'Unknown';
    default: {
      const n = SIZE[kind];
      let v = 0n;
      for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(slice[i]);
      if (kind[0] === 'i' && v >= 1n << BigInt(n * 8 - 1)) v -= 1n << BigInt(n * 8);
      return kind === 'u32' ? Number(v) : v;
    }
  }
}

/** Decode one event body, discriminator included. Null when unrecognised. */
export function decodeEvent(data: Uint8Array): VaultEvent | null {
  if (data.length < 8) return null;
  for (const [name, disc] of Object.entries(EVENT_DISCRIMINATOR)) {
    if (disc.every((b, i) => data[i] === b)) {
      const fields: Record<string, unknown> = {};
      let at = 8;
      for (const [key, kind] of LAYOUT[name]) {
        if (at + SIZE[kind] > data.length) return null;   // truncated: say so by omission
        fields[key] = read(kind, data, at);
        at += SIZE[kind];
      }
      return { name, fields };
    }
  }
  return null;
}

/**
 * Every event a transaction emitted, from its logs.
 *
 * Anchor writes `Program data: <base64>` for `emit!`. Lines from other
 * programs decode to nothing and are skipped, so a transaction that touched
 * several programs yields only this one's events.
 */
export function eventsFromLogs(logs: string[] | null | undefined): VaultEvent[] {
  if (!logs) return [];
  const out: VaultEvent[] = [];
  for (const line of logs) {
    const m = line.match(/^Program data: (.+)$/);
    if (!m) continue;
    try {
      const bin = typeof atob === 'function'
        ? Uint8Array.from(atob(m[1]), c => c.charCodeAt(0))
        : Uint8Array.from(Buffer.from(m[1], 'base64'));
      const ev = decodeEvent(bin);
      if (ev) out.push(ev);
    } catch { /* not ours */ }
  }
  return out;
}

/* ── how a person reads it ───────────────────────────────────────────────── */

const WAD = 10n ** 18n;
const amount = (v: bigint, dec: number, digits = 2) =>
  (Number(v) / 10 ** dec).toLocaleString('en-US', { maximumFractionDigits: digits });
const nav = (v: bigint) => (Number(v) / Number(WAD)).toFixed(4);

/** A short, true sentence for one event. `dec` is the quote's decimals. */
export function describe(e: VaultEvent, dec = 6, cls: (c: ClassName) => string = c => c.toUpperCase()): string {
  // Fields come back typed by the layout above; reading them here needs a
  // narrow accessor rather than a cast that makes every field `never`.
  const raw = e.fields;
  const n = (k: string) => raw[k] as bigint;
  const num = (k: string) => raw[k] as number;
  const str = (k: string) => String(raw[k]);
  const flag = (k: string) => raw[k] as boolean;
  const klass = (k: string) => cls(raw[k] as ClassName);
  const abs = (v: bigint) => (v < 0n ? -v : v);
  switch (e.name) {
    case 'VaultInitialized':
      return `Vault opened at a mark of ${nav(n('mark'))}, ${klass('exposed')} exposed`;
    case 'BoundarySettled':
      return `Boundary ${str('boundary')} settled at ${nav(n('mark'))} — ${klass('exposed')} takes the stock, `
        + `NAV ${nav(n('nightNav'))} / ${nav(n('dayNav'))}`
        + (n('funding') !== 0n
          ? `, funding ${n('funding') > 0n ? 'NIGHT→DAY' : 'DAY→NIGHT'} ${amount(abs(n('funding')), dec)}`
          : '');
    case 'SharesMinted':
      return `Minted ${amount(n('sharesOut'), dec)} ${klass('class')} for ${amount(n('quoteIn'), dec)} quote at NAV ${nav(n('nav'))}`;
    case 'SharesRedeemed':
      return `Redeemed ${amount(n('sharesIn'), dec)} ${klass('class')} for ${amount(n('quoteOut'), dec)} quote at NAV ${nav(n('nav'))}`;
    case 'HandoffFilled':
      return `Handoff filled: vault ${n('underlyingDelta') > 0n ? 'bought' : 'sold'} stock, `
        + `incentive ${amount(n('incentivePaid'), dec)}, `
        + `${n('remainingDelta') === 0n ? 'flat' : `${amount(abs(n('remainingDelta')), dec)} left`}`;
    case 'VaultHalted':
      return `Halted — ${str('reason')}${n('detail') !== 0n ? ` (${str('detail')})` : ''}`;
    case 'VaultResumed':
      return `Resumed with ${klass('exposed')} exposed`;
    case 'Recapped':
      return `Recapped ${str('boundaries')} missed bell${num('boundaries') === 1 ? '' : 's'}, `
        + `${flag('verified') ? 'each backed by a Pyth update' : 'attested by the operator'}`
        + (n('absorbed') !== 0n ? `, ${amount(n('absorbed'), dec)} charged to the other class` : '');
    case 'JumpSettled':
      return `Jump of ${(num('moveBps') / 100).toFixed(1)}% settled — the exposed class wore it; fills paused`;
    case 'AuctionOpened':
      return `Auction opened for ${amount(n('wantedUnderlying'), dec)} — the vault ${flag('vaultBuys') ? 'buys' : 'sells'}`;
    case 'AuctionBid':
      return `Bid ${amount(n('underlying'), dec)}; ${str('bids')} bidder${num('bids') === 1 ? '' : 's'} so far`;
    case 'AuctionCleared':
      return `Auction cleared at ${nav(n('mark'))} — one price for all ${str('bids')} bids, `
        + `${n('fillRatio') === WAD ? 'filled whole' : `${((Number(n('fillRatio')) / Number(WAD)) * 100).toFixed(1)}% pro rata`}`;
    case 'AuctionClaimed':
      return `Claimed ${amount(n('underlying'), dec)}${n('refund') !== 0n ? `, ${amount(n('refund'), dec)} returned` : ''}`;
    case 'SurplusSkimmed':
      return `Skimmed ${amount(n('underlying'), dec)} underlying and ${amount(n('quote'), dec)} quote sent in by mistake`;
    case 'DetectorPosted':
      return `Detector posted: mark ${nav(n('mark'))}, executes at ${nav(n('executable'))} — `
        + `${(num('premiumBps') / 100).toFixed(2)}% apart`;
    case 'ScheduleSet':
      return `Schedule set: ${str('events')} print${num('events') === 1 ? '' : 's'} ahead`;
    case 'VaultCurated':
      return flag('curated') ? 'Listed on the desk' : 'Taken off the desk';
    case 'ParamsChanged':
      return 'Parameters changed';
    default:
      return e.name;
  }
}

/** For colouring a row: what sort of thing happened. */
export function kindOf(name: string): 'settle' | 'trade' | 'fill' | 'halt' | 'auction' | 'admin' {
  if (name === 'BoundarySettled' || name === 'JumpSettled' || name === 'Recapped') return 'settle';
  if (name === 'SharesMinted' || name === 'SharesRedeemed') return 'trade';
  if (name === 'HandoffFilled') return 'fill';
  if (name === 'VaultHalted' || name === 'VaultResumed') return 'halt';
  if (name.startsWith('Auction')) return 'auction';
  return 'admin';
}
