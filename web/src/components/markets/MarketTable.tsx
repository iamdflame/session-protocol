/* ───────────────────────────────────────────────────────────────────────────
   The market table.

   Dense, aligned, and honest about what each row is. Price is live from
   Jupiter where a quote is available and marked as the history snapshot where
   it is not. DAY and NIGHT are the measured returns of each session over the
   study window — the product's own dimension, not a borrowed one. Every
   listed name shares one bell, so the session and countdown columns agree
   down the table; a pre-IPO name has no session and says so instead of
   inheriting a clock it does not trade on.

   Rows are links. Arrow keys move between them; Enter opens one.
   ─────────────────────────────────────────────────────────────────────────── */

import { useRef, type KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Asset, CurvePoint, Quote } from '@/lib/data';
import { useSession } from '@/lib/session';
import { AssetAvatar } from '../ui/Avatar';
import { Delta, Price, Countdown } from '../ui/Figures';
import { Icon } from '../ui/Icon';
import { Spark } from '../charts/Spark';
import s from './MarketTable.module.css';

export type SortKey = 'liquidity' | 'symbol' | 'price' | 'change' | 'day' | 'night' | 'gap';

export interface VaultInfo { kind: 'devnet' | 'event' }

function SessionCell({ asset }: { asset: Asset }) {
  const sess = useSession();
  if (asset.category === 'preipo') return <span className={s.none} title="Private company: no exchange session, no bell.">No session</span>;
  if (!sess) return <span className="skeleton" style={{ width: 70, height: 12, display: 'inline-block' }} />;
  const cls = sess.holder.toLowerCase();
  return <span className={s.sess} data-cls={cls}><span className={s.sessDot} aria-hidden="true" />{sess.holder}</span>;
}

function NextCell({ asset }: { asset: Asset }) {
  const sess = useSession();
  if (asset.category === 'preipo') return <span className={s.none}>—</span>;
  if (!sess) return <span className="skeleton" style={{ width: 64, height: 12, display: 'inline-block' }} />;
  return <Countdown seconds={sess.until} className={s.countdown} />;
}

export function MarketTable({ assets, quotes, curves, vaults, favorites, onFavorite, sort, onSort, compact, caption }: {
  assets: Asset[];
  quotes: Record<string, Quote>;
  curves?: Record<string, CurvePoint[]>;
  vaults: Map<string, VaultInfo>;
  favorites?: Set<string>;
  onFavorite?: (symbol: string) => void;
  sort?: SortKey;
  onSort?: (k: SortKey) => void;
  compact?: boolean;
  caption: string;
}) {
  const body = useRef<HTMLTableSectionElement>(null);
  const nav = useNavigate();

  /* Roving focus between rows: each row's first link is the tab stop, and the
     arrow keys move it — the table is one control, not 26 tab stops. */
  const onKey = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const links = [...(body.current?.querySelectorAll<HTMLAnchorElement>('a[data-row]') ?? [])];
    const i = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (i < 0) return;
    e.preventDefault();
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? links.length - 1
      : Math.min(links.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)));
    links[n]?.focus();
  };

  const th = (k: SortKey | null, label: string, cls?: string) => (
    <th scope="col" className={cls} aria-sort={k && sort === k ? 'descending' : undefined}>
      {k && onSort ? (
        <button className={s.sortBtn} onClick={() => onSort(k)} data-on={sort === k || undefined}>
          {label}{sort === k && <Icon name="chevronDown" size={12} />}
        </button>
      ) : label}
    </th>
  );

  return (
    <div className={s.wrap} data-compact={compact || undefined}>
      <table className={s.table}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {th('symbol', 'Asset', s.colAsset)}
            {!compact && <th scope="col" className={s.colSpark}><span className="sr-only">DAY and NIGHT history</span></th>}
            {th('price', 'Price', s.num)}
            {th('change', '24h', s.num)}
            {th('day', 'DAY', `${s.num} ${s.colDay}`)}
            {th('night', 'NIGHT', `${s.num} ${s.colNight}`)}
            {th(null, 'Session', s.colSession)}
            {th(null, 'Next handoff', `${s.num} ${s.colNext}`)}
            {!compact && th(null, 'Vault', s.colVault)}
            {onFavorite && <th scope="col" className={s.colFav}><span className="sr-only">Favorite</span></th>}
          </tr>
        </thead>
        <tbody ref={body} onKeyDown={onKey}>
          {assets.map((a, i) => {
            const q = quotes[a.mint];
            const vault = vaults.get(a.symbol);
            const href = `/markets/${encodeURIComponent(a.symbol)}`;
            const fav = favorites?.has(a.symbol);
            return (
              <tr key={a.symbol} className={s.row} onClick={e => {
                if ((e.target as HTMLElement).closest('a, button')) return;
                nav(href);
              }}>
                <th scope="row" className={s.colAsset}>
                  <Link to={href} className={s.assetLink} data-row tabIndex={i === 0 ? 0 : -1}>
                    <AssetAvatar symbol={a.symbol} kind={a.category} />
                    <span className={s.assetText}>
                      <span className={`mono ${s.sym}`}>{a.symbol}</span>
                      <span className={s.name}>{a.name}</span>
                    </span>
                  </Link>
                </th>
                {!compact && (
                  <td className={s.colSpark}>
                    {curves?.[a.symbol] ? <Spark points={curves[a.symbol]} width={84} height={26} /> : <span className={s.sparkSkel} />}
                  </td>
                )}
                <td className={`${s.num} ${s.colPrice}`}>
                  <Price value={q?.price ?? a.price} />
                  {!q && <span className={s.snap} title="No live quote; last close from the study data.">last close</span>}
                </td>
                <td className={`${s.num} ${s.colChange}`}><Delta value={a.change24h} /></td>
                <td className={`${s.num} ${s.colDay}`} data-label="DAY"><Delta value={a.day?.cumulative ?? null} title="DAY sessions, compounded over the study window" /></td>
                <td className={`${s.num} ${s.colNight}`} data-label="NIGHT"><Delta value={a.night?.cumulative ?? null} title="NIGHT sessions, compounded over the study window" /></td>
                <td className={s.colSession}><SessionCell asset={a} /></td>
                <td className={`${s.num} ${s.colNext}`}><NextCell asset={a} /></td>
                {!compact && (
                  <td className={s.colVault}>
                    {vault ? <span className={s.vault} data-kind={vault.kind}>{vault.kind === 'event' ? 'Devnet · event' : 'Devnet vault'}</span>
                      : <span className={s.sim} title="No vault on chain. Its page runs the same settle() locally, with balances in your browser.">Simulated</span>}
                  </td>
                )}
                {onFavorite && (
                  <td className={s.colFav}>
                    <button className={s.fav} data-on={fav || undefined} onClick={() => onFavorite(a.symbol)}
                            aria-pressed={!!fav} aria-label={`${fav ? 'Remove' : 'Add'} ${a.symbol} ${fav ? 'from' : 'to'} favorites`}>
                      <Icon name="star" size={15} />
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
