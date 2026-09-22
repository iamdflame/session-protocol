/* Drawer, bottom sheet and dialog, as one accessible primitive.
 *
 * It is a modal: focus moves in and is trapped, Escape closes, the page
 * behind stops scrolling, and focus returns to whatever opened it. Rendered
 * into <body> so no ancestor's overflow or stacking context can clip it. */
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import s from './Sheet.module.css';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Sheet({ open, onClose, title, kind = 'drawer', children, labelledBy }: {
  open: boolean; onClose: () => void; title?: ReactNode;
  kind?: 'drawer' | 'sheet' | 'dialog'; children: ReactNode; labelledBy?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el.offsetParent !== null);
      if (!items.length) { e.preventDefault(); return; }
      const [a, z] = [items[0], items[items.length - 1]];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      opener?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <>
      <div className={s.scrim} onClick={onClose} aria-hidden="true" />
      <div
        ref={panel} className={s.panel} data-kind={kind}
        role="dialog" aria-modal="true" aria-labelledby={labelledBy ?? (title ? titleId : undefined)}
        tabIndex={-1}
      >
        <div className={s.grab} aria-hidden="true" />
        {title !== undefined && (
          <div className={s.head}>
            <h2 className={s.title} id={titleId}>{title}</h2>
            <button className={s.close} onClick={onClose} aria-label="Close"><Icon name="close" /></button>
          </div>
        )}
        <div className={s.body}>{children}</div>
      </div>
    </>,
    document.body,
  );
}
