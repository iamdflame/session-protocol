/* ───────────────────────────────────────────────────────────────────────────
   The bell poster: put each NYSE open and close on chain, then freeze it.

   One pipeline, two sources. For every bell it collects candidate messages,
   keeps the one the rule prefers (`bellAccept`, `bellBetter` — the program's
   own rule, ported and pinned by tests/bell.test.ts), posts it behind Pyth's
   Ed25519 instruction, and once the deadline has passed finalises the print,
   or marks the bell missing if nothing qualified.

   --simulate  Key-free, for the devnet sandbox. The candidate is built here:
               Jupiter's reference price for the share (price v3 stockData),
               stamped with Jupiter's own update time, and the xStock's USD
               price beside it, signed by the test key the devnet verifier
               trusts. Jupiter reports no publisher count and no confidence,
               so those are placeholders: 1 publisher (one source) and 1 bp.
               The program flags every such print simulated, forever.
   (default)   Pyth Pro: the candidates are Pyth's own signed messages, from a
               subscription per listing (PYTH_PRO_TOKEN and
               @pythnetwork/pyth-lazer-sdk@7). Written, not yet run: there is
               no Pyth Pro key.

   Every observation, post and action is written to data/bell-poster.db.

     npm run bell:poster -- --simulate           run until stopped (the service)
     npm run bell:poster -- --simulate --once    the next bell, then exit
     npm run bell:poster -- --simulate --rehearse
                                                 build the next bell's post and
                                                 simulate it on devnet; sends nothing
     npm run bell:poster -- --status             what the chain and the log say
   ─────────────────────────────────────────────────────────────────────────── */

import { createPrivateKey, sign as edSign } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  BELL_ACCOUNT, BELL_PROGRAM_ID, bellAccept, bellBetter, bellNotFromTheFuture, bellConfigPda, bellDeadline, bellTs, bellWindow,
  decimalPrice, decodeBellConfig, decodeLazerStorage, decodeListing, decodePrint, encodeLazerMessage,
  encodeLazerPayload, etDay, finalizePrintIx, listingPda, markMissingIx, parseLazerMessage, parseLazerPayload,
  postPrintIxs, printPda, PRINT_LISTING_OFFSET, SESSION, type BellConfig, type BellKind, type LazerFeed,
  type Listing,
} from '../../sdk/src/bell.ts';
import bs58 from 'bs58';
import { parseSecret } from './wallet.ts';

const RPC = process.env.DEVNET_RPC ?? 'https://api.devnet.solana.com';
const JUP = 'https://lite-api.jup.ag';
const DB_PATH = 'data/bell-poster.db';
const MANIFEST = 'web/public/bell-devnet.json';
const POST_CU = 150_000; // a post measures 74,584 CU in tests/integration
const POLL_MS = 5_000;

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { stopping = true; log(`${sig}: stopping after this step`); });

/* ── the log ─────────────────────────────────────────────────────────────── */

mkdirSync('data', { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS observations (
    observed_ms INTEGER NOT NULL, symbol TEXT NOT NULL, source TEXT NOT NULL,
    price REAL, price_ts_ms INTEGER, token_price REAL, raw TEXT,
    PRIMARY KEY (observed_ms, symbol, source));
  CREATE TABLE IF NOT EXISTS posts (
    ts_ms INTEGER NOT NULL, symbol TEXT NOT NULL, day INTEGER NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL,
    feed_ts_us TEXT, price TEXT, expo INTEGER, signature TEXT, outcome TEXT NOT NULL, error TEXT);
  CREATE TABLE IF NOT EXISTS actions (
    ts_ms INTEGER NOT NULL, symbol TEXT NOT NULL, day INTEGER NOT NULL, kind TEXT NOT NULL, action TEXT NOT NULL,
    signature TEXT, outcome TEXT NOT NULL, error TEXT);
`);
const insObs = db.prepare('INSERT OR REPLACE INTO observations VALUES (?, ?, ?, ?, ?, ?, ?)');
const insPost = db.prepare('INSERT INTO posts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const insAction = db.prepare('INSERT INTO actions VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

/* ── the chain ───────────────────────────────────────────────────────────── */

const conn = new Connection(RPC, 'confirmed');
const loadKey = (p: string) => parseSecret(readFileSync(p, 'utf8')).keypair;

interface Ctx {
  config: BellConfig;
  treasury: PublicKey;
  listings: { symbol: string; mint: string; account: Listing }[];
}

async function context(): Promise<Ctx> {
  const cfgInfo = await conn.getAccountInfo(bellConfigPda()[0]);
  if (!cfgInfo) throw new Error('no bell config on this cluster: run npm run bell:devnet -- --apply');
  const config = decodeBellConfig(cfgInfo.data);
  const st = await conn.getAccountInfo(config.verifierStorage);
  if (!st) throw new Error(`verifier storage ${config.verifierStorage.toBase58()} missing`);
  const treasury = decodeLazerStorage(st.data).treasury;
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { listings: { symbol: string; mint: string }[] };
  const infos = await conn.getMultipleAccountsInfo(manifest.listings.map((l) => listingPda(l.symbol)[0]));
  const listings = manifest.listings.flatMap((l, i) => {
    const info = infos[i];
    return info ? [{ symbol: l.symbol, mint: l.mint, account: decodeListing(info.data) }] : [];
  });
  return { config, treasury, listings };
}

/* ── bells ───────────────────────────────────────────────────────────────── */

interface Bell { day: number; kind: BellKind; ts: number }

/** Bells from `fromDay` onward, in time order. */
function bellsFrom(fromDay: number, count: number): Bell[] {
  const out: Bell[] = [];
  for (let d = fromDay; out.length < count && d < fromDay + 30; d++) {
    for (const kind of ['open', 'close'] as const) {
      const ts = bellTs(d, kind);
      if (ts !== null) out.push({ day: d, kind, ts });
    }
  }
  return out.slice(0, count);
}

/** The next bell whose window has not yet ended. */
function nextBell(now: number, cfg: BellConfig): Bell {
  const w = (b: Bell) => Number(bellWindow(b.ts, b.kind, cfg.params).endUs / 1_000_000n);
  return bellsFrom(etDay(now) - 1, 8).find((b) => w(b) > now)!;
}

/* ── candidates ──────────────────────────────────────────────────────────── */

interface Candidate {
  symbol: string;
  message: Uint8Array;
  feed: LazerFeed;
  source: string;
}

/** Keeps, per symbol, the candidate the rule prefers. */
class Book {
  readonly best = new Map<string, Candidate>();
  readonly bell: Bell;
  constructor(bell: Bell) { this.bell = bell; }
  offer(c: Candidate): boolean {
    const had = this.best.get(c.symbol);
    if (had && !bellBetter(this.bell.kind, had.feed.feedTsUs!, c.feed.feedTsUs!)) return false;
    this.best.set(c.symbol, c);
    return true;
  }
}

/* The simulated source. */

const PKCS8_ED25519 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

function testSigner(): { publicKey: Uint8Array; sign: (m: Uint8Array) => Uint8Array } {
  const kp = loadKey('keeper/.devnet/bell-signer.json');
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, kp.secretKey.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
  return { publicKey: kp.publicKey.toBytes(), sign: (m) => new Uint8Array(edSign(null, m, key)) };
}

/** A decimal to a Pyth mantissa at `expo`, through the decimal string, not float scaling. */
function mantissa(x: number, expo: number): bigint {
  const [int, frac = ''] = x.toFixed(Math.min(-expo + 2, 20)).split('.');
  const places = -expo;
  const digits = int + frac.padEnd(places + 1, '0').slice(0, places);
  const round = Number(frac[places] ?? '0') >= 5 ? 1n : 0n;
  return BigInt(digits) + (x < 0 ? -round : round);
}

interface JupPrice {
  usdPrice?: number;
  stockData?: { price?: number; updatedAt?: string };
}

async function jupiter(mints: string[]): Promise<Record<string, JupPrice>> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${JUP}/price/v3?ids=${mints.join(',')}`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) return (await res.json()) as Record<string, JupPrice>;
    if (attempt >= 3) throw new Error(`jupiter price v3: HTTP ${res.status}`);
    await sleep(res.status === 429 ? 3_000 * attempt : 1_000);
  }
}

/** One poll: a signed simulated candidate per listing whose price is fresh. */
async function simulatedCandidates(ctx: Ctx, signer: ReturnType<typeof testSigner>): Promise<Candidate[]> {
  const observed = Date.now();
  const prices = await jupiter(ctx.listings.map((l) => l.mint));
  const out: Candidate[] = [];
  for (const l of ctx.listings) {
    const p = prices[l.mint];
    const stock = p?.stockData?.price;
    const stampedMs = p?.stockData?.updatedAt ? Date.parse(p.stockData.updatedAt) : NaN;
    insObs.run(observed, l.symbol, 'jupiter', stock ?? null, Number.isFinite(stampedMs) ? stampedMs : null, p?.usdPrice ?? null, JSON.stringify(p ?? null));
    if (!stock || !Number.isFinite(stampedMs)) continue;

    const price = mantissa(stock, -5);
    const equity: LazerFeed = {
      feedId: l.account.equityFeed, price, bestBid: null, bestAsk: null,
      publishers: 1, exponent: -5, confidence: price / 10_000n > 0n ? price / 10_000n : 1n,
      session: 0, emaPrice: null, emaConfidence: null, feedTsUs: BigInt(stampedMs) * 1000n,
    };
    const feeds = [equity];
    if (l.account.tokenFeed && p?.usdPrice) {
      feeds.push({
        feedId: l.account.tokenFeed, price: mantissa(p.usdPrice, -8), bestBid: null, bestAsk: null,
        publishers: null, exponent: -8, confidence: null, session: null, emaPrice: null, emaConfidence: null,
        feedTsUs: BigInt(observed) * 1000n,
      });
    }
    const messageTsUs = BigInt(Math.max(observed, stampedMs)) * 1000n;
    // channel 0: no Pyth channel delivered this
    const payload = encodeLazerPayload({ timestampUs: messageTsUs, channel: 0, feeds });
    const message = encodeLazerMessage(signer.sign(payload), signer.publicKey, payload);
    out.push({ symbol: l.symbol, message, feed: equity, source: 'simulated:jupiter' });
  }
  return out;
}

/* The Pyth Pro source. Written against @pythnetwork/pyth-lazer-sdk 7.0.0 and
   not yet run: it needs a Pyth Pro token. */

async function pythProStream(ctx: Ctx, onCandidate: (c: Candidate) => void): Promise<() => void> {
  const token = process.env.PYTH_PRO_TOKEN;
  if (!token) throw new Error('live mode needs PYTH_PRO_TOKEN; without one, run --simulate');
  let sdk: any;
  try {
    sdk = await import('@pythnetwork/pyth-lazer-sdk' as string);
  } catch {
    throw new Error('live mode needs the Pyth Pro SDK: npm i @pythnetwork/pyth-lazer-sdk@7.0.0');
  }
  const client = await sdk.PythLazerClient.create({ token, webSocketPoolConfig: {} });
  const bySub = new Map<number, (typeof ctx.listings)[number]>();
  client.addMessageListener((m: any) => {
    if (m?.type !== 'json' || m.value?.type !== 'streamUpdated' || !m.value.solana?.data) return;
    const l = bySub.get(m.value.subscriptionId);
    if (!l) return;
    const message = Uint8Array.from(Buffer.from(m.value.solana.data, 'hex'));
    const payload = parseLazerPayload(parseLazerMessage(message).payload);
    const feed = payload.feeds.find((f) => f.feedId === l.account.equityFeed);
    if (feed?.feedTsUs != null) onCandidate({ symbol: l.symbol, message, feed, source: 'pyth-pro' });
  });
  ctx.listings.forEach((l, i) => {
    bySub.set(i + 1, l);
    const a = l.account;
    client.subscribe({
      type: 'subscribe', subscriptionId: i + 1,
      priceFeedIds: [a.equityFeed, a.rrFeed, a.tokenFeed, a.indexFeed].filter(Boolean),
      properties: ['price', 'confidence', 'exponent', 'publisherCount', 'marketSession', 'feedUpdateTimestamp'],
      formats: ['solana'], deliveryFormat: 'json', jsonBinaryEncoding: 'hex', parsed: false,
      channel: 'fixed_rate@200ms', ignoreInvalidFeedIds: true,
    });
  });
  return () => client.shutdown?.();
}

/* ── posting ─────────────────────────────────────────────────────────────── */

const poster = (): Keypair => loadKey(process.env.BELL_POSTER_KEYPAIR ?? 'keeper/.devnet/bell-poster.json');

/** The program's own name for a refusal, from the logs a failed send carries. */
const refusal = (e: unknown): string | null => {
  const x = e as { logs?: string[]; transactionLogs?: string[] };
  const text = [...(x?.logs ?? []), ...(x?.transactionLogs ?? []), String(e)].join('\n');
  const m = /Error Code: (\w+)/.exec(text);
  return m ? m[1] : null;
};

async function post(ctx: Ctx, bell: Bell, c: Candidate, deadline: number): Promise<void> {
  const payer = poster();
  const ixs = postPrintIxs({
    poster: payer.publicKey, symbol: c.symbol, day: bell.day, kind: bell.kind, message: c.message,
    verifier: ctx.config.verifier, treasury: ctx.treasury, computeUnits: POST_CU,
  });
  const price = c.feed.price!;
  for (let attempt = 1; Date.now() / 1000 < deadline && !stopping; attempt++) {
    try {
      const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [payer], { commitment: 'confirmed' });
      insPost.run(Date.now(), c.symbol, bell.day, bell.kind, c.source, String(c.feed.feedTsUs), String(price), c.feed.exponent, sig, 'confirmed', null);
      log(`  posted ${c.symbol} ${bell.kind} ${decimalPrice(price, c.feed.exponent!)} from ${new Date(Number(c.feed.feedTsUs! / 1000n)).toISOString().slice(11, 23)}  ${sig}`);
      return;
    } catch (e) {
      const code = refusal(e);
      insPost.run(Date.now(), c.symbol, bell.day, bell.kind, c.source, String(c.feed.feedTsUs), String(price), c.feed.exponent, null, code ? 'refused' : 'error', code ?? String(e).slice(0, 500));
      if (code) { log(`  ${c.symbol}: refused, ${code}`); return; }
      log(`  ${c.symbol}: attempt ${attempt} failed: ${String(e).slice(0, 160)}`);
      if (attempt >= 5) return;
      await sleep(2_000 * attempt);
    }
  }
}

/** Finalise what is due and mark missing what never came, for recent bells. */
async function settle(ctx: Ctx): Promise<void> {
  const now = Date.now() / 1000;
  const payer = poster();
  const bells = bellsFrom(etDay(now) - 7, 16).filter((b) => bellDeadline(b.ts, b.kind, ctx.config.params) <= now);
  for (const l of ctx.listings) {
    if (!l.account.active) continue;
    const due = bells.filter((b) => b.ts >= l.account.activeSince);
    const addrs = due.map((b) => printPda(listingPda(l.symbol)[0], b.day, b.kind)[0]);
    const infos = addrs.length ? await conn.getMultipleAccountsInfo(addrs) : [];
    for (const [i, b] of due.entries()) {
      const info = infos[i];
      const action = !info ? 'mark_missing' : decodePrint(info.data).status === 'provisional' ? 'finalize' : null;
      if (!action || stopping) continue;
      const ix = action === 'finalize'
        ? finalizePrintIx({ symbol: l.symbol, day: b.day, kind: b.kind })
        : markMissingIx({ caller: payer.publicKey, symbol: l.symbol, day: b.day, kind: b.kind });
      try {
        const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer], { commitment: 'confirmed' });
        insAction.run(Date.now(), l.symbol, b.day, b.kind, action, sig, 'confirmed', null);
        log(`  ${action} ${l.symbol} ${b.kind} day ${b.day}  ${sig}`);
      } catch (e) {
        insAction.run(Date.now(), l.symbol, b.day, b.kind, action, null, 'error', refusal(e) ?? String(e).slice(0, 500));
        log(`  ${action} ${l.symbol} ${b.kind} day ${b.day} failed: ${refusal(e) ?? String(e).slice(0, 160)}`);
      }
    }
  }
}

/* ── one bell ────────────────────────────────────────────────────────────── */

async function runBell(ctx: Ctx, bell: Bell, simulate: boolean): Promise<void> {
  const p = ctx.config.params;
  const w = bellWindow(bell.ts, bell.kind, p);
  const [startS, endS] = [Number(w.startUs / 1_000_000n), Number(w.endUs / 1_000_000n)];
  const deadline = bellDeadline(bell.ts, bell.kind, p);
  const book = new Book(bell);
  const posted = new Set<string>();
  log(`${bell.kind} of day ${bell.day} at ${new Date(bell.ts * 1000).toISOString()}: window ${new Date(startS * 1000).toISOString().slice(11, 19)}–${new Date(endS * 1000).toISOString().slice(11, 19)}, deadline ${new Date(deadline * 1000).toISOString().slice(11, 19)}`);

  const consider = (c: Candidate): void => {
    const payload = parseLazerPayload(parseLazerMessage(c.message).payload);
    const why = bellAccept(c.feed, payload.timestampUs, w, p);
    if (why === null && bellNotFromTheFuture(c.feed.feedTsUs!, Date.now() / 1000)) book.offer(c);
  };

  // an open is posted the moment its first price is in; a close once its window is over
  const postReady = async (final: boolean) => {
    for (const [symbol, c] of book.best) {
      if (posted.has(symbol)) continue;
      if (bell.kind === 'close' && !final) continue;
      posted.add(symbol);
      await post(ctx, bell, c, deadline);
    }
  };

  let stop: (() => void) | null = null;
  if (!simulate) stop = await pythProStream(ctx, consider);
  const signer = simulate ? testSigner() : null;
  await sleep((startS - 10) * 1000 - Date.now());
  const until = (endS + (simulate ? 30 : 5)) * 1000;
  while (!stopping && Date.now() < until) {
    if (signer) {
      try {
        for (const c of await simulatedCandidates(ctx, signer)) consider(c);
      } catch (e) {
        log(`  poll failed: ${String(e).slice(0, 160)}`);
      }
    }
    if (bell.kind === 'open') await postReady(false);
    if (ctx.listings.every((l) => posted.has(l.symbol))) break;
    await sleep(POLL_MS);
  }
  stop?.();
  await postReady(true);
  const missing = ctx.listings.filter((l) => !book.best.has(l.symbol)).map((l) => l.symbol);
  if (missing.length) log(`  no qualifying price for ${missing.join(', ')}: marked missing after the deadline unless one arrives`);
}

/* ── status ──────────────────────────────────────────────────────────────── */

async function status(): Promise<void> {
  const ctx = await context();
  const c = ctx.config;
  console.log(`bell ${BELL_PROGRAM_ID.toBase58()} on ${RPC}`);
  console.log(`  verifier ${c.verifier.toBase58()}  ${c.simulated ? 'SIMULATED SIGNER' : "Pyth's own program"}`);
  console.log(`  rule v${c.params.methodVersion}: close ${c.params.closeLeadSecs}s lead, open ${c.params.openWindowSecs}s window, ${c.params.minPublishers}+ publishers, ≤${c.params.maxConfBps} bp confidence, final ${c.params.finalizeAfterSecs}s after the window`);
  const disc = Uint8Array.from(BELL_ACCOUNT.Print);
  for (const l of ctx.listings) {
    const accts = await conn.getProgramAccounts(BELL_PROGRAM_ID, {
      filters: [
        { memcmp: { offset: 0, bytes: bs58.encode(disc) } },
        { memcmp: { offset: PRINT_LISTING_OFFSET, bytes: listingPda(l.symbol)[0].toBase58() } },
      ],
    });
    const prints = accts.map((a) => decodePrint(a.account.data)).sort((a, b) => b.bellTs - a.bellTs);
    console.log(`\n  ${l.symbol.padEnd(5)} ${Number(l.account.prints)} print(s), ${Number(l.account.missing)} missing, active since ${new Date(l.account.activeSince * 1000).toISOString()}`);
    for (const p of prints.slice(0, 6)) {
      const e = p.equity;
      const lag = e.present ? `${(Number(e.feedTsUs) / 1e3 - p.bellTs * 1e3).toFixed(0)} ms from the bell` : '';
      console.log(`    ${new Date(p.bellTs * 1000).toISOString().slice(0, 16)}Z ${p.kind.padEnd(5)} ${p.status.padEnd(11)} ${e.present ? decimalPrice(e.price, e.expo).padStart(14) : '—'.padStart(14)}  ${lag}  ${e.present ? SESSION[e.session] ?? '' : ''}${p.simulated ? '  simulated' : ''}`);
    }
  }
  const recent = db.prepare('SELECT ts_ms, symbol, day, kind, outcome, error FROM posts ORDER BY ts_ms DESC LIMIT 8').all() as Record<string, unknown>[];
  if (recent.length) {
    console.log('\n  recent posts (data/bell-poster.db):');
    for (const r of recent) console.log(`    ${new Date(Number(r.ts_ms)).toISOString().slice(0, 19)}  ${r.symbol} ${r.kind} day ${r.day}  ${r.outcome}${r.error ? ` (${String(r.error).slice(0, 80)})` : ''}`);
  }
}

/* ── rehearsal ───────────────────────────────────────────────────────────── */

/** Build the next bell's post from a live observation re-stamped into that
 *  bell's window, and ask devnet to simulate it. Nothing is sent. A test key
 *  can date a message in the future, which is what makes this possible; a
 *  program with the FeedFromTheFuture guard refuses it there, after the
 *  layout, the parse and the rule have all been checked. */
async function rehearse(ctx: Ctx): Promise<void> {
  const bell = nextBell(Date.now() / 1000, ctx.config);
  const w = bellWindow(bell.ts, bell.kind, ctx.config.params);
  const signer = testSigner();
  const l = ctx.listings[0];
  const p = (await jupiter([l.mint]))[l.mint];
  const ts = bell.kind === 'close' ? w.endUs - 1_000_000n : w.startUs + 1_000_000n;
  const price = mantissa(p.stockData!.price!, -5);
  const feed: LazerFeed = {
    feedId: l.account.equityFeed, price, bestBid: null, bestAsk: null, publishers: 1, exponent: -5,
    confidence: price / 10_000n, session: 0, emaPrice: null, emaConfidence: null, feedTsUs: ts,
  };
  const payload = encodeLazerPayload({ timestampUs: ts, channel: 0, feeds: [feed] });
  const message = encodeLazerMessage(signer.sign(payload), signer.publicKey, payload);
  const payer = poster();
  const tx = new Transaction().add(...postPrintIxs({
    poster: payer.publicKey, symbol: l.symbol, day: bell.day, kind: bell.kind, message,
    verifier: ctx.config.verifier, treasury: ctx.treasury, computeUnits: POST_CU,
  }));
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(payer);
  const sim = await conn.simulateTransaction(tx);
  log(`rehearsal: ${l.symbol} ${bell.kind} of day ${bell.day}, ${decimalPrice(price, -5)} dated ${new Date(Number(ts / 1000n)).toISOString()}`);
  for (const line of sim.value.logs ?? []) console.log(`    ${line}`);
  console.log(sim.value.err ? `  FAILED: ${JSON.stringify(sim.value.err)}` : `  ok: the post would land (${sim.value.unitsConsumed} CU); nothing was sent`);
  if (sim.value.err) process.exitCode = 1;
}

/* ── main ────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  if (has('--status')) return status();
  const simulate = has('--simulate');
  const ctx = await context();
  if (simulate !== ctx.config.simulated) {
    throw new Error(simulate
      ? 'this config verifies through Pyth\'s own program: a simulated message would be refused'
      : 'this config holds a test signer: run with --simulate');
  }
  if (has('--rehearse')) return rehearse(ctx);
  log(`poster ${poster().publicKey.toBase58()}, ${ctx.listings.length} listing(s), ${simulate ? 'simulated source' : 'Pyth Pro'}`);
  do {
    await settle(await context());
    const now = Date.now() / 1000;
    const bell = nextBell(now, ctx.config);
    const wake = Number(bellWindow(bell.ts, bell.kind, ctx.config.params).startUs / 1_000_000n) - 60;
    if (wake > now) {
      log(`next: ${bell.kind} of day ${bell.day} at ${new Date(bell.ts * 1000).toISOString()}; sleeping ${Math.round((wake - now) / 60)} min`);
      // wake in slices so a stop signal is heard
      while (!stopping && Date.now() / 1000 < wake) await sleep(Math.min(60_000, (wake - Date.now() / 1000) * 1000));
    }
    if (stopping) break;
    await runBell(await context(), bell, simulate);
    // freeze it as soon as it can be frozen, rather than at the next bell
    const deadline = bellDeadline(bell.ts, bell.kind, ctx.config.params);
    log(`waiting for the deadline (${new Date(deadline * 1000).toISOString().slice(11, 19)}) to finalise`);
    while (!stopping && Date.now() / 1000 < deadline + 5) await sleep(Math.min(30_000, (deadline + 5) * 1000 - Date.now()));
    if (!stopping) await settle(await context());
  } while (!stopping && !has('--once'));
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => {
  console.error(e);
  process.exit(1);
});
