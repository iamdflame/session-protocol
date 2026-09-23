/* ───────────────────────────────────────────────────────────────────────────
   /markets/:symbol and /trade — the instrument page.

   A symbol with a vault on devnet renders the on-chain page. Every other
   symbol renders the same layout over a simulation: the program's `settle()`
   running in this browser against the token's live price, with balances kept
   in local storage. The simulation is labelled as such on every surface that
   could be mistaken for the real thing, and nothing on it says "confirmed".
   ─────────────────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ChainVault, AssetSkeleton } from '@/components/ChainVault';
import { DemoVault } from '@/components/DemoVault';
import { SESSION_EVENT } from '@sdk/vault.ts';
import { useDevnetVaultFor, useDevnets } from '@/lib/chain';
import { useSessionMinute, etClock } from '@/lib/session';
import { previewLocalBell } from '@/lib/bell';
import { useCurve, useMarkets, useQuotes, type Asset, type Quote } from '@/lib/data';
import {
  advance, derive, freshVault, loadVault, saveVault, clearVault, markFromPrice,
  fromQuote, fromShares, navToNumber, type LocalVault,
} from '@/lib/localVault';
import { CurveChart } from '@/components/charts/CurveChart';
import { SessionPriceChart } from '@/components/charts/SessionPriceChart';
import { fundingFromLocal } from '@/components/FundingRate';
import { ClassPair, type PairState } from '@/components/session/ClassPair';
import { TradePanel, TradeDock, type TradeRequest } from '@/components/trade/TradePanel';
import { useLocalEngine, classStem } from '@/components/trade/engines';
import { AssetHeader } from '@/components/asset/AssetHeader';
import { SessionStrip } from '@/components/asset/SessionStrip';
import { HealthCard } from '@/components/asset/HealthCard';
import { Position } from '@/components/asset/Position';
import { Compare } from '@/components/asset/Compare';
import { LocalActivity } from '@/components/asset/Activity';
import { Signals } from '@/components/asset/ProtocolDetails';
import { Status, ClassTag } from '@/components/ui/Status';
import { Source } from '@/components/ui/Source';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { Icon } from '@/components/ui/Icon';
import s from '@/components/asset/Asset.module.css';

type Cls = 'day' | 'night';
const asCls = (v: string | null): Cls | null => (v === 'day' || v === 'night' ? v : null);

export default function Vault({ symbol: forced, demo = false }: { symbol?: string; demo?: boolean } = {}) {
  const params = useParams();
  const [search] = useSearchParams();
  const symbol = forced ?? params.symbol ?? '';
  const initialClass = asCls(search.get('class'));
  const markets = useMarkets();
  const asset: Asset | undefined = markets.data?.assets.find(a => a.symbol === symbol);
  // undefined while the manifests load; null when this symbol has no vault on chain.
  const devnet = useDevnetVaultFor(symbol);
  const all = useDevnets();

  if (markets.status === 'loading' || (asset && all === undefined)) return <AssetSkeleton symbol={symbol} />;

  if (markets.status === 'error') {
    return (
      <div className={s.gate}>
        <Status kind="stale" label="Unavailable" />
        <h1 className={s.gateTitle}>The market index did not load.</h1>
        <p className={s.gateBody}>
          Without it there is no way to know what {symbol || 'this symbol'} is or what it is worth, and an
          instrument page that guesses is worse than one that stops.
        </p>
        <div className={s.gateActions}>
          <Button onClick={() => window.location.reload()}>Reload</Button>
          <Button variant="secondary" to="/markets">Back to markets</Button>
        </div>
      </div>
    );
  }

  if (!asset) {
    return (
      <div className={s.gate}>
        <Status kind="closed" label="Not found" />
        <h1 className={s.gateTitle}>No market for “{symbol}”.</h1>
        <p className={s.gateBody}>
          {markets.data?.assets.length ?? 0} assets have enough pool history to decompose into a session
          pair. This is not one of them.
        </p>
        <div className={s.gateActions}>
          <Button to="/markets">Browse markets</Button>
        </div>
      </div>
    );
  }

  // A symbol with a real vault on devnet renders the on-chain page — or, in
  // demo mode, a sandbox copy of it. An event vault has no bells to ring, so
  // its demo is the live page itself, which is already safe to read.
  if (devnet && demo && devnet.sessionKind !== SESSION_EVENT) return <DemoVault m={devnet} asset={asset} />;
  if (devnet) return <ChainVault m={devnet} asset={asset} initialClass={initialClass} />;
  return <Simulated asset={asset} liveSymbols={(all ?? []).map(v => v.symbol)} initialClass={initialClass} />;
}

function Simulated({ asset, liveSymbols, initialClass }: { asset: Asset; liveSymbols: string[]; initialClass: Cls | null }) {
  const curve = useCurve(asset.symbol);
  const { quotes, stale, settled: quoteSettled } = useQuotes([asset.mint]);
  const quote = quotes[asset.mint];
  const price = quote?.price ?? asset.price;
  // To the minute: this is the page root, and a per-second clock here would
  // reconcile every chart and card on the page once a second.
  const clock = useSessionMinute();
  const minute = clock?.minute ?? Math.floor(Date.now() / 60_000) * 60;

  const [vault, setVault] = useState<LocalVault | null>(null);
  const [details, setDetails] = useState(false);
  const [dock, setDock] = useState(false);
  const [request, setRequest] = useState<TradeRequest | null>(null);

  // Restore or open the vault, then run every boundary it slept through. A
  // browser that was closed over a weekend comes back to three settlements,
  // not to a stale screen.
  useEffect(() => {
    if (!price) return;
    const now = Math.floor(Date.now() / 1000);
    const stored = loadVault(asset.symbol);
    const base = stored ?? freshVault(asset.symbol, asset.decimals, price, now);
    const caught = advance(base, markFromPrice(price, asset.decimals), now);
    setVault(caught);
    if (caught !== base || !stored) saveVault(caught);
  }, [asset, price]);

  const commit = useCallback((next: LocalVault) => { setVault(next); saveVault(next); }, []);
  const reset = useCallback(() => {
    clearVault(asset.symbol);
    const fresh = freshVault(asset.symbol, asset.decimals, price, Math.floor(Date.now() / 1000));
    setVault(fresh);
    saveVault(fresh);
  }, [asset, price]);

  const d = useMemo(
    () => (vault && price ? derive(vault, markFromPrice(price, asset.decimals), Math.floor(Date.now() / 1000)) : null),
    [vault, asset, price],
  );

  const stem = classStem(asset.symbol);
  const reopens = clock?.next ? `${etClock(clock.next)} ET` : null;
  const markAge = quote ? Math.max(0, minute - quote.at) : null;

  if (!vault || !d) return <AssetSkeleton symbol={asset.symbol} />;
  return (
    <SimulatedReady
      asset={asset} vault={vault} d={d} stem={stem} price={price} quote={quote} quoteSettled={quoteSettled} stale={stale}
      markAge={markAge} reopens={reopens} commit={commit} reset={reset} curve={curve} minute={minute}
      liveSymbols={liveSymbols} initialClass={initialClass}
      ui={{ details, setDetails, dock, setDock, request, setRequest }}
    />
  );
}

function SimulatedReady({ asset, vault, d, stem, price, quote, quoteSettled, stale, markAge, reopens, commit, reset, curve, minute, liveSymbols, initialClass, ui }: {
  asset: Asset;
  vault: LocalVault;
  d: ReturnType<typeof derive>;
  stem: string;
  price: number;
  quote: Quote | undefined;
  quoteSettled: boolean;
  stale: boolean;
  markAge: number | null;
  reopens: string | null;
  commit: (v: LocalVault) => void;
  reset: () => void;
  curve: ReturnType<typeof useCurve>;
  minute: number;
  liveSymbols: string[];
  initialClass: Cls | null;
  ui: {
    details: boolean; setDetails: (v: boolean) => void;
    dock: boolean; setDock: (v: boolean) => void;
    request: TradeRequest | null; setRequest: (r: TradeRequest) => void;
  };
}) {
  const engine = useLocalEngine(vault, commit, { price, ageSec: markAge, live: !!quote && !stale }, { stem, reopens });
  const mint = (cls: Cls) => { ui.setRequest({ cls, mode: 'mint', n: Date.now() }); ui.setDock(true); };
  const pair: PairState = {
    exposed: vault.exposed,
    halted: vault.halted,
    event: false,
    nav: { day: navToNumber(vault.dayNav), night: navToNumber(vault.nightNav) },
    supply: { day: fromShares(vault.daySupply), night: fromShares(vault.nightSupply) },
    value: { day: fromQuote(d.valueDay), night: fromQuote(d.valueNight) },
    held: { day: fromShares(vault.myDay), night: fromShares(vault.myNight) },
    source: { kind: 'simulated', detail: 'The simulation in this browser', ageSec: null },
  };
  const parked: Cls = vault.exposed === 'night' ? 'day' : 'night';
  const empty = vault.nightSupply === 0n && vault.daySupply === 0n;

  return (
    <div className={s.page}>
      <AssetHeader
        asset={asset} quote={quote} quoteSettled={quoteSettled}
        badges={<>
          <Status kind="simulated" label="Simulated vault" />
          <Status kind="closed" label="Not on chain" bare />
        </>}
        meta={<span>Runs the program&rsquo;s <span className="mono">settle()</span> in this browser, on the live price</span>}
        actions={<Button variant="secondary" size="sm" onClick={() => ui.setDetails(true)}><Icon name="layers" size={14} /> How this works</Button>}
      />

      <p className={s.honest} role="note">
        <Icon name="info" size={14} />
        <span>
          <strong>{asset.symbol} has no vault on chain.</strong> Its history on this page is real — measured from its own
          pool, hour by hour. The vault is a simulation: the same settlement code the program runs, on the live price,
          written to this browser&rsquo;s storage. Nothing is minted or owned.
          {liveSymbols.length > 0 && <> On chain: {liveSymbols.map((sym, i) => <span key={sym}>{i ? ', ' : ''}<Link to={`/markets/${sym}`}>{sym}</Link></span>)}.</>}
        </span>
      </p>

      <div className={s.grid}>
        <div className={s.main}>
          <div className={s.first}><SessionStrip symbol={stem} exposed={vault.exposed} /></div>
          <div className={s.second}>
            <ClassPair asset={asset} detailed vaultSymbol={stem} onMint={mint} state={pair} />
          </div>

          <Compare asset={asset} funding={fundingFromLocal(d.valueNight, d.valueDay, d.skew, 6)} event={false} />

          <section className={s.card} aria-label="Price over the sessions">
            <header className={s.cardHead}>
              <h2 className={s.cardTitle}>What you are exposed to</h2>
              <Source kind="study" detail="Hourly pool closes from GeckoTerminal, in the study snapshot" />
            </header>
            <p className={s.cardSub}>
              The token&rsquo;s hourly price over the sessions a vault settles on. {vault.exposed.toUpperCase()} holds the
              stock in the shaded stretch it names; the other class sits in quote.
            </p>
            {curve.status === 'ready' && curve.data.recent
              ? <SessionPriceChart recent={curve.data.recent} live={quote ? { price: quote.price, at: quote.at } : null} now={minute} symbol={asset.symbol} />
              : curve.status === 'error'
                ? <p className={s.note}>The recent history for {asset.symbol} could not be loaded. Everything else on this page is unaffected.</p>
                : <div className="skeleton" style={{ width: '100%', height: 280 }} />}
          </section>

          <Position
            names={engine.names} words={engine.words} held={engine.held} nav={engine.nav}
            exposed={vault.exposed} event={false}
            preview={previewLocalBell(vault, markFromPrice(price, asset.decimals))}
            empty={empty
              ? <><strong>Nothing minted in this browser yet.</strong> <span className="mono">{engine.names[parked]}</span> is the class that is open — it is parked in quote until the bell{reopens ? <> at <span className="num">{reopens}</span></> : ''}, when the vault hands it the stock for {parked === 'day' ? 'the regular session' : 'the overnight stretch'}. Mint into it to watch that happen.</>
              : <>You hold neither class. <strong>{engine.names[parked]}</strong> is open.</>}
          />

          <section className={s.card} aria-label="Recent activity">
            <header className={s.cardHead}>
              <h2 className={s.cardTitle}>This vault&rsquo;s ledger</h2>
              <Status kind="simulated" label="In this browser" bare />
            </header>
            <LocalActivity history={vault.history} stem={stem} />
          </section>

          <HealthCard
            health={d.health}
            backing={fromQuote(d.backing)} claims={fromQuote(d.totalClaims)} margin={fromQuote(d.margin)}
            skew={Number(d.skew) / 1e18}
            halted={vault.halted ? (vault.haltReason || 'halted') : null}
            onMore={() => ui.setDetails(true)}
            foot={<>This vault&rsquo;s balances live in this browser. Everything derived from them — NAV, funding, the handoff, these signals — runs the same code the program does.</>}
            action={<Button variant="tertiary" size="sm" onClick={reset}>Reset this vault</Button>}
          />

          <section className={s.card} aria-label="Measured history">
            <header className={s.cardHead}>
              <h2 className={s.cardTitle}>Decomposed since inception</h2>
              <Source kind="study" detail={`${Math.round(asset.days)} days of hourly closes`} />
            </header>
            <p className={s.cardSub}>
              Each line compounds only the returns earned inside its own session. The gap between them is what owning
              one instead of the other would have been worth.
            </p>
            {curve.status === 'ready'
              ? <CurveChart points={curve.data.points} height={260} label={`${asset.symbol}, night versus day cumulative return`} />
              : curve.status === 'error'
                ? <p className={s.note}>The history for {asset.symbol} could not be loaded.</p>
                : <div className="skeleton" style={{ width: '100%', height: 260 }} />}
          </section>
        </div>

        <aside className={s.side} aria-label="Trade">
          <TradeDock
            open={ui.dock} onOpenChange={ui.setDock} label={`Trade ${asset.symbol}`}
            bar={<><ClassTag cls={parked} active>{engine.words[parked]}</ClassTag><span>{engine.names[parked]} open · simulated</span></>}
          >
            <TradePanel engine={engine} symbol={asset.symbol} name={asset.name} request={ui.request} initialClass={initialClass} />
          </TradeDock>
          <p className={s.note}>
            Want the real thing? <Link to="/markets/NVDAx">NVDAx</Link> has a vault on devnet.
          </p>
        </aside>
      </div>

      <Sheet open={ui.details} onClose={() => ui.setDetails(false)} kind="drawer" title="How this simulation works">
        <div className={s.details}>
          <section className={s.dSection}>
            <h3 className={s.dTitle}>What runs here</h3>
            <p className={s.dText}>
              The vault is the program&rsquo;s own arithmetic — <span className="mono">settle()</span>,{' '}
              <span className="mono">plan_mint</span>, <span className="mono">plan_redeem</span> — run in this browser
              against the live price of {asset.symbol}. When the page opens it settles every bell the vault slept
              through, in order.
            </p>
            <p className={s.dText}>
              Two things are simpler than on chain, and both are stated rather than hidden: missed bells settle at the
              current price, because a browser has no record of the price at each one; and the handoff is assumed
              filled at the mark, which is the optimistic case — on chain a filler does it and is paid for it.
            </p>
          </section>
          <section className={s.dSection}>
            <h3 className={s.dTitle}>Health signals</h3>
            <Signals health={d.health} />
          </section>
          <section className={s.dSection}>
            <h3 className={s.dTitle}>State</h3>
            <dl className={s.kv}>
              <div><dt>Exposed class</dt><dd>{vault.exposed.toUpperCase()}</dd></div>
              <div><dt>Last settled</dt><dd className="num">{etClock(vault.lastBoundaryTs)} ET</dd></div>
              <div><dt>Inventory</dt><dd className="num">{(Number(vault.ownedUnderlying) / 10 ** asset.decimals).toLocaleString('en-US', { maximumFractionDigits: 6 })} {asset.symbol}</dd></div>
              <div><dt>Quote held</dt><dd className="num">{fromQuote(vault.ownedQuote).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</dd></div>
            </dl>
          </section>
          <section className={s.dSection}>
            <h3 className={s.dTitle}>The real one</h3>
            <p className={s.dText}>
              The same program runs on devnet for <Link to="/markets/NVDAx">NVDAx</Link> and{' '}
              <Link to="/markets/OPENAI">OPENAI</Link>, with real transactions and a ledger anyone can read.
            </p>
          </section>
        </div>
      </Sheet>
    </div>
  );
}
