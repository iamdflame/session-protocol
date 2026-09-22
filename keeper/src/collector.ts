/* ───────────────────────────────────────────────────────────────────────────
   The study, collected rather than refetched.

   `npm run data` walks GeckoTerminal's `before_timestamp` backwards seven
   pages per asset and overwrites `data/_hourly.json`. That has three costs:
   history older than the walk window cannot be recovered once it falls out,
   every run spends hundreds of API calls re-fetching hours it already had, and
   the file is rewritten wholesale so `study.json` shows dirty on every build
   whether a number moved or not.

   This is the same data, accumulated. Hourly bars and minute ticks come from
   the price API; bells and the funding paid at each one come from the vault's
   own events, because a throttled price endpoint must never cost us a
   settlement. Everything is keyed so a write is an upsert and a re-run of the
   same window changes nothing.

     npm run collect -- --backfill   import data/_hourly.json, once
     npm run collect -- --once       one incremental pass
     npm run collect -- --watch      minute ticks, hourly bars, chain every 5m
     npm run collect -- --status     watermarks and row counts

   The chain stays the truth for positions. This is the truth for history.
   ─────────────────────────────────────────────────────────────────────────── */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { decodeVault } from '../../sdk/src/vault.ts';
import { eventsFromLogs } from '../../sdk/src/events.ts';

const DB_PATH = process.env.COLLECTOR_DB ?? 'data/collector.db';
const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';
const MANIFESTS = ['web/public/devnet.json', 'web/public/devnet-openai.json'];

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

/* ── the store ───────────────────────────────────────────────────────────── */

mkdirSync('data', { recursive: true });
const db = new DatabaseSync(DB_PATH);

/* WAL so a --watch process and a --once process can coexist, and so a kill
   -9 mid-write loses at most the current transaction rather than the file. */
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA busy_timeout = 5000');

/* Every table's primary key is the natural one, so an upsert is the only
   write and replaying a window is free. Amounts the chain reports as u64/u128
   are stored as TEXT: a NAV is WAD-scaled, 1.005 is 1005000000000000000, and
   a REAL column would silently round it. Nothing here is arithmetic — the
   statistics run in the derive step on values parsed back as BigInt. */
/* `bells` is keyed by the vault's own boundary ordinal, because that is the
   only thing the program guarantees unique per settlement — and because the
   event does not carry the bell.

   BoundarySettled emits ts = now (when the crank ran) and
   boundary = v.boundary_count (which settlement this was). The bell it
   actually settled lives in vault.last_boundary_ts and is never published.
   The program is careful about this everywhere else — a late settlement is
   stamped with the bell it belongs to, not with the moment somebody got
   around to cranking — so the omission is in the event, not in the money.
   cranked_ts is therefore named for what it is rather than passed off as the
   bell, and bell_ts is filled from the vault account when the collector can
   see it and left null when it cannot. */
db.exec(`
  CREATE TABLE IF NOT EXISTS assets (
    mint TEXT PRIMARY KEY, symbol TEXT NOT NULL, kind TEXT, pool TEXT, liquidity REAL
  );
  CREATE TABLE IF NOT EXISTS bars (
    mint TEXT NOT NULL, ts INTEGER NOT NULL,
    o REAL, h REAL, l REAL, c REAL NOT NULL, v REAL,
    PRIMARY KEY (mint, ts)
  );
  CREATE TABLE IF NOT EXISTS ticks (
    mint TEXT NOT NULL, ts INTEGER NOT NULL, price REAL NOT NULL,
    PRIMARY KEY (mint, ts)
  );
  CREATE TABLE IF NOT EXISTS bells (
    vault TEXT NOT NULL, boundary INTEGER NOT NULL,
    signature TEXT, cranked_ts INTEGER, bell_ts INTEGER,
    exposed TEXT, mark TEXT,
    night_nav TEXT, day_nav TEXT, night_supply TEXT, day_supply TEXT,
    funding TEXT, pending_delta TEXT, owned_underlying TEXT, owned_quote TEXT,
    PRIMARY KEY (vault, boundary)
  );
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS bars_ts ON bars (ts);
  CREATE INDEX IF NOT EXISTS ticks_ts ON ticks (ts);
`);

const getMeta = (k: string): string | null =>
  (db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined)?.v ?? null;
const setMeta = db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');

const putAsset = db.prepare(`
  INSERT INTO assets (mint, symbol, kind, pool, liquidity) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(mint) DO UPDATE SET symbol = excluded.symbol, kind = excluded.kind,
    pool = excluded.pool, liquidity = excluded.liquidity`);
const putBar = db.prepare(`
  INSERT INTO bars (mint, ts, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(mint, ts) DO UPDATE SET
    o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c, v = excluded.v`);
const putTick = db.prepare(
  'INSERT INTO ticks (mint, ts, price) VALUES (?, ?, ?) ON CONFLICT(mint, ts) DO NOTHING');
const putBell = db.prepare(`
  INSERT INTO bells (vault, boundary, signature, cranked_ts, exposed, mark,
    night_nav, day_nav, night_supply, day_supply, funding, pending_delta,
    owned_underlying, owned_quote)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(vault, boundary) DO UPDATE SET
    signature = excluded.signature, cranked_ts = excluded.cranked_ts,
    exposed = excluded.exposed, mark = excluded.mark,
    night_nav = excluded.night_nav, day_nav = excluded.day_nav,
    night_supply = excluded.night_supply, day_supply = excluded.day_supply,
    funding = excluded.funding, pending_delta = excluded.pending_delta,
    owned_underlying = excluded.owned_underlying, owned_quote = excluded.owned_quote`);
/* The bell the vault says it is on, matched to the ordinal it is on. Only the
   latest is knowable this way; older ones stay null rather than guessed. */
const stampBell = db.prepare(
  'UPDATE bells SET bell_ts = ? WHERE vault = ? AND boundary = ? AND bell_ts IS NULL');

const count = (t: string): number =>
  (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;

/* ── the price API ───────────────────────────────────────────────────────── */

/** GeckoTerminal, with the backoff `research/fetch-hourly.mjs` already proved. */
async function gt(path: string): Promise<any | null> {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(GT + path, { headers: { accept: 'application/json' } });
      if (r.status === 429) { await sleep(6000); continue; }
      if (r.ok) return await r.json();
    } catch { /* network, retry */ }
    await sleep(1500 * (i + 1));
  }
  return null;
}

interface Asset { mint: string; symbol: string; kind: string; pool: string; liquidity: number }

const assets = (): Asset[] =>
  db.prepare('SELECT mint, symbol, kind, pool, liquidity FROM assets ORDER BY symbol').all() as Asset[];

/* ── backfill ────────────────────────────────────────────────────────────── */

/**
 * Import whatever the batch pipeline already fetched.
 *
 * Run once. It exists so switching to the collector costs no history: the
 * seven-page walk that produced `_hourly.json` is the deepest history anyone
 * has, and re-walking it later would only get whatever the API still serves.
 */
function backfill(): void {
  const src = 'data/_hourly.json';
  if (!existsSync(src)) { console.log(`${src} is absent — nothing to import`); return; }
  const raw = JSON.parse(readFileSync(src, 'utf8')) as {
    generated: string;
    assets: { symbol: string; mint: string; kind: string; pool: string; liquidity: number; rows: [number, number][] }[];
  };

  let bars = 0;
  db.exec('BEGIN');
  try {
    for (const a of raw.assets) {
      putAsset.run(a.mint, a.symbol, a.kind ?? null, a.pool ?? null, a.liquidity ?? null);
      for (const [ts, c] of a.rows) {
        // The batch fetcher kept only the close; o/h/l/v stay null rather than
        // being invented from it.
        putBar.run(a.mint, ts, null, null, null, c, null);
        bars++;
      }
      const last = a.rows.length ? a.rows[a.rows.length - 1][0] : 0;
      if (last) setMeta.run(`bars:${a.mint}`, String(last));
    }
    setMeta.run('backfilled', raw.generated);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  console.log(`imported ${bars.toLocaleString()} bars across ${raw.assets.length} assets from ${src}`);
  console.log(`snapshot ${raw.generated}`);
}

/* ── incremental bars ────────────────────────────────────────────────────── */

/**
 * Fetch only the gap since this asset's watermark.
 *
 * One page of 1,000 hourly candles covers ~42 days, so a collector that has
 * run in the last month needs exactly one request per asset. The watermark is
 * advanced only after the rows are committed, so an interrupted run refetches
 * a window rather than skipping one.
 */
async function bars(limitAssets?: number): Promise<{ fetched: number; added: number }> {
  const list = limitAssets ? assets().slice(0, limitAssets) : assets();
  let fetched = 0, added = 0;

  for (const a of list) {
    if (!a.pool) continue;
    const mark = Number(getMeta(`bars:${a.mint}`) ?? 0);
    const before = nowSec();
    const oh = await gt(`/pools/${a.pool}/ohlcv/hour?aggregate=1&limit=1000` +
                        `&currency=usd&token=${a.mint}&before_timestamp=${before}`);
    await sleep(2300);
    const rows: number[][] | undefined = oh?.data?.attributes?.ohlcv_list;
    if (!rows?.length) { console.log(`  --   ${a.symbol.padEnd(10)} no candles`); continue; }

    let newest = mark, n = 0;
    db.exec('BEGIN');
    try {
      for (const r of rows) {
        const [ts, o, h, l, c, v] = r;
        if (!(c > 0)) continue;
        // Re-writing a bar we already hold is free and self-healing: a
        // provisional candle from the current hour gets corrected next pass.
        putBar.run(a.mint, ts, o ?? null, h ?? null, l ?? null, c, v ?? null);
        if (ts > mark) n++;
        if (ts > newest) newest = ts;
      }
      if (newest > mark) setMeta.run(`bars:${a.mint}`, String(newest));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    fetched++; added += n;
    console.log(`  ok   ${a.symbol.padEnd(10)} +${String(n).padStart(4)}h  ` +
      `through ${new Date(newest * 1000).toISOString().slice(0, 16)}`);
  }
  return { fetched, added };
}

/* ── minute ticks ────────────────────────────────────────────────────────── */

/**
 * The current price of every asset, once a minute.
 *
 * Bars answer the study's question; ticks answer "is this number fresh", which
 * is the one a reader asks and the one a green button depends on. One request
 * covers up to 30 mints, so this is cheap enough to run every minute.
 */
async function ticks(): Promise<number> {
  const list = assets().filter(a => a.mint);
  let n = 0;
  for (let i = 0; i < list.length; i += 30) {
    const chunk = list.slice(i, i + 30);
    const res = await gt(`/tokens/multi/${chunk.map(a => a.mint).join(',')}`);
    await sleep(2300);
    const ts = nowSec() - (nowSec() % 60);      // aligned, so re-runs collapse
    db.exec('BEGIN');
    try {
      for (const t of res?.data ?? []) {
        const mint = t?.attributes?.address;
        const price = Number(t?.attributes?.price_usd);
        if (!mint || !(price > 0)) continue;
        putTick.run(mint, ts, price);
        n++;
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return n;
}

/* ── bells, from the chain ───────────────────────────────────────────────── */

interface Vaults { vault: string; rpc: string; symbol: string }

function vaultList(): Vaults[] {
  const out: Vaults[] = [];
  for (const f of MANIFESTS) {
    if (!existsSync(f)) continue;
    const m = JSON.parse(readFileSync(f, 'utf8'));
    out.push({ vault: m.vault, rpc: process.env.DEVNET_RPC ?? m.rpc, symbol: m.symbol });
  }
  return out;
}

/**
 * Every boundary the program says it settled, and what funding it moved.
 *
 * `BoundarySettled` carries the bell and the funding in one event — the
 * boundary it belongs to, both NAVs, both supplies, the mark it used and the
 * signed funding transfer — so there is no second table to keep in step with
 * this one. It is read from the vault's own logs rather than reconstructed from
 * NAV differences, because a NAV moves for settlement *and* funding and the
 * difference cannot tell you which.
 */
async function bells(): Promise<number> {
  let n = 0;
  for (const v of vaultList()) {
    const conn = new Connection(v.rpc, 'confirmed');
    const key = new PublicKey(v.vault);
    const since = getMeta(`bells:${v.vault}`);

    /* How many settlements exist, straight from the vault. Without this the
       first pass walks the whole signature history looking for events that
       are a small minority of it — a hundred transactions in chunks of five
       against a throttled endpoint, silent for minutes. With it the walk stops
       the moment it has them all. */
    const held = decodeVault((await conn.getAccountInfo(key))!.data);
    const want = held.boundaryCount;
    const have = () => (db.prepare('SELECT COUNT(*) n FROM bells WHERE vault = ?')
      .get(v.vault) as { n: number }).n;
    if (!since && have() >= want) {
      console.log(`  ok   ${v.symbol.padEnd(10)} ${want} bell(s), all held`);
      continue;
    }

    let sigs;
    try {
      sigs = await conn.getSignaturesForAddress(key, { limit: 200, ...(since ? { until: since } : {}) });
    } catch (e) {
      console.log(`  --   ${v.symbol.padEnd(10)} signatures unavailable: ${(e as Error).message.slice(0, 60)}`);
      continue;
    }
    const ok = sigs.filter(s => !s.err);
    if (!ok.length) { console.log(`  ok   ${v.symbol.padEnd(10)} no new transactions`); continue; }

    /* Newest first, which is both the order the endpoint returns and the order
       that finds settlements soonest: on a catch-up pass the bells we lack are
       the recent ones, and a first pass can stop as soon as the vault's own
       count is satisfied instead of reading a hundred mints to reach two
       settlements at the far end.

       Contiguity is not lost by stopping early. The watermark is the newest
       signature in this batch, and `until` is exclusive, so the next pass
       takes everything above it — and the only reason to stop early is that
       the vault says there is nothing older left to find. */
    const ordered = ok;
    const newest: string | null = ok[0]?.signature ?? null;

    for (let i = 0; i < ordered.length; i += 5) {
      const chunk = ordered.slice(i, i + 5);
      let txs = null;
      for (let a = 0; a < 5 && !txs; a++) {
        if (a) await sleep(1500 * 2 ** (a - 1));
        txs = await conn.getParsedTransactions(chunk.map(s => s.signature),
          { maxSupportedTransactionVersion: 0 }).catch(() => null);
      }
      if (!txs) {
        console.log(`  --   ${v.symbol.padEnd(10)} endpoint stopped answering; watermark held`);
        break;                                   // keep the watermark: retry next pass
      }
      if (!since) {
        process.stdout.write(`\r  ..   ${v.symbol.padEnd(10)} ${Math.min(i + 5, ordered.length)}/${ordered.length} read, ${have()}/${want} bells`);
      }

      db.exec('BEGIN');
      try {
        for (const t of txs) {
          // Keyed by the signature the transaction carries, never by position
          // in the batch — a batch is not guaranteed to come back in order.
          const sig = t?.transaction?.signatures?.[0];
          if (!sig) continue;
          for (const e of eventsFromLogs(t?.meta?.logMessages)) {
            if (e.name !== 'BoundarySettled' && e.name !== 'JumpSettled') continue;
            const f = e.fields as Record<string, unknown>;
            putBell.run(
              v.vault, Number(f.boundary), sig, Number(f.ts),
              String(f.exposed ?? ''), String(f.mark ?? ''),
              String(f.nightNav ?? ''), String(f.dayNav ?? ''),
              String(f.nightSupply ?? ''), String(f.daySupply ?? ''),
              String(f.funding ?? ''), String(f.pendingDelta ?? ''),
              String(f.ownedUnderlying ?? ''), String(f.ownedQuote ?? ''),
            );
            n++;
          }
        }
        db.exec('COMMIT');
      } catch (err) { db.exec('ROLLBACK'); throw err; }
      if (!since && have() >= want) break;       // every settlement accounted for
    }

    if (newest) setMeta.run(`bells:${v.vault}`, newest);
    // The latest ordinal is the one the vault is sitting on, so its bell is
    // knowable. Older ones the event never carried stay null.
    stampBell.run(held.lastBoundaryTs, v.vault, want);
    if (!since) process.stdout.write('\r');
    console.log(`  ok   ${v.symbol.padEnd(10)} ${have()}/${want} bell(s) held; ` +
      `latest bell ${new Date(held.lastBoundaryTs * 1000).toISOString()}`);
  }
  return n;
}

/* ── modes ───────────────────────────────────────────────────────────────── */

function status(): void {
  console.log(`${DB_PATH}`);
  for (const t of ['assets', 'bars', 'ticks', 'bells']) {
    console.log(`  ${t.padEnd(8)} ${count(t).toLocaleString()}`);
  }
  const span = db.prepare('SELECT MIN(ts) a, MAX(ts) b FROM bars').get() as { a: number | null; b: number | null };
  if (span.a) {
    console.log(`  bars span ${new Date(span.a * 1000).toISOString().slice(0, 10)}` +
      ` → ${new Date(span.b! * 1000).toISOString().slice(0, 10)}`);
  }
  const b = db.prepare(
    'SELECT boundary, bell_ts, cranked_ts, night_nav, day_nav, funding, exposed FROM bells ORDER BY vault, boundary',
  ).all() as any[];
  for (const r of b) {
    // The bell when the vault could tell us, the crank time otherwise, and
    // which it is — rather than one column pretending to be both.
    const when = r.bell_ts
      ? `bell ${new Date(r.bell_ts * 1000).toISOString()}`
      : `cranked ${new Date(r.cranked_ts * 1000).toISOString()} (bell not published)`;
    console.log(`  #${String(r.boundary).padStart(3)}  ${when}  ` +
      `night ${(Number(r.night_nav) / 1e18).toFixed(6)}  day ${(Number(r.day_nav) / 1e18).toFixed(6)}  ` +
      `funding ${r.funding}  → ${r.exposed}`);
  }
}

async function once(): Promise<void> {
  console.log('bells');
  const nb = await bells();
  console.log('\nbars');
  const { fetched, added } = await bars();
  console.log('\nticks');
  const nt = await ticks();
  console.log(`\n${added} new bar(s) across ${fetched} asset(s), ${nt} tick(s), ${nb} bell row(s)`);
  setMeta.run('last_pass', new Date().toISOString());
}

async function watch(): Promise<void> {
  console.log('watching — ticks every minute, bars hourly, chain every five minutes');
  let lastBars = 0, lastChain = 0;
  for (;;) {
    const t = Date.now();
    try {
      if (t - lastChain > 5 * 60_000) { await bells(); lastChain = t; }
      if (t - lastBars > 60 * 60_000) { await bars(); lastBars = t; }
      const n = await ticks();
      setMeta.run('last_pass', new Date().toISOString());
      console.log(`${new Date().toISOString().slice(11, 19)}  ${n} tick(s)`);
    } catch (e) {
      // A collector that dies on one bad response stops collecting. Log and
      // carry on; the watermarks mean nothing is lost by trying again.
      console.log(`${new Date().toISOString().slice(11, 19)}  pass failed: ${(e as Error).message.slice(0, 120)}`);
    }
    await sleep(60_000);
  }
}

/* Each source alone as well as together: they fail differently and they cost
   differently. Bells are three cheap RPC calls and the thing we cannot afford
   to miss; bars are 26 rate-limited fetches and can wait an hour. A cron that
   wants one should not pay for the other. */
if (has('--backfill')) backfill();
else if (has('--status')) status();
else if (has('--watch')) await watch();
else if (has('--bells')) { console.log('bells'); await bells(); }
else if (has('--bars')) { console.log('bars'); await bars(); }
else if (has('--ticks')) { console.log(`ticks: ${await ticks()}`); }
else await once();

db.close();
