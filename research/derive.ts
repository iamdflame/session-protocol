/* ───────────────────────────────────────────────────────────────────────────
   The study's input, materialised from the collector.

   `research/session-study.ts` reads `data/_hourly.json` and nothing else. That
   file used to be produced by a seven-page backwards walk of a price API; it
   is now produced from `data/collector.db`, which accumulated the same hours
   and keeps the ones that have fallen out of the API's window.

   This writes the file and stops. It does not compute anything: every
   statistic stays in `session-study.ts`, `stats.ts` and `clean.ts`, because a
   second path through the arithmetic is a second answer waiting to disagree
   with the first.

     npm run derive        rebuild data/_hourly.json, then run the study
   ─────────────────────────────────────────────────────────────────────────── */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, writeFileSync } from 'node:fs';

const DB_PATH = process.env.COLLECTOR_DB ?? 'data/collector.db';
if (!existsSync(DB_PATH)) {
  console.error(`${DB_PATH} is absent — run \`npm run collect -- --backfill\` first`);
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 5000');

/* The same floor `fetch-hourly.mjs` applied: below this the session runs are
   too few for the study to say anything, and it drops the asset rather than
   reporting a statistic it does not have. */
const MIN_HOURS = 400;

interface AssetRow { mint: string; symbol: string; kind: string | null; pool: string | null; liquidity: number | null }

const assets = db.prepare(
  'SELECT mint, symbol, kind, pool, liquidity FROM assets ORDER BY symbol',
).all() as AssetRow[];

const bars = db.prepare('SELECT ts, c FROM bars WHERE mint = ? ORDER BY ts');

const out: {
  symbol: string; mint: string; kind: string | null; pool: string | null;
  liquidity: number | null; rows: [number, number][];
}[] = [];

let dropped = 0;
for (const a of assets) {
  const rows = (bars.all(a.mint) as { ts: number; c: number }[])
    .filter(r => r.c > 0)
    .map(r => [r.ts, r.c] as [number, number]);
  if (rows.length < MIN_HOURS) {
    console.error(`  skip ${a.symbol.padEnd(10)} only ${rows.length}h`);
    dropped++;
    continue;
  }
  out.push({ symbol: a.symbol, mint: a.mint, kind: a.kind, pool: a.pool, liquidity: a.liquidity, rows });
  const days = (rows[rows.length - 1][0] - rows[0][0]) / 86400;
  console.error(`  ok   ${a.symbol.padEnd(10)} ${String(rows.length).padStart(5)}h  ` +
    `${days.toFixed(0).padStart(3)}d  ${new Date(rows[0][0] * 1000).toISOString().slice(0, 10)}` +
    ` -> ${new Date(rows[rows.length - 1][0] * 1000).toISOString().slice(0, 10)}`);
}

/* `generated` is the newest bar the collector holds, not the moment this ran.
   Two derives over the same data then produce the same bytes, which is what
   makes the downstream `study.json` stop showing dirty on every build. */
const newest = db.prepare('SELECT MAX(ts) t FROM bars').get() as { t: number | null };
const generated = new Date((newest.t ?? 0) * 1000).toISOString();

writeFileSync('data/_hourly.json', JSON.stringify({ generated, assets: out }));

/* ── funding, measured against the study's prior ─────────────────────────
   The study says what the night/day difference actually was. Funding is what
   the vault charges the crowded side to hold it. Whether those two numbers
   agree is the only way to know if `k` is set anywhere near right — the
   defaults are reasoned, not fitted, and REBUILD §5.7 is explicit that only a
   live book calibrates them.

   Published here so the page can put them side by side rather than asserting
   a rate nobody has checked against an outcome. */
const bells = db.prepare(`
  SELECT vault, boundary, bell_ts, cranked_ts, exposed,
         night_nav, day_nav, night_supply, day_supply, funding
  FROM bells ORDER BY vault, boundary`).all() as Record<string, string | number>[];

const WAD = 10n ** 18n;
const series = bells.map(b => {
  const nv = BigInt(b.night_nav as string) * BigInt(b.night_supply as string) / WAD;
  const dv = BigInt(b.day_nav as string) * BigInt(b.day_supply as string) / WAD;
  const transfer = BigInt(b.funding as string);
  const abs = transfer < 0n ? -transfer : transfer;
  /* Sized on the smaller side, exactly as `fundingTransfer` does: an empty
     class means there is nobody to pay and nobody to pay them, which is a
     zero for a reason that is not "the book is balanced". */
  const base = nv < dv ? nv : dv;
  return {
    boundary: Number(b.boundary),
    bellTs: b.bell_ts === null ? null : Number(b.bell_ts),
    crankedTs: Number(b.cranked_ts),
    exposed: String(b.exposed),
    fundingAtoms: transfer.toString(),
    payer: transfer === 0n ? null : transfer > 0n ? 'night' : 'day',
    rateBps: base > 0n ? Number(abs * 10_000n / base) : null,
    valueNight: nv.toString(),
    valueDay: dv.toString(),
  };
});

/* No prior in here. The study already publishes `pooled.night.meanPerHour`
   and `pooled.day.meanPerHour`, and the page already loads it — copying those
   figures into a second file would be a second place for them to go stale. */
writeFileSync('data/funding.json', JSON.stringify({
  snapshot: generated,
  bells: series,
}, null, 1));
console.error(`[derive] ${series.length} settled boundary/ies with funding`);
console.error(`\n[derive] ${out.length} assets, ` +
  `${out.reduce((s, a) => s + a.rows.length, 0).toLocaleString()} hourly closes` +
  `${dropped ? `, ${dropped} below ${MIN_HOURS}h` : ''}`);
console.error(`[derive] newest bar ${generated}`);
db.close();
