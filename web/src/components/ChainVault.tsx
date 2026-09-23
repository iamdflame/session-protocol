/* ───────────────────────────────────────────────────────────────────────────
   The instrument page, when the vault is real.

   Everything on it is read from devnet through `useChainVault`: the account,
   the share supplies, both oracles, the wallet's balances. The trade panel
   signs real transactions; the health card runs the SDK's `evaluate` on the
   chain state; the activity list is the vault's own transaction history.

   The page is split the way the brief asks: what a holder needs — session,
   the two classes, their position, the trade — is on the page, and the layer
   underneath — oracle, settlement, instrument, ledger, every account — is in
   the protocol details drawer, one click away and never on the way.
   ─────────────────────────────────────────────────────────────────────────── */

import { useCallback, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { Link } from 'react-router-dom';
import { SESSION_EVENT } from '@sdk/vault.ts';
import { useCurve, useQuotes, type Asset } from '@/lib/data';
import {
  useChainVault, explorerAddr, short, useLedger, useWalletTrades,
  type Devnet, type ChainVault as ChainState,
} from '@/lib/chain';
import type { ShareClass } from '@/lib/localVault';
import { useSessionMinute } from '@/lib/session';
import { previewChainBell } from '@/lib/bell';
import { CurveChart } from './charts/CurveChart';
import { SessionPriceChart } from './charts/SessionPriceChart';
import { EventSession } from './EventSession';
import { Auction } from './Auction';
import { Statement } from './Statement';
import { fundingFromChain } from './FundingRate';
import { ClassPair, EventHinge, pairFromChain } from './session/ClassPair';
import { TradePanel, TradeDock, type TradeRequest } from './trade/TradePanel';
import { useChainEngine, classStem } from './trade/engines';
import { AssetHeader } from './asset/AssetHeader';
import { SessionStrip } from './asset/SessionStrip';
import { HealthCard } from './asset/HealthCard';
import { Position } from './asset/Position';
import { Compare } from './asset/Compare';
import { ChainActivity } from './asset/Activity';
import { ChainDetails } from './asset/ProtocolDetails';
import { useCrank } from './asset/useCrank';
import { Status, ClassTag } from './ui/Status';
import { Source } from './ui/Source';
import { Button } from './ui/Button';
import { Sheet } from './ui/Sheet';
import { Icon } from './ui/Icon';
import s from './asset/Asset.module.css';

type Cls = 'day' | 'night';
const atoms = (v: bigint, d: number) => Number(v) / 10 ** d;

/** Now, to the minute: the page root redraws when the minute turns, not every second. */
function useMinute() {
  const clock = useSessionMinute();
  return clock?.minute ?? Math.floor(Date.now() / 60_000) * 60;
}

export function ChainVault({ m, asset, initialClass }: { m: Devnet; asset: Asset; initialClass?: Cls | null }) {
  const chain = useChainVault(m);

  if (chain.status === 'loading') return <AssetSkeleton symbol={asset.symbol} />;
  if (chain.status === 'error' && !chain.data) {
    return (
      <div className={s.gate}>
        <Status kind="stale" label="Devnet unreachable" />
        <h1 className={s.gateTitle}>{asset.symbol}: the vault could not be read.</h1>
        <p className={s.gateBody}>
          {chain.error.message}. The public devnet endpoint rate-limits; trying again usually gets through.
          Nothing on this page is guessed in the meantime — a vault page that shows an old number as a
          current one is worse than one that stops.
        </p>
        <div className={s.gateActions}>
          <Button onClick={() => chain.refresh()}>Try again</Button>
          <Button variant="secondary" href={explorerAddr(m.vault)}>Vault on Solscan</Button>
        </div>
      </div>
    );
  }
  return <Ready m={m} asset={asset} d={chain.data!} refresh={chain.refresh} initialClass={initialClass ?? null} />;
}

function Ready({ m, asset, d, refresh, initialClass }: {
  m: Devnet; asset: Asset; d: ChainState; refresh: () => void; initialClass: Cls | null;
}) {
  const { publicKey } = useWallet();
  /* One history, two readers. The activity list shows the latest; the
     statement needs further back to price a position opened before them, and
     fetching the same signatures twice is how a public RPC starts refusing. */
  const ledger = useLedger(m.vault, 60);
  /* The connected wallet's own trades, off its share accounts. A position is
     exact from those alone; only the comparison needs the vault's history. */
  const mine = useWalletTrades(m, publicKey);
  // A trade that lands shows up in the history and the statement at once.
  const settled = useCallback(
    () => { refresh(); ledger.refresh(); mine.refresh(); },
    [refresh, ledger.refresh, mine.refresh],
  );
  const { quotes, settled: quoteSettled } = useQuotes([asset.mint]);
  const quote = quotes[asset.mint];
  const curve = useCurve(asset.symbol);
  const crank = useCrank(d, settled);
  const engine = useChainEngine(m, d, settled);
  const minute = useMinute();

  const [details, setDetails] = useState(false);
  const [dock, setDock] = useState(false);
  const [request, setRequest] = useState<TradeRequest | null>(null);

  const v = d.vault;
  const qd = v.quoteDecimals;
  const isEvent = v.sessionKind === SESSION_EVENT;
  const stem = classStem(m.symbol, m.vaultSymbol);
  const label = (k: ShareClass) => engine.names[k];
  const mint = (cls: Cls) => { setRequest({ cls, mode: 'mint', n: Date.now() }); setDock(true); };
  const skew = Number(d.skew) / 1e18;

  return (
    <div className={s.page}>
      <AssetHeader
        asset={asset} quote={quote} quoteSettled={quoteSettled}
        badges={<>
          <Status kind="devnet" label="Live · devnet" pulse />
          {isEvent && <Status kind="event" label="Event vault · no bell" />}
          <Status kind="devnet" label="Test funds" bare title="Test mints on devnet: nothing here has a market value" />
        </>}
        meta={<>
          <span>Vault <a href={explorerAddr(m.vault)} target="_blank" rel="noreferrer" className="mono">{short(m.vault, 4)} <Icon name="external" size={11} /></a></span>
          <span><span className="num">{v.boundaryCount.toString()}</span> boundaries settled</span>
        </>}
        actions={<Button variant="secondary" size="sm" onClick={() => setDetails(true)}><Icon name="layers" size={14} /> Protocol details</Button>}
      />

      <p className={s.honest} role="note">
        <Icon name="info" size={14} />
        <span>
          {isEvent
            ? <><strong>A devnet vault on a PreStock-shaped test mint.</strong> The program and every figure it produces are real; the detector reading it settles against is read live from prestocks.com and posted on chain.</>
            : <><strong>A devnet vault with test mints, marked to Pyth {m.markFeed}</strong> as a stand-in for the NVDAX feed devnet does not carry — so its NAVs move with that feed, not with {asset.symbol}&rsquo;s price above.</>}{' '}
          <button type="button" onClick={() => setDetails(true)}>What is real here</button>
        </span>
      </p>

      <div className={s.grid}>
        <div className={s.main}>
          {isEvent
            ? <div className={s.first}><EventSession m={m} d={d} /></div>
            : <div className={s.first}><SessionStrip symbol={stem} exposed={v.exposed as Cls} due={d.boundaryDue} onSettle={() => crank.run('manual')} settling={crank.busy} /></div>}

          <div className={s.second}>
            <ClassPair
              asset={asset} detailed vaultSymbol={stem} onMint={mint}
              state={pairFromChain(d, `${stem} vault account, devnet, slot ${d.slot.toLocaleString()}`)}
              hinge={isEvent ? <EventHinge nextPrint={d.event?.nextPrint ?? null} /> : undefined}
            />
          </div>

          <Compare asset={asset} funding={fundingFromChain(d)} event={isEvent} />

          <section className={s.card} aria-label="Price over the sessions">
            <header className={s.cardHead}>
              <h2 className={s.cardTitle}>{isEvent ? `${asset.symbol} against NYSE hours` : 'What you are exposed to'}</h2>
              <Source kind="study" detail="Hourly pool closes from GeckoTerminal, in the study snapshot" />
            </header>
            <p className={s.cardSub}>
              {isEvent
                ? <>{asset.symbol}&rsquo;s own pool, shaded by NYSE sessions it does not have — a control, not this vault&rsquo;s rule. <strong>This vault splits on the next print and on the premium</strong>, not on the bell.</>
                : <>The token&rsquo;s hourly price over the sessions the vault settles on. {engine.words[v.exposed as Cls]} holds the stock in the shaded stretch it names; the other class sits in quote.</>}
            </p>
            {curve.status === 'ready' && curve.data.recent
              ? <SessionPriceChart recent={curve.data.recent} live={quote ? { price: quote.price, at: quote.at } : null} now={minute} symbol={asset.symbol} />
              : curve.status === 'error'
                ? <p className={s.note}>The recent history for {asset.symbol} could not be loaded. Everything else on this page is unaffected.</p>
                : <div className="skeleton" style={{ width: '100%', height: 280 }} />}
          </section>

          <Position
            names={engine.names} words={engine.words} held={engine.held} nav={engine.nav}
            exposed={v.exposed as Cls} event={isEvent}
            wallet={{ connected: engine.wallet.connected, connect: engine.wallet.connect }}
            preview={previewChainBell(d)}
            empty={<>You hold neither class. <strong>{engine.names[engine.parked]}</strong> is open — mint it to take a side.</>}
          />

          <Statement mine={mine.events} mineState={mine.state} rows={ledger.rows} history={ledger.history} d={d} symbol={asset.symbol} label={label} />

          <section className={s.card} aria-label="Recent activity">
            <header className={s.cardHead}>
              <h2 className={s.cardTitle}>Recent activity</h2>
              <button type="button" className={s.linkBtn} onClick={() => setDetails(true)}>Full ledger</button>
            </header>
            <ChainActivity rows={ledger.rows} error={ledger.error} dec={qd} label={label} limit={6} />
          </section>

          <HealthCard
            health={d.health}
            backing={atoms(d.health.margin + d.valueNight + d.valueDay, qd)}
            claims={atoms(d.valueNight + d.valueDay, qd)}
            margin={atoms(d.health.margin, qd)}
            skew={skew}
            halted={v.halted ? String(v.haltReason) : null}
            onMore={() => setDetails(true)}
            foot={<>Computed by the SDK&rsquo;s <span className="mono">evaluate()</span> on state read from devnet at slot <span className="num">{d.slot.toLocaleString()}</span> — the same function the keeper pages on.</>}
          />

          <section className={s.card} aria-label="Measured history">
            <header className={s.cardHead}>
              <h2 className={s.cardTitle}>{isEvent ? 'The same split, on an asset with no session' : 'Decomposed since inception'}</h2>
              <Source kind="study" detail={`${Math.round(asset.days)} days of hourly closes`} />
            </header>
            <p className={s.cardSub}>
              Each line compounds only the returns earned inside its own session. The gap between them is
              what owning one instead of the other would have been worth.
            </p>
            {curve.status === 'ready'
              ? <CurveChart points={curve.data.points} height={260} label={`${asset.symbol}, night versus day cumulative return`} />
              : curve.status === 'error'
                ? <p className={s.note}>The history for {asset.symbol} could not be loaded.</p>
                : <div className="skeleton" style={{ width: '100%', height: 260 }} />}
          </section>
        </div>

        <aside className={s.side} aria-label="Trade" data-tour="vault">
          <TradeDock
            open={dock} onOpenChange={setDock} label={`Trade ${asset.symbol}`}
            bar={<><ClassTag cls={engine.parked} active>{engine.words[engine.parked]}</ClassTag><span>{engine.halted ? 'Vault halted' : `${engine.names[engine.parked]} open to mint`}</span></>}
          >
            <TradePanel engine={engine} symbol={asset.symbol} name={asset.name} request={request} initialClass={initialClass} />
          </TradeDock>
          <Auction m={m} d={d} onDone={settled} />
          <p className={s.note}>
            New here? <Link to="/how-it-works">How the handoff works</Link>.
          </p>
        </aside>
      </div>

      <Sheet open={details} onClose={() => setDetails(false)} kind="drawer" title="Protocol details">
        <ChainDetails m={m} d={d} ledger={ledger} label={label} crank={crank} />
      </Sheet>
    </div>
  );
}

export function AssetSkeleton({ symbol }: { symbol: string }) {
  return (
    <div className={s.page} aria-busy="true">
      {/* A page that is loading still has a name: without it the document has
          no level-1 heading while the chain read is in flight, which is what a
          screen-reader user lands on. */}
      <h1 className="sr-only">{symbol}</h1>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="skeleton" style={{ width: 140, height: 12 }} />
        <div className="skeleton" style={{ width: 260, height: 40 }} />
        <div className="skeleton" style={{ width: '100%', height: 1 }} />
      </div>
      <div className={s.grid}>
        <div className={s.main}>
          <div className="skeleton" style={{ height: 150, borderRadius: 16 }} />
          <div className="skeleton" style={{ height: 300, borderRadius: 16 }} />
        </div>
        <div className="skeleton" style={{ height: 520, borderRadius: 16 }} />
      </div>
      <p className="sr-only" role="status">Reading the vault</p>
    </div>
  );
}
