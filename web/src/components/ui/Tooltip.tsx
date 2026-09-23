/* A tooltip explains a term; it never carries something needed to finish an
 * action. Shown on hover *and* focus, and linked with aria-describedby, so a
 * keyboard user and a screen reader get it too.
 *
 * Two things keep it from pushing the page sideways. Hidden, it is scaled to
 * nothing, so an invisible tip near the edge adds no width to the document —
 * `visibility: hidden` alone still lays it out, and on a phone that was 80px
 * of sideways scroll. Shown, it measures the room either side of its term and
 * aligns to the edge it would otherwise run past. */
import { useId, useRef, useState, type ReactNode } from 'react';
import s from './Tooltip.module.css';

const HALF = 150; // half the widest tip, with a margin

export function Tooltip({ tip, children, side = 'top' }: {
  tip: ReactNode; children: ReactNode; side?: 'top' | 'bottom';
}) {
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const [align, setAlign] = useState<'center' | 'start' | 'end'>('center');
  const place = () => {
    const r = wrap.current?.getBoundingClientRect();
    if (!r) return;
    const mid = r.left + r.width / 2;
    setAlign(mid < HALF ? 'start' : window.innerWidth - mid < HALF ? 'end' : 'center');
  };
  return (
    <span className={s.wrap} ref={wrap} onPointerEnter={place} onFocus={place}>
      <span aria-describedby={id} style={{ display: 'inline-flex' }}>{children}</span>
      <span role="tooltip" id={id} className={s.tip} data-side={side} data-align={align}>{tip}</span>
    </span>
  );
}

/** An inline technical term with its definition one hover or tab away. */
export function Term({ children, tip }: { children: ReactNode; tip: ReactNode }) {
  return (
    <Tooltip tip={tip}>
      <span className={s.term} tabIndex={0}>{children}</span>
    </Tooltip>
  );
}
