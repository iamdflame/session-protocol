/* Numbers that behave like numbers in a financial product.
 *
 * Signed figures always show their sign: colour is never the only carrier of
 * direction, because red and green are indistinguishable to a deuteranope.
 * A changed value tints briefly and decays — a tick, not an alert. */
import { useEffect, useRef, useState } from 'react';
import s from './Figures.module.css';

/** Brief flash direction when `value` changes, cleared after the animation. */
function useFlash(value: number | null | undefined): 'up' | 'down' | undefined {
  const prev = useRef(value);
  const [flash, setFlash] = useState<'up' | 'down' | undefined>();
  useEffect(() => {
    const p = prev.current;
    prev.current = value;
    if (p === null || p === undefined || value === null || value === undefined || p === value) return;
    setFlash(value > p ? 'up' : 'down');
    const t = setTimeout(() => setFlash(undefined), 650);
    return () => clearTimeout(t);
  }, [value]);
  return flash;
}

/** A signed change. `value` is a fraction (0.0124 = +1.24%) unless `unit` says otherwise. */
export function Delta({ value, digits = 2, unit = '%', flash, className, title }: {
  value: number | null | undefined; digits?: number; unit?: '%' | 'bp' | '';
  flash?: boolean; className?: string; title?: string;
}) {
  const f = useFlash(flash ? value : undefined);
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <span className={`${s.delta} ${className ?? ''}`} data-sign="zero" title={title}>—</span>;
  }
  const scaled = unit === '%' ? value * 100 : unit === 'bp' ? value * 10_000 : value;
  const rounded = Number(scaled.toFixed(digits));
  const sign = rounded > 0 ? 'pos' : rounded < 0 ? 'neg' : 'zero';
  // U+2212 for the minus: same width as the plus, so columns stay aligned.
  const text = `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${Math.abs(rounded).toFixed(digits)}${unit === '%' ? '%' : unit === 'bp' ? ' bp' : ''}`;
  return <span className={`${s.delta} ${className ?? ''}`} data-sign={sign} data-flash={f} title={title}>{text}</span>;
}

/** A price in dollars, tinted briefly when it moves. */
export function Price({ value, digits, className }: { value: number | null | undefined; digits?: number; className?: string }) {
  const f = useFlash(value);
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className={`${s.price} ${className ?? ''}`}>—</span>;
  const d = digits ?? (value >= 1000 ? 2 : value >= 1 ? 2 : 4);
  return (
    <span className={`${s.price} ${className ?? ''}`} data-flash={f}>
      ${value.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}
    </span>
  );
}

/** HH:MM:SS for anything under a day, "2d 04:12:09" beyond — fixed-width either way. */
export function clock(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  const d = Math.floor(t / 86400);
  const h = Math.floor((t % 86400) / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  const hms = [h, m, sec].map(n => String(n).padStart(2, '0')).join(':');
  return d > 0 ? `${d}d ${hms}` : hms;
}

export function Countdown({ seconds, className, label }: { seconds: number; className?: string; label?: string }) {
  return (
    <span className={`${s.countdown} ${className ?? ''}`} aria-label={label ? `${label} ${clock(seconds)}` : undefined}>
      {clock(seconds)}
    </span>
  );
}
