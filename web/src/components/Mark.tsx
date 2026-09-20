/* The mark is the product: a 24-hour ring carrying the real 6.5h / 17.5h split.
   Not an abstract glyph — the same geometry the session clock draws, at 26px. */

export const DAY_HOURS = 6.5;
export const NIGHT_HOURS = 24 - DAY_HOURS;

/** Polar point on a ring, with 0h at the top and the day clockwise from there. */
export function ringPoint(cx: number, cy: number, r: number, hours: number) {
  const a = (hours / 24) * Math.PI * 2 - Math.PI / 2;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
}

/** SVG arc path between two hour marks on a ring. */
export function ringArc(cx: number, cy: number, r: number, from: number, to: number) {
  const [x0, y0] = ringPoint(cx, cy, r, from);
  const [x1, y1] = ringPoint(cx, cy, r, to);
  const large = (to - from) % 24 > 12 ? 1 : 0;
  return `M ${x0.toFixed(3)} ${y0.toFixed(3)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(3)} ${y1.toFixed(3)}`;
}

export function Mark({ size = 28, title }: { size?: number; title?: string }) {
  const c = size / 2;
  const r = c - size * 0.13;
  const w = size * 0.155;

  // 09:30 → 16:00 ET is the day; the rest of the ring is the night.
  const dayFrom = 9.5, dayTo = 16;

  return (
    <svg
      width={size} height={size} viewBox={`0 0 ${size} ${size}`}
      role={title ? 'img' : 'presentation'} aria-label={title} aria-hidden={!title}
      style={{ display: 'block', flex: 'none' }}
    >
      <path
        d={ringArc(c, c, r, dayTo, dayFrom + 24)}
        stroke="var(--night)" strokeWidth={w} strokeLinecap="round" fill="none"
      />
      <path
        d={ringArc(c, c, r, dayFrom, dayTo)}
        stroke="var(--day)" strokeWidth={w} strokeLinecap="round" fill="none"
      />
    </svg>
  );
}
