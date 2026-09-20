/* ───────────────────────────────────────────────────────────────────────────
   PRISM — the refraction engine

   A belief is never one bet. "AI is a bubble but Anthropic survives it" is
   secretly a bundle: mostly a bet that the stock market goes up, partly a bet
   on AI in general, and — somewhere at the bottom — the idea you actually had.

   This module splits a portfolio into that spectrum, and then projects the
   unwanted bands out of it. No dependencies. The numbers on screen are these
   numbers.
   ─────────────────────────────────────────────────────────────────────────── */

/* ── linear algebra ─────────────────────────────────────────────────────── */

const zeros = (n, m) => Array.from({ length: n }, () => new Float64Array(m));

/** Jacobi eigendecomposition for a real symmetric matrix.
 *  Returns eigenvalues (desc) and matching orthonormal eigenvectors as columns. */
export function eigenSym(Ain, sweeps = 100, tol = 1e-11) {
  const n = Ain.length;
  const A = Ain.map(r => Float64Array.from(r));
  const V = zeros(n, n);
  for (let i = 0; i < n; i++) V[i][i] = 1;

  for (let s = 0; s < sweeps; s++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
    if (Math.sqrt(2 * off) < tol) break;

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-14) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), sn = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p], akq = A[k][q];
          A[k][p] = c * akp - sn * akq;
          A[k][q] = sn * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k], aqk = A[q][k];
          A[p][k] = c * apk - sn * aqk;
          A[q][k] = sn * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - sn * vkq;
          V[k][q] = sn * vkp + c * vkq;
        }
      }
    }
  }

  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => A[b][b] - A[a][a]);
  return {
    values: idx.map(i => A[i][i]),
    // vectors[k] = k-th eigenvector as a plain array of length n
    vectors: idx.map(i => {
      const v = Array.from({ length: n }, (_, r) => V[r][i]);
      // sign convention: make the largest-magnitude entry positive, so factor
      // directions are stable between runs and readable in the UI
      let m = 0;
      for (let r = 1; r < n; r++) if (Math.abs(v[r]) > Math.abs(v[m])) m = r;
      return v[m] < 0 ? v.map(x => -x) : v;
    }),
  };
}

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

/* ── return matrix construction ─────────────────────────────────────────── */

const DAY = 86400;
const day = t => Math.floor(t / DAY) * DAY;   // candle stamps snap to UTC days

/** Pick the (assets × days) window that maximises usable data.
 *
 *  Assets list on different dates — OpenAI has traded since Oct 2025, NVDAx
 *  since Mar 2026 — so an early start buys history at the cost of names. We
 *  search the start dates and keep the best assets×days area.
 *
 *  The end is the *most recent* close in the set, not the earliest: one token
 *  that stopped trading must not truncate the window for everybody else. Such
 *  a token simply fails the coverage test and drops out.
 */
function chooseWindow(assets, minDays = 55, minAssets = 10) {
  const first = a => day(a.rows[0].t), last = a => day(a.rows.at(-1).t);
  const end = Math.max(...assets.map(last));
  const fresh = a => last(a) >= end - 3 * DAY;            // still trading

  const starts = [...new Set(assets.map(first))].sort((a, b) => a - b);
  let best = null;
  for (const st of starts) {
    const keep = assets.filter(a => first(a) <= st && fresh(a));
    const days = Math.round((end - st) / DAY);
    if (days < minDays || keep.length < minAssets) continue;
    const score = keep.length * Math.log(days);           // names vs history
    if (!best || score > best.score) best = { score, start: st, end, keep, days };
  }
  if (best) return best;

  // nothing cleared the bar — fall back to whatever overlaps at all
  const keep = assets.filter(fresh);
  return { start: Math.max(...keep.map(first)), end, keep };
}

/** Build aligned daily log-return matrix. Forward-fills gaps and winsorises
 *  tails — thin on-chain pools print the occasional absurd candle. */
export function buildReturns(assetsIn) {
  const assets = assetsIn.filter(a => a.rows && a.rows.length > 30)
    .map(a => ({ ...a, rows: a.rows.map(r => Array.isArray(r)
      ? { t: day(r[0]), c: +r[1] } : { t: day(r.t), c: +r.c }) }));
  const { start, end, keep } = chooseWindow(assets);

  const grid = [];
  for (let t = start; t <= end; t += DAY) grid.push(t);

  const px = keep.map(a => {
    const m = new Map(a.rows.map(r => [r.t, r.c]));
    let last = a.rows.find(r => r.t >= start)?.c ?? a.rows[0].c;
    return grid.map(t => { const v = m.get(t); if (v > 0) last = v; return last; });
  });

  const T = grid.length - 1, N = keep.length;
  const R = zeros(T, N);
  for (let i = 0; i < N; i++)
    for (let t = 0; t < T; t++) R[t][i] = Math.log(px[i][t + 1] / px[i][t]);

  // winsorise at ±4σ per asset
  for (let i = 0; i < N; i++) {
    let m = 0; for (let t = 0; t < T; t++) m += R[t][i]; m /= T;
    let v = 0; for (let t = 0; t < T; t++) v += (R[t][i] - m) ** 2; v = Math.sqrt(v / (T - 1)) || 1e-9;
    const lo = m - 4 * v, hi = m + 4 * v;
    for (let t = 0; t < T; t++) R[t][i] = Math.min(hi, Math.max(lo, R[t][i]));
  }

  const mean = new Float64Array(N), sd = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let m = 0; for (let t = 0; t < T; t++) m += R[t][i]; m /= T; mean[i] = m;
    let v = 0; for (let t = 0; t < T; t++) v += (R[t][i] - m) ** 2;
    sd[i] = Math.sqrt(v / (T - 1)) || 1e-9;
  }
  const Z = zeros(T, N);
  for (let i = 0; i < N; i++)
    for (let t = 0; t < T; t++) Z[t][i] = (R[t][i] - mean[i]) / sd[i];

  return { assets: keep, dates: grid.slice(1), R, Z, mean, sd, T, N };
}

/* ── factor extraction + naming ─────────────────────────────────────────── */

/** Themes used to *name* the statistical factors. The factors are discovered
 *  from the data; these tags only tell us what to call what we found. */
export const THEMES = [
  ['Frontier AI labs',   ['ai-lab']],
  ['The AI trade',       ['ai']],
  ['Private markets',    ['private']],
  ['Semiconductors',     ['semis']],
  ['Crypto proxies',     ['crypto']],
  ['Big tech',           ['bigtech']],
  ['Defensive / staples',['defensive']],
  ['Defense & space',    ['defense', 'space']],
  ['Robotics',           ['robotics']],
  ['Index beta',         ['index']],
];

function corr(a, b) {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return num / (Math.sqrt(da * db) || 1e-12);
}

/** Give a discovered factor a human name by matching its loading pattern
 *  against theme membership.
 *
 *  The sign of an eigenvector is arbitrary — v and −v describe the same axis,
 *  and (v·w)v is identical either way — so when a factor matches a theme
 *  *negatively* we flip it rather than label it backwards. Without this, a
 *  factor whose semiconductors all load negative gets called "Semiconductors",
 *  which is the opposite of what the reader will assume.
 */
function nameFactor(vec, assets, k, used) {
  const allPos = vec.filter(v => v > 0).length >= vec.length * 0.8;
  if (k === 0 && allPos)
    return { name: 'Market beta', blurb: 'everything moving together', flip: false };
  if (k === 0 && vec.filter(v => v < 0).length >= vec.length * 0.8)
    return { name: 'Market beta', blurb: 'everything moving together', flip: true };

  /* Score each theme by how far its members sit from everyone else along this
     axis. A factor usually has two ends, and the honest name says which. */
  const scored = [];
  for (const [name, tags] of THEMES) {
    const inT = [], out = [];
    assets.forEach((a, i) =>
      ((a.tags || []).some(t => tags.includes(t)) ? inT : out).push(vec[i]));
    if (inT.length < 2 || out.length < 2) continue;
    const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
    scored.push({ name, sep: mean(inT) - mean(out) });
  }
  scored.sort((a, b) => b.sep - a.sep);

  const pos = scored.find(s => !used.has(s.name));
  const neg = [...scored].reverse().find(s => !used.has(s.name) && s.name !== pos?.name);
  const STRONG = 0.16, WEAK = 0.09;

  // a genuine rotation: both ends carry a recognisable bloc
  if (pos && neg && pos.sep > WEAK && -neg.sep > WEAK &&
      (pos.sep > STRONG || -neg.sep > STRONG)) {
    used.add(pos.name); used.add(neg.name);
    // lower-case the trailing bloc, but never mangle an acronym ("the AI trade")
    const low = s => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
    return { name: `${pos.name} vs ${low(neg.name)}`,
             blurb: 'a rotation between two blocs', flip: false };
  }
  // one end dominates — name it after that end, flipping if it is the negative one
  const solo = pos && neg ? (pos.sep >= -neg.sep ? pos : neg) : (pos || neg);
  if (solo && Math.abs(solo.sep) > STRONG) {
    used.add(solo.name);
    return { name: solo.name, blurb: 'moving as a bloc', flip: solo.sep < 0 };
  }

  const order = assets.map((a, i) => [a.symbol, vec[i]]).sort((x, y) => y[1] - x[1]);
  return {
    name: `${order[0][0]} vs ${order.at(-1)[0]}`,
    blurb: 'a rotation the data found on its own',
    flip: false,
  };
}

/** Principal-component factor model over the standardised return matrix. */
export function buildFactors(model, k = 5) {
  const { Z, T, N, assets } = model;
  const C = zeros(N, N);
  for (let i = 0; i < N; i++)
    for (let j = i; j < N; j++) {
      let s = 0; for (let t = 0; t < T; t++) s += Z[t][i] * Z[t][j];
      C[i][j] = C[j][i] = s / (T - 1);
    }

  const { values, vectors } = eigenSym(C);
  const total = values.reduce((s, v) => s + Math.max(v, 0), 0) || 1;
  const used = new Set();

  const factors = [];
  for (let f = 0; f < Math.min(k, N); f++) {
    const { name, blurb, flip } = nameFactor(vectors[f], assets, f, used);
    const vec = flip ? vectors[f].map(x => -x) : vectors[f];
    factors.push({
      name, blurb,
      eigenvalue: values[f],
      share: values[f] / total,            // share of universe variance
      loadings: vec,                        // orthonormal, length N
    });
  }
  return { factors, eigenvalues: values, totalVar: total, C };
}

/* ── the spectrum: variance attribution ─────────────────────────────────── */

/** Split a portfolio's risk into named factor bands plus the residual.
 *  The residual — the part no systematic factor explains — is the only part
 *  that is actually *your idea*. Everything else you were going to own by
 *  accident. Bands sum to 1. */
export function refract(weights, model, fm) {
  const { N } = model;
  const w = Float64Array.from(weights);

  const bands = fm.factors.map(f => {
    const exposure = dot(Array.from(w), f.loadings);   // b_k
    return { name: f.name, blurb: f.blurb, exposure, variance: exposure * exposure * f.eigenvalue };
  });

  // total variance of the portfolio in standardised space: wᵀCw
  let total = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) total += w[i] * fm.C[i][j] * w[j];
  total = Math.max(total, 1e-12);

  const explained = bands.reduce((s, b) => s + b.variance, 0);
  const residual = Math.max(total - explained, 0);

  const out = bands.map(b => ({ ...b, share: b.variance / total }));
  return {
    bands: out,
    yours: residual / total,          // ← the headline number
    totalVar: total,
    vol: Math.sqrt(total),
  };
}

/* ── evidence ───────────────────────────────────────────────────────────── */

/** Daily return series the weights would actually have produced. */
export function series(weights, model) {
  const { R, T, N } = model;
  const out = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    let s = 0;
    for (let i = 0; i < N; i++) s += weights[i] * R[t][i];
    out[t] = s;
  }
  return out;
}

const pearson = (a, b) => {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return num / (Math.sqrt(da * db) || 1e-12);
};

/** The falsifiable claim: how tied to the market is this position, really?
 *
 *  Returns the correlation and annualised vol, the regression slope against the
 *  market (beta), and the daily scatter behind both — so the claim can be shown
 *  rather than asserted. A tilted cloud is market exposure; a round one is not.
 */
export function evidence(weights, model, refSymbol = 'SPYx') {
  const p = series(weights, model);
  let ri = model.assets.findIndex(a => a.symbol === refSymbol);
  if (ri < 0) ri = model.assets.findIndex(a => (a.tags || []).includes('index'));
  const ref = ri >= 0 ? model.R.map(row => row[ri]) : null;

  const n = p.length;
  let m = 0; for (let i = 0; i < n; i++) m += p[i]; m /= n;
  let v = 0; for (let i = 0; i < n; i++) v += (p[i] - m) ** 2;
  const vol = Math.sqrt(v / (n - 1)) * Math.sqrt(365);

  let beta = null, pts = [];
  if (ref) {
    let mr = 0; for (let i = 0; i < n; i++) mr += ref[i]; mr /= n;
    let cov = 0, vr = 0;
    for (let i = 0; i < n; i++) {
      cov += (ref[i] - mr) * (p[i] - m);
      vr += (ref[i] - mr) ** 2;
    }
    beta = cov / (vr || 1e-12);
    pts = Array.from({ length: n }, (_, i) => ({ x: ref[i], y: p[i], t: model.dates[i] }));
  }

  return {
    vol, beta, pts,
    refSymbol: ri >= 0 ? model.assets[ri].symbol : null,
    corr: ref ? pearson(Array.from(p), ref) : null,
  };
}

/* ── the refraction: project unwanted bands out ─────────────────────────── */

/** Remove exposure to the chosen factors while keeping the position tradeable.
 *
 *  Because principal components are orthonormal, the projection onto the
 *  null-space of the unwanted loadings collapses to a subtraction:
 *      w ← w − Σ (vₖ · w) vₖ
 *  Clipping for executability knocks it slightly off-neutral, so we alternate
 *  projection and clipping a few times — each pass lands closer to both.
 */
export function project(weights, fm, stripIdx, opts = {}) {
  const { minWeight = 0.018, maxWeight = 0.34, passes = 6 } = opts;
  let w = Array.from(weights);

  const normalise = v => {
    const s = v.reduce((a, x) => a + Math.abs(x), 0) || 1;
    return v.map(x => x / s);
  };

  for (let p = 0; p < passes; p++) {
    for (const k of stripIdx) {
      const v = fm.factors[k].loadings;
      const c = dot(w, v);
      for (let i = 0; i < w.length; i++) w[i] -= c * v[i];
    }
    w = normalise(w);
    if (p === passes - 1) break;
    // executability: drop dust, cap concentration
    w = w.map(x => (Math.abs(x) < minWeight ? 0 : Math.sign(x) * Math.min(Math.abs(x), maxWeight)));
    if (w.every(x => x === 0)) return normalise(Array.from(weights));
    w = normalise(w);
  }
  return normalise(w.map(x => (Math.abs(x) < minWeight ? 0 : x)));
}
