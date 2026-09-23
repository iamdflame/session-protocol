/* ───────────────────────────────────────────────────────────────────────────
   Markets — the explorer.

   Every listed name shares one bell, so the table leads with the session they
   are all in and then lets them differ on what they actually differ on: price,
   the last 24 hours, and how each session has treated them. Pre-IPO names
   have no exchange session at all; they get their own rail rather than a
   countdown to a bell they do not trade on.

   Search, filter and sort live in the URL, so a filtered view is a link.
   ─────────────────────────────────────────────────────────────────────────── */

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMarkets, useQuotes, load, type Asset, type CurveFile, type CurvePoint } from '@/lib/data';
import { useDevnets } from '@/lib/chain';
import { useSession } from '@/lib/session';
import { SESSION_EVENT } from '@sdk/vault.ts';
import { MarketTable, type SortKey, type VaultInfo } from '@/components/markets/MarketTable';
import { Census } from '@/components/Census';
import { MiniRail } from '@/components/session/SessionRail';
import { Segmented } from '@/components/ui/Segmented';
import { Source } from '@/components/ui/Source';
import { Countdown } from '@/components/ui/Figures';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import s from './Markets.module.css';

type Filter = 'all' | 'equity' | 'etf' | 'preipo' | 'vaults' | 'favorites';
const FILTERS: Filter[] = ['all', 'equity', 'etf', 'preipo', 'vaults', 'favorites'];
const SORTS: { key: SortKey; label: string }[] = [
  { key: 'liquidity', label: 'Deepest pool' },
  { key: 'change', label: '24h change' },
  { key: 'gap', label: 'Widest DAY/NIGHT gap' },
  { key: 'day', label: 'DAY return' },
  { key: 'night', label: 'NIGHT return' },
  { key: 'price', label: 'Price' },
  { key: 'symbol', label: 'Ticker, A–Z' },
];

const FAV_KEY = 'session.favorites';
function useFavorites(): [Set<string>, (sym: string) => void] {
  const [favs, setFavs] = useState<Set<string>>(new Set());
  useEffect(() => {
    try { setFavs(new Set(JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]'))); } catch { /* blocked storage */ }
  }, []);
  const toggle = (sym: string) => setFavs(prev => {
    const next = new Set(prev);
    if (next.has(sym)) next.delete(sym); else next.add(sym);
    try { localStorage.setItem(FAV_KEY, JSON.stringify([...next])); } catch { /* not worth failing over */ }
    return next;
  });
  return [favs, toggle];
}

/* The one sentence about the market as a whole. `data-holder` is read by the
   flow harness to check it agrees with the chip in the top bar. */
function MarketState({ onBell }: { onBell: number }) {
  const sess = useSession();
  if (!sess) return <div className="skeleton" style={{ height: 20, width: 420 }} />;
  const cls = sess.holder.toLowerCase();
  return (
    <div className={s.state}>
      <span className={s.stateDot} data-cls={cls} aria-hidden="true" />
      <p className={s.stateText}>
        <strong data-holder={cls} className={cls === 'day' ? 'day-ink' : 'night-ink'}>{sess.holder}</strong> is carrying every
        listed name. {onBell === 1 ? 'The one vault on this clock hands over' : `All ${onBell} vaults on this clock hand over`} in{' '}
        <Countdown seconds={sess.until} className={s.stateClock} />.
      </p>
      <MiniRail />
    </div>
  );
}

export default function Markets() {
  const markets = useMarkets();
  const devnets = useDevnets();
  const [params, setParams] = useSearchParams();
  const [favs, toggleFav] = useFavorites();
  const [curves, setCurves] = useState<Record<string, CurvePoint[]>>({});

  const q = params.get('q') ?? '';
  const filter = (FILTERS.includes(params.get('f') as Filter) ? params.get('f') : 'all') as Filter;
  const sort = (SORTS.some(x => x.key === params.get('sort')) ? params.get('sort') : 'liquidity') as SortKey;
  const set = (k: string, v: string, fallback: string) => {
    const next = new URLSearchParams(params);
    if (!v || v === fallback) next.delete(k); else next.set(k, v);
    setParams(next, { replace: true });
  };

  const assets = markets.data?.assets ?? [];
  const mints = useMemo(() => assets.map(a => a.mint).filter(Boolean), [assets]);
  const { quotes, stale, settled } = useQuotes(mints);
  const noQuotes = settled && Object.keys(quotes).length === 0;
  const newestQuote = Math.max(0, ...Object.values(quotes).map(x => x.at));

  const vaults = useMemo(() => new Map<string, VaultInfo>((devnets ?? []).map(d => [
    d.symbol, { kind: d.sessionKind === SESSION_EVENT ? 'event' : 'devnet' },
  ])), [devnets]);
  const pageForVault = useMemo(() => new Map((devnets ?? []).map(v => [v.vault, v.symbol])), [devnets]);
  const onBell = (devnets ?? []).filter(d => d.sessionKind !== SESSION_EVENT).length;

  // Sparklines land after the table is readable, not before it.
  useEffect(() => {
    let on = true;
    for (const a of assets) {
      load<CurveFile>(`/data/curves/${encodeURIComponent(a.symbol)}.json`)
        .then(c => { if (on) setCurves(p => ({ ...p, [c.symbol]: c.points })); })
        .catch(() => { /* a missing sparkline is not an error state */ });
    }
    return () => { on = false; };
  }, [assets]);

  const count = (f: Filter) => assets.filter(a => matches(a, f)).length;
  function matches(a: Asset, f: Filter) {
    switch (f) {
      case 'equity': return a.category === 'equity';
      case 'etf': return a.category === 'etf';
      case 'preipo': return a.category === 'preipo';
      case 'vaults': return vaults.has(a.symbol);
      case 'favorites': return favs.has(a.symbol);
      default: return true;
    }
  }

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/x$/, '');
    const hit = (a: Asset) => !needle || [a.symbol, a.name, a.mint].some(v => v?.toLowerCase().includes(needle));
    const price = (a: Asset) => quotes[a.mint]?.price ?? a.price;
    const gap = (a: Asset) => Math.abs((a.night?.cumulative ?? 0) - (a.day?.cumulative ?? 0));
    const out = assets.filter(a => matches(a, filter) && hit(a));
    out.sort((a, b) => {
      switch (sort) {
        case 'symbol': return a.symbol.localeCompare(b.symbol);
        case 'price': return price(b) - price(a);
        // The same figure the cell shows: Jupiter's live change, else the study's.
        case 'change': return (quotes[b.mint]?.change24h ?? b.change24h ?? -Infinity) - (quotes[a.mint]?.change24h ?? a.change24h ?? -Infinity);
        case 'day': return (b.day?.cumulative ?? -Infinity) - (a.day?.cumulative ?? -Infinity);
        case 'night': return (b.night?.cumulative ?? -Infinity) - (a.night?.cumulative ?? -Infinity);
        case 'gap': return gap(b) - gap(a);
        default: return b.liquidity - a.liquidity;
      }
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, filter, sort, q, quotes, favs, vaults]);

  const listed = rows.filter(a => a.category !== 'preipo');
  const events = rows.filter(a => a.category === 'preipo');

  return (
    <div className={s.page}>
      <header className={s.head}>
        <div>
          <h1 className={`display ${s.title}`}>Markets</h1>
          <p className={s.sub}>
            {assets.length || 26} tokenized assets. Live prices, and the DAY and NIGHT sessions measured apart.
          </p>
        </div>
        <MarketState onBell={onBell} />
      </header>

      <div className={s.toolbar} role="search">
        <label className={s.search}>
          <Icon name="search" size={15} />
          <span className="sr-only">Filter markets</span>
          <input
            value={q} onChange={e => set('q', e.target.value, '')}
            placeholder="Ticker, company or mint" spellCheck={false} autoComplete="off"
            onKeyDown={e => { if (e.key === 'Escape') set('q', '', ''); }}
          />
          {q && <button className={s.clear} onClick={() => set('q', '', '')} aria-label="Clear filter"><Icon name="close" size={13} /></button>}
        </label>

        <div className={s.filters}>
          <Segmented<Filter>
            label="Filter by kind"
            value={filter}
            onChange={v => set('f', v, 'all')}
            items={[
              { value: 'all', label: 'All', count: assets.length },
              { value: 'equity', label: 'Equities', count: count('equity') },
              { value: 'etf', label: 'ETFs', count: count('etf') },
              { value: 'preipo', label: 'Pre-IPO', count: count('preipo') },
              { value: 'vaults', label: 'Vaults', count: count('vaults'), hint: 'Names with a vault on chain (devnet)' },
              { value: 'favorites', label: <><Icon name="star" size={12} /> Favorites</>, count: favs.size },
            ]}
          />
        </div>

        <label className={s.sort}>
          <span className={s.sortLabel}>Sort</span>
          <select value={sort} onChange={e => set('sort', e.target.value, 'liquidity')}>
            {SORTS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
          <Icon name="chevronDown" size={13} />
        </label>

        <span className={s.src}>
          <Source kind="jupiter" detail="Live prices from Jupiter, polled every 20 seconds" ageSec={newestQuote ? Math.floor(Date.now() / 1000) - newestQuote : null} staleAfter={60} />
          {noQuotes ? <span className={s.stale} role="status">Live prices unavailable — showing last closes</span>
            : stale ? <span className={s.stale} role="status">Live prices stalled — figures may be a minute old</span> : null}
        </span>
      </div>

      <Census pages={pageForVault} />

      {markets.status === 'loading' ? (
        <div className={s.skel}>{Array.from({ length: 8 }, (_, i) => <div key={i} className="skeleton" style={{ height: 46 }} />)}</div>
      ) : markets.status === 'error' ? (
        <div className={s.empty}>
          <p className={s.emptyTitle}>The market list did not load.</p>
          <p className={s.emptyBody}>Nothing below would be current, so nothing is shown. The data comes from this site&rsquo;s own build, so a reload usually fixes it.</p>
          <Button variant="secondary" onClick={() => window.location.reload()}>Reload</Button>
        </div>
      ) : rows.length === 0 ? (
        <div className={s.empty}>
          {filter === 'favorites' && !q ? (
            <>
              <p className={s.emptyTitle}>No favorites yet.</p>
              <p className={s.emptyBody}>Star a market to keep it here. Favorites live in this browser only.</p>
              <Button variant="secondary" onClick={() => set('f', 'all', 'all')}>Browse markets</Button>
            </>
          ) : (
            <>
              <p className={s.emptyTitle}>Nothing matches “{q}”.</p>
              <p className={s.emptyBody}>Try a ticker like NVDA, a company like Tesla, or paste a mint.</p>
              <Button variant="secondary" onClick={() => { const n = new URLSearchParams(); setParams(n, { replace: true }); }}>Clear filters</Button>
            </>
          )}
        </div>
      ) : (
        <>
          {listed.length > 0 && (
            <section className={s.block} aria-labelledby="listed-h">
              <div className={s.blockHead}>
                <h2 id="listed-h" className={s.h2}>Listed names</h2>
                <p className={s.blockSub}>One bell for all of them: 09:30 and 16:00 ET, from the calendar the program settles on.</p>
              </div>
              <MarketTable
                assets={listed} quotes={quotes} quotesSettled={settled && !noQuotes} curves={curves} vaults={vaults}
                favorites={favs} onFavorite={toggleFav}
                sort={sort} onSort={k => set('sort', k, 'liquidity')}
                caption="Listed tokenized equities and funds, with live price and measured DAY and NIGHT returns"
              />
            </section>
          )}
          {events.length > 0 && (
            <section className={s.block} aria-labelledby="events-h">
              <div className={s.blockHead}>
                <h2 id="events-h" className={s.h2}>Pre-IPO · no exchange session</h2>
                <p className={s.blockSub}>
                  Private companies have no 09:30 and no close. Their boundary is the next print, or the moment the
                  token&rsquo;s price runs from the issuer&rsquo;s mark. <Link to="/markets/OPENAI">How OPENAI settles</Link>
                </p>
              </div>
              <MarketTable
                assets={events} quotes={quotes} quotesSettled={settled && !noQuotes} curves={curves} vaults={vaults}
                favorites={favs} onFavorite={toggleFav}
                sort={sort} onSort={k => set('sort', k, 'liquidity')}
                caption="Pre-IPO tokens, with live price and measured returns"
              />
            </section>
          )}
        </>
      )}

      <p className={s.foot}>
        DAY and NIGHT columns are each session compounded over the study window, measured from real Solana pool history —
        not a quote for a class. Only names marked <span className={s.vaultWord}>devnet vault</span> have a vault on chain; the
        rest run the same settlement in your browser. <Link to="/list">Open a vault</Link>
      </p>
    </div>
  );
}
