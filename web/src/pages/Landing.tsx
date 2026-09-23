/* ───────────────────────────────────────────────────────────────────────────
   Home is the product.

   The first viewport answers, in this order: what SESSION does, whether NYSE
   is open, which class is carrying the stock, when the next handoff is, and
   what you can do about it right now. Then the instrument itself — NVDA.DAY
   and NVDA.NIGHT, read from the devnet vault — then the market, the evidence,
   and how the handoff works. No hero illustration: the session rail is the
   hero, and it is live.
   ─────────────────────────────────────────────────────────────────────────── */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession, closureReason, etClock, upcoming } from '@/lib/session';
import { useMarkets, useQuotes, load, type CurveFile, type CurvePoint } from '@/lib/data';
import { useChainVault, useDevnetVaultFor, useDevnets } from '@/lib/chain';
import { SESSION_EVENT } from '@sdk/vault.ts';
import { SessionRail, type ScrubState } from '@/components/session/SessionRail';
import { ClassPair, pairFromChain } from '@/components/session/ClassPair';
import { MarketTable, type VaultInfo } from '@/components/markets/MarketTable';
import { Button } from '@/components/ui/Button';
import { Status } from '@/components/ui/Status';
import { Countdown, Delta } from '@/components/ui/Figures';
import { Icon } from '@/components/ui/Icon';
import { Source } from '@/components/ui/Source';
import s from './Landing.module.css';
import { useTour } from '@/components/tour/Tour';

/* What a minute on the rail means, in one sentence each. */
function readout(sc: ScrubState | null, holder: 'DAY' | 'NIGHT' | null) {
  if (sc?.handoff) {
    return sc.handoff.kind === 'open'
      ? <><b>{sc.handoff.label} — the opening bell.</b> NIGHT hands the stock to DAY. Only the imbalance between the classes trades, at the bell&rsquo;s own Pyth print.</>
      : <><b>{sc.handoff.label} — the closing bell.</b> DAY hands the stock to NIGHT for the hours the market is shut.</>;
  }
  const cls = sc?.cls ?? holder?.toLowerCase();
  if (cls === 'day') return <><b className="day-ink">DAY holds the stock.</b> NYSE is open, arbitrage keeps the token pinned to the share, and there is no overnight gap.</>;
  if (cls === 'night') return <><b className="night-ink">NIGHT holds the stock.</b> The exchange is shut, the token keeps trading with nothing to arbitrage against, and the gap lives here.</>;
  return null;
}

function MarketModule({ parked, halted, asset }: {
  parked: 'day' | 'night' | null;
  /** The vault's own halt reason, when it has stopped. Nothing is offered then. */
  halted: string | null;
  asset: { symbol: string; name: string; price: number | null; change: number | null } | null;
}) {
  const sess = useSession();
  const [scrub, setScrub] = useState<ScrubState | null>(null);
  const { start: startTour } = useTour();

  if (!sess) {
    return <div className={s.module} aria-busy="true"><div className="skeleton" style={{ height: 240, borderRadius: 12 }} /></div>;
  }
  const active = sess.holder;
  const cls = active.toLowerCase() as 'day' | 'night';
  const why = closureReason(sess.now);
  const next = upcoming(sess.now, 1)[0];
  // The class you can issue right now is the one parked in quote. The chain is
  // authoritative; until it has been read, the calendar says the same thing.
  const mintable = parked ?? (sess.handsTo.toLowerCase() as 'day' | 'night');

  return (
    <div className={`${s.module} grid-bg`} data-cls={cls} data-tour="clock">
      <div className={s.glow} aria-hidden="true" />
      <div className={s.modTop}>
        <div className={s.activeBlock}>
          <p className={s.modEyebrow}>
            <Status kind={sess.isOpen ? 'open' : 'closed'} label={sess.isOpen ? 'NYSE open' : 'NYSE closed'} bare />
            {why && <span className={s.why}>{why}</span>}
          </p>
          <p className={s.activeWord} data-cls={cls}>{active} <span>active</span></p>
          <p className={s.activeSub}>
            {cls === 'day' ? 'Regular-session exposure is live.' : 'Overnight gap exposure is live.'}
          </p>
        </div>

        <div className={s.nextBlock}>
          <p className={s.modEyebrow}>Next handoff</p>
          <Countdown seconds={sess.until} className={s.bigClock} label="Next handoff in" />
          <p className={s.nextSub}>
            {sess.handsTo} takes the stock at <span className="num">{next ? etClock(next.at) : '—'} ET</span>
            {next && next.label !== 'Today' ? ` · ${next.label}` : ''}
          </p>
        </div>

        <div className={s.actions}>
          {asset && (
            <Link to="/markets/NVDAx" className={s.instr} data-tour="nvda">
              <span className={`mono ${s.instrSym}`}>{asset.symbol}</span>
              <span className={s.instrName}>{asset.name}</span>
              <span className={`num ${s.instrPrice}`}>{asset.price ? `$${asset.price.toFixed(2)}` : '—'}</span>
              <Delta value={asset.change} />
            </Link>
          )}
          {halted ? (
            <>
              {/* A halted vault issues nothing. The call to act says so and
                  points at the reason, rather than offering a mint the
                  program would refuse. */}
              <Button to="/markets/NVDAx" variant="secondary" size="lg">
                Vault halted · see why
                <Icon name="chevronRight" size={16} />
              </Button>
              <p className={s.actionNote}>
                The NVDA vault stopped itself ({halted === 'MissedBoundary' ? 'a bell went unsettled' : halted}) and mints nothing until
                its books are replayed and it resumes. Halting is the protocol working.
              </p>
            </>
          ) : (
            <>
              <Button to={`/trade?asset=NVDAx&class=${mintable}`} tone={mintable} size="lg">
                Mint NVDA.{mintable.toUpperCase()}
                <Icon name="chevronRight" size={16} />
              </Button>
              <p className={s.actionNote}>
                {mintable.toUpperCase()} is parked in quote, so it can be issued now — it takes the stock at the next bell.
                {' '}{active} is carrying it and reopens for minting then.
              </p>
            </>
          )}
          <div className={s.secondary}>
            <Button to="/trade?demo=1" variant="secondary" size="sm">Explore demo</Button>
            <Button variant="tertiary" size="sm" onClick={startTour}><Icon name="play" size={12} /> 90-sec tour</Button>
          </div>
        </div>
      </div>

      <SessionRail interactive onScrub={setScrub} label="Today in Eastern time" />

      <p className={s.readout} aria-live="polite">
        {readout(scrub, active)}
        {!scrub && <span className={s.hint}> Drag the rail — or focus it and use ← → — to see who holds the stock at any minute today.</span>}
      </p>
    </div>
  );
}

function ResearchStrip() {
  const markets = useMarkets();
  const h = markets.data?.headline;
  if (!h) return <div className="skeleton" style={{ height: 180, borderRadius: 16 }} />;
  const volUp = (h.volRatio - 1) * 100;
  return (
    <section className={s.research} aria-labelledby="research-h">
      <div className={s.resHead}>
        <p className="eyebrow">The evidence</p>
        <h2 id="research-h" className={s.h2}>NIGHT does not outperform DAY. It is just riskier.</h2>
        <Link to="/research" className={s.more}>Explore research <Icon name="chevronRight" size={14} /></Link>
      </div>
      <div className={s.resGrid}>
        <div className={s.resStat}>
          <span className={`num ${s.resBig}`}>{h.closes.toLocaleString()}</span>
          <span className={s.resKey}>hourly closes, {h.assets} assets, {h.spanDays} days</span>
        </div>
        <div className={s.resStat}>
          <span className={`num ${s.resBig}`}>{h.spreadBpPerHour > 0 ? '+' : '−'}{Math.abs(h.spreadBpPerHour).toFixed(2)}<span className={s.resUnit}> bp/h</span></span>
          <span className={s.resKey}>NIGHT minus DAY, per hour, pooled</span>
        </div>
        <div className={s.resStat}>
          <span className={s.wins} role="img" aria-label={`NIGHT beat DAY in ${h.nightWins} of ${h.equities} equities`}>
            {Array.from({ length: h.equities }, (_, i) => <span key={i} data-on={i < h.nightWins || undefined} />)}
          </span>
          <span className={s.resKey}><b className="num">{h.nightWins} / {h.equities}</b> equities where NIGHT beat DAY per hour</span>
        </div>
        <div className={s.resStat}>
          <div className={s.vol} role="img" aria-label={`Volatility per session: NIGHT ${(h.nightVol * 100).toFixed(2)}%, DAY ${(h.dayVol * 100).toFixed(2)}%`}>
            <span className={s.volRow}><span className={s.volLabel}>NIGHT</span><span className={s.volBar} data-cls="night" style={{ width: '100%' }} /><span className="num">{(h.nightVol * 100).toFixed(2)}%</span></span>
            <span className={s.volRow}><span className={s.volLabel}>DAY</span><span className={s.volBar} data-cls="day" style={{ width: `${(h.dayVol / h.nightVol) * 100}%` }} /><span className="num">{(h.dayVol * 100).toFixed(2)}%</span></span>
          </div>
          <span className={s.resKey}><b className="num">+{volUp.toFixed(0)}%</b> volatility at night, for no more return</span>
        </div>
      </div>
      <p className={s.resSrc}><Source kind="study" detail={`Session study over real Solana pool history`} /> Measured, not modelled — including where it disagrees with the literature.</p>
    </section>
  );
}

const STEPS = [
  { n: '01', t: 'One vault holds the stock', d: 'A tokenized NVDAx wrapper, and two share classes over it.' },
  { n: '02', t: 'One class carries it', d: 'DAY during the regular session, NIGHT for every other hour.' },
  { n: '03', t: 'The bell rings', d: 'At 09:30 and 16:00 ET — early closes, holidays and weekends from the same calendar the program runs.' },
  { n: '04', t: 'Exposure hands over', d: 'Only the imbalance trades, at the bell’s own Pyth print. Funding pays the side carrying the crowd.' },
];

export default function Landing() {
  const markets = useMarkets();
  const devnets = useDevnets();
  const nvda = useDevnetVaultFor('NVDAx');
  const chain = useChainVault(nvda);
  const assets = markets.data?.assets ?? [];
  const nvdaAsset = assets.find(a => a.symbol === 'NVDAx');

  const preview = useMemo(() => {
    const pick = ['NVDAx', 'SPYx', 'TSLAx', 'AAPLx', 'QQQx', 'OPENAI'];
    return pick.map(p => assets.find(a => a.symbol === p)).filter((a): a is NonNullable<typeof a> => !!a);
  }, [assets]);
  const mints = useMemo(() => preview.map(a => a.mint), [preview]);
  const { quotes, settled } = useQuotes(mints);
  const vaults = useMemo(() => new Map<string, VaultInfo>((devnets ?? []).map(d => [d.symbol, { kind: d.sessionKind === SESSION_EVENT ? 'event' : 'devnet' }])), [devnets]);

  const live = nvdaAsset ? quotes[nvdaAsset.mint]?.price ?? nvdaAsset.price : null;

  const [curves, setCurves] = useState<Record<string, CurvePoint[]>>({});
  useEffect(() => {
    let on = true;
    for (const a of preview) {
      load<CurveFile>(`/data/curves/${encodeURIComponent(a.symbol)}.json`)
        .then(c => { if (on) setCurves(p => ({ ...p, [c.symbol]: c.points })); })
        .catch(() => { /* a missing sparkline is not an error state */ });
    }
    return () => { on = false; };
  }, [preview]);

  const parked = chain.data ? (chain.data.vault.exposed === 'day' ? 'night' : 'day') : null;

  return (
    <div className={s.page}>
      {/* ── the product, first ──────────────────────────────────────────── */}
      <section className={s.hero} aria-labelledby="hero-h">
        <div className={s.heroTop} data-tour="session">
          <div>
            <div className={s.statusLine}>
              <span className={s.brand}>SESSION</span>
              <Status kind="live" label="Live" />
              <Status kind="devnet" label="Devnet vault" title="The vaults run on Solana devnet with test mints; the program is the mainnet program." />
            </div>
            <h1 id="hero-h" className={`display ${s.title}`}>Separate the day from the night.</h1>
          </div>
          <p className={s.sub}>
            Tokenized equities trade around the clock; the stock behind them trades for six and a half hours.
            SESSION splits the exposure: <b className="day-ink">DAY</b> carries the regular session, <b className="night-ink">NIGHT</b> the overnight gap.
          </p>
        </div>
        <MarketModule parked={parked} halted={chain.data?.vault.halted ? String(chain.data.vault.haltReason) : null} asset={nvdaAsset ? { symbol: nvdaAsset.symbol, name: nvdaAsset.name, price: live, change: (nvdaAsset && quotes[nvdaAsset.mint]?.change24h) ?? nvdaAsset.change24h } : null} />
      </section>

      {/* ── the instrument ──────────────────────────────────────────────── */}
      <section className={s.section} aria-labelledby="pair-h" data-tour="classes">
        <div className={s.secHead}>
          <div>
            <p className="eyebrow">Live instrument</p>
            <h2 id="pair-h" className={s.h2}>NVDA, split in two</h2>
          </div>
          <div className={s.underlying}>
            <span className={s.uLabel}>NVDAx</span>
            <span className={`num ${s.uPrice}`}>{live ? `$${live.toFixed(2)}` : '—'}</span>
            <Source kind="jupiter" detail="NVDAx on mainnet, via Jupiter" ageSec={nvdaAsset && quotes[nvdaAsset.mint] ? Math.max(0, Math.floor(Date.now() / 1000) - quotes[nvdaAsset.mint].at) : undefined} />
          </div>
        </div>
        <ClassPair asset={nvdaAsset} state={chain.data ? pairFromChain(chain.data, 'NVDA vault account, devnet') : null} vaultSymbol="NVDA" tradeHref="/trade?asset=NVDAx" />
        <p className={s.honest}>
          <Status kind="devnet" /> The vault runs on devnet with a stand-in mint marked by Pyth <span className="mono">Crypto.SOL/USD</span>, so its NAV follows that feed, not NVDA.
          The price above is real NVDAx on mainnet. <Link to="/how-it-works#status">What is live</Link>
        </p>
      </section>

      {/* ── markets ─────────────────────────────────────────────────────── */}
      <section className={s.section} aria-labelledby="mk-h">
        <div className={s.secHead}>
          <div>
            <p className="eyebrow">Markets</p>
            <h2 id="mk-h" className={s.h2}>Every name, split by session</h2>
          </div>
          <Link to="/markets" className={s.more}>All {assets.length || 26} markets <Icon name="chevronRight" size={14} /></Link>
        </div>
        {preview.length ? (
          <MarketTable assets={preview} quotes={quotes} quotesSettled={settled} curves={curves} vaults={vaults} compact caption="Six markets, with live price and measured DAY and NIGHT returns" />
        ) : <div className="skeleton" style={{ height: 300, borderRadius: 12 }} />}
      </section>

      {/* ── evidence ────────────────────────────────────────────────────── */}
      <div className={s.section}><ResearchStrip /></div>

      {/* ── how it works ────────────────────────────────────────────────── */}
      <section className={s.section} aria-labelledby="how-h">
        <div className={s.secHead}>
          <div>
            <p className="eyebrow">Protocol</p>
            <h2 id="how-h" className={s.h2}>How the handoff works</h2>
          </div>
          <Link to="/how-it-works" className={s.more}>Step through it <Icon name="chevronRight" size={14} /></Link>
        </div>
        <ol className={s.steps}>
          {STEPS.map(st => (
            <li key={st.n} className={s.step}>
              <span className={`num ${s.stepN}`}>{st.n}</span>
              <h3 className={s.stepT}>{st.t}</h3>
              <p className={s.stepD}>{st.d}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
