/* ───────────────────────────────────────────────────────────────────────────
   Everything the site reads.

   Two sources, and no third: files under /data, derived at build time from the
   real pool history through the real calendar, and live quotes from Jupiter.
   Nothing here invents a number, and nothing falls back to a plausible-looking
   default when a fetch fails — a market interface that guesses is worse than
   one that says it does not know.
   ─────────────────────────────────────────────────────────────────────────── */

import { useEffect, useRef, useState } from 'react';

export interface Stats {
  n: number;
  mean: number;
  cumulative: number;
  stdev: number;
  se: number;
  t: number;
  ci: [number, number];
  hitRate: number;
  meanExExtremes: number;
  perHour: number;
}

export interface Asset {
  symbol: string;
  name: string;
  kind: 'public' | 'private';
  mint: string;
  decimals: number;
  /** Last measured price from the history file — a starting point, not a quote. */
  price: number;
  liquidity: number;
  first: number;
  last: number;
  days: number;
  hours: number;
  sessions: { nights: number; days: number };
  night: Stats | null;
  day: Stats | null;
  endNight: number;
  endDay: number;
}

/**
 * The figures the copy quotes, computed by scripts/prepare-data.ts from the
 * study file. Typed here, never typed *out* anywhere — a number in a sentence
 * that is not derived from this is a number free to be wrong.
 */
export interface Headline {
  assets: number;
  equities: number;
  closes: number;
  sessions: number;
  spanDays: number;
  nightVol: number;
  dayVol: number;
  volRatio: number;
  nightMoreVolatile: number;
  nightCum: number;
  dayCum: number;
  significant: number;
  spikesDropped: number;
  barsTotal: number;
}

export interface MarketsFile {
  generated: string;
  source: string;
  headline: Headline;
  assets: Asset[];
}

export interface CurvePoint { t: number; n: number; d: number }
export interface CurveFile { symbol: string; points: CurvePoint[] }

/* ── async state ─────────────────────────────────────────────────────────── */

export type Async<T> =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: null; error: Error };

const LOADING = { status: 'loading', data: null, error: null } as const;

/**
 * Fetch once per key and keep it.
 *
 * The module-level cache matters more than it looks: the markets index is read
 * by the nav, the list and every vault page, and refetching it on each route
 * would make navigation flash skeletons over data the browser already has.
 */
const cache = new Map<string, Promise<unknown>>();

export function load<T>(url: string): Promise<T> {
  let p = cache.get(url) as Promise<T> | undefined;
  if (!p) {
    p = fetch(url)
      .then(r => {
        if (!r.ok) throw new Error(`${url} — ${r.status} ${r.statusText}`);
        return r.json() as Promise<T>;
      })
      .catch(e => {
        cache.delete(url);           // a failure must not be cached as an answer
        throw e instanceof Error ? e : new Error(String(e));
      });
    cache.set(url, p);
  }
  return p;
}

export function useData<T>(url: string | null): Async<T> {
  const [state, setState] = useState<Async<T>>(LOADING);

  useEffect(() => {
    if (!url) return;
    let live = true;
    setState(LOADING);
    load<T>(url)
      .then(data => { if (live) setState({ status: 'ready', data, error: null }); })
      .catch(error => { if (live) setState({ status: 'error', data: null, error }); });
    return () => { live = false; };
  }, [url]);

  return state;
}

export const useMarkets = () => useData<MarketsFile>('/data/markets.json');
export const useCurve = (symbol: string | undefined) =>
  useData<CurveFile>(symbol ? `/data/curves/${encodeURIComponent(symbol)}.json` : null);
export const useStudy = () => useData<StudyFile>('/data/study.json');
export const useExecution = () => useData<ExecutionFile>('/data/execution.json');
export const useSimulation = () => useData<SimReport>('/data/sim-report.json');
export const useFreshness = () => useData<Freshness>('/data/freshness.json');
export const useFunding = () => useData<FundingFile>('/data/funding.json');

/* ── the study ───────────────────────────────────────────────────────────── */

export interface StudyAsset {
  symbol: string;
  kind?: string;
  night: Stats;
  day: Stats;
  spread?: { mean: number; t: number };
  [k: string]: unknown;
}

export interface StudyFile {
  /** The newest bar the study read — not when it ran. See `Freshness`. */
  snapshot?: string;
  equities: StudyAsset[];
  controls: StudyAsset[];
  [k: string]: unknown;
}

/**
 * When the study was last computed, and off how much.
 *
 * Split out of `study.json` so that file is byte-identical whenever no figure
 * has moved. It is the only derived file carrying a wall clock, which is what
 * lets the page say "as of" without the study churning on every build — and
 * it is absent on a clone that has never run the pipeline, so the page has to
 * handle not knowing rather than implying a freshness it cannot vouch for.
 */
/**
 * What the vault actually paid at each boundary it has settled.
 *
 * The study says what the night/day difference *was*; this says what the
 * vault *charged* for it. The defaults behind that charge — `k = 2,500 bps`,
 * capped at 50 bp a boundary — are reasoned rather than fitted, and the only
 * thing that can calibrate them is a live book. Publishing both means the
 * rate can be checked against an outcome instead of asserted.
 */
export interface FundingBell {
  boundary: number;
  /** The bell this settled, when the chain could tell us; the event does not carry it. */
  bellTs: number | null;
  /** When the crank actually ran, which is not the same thing. */
  crankedTs: number;
  exposed: string;
  fundingAtoms: string;
  payer: 'night' | 'day' | null;
  /** Null when one class is empty: nobody to pay, and nobody to pay them. */
  rateBps: number | null;
  valueNight: string;
  valueDay: string;
}

export interface FundingFile {
  snapshot: string;
  bells: FundingBell[];
}

export interface Freshness {
  computed: string;
  snapshot: string;
  assets: number;
  bars: number;
}

export interface ExecutionFile {
  [k: string]: unknown;
}

/**
 * The adversarial simulation's own report, written by the Rust test that runs
 * it and republished by CI on every change. `halts` counts *runs*, because a
 * run stops at its first halt — it is the share of simulated years in which
 * the vault stops once, not a per-bell rate.
 */
export interface SimReport {
  runs: number;
  bells_per_run: number;
  halts: number;
  halt_rate: number;
  halt_rate_of?: string;
  max_carry_delta_bps: number;
  note?: string;
}

/* ── live quotes ─────────────────────────────────────────────────────────── */

const JUP = 'https://lite-api.jup.ag/price/v3';

export interface Quote { price: number; at: number }

/**
 * Live marks from Jupiter.
 *
 * Pyth's Hermes endpoint now requires a key, so this is the open source of
 * truth for a browser. It is polled rather than streamed because these are
 * thin markets — a socket would deliver the same number two hundred times.
 *
 * `usdPrice` is deliberately *not* trusted for the pre-IPO names: it read
 * $1,144 for OPENAI while four pools and an executable swap quote all agreed on
 * ~$1,701. Where the history file has a measured price we surface both and say
 * which is which rather than silently preferring one.
 */
export function useQuotes(mints: string[], intervalMs = 20_000) {
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [error, setError] = useState<Error | null>(null);
  const [stale, setStale] = useState(false);
  const key = mints.join(',');
  const lastOk = useRef(0);

  useEffect(() => {
    if (!key) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const r = await fetch(`${JUP}?ids=${key}`);
        if (!r.ok) throw new Error(`Jupiter — ${r.status}`);
        const j = await r.json() as Record<string, { usdPrice?: number }>;
        if (!live) return;
        const at = Math.floor(Date.now() / 1000);
        const next: Record<string, Quote> = {};
        for (const [mint, v] of Object.entries(j)) {
          if (typeof v?.usdPrice === 'number' && v.usdPrice > 0) {
            next[mint] = { price: v.usdPrice, at };
          }
        }
        setQuotes(q => ({ ...q, ...next }));
        setError(null);
        setStale(false);
        lastOk.current = Date.now();
      } catch (e) {
        if (!live) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        // One miss is a blip; a minute of misses means what is on screen is old
        // and the page has to stop implying otherwise.
        if (lastOk.current && Date.now() - lastOk.current > 60_000) setStale(true);
      } finally {
        if (live) timer = setTimeout(tick, intervalMs);
      }
    };

    tick();
    return () => { live = false; clearTimeout(timer); };
  }, [key, intervalMs]);

  return { quotes, error, stale };
}

/* ── formatting ──────────────────────────────────────────────────────────── */

export const fmtUsd = (v: number, digits?: number) =>
  v.toLocaleString('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: digits ?? (v >= 1000 ? 2 : v >= 1 ? 2 : 4),
    maximumFractionDigits: digits ?? (v >= 1000 ? 2 : v >= 1 ? 2 : 4),
  });

export const fmtCompact = (v: number) =>
  v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M`
  : v >= 1_000 ? `$${(v / 1_000).toFixed(0)}K`
  : `$${v.toFixed(0)}`;

export const fmtPct = (v: number, digits = 2) =>
  `${v >= 0 ? '+' : '−'}${(Math.abs(v) * 100).toFixed(digits)}%`;

/** Unsigned percent, for magnitudes where a sign would be noise. */
export const fmtPctAbs = (v: number, digits = 2) => `${(v * 100).toFixed(digits)}%`;

export const fmtNum = (v: number, digits = 2) =>
  v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
