import { useEffect, useRef, useState, type ReactNode } from 'react';
import s from './Reveal.module.css';

/**
 * Animates a block in as it enters the viewport.
 *
 * The important property is what happens when the animation *doesn't* run.
 * An earlier version parked off-screen blocks at `opacity: 0` and waited for
 * an IntersectionObserver to release them, which meant a missed callback — a
 * fast flick, an anchor jump, a block that mounted after the scroll had
 * already gone past it — left real content permanently invisible. That is the
 * worst failure this component can have, and no entrance is worth it.
 *
 * So the resting state is *visible*, and the observer only ever adds an
 * animation on top. No observer, reduced motion, a missed frame, a callback
 * that never arrives: the content is simply there, unanimated.
 */
export function Reveal({
  children,
  delay = 0,
  as: Tag = 'div',
}: {
  children: ReactNode;
  delay?: number;
  as?: 'div' | 'section' | 'li' | 'tr';
}) {
  const ref = useRef<HTMLElement>(null);
  const [enter, setEnter] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    let first = true;
    const io = new IntersectionObserver(
      ([e]) => {
        if (first) {
          first = false;
          // On screen at mount: animating it now would be a flicker, not an
          // entrance. Leave it alone and stop watching.
          if (e.isIntersecting) io.disconnect();
          return;
        }
        if (e.isIntersecting) { setEnter(true); io.disconnect(); }
      },
      { rootMargin: '0px 0px -6% 0px', threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Tag
      ref={ref as never}
      className={s.reveal}
      data-enter={enter || undefined}
      style={enter && delay ? { animationDelay: `${delay}ms` } : undefined}
    >
      {children}
    </Tag>
  );
}
