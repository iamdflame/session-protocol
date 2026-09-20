import { useMemo, useRef } from 'react';
import { area, line, nearest, scale, spread, ticks, timeTicks, useHover, useMeasure } from './primitives';
import { etDate } from '@/lib/session';
import type { CurvePoint } from '@/lib/data';
import s from './CurveChart.module.css';

interface Props {
  points: CurvePoint[];
  /** Compact removes the axis furniture for use inside a dense card. */
  compact?: boolean;
  height?: number;
  label?: string;
}

const M = { top: 18, right: 64, bottom: 30, left: 50 };

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Month ticks are UTC midnight on the first, and a UTC midnight rendered in
 * Eastern time is 19:00 or 20:00 the *previous* day — so "Apr 1" printed as
 * "Tue Mar 31". Over a span long enough to tick by month, the day carries
 * nothing anyway; the month alone is both correct and narrow enough not to
 * collide on a phone.
 */
const tickLabel = (v: number, spanSec: number) => {
  if (spanSec > 60 * 86400) {
    const d = new Date(v * 1000);
    const m = MONTH[d.getUTCMonth()];
    return d.getUTCMonth() === 0 ? `${m} ${d.getUTCFullYear()}` : m;
  }
  return etDate(v).replace(/,.*/, '');
};
const M_COMPACT = { top: 10, right: 52, bottom: 6, left: 6 };

/**
 * Two NAVs, one axis.
 *
 * Both series start at 1.00 and compound only the returns earned inside their
 * own session, so the vertical distance between them at any date *is* the
 * cumulative difference between owning the day and owning the night. That is
 * the whole argument of the product, which is why it gets a chart rather than
 * a sentence.
 *
 * The two never share a scale with anything else and there is never a second
 * y-axis; when a figure belongs to a different unit it goes in its own chart.
 */
export function CurveChart({ points, compact = false, height = 320, label }: Props) {
  const [ref, { width }] = useMeasure<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const m = compact ? M_COMPACT : M;
  const h = compact ? height : height;
  const { x: hoverX, onMove, onLeave } = useHover(svgRef, width);

  const g = useMemo(() => {
    if (!width || points.length < 2) return null;
    const iw = width - m.left - m.right;
    const ih = h - m.top - m.bottom;

    const t0 = points[0].t, t1 = points.at(-1)!.t;
    let lo = Infinity, hi = -Infinity;
    for (const p of points) {
      lo = Math.min(lo, p.n, p.d);
      hi = Math.max(hi, p.n, p.d);
    }
    // Always keep 1.00 in frame: a chart of indexed performance that crops the
    // base line hides whether a series is up or down at all.
    lo = Math.min(lo, 1); hi = Math.max(hi, 1);
    const pad = (hi - lo) * 0.09 || 0.02;

    const x = scale(t0, t1, m.left, m.left + iw);
    const y = scale(lo - pad, hi + pad, m.top + ih, m.top);

    const nightPts = points.map(p => [x(p.t), y(p.n)] as const);
    const dayPts = points.map(p => [x(p.t), y(p.d)] as const);
    const xs = points.map(p => x(p.t));

    const yt = ticks(lo - pad, hi + pad, compact ? 3 : 5);
    const xt = timeTicks(t0, t1, width < 520 ? 3 : 5);

    const endN = y(points.at(-1)!.n);
    const endD = y(points.at(-1)!.d);
    const [labN, labD] = spread([endN, endD], 17, m.top + 7, m.top + ih - 7);

    return { iw, ih, x, y, nightPts, dayPts, xs, yt, xt, base: y(1), endN, endD, labN, labD };
  }, [width, points, h, m.left, m.right, m.top, m.bottom, compact]);

  const hovered = g && hoverX != null ? nearest(g.xs, hoverX) : -1;
  const hp = hovered >= 0 ? points[hovered] : null;

  const last = points.at(-1);

  return (
    <figure className={s.figure} data-compact={compact}>
      {!compact && (
        <figcaption className={s.legend}>
          <span className={s.key}>
            <span className={s.swatch} data-series="night" aria-hidden="true" />
            <span>NIGHT</span>
            <span className={`${s.keyVal} num`}>{last ? last.n.toFixed(3) : '—'}</span>
          </span>
          <span className={s.key}>
            <span className={s.swatch} data-series="day" aria-hidden="true" />
            <span>DAY</span>
            <span className={`${s.keyVal} num`}>{last ? last.d.toFixed(3) : '—'}</span>
          </span>
          <span className={s.axisNote}>indexed, both start at 1.000</span>
        </figcaption>
      )}

      <div className={s.plot} ref={ref} style={{ height: h }}>
        {g && (
          <svg
            ref={svgRef} width={width} height={h} className={s.svg}
            onPointerMove={onMove} onPointerLeave={onLeave}
            role="img"
            aria-label={
              label ??
              `Cumulative return, night versus day. ` +
              `Night ends at ${last?.n.toFixed(3)}, day at ${last?.d.toFixed(3)}, both from 1.000.`
            }
          >
            <defs>
              <linearGradient id="cc-night" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--night)" stopOpacity="0.17" />
                <stop offset="100%" stopColor="var(--night)" stopOpacity="0" />
              </linearGradient>
              <clipPath id="cc-clip">
                <rect x={m.left} y={m.top} width={g.iw} height={g.ih} />
              </clipPath>
            </defs>

            {/* grid — recessive, never competing with the marks */}
            {!compact && g.yt.map(v => (
              <g key={v}>
                <line x1={m.left} x2={m.left + g.iw} y1={g.y(v)} y2={g.y(v)} className={s.grid} />
                <text x={m.left - 10} y={g.y(v)} className={`${s.tick} num`}
                      textAnchor="end" dominantBaseline="middle">{v.toFixed(2)}</text>
              </g>
            ))}

            {/* the base line: 1.00, where both series began */}
            <line x1={m.left} x2={m.left + g.iw} y1={g.base} y2={g.base} className={s.base} />

            <g clipPath="url(#cc-clip)">
              <path d={area(g.nightPts, g.base)} fill="url(#cc-night)" />
              <path d={line(g.dayPts)} className={s.day} />
              <path d={line(g.nightPts)} className={s.night} />
            </g>

            {!compact && g.xt.map(v => (
              <text key={v} x={g.x(v)} y={h - 10} className={s.tick} textAnchor="middle">
                {tickLabel(v, points.at(-1)!.t - points[0].t)}
              </text>
            ))}

            {/* direct labels — the reason this is readable without a lookup */}
            <g className={s.endLabels}>
              <line x1={m.left + g.iw} x2={m.left + g.iw + 6} y1={g.endN} y2={g.labN} className={s.leader} data-series="night" />
              <line x1={m.left + g.iw} x2={m.left + g.iw + 6} y1={g.endD} y2={g.labD} className={s.leader} data-series="day" />
              <circle cx={m.left + g.iw} cy={g.endN} r="3" className={s.endDot} data-series="night" />
              <circle cx={m.left + g.iw} cy={g.endD} r="3" className={s.endDot} data-series="day" />
              <text x={m.left + g.iw + 10} y={g.labN} className={`${s.endLabel} num`}
                    data-series="night" dominantBaseline="middle">{last!.n.toFixed(2)}</text>
              <text x={m.left + g.iw + 10} y={g.labD} className={`${s.endLabel} num`}
                    data-series="day" dominantBaseline="middle">{last!.d.toFixed(2)}</text>
            </g>

            {/* hover */}
            {hp && (
              <g className={s.hover} pointerEvents="none">
                <line x1={g.x(hp.t)} x2={g.x(hp.t)} y1={m.top} y2={m.top + g.ih} className={s.hairline} />
                <circle cx={g.x(hp.t)} cy={g.y(hp.n)} r="4.5" className={s.hoverDot} data-series="night" />
                <circle cx={g.x(hp.t)} cy={g.y(hp.d)} r="4.5" className={s.hoverDot} data-series="day" />
              </g>
            )}
          </svg>
        )}

        {hp && g && (
          <div
            className={s.tooltip}
            style={{
              left: Math.min(Math.max(g.x(hp.t), 74), width - 74),
              top: m.top,
            }}
          >
            <div className={s.tipDate}>{etDate(hp.t)}</div>
            <div className={s.tipRow}>
              <span className={s.swatch} data-series="night" aria-hidden="true" />
              <span>NIGHT</span>
              <span className="num">{hp.n.toFixed(3)}</span>
            </div>
            <div className={s.tipRow}>
              <span className={s.swatch} data-series="day" aria-hidden="true" />
              <span>DAY</span>
              <span className="num">{hp.d.toFixed(3)}</span>
            </div>
            <div className={s.tipSpread}>
              <span>spread</span>
              <span className="num">{((hp.n - hp.d) * 100).toFixed(1)} pts</span>
            </div>
          </div>
        )}

        {!width && <div className="skeleton" style={{ width: '100%', height: h }} />}
      </div>
    </figure>
  );
}
