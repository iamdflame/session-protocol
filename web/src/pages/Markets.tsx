import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { SessionClock } from '@/components/SessionClock';
import { Spark } from '@/components/charts/Spark';
import { PreLaunch } from '@/components/PreLaunch';
import { useSession, useClockSize, countdown } from '@/lib/session';
import { useDevnets } from '@/lib/chain';
import {
  useMarkets, useQuotes, load, fmtUsd, fmtCompact, fmtPct,
  type Asset, type CurveFile, type CurvePoint,
} from '@/lib/data';
import s from './Markets.module.css';

type Filter = 'all' | 'public' | 'private';
type SortKey = 'liquidity' | 'symbol' | 'spread' | 'price';

const FILTERS: { key: Filter; label: string; hint: string }[] = [
  { key: 'all', label: 'All', hint: 'Every asset with enough history to decompose' },
  { key: 'public', label: 'Public', hint: 'Tokenized shares of companies trading on a US exchange' },
  { key: 'private', label: 'Pre-IPO', hint: 'Private companies — no NYSE session to arbitrage against' },
];

/**
 * The only live sentence on this page.
 *
 * `useSession` ticks every second, so it lives in the leaf that shows the
 * time. At the page root it re-rendered twenty-six rows and twenty-six
 * sparklines once a second to move a countdown.
 */
function LiveLead() {
  const sess = useSession();
  if (!sess) {
    return (
      <p className={`lead ${s.lead}`}>
        Both classes of every vault, priced live, with the session each one is earning.
      </p>
    );
  }
  return (
    <p className={`lead ${s.lead}`}>
      <strong className={s.holderInline} data-holder={sess.holder.toLowerCase()}>
        {sess.holder}
      </strong>{' '}
      is carrying the exposure across all of these right now.
      In {countdown(sess.until)} every vault hands over at once — the
      boundary is the same bell for all of them.
    </p>
  );
}

export default function Markets() {
  const markets = useMarkets();
  const allVaults = useDevnets();
  // Which names have a vault at all. The table used to know about one, which
  // was true until there were two, and a row showing no status is a row a
  // reader has to guess about.
  //
  // This page used to poll the vault account every twenty seconds to fill a
  // prop no cell ever read. On a rate-limited endpoint that is a request
  // taken from whoever is trying to mint.
  const listed = useMemo(() => new Set((allVaults ?? []).map(v => v.symbol)), [allVaults]);
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<SortKey>('liquidity');
  const [curves, setCurves] = useState<Record<string, CurvePoint[]>>({});
  const clockSize = useClockSize(188, 72);

  const assets = markets.data?.assets ?? [];
  const mints = useMemo(() => assets.map(a => a.mint).filter(Boolean), [assets]);
  const { quotes, error: quoteError, stale } = useQuotes(mints);

  // Sparklines come from the per-asset curve files. Fetched after the table is
  // already on screen and drawn in as they land, because a table of numbers a
  // reader can use now beats a complete table a second later.
  useEffect(() => {
    let live = true;
    for (const a of assets) {
      load<CurveFile>(`/data/curves/${encodeURIComponent(a.symbol)}.json`)
        .then(c => { if (live) setCurves(prev => ({ ...prev, [c.symbol]: c.points })); })
        .catch(() => { /* a missing sparkline is not worth an error state */ });
    }
    return () => { live = false; };
  }, [assets]);

  const rows = useMemo(() => {
    const out = assets.filter(a => filter === 'all' || a.kind === filter);
    const spread = (a: Asset) => a.endNight - a.endDay;
    out.sort((a, b) => {
      switch (sort) {
        case 'symbol': return a.symbol.localeCompare(b.symbol);
        case 'spread': return Math.abs(spread(b)) - Math.abs(spread(a));
        case 'price': return (quotes[b.mint]?.price ?? b.price) - (quotes[a.mint]?.price ?? a.price);
        default: return b.liquidity - a.liquidity;
      }
    });
    return out;
  }, [assets, filter, sort, quotes]);

  return (
    <div className={s.page}>
      <header className={`shell ${s.head}`}>
        <div className={s.headCopy}>
          <p className="eyebrow">Markets</p>
          <h1 className={`display ${s.title}`}>Every vault, and who holds it.</h1>
          <LiveLead />
        </div>
        <SessionClock size={clockSize} compact />
      </header>

      <PreLaunch />

      <div className={`shell ${s.controls}`}>
        <div className={s.filters} role="group" aria-label="Filter by asset type">
          {FILTERS.map(f => (
            <button
              key={f.key}
              className={s.filter}
              data-on={filter === f.key}
              onClick={() => setFilter(f.key)}
              title={f.hint}
              aria-pressed={filter === f.key}
            >
              {f.label}
              <span className={`num ${s.filterCount}`}>
                {f.key === 'all' ? assets.length : assets.filter(a => a.kind === f.key).length}
              </span>
            </button>
          ))}
        </div>

        <label className={s.sort}>
          <span className="sr-only">Sort by</span>
          <select value={sort} onChange={e => setSort(e.target.value as SortKey)}>
            <option value="liquidity">Deepest pool</option>
            <option value="spread">Widest night–day gap</option>
            <option value="price">Highest price</option>
            <option value="symbol">Symbol, A–Z</option>
          </select>
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M4 6.5 8 10.5l4-4" fill="none" stroke="currentColor"
                  strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </label>

        <p className={s.quoteState} data-stale={stale} data-error={!!quoteError && !Object.keys(quotes).length}>
          {quoteError && !Object.keys(quotes).length
            ? <>Live quotes unavailable · showing last measured price</>
            : stale
              ? <>Quotes stale · last good fill over a minute ago</>
              : Object.keys(quotes).length
                ? <><span className={s.liveDot} aria-hidden="true" />Live from Jupiter</>
                : <>Fetching live quotes…</>}
        </p>
      </div>

      <div className="shell">
        {markets.status === 'error' ? (
          <div className={s.error} role="alert">
            <h2>The market index could not be loaded.</h2>
            <p>
              Nothing on this page is live without it. The file is static, so a
              reload almost always fixes it.
            </p>
            <button className={s.retry} onClick={() => window.location.reload()}>Reload</button>
          </div>
        ) : markets.status === 'loading' ? (
          <Skeleton />
        ) : rows.length === 0 ? (
          <div className={s.empty}>
            <p>No assets match that filter.</p>
            <button className={s.retry} onClick={() => setFilter('all')}>Show all {assets.length}</button>
          </div>
        ) : (
          <Table rows={rows} quotes={quotes} curves={curves} listed={listed} />
        )}
      </div>

      <footer className={`shell ${s.noteWrap}`}>
        <p className={s.note}>
          Prices are the median across every Solana pool holding the asset, not a
          single venue&rsquo;s quote — for the thinner names those disagree by more
          than the spread being measured. Night and day figures are measured over{' '}
          {markets.data ? Math.round(Math.max(...markets.data.assets.map(a => a.days))) : '—'} days
          of real pool history, decomposed through the same calendar the program settles on.
        </p>
      </footer>
    </div>
  );
}

/* ── the table ───────────────────────────────────────────────────────────── */

function Table({
  rows, quotes, curves, listed,
}: {
  rows: Asset[];
  quotes: Record<string, { price: number; at: number }>;
  curves: Record<string, CurvePoint[]>;
  /** Every symbol with a vault on chain. The rest are simulations and say so. */
  listed: Set<string>;
}) {
  return (
    <div className={s.tableWrap}>
      <table className={s.table}>
        <caption className="sr-only">
          Tokenized assets, with the cumulative return earned in each session.
        </caption>
        <thead>
          <tr>
            <th scope="col">Asset</th>
            <th scope="col" className={s.right}>Price</th>
            <th scope="col" className={s.right}>NIGHT</th>
            <th scope="col" className={s.right}>DAY</th>
            <th scope="col" className={`${s.right} ${s.gap}`} title="Cumulative night return minus cumulative day return">
              Night − Day
            </th>
            <th scope="col" className={s.sparkCol}>Since inception</th>
            <th scope="col" className={`${s.right} ${s.pool}`}>Pool</th>
            <th scope="col" className={s.open}><span className="sr-only">Open</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(a => {
            const q = quotes[a.mint];
            const gap = a.endNight - a.endDay;
            const onChain = listed.has(a.symbol);
            return (
              <tr key={a.symbol} data-live={onChain}>
                <th scope="row" className={s.asset}>
                  <Link to={`/markets/${encodeURIComponent(a.symbol)}`} className={s.assetLink}>
                    <span className={s.symbolRow}>
                      <span className={`mono ${s.symbol}`}>{a.symbol}</span>
                      {a.kind === 'private' && <span className={s.tag}>pre-IPO</span>}
                      {onChain
                        ? <span className={s.liveTag}><span className={s.liveTagDot} aria-hidden="true" />devnet</span>
                        : <span className={s.simTag} title="No vault. This page runs the settlement code in your browser.">simulated</span>}
                    </span>
                    <span className={s.name}>{a.name}</span>
                  </Link>
                </th>

                <td className={`num ${s.right}`}>
                  <span className={s.price} data-live={!!q}>
                    {fmtUsd(q?.price ?? a.price)}
                  </span>
                </td>

                <td className={`num ${s.right}`}>
                  <span className={s.nav} data-series="night" data-sign={a.endNight >= 1 ? 'up' : 'down'}>
                    {fmtPct(a.endNight - 1, 1)}
                  </span>
                </td>

                <td className={`num ${s.right}`}>
                  <span className={s.nav} data-series="day" data-sign={a.endDay >= 1 ? 'up' : 'down'}>
                    {fmtPct(a.endDay - 1, 1)}
                  </span>
                </td>

                {/* Signed, so which session ran ahead survives without colour —
                    positive means the night did. */}
                <td className={`num ${s.right} ${s.gap}`} data-wider={gap >= 0 ? 'night' : 'day'}>
                  {gap >= 0 ? '+' : '−'}{(Math.abs(gap) * 100).toFixed(1)}
                  <span className={s.gapUnit}>pts</span>
                </td>

                <td className={s.sparkCol}>
                  {curves[a.symbol]
                    ? <Spark points={curves[a.symbol]} />
                    : <div className="skeleton" style={{ width: 92, height: 28 }} />}
                </td>

                <td className={`num ${s.right} ${s.pool}`}>{fmtCompact(a.liquidity)}</td>

                <td className={s.open}>
                  <Link to={`/markets/${encodeURIComponent(a.symbol)}`} aria-label={`Open the ${a.symbol} vault`}>
                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                      <path d="M3 8h9M8.5 4 12.5 8l-4 4" fill="none" stroke="currentColor"
                            strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Skeleton() {
  return (
    <div className={s.tableWrap} aria-busy="true">
      <div className={s.skelHead} />
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} className={s.skelRow} style={{ opacity: 1 - i * 0.07 }}>
          <div className="skeleton" style={{ width: 132, height: 14 }} />
          <div className="skeleton" style={{ width: 72, height: 14 }} />
          <div className="skeleton" style={{ width: 56, height: 14 }} />
          <div className="skeleton" style={{ width: 56, height: 14 }} />
          <div className="skeleton" style={{ width: 92, height: 28 }} />
        </div>
      ))}
      <span className="sr-only">Loading markets</span>
    </div>
  );
}
