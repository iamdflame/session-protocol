import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { useWallet, type Wallet } from '@solana/wallet-adapter-react';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import s from './WalletModal.module.css';

/* ── context ─────────────────────────────────────────────────────────────── */

interface Ctx { open: boolean; setOpen: (v: boolean) => void }
const ModalCtx = createContext<Ctx>({ open: false, setOpen: () => {} });
export const useWalletModal = () => useContext(ModalCtx);

export function WalletModalProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <ModalCtx.Provider value={{ open, setOpen }}>
      {children}
      {open && <Modal onClose={() => setOpen(false)} />}
    </ModalCtx.Provider>
  );
}

/* ── the modal ───────────────────────────────────────────────────────────── */

/**
 * A wallet picker in the site's own idiom.
 *
 * The adapter ships a modal, but it carries its own stylesheet and its own
 * idea of a button; on a page whose whole point is a specific visual system
 * that reads as a seam. This is ~100 lines and does the same job: installed
 * wallets first, the rest as links to get them, keyboard and focus handled
 * like every other dialog on the site.
 */
function Modal({ onClose }: { onClose: () => void }) {
  const { wallets, select, connect, connecting, wallet: current } = useWallet();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const first = useRef<HTMLButtonElement>(null);
  const restore = useRef<HTMLElement | null>(null);

  // Installed wallets are the ones that can actually connect right now.
  const [installed, others] = useMemo(() => {
    const inst = wallets.filter(w => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable);
    const rest = wallets.filter(w => !inst.includes(w));
    return [inst, rest];
  }, [wallets]);

  useEffect(() => {
    restore.current = document.activeElement as HTMLElement | null;
    first.current?.focus();
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      restore.current?.focus?.();
    };
  }, [onClose]);

  // Selecting and connecting are two steps with a render in between: the
  // provider only subscribes to an adapter's events once it is the selected
  // one, so connecting the adapter directly after `select()` lands before the
  // provider is listening and the UI never learns it happened. Select, let the
  // provider switch, then connect through the context.
  const pick = useCallback((w: Wallet) => {
    setError(null);
    setBusy(w.adapter.name);
    setPending(w.adapter.name);
    select(w.adapter.name);
  }, [select]);

  useEffect(() => {
    if (!pending || current?.adapter.name !== pending) return;
    let live = true;
    (async () => {
      try {
        await connect();
        if (live) onClose();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (live) setError(/reject|denied|cancel/i.test(msg) ? 'Cancelled in the wallet.' : msg);
      } finally {
        if (live) { setBusy(null); setPending(null); }
      }
    })();
    return () => { live = false; };
  }, [pending, current, connect, onClose]);

  return (
    <div className={s.backdrop} onClick={onClose} role="presentation">
      <div
        className={s.dialog}
        role="dialog" aria-modal="true" aria-labelledby="wallet-title"
        onClick={e => e.stopPropagation()}
      >
        <header className={s.head}>
          <div>
            <p className="eyebrow">Devnet</p>
            <h2 id="wallet-title" className={s.title}>Connect a wallet</h2>
          </div>
          <button className={s.close} onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        {installed.length === 0 ? (
          <div className={s.none}>
            <p>No Solana wallet is installed in this browser.</p>
            <p className={s.noneSub}>
              Phantom, Solflare and Backpack all work. Install one, switch it to
              <strong> devnet</strong>, and come back — the site will see it.
            </p>
          </div>
        ) : (
          <ul className={s.list}>
            {installed.map((w, i) => (
              <li key={w.adapter.name}>
                <button
                  ref={i === 0 ? first : undefined}
                  className={s.wallet}
                  onClick={() => pick(w)}
                  disabled={!!busy || connecting}
                  data-current={current?.adapter.name === w.adapter.name}
                >
                  <img src={w.adapter.icon} alt="" width="28" height="28" className={s.icon} />
                  <span className={s.name}>{w.adapter.name}</span>
                  <span className={s.state}>
                    {busy === w.adapter.name ? 'Connecting…' : 'Detected'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {others.length > 0 && installed.length > 0 && (
          <details className={s.more}>
            <summary>Other wallets</summary>
            <ul className={s.list}>
              {others.map(w => (
                <li key={w.adapter.name}>
                  <a className={s.wallet} href={w.adapter.url} target="_blank" rel="noreferrer">
                    <img src={w.adapter.icon} alt="" width="28" height="28" className={s.icon} />
                    <span className={s.name}>{w.adapter.name}</span>
                    <span className={s.state}>Get</span>
                  </a>
                </li>
              ))}
            </ul>
          </details>
        )}

        {error && <p className={s.error} role="alert">{error}</p>}

        <p className={s.foot}>
          This is Solana <strong>devnet</strong>. Nothing here has value, and the
          quote token is a test mint you can get from the faucet once connected.
        </p>
      </div>
    </div>
  );
}
