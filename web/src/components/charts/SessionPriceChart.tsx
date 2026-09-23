/* ───────────────────────────────────────────────────────────────────────────
   What am I exposed to right now?

   The token's hourly price over the last three days, laid over the sessions
   the program settles on: DAY bands where the regular session ran, NIGHT
   everywhere else, a mark at every bell. The eye does the rest — a line that
   walks during DAY and jumps across NIGHT is the whole reason the vault
   splits the two.

   Everything drawn is real and says where it came from. The line is the
   study's hourly closes (GeckoTerminal, the token's own pool) and stops where
   that snapshot stops. The live price from Jupiter is a separate dot at
   "now", never joined to the line: the hours between the snapshot and now are
   not in the data, and a line through them would be a guess drawn as a fact.
   The bands and bells are the calendar, so they run on past now to the next
   bell — the part of the chart the reader is about to live through.
   ─────────────────────────────────────────────────────────────────────────── */

import { useMemo, useRef } from 'react';
import { sessionAt, nextBoundary, Session } from '@sdk/calendar.ts';
import { etClock, etDate, etParts } from '@/lib/session';
import { fmtUsd } from '@/lib/data';
import { line, nearest, scale, ticks, useHover, useMeasure } from './primitives';
import s from './SessionPriceChart.module.css';

type Cls = 'day' | 'night';
interface Band { from: number; to: number; cls: Cls }

const M = { top: 26, right: 58, bottom: 28, left: 12 };
const HOUR = 3600;
/** A snapshot older than this is shown as it is, not stretched to meet now. */
const JOIN_LIMIT = 36 * HOUR;

function bandsBetween(t0: number, t1: number): Band[] {
  const out: Band[] = [];
  let t = t0;
  let guard = 0;
  while (t < t1 && guard++ < 64) {
    const cls: Cls = sessionAt(t) === Session.Open ? 'day' : 'night';
    const b = nextBoundary(t, 6) ?? t1;
    out.push({ from: t, to: Math.min(b, t1), cls });
    t = b;
  }
  return out;
}

const weekday = (t: number) => etParts(t).dow;

export function SessionPriceChart({ recent, live, now, symbol, height = 280 }: {
  recent: [number, number][];
  /** The live price and the second it was read. */
  live: { price: number; at: number } | null;
  /** The current time, to the minute — passed in so the chart redraws once a minute, not every second. */
  now: number;
  symbol: string;
  height?: number;
}) {
  const [ref, { width }] = useMeasure<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const { x: hoverX, onMove, onLeave } = useHover(svgRef, width);

  const g = useMemo(() => {
    if (!width || recent.length < 2) return null;
    const first = recent[0][0];
    const last = recent[recent.length - 1][0];
    const joined = now - last <= JOIN_LIMIT;
    // Past the present, the calendar is still known: run on to the next bell
    // so the handoff the reader is waiting for is on the chart.
    const nb = joined ? nextBoundary(now, 3) : null;
    const t1 = joined ? Math.max(now, Math.min(nb ?? now, now + 18 * HOUR)) + HOUR : last;
    const t0 = first;
    const iw = width - M.left - M.right;
    const ih = height - M.top - M.bottom;

    let lo = Infinity, hi = -Infinity;
    for (const [, p] of recent) { lo = Math.min(lo, p); hi = Math.max(hi, p); }
    if (joined && live) { lo = Math.min(lo, live.price); hi = Math.max(hi, live.price); }
    const pad = (hi - lo) * 0.12 || hi * 0.01;

    const x = scale(t0, t1, M.left, M.left + iw);
    const y = scale(lo - pad, hi + pad, M.top + ih, M.top);

    // Break the line where the data has a hole rather than bridging it.
    const runs: [number, number][][] = [];
    let run: [number, number][] = [];
    recent.forEach(([t, p], i) => {
      if (i > 0 && t - recent[i - 1][0] > 2 * HOUR) { runs.push(run); run = []; }
      run.push([x(t), y(p)]);
    });
    runs.push(run);

    const bands = bandsBetween(t0, t1);
    const bells = bands.slice(1).map(b => ({ at: b.from, kind: b.cls === 'day' ? 'open' as const : 'close' as const }));
    const yt = ticks(lo - pad, hi + pad, 4);
    // Day ticks at ET midnight, labelled by weekday.
    const days: number[] = [];
    for (const b of bands) {
      const p = etParts(b.from);
      const midnight = b.from - p.secOfDay;
      for (let d = midnight; d <= b.to; d += 86_400) if (d > t0 && d < t1 && !days.includes(d)) days.push(d);
    }

    return { t0, t1, iw, ih, x, y, runs, bands, bells, yt, days, joined, next: nb, xs: recent.map(r => x(r[0])) };
  }, [width, height, recent, live, now]);

  if (recent.length < 2) {
    return <p className={s.empty}>No recent closes for {symbol} in the study snapshot.</p>;
  }

  /* Hover: snap to the nearest close inside the data, otherwise read the
     calendar at the pointer — the future and the unrecorded gap still have a
     session, even without a price. */
  let tip: { left: number; t: number; price: number | null; cls: Cls; bell: string | null; label: string } | null = null;
  if (g && hoverX !== null) {
    const tp = g.x.invert(Math.min(Math.max(hoverX, M.left), M.left + g.iw));
    const lastT = recent[recent.length - 1][0];
    let t = Math.round(tp);
    let price: number | null = null;
    let label = 'No close recorded';
    if (tp <= lastT + HOUR / 2) {
      const i = nearest(g.xs, hoverX);
      t = recent[i][0]; price = recent[i][1]; label = 'Hourly close';
    } else if (g.joined && live && Math.abs(g.x(now) - hoverX) < 10) {
      t = now; price = live.price; label = 'Live · Jupiter';
    } else if (t > now) {
      label = 'Scheduled';
    }
    const cls: Cls = sessionAt(t) === Session.Open ? 'day' : 'night';
    const near = g.bells.find(b => Math.abs(g.x(b.at) - hoverX) < 8);
    tip = {
      left: g.x(t), t, price, cls, label,
      bell: near ? `${etClock(near.at)} ET · ${near.kind === 'open' ? 'DAY begins' : 'DAY ends, NIGHT begins'}` : null,
    };
  }

  const lastClose = recent[recent.length - 1];
  const summary = `${symbol} hourly closes from ${etDate(recent[0][0])} to ${etDate(lastClose[0])}, ` +
    `last ${fmtUsd(lastClose[1])}, with regular sessions shaded as DAY and the rest as NIGHT.`;

  return (
    <figure className={s.figure}>
      <figcaption className={s.legend}>
        <span className={s.key}><span className={s.lineKey} aria-hidden="true" />{symbol} hourly close</span>
        <span className={s.key}><span className={s.band} data-cls="day" aria-hidden="true" />DAY</span>
        <span className={s.key}><span className={s.band} data-cls="night" aria-hidden="true" />NIGHT</span>
        {g?.joined && live && <span className={s.key}><span className={s.liveKey} aria-hidden="true" />Live</span>}
      </figcaption>

      <div className={s.plot} ref={ref} style={{ height }}>
        {g && (
          <svg ref={svgRef} width={width} height={height} className={s.svg} role="img" aria-label={summary}
               onPointerMove={onMove} onPointerLeave={onLeave}>
            <defs>
              <clipPath id="spc-clip"><rect x={M.left} y={M.top} width={g.iw} height={g.ih} /></clipPath>
            </defs>

            {/* the sessions */}
            {g.bands.map(b => (
              <rect key={b.from} x={g.x(b.from)} y={M.top} width={Math.max(0, g.x(b.to) - g.x(b.from))} height={g.ih}
                    className={s.bandRect} data-cls={b.cls} />
            ))}
            {g.bands.filter(b => g.x(b.to) - g.x(b.from) > 34).map(b => (
              <text key={`l${b.from}`} x={(g.x(b.from) + g.x(b.to)) / 2} y={M.top - 9} className={s.bandLabel} data-cls={b.cls} textAnchor="middle">
                {b.cls === 'day' ? 'DAY' : 'NIGHT'}
              </text>
            ))}

            {/* grid, recessive */}
            {g.yt.map(v => (
              <g key={v}>
                <line x1={M.left} x2={M.left + g.iw} y1={g.y(v)} y2={g.y(v)} className={s.grid} />
                <text x={M.left + g.iw + 8} y={g.y(v)} className={`${s.tick} num`} dominantBaseline="middle">{fmtUsd(v, v >= 100 ? 0 : 2)}</text>
              </g>
            ))}

            {/* the bells */}
            {g.bells.map(b => (
              <line key={b.at} x1={g.x(b.at)} x2={g.x(b.at)} y1={M.top} y2={M.top + g.ih} className={s.bell} data-kind={b.kind} />
            ))}

            {/* the unrecorded stretch between the snapshot and now */}
            {g.joined && now - lastClose[0] > 2 * HOUR && (
              <g>
                <rect x={g.x(lastClose[0])} y={M.top} width={Math.max(0, g.x(now) - g.x(lastClose[0]))} height={g.ih} className={s.gap} />
                {g.x(now) - g.x(lastClose[0]) > 96 && (
                  <text x={(g.x(lastClose[0]) + g.x(now)) / 2} y={M.top + g.ih / 2} textAnchor="middle" dominantBaseline="middle" className={s.gapLabel}>not in the snapshot</text>
                )}
              </g>
            )}

            <g clipPath="url(#spc-clip)">
              {g.runs.map((r, i) => <path key={i} d={line(r)} className={s.price} />)}
            </g>

            {/* now, and the live price */}
            {g.joined && (
              <g>
                <line x1={g.x(now)} x2={g.x(now)} y1={M.top - 2} y2={M.top + g.ih} className={s.now} />
                <text x={g.x(now) - 5} y={M.top + g.ih - 7} textAnchor="end" className={`${s.nowLabel} ${s.halo}`}>Now</text>
                {live && <circle cx={g.x(now)} cy={g.y(live.price)} r="4.5" className={s.liveDot} />}
              </g>
            )}
            {g.joined && g.next && g.next <= g.t1 && (() => {
              /* "Now" sits at the foot of its line and this label at the head
                 of its own, so the two never share a row; it goes right of its
                 line when there is room and left when there is not, haloed so
                 the now line behind it does not cut through the glyphs. */
              const nx = g.x(g.next);
              const right = nx + 5 + 96 <= width - 4;
              return (
                <g>
                  <line x1={nx} x2={nx} y1={M.top} y2={M.top + g.ih} className={s.nextLine} />
                  <text x={right ? nx + 5 : nx - 5} y={M.top + 13} textAnchor={right ? 'start' : 'end'} className={`${s.nextLabel} ${s.halo}`}>
                    Next bell {etClock(g.next)}
                  </text>
                </g>
              );
            })()}

            {/* weekday ticks */}
            {g.days.map(d => (
              <g key={d}>
                <line x1={g.x(d)} x2={g.x(d)} y1={M.top + g.ih} y2={M.top + g.ih + 5} className={s.dayTick} />
                <text x={g.x(d) + 4} y={height - 9} className={s.day}>{weekday(d + 3600)} {etParts(d + 3600).d}</text>
              </g>
            ))}

            {tip && (
              <g pointerEvents="none">
                <line x1={tip.left} x2={tip.left} y1={M.top} y2={M.top + g.ih} className={s.hair} />
                {tip.price !== null && <circle cx={tip.left} cy={g.y(tip.price)} r="4" className={s.hoverDot} />}
              </g>
            )}
          </svg>
        )}
        {g && tip && (
          <div className={s.tooltip} style={{ left: Math.min(Math.max(tip.left, 84), width - 84), top: M.top + 4 }}>
            <div className={s.tipTime}>{weekday(tip.t)} {etClock(tip.t)} ET</div>
            <div className={s.tipRow}><span className={s.tipCls} data-cls={tip.cls}>{tip.cls === 'day' ? 'DAY' : 'NIGHT'}</span><span>{tip.label}</span></div>
            {tip.price !== null && <div className={`num ${s.tipPrice}`}>{fmtUsd(tip.price)}</div>}
            {tip.bell && <div className={s.tipBell}>{tip.bell}</div>}
          </div>
        )}
      </div>

      {g && !g.joined && (
        <p className={s.note}>The snapshot ends {etDate(lastClose[0])}; it is shown as recorded rather than stretched to meet the live price.</p>
      )}
      <SessionTable recent={recent} />
    </figure>
  );
}

/** The same data as a table: each session, close to close. */
function SessionTable({ recent }: { recent: [number, number][] }) {
  const rows = useMemo(() => {
    const out: { from: number; cls: Cls; start: number; end: number }[] = [];
    const bands = bandsBetween(recent[0][0], recent[recent.length - 1][0] + 1);
    for (const b of bands) {
      // Measured from the last close before the session began to its own last
      // close, so every hour belongs to exactly one session and the opening gap
      // is counted in the session it opens.
      const before = recent.filter(([t]) => t <= b.from).at(-1);
      const inside = recent.filter(([t]) => t > b.from && t <= b.to).at(-1);
      if (!before || !inside) continue;
      out.push({ from: b.from, cls: b.cls, start: before[1], end: inside[1] });
    }
    return out.reverse();
  }, [recent]);
  if (!rows.length) return null;
  return (
    <details className={s.table}>
      <summary>Session by session</summary>
      <table>
        <thead><tr><th scope="col">Session</th><th scope="col">Began</th><th scope="col">Start</th><th scope="col">End</th><th scope="col">Move</th></tr></thead>
        <tbody>
          {rows.map(r => {
            const mv = r.end / r.start - 1;
            return (
              <tr key={r.from}>
                <th scope="row"><span className={s.tipCls} data-cls={r.cls}>{r.cls === 'day' ? 'DAY' : 'NIGHT'}</span></th>
                <td className="num">{weekday(r.from)} {etClock(r.from)}</td>
                <td className="num">{fmtUsd(r.start)}</td>
                <td className="num">{fmtUsd(r.end)}</td>
                <td className="num" data-sign={mv > 0 ? 'pos' : mv < 0 ? 'neg' : 'zero'}>{mv > 0 ? '+' : mv < 0 ? '−' : ''}{Math.abs(mv * 100).toFixed(2)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className={s.tableNote}>Each session runs from the last hourly close before it began to its own last close, so every hour is counted once and an opening gap belongs to the session it opens. The first session in the window may be partial.</p>
    </details>
  );
}
