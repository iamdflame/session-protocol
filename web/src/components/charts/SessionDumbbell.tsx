/* ───────────────────────────────────────────────────────────────────────────
   DAY against NIGHT, one row per asset.

   A dumbbell: the two sessions' figures for an asset on one line, joined, so
   the eye reads the gap rather than subtracting two bars. Sorted by the gap
   and split into the assets where NIGHT came out ahead and those where DAY
   did, which makes the headline — how many of each — the shape of the chart.

   The class is carried twice: DAY is a blue circle, NIGHT an amber diamond,
   so identity never rests on colour alone. Built from HTML rather than SVG so
   each row is a real list item: it takes focus, a screen reader reads it as a
   sentence, and the tooltip a pointer gets is the same one the keyboard gets.
   ─────────────────────────────────────────────────────────────────────────── */

import { useMemo, useState } from 'react';
import type { StudyAsset } from '@/lib/data';
import { ticks } from './primitives';
import s from './SessionDumbbell.module.css';

export type Metric = 'return' | 'risk';

interface Row {
  symbol: string;
  night: number;
  day: number;
  diff: number;
  nightT: number;
  dayT: number;
  nNight: number;
  nDay: number;
}

const UNIT: Record<Metric, string> = { return: 'bp/h', risk: '%' };
const fmt = (v: number, m: Metric, sign = m === 'return') =>
  `${sign && v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}${m === 'risk' ? '%' : ''}`;

export function SessionDumbbell({ rows: src, metric, label }: { rows: StudyAsset[]; metric: Metric; label: string }) {
  const [active, setActive] = useState<string | null>(null);

  const { rows, lo, hi, tickVals } = useMemo(() => {
    const rows: Row[] = src.map(a => {
      // Returns per hour, so a 17.5-hour NIGHT and a 6.5-hour DAY are compared
      // like for like — the same normalisation the pooled spread and the win
      // count use. Risk is per session, as the study reports it.
      const night = metric === 'return' ? a.night.perHour * 1e4 : a.night.stdev * 100;
      const day = metric === 'return' ? a.day.perHour * 1e4 : a.day.stdev * 100;
      return { symbol: a.symbol, night, day, diff: night - day, nightT: a.night.t, dayT: a.day.t, nNight: a.night.n, nDay: a.day.n };
    }).sort((a, b) => b.diff - a.diff);
    const vals = rows.flatMap(r => [r.night, r.day]);
    let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
    if (metric === 'return') { const m = Math.max(Math.abs(lo), Math.abs(hi)); lo = -m; hi = m; }
    const pad = (hi - lo) * 0.06 || 1;
    lo = metric === 'risk' ? 0 : lo - pad; hi += pad;
    return { rows, lo, hi, tickVals: ticks(lo, hi, 5) };
  }, [src, metric]);

  const x = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const ahead = rows.filter(r => r.diff > 0);
  const behind = rows.filter(r => r.diff <= 0);
  const [up, down] = metric === 'return' ? ['NIGHT ahead', 'DAY ahead'] : ['NIGHT wider', 'DAY wider'];

  const row = (r: Row) => {
    const a = Math.min(x(r.night), x(r.day));
    const b = Math.max(x(r.night), x(r.day));
    const on = active === r.symbol;
    return (
      <li
        key={r.symbol} className={s.row} data-on={on || undefined} tabIndex={0}
        onPointerEnter={() => setActive(r.symbol)} onPointerLeave={() => setActive(v => (v === r.symbol ? null : v))}
        onFocus={() => setActive(r.symbol)} onBlur={() => setActive(v => (v === r.symbol ? null : v))}
      >
        <span className={`mono ${s.sym}`}>{r.symbol}</span>
        <span className={s.track} aria-hidden="true">
          <span className={s.bar} style={{ left: `${a}%`, width: `${Math.max(0.4, b - a)}%` }} />
          <span className={s.mark} data-cls="day" style={{ left: `${x(r.day)}%` }} />
          <span className={s.mark} data-cls="night" style={{ left: `${x(r.night)}%` }} />
          {on && (
            <span className={s.tip} style={{ left: `clamp(0px, calc(${(x(r.night) + x(r.day)) / 2}% - 112px), calc(100% - 224px))` }}>
              <span className={s.tipHead}><span className="mono">{r.symbol}</span><span>{metric === 'return' ? 'mean return per hour' : 'σ per session'}</span></span>
              <span className={s.tipRow}><i data-cls="night" />NIGHT<b className="num">{fmt(r.night, metric)}{metric === 'return' ? ' bp' : ''}</b><em className="num">t {r.nightT.toFixed(2)} · n {r.nNight}</em></span>
              <span className={s.tipRow}><i data-cls="day" />DAY<b className="num">{fmt(r.day, metric)}{metric === 'return' ? ' bp' : ''}</b><em className="num">t {r.dayT.toFixed(2)} · n {r.nDay}</em></span>
              <span className={s.tipDiff}>NIGHT − DAY <b className="num">{fmt(r.diff, metric, true)}{metric === 'return' ? ' bp' : ' pts'}</b></span>
            </span>
          )}
        </span>
        <span className={`num ${s.diff}`} data-sign={r.diff > 0 ? 'night' : 'day'}>{fmt(r.diff, metric, true)}</span>
        <span className="sr-only">
          {`${r.symbol}: NIGHT ${fmt(r.night, metric)}, DAY ${fmt(r.day, metric)} ${UNIT[metric] === '%' ? 'per session' : 'basis points per hour'}; NIGHT minus DAY ${fmt(r.diff, metric, true)}; t ${r.nightT.toFixed(2)} and ${r.dayT.toFixed(2)}; ${r.nNight} and ${r.nDay} sessions.`}
        </span>
      </li>
    );
  };

  return (
    <figure className={s.figure} aria-label={label} style={{ '--zero': `${x(0)}%` } as React.CSSProperties}>
      <div className={s.legend} aria-hidden="true">
        <span><i className={s.key} data-cls="day" />DAY</span>
        <span><i className={s.key} data-cls="night" />NIGHT</span>
        <span className={s.unit}>{metric === 'return' ? 'mean return, basis points per hour' : 'standard deviation of session returns'}</span>
      </div>
      <div className={s.axis} aria-hidden="true">
        <span />
        <span className={s.ticks}>
          {tickVals.map(t => (
            <span key={t} style={{ left: `${x(t)}%` }}>{metric === 'return' ? (t > 0 ? `+${t}` : t < 0 ? `−${Math.abs(t)}` : '0') : `${t}%`}</span>
          ))}
        </span>
        <span className={s.diffHead}>gap</span>
      </div>
      <div className={s.body}>
        <p className={s.group} data-cls="night"><b className="num">{ahead.length}</b> {up}</p>
        <ul className={s.list} aria-label={`${up}: ${ahead.length}`}>{ahead.map(row)}</ul>
        <p className={s.group} data-cls="day"><b className="num">{behind.length}</b> {down}</p>
        <ul className={s.list} aria-label={`${down}: ${behind.length}`}>{behind.map(row)}</ul>
      </div>
    </figure>
  );
}
