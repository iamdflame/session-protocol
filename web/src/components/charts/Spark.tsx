import { line, scale } from './primitives';
import type { CurvePoint } from '@/lib/data';
import s from './Spark.module.css';

/**
 * Two tiny curves in a table cell.
 *
 * Deliberately axis-less and label-less: at 92×28 there is no honest way to
 * show a scale, so this claims only shape — which of the two sessions carried
 * the asset, and how far apart they ended. The numbers next to it are the
 * quantities; this is the gesture.
 */
export function Spark({
  points, width = 92, height = 28,
}: { points: CurvePoint[]; width?: number; height?: number }) {
  if (points.length < 2) {
    return <div className={s.empty} style={{ width, height }} aria-hidden="true" />;
  }

  let lo = Infinity, hi = -Infinity;
  for (const p of points) { lo = Math.min(lo, p.n, p.d); hi = Math.max(hi, p.n, p.d); }
  lo = Math.min(lo, 1); hi = Math.max(hi, 1);
  const pad = (hi - lo) * 0.12 || 0.01;

  const x = scale(points[0].t, points.at(-1)!.t, 1, width - 1);
  const y = scale(lo - pad, hi + pad, height - 2, 2);

  const night = points.map(p => [x(p.t), y(p.n)] as const);
  const day = points.map(p => [x(p.t), y(p.d)] as const);

  return (
    <svg width={width} height={height} className={s.svg} aria-hidden="true" focusable="false">
      <line x1={0} x2={width} y1={y(1)} y2={y(1)} className={s.base} />
      <path d={line(day)} className={s.day} />
      <path d={line(night)} className={s.night} />
      <circle cx={x(points.at(-1)!.t)} cy={y(points.at(-1)!.d)} r="2" className={s.dotDay} />
      <circle cx={x(points.at(-1)!.t)} cy={y(points.at(-1)!.n)} r="2" className={s.dotNight} />
    </svg>
  );
}
