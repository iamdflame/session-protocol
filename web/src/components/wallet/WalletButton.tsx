/* The wallet, as a trader sees it.
 *
 * Disconnected: one primary action. Connected: an identicon, the short
 * address, and the two balances that decide what you can do here — SOL for
 * fees and the devnet test quote you mint with — plus a menu with the four
 * things a person actually does with a connected wallet on this site. */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { ata } from '@sdk/ix.ts';
import { useWalletModal } from './WalletModal';
import { short, explorerAddr, useDevnet } from '@/lib/chain';
import { Icon } from '../ui/Icon';
import s from './WalletButton.module.css';

/** A 5×5 mirrored grid drawn from the address — the same wallet, the same face. */
export function Identicon({ address, size = 20 }: { address: string; size?: number }) {
  let h = 2166136261;
  for (const ch of address) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const cells: [number, number][] = [];
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
    if ((h >>> ((y * 3 + x) % 31)) & 1) { cells.push([x, y]); if (x < 2) cells.push([4 - x, y]); }
  }
  const tone = 190 + (h % 60);
  return (
    <svg width={size} height={size} viewBox="0 0 5 5" className={s.identicon} aria-hidden="true" shapeRendering="crispEdges">
      <rect width="5" height="5" fill="#1A1F26" />
      {cells.map(([x, y], i) => <rect key={i} x={x} y={y} width="1" height="1" fill={`hsl(${tone} 12% 72%)`} />)}
    </svg>
  );
}

function useBalances(owner: PublicKey | null) {
  const { connection } = useConnection();
  const devnet = useDevnet();
  const [sol, setSol] = useState<number | null>(null);
  const [quote, setQuote] = useState<number | null>(null);

  useEffect(() => {
    if (!owner) { setSol(null); setQuote(null); return; }
    let live = true;
    const read = async () => {
      const lamports = await connection.getBalance(owner).catch(() => null);
      if (live) setSol(lamports === null ? null : lamports / LAMPORTS_PER_SOL);
      if (!devnet) return;
      const acct = ata(owner, new PublicKey(devnet.quoteMint), new PublicKey(devnet.tokenProgram));
      const b = await connection.getTokenAccountBalance(acct).then(r => r.value.uiAmount ?? 0).catch(() => 0);
      if (live) setQuote(b);
    };
    read();
    const id = setInterval(read, 30_000);
    return () => { live = false; clearInterval(id); };
  }, [connection, owner, devnet]);

  return { sol, quote };
}

export function WalletButton({ compact = false }: { compact?: boolean }) {
  const { publicKey, connected, connecting, disconnect, wallet } = useWallet();
  const { setOpen } = useWalletModal();
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const { sol, quote } = useBalances(connected ? publicKey : null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setMenu(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey); };
  }, [menu]);

  if (!connected || !publicKey) {
    return (
      <button className={s.connect} data-compact={compact || undefined} onClick={() => setOpen(true)} disabled={connecting}>
        {compact ? <Icon name="wallet" size={16} /> : null}
        <span className={compact ? s.connectCompactLabel : undefined}>{connecting ? 'Connecting…' : compact ? 'Connect' : 'Connect wallet'}</span>
      </button>
    );
  }

  const addr = publicKey.toBase58();
  return (
    <div className={s.wrap} ref={wrap}>
      <button className={s.account} data-compact={compact || undefined} onClick={() => setMenu(v => !v)} aria-haspopup="menu" aria-expanded={menu}>
        <Identicon address={addr} />
        <span className={s.accountText}>
          <span className={`mono ${s.addr}`}>{short(addr)}</span>
          {!compact && (
            <span className={`num ${s.bal}`}>
              {sol === null ? '— SOL' : `${sol.toFixed(3)} SOL`}
              {quote !== null && <> · {quote.toLocaleString('en-US', { maximumFractionDigits: 2 })} quote</>}
            </span>
          )}
        </span>
        <Icon name="chevronDown" size={13} />
      </button>

      {menu && (
        <div className={s.menu} role="menu">
          <div className={s.menuHead}>
            <span className={s.menuLabel}>{wallet?.adapter.name} · <span className={s.devnet}>Devnet</span></span>
            <span className={`mono ${s.menuAddr}`}>{addr}</span>
            <span className={`num ${s.menuBal}`}>
              {sol === null ? '—' : sol.toFixed(4)} SOL
              {quote !== null && <> · {quote.toLocaleString('en-US', { maximumFractionDigits: 2 })} test quote</>}
            </span>
          </div>
          <Link role="menuitem" className={s.item} to="/portfolio" onClick={() => setMenu(false)}>
            <Icon name="portfolio" size={15} /> Portfolio
          </Link>
          <button role="menuitem" className={s.item} onClick={async () => {
            try { await navigator.clipboard.writeText(addr); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
          }}>
            <Icon name={copied ? 'check' : 'copy'} size={15} /> {copied ? 'Copied' : 'Copy address'}
          </button>
          <a role="menuitem" className={s.item} href={explorerAddr(addr)} target="_blank" rel="noreferrer">
            <Icon name="external" size={15} /> View on Solscan
          </a>
          <button role="menuitem" className={`${s.item} ${s.danger}`} onClick={() => { setMenu(false); disconnect(); }}>
            <Icon name="logout" size={15} /> Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
