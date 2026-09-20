import s from './RouteFallback.module.css';

/**
 * Shown while a route chunk loads.
 *
 * Not a spinner. Every page here opens the same way — eyebrow, heading, lead —
 * so the fallback can hold that exact shape and the real content lands in place
 * instead of shoving the page down. On a fast connection it is never seen; on a
 * slow one it should read as the page arriving, not as waiting.
 */
export function RouteFallback() {
  return (
    <div className={`shell ${s.wrap}`} role="status" aria-label="Loading">
      <div className="skeleton" style={{ width: 92, height: 11, borderRadius: 3 }} />
      <div className={s.lines}>
        <div className="skeleton" style={{ width: 'min(100%, 620px)', height: 40 }} />
        <div className="skeleton" style={{ width: 'min(82%, 480px)', height: 40 }} />
      </div>
      <div className={s.lines}>
        <div className="skeleton" style={{ width: 'min(100%, 560px)', height: 15 }} />
        <div className="skeleton" style={{ width: 'min(70%, 400px)', height: 15 }} />
      </div>
      <span className="sr-only">Loading</span>
    </div>
  );
}
