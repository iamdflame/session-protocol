#!/usr/bin/env node
/* Snapshot Pyth's published trading schedules for the listings the bell
 * serves, into tests/vectors/pyth-schedule.json.
 *
 * `tests/pyth-schedule.check.ts` holds our NYSE calendar against these strings
 * day by day. The snapshot is committed rather than fetched in the test so the
 * check is reproducible and offline; refreshing it is a deliberate act whose
 * diff shows exactly which holidays Pyth added or changed.
 *
 *   node scripts/pyth-schedule.mjs --refresh
 */
import { writeFileSync } from 'node:fs';

const SYMBOLS = ['NVDA', 'SPY', 'TSLA', 'AAPL', 'QQQ', 'META', 'IBM'].map(s => `Equity.US.${s}/USD`);
const OUT = 'tests/vectors/pyth-schedule.json';

if (!process.argv.includes('--refresh')) {
  console.log(`usage: node scripts/pyth-schedule.mjs --refresh   (rewrites ${OUT})`);
  process.exit(2);
}

const r = await fetch('https://pyth.dourolabs.app/v1/symbols', { headers: { accept: 'application/json' } });
if (!r.ok) throw new Error(`symbols: http ${r.status}`);
const all = await r.json();

const symbols = {};
for (const want of SYMBOLS) {
  const s = all.find(x => x.symbol === want);
  if (!s) throw new Error(`${want} is not in Pyth's symbol list`);
  const sessions = {};
  for (const [k, v] of Object.entries(s.market_sessions ?? {})) sessions[k] = v.schedule;
  symbols[want] = {
    pyth_lazer_id: s.pyth_lazer_id,
    state: s.state,
    schedule: s.schedule,
    market_sessions: sessions,
  };
}

const fetched = new Date().toISOString();
writeFileSync(OUT, JSON.stringify({
  note: 'Pyth Pro trading schedules, as published at https://pyth.dourolabs.app/v1/symbols. ' +
    'Refreshed with `node scripts/pyth-schedule.mjs --refresh`; read by tests/pyth-schedule.check.ts.',
  fetched,
  symbols,
}, null, 2) + '\n');
console.log(`wrote ${OUT}: ${SYMBOLS.length} symbols, fetched ${fetched}`);
