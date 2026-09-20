import { useEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from './WalletModal';
import { short, explorerAddr } from '@/lib/chain';
import s from './WalletButton.module.css';

/**
 * The connect control in the nav.
 *
 * Disconnected it is a single button. Connected it is the address, and a
 * small menu with copy, explorer and disconnect — the three things a person
 * actually does with a connected wallet on a site like this.
 */
export function WalletButton({ compact = false }: { compact?: boolean }) {
  const { publicKey, connected, connecting, disconnect, wallet } = useWallet();
  const { setOpen } = useWalletModal();
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  if (!connected || !publicKey) {
    return (
      <button
        className={s.connect}
        data-compact={compact}
        onClick={() => setOpen(true)}
        disabled={connecting}
      >
        {connecting ? 'Connecting…' : compact ? 'Connect' : 'Connect wallet'}
      </button>
    );
  }

  const addr = publicKey.toBase58();

  return (
    <div className={s.wrap} ref={wrap}>
      <button
        className={s.account}
        data-compact={compact}
        onClick={() => setMenu(v => !v)}
        aria-haspopup="menu" aria-expanded={menu}
      >
        {wallet?.adapter.icon && <img src={wallet.adapter.icon} alt="" width="16" height="16" className={s.icon} />}
        <span className={`mono ${s.addr}`}>{short(addr)}</span>
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
          <path d="M4 6.5 8 10.5l4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {menu && (
        <div className={s.menu} role="menu">
          <p className={s.menuHead}>
            <span className={s.menuLabel}>{wallet?.adapter.name} · devnet</span>
            <span className={`mono ${s.menuAddr}`}>{addr}</span>
          </p>
          <button
            role="menuitem" className={s.item}
            onClick={async () => {
              try { await navigator.clipboard.writeText(addr); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
            }}
          >
            {copied ? 'Copied' : 'Copy address'}
          </button>
          <a role="menuitem" className={s.item} href={explorerAddr(addr)} target="_blank" rel="noreferrer">
            View on Explorer ↗
          </a>
          <button role="menuitem" className={`${s.item} ${s.danger}`} onClick={() => { setMenu(false); disconnect(); }}>
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
