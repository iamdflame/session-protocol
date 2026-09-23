/* ───────────────────────────────────────────────────────────────────────────
   The session rail — SESSION's signature instrument.

   One Eastern-time day, 00:00 → 24:00. The regular session is the DAY
   segment; everything else is NIGHT. A live indicator walks along it at the
   real time, and the bells are marked where the calendar puts them — so an
   early close, a holiday or a weekend draws itself, because the segments come
   from the same `sessionAt` the program settles on (lib/rail.ts).

   It is also the product's explanation. Drag the handle, or tab to it and use
   the arrow keys, and it tells you what holds the stock at that minute: DAY
   ACTIVE, HANDOFF, NIGHT ACTIVE. The handle snaps to the bells, because the
   bells are the only instants where the answer changes.

   The mini variant is the same geometry at 4px, for market rows.
   ─────────────────────────────────────────────────────────────────────────── */

import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useSession, useHandoff } from '@/lib/session';
import { dayLayout, along, railClock, stateAt, type DayLayout } from '@/lib/rail';
import s from './SessionRail.module.css';

export interface ScrubState { t: number; cls: 'day' | 'night'; handoff: { kind: 'open' | 'close'; label: string } | null }

const SNAP = 12 * 60;           // magnetic range around a bell, seconds
const TICKS = [0, 3, 6, 9, 12, 15, 18, 21, 24];

function useLayout(): { layout: DayLayout; now: number } | null {
  const sess = useSession();
  return useMemo(() => (sess ? { layout: dayLayout(sess.now), now: sess.now } : null), [sess]);
}

export function SessionRail({ interactive = false, onScrub, size = 'lg', label = 'Session rail' }: {
  interactive?: boolean;
  onScrub?: (s: ScrubState | null) => void;
  size?: 'lg' | 'md';
  label?: string;
}) {
  const data = useLayout();
  const handoff = useHandoff();
  const track = useRef<HTMLDivElement>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const dragging = useRef(false);

  const emit = useCallback((t: number | null) => {
    setScrub(t);
    if (!onScrub || !data) return;
    if (t === null) { onScrub(null); return; }
    const st = stateAt(data.layout, t);
    onScrub({ t, cls: st.cls, handoff: st.handoff ? { kind: st.handoff.kind, label: st.handoff.label } : null });
  }, [onScrub, data]);

  const fromPointer = (clientX: number): number | null => {
    if (!data || !track.current) return null;
    const r = track.current.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    let t = data.layout.start + Math.round((f * data.layout.length) / 60) * 60;
    const near = data.layout.bells.find(b => Math.abs(b.at - t) <= SNAP);
    if (near) t = near.at;
    return t;
  };

  if (!data) {
    return <div className={s.rail} data-size={size} aria-hidden="true"><div className={`skeleton ${s.skel}`} /></div>;
  }
  const { layout, now } = data;
  const nowF = along(layout, now);
  const shown = scrub ?? now;
  const shownState = stateAt(layout, shown);
  const nextBell = layout.bells.find(b => b.at > now) ?? null;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    emit(fromPointer(e.clientX));
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!interactive || !dragging.current) return;
    emit(fromPointer(e.clientX));
  };
  const onPointerUp = () => { dragging.current = false; };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return;
    const base = scrub ?? now;
    const step = e.shiftKey ? 3600 : 900;
    let t: number | null | undefined;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') t = base + step;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') t = base - step;
    else if (e.key === 'Home') t = layout.start;
    else if (e.key === 'End') t = layout.start + layout.length - 60;
    else if (e.key === 'PageUp' || e.key === ']') t = layout.bells.find(b => b.at > base)?.at ?? base;
    else if (e.key === 'PageDown' || e.key === '[') t = [...layout.bells].reverse().find(b => b.at < base)?.at ?? base;
    else if (e.key === 'Escape' || e.key.toLowerCase() === 'n') t = null;
    else return;
    e.preventDefault();
    emit(t === null ? null : Math.min(layout.start + layout.length - 60, Math.max(layout.start, t)));
  };

  const valueText = `${railClock(layout, shown)} ET, ${shownState.handoff
    ? `the ${shownState.handoff.kind === 'open' ? 'opening' : 'closing'} bell: handoff to ${shownState.handoff.kind === 'open' ? 'DAY' : 'NIGHT'}`
    : `${shownState.cls.toUpperCase()} holds the stock`}${scrub === null ? ' (now)' : ''}`;

  return (
    <div className={s.rail} data-size={size} data-handoff={handoff.active || undefined} data-scrubbing={scrub !== null || undefined}>
      <div
        ref={track}
        className={s.track}
        role={interactive ? 'slider' : 'img'}
        aria-label={interactive ? `${label}: drag, or use the arrow keys, to see who holds the stock at any minute today` : `${label}. ${valueText}.`}
        aria-valuemin={interactive ? 0 : undefined}
        aria-valuemax={interactive ? 1439 : undefined}
        aria-valuenow={interactive ? Math.round((shown - layout.start) / 60) : undefined}
        aria-valuetext={interactive ? valueText : undefined}
        tabIndex={interactive ? 0 : undefined}
        onKeyDown={onKey}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        data-interactive={interactive || undefined}
      >
        {layout.segments.map(seg => {
          const a = along(layout, seg.from), b = along(layout, seg.to);
          const live = now >= seg.from && now < seg.to;
          return (
            <span key={seg.from} className={s.seg} data-cls={seg.cls} data-live={live || undefined}
                  style={{ left: `${a * 100}%`, width: `${(b - a) * 100}%` }} />
          );
        })}
        {/* the part of today already behind us, dimmed */}
        <span className={s.past} style={{ width: `${nowF * 100}%` }} aria-hidden="true" />

        {layout.bells.map(b => (
          <span key={b.at} className={s.bell} data-kind={b.kind} data-next={nextBell?.at === b.at || undefined}
                style={{ left: `${along(layout, b.at) * 100}%` }} aria-hidden="true">
            <span className={s.bellLabel}>
              <span className="num">{b.label}</span>
              <span className={s.bellWord}>{b.kind === 'open' ? 'Open' : 'Close'}</span>
            </span>
          </span>
        ))}

        <span className={s.now} style={{ left: `${nowF * 100}%` }} aria-hidden="true">
          <span className={s.nowDot} />
          {size === 'lg' && scrub === null && <span className={s.nowLabel}>Now <span className="num">{railClock(layout, now)}</span></span>}
        </span>

        {interactive && (
          <span className={s.handle} data-cls={shownState.cls} data-hidden={scrub === null || undefined}
                style={{ left: `${along(layout, shown) * 100}%` }} aria-hidden="true">
            <span className={s.callout} data-cls={shownState.handoff ? 'handoff' : shownState.cls}>
              <span className="num">{railClock(layout, shown)}</span>
              <span className={s.calloutState}>
                {shownState.handoff ? `Handoff → ${shownState.handoff.kind === 'open' ? 'DAY' : 'NIGHT'}` : `${shownState.cls.toUpperCase()} active`}
              </span>
            </span>
          </span>
        )}
      </div>

      <div className={s.axis} aria-hidden="true">
        {TICKS.map(h => (
          <span key={h} className={s.tick} style={{ left: `${(h / 24) * 100}%` }}>{String(h % 24).padStart(2, '0')}</span>
        ))}
      </div>

      {layout.note && <p className={s.note}>{layout.note}: {layout.segments.every(x => x.cls === 'night') ? 'NIGHT holds all day' : 'DAY ends early'}</p>}
    </div>
  );
}

/** The same rail at 4px, for a market row. Static; the row itself is the link. */
export function MiniRail() {
  const data = useLayout();
  if (!data) return <span className={s.mini} aria-hidden="true" />;
  const { layout, now } = data;
  return (
    <span className={s.mini} aria-hidden="true">
      {layout.segments.map(seg => {
        const a = along(layout, seg.from), b = along(layout, seg.to);
        return <span key={seg.from} className={s.miniSeg} data-cls={seg.cls} style={{ left: `${a * 100}%`, width: `${(b - a) * 100}%` }} />;
      })}
      <span className={s.miniNow} style={{ left: `${along(layout, now) * 100}%` }} />
    </span>
  );
}
