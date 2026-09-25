/* sdk/src/counterfactual.ts: the quote a keeper writes beside a cross's price.
   - it survives the trip through a memo, including the RPC's own formatting
     of the `memo` field;
   - anything malformed reads as no counterfactual, never a partial one;
   - the worst case still fits in a price_cross transaction;
   - edgeBps compares rates, to the hundredth of a basis point. */
import { readFileSync } from 'node:fs';
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  COUNTERFACTUAL_TAG, counterfactualMemoIx, edgeBps, encodeCounterfactual, MEMO_PROGRAM_ID, readCounterfactual,
  type Counterfactual,
} from '../sdk/src/counterfactual.ts';
import { decodeMarket, marketRef, priceCrossIx } from '../sdk/src/cross-ix.ts';

let failed = 0;
let passed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) passed++;
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const CROSS = 'GdN6aYz68FBYxmwjVVUbJ9PEXrsku5nsDj7S18uX7PAb';
const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const cf: Counterfactual = {
  cross: CROSS, at: 1_790_343_012, venue: 'jupiter', mint: NVDAX,
  buy: { in: '1000000000', out: '445120311', impactPct: 0.0021, route: 'Meteora DLMM > Whirlpool' },
  sell: { noRoute: 'Could not find any route' },
};

/* ── round trips ─────────────────────────────────────────────────────────── */

const text = encodeCounterfactual(cf);
check('encodes behind its tag', text.startsWith(COUNTERFACTUAL_TAG));
check('reads back what was written', same(readCounterfactual(text), cf), JSON.stringify(readCounterfactual(text)));
// getSignaturesForAddress formats memos as "[len] text", several joined by "; "
check('reads the RPC memo field', same(readCounterfactual(`[${text.length}] ${text}`), cf));
check('reads it among other memos', same(readCounterfactual(`[5] hello; [${text.length}] ${text}; [3] bye`), cf));
const braces = { ...cf, buy: { in: '1', out: '2', impactPct: 0, route: 'a } b { "c"' } } as Counterfactual;
check('braces and quotes inside a route do not end the object early', same(readCounterfactual(encodeCounterfactual(braces)), braces));
const oneSide: Counterfactual = { cross: CROSS, at: 1, venue: 'jupiter', mint: NVDAX, sell: { in: '300000000', out: '671000000', impactPct: 0.4, route: 'x' } };
check('a side with no orders stays absent', same(readCounterfactual(encodeCounterfactual(oneSide)), oneSide));

/* ── refusals ────────────────────────────────────────────────────────────── */

const bad = (name: string, memo: string | null | undefined) => check(`refuses ${name}`, readCounterfactual(memo) === null, String(memo).slice(0, 80));
const edit = (patch: Record<string, unknown>) => COUNTERFACTUAL_TAG + JSON.stringify({ ...cf, ...patch });
bad('no memo', null);
bad('an empty memo', '');
bad('another tag', text.replace('v1', 'v2'));
bad('a truncated object', text.slice(0, -3));
bad('JSON that is not JSON', COUNTERFACTUAL_TAG + '{"cross": nope}');
bad('a cross that is not base58', edit({ cross: 'not-a-key-0OIl' }));
bad('a mint that is not base58', edit({ mint: '' }));
bad('a fractional time', edit({ at: 1.5 }));
bad('a time as text', edit({ at: '1790343012' }));
bad('another venue', edit({ venue: 'raydium' }));
bad('an amount that is not digits', edit({ buy: { in: '1e9', out: '1', impactPct: 0, route: '' } }));
bad('a negative amount', edit({ buy: { in: '-5', out: '1', impactPct: 0, route: '' } }));
bad('an impact that is not a number', edit({ buy: { in: '5', out: '1', impactPct: 'high', route: '' } }));
bad('a quote that is neither', edit({ sell: { price: 1 } }));
bad('a quote that is null', edit({ sell: null }));

/* ── the transaction ─────────────────────────────────────────────────────── */

const ix = counterfactualMemoIx(cf);
check('memo instruction: the memo program', ix.programId.equals(MEMO_PROGRAM_ID));
check('memo instruction: no accounts to sign', ix.keys.length === 0);
check('memo instruction: the text, as UTF-8', new TextDecoder().decode(ix.data) === text);

// The largest memo readCounterfactual accepts: 20-digit amounts, 120-character routes.
const worst: Counterfactual = {
  cross: CROSS, at: 9_999_999_999, venue: 'jupiter', mint: NVDAX,
  buy: { in: '9'.repeat(20), out: '9'.repeat(20), impactPct: -0.123456789012345, route: 'r'.repeat(120) },
  sell: { in: '9'.repeat(20), out: '9'.repeat(20), impactPct: 0.123456789012345, route: 'r'.repeat(120) },
};
const doc = JSON.parse(readFileSync('tests/vectors/cross-accounts.json', 'utf8'));
const market = decodeMarket(Uint8Array.from(doc.market as number[]));
const ref = marketRef(new PublicKey(new Uint8Array(32).fill(9)), market);
const payer = Keypair.generate();
// the transaction keeper/src/cross-keeper.ts sends: a compute limit, the price, the memo
const tx = new Transaction({ feePayer: payer.publicKey, blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 0 })
  .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), priceCrossIx(ref, { day: 20_356, kind: 'open' }), counterfactualMemoIx(worst));
tx.sign(payer);
const size = tx.serialize().length;
check(`the worst case fits beside price_cross (${size} of 1232 bytes)`, size <= 1232);

/* ── edgeBps ─────────────────────────────────────────────────────────────── */

check('parity is 0', edgeBps(1_000n, 500n, 2_000n, 1_000n) === 0);
check('10 bp more out per unit in', edgeBps(1_000_000n, 1_001_000n, 1_000_000n, 1_000_000n) === 10);
check('worse is negative', edgeBps(1_000_000n, 999_000n, 1_000_000n, 1_000_000n) === -10);
check('rates, not totals: half the size at the same rate is parity', edgeBps(500n, 250n, 1_000n, 500n) === 0);
check('to the hundredth of a bp', edgeBps(1_000_000n, 1_000_123n, 1_000_000n, 1_000_000n) === 1.23);
check('nothing to compare is null', edgeBps(0n, 0n, 1n, 1n) === null && edgeBps(1n, 1n, 1n, 0n) === null);

if (failed) {
  console.log(`${failed} counterfactual check(s) failed`);
  process.exit(1);
}
console.log(`all counterfactual checks passed (${passed})`);
