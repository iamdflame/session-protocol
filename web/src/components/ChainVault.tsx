import { useCallback, useEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { Link } from 'react-router-dom';
import { CurveChart } from './charts/CurveChart';
import { SessionClock } from './SessionClock';
import { ChainTrade } from './ChainTrade';
import { Instrument } from './Instrument';
import { EventSession } from './EventSession';
import { Auction } from './Auction';
import { FundingRate } from './FundingRate';
import { Statement } from './Statement';
import { useSession, useClockSize, countdown, etClock, etDate } from '@/lib/session';
import { useCurve, fmtUsd, fmtPct, type Asset } from '@/lib/data';
import {
  useChainVault, pingCrank, explorer, explorerAddr, short, type Devnet, type ChainVault as ChainState,
  useLedger, useWalletTrades, pingDetector, type LedgerRow,
} from '@/lib/chain';
import { Severity } from '@sdk/health.ts';
import { describe, kindOf } from '@sdk/events.ts';
import { SESSION_EVENT } from '@sdk/vault.ts';
import type { ShareClass } from '@/lib/localVault';
import s from '@/pages/Vault.module.css';
import h from './HealthPanel.module.css';
import c from './ChainVault.module.css';

const LABEL: Record<string, string> = { ok: 'Healthy', notice: 'Notice', warning: 'Warning', critical: 'Critical' };
const nav = (v: bigint) => Number(v) / 1e18;
const fromAtoms = (v: bigint, d: number) => Number(v) / 10 ** d;

/**
 * The vault page, when the vault is real.
 *
 * Everything on it is read from devnet through `useChainVault`: the account,
 * the share supplies, both oracles, the wallet's balances. The trade panel
 * signs real transactions. The health panel runs the SDK's `evaluate` on the
 * chain state. The ledger is the vault's own transaction history. None of it
 * is the local simulation — that path still serves the other assets, which
 * have no vault on chain yet, and says so.
 */
export function ChainVault({ m, asset }: { m: Devnet; asset: Asset }) {
  const { publicKey } = useWallet();
  const chain = useChainVault(m);
  /* One history, two readers. The ledger shows the last twenty; the statement
     needs further back to price a position opened before them, and fetching
     the same signatures twice is how a public RPC starts refusing. */
  const ledger = useLedger(m.vault, 60);
  /* The connected wallet's own trades, off its share accounts. A position is
     exact from those alone; only the comparison needs the vault's history. */
  const mine = useWalletTrades(m, publicKey);
  // A trade that lands should show up in both the history and the statement
  // immediately, not on the next poll.
  const settled = useCallback(
    () => { chain.refresh(); ledger.refresh(); mine.refresh(); },
    [chain.refresh, ledger.refresh, mine.refresh],
  );
  const curve = useCurve(asset.symbol);
  const clockSize = useClockSize(196, 72);

  if (chain.status === 'loading') return <ChainSkeleton symbol={asset.symbol} />;

  if (chain.status === 'error' && !chain.data) {
    return (
      <div className={`shell ${s.gate}`}>
        <p className="eyebrow">Devnet unreachable</p>
        <h1 className={`display ${s.gateTitle}`}>The vault could not be read.</h1>
        <p className={`lead ${s.gateBody}`}>
          {chain.error.message}. The public devnet RPC rate-limits; a reload usually
          gets through. Nothing here is guessed in the meantime.
        </p>
        <div className={s.gateActions}>
          <button className={s.primary} onClick={() => chain.refresh()}>Try again</button>
          <a className={s.secondary} href={explorerAddr(m.vault)} target="_blank" rel="noreferrer">Vault on Explorer ↗</a>
        </div>
      </div>
    );
  }

  const d = chain.data!;
  const v = d.vault;
  const qd = v.quoteDecimals;
  // One program, two vocabularies: an equity vault has a day and a night, an
  // event vault has only the stretch before the next print and the print.
  const isEvent = v.sessionKind === SESSION_EVENT;
  const label = (k: ShareClass) =>
    isEvent ? `${asset.symbol}.${k === 'night' ? 'THEN' : 'NOW'}` : `${asset.symbol}.${k.toUpperCase()}`;

  return (
    <div className={s.page}>
      <header className={`shell ${s.head}`}>
        <div className={s.crumbs}>
          <Link to="/markets">Markets</Link>
          <span aria-hidden="true">/</span>
          <span className="mono">{asset.symbol}</span>
        </div>

        <div className={s.headMain}>
          <div className={s.identity}>
            <div className={c.titleRow}>
              <h1 className={`mono ${s.symbol}`}>{asset.symbol}</h1>
              <span className={c.liveBadge}><span className={c.liveDot} aria-hidden="true" />Live · devnet</span>
            </div>
            <p className={s.name}>{asset.name}</p>

            <div className={s.priceRow}>
              <span className={`num ${s.price}`}>{d.markUsd !== null ? fmtUsd(d.markUsd) : '—'}</span>
              <span className={s.priceMeta} data-live={d.markAgeSecs !== null && d.markAgeSecs < v.maxStaleSecs} data-stale={d.markAgeSecs !== null && d.markAgeSecs >= v.maxStaleSecs}>
                {d.markAgeSecs === null ? 'mark unavailable'
                  : d.markAgeSecs >= v.maxStaleSecs ? `mark stale · ${Math.round(d.markAgeSecs / 60)}m`
                  : `pyth · ${m.markFeed} · ${d.markAgeSecs}s`}
              </span>
            </div>

            <dl className={s.quickFacts}>
              <div><dt>Vault</dt><dd><a className={`num ${c.addrLink}`} href={explorerAddr(m.vault)} target="_blank" rel="noreferrer">{short(m.vault, 6)} ↗</a></dd></div>
              <div><dt>Boundaries settled</dt><dd className="num">{v.boundaryCount.toString()}</dd></div>
              <div><dt>Slot</dt><dd className="num">{d.slot.toLocaleString()}</dd></div>
            </dl>
          </div>

          {isEvent ? (
            // No clock. A pre-IPO name has no session to count down to, and a
            // ring showing NYSE hours next to OPENAI would be a lie with a
            // timer on it. The event panel below carries its real clock.
            <div className={s.clockCol}>
              <p className={s.clockNote}>
                <strong data-holder={v.exposed}>{v.exposed === 'night' ? 'THEN' : 'NOW'}</strong> holds this vault.
                There is no bell here — the boundary is the next print, or a premium that runs.
              </p>
            </div>
          ) : (
            <div className={s.clockCol}>
              <SessionClock size={clockSize} compact />
              <ClockNote exposed={v.exposed} />
            </div>
          )}
        </div>
      </header>

      <DevnetNote m={m} isEvent={isEvent} />

      {/* ── the two classes ─────────────────────────────────────────────── */}
      <section className={`shell ${s.classes}`} aria-label="Share classes">
        {(['night', 'day'] as ShareClass[]).map(k => {
          const isExposed = v.exposed === k;
          const supply = k === 'night' ? d.nightSupply : d.daySupply;
          const value = k === 'night' ? d.valueNight : d.valueDay;
          const mine = d.me ? (k === 'night' ? d.me.night : d.me.day) : null;
          const study = k === 'night' ? asset.night : asset.day;
          const navK = k === 'night' ? v.nightNav : v.dayNav;
          return (
            <article key={k} className={s.classCard} data-class={k} data-exposed={isExposed}>
              <header className={s.classHead}>
                <div>
                  <span className={s.classTag}>{label(k)}</span>
                  <p className={s.classState}>
                    {isExposed
                      ? (isEvent ? 'Wearing the print and the premium' : 'Holding the stock')
                      : 'Flat — parked in quote'}
                  </p>
                </div>
                <span className={s.classBadge} data-on={isExposed}>{isExposed ? 'exposed' : 'parked'}</span>
              </header>
              <div className={s.navRow}>
                <span className={`num ${s.navValue}`}>{nav(navK).toFixed(4)}</span>
                <span className={s.navUnit}>NAV per share</span>
              </div>
              <dl className={s.classStats}>
                <div><dt>Supply</dt><dd className="num">{fromAtoms(supply, qd).toLocaleString('en-US', { maximumFractionDigits: 2 })}</dd></div>
                <div><dt>Class value</dt><dd className="num">{fmtUsd(fromAtoms(value, qd), 2)}</dd></div>
                <div>
                  <dt>You hold</dt>
                  <dd className="num" data-mine={!!mine && mine > 0n}>
                    {mine === null ? '—' : fromAtoms(mine, qd).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                  </dd>
                </div>
              </dl>
              {study && (
                <footer className={s.classStudy}>
                  <span>Measured, {Math.round(asset.days)}d</span>
                  <span className={`num ${s.classCum}`} data-sign={study.cumulative >= 0 ? 'up' : 'down'}>{fmtPct(study.cumulative, 1)}</span>
                  <span className={s.classT}>σ <span className="num">{(study.stdev * 100).toFixed(2)}%</span> · t <span className="num">{study.t.toFixed(2)}</span></span>
                </footer>
              )}
            </article>
          );
        })}
      </section>

      {/* ── chart + trade ───────────────────────────────────────────────── */}
      <section className={`shell ${s.body}`}>
        <div className={c.left}>
          {isEvent && <EventSession m={m} d={d} />}
          <div className={`card ${s.chartCard}`}>
            <header className={s.cardHead}>
              <div>
                <h2 className={s.cardTitle}>
                  {isEvent ? 'The same split, on an asset with no session' : 'Decomposed since inception'}
                </h2>
                <p className={s.cardSub}>
                  {isEvent ? (
                    /* This curve is cut by NYSE hours, and OPENAI does not have
                       any — so it is a control, not this vault's rule. Labelling
                       it "decomposed since inception" beside a vault that splits
                       on prints and premium would claim the chart shows what the
                       vault does, and it does not. */
                    <>{asset.symbol}&rsquo;s real pool history cut by <strong>NYSE hours</strong>,
                      which it does not have — the same control the study runs on GLDx. It is here
                      because the question is fair and the answer should be visible, not because
                      this vault uses it. <strong>This vault splits on the next print and on the
                      premium above</strong>, which is a different boundary entirely.</>
                  ) : (
                    <>{asset.symbol}&rsquo;s real pool history, split by session. The vault above
                      applies the same rule to whatever the mark does from here.</>
                  )}
                </p>
              </div>
            </header>
            {curve.status === 'ready'
              ? <CurveChart points={curve.data.points} height={300} label={`${asset.symbol}, night versus day cumulative return`} />
              : curve.status === 'error'
                ? <p className={s.cardError}>The history for {asset.symbol} could not be loaded.</p>
                : <div className="skeleton" style={{ width: '100%', height: 300 }} />}
          </div>

          <Crank d={d} onDone={settled} />
          <Statement mine={mine.events} mineState={mine.state} rows={ledger.rows} history={ledger.history} d={d} symbol={asset.symbol} label={label} />
          <Ledger {...ledger} dec={qd} label={label} />
        </div>

        <div className={s.side}>
          <Auction m={m} d={d} onDone={settled} />
          <ChainTrade m={m} chain={d} onDone={settled} />
          <ChainHealth d={d} />
          <Instrument m={m} d={d} />
        </div>
      </section>
    </div>
  );
}

/* ── pieces ──────────────────────────────────────────────────────────────── */

function ClockNote({ exposed }: { exposed: ShareClass }) {
  const sess = useSession();
  if (!sess) return <p className={s.clockNote}>Reading the session clock…</p>;
  return (
    <p className={s.clockNote}>
      <strong data-holder={exposed}>{exposed.toUpperCase()}</strong> holds this vault&rsquo;s stock.
      Handover in <span className="num">{countdown(sess.until)}</span>.
    </p>
  );
}

function DevnetNote({ m, isEvent }: { m: Devnet; isEvent: boolean }) {
  return (
    <div className={`shell ${c.noteWrap}`}>
      <div className={c.note} role="note">
        <span className={c.noteDot} aria-hidden="true" />
        {isEvent ? (
          <p>
            <strong>This vault is on Solana devnet.</strong> The program, both classes,
            settlement, funding, the handoff and every health signal are the real thing.
            The underlying is a devnet mint built to the same shape as the real{' '}
            <span className="mono">{m.symbol}</span> PreStock — Token-2022 with a 1% transfer
            fee, a scaled-UI multiplier, a permanent delegate and a pause switch — because
            those are the paths that have to work. The token itself is mainnet-only.{' '}
            <strong>The detector is not a stand-in:</strong> the mark and the executable price
            below are read live from prestocks.com and posted on chain.{' '}
            <Link to="/how-it-works#status" className={c.noteLink}>What is and is not live</Link>
          </p>
        ) : (
          <p>
            <strong>This vault is on Solana devnet.</strong> The program, both share
            classes, settlement, funding, the handoff and every health signal are the
            real thing. Two parts stand in: the underlying and quote are test mints
            (devnet has no xStocks or USDC), and the mark is fed by Pyth&rsquo;s{' '}
            <span className="mono">{m.markFeed}</span> because the NVDAX feed is not
            sponsored on devnet — on mainnet it is <span className="mono">Crypto.NVDAX/USD</span>.{' '}
            <Link to="/how-it-works#status" className={c.noteLink}>What is and is not live</Link>
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The crank, visible.
 *
 * Settlement is permissionless, so the page itself can keep the vault current:
 * when the calendar says a bell has passed and the vault has not settled it,
 * the page pings the crank endpoint, which settles and fills. A person can
 * also press the button. Either way the result is read back from the chain,
 * never assumed.
 */
function Crank({ d, onDone }: { d: ChainState; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ at: number; text: string; sig?: string; ok: boolean } | null>(null);
  const auto = useRef(0);
  /* An event vault has no calendar to crank against. Its tick is the reading:
     post the issuer's mark and the executable price, then settle against them
     if the premium has run. Same button, different endpoint, because from the
     reader's side it is the same act — bring the vault up to date. */
  const isEvent = d.vault.sessionKind === SESSION_EVENT;

  const run = useCallback(async (why: 'auto' | 'manual') => {
    setBusy(true);
    if (isEvent) {
      const r = await pingDetector();
      setBusy(false);
      const at = Math.floor(Date.now() / 1000);
      if ('error' in r) { setLast({ at, text: r.error, ok: false }); return; }
      const rep = r.report;
      const settled = rep.cranked && 'settled' in rep.cranked ? rep.cranked.settled : null;
      const premium = `premium ${(rep.premiumBps / 100).toFixed(2)}%`;
      if (settled && 'signature' in settled) {
        setLast({ at, ok: true, sig: settled.signature, text: `Boundary settled at ${premium}` });
        onDone();
      } else if ('signature' in rep.posted) {
        setLast({
          at, ok: true, sig: rep.posted.signature,
          text: `Reading posted — mark $${rep.mark.toFixed(2)}, executable $${rep.executable.toFixed(2)}, ${premium}`
            + (rep.overToleranceBps !== null ? ` — past tolerance by ${(rep.overToleranceBps / 100).toFixed(2)}%` : ''),
        });
        onDone();
      } else if ('failed' in rep.posted) {
        setLast({ at, ok: false, text: `Could not post the reading: ${rep.posted.failed}` });
      } else {
        setLast({ at, ok: true, text: `Reading is current — ${premium}` });
      }
      return;
    }
    const r = await pingCrank();
    setBusy(false);
    const at = Math.floor(Date.now() / 1000);
    if ('error' in r) { setLast({ at, text: r.error, ok: false }); return; }
    const rep = r.report;
    if ('signature' in rep.settled) {
      const source = rep.markSource === 'hermes-as-of' ? ' at the bell\u2019s own print' : rep.markSource === 'sponsored' ? ' on the sponsored feed' : '';
      setLast({ at, ok: true, sig: rep.settled.signature, text: `Boundary settled${source}${rep.fills.length ? ` and handoff filled (${rep.fills.length})` : ''}` });
      onDone();
    } else if ('failed' in rep.settled) {
      setLast({ at, ok: false, text: `Settlement failed: ${rep.settled.failed}` });
    } else if (rep.fills.length) {
      setLast({ at, ok: true, sig: rep.fills[0].signature, text: `Handoff filled (${rep.fills.length})` });
      onDone();
    } else if (rep.fillError) {
      setLast({ at, ok: false, text: `Fill failed: ${rep.fillError}` });
    } else {
      setLast({ at, ok: true, text: why === 'manual' ? 'Nothing due — the vault is current' : 'Checked; nothing due' });
    }
  }, [onDone, isEvent]);

  // Ping once when a boundary is due, and not again for five minutes so a
  // page left open does not hammer the endpoint while a stale mark blocks it.
  useEffect(() => {
    if (!d.boundaryDue || d.vault.halted) return;
    const now = Date.now();
    if (now - auto.current < 5 * 60_000) return;
    auto.current = now;
    run('auto');
  }, [d.boundaryDue, d.vault.halted, run]);

  return (
    <div className={`card ${c.crank}`}>
      <div className={c.crankRow}>
        <div>
          <p className={c.crankTitle}>{isEvent ? 'The reading, and settlement' : 'Settlement'}</p>
          <p className={c.crankSub}>
            Last settled <span className="num">{etClock(d.vault.lastBoundaryTs)}</span> {etDate(d.vault.lastBoundaryTs)} ET
            {!isEvent && d.nextBoundaryTs !== null && (
              <> · next bell <span className="num">{etClock(d.nextBoundaryTs)}</span> {etDate(d.nextBoundaryTs)}</>
            )}
            {d.vault.pendingDelta !== 0n && (
              <> · handoff pending <span className="num">{fmtUsd(fromAtoms(d.vault.pendingDelta < 0n ? -d.vault.pendingDelta : d.vault.pendingDelta, d.vault.quoteDecimals), 2)}</span></>
            )}
          </p>
        </div>
        <button className={c.crankBtn} onClick={() => run('manual')} disabled={busy} data-due={d.boundaryDue}>
          {busy ? 'Running…' : d.boundaryDue ? 'Settle now' : isEvent ? 'Refresh the reading' : 'Check'}
        </button>
      </div>
      {last && (
        <p className={c.crankLast} data-ok={last.ok}>
          {last.text}
          {last.sig && <> · <a href={explorer(last.sig)} target="_blank" rel="noreferrer">transaction ↗</a></>}
        </p>
      )}
      <p className={c.crankNote}>
        {isEvent ? (
          <>No oracle prices a pre-IPO token, so this vault settles against a{' '}
            <strong>reading an operator posts</strong> — the issuer&rsquo;s mark and the price
            the token actually trades at, both read live from prestocks.com. The program
            bounds how stale that reading may be and records who posted it; it cannot make
            it true. Everything else here is enforced on chain.</>
        ) : (
          <>Anyone can settle: the program&rsquo;s <span className="mono">settle_boundary</span> takes
            no signer. This page pings the crank when its calendar says a bell has passed; the
            operator&rsquo;s inventory fills the handoff, which on mainnet is a market maker&rsquo;s job.</>
        )}
      </p>
    </div>
  );
}

function ChainHealth({ d }: { d: ChainState }) {
  const { health, vault: v } = d;
  const qd = v.quoteDecimals;
  const skewPct = Number(d.skew) / 1e18;
  return (
    <section className={`card ${h.card}`} aria-label="Vault health">
      <header className={h.head}>
        <h2 className={h.title}>Vault health</h2>
        <span className={h.badge} data-sev={health.severity}><span className={h.dot} aria-hidden="true" />{LABEL[health.severity]}</span>
      </header>
      <div className={h.funding}><FundingRate d={d} /></div>
      <dl className={h.metrics}>
        <div><dt>Backing</dt><dd className="num">{fmtUsd(fromAtoms(health.margin + d.valueNight + d.valueDay, qd), 2)}</dd></div>
        <div><dt>Claims</dt><dd className="num">{fmtUsd(fromAtoms(d.valueNight + d.valueDay, qd), 2)}</dd></div>
        <div><dt>Margin</dt><dd className="num" data-sign={health.margin >= 0n ? 'up' : 'down'}>{health.margin >= 0n ? '+' : '−'}{fmtUsd(Math.abs(fromAtoms(health.margin, qd)), 2)}</dd></div>
        <div><dt title="Night value minus day value, over their total">Skew</dt><dd className="num" data-side={skewPct >= 0 ? 'night' : 'day'}>{skewPct >= 0 ? '+' : '−'}{(Math.abs(skewPct) * 100).toFixed(1)}%</dd></div>
      </dl>
      {health.signals.length === 0 ? (
        <p className={h.clear}>No signals. Claims are fully backed, the handoff is flat and the last boundary settled on time.</p>
      ) : (
        <ul className={h.signals}>
          {health.signals.map(sig => (
            <li key={sig.id} className={h.signal} data-sev={sig.severity}>
              <span className={h.sigDot} aria-hidden="true" />
              <div>
                <p className={h.sigMsg}><span className={h.sigId}>{sig.id.replace(/-/g, ' ')}</span>{sig.message}</p>
                {sig.action && <p className={h.sigAction}>{sig.action}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {v.halted && (
        <p className={h.halted} role="alert"><strong>Halted — {v.haltReason}.</strong> Settlement has stopped. Redemption at the last good NAV is the only operation left.</p>
      )}
      <footer className={h.foot}>
        <p>Computed by the SDK&rsquo;s <span className="mono">evaluate()</span> on state read from devnet at slot <span className="num">{d.slot.toLocaleString()}</span> — the same function the keeper pages on.</p>
      </footer>
    </section>
  );
}

/** The vault's own transaction history, from the chain. */
function Ledger({ rows, error, dec, label }: {
  rows: LedgerRow[] | null;
  error: Error | null;
  dec: number;
  label: (c: ShareClass) => string;
}) {
  return (
    <section className={c.ledger}>
      <h2 className={s.cardTitle}>On-chain ledger</h2>
      <p className={s.cardSub}>
        Every transaction that touched this vault, newest first — and what the program
        itself said happened, decoded from the events it emitted. Nothing here is this
        site&rsquo;s account of it; the same rows can be rebuilt from the chain by anyone.
      </p>
      {error ? (
        <p className={c.ledgerNote}>Could not load history: {error.message}</p>
      ) : rows === null ? (
        <div className={c.ledgerSkel}>{Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton" style={{ height: 34 }} />)}</div>
      ) : rows.length === 0 ? (
        <p className={c.ledgerNote}>No transactions yet.</p>
      ) : (
        <ol className={s.events}>
          {rows.slice(0, 20).map(r => {
            // A transaction may emit several events — a settle that also
            // halted, a fill that paid an incentive. Each gets its own line;
            // one with none at all is still shown, because a transaction that
            // touched the vault and said nothing is itself worth seeing.
            const lines = r.events.length
              ? r.events.map(ev => ({ kind: kindOf(ev.name), text: describe(ev, dec, cl => label(cl as ShareClass)) }))
              : [{ kind: r.failed ? 'halt' : 'admin', text: r.failed ? 'Reverted — nothing was written' : 'Touched the vault without emitting an event' }];
            return lines.map((l, i) => (
              <li key={`${r.signature}-${i}`} className={s.event} data-kind={l.kind}>
                <span className={s.eventKind}>{l.kind}</span>
                <span className={s.eventWhen}>
                  {r.at
                    ? <><span className="num">{etClock(r.at)}</span><span className={s.eventDate}>{etDate(r.at)}</span></>
                    : <span className={s.eventDate}>pending</span>}
                </span>
                <span className={s.eventDetail}>
                  <span className={c.ledgerText}>{l.text}</span>
                  {i === 0 && (
                    <a className={`mono ${c.sig}`} href={explorer(r.signature)} target="_blank" rel="noreferrer">
                      {short(r.signature, 6)} ↗
                    </a>
                  )}
                </span>
              </li>
            ));
          })}
        </ol>
      )}
    </section>
  );
}

function ChainSkeleton({ symbol }: { symbol: string }) {
  return (
    <div className={s.page} aria-busy="true">
      <div className={`shell ${s.head}`}>
        {/* A page that is loading still has a name. Without this the document
            has no level-1 heading while the chain read is in flight, which is
            what a screen-reader user lands on and what the a11y pass caught
            intermittently — the race was the symptom, the missing heading was
            the bug. */}
        <h1 className="sr-only">{symbol} vault</h1>
        <div className="skeleton" style={{ width: 160, height: 12 }} />
        <div style={{ marginTop: 28, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="skeleton" style={{ width: 220, height: 38 }} />
          <div className="skeleton" style={{ width: 120, height: 14 }} />
          <div className="skeleton" style={{ width: 240, height: 30 }} />
        </div>
      </div>
      <div className={`shell ${s.classes}`}>
        <div className="skeleton" style={{ height: 210, borderRadius: 20 }} />
        <div className="skeleton" style={{ height: 210, borderRadius: 20 }} />
      </div>
      <p className="sr-only" role="status">Reading the vault from devnet</p>
    </div>
  );
}

export { Severity };
