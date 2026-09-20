/* ───────────────────────────────────────────────────────────────────────────
   Live session state.

   Everything here reads from the same calendar the on-chain program runs — the
   one pinned by 4,734 cross-language vectors — so the countdown on screen is
   the same instant the vault will settle at, through DST, holidays and early
   closes. Nothing about the clock is approximated for the UI.
   ─────────────────────────────────────────────────────────────────────────── */


import { useEffect, useState } from 'react';
import {
  sessionAt, nextBoundary, Session, isDST, civilFromDays, weekdayFromDays,
  holidays, earlyCloses, SEC_PER_DAY,
} from '@sdk/calendar.ts';

export { Session };

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
               'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A UTC instant rendered in Eastern wall-clock, which is how a trader reads it. */
export function etParts(ts: number) {
  const dst = isDST(ts);
  const et = ts + (dst ? -4 : -5) * 3600;
  const days = Math.floor(et / SEC_PER_DAY);
  const s = et - days * SEC_PER_DAY;
  const { y, m, d } = civilFromDays(days);
  return {
    y, m, d, days,
    hh: Math.floor(s / 3600),
    mm: Math.floor((s % 3600) / 60),
    ss: Math.floor(s % 60),
    dow: DOW[weekdayFromDays(days)],
    month: MONTH[m - 1],
    zone: dst ? 'EDT' : 'EST',
    secOfDay: s,
  };
}

export const etClock = (ts: number) => {
  const p = etParts(ts);
  return `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
};

export const etDate = (ts: number) => {
  const p = etParts(ts);
  return `${p.dow} ${p.month} ${p.d}`;
};

/** `4h 12m`, or `11m 04s` inside the last hour where seconds start to matter. */
export function countdown(seconds: number): string {
  if (seconds <= 0) return '00s';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${String(h).padStart(2, '0')}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export interface SessionState {
  now: number;
  session: Session;
  isOpen: boolean;
  /** The class that holds the stock right now. */
  holder: 'NIGHT' | 'DAY';
  next: number | null;
  /** Seconds until the next boundary. */
  until: number;
  /** The class that takes over at that boundary. */
  handsTo: 'NIGHT' | 'DAY';
  /** How long the current stretch runs, end to end, in seconds. */
  spanTotal: number;
  /** 0 → 1 through the current stretch. Drives the clock hand. */
  spanProgress: number;
  /** True for a weekend or holiday stretch, which reads very differently. */
  isLongHold: boolean;
  /** Unix seconds at which the current stretch began. */
  spanStart: number;
}

/**
 * The span the clock is currently inside, found once and then reused.
 *
 * Both halves of this are expensive — walking back to the start of a stretch
 * costs a `sessionAt` per minute, and a Friday-to-Monday night is 3,930 of
 * them — and both are *constant until the next boundary*. Recomputing them on
 * every tick measured at 14ms a second, which is a dropped frame every second
 * for an answer that had not changed. So the span is cached and only rebuilt
 * when the clock crosses out of it.
 */
let span: { session: Session; start: number; next: number | null } | null = null;

function spanAt(now: number) {
  if (span && now >= span.start && (span.next === null || now < span.next)) {
    // Cheap re-check: a cached span that no longer matches the calendar means
    // the machine slept through a boundary, or the clock was moved.
    if (sessionAt(now) === span.session) return span;
  }

  const session = sessionAt(now);
  const next = nextBoundary(now, 20);

  // Walk back to where this stretch began so progress is real rather than
  // assumed: a Friday-to-Monday night is 65.5h, not 17.5h.
  let start = now;
  for (let probe = now - 60; probe > now - 12 * SEC_PER_DAY; probe -= 60) {
    if (sessionAt(probe) !== session) { start = probe + 60; break; }
  }

  span = { session, start, next };
  return span;
}

function compute(now: number): SessionState {
  const { session, start, next } = spanAt(now);
  const isOpen = session === Session.Open;

  const until = next === null ? 0 : Math.max(0, next - now);
  const spanTotal = next === null ? 1 : Math.max(1, next - start);
  const holder = isOpen ? 'DAY' : 'NIGHT';

  return {
    now, session, isOpen, holder, next, until,
    handsTo: isOpen ? 'NIGHT' : 'DAY',
    spanTotal,
    spanProgress: Math.min(1, Math.max(0, (now - start) / spanTotal)),
    isLongHold: spanTotal > 20 * 3600,
    /** When this stretch began — the clock lights the elapsed part from here. */
    spanStart: start,
  };
}

/**
 * One ticker, however many components ask for the time.
 *
 * The clock, the nav badge and the hero all want the same second. Three
 * intervals would mean three timers, three `compute` calls and three separate
 * re-render roots for one piece of state that is identical in all of them.
 */
const listeners = new Set<(s: SessionState) => void>();
let ticker: ReturnType<typeof setInterval> | null = null;
let current: SessionState | null = null;

function tick() {
  current = compute(Math.floor(Date.now() / 1000));
  for (const fn of listeners) fn(current);
}

export function useSession(): SessionState | null {
  // null on the first render, so nothing renders a time that was computed
  // before the component was on screen.
  const [state, setState] = useState<SessionState | null>(null);

  useEffect(() => {
    listeners.add(setState);
    if (!ticker) { tick(); ticker = setInterval(tick, 1000); }
    else setState(current ?? compute(Math.floor(Date.now() / 1000)));

    return () => {
      listeners.delete(setState);
      if (!listeners.size && ticker) { clearInterval(ticker); ticker = null; }
    };
  }, []);

  return state;
}

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The next `n` boundaries, for schedules and the clock's forward view.
 *
 * Each carries a label relative to *Eastern* today, not the viewer's today —
 * a holder in Singapore reading "tomorrow" about a bell that already rang
 * would be reading a different market than the one the vault settles against.
 */
let upcomingCache: { key: number; n: number; out: Upcoming[] } | null = null;

export interface Upcoming {
  at: number;
  to: 'NIGHT' | 'DAY';
  span: number;
  label: string;
}

export function upcoming(from: number, n = 6): Upcoming[] {
  // Each entry costs a `nextBoundary`, and `nextBoundary` walks the calendar a
  // minute at a time — a weekend is 3,930 steps. The answer is the same for
  // every instant inside the current stretch, so it is computed once per
  // boundary rather than once per tick.
  const key = spanAt(from).next ?? 0;
  if (upcomingCache && upcomingCache.key === key && upcomingCache.n === n) {
    return upcomingCache.out;
  }

  const today = etParts(from).days;
  const out: Upcoming[] = [];
  let t = from;
  for (let i = 0; i < n; i++) {
    const b = nextBoundary(t, 20);
    if (b === null) break;
    const p = etParts(b);
    const ahead = p.days - today;
    const label =
      ahead === 0 ? 'Today'
      : ahead === 1 ? 'Tomorrow'
      : ahead < 7 ? WEEKDAY[weekdayFromDays(p.days)]
      : `${WEEKDAY[weekdayFromDays(p.days)].slice(0, 3)} ${p.m}/${p.d}`;
    out.push({
      at: b,
      to: sessionAt(b) === Session.Open ? 'DAY' : 'NIGHT',
      span: b - t,
      label,
    });
    t = b;
  }

  upcomingCache = { key, n, out };
  return out;
}

/** Why the market is shut, when the reason is not simply "it is night". */
export function closureReason(ts: number): string | null {
  if (sessionAt(ts) === Session.Open) return null;
  const p = etParts(ts);
  const w = weekdayFromDays(p.days);
  if (w === 0 || w === 6) return 'Weekend';
  if (holidays(p.y).has(p.days)) return 'Market holiday';
  if (earlyCloses(p.y).has(p.days) && p.secOfDay >= 13 * 3600) return 'Early close';
  return null;
}

/**
 * Viewport width, tracked.
 *
 * The session clock is a fixed square drawn from its `size`, and every label
 * inside it is a fraction of that size — which is what lets one component work
 * at 188px and 380px. It also means the size has to come from somewhere real
 * on a narrow screen, rather than overflowing the gutter.
 */
export function useViewport(): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    on();
    window.addEventListener('resize', on, { passive: true });
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}

/** The largest clock that fits, never bigger than the design size. */
export function useClockSize(preferred: number, inset = 96): number {
  const vw = useViewport();
  if (!vw) return preferred;
  return Math.round(Math.max(200, Math.min(preferred, vw - inset)));
}

export const SESSION_HOURS = { day: 6.5, night: 17.5 };
/** 73% of every week — the asymmetry the whole product rests on. */
export const NIGHT_SHARE = 17.5 / 24;
