/* ───────────────────────────────────────────────────────────────────────────
   Today, as the program sees it.

   The session rail draws one Eastern-time day, 00:00 → 24:00, with the
   regular session as the DAY segment and the rest as NIGHT. Nothing here
   assumes 09:30–16:00: the segments are sampled from `sessionAt`, the same
   calendar the on-chain program settles on, so an early close ends DAY at
   13:00, a holiday or a weekend draws no DAY at all, and a DST day is still
   24 hours of wall clock.

   Sampling is per minute across the day — 1,440 calls — and cached by the
   ET day, so it runs once per day rather than once per tick.
   ─────────────────────────────────────────────────────────────────────────── */

import { sessionAt, Session } from '@sdk/calendar.ts';
import { etParts, closureReason } from './session';

export type Cls = 'day' | 'night';

export interface Segment { from: number; to: number; cls: Cls }
export interface Bell { at: number; kind: 'open' | 'close'; label: string }

export interface DayLayout {
  /** Unix seconds at 00:00 ET of this day. */
  start: number;
  /** 86,400 on every day — the rail is wall-clock, not session length. */
  length: number;
  segments: Segment[];
  bells: Bell[];
  /** 'Weekend', 'Market holiday', 'Early close', or null for a normal day. */
  note: string | null;
  /** ET calendar day number, the cache key. */
  day: number;
}

let cache: DayLayout | null = null;

/* Labels read the Eastern wall clock at the instant itself rather than an
   offset from midnight: on the two DST Sundays a year the day is 23 or 25
   hours long, and an offset would be an hour wrong after 02:00. */
const hhmm = (t: number) => {
  const p = etParts(t);
  return `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
};

export function dayLayout(now: number): DayLayout {
  const p = etParts(now);
  if (cache && cache.day === p.days) return cache;

  const start = now - p.secOfDay;
  const length = 86_400;
  const segments: Segment[] = [];
  let cur: Segment | null = null;
  for (let m = 0; m < 1440; m++) {
    const t = start + m * 60;
    const cls: Cls = sessionAt(t) === Session.Open ? 'day' : 'night';
    if (cur && cur.cls === cls) { cur.to = t + 60; continue; }
    cur = { from: t, to: t + 60, cls };
    segments.push(cur);
  }

  const bells: Bell[] = [];
  for (let i = 1; i < segments.length; i++) {
    const at = segments[i].from;
    const kind = segments[i].cls === 'day' ? 'open' : 'close';
    bells.push({ at, kind, label: hhmm(at) });
  }

  // The day's own character: why there is no DAY segment, or why it is short.
  const midday = start + 12 * 3600;
  const note = segments.every(s => s.cls === 'night')
    ? (closureReason(midday) ?? 'Market closed')
    : closureReason(start + 13.5 * 3600) === 'Early close' ? 'Early close' : null;

  cache = { start, length, segments, bells, note, day: p.days };
  return cache;
}

/** Fraction 0 → 1 of `t` along the day's rail. */
export const along = (layout: DayLayout, t: number) =>
  Math.min(1, Math.max(0, (t - layout.start) / layout.length));

/** "14:32" in ET for a point on the rail. */
export const railClock = (_layout: DayLayout, t: number) => hhmm(t);

/**
 * What a point on the rail means, for the scrub preview.
 *
 * Within ten minutes of a bell it is the handoff itself — the moment exposure
 * changes hands — rather than whichever side of it the minute happens to fall.
 */
export function stateAt(layout: DayLayout, t: number): { cls: Cls; handoff: Bell | null } {
  const seg = layout.segments.find(s => t >= s.from && t < s.to) ?? layout.segments[layout.segments.length - 1];
  const handoff = layout.bells.find(b => Math.abs(b.at - t) <= 600) ?? null;
  return { cls: seg.cls, handoff };
}
