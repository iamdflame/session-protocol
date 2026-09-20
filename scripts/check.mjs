// Sanity-check the refraction engine against the real snapshot.
// Everything the UI claims should be verifiable from a terminal.
import { readFileSync } from 'node:fs';
import { buildReturns, buildFactors, refract, project, evidence } from '../src/engine.js';
import { parseBelief, toWeights } from '../src/belief.js';

const data = JSON.parse(readFileSync('data/universe.json', 'utf8'));
const model = buildReturns(data.assets);
const fm = buildFactors(model, 5);
const syms = model.assets.map(a => a.symbol);

const pc = x => (x * 100).toFixed(1).padStart(5) + '%';
let failures = 0;
const failures0 = () => { failures++; };

console.log(`\n=== UNIVERSE ===`);
console.log(`${model.N} assets × ${model.T} daily returns ` +
  `(${new Date(model.dates[0] * 1e3).toISOString().slice(0,10)} → ` +
  `${new Date(model.dates.at(-1) * 1e3).toISOString().slice(0,10)})`);
console.log(`private: ${model.assets.filter(a=>a.kind==='private').map(a=>a.symbol).join(' ')}`);
console.log(`public : ${model.assets.filter(a=>a.kind==='public').map(a=>a.symbol).join(' ')}`);

/* ── linear algebra must be right or everything downstream is decoration ── */
console.log(`\n=== EIGENDECOMPOSITION SANITY ===`);
{
  const N = model.N;
  const trace = Array.from({ length: N }, (_, i) => fm.C[i][i]).reduce((s, x) => s + x, 0);
  const sumEig = fm.eigenvalues.reduce((s, x) => s + x, 0);
  console.log(`  trace(C) = ${trace.toFixed(4)}   Σλ = ${sumEig.toFixed(4)}   ` +
              `(correlation matrix ⇒ both should equal N = ${N})`);
  if (Math.abs(trace - sumEig) > 1e-6 * N) { console.log('  !! trace ≠ Σλ'); failures0(); }
  if (Math.abs(trace - N) > 1e-6 * N) { console.log('  !! trace ≠ N'); failures0(); }

  const v = fm.factors.map(f => f.loadings);
  let worstNorm = 0, worstOrth = 0;
  for (let i = 0; i < v.length; i++) {
    worstNorm = Math.max(worstNorm, Math.abs(v[i].reduce((s, x) => s + x * x, 0) - 1));
    for (let j = i + 1; j < v.length; j++)
      worstOrth = Math.max(worstOrth, Math.abs(v[i].reduce((s, x, k) => s + x * v[j][k], 0)));
  }
  console.log(`  worst |‖v‖−1| = ${worstNorm.toExponential(2)}   worst |vᵢ·vⱼ| = ${worstOrth.toExponential(2)}`);
  if (worstNorm > 1e-8 || worstOrth > 1e-8) { console.log('  !! eigenvectors not orthonormal'); failures0(); }

  const desc = fm.eigenvalues.every((x, i, a) => i === 0 || a[i - 1] >= x - 1e-12);
  console.log(`  eigenvalues descending: ${desc}`);
  if (!desc) { console.log('  !! not sorted'); failures0(); }
}

console.log(`\n=== FACTORS DISCOVERED (principal components) ===`);
fm.factors.forEach((f, k) => {
  const rank = f.loadings.map((v, i) => [syms[i], v]).sort((a, b) => b[1] - a[1]);
  console.log(`\nPC${k + 1}  "${f.name}"  — ${f.blurb}`);
  console.log(`     explains ${pc(f.share)} of universe variance   (eigenvalue ${f.eigenvalue.toFixed(2)})`);
  console.log(`     top +: ${rank.slice(0, 5).map(([s, v]) => `${s} ${v.toFixed(2)}`).join('  ')}`);
  console.log(`     top -: ${rank.slice(-4).reverse().map(([s, v]) => `${s} ${v.toFixed(2)}`).join('  ')}`);
});

const BELIEFS = [
  'AI is a bubble but Anthropic survives it',
  'OpenAI beats Google',
  'Private AI labs eat big tech',
  'Robotaxis are further away than the market thinks',
  'The defense buildout is real and underpriced',
  'Apple is done and Nvidia keeps winning',
  'Gold over crypto',
];

for (const text of BELIEFS) {
  const p = parseBelief(text, syms);
  console.log(`\n\n=== "${text}" ===`);
  if (!p.matched) { console.log('  !! no match'); failures++; continue; }
  console.log('  naive: ' + p.legs.map(l =>
    `${l.dir > 0 ? '+' : '-'}${l.sym}(${(Math.abs(l.weight) * 100).toFixed(0)}%)`).join(' '));

  const w0 = toWeights(p.legs, syms);
  const r0 = refract(w0, model, fm);
  const sum0 = r0.bands.reduce((s, b) => s + b.share, 0) + r0.yours;
  console.log(`\n  BEFORE   (bands+residual = ${sum0.toFixed(4)})`);
  r0.bands.forEach(b => console.log(`    ${pc(b.share)}  ${b.name}`));
  console.log(`    ${pc(r0.yours)}  << YOUR ACTUAL IDEA >>`);

  if (Math.abs(sum0 - 1) > 0.02) { console.log('  !! attribution does not sum to 1'); failures++; }

  // the realistic move: strip only the bet you did not mean to make
  const e0 = evidence(w0, model);
  const wM = project(w0, fm, [0]);
  const rM = refract(wM, model, fm);
  const dM = rM.bands.reduce((s, b) => s + b.share, 0) + rM.yours || 1;
  const eM = evidence(wM, model);
  console.log(`\n  STRIP MARKET BETA ONLY  (what a user actually does)`);
  console.log(`    your idea ${pc(r0.yours)} → ${pc(rM.yours / dM)}`);
  console.log(`    corr to ${e0.refSymbol}  ${e0.corr.toFixed(3)} → ${eM.corr.toFixed(3)}` +
              `     vol ${(e0.vol*100).toFixed(0)}% → ${(eM.vol*100).toFixed(0)}%`);
  if (Math.abs(eM.corr) > Math.abs(e0.corr) + 0.02) {
    console.log('  !! stripping market beta did not reduce market correlation'); failures++;
  }

  // strip every named systematic factor
  const strip = fm.factors.map((_, i) => i);
  const w1 = project(w0, fm, strip);
  const r1 = refract(w1, model, fm);
  const denom1 = r1.bands.reduce((s, b) => s + b.share, 0) + r1.yours || 1;
  console.log(`\n  AFTER stripping all ${strip.length} factors`);
  r1.bands.forEach(b => console.log(`    ${pc(b.share / denom1)}  ${b.name}`));
  console.log(`    ${pc(r1.yours / denom1)}  << YOUR ACTUAL IDEA >>`);
  const legs = w1.filter(x => Math.abs(x) > 0.004).length;
  console.log(`    ${legs} tradeable legs, gross ${(w1.reduce((s,x)=>s+Math.abs(x),0)).toFixed(3)}`);

  if (r1.yours / denom1 <= r0.yours) { console.log('  !! refraction did not increase purity'); failures++; }
  if (legs < 2) { console.log('  !! position collapsed'); failures++; }
}

console.log(`\n\n=== ${failures ? `${failures} CHECK(S) FAILED` : 'all checks passed'} ===\n`);
process.exit(failures ? 1 : 0);
