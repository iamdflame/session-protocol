/* sdk/src/receipt.ts: what a receipt believes, and what it refuses to.
   - checkPrint re-verifies a real Ed25519 signature over a real post_print
     transaction, and notices a flipped byte or a print that differs from
     what was signed;
   - findCounterfactual takes the keeper's quote only from the transaction
     that priced the cross, and only when the keeper signed it;
   - the cross program's events decode, their discriminators are what
     Anchor computes, and a `Program data:` line written by any other
     program, even one session-cross called, is ignored;
   - ordersFromHistory adds up what each order was paid. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  ComputeBudgetProgram, Keypair, PublicKey, Transaction, type ConfirmedSignatureInfo, type Connection,
  type TransactionInstruction, type VersionedTransactionResponse,
} from '@solana/web3.js';
import nacl from 'tweetnacl';
import { encodeLazerMessage, encodeLazerPayload, postPrintIxs, type LazerFeed, type Print } from '../sdk/src/bell.ts';
import { counterfactualMemoIx, encodeCounterfactual, type Counterfactual } from '../sdk/src/counterfactual.ts';
import { CROSS_PROGRAM_ID, crossPda, decodeMarket, marketRef, priceCrossIx, type CrossAccount } from '../sdk/src/cross-ix.ts';
import {
  checkPrint, CROSS_EVENT, crossEventsFromLogs, decodeCrossEvent, findCounterfactual, ordersFromHistory,
} from '../sdk/src/receipt.ts';

let failed = 0;
let passed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) passed++;
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
};
const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));

/** A fetched transaction, as getTransaction returns it, from instructions. */
function fetched(ixs: TransactionInstruction[], payer: PublicKey, logs: string[] = []): VersionedTransactionResponse {
  const message = new Transaction({ feePayer: payer, blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 0 }).add(...ixs).compileMessage();
  return { slot: 1, blockTime: 0, transaction: { message, signatures: [] }, meta: { err: null, logMessages: logs } } as unknown as VersionedTransactionResponse;
}
/** A connection that serves a fixed history and fixed transactions. */
const mock = (sigs: Partial<ConfirmedSignatureInfo>[], txs: Record<string, VersionedTransactionResponse>) => ({
  getSignaturesForAddress: async () => sigs as ConfirmedSignatureInfo[],
  getTransaction: async (s: string) => txs[s] ?? null,
}) as unknown as Connection;

/* ── the print ──────────────────────────────────────────────────────────── */

const signer = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const feed: LazerFeed = {
  feedId: 1314, price: 22_406_000n, bestBid: null, bestAsk: null, publishers: 3, exponent: -5,
  confidence: 2_240n, session: 0, emaPrice: null, emaConfidence: null, feedTsUs: 1_790_343_000_123_000n,
};
const payload = encodeLazerPayload({ timestampUs: 1_790_343_000_200_000n, channel: 0, feeds: [feed] });
const message = encodeLazerMessage(nacl.sign.detached(payload, signer.secretKey), signer.publicKey, payload);
const poster = Keypair.generate().publicKey;
const postIxs = () => postPrintIxs({ poster, symbol: 'NVDA', day: 20_356, kind: 'open', message, verifier: key(3), treasury: key(4) });
const print = {
  slot: 555n, signer: new PublicKey(signer.publicKey), messageTsUs: 1_790_343_000_200_000n,
  equity: { present: true, feedId: 1314, price: 22_406_000n, conf: 2_240n, expo: -5, publishers: 3, session: 0, feedTsUs: 1_790_343_000_123_000n },
} as unknown as Print;
const inSlot = [{ signature: 'post', slot: 555, err: null }];

{
  const r = await checkPrint(mock(inSlot, { post: fetched(postIxs(), poster) }), key(5), print);
  check('a real print verifies here', 'verifiedHere' in r && r.verifiedHere, JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? String(v) : v)).slice(0, 200));
  check('and opens with the Ed25519 precompile', 'precompile' in r && r.precompile);
  check('and equals what the print stored', 'matchesPrint' in r && r.matchesPrint);
  check('and names its signer', 'signer' in r && r.signer === new PublicKey(signer.publicKey).toBase58());
}
{
  const ixs = postIxs();
  const post = ixs[ixs.length - 1];
  post.data[12 + 4 + 64 + 32 + 2 + 20] ^= 1; // one bit of the signed price
  const r = await checkPrint(mock(inSlot, { post: fetched(ixs, poster) }), key(5), print);
  check('one flipped bit fails the signature', 'verifiedHere' in r && !r.verifiedHere);
  check('and no longer matches the print', 'matchesPrint' in r && !r.matchesPrint);
}
{
  const other = { ...print, equity: { ...print.equity, price: 22_406_001n } } as unknown as Print;
  const r = await checkPrint(mock(inSlot, { post: fetched(postIxs(), poster) }), key(5), other);
  check('a print that differs from the signed feed is caught', 'matchesPrint' in r && !r.matchesPrint && r.verifiedHere);
}
{
  const r = await checkPrint(mock([{ signature: 'post', slot: 554, err: null }], { post: fetched(postIxs(), poster) }), key(5), print);
  check('no post in the recorded slot is unavailable, not a pass', 'missing' in r && r.missing === 'unavailable');
  const refused = { getSignaturesForAddress: async () => { throw new Error('429 Too Many Requests'); } } as unknown as Connection;
  const r2 = await checkPrint(refused, key(5), print);
  check('an RPC refusal is unavailable, with the reason', 'missing' in r2 && r2.missing === 'unavailable' && /429/.test(r2.why ?? ''));
  const missingPrint = { ...print, equity: { ...print.equity, present: false } } as unknown as Print;
  const r3 = await checkPrint(mock(inSlot, {}), key(5), missingPrint);
  check('a missing print has nothing to verify', 'missing' in r3 && r3.missing === 'none');
}

/* ── the counterfactual ─────────────────────────────────────────────────── */

const doc = JSON.parse(readFileSync('tests/vectors/cross-accounts.json', 'utf8'));
const ref = marketRef(key(9), decodeMarket(Uint8Array.from(doc.market as number[])));
const cross = crossPda(ref.market, 20_356, 'open');
const keeper = Keypair.generate().publicKey;
const cf: Counterfactual = {
  cross: cross.toBase58(), at: 1_790_343_012, venue: 'jupiter', mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh',
  buy: { in: '1000000000', out: '445120311', impactPct: 0.0021, route: 'Meteora DLMM' },
};
const memo = `[${encodeCounterfactual(cf).length}] ${encodeCounterfactual(cf)}`;
const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
const priced = { pricedAt: 1_790_343_600 } as CrossAccount;
const hist = (sig: string) => [{ signature: sig, slot: 1, err: null, memo, blockTime: 1_790_343_600 }] as ConfirmedSignatureInfo[];

{
  const tx = fetched([cu, priceCrossIx(ref, { day: 20_356, kind: 'open' }), counterfactualMemoIx(cf)], keeper);
  const r = await findCounterfactual(mock([], { p: tx }), cross, priced, hist('p'), keeper.toBase58());
  check('the keeper\'s quote in the pricing transaction is shown', 'cf' in r && r.cf.cross === cf.cross && r.signature === 'p', JSON.stringify(r).slice(0, 160));
}
{
  const stranger = Keypair.generate().publicKey;
  const tx = fetched([cu, priceCrossIx(ref, { day: 20_356, kind: 'open' }), counterfactualMemoIx(cf)], stranger);
  const r = await findCounterfactual(mock([], { p: tx }), cross, priced, hist('p'), keeper.toBase58());
  check('the same quote from anyone else is untrusted, and says who', 'untrusted' in r && r.untrusted === stranger.toBase58());
}
{
  // a memo beside some other instruction, in a transaction that touches the cross
  const tx = fetched([counterfactualMemoIx(cf)], keeper);
  const r = await findCounterfactual(mock([], { p: tx }), cross, priced, hist('p'), keeper.toBase58());
  check('a memo outside the pricing transaction is not a counterfactual', 'missing' in r && r.missing === 'none');
}
{
  const other = crossPda(ref.market, 20_357, 'open');
  const tx = fetched([cu, priceCrossIx(ref, { day: 20_357, kind: 'open' }), counterfactualMemoIx(cf)], keeper);
  const r = await findCounterfactual(mock([], { p: tx }), cross, priced, hist('p'), keeper.toBase58());
  check('pricing another cross does not count', 'missing' in r && other.toBase58() !== cross.toBase58());
}
{
  const tx = fetched([priceCrossIx(ref, { day: 20_356, kind: 'open' })], keeper);
  const noMemo = [{ signature: 'p', slot: 1, err: null, memo: null, blockTime: 1_790_343_600 }] as ConfirmedSignatureInfo[];
  const r = await findCounterfactual(mock([], { p: tx }), cross, priced, noMemo, keeper.toBase58());
  check('priced without a quote: none, found by block time', 'missing' in r && r.missing === 'none' && /carries no swap quote/.test(r.why ?? ''));
  const r2 = await findCounterfactual(mock([], {}), cross, { pricedAt: 0 } as CrossAccount, noMemo, keeper.toBase58());
  check('not priced yet: none', 'missing' in r2 && r2.missing === 'none');
  const r3 = await findCounterfactual(mock([], {}), cross, priced, [], keeper.toBase58());
  check('a history without the price is unavailable, not none', 'missing' in r3 && r3.missing === 'unavailable');
}

/* ── events ─────────────────────────────────────────────────────────────── */

for (const [name, disc] of Object.entries(CROSS_EVENT)) {
  const want = [...createHash('sha256').update(`event:${name}`).digest().subarray(0, 8)];
  check(`event:${name}`, want.join() === disc.join(), `${disc} vs ${want}`);
}

const u64 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b; };
const cat = (...parts: (Uint8Array | readonly number[])[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const [owner, order] = [key(11), key(12)];
const placed = cat(CROSS_EVENT.OrderPlaced, cross.toBytes(), order.toBytes(), owner.toBytes(), u64(20_356n), [0], [0], u64(5_000_000n), u64(0n));
const settled = (quote: bigint, raw: bigint) => cat(CROSS_EVENT.OrderSettled, cross.toBytes(), order.toBytes(), owner.toBytes(), u64(quote), u64(raw));
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

{
  const e = decodeCrossEvent(placed);
  check('OrderPlaced decodes', !!e && e.name === 'OrderPlaced' && e.amount === 5_000_000n && e.side === 'buy' && e.kind === 'open' && e.day === 20_356 && e.owner.equals(owner));
  const s = decodeCrossEvent(settled(12n, 2_231_000n));
  check('OrderSettled decodes', !!s && s.name === 'OrderSettled' && s.quote === 12n && s.raw === 2_231_000n);
  check('a truncated event is refused', decodeCrossEvent(placed.subarray(0, placed.length - 1)) === null);
  check('a padded event is refused', decodeCrossEvent(cat(placed, [0])) === null);
  check('an unknown discriminator is refused', decodeCrossEvent(cat([1, 2, 3, 4, 5, 6, 7, 8], placed.subarray(8))) === null);
}

const X = CROSS_PROGRAM_ID.toBase58();
const EVIL = key(66).toBase58();
{
  const logs = [
    `Program ${X} invoke [1]`, 'Program log: Instruction: PlaceOrder',
    'Program 11111111111111111111111111111111 invoke [2]', 'Program 11111111111111111111111111111111 success',
    `Program data: ${b64(placed)}`, `Program ${X} consumed 20000 of 200000 compute units`, `Program ${X} success`,
  ];
  const ev = crossEventsFromLogs(logs);
  check('an event session-cross wrote counts', ev.length === 1 && ev[0].name === 'OrderPlaced');
  const forged = [`Program ${EVIL} invoke [1]`, `Program data: ${b64(settled(9_999_999_999n, 0n))}`, `Program ${EVIL} success`];
  check('the same bytes from another program do not', crossEventsFromLogs(forged).length === 0);
  const nested = [`Program ${X} invoke [1]`, `Program ${EVIL} invoke [2]`, `Program data: ${b64(settled(9_999_999_999n, 0n))}`, `Program ${EVIL} success`, `Program ${X} success`];
  check('nor from a program session-cross called', crossEventsFromLogs(nested).length === 0);
  const after = [`Program ${X} invoke [1]`, `Program ${X} success`, `Program data: ${b64(placed)}`];
  check('nor after session-cross returned', crossEventsFromLogs(after).length === 0);
}

/* ── orders, from history ───────────────────────────────────────────────── */

{
  const ev = (bytes: Uint8Array) => [`Program ${X} invoke [1]`, `Program data: ${b64(bytes)}`, `Program ${X} success`];
  const noop = fetched([cu], keeper);
  const withLogs = (logs: string[]) => ({ ...noop, meta: { err: null, logMessages: logs } }) as unknown as VersionedTransactionResponse;
  const history = [ // newest first, as getSignaturesForAddress returns it
    { signature: 'forged', err: null }, { signature: 's2', err: null }, { signature: 's1', err: null }, { signature: 'p', err: null },
  ] as ConfirmedSignatureInfo[];
  const txs = {
    p: withLogs(ev(placed)),
    s1: withLogs(ev(settled(0n, 1_000n))), // the token leg alone, after a pause
    s2: withLogs(ev(settled(7n, 0n))),
    forged: withLogs([`Program ${EVIL} invoke [1]`, `Program data: ${b64(settled(9_999_999_999n, 0n))}`, `Program ${EVIL} success`]),
  };
  const r = await ordersFromHistory(mock([], txs), cross, history);
  const o = r.orders[0];
  check('one order, placed and paid twice', r.orders.length === 1 && o.placed === 'p' && o.outcome === 'settled', JSON.stringify(r.orders, (_, v) => (typeof v === 'bigint' ? String(v) : v)));
  check('its payouts sum both legs and ignore the forgery', o.quote === 7n && o.raw === 1_000n && r.complete);
  const theirs = await ordersFromHistory(mock([], txs), cross, history, { owner: key(99) });
  check('filtered to another owner, nothing', theirs.orders.length === 0);
  const gap = await ordersFromHistory(mock([], { p: txs.p }), cross, history);
  check('a transaction the RPC would not serve makes it incomplete', !gap.complete && gap.orders.length === 1);
}

if (failed) {
  console.log(`${failed} receipt check(s) failed`);
  process.exit(1);
}
console.log(`all receipt checks passed (${passed})`);
