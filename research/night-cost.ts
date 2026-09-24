/* ───────────────────────────────────────────────────────────────────────────
   What the night costs.

   The case for trading at the bell rests on a claim about the hours the
   exchange is shut: that a tokenized stock costs more to trade then than
   while the real market is open, because the pools are thinner and nothing
   anchors them. That claim is measurable, so this measures it, every ten
   minutes, for two weeks and then for as long as it keeps running.

   Each sample is a round trip: buy $N of the token with USDC, then sell back
   exactly what the buy returned. Whatever does not come back is what entering
   and leaving cost at that size, at that minute. The method needs no
   reference price at all — it cannot be wrong about what the stock "should"
   cost — which is why it is the primary measure. The reference is recorded
   alongside, from Jupiter's own price record for the token, so the deviation
   from the underlying can be studied from the same rows.

   Every sample is tagged twice: with our calendar's open/closed, which is
   what the protocol settles on, and with Pyth's published schedule, which
   splits "closed" into pre-market, post-market, overnight and closed. A
   failed quote is a row with its error, not a gap: a route that vanishes at
   3am is part of what the night costs.

     npm run night-cost -- --once      one sampling cycle, now
     npm run night-cost -- --watch     every ten minutes, aligned to the clock
     npm run night-cost -- --status    what has been collected, and the medians

   The store is data/night-cost.db (gitignored). It runs as a systemd user
   service on the collecting machine: deploy/install-night-cost.sh.
   ─────────────────────────────────────────────────────────────────────────── */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { sessionAt } from '../sdk/src/calendar.ts';
import { marketSessionAt, parseSessions, type SessionSchedules } from '../sdk/src/pyth-schedule.ts';

interface Name { symbol: string; mint: string; decimals: number }
const CONFIG = JSON.parse(readFileSync('research/night-cost.names.json', 'utf8')) as {
  quote: Name; sizesUsd: number[]; names: Name[];
};
const USDC = CONFIG.quote;

const DB_PATH = process.env.NIGHT_COST_DB ?? 'data/night-cost.db';
const JUP = 'https://lite-api.jup.ag';
const PYTH_SYMBOLS = 'https://pyth.dourolabs.app/v1/symbols';
/* Every US listing shares one exchange calendar, so one symbol's schedule
   tags every sample. SPY is the one least likely to be delisted. */
const SCHEDULE_SYMBOL = 'Equity.US.SPY/USD';
const SLOT = 600;                   // ten minutes
const MIN_GAP_MS = 1_100;           // at most one request a second, with room

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

/* ── the store ───────────────────────────────────────────────────────────── */

mkdirSync('data', { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA busy_timeout = 5000');

/* Keys are the natural ones, so a re-run of a slot is an upsert. Token
   amounts stay TEXT: they are u64 atoms, and a REAL column would round the
   last digits of exactly the numbers this study is about. */
db.exec(`
  CREATE TABLE IF NOT EXISTS cycles (
    ts INTEGER PRIMARY KEY,
    started INTEGER NOT NULL,
    finished INTEGER,
    calendar TEXT NOT NULL,
    pyth_session TEXT,
    quotes_ok INTEGER,
    quotes_failed INTEGER
  );
  CREATE TABLE IF NOT EXISTS quotes (
    ts INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    size_usd INTEGER NOT NULL,
    buy_out TEXT, buy_impact REAL, buy_route TEXT,
    sell_out TEXT, sell_impact REAL, sell_route TEXT,
    round_trip_bps REAL,
    error TEXT,
    PRIMARY KEY (ts, symbol, size_usd)
  );
  CREATE TABLE IF NOT EXISTS prices (
    ts INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    usd_price REAL,
    usd_price_prescaled REAL,
    stock_price REAL,
    stock_updated TEXT,
    multiplier REAL,
    new_multiplier REAL,
    new_multiplier_at TEXT,
    liquidity REAL,
    raw TEXT,
    PRIMARY KEY (ts, symbol)
  );
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS quotes_symbol ON quotes (symbol, size_usd, ts);
`);

const getMeta = (k: string): string | null =>
  (db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined)?.v ?? null;
const setMeta = db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');

const putCycle = db.prepare(`
  INSERT INTO cycles (ts, started, calendar, pyth_session) VALUES (?, ?, ?, ?)
  ON CONFLICT(ts) DO UPDATE SET started = excluded.started,
    calendar = excluded.calendar, pyth_session = excluded.pyth_session`);
const endCycle = db.prepare('UPDATE cycles SET finished = ?, quotes_ok = ?, quotes_failed = ? WHERE ts = ?');
const putQuote = db.prepare(`
  INSERT INTO quotes (ts, symbol, size_usd, buy_out, buy_impact, buy_route,
    sell_out, sell_impact, sell_route, round_trip_bps, error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(ts, symbol, size_usd) DO UPDATE SET
    buy_out = excluded.buy_out, buy_impact = excluded.buy_impact, buy_route = excluded.buy_route,
    sell_out = excluded.sell_out, sell_impact = excluded.sell_impact, sell_route = excluded.sell_route,
    round_trip_bps = excluded.round_trip_bps, error = excluded.error`);
const putPrice = db.prepare(`
  INSERT INTO prices (ts, symbol, usd_price, usd_price_prescaled, stock_price, stock_updated,
    multiplier, new_multiplier, new_multiplier_at, liquidity, raw)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(ts, symbol) DO UPDATE SET
    usd_price = excluded.usd_price, usd_price_prescaled = excluded.usd_price_prescaled,
    stock_price = excluded.stock_price, stock_updated = excluded.stock_updated,
    multiplier = excluded.multiplier, new_multiplier = excluded.new_multiplier,
    new_multiplier_at = excluded.new_multiplier_at, liquidity = excluded.liquidity, raw = excluded.raw`);

/* ── the network ─────────────────────────────────────────────────────────── */

let lastRequest = 0;

/* One request at a time, spaced, with the backoff the other collectors
   proved. A 429 is waited out rather than counted as a failure; anything
   that still fails comes back as the reason, which becomes a row. */
async function getJson(url: string): Promise<{ ok: true; json: any } | { ok: false; error: string }> {
  let error = 'unreachable';
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = lastRequest + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (r.status === 429) { error = 'http 429'; await sleep(5_000 * 2 ** attempt); continue; }
      const text = await r.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      if (!r.ok) {
        error = `http ${r.status}${json?.error ? `: ${String(json.error).slice(0, 120)}` : ''}`;
        // A 4xx other than 429 is an answer, not an outage: do not retry it.
        if (r.status < 500) return { ok: false, error };
        await sleep(1_500 * (attempt + 1));
        continue;
      }
      if (json === null) return { ok: false, error: 'not json' };
      return { ok: true, json };
    } catch (e) {
      error = `network: ${(e as Error).message.slice(0, 120)}`;
      await sleep(1_500 * (attempt + 1));
    }
  }
  return { ok: false, error };
}

interface Leg { out: bigint; impact: number | null; route: string }

async function quote(inMint: string, outMint: string, amount: bigint): Promise<Leg | { error: string }> {
  const url = `${JUP}/swap/v1/quote?inputMint=${inMint}&outputMint=${outMint}` +
    `&amount=${amount}&slippageBps=300&swapMode=ExactIn`;
  const r = await getJson(url);
  if (!r.ok) return { error: r.error };
  const q = r.json;
  if (!q?.outAmount) return { error: q?.errorCode ?? q?.error ?? 'no route' };
  const route = Array.isArray(q.routePlan)
    ? q.routePlan.map((p: any) => `${p?.swapInfo?.label ?? '?'}:${p?.percent ?? '?'}`).join('+')
    : '';
  const impact = q.priceImpactPct === undefined ? null : Number(q.priceImpactPct);
  return { out: BigInt(q.outAmount), impact: Number.isFinite(impact) ? impact : null, route };
}

/* ── Pyth's schedule, refreshed daily ────────────────────────────────────── */

let schedules: SessionSchedules | null = null;
let schedulesFetched = 0;

async function pythSchedules(): Promise<SessionSchedules | null> {
  if (schedules && nowSec() - schedulesFetched < 86_400) return schedules;
  const cached = getMeta('pyth_sessions');
  // The symbols list is a few megabytes; ask for the one symbol first.
  let raw: any = null;
  const narrow = await getJson(`${PYTH_SYMBOLS}?query=${encodeURIComponent(SCHEDULE_SYMBOL)}&asset_type=equity`);
  const pick = (list: any) => Array.isArray(list) ? list.find((s: any) => s?.symbol === SCHEDULE_SYMBOL) : null;
  raw = narrow.ok ? pick(narrow.json) : null;
  if (!raw) {
    const full = await getJson(PYTH_SYMBOLS);
    raw = full.ok ? pick(full.json) : null;
  }
  if (raw?.market_sessions) {
    try {
      schedules = parseSessions(raw.market_sessions);
      schedulesFetched = nowSec();
      setMeta.run('pyth_sessions', JSON.stringify({ fetched: schedulesFetched, symbol: SCHEDULE_SYMBOL, market_sessions: raw.market_sessions }));
      return schedules;
    } catch (e) {
      console.error(`pyth schedule did not parse, keeping the previous one: ${(e as Error).message}`);
    }
  }
  if (cached) {
    try {
      const c = JSON.parse(cached);
      schedules = parseSessions(c.market_sessions);
      schedulesFetched = c.fetched;
      return schedules;
    } catch { /* fall through */ }
  }
  return null;
}

/* ── one cycle ───────────────────────────────────────────────────────────── */

async function cycle(slot: number): Promise<void> {
  const sched = await pythSchedules();
  const calendar = sessionAt(slot);
  const pyth = sched ? marketSessionAt(sched, slot) : null;
  putCycle.run(slot, nowSec(), calendar, pyth);

  let ok = 0, failed = 0;
  for (const n of CONFIG.names) {
    for (const usd of CONFIG.sizesUsd) {
      const size = BigInt(usd) * 10n ** BigInt(USDC.decimals);
      const buy = await quote(USDC.mint, n.mint, size);
      if ('error' in buy) {
        putQuote.run(slot, n.symbol, usd, null, null, null, null, null, null, null, `buy: ${buy.error}`);
        failed++;
        continue;
      }
      const sell = await quote(n.mint, USDC.mint, buy.out);
      if ('error' in sell) {
        putQuote.run(slot, n.symbol, usd, String(buy.out), buy.impact, buy.route, null, null, null, null, `sell: ${sell.error}`);
        failed++;
        continue;
      }
      const bps = Number((size - sell.out) * 1_000_000n / size) / 100;
      putQuote.run(slot, n.symbol, usd, String(buy.out), buy.impact, buy.route,
        String(sell.out), sell.impact, sell.route, bps, null);
      ok++;
    }
  }

  const ids = CONFIG.names.map(n => n.mint).join(',');
  const prices = await getJson(`${JUP}/price/v3?ids=${ids}`);
  if (prices.ok) {
    for (const n of CONFIG.names) {
      const p = prices.json?.[n.mint];
      if (!p) continue;
      const s = p.scaledUiConfig ?? {};
      putPrice.run(slot, n.symbol,
        numOrNull(p.usdPrice), numOrNull(s.usdPricePrescaled), numOrNull(p.stockData?.price),
        p.stockData?.updatedAt ?? null, numOrNull(s.multiplier), numOrNull(s.newMultiplier),
        s.newMultiplierEffectiveAt ?? null, numOrNull(p.liquidity), JSON.stringify(p));
    }
  } else {
    console.error(`price/v3: ${prices.error}`);
  }

  endCycle.run(nowSec(), ok, failed, slot);
  const at = new Date(slot * 1000).toISOString().slice(0, 16).replace('T', ' ');
  console.log(`${at}Z  ${calendar.padEnd(6)} ${String(pyth ?? '?').padEnd(10)}  ${ok} quotes, ${failed} failed  (${nowSec() - slot}s)`);
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/* ── status ──────────────────────────────────────────────────────────────── */

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function status(): void {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const first = db.prepare('SELECT MIN(ts) a, MAX(ts) b FROM cycles').get() as { a: number | null; b: number | null };
  console.log(`\nnight-cost — ${DB_PATH}`);
  console.log(`  cycles  ${n('SELECT COUNT(*) n FROM cycles')}` +
    (first.a ? `  (${new Date(first.a * 1000).toISOString().slice(0, 16)}Z → ${new Date(first.b! * 1000).toISOString().slice(0, 16)}Z)` : ''));
  console.log(`  quotes  ${n('SELECT COUNT(*) n FROM quotes WHERE error IS NULL')} priced, ${n('SELECT COUNT(*) n FROM quotes WHERE error IS NOT NULL')} failed`);
  console.log(`  prices  ${n('SELECT COUNT(*) n FROM prices')}`);

  const last = db.prepare('SELECT * FROM cycles ORDER BY ts DESC LIMIT 1').get() as any;
  if (last) {
    console.log(`  last    ${new Date(last.ts * 1000).toISOString().slice(0, 16)}Z  calendar=${last.calendar} pyth=${last.pyth_session}` +
      `  ${last.quotes_ok ?? '…'} ok / ${last.quotes_failed ?? '…'} failed`);
  }

  /* Median round trip by Pyth session, per name, at $1k and $10k, over the
     whole store. Sessions with fewer than three samples are shown as such. */
  const rows = db.prepare(`
    SELECT q.symbol, q.size_usd, c.pyth_session s, q.round_trip_bps b
    FROM quotes q JOIN cycles c ON c.ts = q.ts
    WHERE q.error IS NULL AND q.size_usd IN (1000, 10000)`).all() as { symbol: string; size_usd: number; s: string | null; b: number }[];
  const sessions = ['regular', 'preMarket', 'postMarket', 'overNight', 'closed'];
  for (const size of [1000, 10000]) {
    console.log(`\n  median round trip, $${size.toLocaleString()} (bp; n)`);
    console.log('  ' + 'name'.padEnd(8) + sessions.map(s => s.padStart(14)).join(''));
    for (const nm of CONFIG.names) {
      const cells = sessions.map(s => {
        const xs = rows.filter(r => r.symbol === nm.symbol && r.size_usd === size && r.s === s).map(r => r.b);
        const m = median(xs);
        return (m === null ? '—' : `${m.toFixed(1)} (${xs.length})`).padStart(14);
      });
      console.log('  ' + nm.symbol.padEnd(8) + cells.join(''));
    }
  }
  const errs = db.prepare(`SELECT error, COUNT(*) n FROM quotes WHERE error IS NOT NULL GROUP BY error ORDER BY n DESC LIMIT 5`).all() as { error: string; n: number }[];
  if (errs.length) {
    console.log('\n  most common failures');
    for (const e of errs) console.log(`    ${String(e.n).padStart(5)}  ${e.error}`);
  }
  console.log();
}

/* ── main ────────────────────────────────────────────────────────────────── */

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`\n${sig}: finishing the current write, then stopping`);
  });
}

if (has('--status')) {
  status();
} else if (has('--once')) {
  await cycle(Math.floor(nowSec() / 60) * 60);
} else if (has('--watch')) {
  console.log(`night-cost: ${CONFIG.names.length} names × ${CONFIG.sizesUsd.length} sizes every ${SLOT / 60} minutes → ${DB_PATH}`);
  while (!stopping) {
    const next = Math.ceil((nowSec() + 1) / SLOT) * SLOT;
    // Sleep in short steps so a stop signal is honoured within seconds.
    while (!stopping && nowSec() < next) await sleep(Math.min(5_000, (next - nowSec()) * 1000));
    if (stopping) break;
    const done = db.prepare('SELECT finished FROM cycles WHERE ts = ?').get(next) as { finished: number | null } | undefined;
    if (done?.finished) continue;             // a restart inside a finished slot
    try {
      await cycle(next);
    } catch (e) {
      console.error(`cycle ${next} failed: ${(e as Error).stack ?? e}`);
    }
  }
} else {
  console.log('usage: npm run night-cost -- --once | --watch | --status');
  process.exitCode = 2;
}
db.close();
