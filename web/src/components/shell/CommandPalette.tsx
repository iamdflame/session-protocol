/* ⌘K: jump to any market or page.
 *
 * 26 assets and a handful of pages do not need a search engine. This is a
 * filtered list: ticker first, then company name, then mint — so "nvda",
 * "nvidia" and a pasted mint all land on the same row. Arrow keys move,
 * Enter goes, Escape closes. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMarkets } from '@/lib/data';
import { useDevnets } from '@/lib/chain';
import { Sheet } from '../ui/Sheet';
import { Icon, type IconName } from '../ui/Icon';
import { AssetAvatar } from '../ui/Avatar';
import s from './Palette.module.css';
import { useTour } from '../tour/Tour';

const Ctx = createContext<{ open: () => void }>({ open: () => {} });
export const usePalette = () => useContext(Ctx);

interface Row { key: string; to: string; title: string; sub: string; icon?: IconName; symbol?: string; kind?: string; rank: number; badge?: string; tour?: boolean }

const PAGES: Omit<Row, 'rank'>[] = [
  { key: 'p:trade', to: '/trade', title: 'Trade', sub: 'Mint or redeem the parked class', icon: 'trade' },
  { key: 'p:markets', to: '/markets', title: 'Markets', sub: 'All 26 tokenized assets', icon: 'markets' },
  { key: 'p:portfolio', to: '/portfolio', title: 'Portfolio', sub: 'What you hold, and what changes at the next bell', icon: 'portfolio' },
  { key: 'p:research', to: '/research', title: 'Research', sub: 'Does the overnight premium survive?', icon: 'research' },
  { key: 'p:how', to: '/how-it-works', title: 'How it works', sub: 'The handoff, step by step', icon: 'how' },
  { key: 'p:bells', to: '/bells', title: 'Bell orders', sub: 'Buy or sell NVDAx at the open or close', icon: 'clock' },
  { key: 'p:bell', to: '/bell', title: 'Keeper', sub: 'The next boundary, live', icon: 'bell' },
  { key: 'p:oracle', to: '/oracle', title: 'Oracle', sub: 'Every open and close, as Pyth signed them', icon: 'verified' },
  { key: 'p:list', to: '/list', title: 'Open a vault', sub: 'initialize_vault from your wallet', icon: 'list' },
  { key: 'p:demo', to: '/trade?demo=1', title: 'Explore the demo', sub: 'A sandbox copy of the NVDAx vault — no wallet, nothing sent', icon: 'play' },
  { key: 'p:tour', to: '/', title: 'Take the 90-second tour', sub: 'Seven stops: the classes, the clock, the vault, the research', icon: 'play', tour: true },
];

function score(q: string, fields: string[]): number {
  let best = 0;
  fields.forEach((f, i) => {
    const v = f.toLowerCase();
    const weight = 3 - Math.min(i, 2);
    if (v === q) best = Math.max(best, 100 * weight);
    else if (v.startsWith(q)) best = Math.max(best, 50 * weight);
    else if (v.includes(q)) best = Math.max(best, 10 * weight);
  });
  return best;
}

function Palette({ onClose }: { onClose: () => void }) {
  const markets = useMarkets();
  const devnets = useDevnets();
  const nav = useNavigate();
  const { start: startTour } = useTour();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const vaulted = useMemo(() => new Set((devnets ?? []).map(d => d.symbol)), [devnets]);

  const rows = useMemo(() => {
    const query = q.trim().toLowerCase();
    const assets: Row[] = (markets.data?.assets ?? []).map(a => ({
      key: `a:${a.symbol}`, to: `/markets/${encodeURIComponent(a.symbol)}`, title: a.symbol,
      sub: a.name === a.symbol ? (a.kind === 'private' ? 'Pre-IPO' : 'Tokenized equity') : a.name,
      symbol: a.symbol, kind: a.kind === 'private' ? 'preipo' : 'equity',
      badge: vaulted.has(a.symbol) ? 'Devnet vault' : undefined,
      rank: query ? score(query, [a.symbol.replace(/x$/, ''), a.name, a.mint ?? '']) : 1,
    }));
    const pages: Row[] = PAGES.map(p => ({ ...p, rank: query ? score(query, [p.title, p.sub]) : 1 }));
    if (!query) return [...assets.filter(a => a.badge), ...pages, ...assets.filter(a => !a.badge)].slice(0, 40);
    return [...assets, ...pages].filter(r => r.rank > 0).sort((a, b) => b.rank - a.rank).slice(0, 20);
  }, [q, markets.data, vaulted]);

  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const go = (r: Row | undefined) => { if (!r) return; onClose(); if (r.tour) startTour(); else nav(r.to); };

  return (
    <div className={s.wrap}>
      <div className={s.field}>
        <Icon name="search" size={16} />
        <input
          className={s.input} autoFocus value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search a ticker, company or mint…" aria-label="Search markets and pages"
          role="combobox" aria-expanded="true" aria-controls="palette-list"
          aria-activedescendant={rows[sel] ? `pal-${sel}` : undefined}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel(i => Math.min(rows.length - 1, i + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(i => Math.max(0, i - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); go(rows[sel]); }
          }}
        />
        <kbd className={s.kbd}>esc</kbd>
      </div>
      <ul className={s.list} id="palette-list" role="listbox" ref={listRef} aria-label="Results">
        {rows.length === 0 && <li className={s.empty}>Nothing matches “{q}”. Try a ticker like NVDA or a company like NVIDIA.</li>}
        {rows.map((r, i) => (
          <li
            key={r.key} id={`pal-${i}`} data-i={i} role="option" aria-selected={i === sel}
            className={s.row} onMouseEnter={() => setSel(i)} onClick={() => go(r)}
          >
            {r.symbol ? <AssetAvatar symbol={r.symbol} kind={r.kind} size="sm" /> : <span className={s.pageIcon}><Icon name={r.icon!} size={15} /></span>}
            <span className={s.rowText}>
              <span className={s.rowTitle} data-asset={r.symbol ? true : undefined}>{r.title}</span>
              <span className={s.rowSub}>{r.sub}</span>
            </span>
            {r.badge && <span className={s.badge}>{r.badge}</span>}
            <Icon name="chevronRight" size={14} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PaletteProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable="true"]');
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen(o => !o); }
      else if (e.key === '/' && !typing) { e.preventDefault(); setOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <Ctx.Provider value={{ open: show }}>
      {children}
      <Sheet open={open} onClose={() => setOpen(false)} kind="dialog" labelledBy="palette-title">
        <h2 id="palette-title" className="sr-only">Search</h2>
        <Palette onClose={() => setOpen(false)} />
      </Sheet>
    </Ctx.Provider>
  );
}
