import { useMemo, useState } from 'react';
import {
  civilFromDays, weekdayFromDays, holidays, earlyCloses,
  isDST, SEC_PER_DAY,
} from '@sdk/calendar.ts';
import { useSession } from '@/lib/session';
import s from './BoundaryWalk.module.css';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const WEEKS = 6;

interface Day {
  days: number;
  y: number; m: number; d: number;
  dow: number;
  /** null when the market never opens that day. */
  open: number | null;
  close: number | null;
  reason: string | null;
  early: boolean;
}

/**
 * Six weeks of the real calendar.
 *
 * Every band is drawn from the same functions the program settles against, so
 * a short bar on the Friday after Thanksgiving is not an illustration of an
 * early close — it *is* the early close, computed the way the vault computes
 * it. Which is the only reason a diagram like this is worth showing.
 */
export function BoundaryWalk() {
  const sess = useSession();
  const [hover, setHover] = useState<number | null>(null);

  const weeks = useMemo(() => {
    const now = sess?.now ?? Math.floor(Date.now() / 1000);
    const et = now + (isDST(now) ? -4 : -5) * 3600;
    const today = Math.floor(et / SEC_PER_DAY);

    // Start on the Sunday of the current week, so columns line up as a calendar.
    const start = today - weekdayFromDays(today);

    const out: Day[][] = [];
    for (let w = 0; w < WEEKS; w++) {
      const row: Day[] = [];
      for (let i = 0; i < 7; i++) {
        const days = start + w * 7 + i;
        const { y, m, d } = civilFromDays(days);
        const dow = weekdayFromDays(days);
        const isWeekend = dow === 0 || dow === 6;
        const hol = holidays(y).has(days);
        const early = earlyCloses(y).has(days);

        row.push({
          days, y, m, d, dow,
          open: isWeekend || hol ? null : 9.5,
          close: isWeekend || hol ? null : early ? 13 : 16,
          reason: isWeekend ? 'Weekend' : hol ? 'Market holiday' : early ? 'Early close, 13:00' : null,
          early,
        });
      }
      out.push(row);
    }
    return out;
  }, [sess?.now]);

  const todayDays = useMemo(() => {
    const now = sess?.now ?? Math.floor(Date.now() / 1000);
    return Math.floor((now + (isDST(now) ? -4 : -5) * 3600) / SEC_PER_DAY);
  }, [sess?.now]);

  const shown = hover !== null
    ? weeks.flat().find(d => d.days === hover) ?? null
    : null;

  // Only key what is actually on screen. A legend entry for a thing the reader
  // cannot find is a small lie about the picture.
  const hasEarly = weeks.flat().some(d => d.early);
  const hasHoliday = weeks.flat().some(d => d.open === null && d.dow !== 0 && d.dow !== 6);

  return (
    <figure className={s.wrap}>
      <figcaption className={s.legend}>
        <span className={s.key}><span className={s.swatch} data-kind="day" aria-hidden="true" />Regular session</span>
        <span className={s.key}><span className={s.swatch} data-kind="night" aria-hidden="true" />Closed — NIGHT holds</span>
        {hasEarly && (
          <span className={s.key}><span className={s.swatch} data-kind="early" aria-hidden="true" />Early close, 13:00</span>
        )}
        {hasHoliday && (
          <span className={s.key}><span className={s.swatch} data-kind="holiday" aria-hidden="true" />Market holiday</span>
        )}
        <span className={s.unit}>each column is one day, midnight to midnight ET</span>
      </figcaption>

      <div className={s.grid} role="group" aria-label="Six weeks of market sessions">
        <div className={s.dowRow} aria-hidden="true">
          {DOW.map(d => <span key={d}>{d}</span>)}
        </div>

        {weeks.map((week, wi) => (
          <div key={wi} className={s.week}>
            {week.map(day => {
              const isToday = day.days === todayDays;
              const label =
                `${DOW[day.dow]} ${MONTH[day.m - 1]} ${day.d}: ` +
                (day.open === null
                  ? day.reason ?? 'closed'
                  : `open 09:30 to ${day.close === 13 ? '13:00 (early close)' : '16:00'} ET`);

              return (
                <button
                  key={day.days}
                  type="button"
                  className={s.day}
                  data-today={isToday}
                  data-closed={day.open === null}
                  data-weekend={day.dow === 0 || day.dow === 6}
                  data-early={day.early}
                  onPointerEnter={() => setHover(day.days)}
                  onFocus={() => setHover(day.days)}
                  onPointerLeave={() => setHover(null)}
                  onBlur={() => setHover(null)}
                  aria-label={label}
                >
                  <span className={s.dayNum}>{day.d}</span>
                  <span className={s.bar}>
                    {day.open !== null && (
                      <span
                        className={s.session}
                        style={{
                          top: `${(day.open / 24) * 100}%`,
                          height: `${((day.close! - day.open) / 24) * 100}%`,
                        }}
                      />
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <p className={s.readout} aria-live="polite">
        {shown ? (
          <>
            <strong>{DOW[shown.dow]} {MONTH[shown.m - 1]} {shown.d}</strong>
            {shown.open === null
              ? <> — {shown.reason}. NIGHT holds the whole day.</>
              : <> — DAY holds <span className="num">09:30</span> to{' '}
                  <span className="num">{shown.close === 13 ? '13:00' : '16:00'}</span> ET
                  {shown.early && <span className={s.earlyTag}>early close</span>}
                  , NIGHT holds the other{' '}
                  <span className="num">{(24 - (shown.close! - shown.open)).toFixed(1)}</span> hours.</>}
          </>
        ) : (
          <>Hover or tab through a day to see who holds the stock and for how long.</>
        )}
      </p>
    </figure>
  );
}
