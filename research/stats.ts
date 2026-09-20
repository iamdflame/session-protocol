/* ───────────────────────────────────────────────────────────────────────────
   Statistics for the session study.

   The headline number for this project is a cumulative return, and cumulative
   returns are the easiest thing in finance to fool yourself with. Everything
   here exists to make the claim falsifiable: autocorrelation-robust standard
   errors, a bootstrap that does not assume normality, and an ex-extremes mean
   that shows whether two good days are carrying the result.
   ─────────────────────────────────────────────────────────────────────────── */

export const mean = (x: number[]): number =>
  x.length ? x.reduce((s, v) => s + v, 0) / x.length : 0;

export function variance(x: number[]): number {
  if (x.length < 2) return 0;
  const m = mean(x);
  return x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1);
}

export const stdev = (x: number[]): number => Math.sqrt(variance(x));

/** Autocovariance at lag k. */
function autocov(x: number[], k: number): number {
  const n = x.length, m = mean(x);
  let s = 0;
  for (let t = k; t < n; t++) s += (x[t] - m) * (x[t - k] - m);
  return s / n;
}

/**
 * Newey–West standard error of the mean.
 *
 * Session returns are not independent draws — overnight moves cluster, and a
 * weekend is three sessions of news in one observation. A plain SE would
 * overstate significance, so the SE is corrected for serial correlation with
 * a Bartlett kernel at the usual automatic lag.
 */
export function neweyWestSE(x: number[]): number {
  const n = x.length;
  if (n < 3) return NaN;
  const L = Math.max(1, Math.floor(4 * Math.pow(n / 100, 2 / 9)));
  let s = autocov(x, 0);
  for (let k = 1; k <= L && k < n; k++) {
    s += 2 * (1 - k / (L + 1)) * autocov(x, k);
  }
  return Math.sqrt(Math.max(s, 0) / n);
}

/** Percentile bootstrap CI for the mean; makes no normality assumption. */
export function bootstrapCI(
  x: number[], iters = 10_000, alpha = 0.05, seed = 0x5eed,
): [number, number] {
  const n = x.length;
  if (n < 3) return [NaN, NaN];
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  const means = new Float64Array(iters);
  for (let i = 0; i < iters; i++) {
    let acc = 0;
    for (let j = 0; j < n; j++) acc += x[(rnd() * n) | 0];
    means[i] = acc / n;
  }
  means.sort();
  const lo = means[Math.floor((alpha / 2) * iters)];
  const hi = means[Math.min(iters - 1, Math.floor((1 - alpha / 2) * iters))];
  return [lo, hi];
}

export interface Summary {
  n: number;
  mean: number;
  cumulative: number;      // compounded, from summed log returns
  stdev: number;
  se: number;              // Newey-West
  t: number;
  ci: [number, number];    // bootstrap, on the mean
  hitRate: number;         // share of observations above zero
  meanExExtremes: number;  // best and worst observation removed
  perHour: number;         // mean log return per hour of exposure
}

/** `x` are log returns per session; `hours` the exposure each one covered. */
export function summarise(x: number[], hours: number[]): Summary {
  const n = x.length;
  const m = mean(x);
  const se = neweyWestSE(x);
  const sorted = [...x].sort((a, b) => a - b);
  const trimmed = n > 2 ? sorted.slice(1, -1) : sorted;
  const totalHours = hours.reduce((s, v) => s + v, 0);

  return {
    n,
    mean: m,
    cumulative: Math.exp(x.reduce((s, v) => s + v, 0)) - 1,
    stdev: stdev(x),
    se,
    t: se > 0 ? m / se : NaN,
    ci: bootstrapCI(x),
    hitRate: n ? x.filter(v => v > 0).length / n : 0,
    meanExExtremes: mean(trimmed),
    perHour: totalHours > 0 ? x.reduce((s, v) => s + v, 0) / totalHours : 0,
  };
}

/** Welch's t for two independent samples with unequal variance. */
export function welchT(a: number[], b: number[]): { t: number; df: number } {
  const va = variance(a) / a.length;
  const vb = variance(b) / b.length;
  const t = (mean(a) - mean(b)) / Math.sqrt(va + vb);
  const df = (va + vb) ** 2 /
    (va ** 2 / Math.max(a.length - 1, 1) + vb ** 2 / Math.max(b.length - 1, 1));
  return { t, df };
}

export const pct = (x: number, dp = 2): string => `${(x * 100).toFixed(dp)}%`;
export const bp = (x: number, dp = 2): string => `${(x * 10_000).toFixed(dp)}bp`;
