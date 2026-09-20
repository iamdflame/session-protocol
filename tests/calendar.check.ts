import { holidays, earlyCloses, isoDay, sessionAt, nextBoundary, easterSunday,
         daysFromCivil, civilFromDays, weekdayFromDays, isDST, Session } from '../sdk/src/calendar.ts';

const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
let fail = 0;
const eq = (got: any, want: any, what: string) => {
  const ok = String(got) === String(want);
  if (!ok) { console.log(`  FAIL ${what}: got ${got}, want ${want}`); fail++; }
  return ok;
};

// round-trip the civil date algorithms over a wide range
for (let z = -50000; z < 50000; z += 37) {
  const { y, m, d } = civilFromDays(z);
  if (daysFromCivil(y, m, d) !== z) { console.log(`  FAIL roundtrip at ${z}`); fail++; break; }
}
console.log('civil date round-trip over ±137 years: ' + (fail ? 'FAIL' : 'ok'));

console.log('\nEaster (known values):');
for (const [y, want] of [[2024,'2024-03-31'],[2025,'2025-04-20'],[2026,'2026-04-05'],[2027,'2027-03-28']] as [number,string][])
  eq(isoDay(easterSunday(y)), want, `easter ${y}`) && console.log(`  ${y}  ${isoDay(easterSunday(y))}  ok`);

console.log('\nNYSE holidays 2026:');
for (const d of [...holidays(2026)].sort((a,b)=>a-b))
  console.log(`  ${isoDay(d)}  ${DOW[weekdayFromDays(d)]}`);

console.log('\nEarly closes 2026:');
for (const d of [...earlyCloses(2026)].sort((a,b)=>a-b))
  console.log(`  ${isoDay(d)}  ${DOW[weekdayFromDays(d)]}`);

console.log('\nDST transitions 2026 (expect Mar 8, Nov 1):');
for (const [mo, dy] of [[3,7],[3,8],[3,9],[10,31],[11,1],[11,2]] as [number,number][]) {
  const t = daysFromCivil(2026, mo, dy) * 86400 + 18 * 3600;
  console.log(`  2026-${String(mo).padStart(2,'0')}-${String(dy).padStart(2,'0')} 18:00Z  DST=${isDST(t)}`);
}

console.log('\nSession probes:');
const probe = (iso: string, h: number, mi: number, want: Session, note: string) => {
  const [y,m,d] = iso.split('-').map(Number);
  // the given time is ET; convert to UTC using the offset at that instant
  let t = daysFromCivil(y,m,d)*86400 + h*3600 + mi*60;
  t = t - (isDST(t + 5*3600) ? -4*3600 : -5*3600);
  const got = sessionAt(t);
  const ok = got === want;
  if (!ok) fail++;
  console.log(`  ${ok?'ok  ':'FAIL'} ${iso} ${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')} ET -> ${got.padEnd(6)} ${note}`);
};
probe('2026-09-21', 9, 29, Session.Closed, 'one minute before the open');
probe('2026-09-21', 9, 30, Session.Open,   'the open');
probe('2026-09-21',15, 59, Session.Open,   'one minute before the close');
probe('2026-09-21',16,  0, Session.Closed, 'the close');
probe('2026-09-20',12,  0, Session.Closed, 'Sunday');
probe('2026-11-26',12,  0, Session.Closed, 'Thanksgiving');
probe('2026-11-27',12, 59, Session.Open,   'day after Thanksgiving, before 13:00');
probe('2026-11-27',13,  0, Session.Closed, 'day after Thanksgiving, early close');
probe('2026-04-03',12,  0, Session.Closed, 'Good Friday');
probe('2026-01-02',12,  0, Session.Open,   'first trading day of 2026');

console.log('\nBoundary walk from Fri 2026-09-18 12:00 ET:');
let t = daysFromCivil(2026,9,18)*86400 + 16*3600;  // 12:00 ET = 16:00 UTC (EDT)
for (let i = 0; i < 5; i++) {
  const b = nextBoundary(t);
  if (b === null) break;
  const et = b + (isDST(b) ? -4*3600 : -5*3600);
  const dd = Math.floor(et/86400), s = et - dd*86400;
  console.log(`  ${isoDay(dd)} ${DOW[weekdayFromDays(dd)]} ` +
    `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor(s%3600/60)).padStart(2,'0')} ET` +
    `  -> ${sessionAt(b)}   (weekend gap = ${((b-t)/3600).toFixed(1)}h)`);
  t = b;
}
console.log(fail ? `\n${fail} FAILURES` : '\nall calendar checks passed');
process.exit(fail ? 1 : 0);
