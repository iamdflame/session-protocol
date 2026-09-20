/* ───────────────────────────────────────────────────────────────────────────
   Chart primitives.

   No chart library. Every chart here has two series that mean opposite things
   and must stay legible on two grounds, and that is not what a general chart
   library is good at — the styling would be fought rather than written. These
   are the pieces the charts are built from: scales, ticks, measurement and
   hit-testing, and nothing else.
   ─────────────────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface Box { top: number; right: number; bottom: number; left: number }

/** A linear scale: domain → range, clamped nowhere because charts should clip. */
export function scale(d0: number, d1: number, r0: number, r1: number) {
  const span = d1 - d0 || 1;
  const f = (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
  f.invert = (p: number) => d0 + ((p - r0) / (r1 - r0 || 1)) * span;
  f.domain = [d0, d1] as const;
  f.range = [r0, r1] as const;
  return f;
}

export type Scale = ReturnType<typeof scale>;

/**
 * Ticks on round numbers, at most `count` of them.
 *
 * Chosen from the 1 / 2 / 2.5 / 5 / 10 family so the labels read as amounts a
 * person would say out loud. A chart whose axis says 0.0347 has stopped being
 * an aid to reading.
 */
export function ticks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 2.25 ? 2.5 : norm >= 1.5 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v);   // kill −0 and float dust
  }
  return out;
}

/** Ticks for a time axis, snapped to months when the span is long enough. */
export function timeTicks(t0: number, t1: number, count = 5): number[] {
  const span = t1 - t0;
  const DAY = 86400;
  if (span > 60 * DAY) {
    const out: number[] = [];
    const d = new Date(t0 * 1000);
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
    const months = Math.max(1, Math.round(span / (30.44 * DAY) / count));
    while (d.getTime() / 1000 < t1) {
      const v = d.getTime() / 1000;
      if (v >= t0) out.push(v);
      d.setUTCMonth(d.getUTCMonth() + months);
    }
    return out;
  }
  return ticks(t0, t1, count);
}

/** Element size, tracked. Charts are drawn to the box they are actually in. */
export function useMeasure<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setSize(s => (s.width === r.width && s.height === r.height ? s : { width: r.width, height: r.height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, size] as const;
}

/**
 * Pointer position inside an SVG, in view coordinates.
 *
 * Deliberately not `getScreenCTM` — these charts never transform, and reading
 * the bounding box is both cheaper and immune to the matrix being null while
 * the element is detached.
 */
export function useHover(svgRef: React.RefObject<SVGSVGElement | null>, width: number) {
  const [x, setX] = useState<number | null>(null);

  const onMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const el = svgRef.current;
    if (!el || !width) return;
    const r = el.getBoundingClientRect();
    if (!r.width) return;
    setX(((e.clientX - r.left) / r.width) * width);
  }, [svgRef, width]);

  const onLeave = useCallback(() => setX(null), []);

  return { x, onMove, onLeave, setX };
}

/** Index of the point nearest a view-space x. Assumes `xs` ascending. */
export function nearest(xs: number[], x: number): number {
  if (!xs.length) return -1;
  let lo = 0, hi = xs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(xs[lo - 1] - x) <= Math.abs(xs[lo] - x)) return lo - 1;
  return lo;
}

/** A polyline through points, rounded to a tenth of a pixel to keep paths small. */
export function line(pts: ReadonlyArray<readonly [number, number]>): string {
  if (!pts.length) return '';
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) d += ` L ${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)}`;
  return d;
}

/** The same polyline closed down to a baseline, for a fill under a curve. */
export function area(pts: ReadonlyArray<readonly [number, number]>, baseline: number): string {
  if (!pts.length) return '';
  return `${line(pts)} L ${pts.at(-1)![0].toFixed(1)} ${baseline.toFixed(1)}` +
         ` L ${pts[0][0].toFixed(1)} ${baseline.toFixed(1)} Z`;
}

/**
 * Nudge labels apart so a stack of direct labels never overlaps.
 *
 * Direct labels are what let these charts be read without a legend lookup, and
 * two of them on top of each other is worse than neither. Positions are pulled
 * apart by the minimum gap and then re-centred on the group's original mean, so
 * the set stays where it belongs.
 */
export function spread(ys: number[], gap: number, min: number, max: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  const out = new Array(ys.length).fill(0);
  let prev = -Infinity;
  for (const { y, i } of order) {
    const v = Math.max(y, prev + gap);
    out[i] = v;
    prev = v;
  }
  const overflow = Math.max(...out) - max;
  if (overflow > 0) for (let i = 0; i < out.length; i++) out[i] -= overflow;
  const under = min - Math.min(...out);
  if (under > 0) for (let i = 0; i < out.length; i++) out[i] += under;
  return out;
}
