/* sdk/src/bell.ts against everything that can pin it:
   - the discriminators, recomputed the way Anchor computes them;
   - the print layout, from bytes the program's own serializer wrote;
   - the Pyth Pro codec, from messages Pyth's own encoder wrote;
   - the Ed25519 instruction, from Pyth's own offset arithmetic;
   - the bell times, from the program's rules.rs for every day of 2025-2027. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import {
  BELL_ACCOUNT, BELL_DISCRIMINATOR, BELL_PROGRAM_ID, PYTH_LAZER_PROGRAM_ID, PYTH_LAZER_STORAGE, PARAMS_V1,
  bellDeadline, bellTs, bellWindow, decimalPrice, decodePrint, ed25519Ix, encodeBellParams, encodeLazerMessage,
  encodeLazerPayload, etDay, LazerError, parseLazerMessage, parseLazerPayload, postPrintIxs, PRINT_LISTING_OFFSET,
  symbolBytes, verifierStoragePda, MIN_DAY, MAX_DAY, LAZER_DISCRIMINATOR, bellAccept, bellBetter, type LazerFeed,
} from '../sdk/src/bell.ts';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ' — ' + detail}`);
  if (!ok) failed++;
};
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

console.log('discriminators');
for (const [name, bytes] of Object.entries(BELL_DISCRIMINATOR)) {
  const want = [...createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)];
  check(`global:${name}`, want.join() === bytes.join(), `${bytes} vs ${want}`);
}
for (const [name, bytes] of Object.entries(LAZER_DISCRIMINATOR)) {
  const want = [...createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)];
  check(`lazer global:${name}`, want.join() === bytes.join(), `${bytes} vs ${want}`);
}
for (const [name, bytes] of Object.entries(BELL_ACCOUNT)) {
  const want = [...createHash('sha256').update(`account:${name}`).digest().subarray(0, 8)];
  check(`account:${name}`, want.join() === bytes.join(), `${bytes} vs ${want}`);
}

console.log('addresses');
check('Pyth storage is the verifier\'s ["storage"] PDA', verifierStoragePda(PYTH_LAZER_PROGRAM_ID).equals(PYTH_LAZER_STORAGE));
check('program id', BELL_PROGRAM_ID.toBase58() === 'BeLLKXJwhSH6YXYQLc8xLd11GxJUvoaT1h9zCadymJv4');

console.log('print layout (tests/vectors/print-account.json, from state.rs sample())');
{
  const doc = JSON.parse(readFileSync('tests/vectors/print-account.json', 'utf8'));
  const p = decodePrint(Uint8Array.from(doc.bytes as number[]));
  const eq = (name: string, got: unknown, want: unknown) => check(`${name} = ${want}`, String(got) === String(want), String(got));
  eq('status', p.status, 'final');
  eq('kind', p.kind, 'close');
  eq('flags', p.flags, 3);
  eq('simulated', p.simulated, true);
  eq('channel', p.channel, 3);
  eq('posts', p.posts, 7);
  eq('listing', p.listing.toBytes()[0], 1);
  eq('day', p.day, 20720);
  eq('bellTs', p.bellTs, 1790280000);
  eq('windowStartUs', p.windowStartUs, 1790279990000000n);
  eq('deadline', p.deadline, 1790280300);
  eq('equity.price', p.equity.price, 22406000000n);
  eq('equity.expo', p.equity.expo, -8);
  eq('equity.feedTsUs', p.equity.feedTsUs, 1790279999800000n);
  eq('rr.feedId', p.rr.feedId, 1832);
  eq('token.price', p.token.price, 22441000000n);
  eq('index.present', p.index.present, false);
  eq('index.session', p.index.session, 255);
  eq('divergenceBps', p.divergenceBps, -22n);
  eq('messageTsUs', p.messageTsUs, 1790280000000000n);
  eq('signer', p.signer.toBytes()[0], 2);
  eq('verifier', p.verifier.toBytes()[0], 3);
  eq('poster', p.poster.toBytes()[0], 4);
  eq('slot', p.slot, 412345678n);
  eq('finalizedAt', p.finalizedAt, 1790280301);
  const bytes = Uint8Array.from(doc.bytes as number[]);
  check('listing sits at PRINT_LISTING_OFFSET for memcmp filters', bytes[PRINT_LISTING_OFFSET] === 1 && bytes[PRINT_LISTING_OFFSET - 1] === 0);
}

console.log('pyth pro codec (tests/vectors/lazer.json, from Pyth\'s encoder)');
{
  const doc = JSON.parse(readFileSync('tests/vectors/lazer.json', 'utf8'));
  const n = (v: string | number | null) => (v === null ? null : typeof v === 'string' ? BigInt(v) : v);
  const same = (a: unknown, b: unknown) => String(a) === String(b);
  for (const c of doc.cases) {
    const raw = unhex(c.message);
    if (c.ok) {
      try {
        const m = parseLazerMessage(raw);
        const p = parseLazerPayload(m.payload);
        const fields: [keyof LazerFeed, string][] = [
          ['feedId', 'feed_id'], ['price', 'price'], ['bestBid', 'best_bid'], ['bestAsk', 'best_ask'],
          ['publishers', 'publishers'], ['exponent', 'exponent'], ['confidence', 'confidence'], ['session', 'session'],
          ['emaPrice', 'ema_price'], ['emaConfidence', 'ema_confidence'], ['feedTsUs', 'feed_ts_us'],
        ];
        const bad: string[] = [];
        if (hex(m.publicKey) !== doc.signer) bad.push('signer');
        if (!same(p.timestampUs, n(c.timestamp_us))) bad.push('timestamp');
        if (p.channel !== c.channel) bad.push('channel');
        if (p.feeds.length !== c.feeds.length) bad.push('feed count');
        p.feeds.forEach((f, i) => {
          for (const [k, j] of fields) if (!same(f[k], n(c.feeds[i][j]))) bad.push(`feed ${f.feedId} ${k}`);
        });
        check(c.name, bad.length === 0, bad.join(', '));

        // what the simulated poster encodes reads back the same
        const again = parseLazerPayload(encodeLazerPayload(p));
        const strip = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
        check(`  re-encoded: ${c.name}`, strip(again) === strip(p));
        check(`  re-wrapped: ${c.name}`, hex(encodeLazerMessage(m.signature, m.publicKey, m.payload)) === c.message);
      } catch (e) {
        check(c.name, false, String(e));
      }
    } else {
      let got = 'accepted';
      try {
        const m = parseLazerMessage(raw);
        if (c.layer === 'payload') parseLazerPayload(m.payload);
        else got = 'message accepted';
      } catch (e) {
        got = e instanceof LazerError ? e.code : `threw ${e}`;
      }
      check(`refuses: ${c.name} → ${c.error}`, got === c.error, got);
    }
  }

  const e = doc.ed25519;
  const msg = unhex(doc.cases[e.message_case].message);
  const edIx = ed25519Ix(msg, e.instruction_index, e.starting_offset);
  check('Ed25519 instruction bytes = Pyth\'s offsets for (message, 2, 12)', hex(edIx.data) === e.data, hex(edIx.data));

  // The post layout a poster sends: budget, Ed25519, post.
  const poster = new PublicKey(new Uint8Array(32).fill(5));
  const base = { poster, symbol: 'NVDA', day: 20720, kind: 'close' as const, message: msg,
    verifier: PYTH_LAZER_PROGRAM_ID, treasury: new PublicKey(new Uint8Array(32).fill(6)) };
  const three = postPrintIxs({ ...base, computeUnits: 400_000 });
  check('with a budget: three instructions', three.length === 3);
  check('  the Ed25519 instruction points at instruction 2', hex(three[1].data) === e.data);
  const post = three[2].data;
  check('  the message sits at byte 12 of the post', hex(post.subarray(12, 12 + msg.length)) === hex(msg));
  check('  and the post names the Ed25519 instruction as 1', post[post.length - 2] === 1 && post[post.length - 1] === 0);
  const two = postPrintIxs(base);
  check('without: two, Ed25519 first pointing at 1', two.length === 2 && two[0].data[4] === 1 && two[1].data[two[1].data.length - 2] === 0);
}

console.log('bell times (tests/vectors/bells.json, from rules.rs)');
{
  const doc = JSON.parse(readFileSync('tests/vectors/bells.json', 'utf8'));
  let bad = 0;
  let first = '';
  for (const [day, open, close] of doc.days as [number, number | null, number | null][]) {
    if (bellTs(day, 'open') !== open || bellTs(day, 'close') !== close) {
      bad++;
      first ||= `${day}: ${bellTs(day, 'open')}/${bellTs(day, 'close')} vs ${open}/${close}`;
    }
  }
  check(`bellTs agrees on all ${doc.days.length} days`, bad === 0, `${bad} differ, first ${first}`);
  check('no bell outside [MIN_DAY, MAX_DAY)', bellTs(MIN_DAY - 1, 'close') === null && bellTs(MAX_DAY, 'open') === null);
  check('etDay of the 24 Sep close is day 20720', etDay(1_790_280_000) === 20720);
  check('etDay of 00:30 UTC 25 Sep is still the 24th in New York', etDay(1_790_296_200) === 20720);
  const w = bellWindow(1_790_280_000, 'close');
  check('close window [15:59:50, 16:00:00]', w.startUs === 1_790_279_990_000_000n && w.endUs === 1_790_280_000_000_000n);
  const o = bellWindow(1_790_256_600, 'open');
  check('open window [09:30:00, 09:31:00]', o.startUs === 1_790_256_600_000_000n && o.endUs === 1_790_256_660_000_000n);
  check('deadlines: close + 300, open + 60 + 300', bellDeadline(1_790_280_000, 'close') === 1_790_280_300 && bellDeadline(1_790_256_600, 'open') === 1_790_256_960);
}

console.log('the rule (bellAccept mirrors rules::accept, case for case)');
{
  const close = 1_790_280_000;
  const w = bellWindow(close, 'close');
  const ts = w.endUs - 200_000n;
  const ok: LazerFeed = {
    feedId: 1314, price: 22_406_000_000n, bestBid: null, bestAsk: null, publishers: 9, exponent: -8,
    confidence: 1_100_000n, session: 0, emaPrice: null, emaConfidence: null, feedTsUs: ts,
  };
  check('a good close is accepted', bellAccept(ok, ts, w) === null);
  const cases: [Partial<LazerFeed>, string][] = [
    [{ price: null }, 'MissingProperty'], [{ price: -1n }, 'NonPositivePrice'],
    [{ exponent: null }, 'MissingProperty'], [{ exponent: -19 }, 'BadExponent'],
    [{ publishers: null }, 'MissingProperty'], [{ publishers: 0 }, 'TooFewPublishers'],
    [{ session: null }, 'MissingProperty'], [{ session: 2 }, 'NotRegularSession'],
    [{ confidence: null }, 'MissingProperty'], [{ confidence: -5n }, 'MissingProperty'],
    [{ confidence: 56_015_001n }, 'ConfidenceTooWide'], [{ feedTsUs: null }, 'MissingProperty'],
    [{ feedTsUs: w.endUs + 1n }, 'OutsideWindow'], [{ feedTsUs: w.startUs - 1n }, 'OutsideWindow'],
  ];
  for (const [patch, want] of cases) {
    const got = bellAccept({ ...ok, ...patch }, (patch.feedTsUs ?? ts) as bigint, w);
    check(`${JSON.stringify(patch, (_, v) => (typeof v === 'bigint' ? `${v}n` : v))} → ${want}`, got === want, String(got));
  }
  check('exactly 25 bps is in', bellAccept({ ...ok, confidence: 56_015_000n }, ts, w) === null);
  check('a feed newer than its message → FeedAfterMessage', bellAccept(ok, ts - 1n, w) === 'FeedAfterMessage');
  check('better: a later close, an earlier open, never an equal one',
    bellBetter('close', 5n, 6n) && !bellBetter('close', 6n, 6n) && bellBetter('open', 6n, 5n) && !bellBetter('open', 5n, 6n));
}

console.log('odds and ends');
check('params encode to 20 bytes', encodeBellParams(PARAMS_V1).length === 20);
check('decimalPrice 224.06', decimalPrice(22_406_000_000n, -8) === '224.06000000');
check('decimalPrice 0.005 and -0.005', decimalPrice(5n, -3) === '0.005' && decimalPrice(-5n, -3) === '-0.005');
check('decimalPrice positive exponent', decimalPrice(12n, 2) === '1200');
check('symbols: NVDA and BRK.B', symbolBytes('NVDA')[3] === 65 && symbolBytes('BRK.B')[5] === 0);
let threw = 0;
for (const s of ['', 'nvda', 'NV DA', 'ABCDEFGHIJKLMNOPQ']) { try { symbolBytes(s); } catch { threw++; } }
check('symbols the program refuses are refused', threw === 4);

if (failed) { console.error(`\n${failed} bell check(s) failed`); process.exit(1); }
console.log('\nall bell checks passed');
