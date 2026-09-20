/* Cross-language settlement vectors. If the chain and the SDK ever disagree,
   a keeper quotes a number the chain will not produce. */
import { settle, WAD, type NavState, type ShareClass, type FundingParams } from '../sdk/src/settle.ts';
import { writeFileSync } from 'node:fs';

let seed = 0xc0ffee;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <T,>(xs: T[]): T => xs[(rnd() * xs.length) | 0];

const cases: any[] = [];
const FP: FundingParams[] = [
  { kBps: 0n, maxBps: 0n },
  { kBps: 2_500n, maxBps: 50n },
  { kBps: 10_000n, maxBps: 200n },
];

// structured edges first
const edges: [bigint, bigint][] = [
  [0n, 1_000_000n], [1_000_000n, 0n], [1n, 1n],
  [1_000_000n, 1_000_000n], [3_000_000n, 1_000_000n], [1n, 1_000_000_000_000n],
];
for (const [ns, ds] of edges)
  for (const exposed of ['night', 'day'] as ShareClass[])
    for (const fp of FP)
      for (const [p0, p1] of [[WAD, WAD], [WAD, WAD * 11n / 10n], [WAD, WAD * 9n / 10n]]) {
        const s: NavState = { nightSupply: ns, daySupply: ds, nightNav: WAD, dayNav: WAD, exposed, lastMark: p0 };
        const out = settle(s, p1, fp);
        cases.push({
          in: { ...s, nightSupply: `${ns}`, daySupply: `${ds}`, nightNav: `${WAD}`, dayNav: `${WAD}`, lastMark: `${p0}` },
          newMark: `${p1}`, fp: { kBps: `${fp.kBps}`, maxBps: `${fp.maxBps}` },
          out: { nightNav: `${out.nightNav}`, dayNav: `${out.dayNav}`, exposed: out.exposed,
                 funding: `${out.funding}`, handoffDelta: `${out.handoffDelta}`,
                 valueNight: `${out.valueNight}`, valueDay: `${out.valueDay}` },
        });
      }

// then a randomised sweep
for (let i = 0; i < 1500; i++) {
  const ns = BigInt(Math.floor(rnd() * 1e12));
  const ds = BigInt(Math.floor(rnd() * 1e12));
  const navN = WAD * BigInt(1 + Math.floor(rnd() * 500)) / 100n;
  const navD = WAD * BigInt(1 + Math.floor(rnd() * 500)) / 100n;
  const p0 = WAD * BigInt(1 + Math.floor(rnd() * 10000)) / 1000n;
  const p1 = WAD * BigInt(1 + Math.floor(rnd() * 10000)) / 1000n;
  const exposed = pick(['night', 'day'] as ShareClass[]);
  const fp = pick(FP);
  const s: NavState = { nightSupply: ns, daySupply: ds, nightNav: navN, dayNav: navD, exposed, lastMark: p0 };
  let out;
  try { out = settle(s, p1, fp); } catch { continue; }
  cases.push({
    in: { nightSupply: `${ns}`, daySupply: `${ds}`, nightNav: `${navN}`, dayNav: `${navD}`, exposed, lastMark: `${p0}` },
    newMark: `${p1}`, fp: { kBps: `${fp.kBps}`, maxBps: `${fp.maxBps}` },
    out: { nightNav: `${out.nightNav}`, dayNav: `${out.dayNav}`, exposed: out.exposed,
           funding: `${out.funding}`, handoffDelta: `${out.handoffDelta}`,
           valueNight: `${out.valueNight}`, valueDay: `${out.valueDay}` },
  });
}

writeFileSync('tests/vectors/settle.json', JSON.stringify({
  generated: new Date().toISOString(),
  note: 'Rust settle() must reproduce every one of these exactly.',
  cases,
}, null, 0));
console.log(`${cases.length} settlement vectors`);
