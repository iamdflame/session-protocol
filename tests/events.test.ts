/* The event decoder must agree with the program's `emit!`.
 *
 * Two things can drift: the discriminator, if an event is renamed, and the
 * field order, if one is inserted. Both produce a ledger that reads plausibly
 * and is wrong, which is worse than one that fails — so both are checked
 * here, the discriminators against Anchor's own derivation and the layouts
 * against the declaration order in state.rs. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { EVENT_DISCRIMINATOR, decodeEvent, eventsFromLogs, describe, kindOf } from '../sdk/src/events.ts';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ' — ' + detail}`);
  if (!ok) failed++;
};

/* ── discriminators ──────────────────────────────────────────────────────── */

for (const [name, bytes] of Object.entries(EVENT_DISCRIMINATOR)) {
  const want = [...createHash('sha256').update(`event:${name}`).digest().subarray(0, 8)];
  check(`discriminator ${name}`, want.join() === bytes.join(), `${bytes} vs ${want}`);
}

/* ── every #[event] in the program is decodable ──────────────────────────── */

const src = readFileSync('programs/session/src/state.rs', 'utf8');
const declared = [...src.matchAll(/#\[event\]\s*pub struct (\w+)/g)].map(m => m[1]);
check(`every #[event] in state.rs has a decoder (${declared.length} found)`,
  declared.every(n => n in EVENT_DISCRIMINATOR),
  declared.filter(n => !(n in EVENT_DISCRIMINATOR)).join(', '));
check('and no decoder is for an event that no longer exists',
  Object.keys(EVENT_DISCRIMINATOR).every(n => declared.includes(n)),
  Object.keys(EVENT_DISCRIMINATOR).filter(n => !declared.includes(n)).join(', '));

/* ── field order, against the declaration in state.rs ────────────────────── */

const RENAME: Record<string, string> = {};                    // snake → camel is mechanical
const camel = (s: string) => RENAME[s] ?? s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

for (const name of declared) {
  const body = src.slice(src.indexOf(`pub struct ${name} {`));
  const inner = body.slice(body.indexOf('{') + 1, body.indexOf('\n}'));
  const rustFields = [...inner.matchAll(/^\s*pub (\w+):/gm)].map(m => camel(m[1]));

  // Build a body of the right length and decode it; the decoder reports the
  // names it read, in order.
  const SIZES: Record<string, number> = {
    VaultInitialized: 32 * 6 + 16 + 1 + 8,
    BoundarySettled: 32 + 8 + 8 + 1 + 16 * 3 + 8 * 2 + 16 * 2 + 8 * 2,
    SharesMinted: 32 * 2 + 1 + 8 * 2 + 16 + 8,
    SharesRedeemed: 32 * 2 + 1 + 8 * 2 + 16 + 8,
    HandoffFilled: 32 * 2 + 8 * 2 + 8 + 16 + 8 * 2,
    VaultHalted: 32 + 1 + 8 + 8,
    VaultResumed: 32 + 8 + 16 + 1,
    ParamsChanged: 32 * 2,
    SurplusSkimmed: 32 + 8 * 2,
    Recapped: 32 + 8 * 3 + 4 + 1 + 16 * 2 + 32 + 1 + 16 * 2 + 16 * 2,
    JumpSettled: 32 + 8 + 4 + 16 + 8,
    AuctionOpened: 32 * 2 + 8 * 2 + 1 + 8,
    AuctionBid: 32 * 2 + 8 * 3 + 4,
    AuctionCleared: 32 * 2 + 16 * 2 + 8 * 2 + 4,
    AuctionClaimed: 32 * 2 + 8 * 3,
    VaultCurated: 32 * 2 + 1 + 8,
    ScheduleSet: 32 * 2 + 1 + 8,
    DetectorPosted: 32 * 2 + 16 * 2 + 4 + 8,
  };
  const body2 = new Uint8Array(8 + (SIZES[name] ?? 512));
  body2.set(EVENT_DISCRIMINATOR[name], 0);
  const ev = decodeEvent(body2);
  check(`${name} decodes, and its fields are state.rs's in order`,
    !!ev && Object.keys(ev.fields).join() === rustFields.join(),
    ev ? `${Object.keys(ev.fields).join()} vs ${rustFields.join()}` : 'did not decode');
}

/* ── a real event, round-tripped ─────────────────────────────────────────── */

{
  // SharesMinted: vault, user, class=day, quoteIn=100e6, sharesOut=100e6, nav=WAD, ownedQuote=100e6
  const b = new Uint8Array(8 + 32 * 2 + 1 + 8 * 2 + 16 + 8);
  b.set(EVENT_DISCRIMINATOR.SharesMinted, 0);
  b.set(new Uint8Array(32).fill(7), 8);
  b.set(new Uint8Array(32).fill(9), 40);
  b[72] = 1;                                   // Class::Day
  const dv = new DataView(b.buffer);
  dv.setBigUint64(73, 100_000_000n, true);     // quoteIn
  dv.setBigUint64(81, 100_000_000n, true);     // sharesOut
  dv.setBigUint64(89, 10n ** 18n % (1n << 64n), true);
  dv.setBigUint64(97, 10n ** 18n >> 64n, true);
  dv.setBigUint64(105, 100_000_000n, true);    // ownedQuote

  const ev = decodeEvent(b)!;
  check('a real SharesMinted decodes', ev.name === 'SharesMinted');
  check('  class reads as day', ev.fields.class === 'day', String(ev.fields.class));
  check('  amounts read as u64', ev.fields.quoteIn === 100_000_000n);
  check('  nav reads as a u128 WAD', ev.fields.nav === 10n ** 18n, String(ev.fields.nav));
  check('  pubkeys decode', (ev.fields.vault as PublicKey).toBuffer()[0] === 7);
  check('  and it reads as a sentence',
    describe(ev, 6).startsWith('Minted 100 DAY for 100 quote'), describe(ev, 6));
  check('  with a kind for colouring', kindOf(ev.name) === 'trade');

  const b64 = Buffer.from(b).toString('base64');
  const found = eventsFromLogs([
    'Program 8gWC37 invoke [1]',
    'Program log: Instruction: MintShares',
    `Program data: ${b64}`,
    'Program data: bm90LW91cnM=',        // another program's data: skipped
    'Program 8gWC37 success',
  ]);
  check('events are pulled out of transaction logs', found.length === 1 && found[0].name === 'SharesMinted', String(found.length));
}

check('an unknown discriminator decodes to nothing rather than to nonsense',
  decodeEvent(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 0, 0])) === null);
check('a truncated event is refused', decodeEvent(Uint8Array.from([...EVENT_DISCRIMINATOR.SharesMinted, 1, 2, 3])) === null);

console.log(failed ? `\n${failed} failed` : '\nall event checks passed');
process.exit(failed ? 1 : 0);
