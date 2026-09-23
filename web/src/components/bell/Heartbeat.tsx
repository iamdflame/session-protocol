/* ───────────────────────────────────────────────────────────────────────────
   The bell, as the protocol's heartbeat.

   The next bell, huge; the time left to it, ticking; and the two classes as
   lanes running into it — the one holding the stock lit and filling as the
   stretch runs out, the other waiting at the bell to take over. When the bell
   rings the lanes trade places in one restrained move: the outgoing lane dims,
   the incoming one lights, the fill starts again from nothing. Under reduced
   motion the swap is instant.

   Beside the calendar's bell sits the chain's: when the vault last settled and
   whether it is current, read from the vault account, because a bell that has
   rung is only half the event until a transaction has settled it.
   ─────────────────────────────────────────────────────────────────────────── */

import { useSession, useHandoff, etClock, etDate, closureReason, countdown } from '@/lib/session';
import { explorer, short, type ChainVault as ChainState, type LedgerRow } from '@/lib/chain';
import { clock } from '../ui/Figures';
import { Status } from '../ui/Status';
import { Icon } from '../ui/Icon';
import s from './Heartbeat.module.css';

type Cls = 'day' | 'night';

export function Heartbeat({ vault, ledger }: { vault: ChainState | null; ledger: LedgerRow[] | null }) {
  const sess = useSession();
  const handoff = useHandoff(1400);

  if (!sess) {
    return (
      <section className={s.hero} aria-label="The next bell" aria-busy="true">
        <div className="skeleton" style={{ width: 280, height: 72 }} />
        <div className="skeleton" style={{ width: '100%', height: 90 }} />
      </section>
    );
  }

  const holder: Cls = sess.holder === 'DAY' ? 'day' : 'night';
  const next: Cls = holder === 'day' ? 'night' : 'day';
  const reason = sess.isOpen ? null : closureReason(sess.now);
  const kind = sess.handsTo === 'NIGHT' ? 'The closing bell' : 'The opening bell';
  const pct = Math.min(100, Math.max(0, sess.spanProgress * 100));

  // The chain's half: the last bell the vault settled, and the transaction.
  const lastSettle = ledger?.find(r => r.events.some(e => e.name === 'BoundarySettled')) ?? null;
  const reading = !!ledger?.some(r => !r.decoded && !r.failed);
  const v = vault?.vault;
  const state = !vault ? null
    : v!.halted ? { kind: 'halted' as const, text: `Halted — ${String(v!.haltReason)}` }
    : vault.boundaryDue ? { kind: 'stale' as const, text: 'Bell rung · settlement due' }
    : { kind: 'healthy' as const, text: 'Settled and current' };

  return (
    <section className={s.hero} aria-labelledby="bell-h" data-to={next} data-handoff={handoff.active || undefined}>
      <div className={s.glow} aria-hidden="true" />
      <div className={s.top}>
        <div className={s.when}>
          <span className={s.eyebrow}>{kind}{reason ? ` · after a ${reason.toLowerCase()}` : ''}</span>
          <h1 className={s.bellTime} id="bell-h">
            <span className="num">{sess.next ? etClock(sess.next) : '—'}</span><span className={s.et}> ET</span>
          </h1>
          <span className={s.date}>{sess.next ? etDate(sess.next) : ''} · {sess.holder} → {sess.handsTo}</span>
        </div>
        <div className={s.countWrap}>
          <span className={s.eyebrow}>Bell in</span>
          <span className={`num ${s.count}`} role="timer" aria-label={`Bell in ${countdown(sess.until)}`}>{clock(sess.until)}</span>
          {/* The stretch's start is found to the minute, so its length is too. */}
          <span className={s.date}>{countdown(Math.round(sess.spanTotal / 60) * 60)} {sess.isOpen ? 'session' : 'stretch'}</span>
        </div>
      </div>

      {/* the two lanes, running into the bell */}
      <div className={s.lanes} aria-hidden="true">
        {(['day', 'night'] as Cls[]).map(c => (
          <div key={c} className={s.lane} data-cls={c} data-on={c === holder || undefined}>
            <span className={s.laneName}>{c.toUpperCase()}</span>
            <span className={s.track}>
              {c === holder && <span className={s.fill} style={{ width: `${pct}%` }} />}
              <span className={s.dot} style={{ left: c === holder ? `${pct}%` : '100%' }} />
            </span>
            <span className={s.laneState}>{c === holder ? 'holding the stock' : 'takes over at the bell'}</span>
          </div>
        ))}
        <span className={s.bellLine}><span className={s.bellTag}>BELL</span></span>
        <span className={s.since}>since {etClock(sess.spanStart)} ET {etDate(sess.spanStart)}</span>
      </div>
      <p className="sr-only" aria-live="polite">
        {handoff.active && handoff.to ? `The bell has rung. ${handoff.to} now holds the stock.` : ''}
      </p>

      {/* the chain's half */}
      <dl className={s.chain}>
        <div>
          <dt>Vault</dt>
          <dd>{state ? <Status kind={state.kind} label={state.text} /> : <span className="skeleton" style={{ width: 140, height: 18 }} />}</dd>
        </div>
        <div>
          <dt>Last settled bell</dt>
          <dd className="num">{v ? <>{etClock(v.lastBoundaryTs)} ET · {etDate(v.lastBoundaryTs)}</> : '—'}</dd>
        </div>
        <div>
          <dt>Settled in</dt>
          <dd>
            {lastSettle
              ? <a className={`mono ${s.sig}`} href={explorer(lastSettle.signature)} target="_blank" rel="noreferrer">{short(lastSettle.signature, 5)} <Icon name="external" size={11} /></a>
              : ledger === null ? <span className="skeleton" style={{ width: 110, height: 14 }} />
              : reading ? <span className={s.muted}>reading the vault&rsquo;s transactions…</span>
              : <span className={s.muted}>not in the last {ledger.length} transactions</span>}
          </dd>
        </div>
        <div>
          <dt>Bells settled</dt>
          <dd className="num">{v ? v.boundaryCount.toString() : '—'}</dd>
        </div>
      </dl>
    </section>
  );
}
