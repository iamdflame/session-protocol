/* ───────────────────────────────────────────────────────────────────────────
   Generate the inline ground script.

   The ground must be correct on the very first paint — a page about what is
   true *right now* should never flash the wrong answer. That means a blocking
   inline script, which cannot import the calendar module.

   So the calendar's *data* is precomputed here (DST windows, full closures,
   early closes) and the ~20 lines of session logic are emitted alongside it.
   The result is then checked against the real module across a quarter of a
   million timestamps. If they ever disagree the build fails, which is the only
   way a second implementation of this is acceptable.
   ─────────────────────────────────────────────────────────────────────────── */

import { writeFileSync, mkdirSync } from 'node:fs';
import {
  sessionAt, Session, holidays, earlyCloses, isDST,
  daysFromCivil, SEC_PER_DAY,
} from '../../sdk/src/calendar.ts';

const FROM_YEAR = 2024;
const TO_YEAR = 2032;

/**
 * DST windows as [startUTC, endUTC], found by scanning and then bisecting to the
 * second. Derived from `isDST` rather than re-deriving its rule, so whatever the
 * module says is what ships.
 */
function dstWindows(): [number, number][] {
  const out: [number, number][] = [];
  for (let y = FROM_YEAR; y <= TO_YEAR; y++) {
    const from = daysFromCivil(y, 1, 1) * SEC_PER_DAY;
    const to = daysFromCivil(y, 12, 31) * SEC_PER_DAY;
    const edges: number[] = [];
    let prev = isDST(from);
    for (let t = from; t <= to; t += 3600) {
      const now = isDST(t);
      if (now !== prev) {
        let lo = t - 3600, hi = t;                  // bisect the hour to the second
        while (hi - lo > 1) {
          const mid = Math.floor((lo + hi) / 2);   // not >>1: epoch seconds overflow int32
          if (isDST(mid) === prev) lo = mid; else hi = mid;
        }
        edges.push(hi);
        prev = now;
      }
    }
    if (edges.length === 2) out.push([edges[0], edges[1]]);
  }
  return out;
}

/**
 * Closure and early-close day numbers, resolved the way `sessionAt` resolves
 * them — a day is looked up in *its own* year's set.
 *
 * This is not the same as flattening `holidays(y)` for every y. When Jan 1 falls
 * on a Saturday the observed date lands on the previous December 31, in the
 * previous year's sets, where `sessionAt` never looks — so the Exchange stays
 * open, which is exactly NYSE Rule 7.2's year-end exception. Flattening would
 * close it and disagree with the program.
 */
function closures(): { hol: number[]; early: number[] } {
  const hol: number[] = [];
  const early: number[] = [];
  for (let y = FROM_YEAR; y <= TO_YEAR; y++) {
    const h = holidays(y);
    const e = earlyCloses(y);
    for (let d = daysFromCivil(y, 1, 1); d <= daysFromCivil(y, 12, 31); d++) {
      if (h.has(d)) hol.push(d);
      if (e.has(d)) early.push(d);
    }
  }
  return { hol, early };
}

const { hol, early } = closures();
const windows = dstWindows();

const script = `(function(){try{
var W=${JSON.stringify(windows)},H=${JSON.stringify(hol)},E=${JSON.stringify(early)};
function dst(t){for(var i=0;i<W.length;i++){if(t>=W[i][0]&&t<W[i][1])return 1}return 0}
function has(a,v){for(var i=0;i<a.length;i++){if(a[i]===v)return 1}return 0}
var t=Math.floor(Date.now()/1000),et=t+(dst(t)?-14400:-18000);
var d=Math.floor(et/86400),s=et-d*86400,w=((d%7)+7+4)%7,g='night';
if(w!==0&&w!==6&&!has(H,d)){var c=has(E,d)?46800:57600;if(s>=34200&&s<c)g='day'}
document.documentElement.dataset.session=g;
}catch(e){document.documentElement.dataset.session='night'}})();`;
/* No override is read. The ground used to honour a pinned preference from
   localStorage, which was harmless while it only chose a background. It now
   decides which class the interface calls *active*, and a pin would let the
   page say DAY holds the stock while the market is shut. */

/* ── verify against the real module ──────────────────────────────────────── */

/* Run the script that actually ships, not a transcription of it.

   This used to check a TypeScript re-implementation of the inline logic, so
   "verified across N timestamps" was a statement about a copy: the emitted
   string could drift from it and nothing would notice. Now the string itself
   is compiled once and executed per timestamp against a stub `document` and
   a frozen clock. */
const shipped = new Function('document', 'Date', script);
function inlineGround(t: number): 'day' | 'night' {
  const doc = { documentElement: { dataset: {} as Record<string, string> } };
  const FrozenDate = { now: () => t * 1000 };
  shipped(doc, FrozenDate);
  return doc.documentElement.dataset.session as 'day' | 'night';
}

const start = daysFromCivil(FROM_YEAR, 1, 1) * SEC_PER_DAY;
const end = daysFromCivil(TO_YEAR, 12, 31) * SEC_PER_DAY;
let checked = 0, mismatched = 0;
for (let t = start; t < end; t += 907) {           // a prime stride, so the
  const want = sessionAt(t) === Session.Open ? 'day' : 'night';   // sampling
  if (inlineGround(t) !== want) {                  // does not align to any
    if (mismatched < 4) {                          // hour or day grid
      console.error(`  mismatch at ${t}: inline=${inlineGround(t)} calendar=${want}`);
    }
    mismatched++;
  }
  checked++;
}

if (mismatched) {
  console.error(`\n${mismatched} of ${checked} timestamps disagree with the calendar.`);
  process.exit(1);
}

mkdirSync('src/generated', { recursive: true });
writeFileSync('src/generated/ground-script.ts',
  `// GENERATED by scripts/gen-ground.ts — do not edit.\n` +
  `// Verified against sdk/src/calendar.ts across ${checked.toLocaleString()} timestamps.\n` +
  `export const GROUND_SCRIPT = ${JSON.stringify(script)};\n`);

console.log(`ground script  ${(script.length / 1024).toFixed(1)}kb inline`);
console.log(`verified       ${checked.toLocaleString()} timestamps, ${FROM_YEAR}–${TO_YEAR}, 0 disagreements`);
console.log(`covers         ${hol.length} closures, ${early.length} early closes, ${windows.length} DST windows`);
