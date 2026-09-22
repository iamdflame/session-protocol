/* A segmented control is a radio group, and behaves like one: arrow keys move
 * the selection, Home/End jump, and only the selected item is in the tab
 * order. */
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import s from './Segmented.module.css';

export interface Segment<T extends string> {
  value: T; label: ReactNode; count?: number; tone?: 'day' | 'night'; hint?: string;
}

export function Segmented<T extends string>({ label, value, onChange, items, block, size }: {
  label: string; value: T; onChange: (v: T) => void; items: Segment<T>[];
  block?: boolean; size?: 'md' | 'lg';
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const idx = Math.max(0, items.findIndex(i => i.value === value));

  const onKey = (e: KeyboardEvent) => {
    let n = idx;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (idx + 1) % items.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (idx - 1 + items.length) % items.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = items.length - 1;
    else return;
    e.preventDefault();
    onChange(items[n].value);
    refs.current[n]?.focus();
  };

  return (
    <div className={s.group} role="radiogroup" aria-label={label} onKeyDown={onKey}
         data-block={block || undefined} data-size={size}>
      {items.map((it, i) => (
        <button
          key={it.value} ref={el => { refs.current[i] = el; }}
          type="button" role="radio" aria-checked={it.value === value}
          tabIndex={it.value === value ? 0 : -1}
          className={s.item} data-tone={it.tone} title={it.hint}
          onClick={() => onChange(it.value)}
        >
          {it.label}
          {it.count !== undefined && <span className={s.count}>{it.count}</span>}
        </button>
      ))}
    </div>
  );
}
