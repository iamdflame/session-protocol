/* ───────────────────────────────────────────────────────────────────────────
   Build the compact datasets the site ships.

   The raw hourly file is 2.6MB — far too heavy to put in a page. Everything
   here is derived from it through the *same* calendar the program uses, so the
   curves on screen are the real session decomposition and not a re-telling of
   it. Nothing is smoothed, invented or rounded for looks.

   Run: node --experimental-strip-types scripts/prepare-data.ts
   ─────────────────────────────────────────────────────────────────────────── */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { sessionAt, Session, SEC_PER_DAY } from '../../sdk/src/calendar.ts';
import { dropSpikes } from '../../research/clean.ts';

const ROOT = '../data';
const OUT = 'public/data';

/* The adversarial simulation's halt rate, published by `cargo test` (and by
   CI, which is the only machine that runs it on every change) into
   `data/sim-report.json`. Copied before the gate below, because it does not
   come from the hourly file and should not disappear with it. */
mkdirSync(OUT, { recursive: true });
if (existsSync(`${ROOT}/sim-report.json`)) {
  writeFileSync(`${OUT}/sim-report.json`, readFileSync(`${ROOT}/sim-report.json`));
}

// The raw hourly file is 2.6MB and is not committed; the derived files under
// public/data are. A clone without the raw file keeps what is committed rather
// than failing the build — regenerating is only possible with the source.
if (!existsSync(`${ROOT}/_hourly.json`)) {
  if (existsSync(`${OUT}/markets.json`)) {
    console.log(`${ROOT}/_hourly.json is absent — keeping the committed public/data (run \`npm run data\` at the repo root to refetch)`);
    process.exit(0);
  }
  console.error(`${ROOT}/_hourly.json is absent and public/data is empty; run \`npm run data\` at the repo root first`);
  process.exit(1);
}
const MAX_ABS_HOURLY = 0.25;   // a >25% hourly move is a bad print, not a return
const CURVE_POINTS = 260;      // enough to read, small enough to ship

type Row = [number, number];

interface Point { t: number; n: number; d: number }

/**
 * Walk hourly closes and compound each session's return into the class that
 * owned it. Intervals straddling a boundary are dropped rather than guessed —
 * the same "strict" attribution the study uses, so the two agree.
 */
function curve(rows: Row[]): { points: Point[]; nights: number; days: number } {
  let navN = 1, navD = 1;
  const raw: Point[] = [];
  let nights = 0, days = 0;
  let prevSession: Session | null = null;

  for (let i = 1; i < rows.length; i++) {
    const [t0, c0] = rows[i - 1];
    const [t1, c1] = rows[i];
    if (c0 <= 0 || c1 <= 0 || t1 <= t0) continue;

    const r = Math.log(c1 / c0);
    if (!Number.isFinite(r) || Math.abs(r) > MAX_ABS_HOURLY) continue;

    const s0 = sessionAt(t0);
    const s1 = sessionAt(t1);
    if (s0 !== s1) continue;                          // straddles a boundary

    if (s0 === Session.Closed) navN *= Math.exp(r); else navD *= Math.exp(r);
    if (prevSession !== s0) {
      if (s0 === Session.Closed) nights++; else days++;
      prevSession = s0;
    }
    raw.push({ t: t1, n: navN, d: navD });
  }

  // Downsample by index, always keeping the last point so the endpoint is exact.
  const step = Math.max(1, Math.floor(raw.length / CURVE_POINTS));
  const points = raw.filter((_, i) => i % step === 0);
  if (raw.length && points.at(-1)!.t !== raw.at(-1)!.t) points.push(raw.at(-1)!);

  return { points, nights, days };
}

const hourly = JSON.parse(readFileSync(`${ROOT}/_hourly.json`, 'utf8'));
const study = JSON.parse(readFileSync(`${ROOT}/session-study.json`, 'utf8'));
const universe = JSON.parse(readFileSync(`${ROOT}/universe.json`, 'utf8'));
const exec = JSON.parse(readFileSync(`${ROOT}/executability.json`, 'utf8'));

const meta = new Map<string, any>(universe.assets.map((a: any) => [a.symbol, a]));
const stat = new Map<string, any>(
  [...study.equities, ...study.controls].map((e: any) => [e.symbol, e]),
);

const assets = hourly.assets
  .map((a: any) => {
    // Same rejection the study applies, from the same module — the curve on
    // screen and the statistics beside it have to be describing one dataset.
    const { rows } = dropSpikes(a.rows as Row[]);
    const { points, nights, days } = curve(rows);
    if (points.length < 40) return null;
    const m = meta.get(a.symbol);
    const s = stat.get(a.symbol);
    return {
      symbol: a.symbol,
      name: m?.co ?? a.symbol,
      kind: a.kind,
      mint: a.mint,
      decimals: m?.decimals ?? 8,
      price: m?.price ?? rows.at(-1)![1],
      liquidity: a.liquidity ?? 0,
      first: rows[0][0],
      last: rows.at(-1)![0],
      days: (rows.at(-1)![0] - rows[0][0]) / SEC_PER_DAY,
      hours: rows.length,
      sessions: { nights, days },
      // rounded only for transport; four decimals is finer than any pixel
      points: points.map(p => ({ t: p.t, n: +p.n.toFixed(4), d: +p.d.toFixed(4) })),
      night: s?.night ?? null,
      day: s?.day ?? null,
    };
  })
  .filter(Boolean)
  .sort((a: any, b: any) => (b!.liquidity ?? 0) - (a!.liquidity ?? 0));

/**
 * The figures the landing page quotes, computed here rather than typed there.
 *
 * Prose drifts from data silently — a number gets corrected in the study and
 * the sentence describing it does not. Deriving them at build time means the
 * only way for the copy to be wrong is for the study to be wrong.
 */
function headline() {
  const eq = study.equities as any[];
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const nightVol = mean(eq.map(e => e.night.stdev));
  const dayVol = mean(eq.map(e => e.day.stdev));
  return {
    assets: assets.length,
    equities: eq.length,
    closes: hourly.assets.reduce((n: number, a: any) => n + a.rows.length, 0),
    sessions: assets.reduce((n: number, a: any) => n + a.sessions.nights + a.sessions.days, 0),
    spanDays: Math.round(Math.max(...assets.map((a: any) => a.days))),
    nightVol,
    dayVol,
    volRatio: nightVol / dayVol,
    nightMoreVolatile: eq.filter(e => e.night.stdev > e.day.stdev).length,
    nightCum: study.pooled.night.meanCum,
    dayCum: study.pooled.day.meanCum,
    significant: Math.round(
      (study.pooled.night.shareSignificant + study.pooled.day.shareSignificant) * eq.length,
    ),
    spikesDropped: study.spikesDropped ?? 0,
    barsTotal: study.barsTotal ?? 0,
  };
}

mkdirSync(OUT, { recursive: true });
mkdirSync(`${OUT}/curves`, { recursive: true });

// The list page needs summaries; only a detail page needs a curve. Shipping
// both together would make every visitor pay for 26 curves to see a table.
const index = assets.map(({ points, ...rest }: any) => ({
  ...rest,
  endNight: points.at(-1)?.n ?? 1,
  endDay: points.at(-1)?.d ?? 1,
}));
const head = headline();
writeFileSync(`${OUT}/markets.json`, JSON.stringify({
  // The snapshot the data came from, not the moment this ran — a wall clock
  // here makes a committed file churn on every build for no change.
  generated: hourly.generated,
  source: hourly.generated,
  headline: head,
  assets: index,
}));
for (const a of assets as any[]) {
  writeFileSync(`${OUT}/curves/${a.symbol}.json`,
    JSON.stringify({ symbol: a.symbol, points: a.points }));
}

writeFileSync(`${OUT}/study.json`, JSON.stringify(study));
writeFileSync(`${OUT}/execution.json`, JSON.stringify(exec));

/* ── token metadata the share mints point at ──────────────────────────────
   Each class's mint carries its name on chain and a URI pointing here. The
   file is the off-chain half wallets and explorers fetch for an image and a
   description, and it exists for whatever vault the manifest describes. */
try {
  const m = JSON.parse(readFileSync('public/devnet.json', 'utf8'));
  const event = m.sessionKind === 1;
  // Named by the ticker the program actually wrote into the mint, because the
  // mint's URI is `{base}/{TICKER}.json` and nothing else will be fetched.
  const sym = m.vaultSymbol ?? m.symbol;
  mkdirSync('public/meta', { recursive: true });
  for (const [cls, suffix] of [['night', event ? 'THEN' : 'NIGHT'], ['day', event ? 'NOW' : 'DAY']] as const) {
    const ticker = `${sym}.${suffix}`;
    writeFileSync(`public/meta/${ticker}.json`, JSON.stringify({
      name: `SESSION ${ticker}`,
      symbol: ticker,
      description: cls === 'day'
        ? `${m.symbol} for the hours the real market is open. Always exitable, and it never holds the overnight gap.`
        : `${m.symbol} for the hours the real market is shut. It wears every gap, and it is the only way to sell them.`,
      external_url: `https://session-roan.vercel.app/markets/${m.symbol}`,
      attributes: [
        { trait_type: 'protocol', value: 'SESSION' },
        { trait_type: 'class', value: suffix },
        { trait_type: 'underlying', value: m.underlyingMint },
        { trait_type: 'vault', value: m.vault },
        { trait_type: 'cluster', value: m.cluster },
      ],
    }));
  }
  console.log(`meta/          ${sym}.${event ? 'THEN' : 'NIGHT'}.json, ${sym}.${event ? 'NOW' : 'DAY'}.json`);
} catch { /* no manifest yet: the site builds without a live vault */ }

const kb = (s: string) => (Buffer.byteLength(s) / 1024).toFixed(0);
console.log(`markets.json   ${kb(JSON.stringify({ assets: index }))}kb   ${assets.length} assets`);
console.log(`curves/        ${kb(JSON.stringify((assets as any[])[0].points))}kb each`);
console.log(`study.json     ${kb(JSON.stringify(study))}kb`);
console.log(`points/asset   ~${Math.round(assets.reduce((s: number, a: any) => s + a.points.length, 0) / assets.length)}`);
console.log(`sessions       ${assets.reduce((s: number, a: any) => s + a.sessions.nights + a.sessions.days, 0)} across all assets`);
console.log(`headline       night σ ${(head.nightVol * 100).toFixed(2)}% vs day ${(head.dayVol * 100).toFixed(2)}% ` +
  `(${((head.volRatio - 1) * 100).toFixed(0)}% more), wider in ${head.nightMoreVolatile}/${head.equities}`);
