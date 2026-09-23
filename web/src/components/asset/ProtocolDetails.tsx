/* Protocol details: everything the program exposes about a vault, kept out of
 * the way of someone who came to mint, and one click away for someone who
 * came to check. Nothing in here is a summary of something on the page —
 * it is the layer underneath: the oracle, the settlement state, the claim
 * the instrument makes, the full ledger, every account by address. */
import { Link } from 'react-router-dom';
import type { Health } from '@sdk/health.ts';
import type { Vault } from '@sdk/vault.ts';
import { etClock, etDate } from '@/lib/session';
import { fmtUsd } from '@/lib/data';
import { explorer, explorerAddr, short, type Devnet, type ChainVault as ChainState, type LedgerRow } from '@/lib/chain';
import type { ShareClass } from '@/lib/localVault';
import { Instrument } from '../Instrument';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { ChainActivity } from './Activity';
import type { CrankResult } from './useCrank';
import s from './Asset.module.css';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={s.dSection}>
      <h3 className={s.dTitle}>{title}</h3>
      {children}
    </section>
  );
}

export function Signals({ health }: { health: Health }) {
  if (!health.signals.length) return <p className={s.clear}>No signals. Claims are fully backed, the handoff is flat and the last boundary settled on time.</p>;
  return (
    <ul className={s.signals}>
      {health.signals.map(sig => (
        <li key={sig.id} className={s.signal} data-sev={sig.severity}>
          <span className={s.sigDot} aria-hidden="true" />
          <div>
            <p className={s.sigMsg}><span className={s.sigId}>{sig.id.replace(/-/g, ' ')}</span>{sig.message}</p>
            {sig.action && <p className={s.sigAction}>{sig.action}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

function StandIns({ m, v, isEvent }: { m: Devnet; v: Vault; isEvent: boolean }) {
  return isEvent ? (
    <p className={s.dText}>
      The program, both classes, settlement, funding, the handoff and every health signal are the real
      thing on devnet. The underlying is a devnet mint built to the shape of the real{' '}
      <span className="mono">{m.symbol}</span> PreStock — Token-2022 with a 1% transfer fee, a scaled-UI
      multiplier, a permanent delegate and a pause switch — because those are the paths that have to work;
      the token itself is mainnet-only. <strong>The detector is not a stand-in:</strong> the issuer&rsquo;s mark
      and the executable price are read live from prestocks.com and posted on chain.
    </p>
  ) : (
    <p className={s.dText}>
      The program, both share classes, settlement, funding, the handoff and every health signal are the real
      thing on devnet. Three parts stand in: the underlying and quote are test mints (devnet has no xStocks
      or USDC); the mark is Pyth&rsquo;s <span className="mono">{m.markFeed}</span> because the NVDAX feed is not
      sponsored there — on mainnet it is <span className="mono">Crypto.NVDAX/USD</span>; and the bell&rsquo;s own
      print is not posted on this instance, so a settlement mark is accepted from{' '}
      {Math.round(v.maxBellLeadSecs / 60)} minutes before the bell to {Math.round(v.maxStaleSecs / 60)} after.
      For the same reason <span className="mono">require_verified_recap</span> is{' '}
      <strong>{v.requireVerifiedRecap ? 'on' : 'off'}</strong>
      {v.requireVerifiedRecap ? ': replaying a missed boundary must carry a Pyth update for each one.' : ': there would be no way to fetch a Pyth update for each missed boundary. On mainnet it is on.'}
    </p>
  );
}

export function ChainDetails({ m, d, ledger, label, crank }: {
  m: Devnet;
  d: ChainState;
  ledger: { rows: LedgerRow[] | null; error: Error | null };
  label: (c: ShareClass) => string;
  crank: { run: (why: 'manual') => void; busy: boolean; last: CrankResult | null; isEvent: boolean };
}) {
  const v = d.vault;
  const qd = v.quoteDecimals;
  const addrs: [string, string][] = [
    ['Vault', m.vault],
    ['Program', m.programId],
    [`${label('day')} mint`, m.dayMint],
    [`${label('night')} mint`, m.nightMint],
    ['Quote mint', m.quoteMint],
    ['Underlying mint', m.underlyingMint],
    ['Quote vault', m.quoteVault],
    ['Underlying vault', m.underlyingVault],
    [`Mark · ${m.markFeed}`, m.markPriceUpdate],
    ...(crank.isEvent ? [] : [[`Equity · ${m.equityFeed}`, m.equityPriceUpdate] as [string, string]]),
    ...(m.detector ? [['Detector', m.detector] as [string, string]] : []),
    ...(m.schedule ? [['Schedule', m.schedule] as [string, string]] : []),
    ['Operator', m.operator],
  ];
  const age = d.markAgeSecs;

  return (
    <div className={s.details}>
      <Section title="What is real here">
        <StandIns m={m} v={v} isEvent={crank.isEvent} />
        <Link to="/how-it-works#status" className={s.dLink}>What is and is not live <Icon name="chevronRight" size={12} /></Link>
      </Section>

      <Section title="Oracle">
        <dl className={s.kv}>
          <div><dt>Feed</dt><dd className="mono">{crank.isEvent ? 'operator-posted detector' : `Pyth ${m.markFeed}`}</dd></div>
          {!crank.isEvent && <div><dt>Mark</dt><dd className="num">{d.markUsd !== null ? fmtUsd(d.markUsd) : 'unavailable'}</dd></div>}
          {!crank.isEvent && <div><dt>Published</dt><dd className="num">{age === null ? '—' : `${age}s ago`} {age !== null && age > v.maxStaleSecs ? '· older than the vault accepts' : ''}</dd></div>}
          <div><dt>Accepted age</dt><dd className="num">{Math.round(v.maxStaleSecs / 60)} min</dd></div>
        </dl>
      </Section>

      <Section title={crank.isEvent ? 'The reading, and settlement' : 'Settlement'}>
        <dl className={s.kv}>
          <div><dt>Last settled</dt><dd className="num">{etClock(v.lastBoundaryTs)} ET · {etDate(v.lastBoundaryTs)}</dd></div>
          {!crank.isEvent && d.nextBoundaryTs !== null && <div><dt>Next bell</dt><dd className="num">{etClock(d.nextBoundaryTs)} ET · {etDate(d.nextBoundaryTs)}</dd></div>}
          <div><dt>Boundaries settled</dt><dd className="num">{v.boundaryCount.toString()}</dd></div>
          <div><dt>Handoff pending</dt><dd className="num">{v.pendingDelta === 0n ? 'none' : fmtUsd(Number(v.pendingDelta < 0n ? -v.pendingDelta : v.pendingDelta) / 10 ** qd, 2)}</dd></div>
          <div><dt>Slot</dt><dd className="num">{d.slot.toLocaleString()}</dd></div>
        </dl>
        <div className={s.crankRow}>
          <Button size="sm" variant={d.boundaryDue ? 'primary' : 'secondary'} onClick={() => crank.run('manual')} loading={crank.busy}>
            {d.boundaryDue ? 'Settle now' : crank.isEvent ? 'Refresh the reading' : 'Check'}
          </Button>
          {crank.last && (
            <p className={s.crankLast} data-ok={crank.last.ok} role="status">
              {crank.last.text}
              {crank.last.sig && <> · <a href={explorer(crank.last.sig)} target="_blank" rel="noreferrer">transaction <Icon name="external" size={11} /></a></>}
            </p>
          )}
        </div>
        <p className={s.dText}>
          {crank.isEvent
            ? <>No oracle prices a pre-IPO token, so this vault settles against a <strong>reading an operator posts</strong> — the issuer&rsquo;s mark and the price the token trades at, both read live from prestocks.com. The program bounds how stale that reading may be and records who posted it; it cannot make it true.</>
            : <>Anyone can settle: <span className="mono">settle_boundary</span> takes no signer. This page pings the crank when its calendar says a bell has passed; the operator&rsquo;s inventory fills the handoff, which on mainnet is a market maker&rsquo;s job.</>}
        </p>
      </Section>

      <Section title="Health signals">
        <Signals health={d.health} />
      </Section>

      <Section title="Instrument">
        <Instrument m={m} d={d} />
      </Section>

      <Section title="Ledger">
        <ChainActivity rows={ledger.rows} error={ledger.error} dec={qd} label={label} limit={20} />
      </Section>

      <Section title="Accounts">
        <ul className={s.addrs}>
          {addrs.map(([k, a]) => (
            <li key={k}>
              <span className={s.addrKey}>{k}</span>
              <a className="mono" href={explorerAddr(a)} target="_blank" rel="noreferrer">{short(a, 5)} <Icon name="external" size={11} /></a>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
