import { useMemo, useRef, useState } from 'react';
import { scale, ticks, useMeasure } from './primitives';
import { useStudy } from '@/lib/data';
import s from './VolBars.module.css';

const ROW = 21;
const M = { top: 26, right: 16, bottom: 26, left: 66 };

/**
 * Session volatility, per asset.
 *
 * A dumbbell rather than paired bars: the quantity that matters is the *gap*
 * between the two sessions, and a connector draws that gap directly instead of
 * asking the reader to subtract two bar lengths by eye.
 *
 * Sorted by the gap, so the shape of the whole set is the headline — almost
 * every connector points the same way.
 */
export function VolBars() {
  const study = useStudy();
  const [ref, { width }] = useMeasure<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const rows = useMemo(() => {
    if (study.status !== 'ready') return null;
    return study.data.equities
      .map(e => ({ symbol: e.symbol, night: e.night.stdev, day: e.day.stdev }))
      .sort((a, b) => (b.night - b.day) - (a.night - a.day));
  }, [study]);

  const h = rows ? M.top + rows.length * ROW + M.bottom : 240;

  const g = useMemo(() => {
    if (!rows || !width) return null;
    const iw = width - M.left - M.right;
    const max = Math.max(...rows.flatMap(r => [r.night, r.day]));
    const x = scale(0, max * 1.06, M.left, M.left + iw);
    return { x, iw, xt: ticks(0, max * 1.06, width < 520 ? 3 : 5) };
  }, [rows, width]);

  if (study.status === 'error') {
    return (
      <p className={s.error}>
        The study file could not be loaded, so this chart has nothing to draw.
        Reloading usually fixes it.
      </p>
    );
  }

  return (
    <figure className={s.figure}>
      <figcaption className={s.legend}>
        <span className={s.key}><span className={s.dot} data-series="day" aria-hidden="true" />Regular session</span>
        <span className={s.key}><span className={s.dot} data-series="night" aria-hidden="true" />Overnight</span>
        <span className={s.unit}>σ of session returns</span>
      </figcaption>

      <div className={s.plot} ref={ref} style={{ minHeight: h }}>
        {!rows || !g ? (
          <div className="skeleton" style={{ width: '100%', height: h }} />
        ) : (
          <svg
            ref={svgRef} width={width} height={h} className={s.svg} role="img"
            aria-label={
              `Session volatility for ${rows.length} tokenized equities. ` +
              `The overnight session is the more volatile of the two in ` +
              `${rows.filter(r => r.night > r.day).length} of them.`
            }
            onPointerLeave={() => setHover(null)}
          >
            {/* grid, drawn first and kept quiet */}
            {g.xt.map(v => (
              <g key={v}>
                <line x1={g.x(v)} x2={g.x(v)} y1={M.top - 6} y2={M.top + rows.length * ROW}
                      className={s.grid} />
                <text x={g.x(v)} y={M.top + rows.length * ROW + 17}
                      className={`${s.tick} num`} textAnchor="middle">
                  {(v * 100).toFixed(0)}%
                </text>
              </g>
            ))}

            {rows.map((r, i) => {
              const y = M.top + i * ROW + ROW / 2;
              const on = hover === i;
              const nightWider = r.night > r.day;
              return (
                <g key={r.symbol} className={s.row} data-on={on}
                   onPointerEnter={() => setHover(i)}>
                  {/* a full-width target: hovering a 3px dot is not a hit area */}
                  <rect x={0} y={M.top + i * ROW} width={width} height={ROW}
                        fill="transparent" />
                  <text x={M.left - 12} y={y} className={s.rowLabel}
                        textAnchor="end" dominantBaseline="middle">{r.symbol}</text>

                  <line x1={g.x(Math.min(r.day, r.night))} x2={g.x(Math.max(r.day, r.night))}
                        y1={y} y2={y} className={s.connector}
                        data-wider={nightWider ? 'night' : 'day'} />

                  <circle cx={g.x(r.day)} cy={y} r={on ? 5 : 4} className={s.mark} data-series="day" />
                  <circle cx={g.x(r.night)} cy={y} r={on ? 5 : 4} className={s.mark} data-series="night" />

                  {on && (
                    <text
                      x={g.x(Math.max(r.day, r.night)) + 10} y={y}
                      className={`${s.inlineVal} num`} dominantBaseline="middle"
                      data-wider={nightWider ? 'night' : 'day'}
                    >
                      {nightWider ? '+' : '−'}{(Math.abs(r.night - r.day) * 100).toFixed(2)} pts
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>

      {rows && (
        <p className={s.footnote}>
          Overnight is the wider of the two in{' '}
          <strong>{rows.filter(r => r.night > r.day).length} of {rows.length}</strong>.
          Sorted by the gap.
        </p>
      )}
    </figure>
  );
}
