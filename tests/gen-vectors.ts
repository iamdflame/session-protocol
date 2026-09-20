/* Generates the shared calendar vectors that programs/session/src/calendar.rs
   must reproduce exactly. If Rust and TypeScript ever disagree about when a
   boundary fires, money moves to the wrong token class. */
import { sessionAt, holidays, earlyCloses, daysFromCivil, isDST } from '../sdk/src/calendar.ts';
import { writeFileSync } from 'node:fs';

const cases: { ts: number; session: string; note: string }[] = [];
const push = (ts: number, note: string) => cases.push({ ts, session: sessionAt(ts), note });

for (let y = 2024; y <= 2030; y++) {
  // every holiday and early close, at midday ET
  for (const d of holidays(y)) { push(d * 86400 + 17 * 3600, `holiday ${y}`); }
  for (const d of earlyCloses(y)) {
    push(d * 86400 + 17 * 3600, `early close ${y} 12:00ET`);
    push(d * 86400 + 18 * 3600 + 1, `early close ${y} 13:00ET+`);
  }
  // DST edges, sampled hourly across the switch
  for (const [m, dow, n] of [[3, 0, 2], [11, 0, 1]] as [number, number, number][]) {
    const first = daysFromCivil(y, m, 1);
    const w = ((first % 7) + 7 + 4) % 7;
    const day = first + ((dow - w + 7) % 7) + (n - 1) * 7;
    for (let h = -4; h <= 4; h++) push(day * 86400 + 7 * 3600 + h * 3600, `dst ${y} m${m} h${h}`);
  }
  // session edges on the first Wednesday of each month
  for (let m = 1; m <= 12; m++) {
    const first = daysFromCivil(y, m, 1);
    const w = ((first % 7) + 7 + 4) % 7;
    const wed = first + ((3 - w + 7) % 7);
    const off = isDST(wed * 86400 + 12 * 3600) ? 4 : 5;
    for (const [hh, mm] of [[9, 29], [9, 30], [12, 0], [15, 59], [16, 0], [20, 0]] as [number, number][])
      push(wed * 86400 + (hh + off) * 3600 + mm * 60, `edge ${y}-${m} ${hh}:${mm}ET`);
  }
}
// a deterministic pseudo-random sweep, to catch anything the structured cases miss
let seed = 0x5eed;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (let i = 0; i < 4000; i++)
  push(Math.floor(1704067200 + rnd() * 6 * 365 * 86400), 'random');

writeFileSync('tests/vectors/calendar.json', JSON.stringify({
  generated: new Date().toISOString(),
  note: 'Rust and TypeScript must agree on every one of these.',
  cases,
}, null, 0));
const open = cases.filter(c => c.session === 'open').length;
console.log(`${cases.length} vectors  (${open} open / ${cases.length - open} closed)`);
