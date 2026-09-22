import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CurveChart } from '@/components/charts/CurveChart';
import { SessionClock } from '@/components/SessionClock';
import { NotListed } from '@/components/NotListed';
import { Trade } from '@/components/Trade';
import { HealthPanel } from '@/components/HealthPanel';
import { ChainVault } from '@/components/ChainVault';
import { useDevnetVaultFor, useDevnets } from '@/lib/chain';
import { useSession, useClockSize, countdown, etClock, etDate, Session } from '@/lib/session';
import { sessionAt } from '@sdk/calendar.ts';
import { useCurve, useMarkets, useQuotes, fmtUsd, fmtPct, type Asset } from '@/lib/data';
import {
  advance, derive, freshVault, loadVault, saveVault, clearVault, markFromPrice,
  fromQuote, fromShares, navToNumber,
  type LocalVault, type ShareClass,
} from '@/lib/localVault';
import s from './Vault.module.css';


/**
 * What to do with an empty vault.
 *
 * Every figure on a fresh vault is zero, which is true and unhelpful. This
 * says which class is open right now, and what the next bell will do with a
 * position opened in it — both read from the calendar, not written here.
 */
function EmptyHint({ symbol, parked }: { symbol: string; parked: ShareClass }) {
  const sess = useSession();
  if (!sess) return null;
  const opensInto = parked === 'day' ? 'the regular session' : 'the overnight stretch';
  return (
    <div className={`shell ${s.emptyWrap}`}>
      <p className={s.empty} role="note">
        <strong>Nothing minted in this browser yet.</strong>{' '}
        <span className="mono" data-class={parked}>{symbol}.{parked.toUpperCase()}</span> is
        the class that is open — it is parked in quote until the bell in{' '}
        <span className="num">{countdown(sess.until)}</span>, when the vault hands it the
        stock for {opensInto}. Mint into it below to watch that happen.
      </p>
    </div>
  );
}

/** The one line on this page that ticks. Kept out of the page root so the
    chart, the ledger and both class cards are not reconciled every second. */
function ClockNote({ exposed }: { exposed: ShareClass }) {
  const sess = useSession();
  if (!sess) return <p className={s.clockNote}>Reading the session clock…</p>;
  return (
    <p className={s.clockNote}>
      <strong data-holder={exposed}>{exposed.toUpperCase()}</strong> holds this
      vault&rsquo;s stock. Handover in <span className="num">{countdown(sess.until)}</span>.
    </p>
  );
}

export default function Vault({ symbol: forced }: { symbol?: string } = {}) {
  const params = useParams();
  const symbol = forced ?? params.symbol ?? '';
  const markets = useMarkets();
  const curve = useCurve(symbol);

  const asset: Asset | undefined = markets.data?.assets.find(a => a.symbol === symbol);
  const { quotes, stale } = useQuotes(asset ? [asset.mint] : []);
  const live = asset ? quotes[asset.mint]?.price : undefined;
  const price = live ?? asset?.price ?? 0;

  const [vault, setVault] = useState<LocalVault | null>(null);
  const clockSize = useClockSize(196, 72);
  // undefined while the manifest loads; null when this symbol has no vault on chain.
  const devnet = useDevnetVaultFor(symbol);
  const allVaults = useDevnets();

  // Restore or open the vault, then run every boundary it slept through. A
  // browser that was closed over a weekend comes back to three settlements,
  // not to a stale screen.
  useEffect(() => {
    if (!asset || !price) return;
    const now = Math.floor(Date.now() / 1000);
    const stored = loadVault(asset.symbol);
    const base = stored ?? freshVault(asset.symbol, asset.decimals, price, now);
    const caught = advance(base, markFromPrice(price, asset.decimals), now);
    setVault(caught);
    if (caught !== base || !stored) saveVault(caught);
  }, [asset, price]);

  const commit = useCallback((next: LocalVault) => {
    setVault(next);
    saveVault(next);
  }, []);

  const reset = useCallback(() => {
    if (!asset || !price) return;
    clearVault(asset.symbol);
    const fresh = freshVault(asset.symbol, asset.decimals, price, Math.floor(Date.now() / 1000));
    setVault(fresh);
    saveVault(fresh);
  }, [asset, price]);

  const d = useMemo(
    () => (vault && asset && price
      ? derive(vault, markFromPrice(price, asset.decimals), Math.floor(Date.now() / 1000))
      : null),
    [vault, asset, price],
  );

  /* ── states before the vault exists ──────────────────────────────────── */

  if (markets.status === 'loading') return <VaultSkeleton />;

  if (markets.status === 'error') {
    return (
      <div className={`shell ${s.gate}`}>
        <p className="eyebrow">Unavailable</p>
        <h1 className={`display ${s.gateTitle}`}>The market index did not load.</h1>
        <p className={`lead ${s.gateBody}`}>
          Without it there is no way to know what this symbol is worth, and a
          vault page that guesses is worse than one that stops.
        </p>
        <div className={s.gateActions}>
          <button className={s.primary} onClick={() => window.location.reload()}>Reload</button>
          <Link to="/markets" className={s.secondary}>Back to markets</Link>
        </div>
      </div>
    );
  }

  if (!asset) {
    return (
      <div className={`shell ${s.gate}`}>
        <p className="eyebrow">Not found</p>
        <h1 className={`display ${s.gateTitle}`}>No vault for “{symbol}”.</h1>
        <p className={`lead ${s.gateBody}`}>
          {markets.data?.assets.length ?? 0} assets have enough pool history to
          decompose into a session pair. This is not one of them.
        </p>
        <div className={s.gateActions}>
          <Link to="/markets" className={s.primary}>See every vault</Link>
        </div>
      </div>
    );
  }

  // A symbol with a real vault on devnet renders the on-chain page instead of
  // the local simulation. Everything below this line is the simulation.
  if (devnet) return <ChainVault m={devnet} asset={asset} />;

  const exposed = vault?.exposed ?? (sessionAt(Math.floor(Date.now() / 1000)) === Session.Open ? 'day' : 'night');

  return (
    <div className={s.page}>
      {/* ── header ──────────────────────────────────────────────────────── */}
      <header className={`shell ${s.head}`}>
        <div className={s.crumbs}>
          <Link to="/markets">Markets</Link>
          <span aria-hidden="true">/</span>
          <span className="mono">{asset.symbol}</span>
        </div>

        <div className={s.headMain}>
          <div className={s.identity}>
            <h1 className={`mono ${s.symbol}`}>{asset.symbol}</h1>
            <p className={s.name}>
              {asset.name}
              {asset.kind === 'private' && <span className={s.tag}>pre-IPO</span>}
            </p>

            <div className={s.priceRow}>
              <span className={`num ${s.price}`}>{fmtUsd(price)}</span>
              <span className={s.priceMeta} data-stale={stale} data-live={!!live}>
                {stale ? 'quote stale'
                  : live ? 'live · Jupiter'
                  : 'last measured'}
              </span>
            </div>

            <dl className={s.quickFacts}>
              <div>
                <dt>Pool depth</dt>
                <dd className="num">{fmtUsd(asset.liquidity, 0)}</dd>
              </div>
              <div>
                <dt>Measured over</dt>
                <dd className="num">{Math.round(asset.days)} days</dd>
              </div>
              <div>
                <dt>Sessions</dt>
                <dd className="num">{asset.sessions.nights + asset.sessions.days}</dd>
              </div>
            </dl>
          </div>

          <div className={s.clockCol}>
            <SessionClock size={clockSize} compact />
            <ClockNote exposed={exposed} />
          </div>
        </div>
      </header>

      <NotListed symbol={asset.symbol} liveSymbols={(allVaults ?? []).map(v => v.symbol)} />


      {/* ── the two classes ─────────────────────────────────────────────── */}
      <section className={`shell ${s.classes}`} aria-label="Share classes">
        {(['night', 'day'] as ShareClass[]).map(c => {
          const nav = vault ? navToNumber(c === 'night' ? vault.nightNav : vault.dayNav) : 1;
          const supply = vault ? fromShares(c === 'night' ? vault.nightSupply : vault.daySupply) : 0;
          const mine = vault ? fromShares(c === 'night' ? vault.myNight : vault.myDay) : 0;
          const value = d ? fromQuote(c === 'night' ? d.valueNight : d.valueDay) : 0;
          const isExposed = exposed === c;
          const study = c === 'night' ? asset.night : asset.day;

          return (
            <article key={c} className={s.classCard} data-class={c} data-exposed={isExposed}>
              <header className={s.classHead}>
                <div>
                  <span className={s.classTag}>{asset.symbol}.{c.toUpperCase()}</span>
                  <p className={s.classState}>
                    {isExposed ? 'Holding the stock' : 'Flat — parked in quote'}
                  </p>
                </div>
                <span className={s.classBadge} data-on={isExposed}>
                  {isExposed ? 'exposed' : 'parked'}
                </span>
              </header>

              <div className={s.navRow}>
                <span className={`num ${s.navValue}`}>{nav.toFixed(4)}</span>
                <span className={s.navUnit}>NAV per share</span>
              </div>

              <dl className={s.classStats}>
                <div><dt>Supply</dt><dd className="num">{supply.toLocaleString('en-US', { maximumFractionDigits: 2 })}</dd></div>
                <div><dt>Class value</dt><dd className="num">{fmtUsd(value, 2)}</dd></div>
                <div><dt>You hold</dt><dd className="num" data-mine={mine > 0}>{mine.toLocaleString('en-US', { maximumFractionDigits: 2 })}</dd></div>
              </dl>

              {study && (
                <footer className={s.classStudy}>
                  <span>Measured, {Math.round(asset.days)}d</span>
                  <span className={`num ${s.classCum}`} data-sign={study.cumulative >= 0 ? 'up' : 'down'}>
                    {fmtPct(study.cumulative, 1)}
                  </span>
                  <span className={s.classT}>
                    σ <span className="num">{(study.stdev * 100).toFixed(2)}%</span>
                    {' · '}t <span className="num">{study.t.toFixed(2)}</span>
                  </span>
                </footer>
              )}
            </article>
          );
        })}
      </section>

      {vault && vault.nightSupply === 0n && vault.daySupply === 0n && (
        <EmptyHint symbol={asset.symbol} parked={exposed === 'night' ? 'day' : 'night'} />
      )}

      {/* ── chart + trade ───────────────────────────────────────────────── */}
      <section className={`shell ${s.body}`}>
        <div className={`card ${s.chartCard}`}>
          <header className={s.cardHead}>
            <div>
              <h2 className={s.cardTitle}>Decomposed since inception</h2>
              <p className={s.cardSub}>
                Each series compounds only the returns earned inside its own
                session. The vertical gap is what owning one instead of the other
                would have been worth.
              </p>
            </div>
          </header>
          {curve.status === 'ready' ? (
            <CurveChart points={curve.data.points} height={330}
                        label={`${asset.symbol}, night versus day cumulative return`} />
          ) : curve.status === 'error' ? (
            <p className={s.cardError}>
              The history for {asset.symbol} could not be loaded. Everything else
              on this page is unaffected.
            </p>
          ) : (
            <div className="skeleton" style={{ width: '100%', height: 330 }} />
          )}
        </div>

        <div className={s.side}>
          {vault && d ? (
            <Trade vault={vault} price={price} onCommit={commit} />
          ) : (
            <div className={`card ${s.tradeSkeleton}`} aria-busy="true">
              <div className="skeleton" style={{ width: '60%', height: 16 }} />
              <div className="skeleton" style={{ width: '100%', height: 44 }} />
              <div className="skeleton" style={{ width: '100%', height: 96 }} />
              <div className="skeleton" style={{ width: '100%', height: 44 }} />
            </div>
          )}

          {vault && d && <HealthPanel vault={vault} derived={d} onReset={reset} />}
        </div>
      </section>

      {/* ── activity ────────────────────────────────────────────────────── */}
      {vault && vault.history.length > 0 && (
        <section className={`shell ${s.activity}`}>
          <h2 className={s.cardTitle}>This vault&rsquo;s ledger</h2>
          <p className={s.cardSub}>
            Every boundary it has settled and every operation you have run, in
            order. Settlements are produced by the same <code className="mono">settle()</code>{' '}
            the program calls.
          </p>
          <ol className={s.events}>
            {vault.history.map((e, i) => (
              <li key={`${e.ts}-${i}`} className={s.event} data-kind={e.kind}>
                <span className={s.eventKind}>{e.kind}</span>
                <span className={s.eventWhen}>
                  <span className="num">{etClock(e.ts)}</span>
                  <span className={s.eventDate}>{etDate(e.ts)}</span>
                </span>
                <span className={s.eventDetail}>
                  {e.kind === 'settle' ? (
                    <>
                      NAV <span className="num">{navToNumber(e.nightNav).toFixed(4)}</span>
                      {' / '}
                      <span className="num">{navToNumber(e.dayNav).toFixed(4)}</span>
                      {e.funding !== undefined && e.funding !== 0n && (
                        <span className={s.eventFunding}>
                          funding {e.funding > 0n ? 'night→day' : 'day→night'}{' '}
                          <span className="num">{fmtUsd(Math.abs(fromQuote(e.funding)), 2)}</span>
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      <span className={s.eventClass} data-class={e.cls}>{e.cls?.toUpperCase()}</span>
                      <span className="num">{fromShares(e.shares ?? 0n).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
                      {' shares · '}
                      <span className="num">{fmtUsd(fromQuote(e.quote ?? 0n), 2)}</span>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function VaultSkeleton() {
  return (
    <div className={s.page} aria-busy="true">
      <div className={`shell ${s.head}`}>
        <div className="skeleton" style={{ width: 160, height: 12 }} />
        <div style={{ marginTop: 28, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="skeleton" style={{ width: 180, height: 38 }} />
          <div className="skeleton" style={{ width: 120, height: 14 }} />
          <div className="skeleton" style={{ width: 220, height: 30 }} />
        </div>
      </div>
      <div className={`shell ${s.classes}`}>
        <div className="skeleton" style={{ height: 210, borderRadius: 20 }} />
        <div className="skeleton" style={{ height: 210, borderRadius: 20 }} />
      </div>
      <span className="sr-only">Loading vault</span>
    </div>
  );
}
