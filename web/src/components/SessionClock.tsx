/* ───────────────────────────────────────────────────────────────────────────
   The session clock.

   A 24-hour dial carrying the real 6.5h / 17.5h split. The trading session's
   midpoint (12:45 ET) sits at twelve o'clock, so the day is a small warm cap
   and the night is the large cool body wrapping beneath it — the 27/73
   asymmetry is the shape, not a caption.

   Both arcs are always drawn, dimmed, as a track. What is *lit* is the part of
   the current span already elapsed, so the ring answers two questions at once:
   who holds the stock, and how far through their stretch we are.

   Every position comes from the same calendar the program settles against, so
   the hand is correct through DST, holidays and early closes, and the countdown
   is the exact instant the vault will hand over.
   ─────────────────────────────────────────────────────────────────────────── */

import { useSession, countdown, etClock, etDate, closureReason, etParts } from '@/lib/session';
import s from './SessionClock.module.css';

const DAY_FROM = 9.5;      // 09:30 ET
const DAY_TO = 16;         // 16:00 ET
const DAY_MID = (DAY_FROM + DAY_TO) / 2;

/** Hours → degrees, with the session midpoint rotated to twelve o'clock. */
const deg = (h: number) => ((h - DAY_MID) / 24) * 360;
const rad = (h: number) => (deg(h) - 90) * (Math.PI / 180);

const pt = (cx: number, cy: number, r: number, h: number) =>
  [cx + r * Math.cos(rad(h)), cy + r * Math.sin(rad(h))] as const;

function arc(cx: number, cy: number, r: number, from: number, to: number) {
  const [x0, y0] = pt(cx, cy, r, from);
  const [x1, y1] = pt(cx, cy, r, to);
  const large = Math.abs(to - from) > 12 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r.toFixed(2)} ${r.toFixed(2)} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export function SessionClock({ size = 340, compact = false }: { size?: number; compact?: boolean }) {
  const sess = useSession();

  const c = size / 2;
  const r = c - size * 0.125;
  const w = size * 0.046;

  if (!sess) {
    return (
      <div className={s.wrap} style={{ width: size, height: size }} aria-busy="true">
        <div className={s.skeletonRing} style={{ inset: size * 0.1 }} />
        <span className="sr-only">Loading the current market session…</span>
      </div>
    );
  }

  const p = etParts(sess.now);
  // The dial is drawn to the minute, not the second. A second is 0.004° of the
  // ring — invisible — and rounding means the SVG is identical for sixty ticks
  // in a row instead of being re-rasterised every time the countdown changes.
  const hourNow = p.hh + p.mm / 60;
  const reason = closureReason(sess.now);
  const isDay = sess.holder === 'DAY';

  // Where the current span sits on the dial. The night wraps past midnight, so
  // it is expressed as 16:00 → 09:30+24 rather than as two separate arcs.
  const spanFrom = isDay ? DAY_FROM : DAY_TO;
  const spanTo = isDay ? DAY_TO : DAY_FROM + 24;

  // The lit arc always means the same thing — how much of this stretch is
  // gone — which is why it is driven by elapsed *time*, not by clock position.
  //
  // Over a single night the two coincide. Over a Friday-to-Monday weekend they
  // cannot: it is 10:54 on Sunday, which sits squarely inside the day arc while
  // NIGHT holds, and no 24-hour ring can show a 65-hour stretch as a position.
  // So a long hold lights 65% of the night because 65% of it has passed, drops
  // the hand rather than parking it somewhere misleading, and marks the day arc
  // shut so the gap in the ring is read as "closed today" and not as a fault.
  const lit = spanFrom + (spanTo - spanFrom) * sess.spanProgress;
  const hasElapsed = lit - spanFrom > 0.004;
  const dayClosed = sess.isLongHold;
  const showHand = !sess.isLongHold;

  const [handInX, handInY] = pt(c, c, r * 0.7, hourNow);
  const [handOutX, handOutY] = pt(c, c, r - w * 0.78, hourNow);
  const [markX, markY] = pt(c, c, r, hourNow);

  return (
    <div
      className={s.wrap}
      style={{ width: size, height: size, ['--clock' as string]: `${size}px` }}
      data-holder={sess.holder.toLowerCase()}
      data-compact={compact}
    >
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img"
           aria-label={
             `The US market is ${sess.isOpen ? 'open' : 'closed'}. ` +
             `${sess.holder} holds the exposure. ` +
             `Next boundary in ${countdown(sess.until)}, when ${sess.handsTo} takes over.`
           }>
        {/* hour ticks — every hour, with the two boundaries emphasised */}
        {Array.from({ length: 24 }, (_, i) => {
          const isBoundary = i === DAY_TO;
          const inner = r - w * (isBoundary ? 1.5 : 1.05);
          const outer = r - w * 0.72;
          const [x0, y0] = pt(c, c, inner, i);
          const [x1, y1] = pt(c, c, outer, i);
          return (
            <line key={i} x1={x0} y1={y0} x2={x1} y2={y1}
                  className={s.tick} strokeWidth={isBoundary ? 1.5 : 1}
                  opacity={isBoundary ? 0.85 : 0.32} strokeLinecap="round" />
          );
        })}

        {/* the track: both arcs, always, dimmed — the shape of the week */}
        <path d={arc(c, c, r, DAY_TO, DAY_FROM + 24)} className={s.trackNight}
              strokeWidth={w} strokeLinecap="round" fill="none" />
        <path d={arc(c, c, r, DAY_FROM, DAY_TO)} className={s.trackDay}
              strokeWidth={w} strokeLinecap="round" fill="none"
              data-closed={dayClosed}
              strokeDasharray={dayClosed ? `${(w * 0.5).toFixed(1)} ${(w * 0.62).toFixed(1)}` : undefined} />

        {/* What has already elapsed of the current span, lit.
            The halo is a second, wider, translucent stroke rather than a blur
            filter — same read, and it costs a path instead of a raster pass. */}
        {hasElapsed && (
          <>
            <path d={arc(c, c, r, spanFrom, lit)} className={s.elapsedHalo}
                  strokeWidth={w * 2.2} strokeLinecap="round" fill="none" />
            <path d={arc(c, c, r, spanFrom, lit)} className={s.elapsed}
                  strokeWidth={w} strokeLinecap="round" fill="none" />
          </>
        )}

        {/* the hand — stops well clear of the readout rather than crossing it */}
        {showHand && (
          <>
            <line x1={handInX} y1={handInY} x2={handOutX} y2={handOutY}
                  className={s.hand} strokeWidth={size * 0.0075} strokeLinecap="round" />
            <circle cx={markX} cy={markY} r={size * 0.021} className={s.handTip} />
          </>
        )}

        {/* Boundary labels, outside the ring. Dropped in compact: at 188px they
            are four-pixel type that reads as dirt rather than as a time. */}
        {!compact && [{ h: DAY_FROM, t: '09:30', anchor: 'end' }, { h: DAY_TO, t: '16:00', anchor: 'start' }]
          .map(({ h, t, anchor }) => {
            const [lx, ly] = pt(c, c, r + w * 1.35, h);
            return (
              <text key={t} x={lx} y={ly} className={s.boundaryLabel}
                    textAnchor={anchor as 'start' | 'end'} dominantBaseline="middle"
                    fontSize={size * 0.032}>{t}</text>
            );
          })}
      </svg>

      <div className={s.center} style={{ width: (r - w * 1.5) * 1.41 }}>
        <span className={s.holderLabel}>{sess.holder}</span>
        {!compact && <span className={s.holds}>holds the stock</span>}
        <span className={`${s.countdown} num`}>{countdown(sess.until)}</span>
        {!compact && <span className={s.handsTo}>until {sess.handsTo} takes over</span>}
        {reason && <span className={s.reason}>{reason}</span>}
      </div>

      {!compact && (
        <div className={s.readout}>
          <span className="num">{etClock(sess.now)}</span>
          <span className={s.readoutSep} aria-hidden="true">·</span>
          <span>{etDate(sess.now)}</span>
          <span className={s.readoutSep} aria-hidden="true">·</span>
          <span>{p.zone}</span>
        </div>
      )}
    </div>
  );
}
