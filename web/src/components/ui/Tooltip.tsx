/* A tooltip explains a term; it never carries something needed to finish an
 * action. Shown on hover *and* focus, and linked with aria-describedby, so a
 * keyboard user and a screen reader get it too. */
import { useId, type ReactNode } from 'react';
import s from './Tooltip.module.css';

export function Tooltip({ tip, children, side = 'top' }: {
  tip: ReactNode; children: ReactNode; side?: 'top' | 'bottom';
}) {
  const id = useId();
  return (
    <span className={s.wrap}>
      <span aria-describedby={id} style={{ display: 'inline-flex' }}>{children}</span>
      <span role="tooltip" id={id} className={s.tip} data-side={side}>{tip}</span>
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
