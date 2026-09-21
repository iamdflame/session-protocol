import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDevnets } from '@/lib/chain';
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
  // Counted, not asserted: this line was written when there was one vault and
  // went stale the day there were two.
  const vaults = useDevnets();
  const live = vaults === undefined ? null : vaults.length;
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
          <strong>Devnet.</strong> The program is live on Solana devnet with{' '}
          {live === null ? 'a vault' : live === 1 ? 'one vault' : `${live} vaults`} — the rows
          marked <em>devnet</em> mint and redeem on chain from your wallet. The other assets
          have no vault; their pages say so and run the same{' '}
          <code className="mono">settle()</code> in the browser. Prices, the calendar and
          every historical figure are real throughout.{' '}
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
