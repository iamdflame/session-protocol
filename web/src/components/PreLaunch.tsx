import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import s from './PreLaunch.module.css';

const KEY = 'session.devnet-notice.dismissed';

/**
 * The honest state of this thing.
 *
 * The program is deployed on devnet with one live vault. The other assets on
 * the markets page have real history and real statistics but no vault on
 * chain yet, so their vault pages run a local simulation of the same code.
 * Said once, plainly, and dismissable — nobody needs to read it twice.
 */
export function PreLaunch() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(KEY) !== '1') setOpen(true);
    } catch {
      setOpen(true);   // blocked storage should show the notice, not hide it
    }
  }, []);

  if (!open) return null;

  const dismiss = () => {
    setOpen(false);
    try { localStorage.setItem(KEY, '1'); } catch { /* fine */ }
  };

  return (
    <div className={`shell ${s.wrap}`}>
      <div className={s.bar} role="note">
        <span className={s.dot} aria-hidden="true" />
        <p className={s.text}>
          <strong>Devnet.</strong> The program is live on Solana devnet with one vault —
          the row marked <em>devnet</em> mints and redeems on chain from your wallet. The
          other assets have no vault yet; their pages run the same{' '}
          <code className="mono">settle()</code> locally. Prices, the calendar and every
          historical figure are real throughout.{' '}
          <Link to="/how-it-works#status" className={s.link}>What is and is not live</Link>
        </p>
        <button className={s.close} onClick={dismiss} aria-label="Dismiss this notice">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor"
                  strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
