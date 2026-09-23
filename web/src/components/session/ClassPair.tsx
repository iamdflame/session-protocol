/* ───────────────────────────────────────────────────────────────────────────
   NVDA.DAY and NVDA.NIGHT — two halves of one mechanism.

   Everything on these cards is something the chain, the simulation or the
   study actually says. A share class has no dollar price: what it has is a
   NAV per share in the vault's quote, a measured history (from the study),
   and a state — holding the stock, or parked in quote and open to mint. The
   live price of the underlying is shown elsewhere, once, as what it is.

   The two halves are deliberately not the same card in two colours. DAY is
   the short, precise window; NIGHT is the long one that carries the gap, and
   its card says so with the volatility the study measured. Between them sits
   the hinge — the next handoff — because that is the product.

   The cards take a `PairState` rather than a chain account, so the vault on
   devnet and the simulation in this browser draw the same surface and differ
   only in the source badge each figure carries.
   ─────────────────────────────────────────────────────────────────────────── */

import type { ReactNode } from 'react';
import { useSession, useHandoff, etClock, upcoming } from '@/lib/session';
import { SESSION_EVENT } from '@sdk/vault.ts';
import type { ChainVault as ChainState } from '@/lib/chain';
import { fmtUsd, type Asset } from '@/lib/data';
import { Button } from '../ui/Button';
import { ClassTag, Status } from '../ui/Status';
import { Source, type SourceKind } from '../ui/Source';
import { Delta, Countdown } from '../ui/Figures';
import { Icon } from '../ui/Icon';
import s from './ClassPair.module.css';

type Cls = 'day' | 'night';

/** What a pair of cards needs, from whichever vault is behind them. */
export interface PairState {
  exposed: Cls;
  halted: boolean;
  /** An event vault: NOW/THEN, no calendar. */
  event: boolean;
  nav: Record<Cls, number>;
  supply: Record<Cls, number>;
  /** Class value in quote: supply × NAV. */
  value: Record<Cls, number>;
  /** Shares this reader holds; null when there is no way to know (no wallet). */
  held: Record<Cls, number | null>;
  source: { kind: SourceKind; detail: string; ageSec: number | null };
}

const atoms = (v: bigint, d: number) => Number(v) / 10 ** d;

export function pairFromChain(d: ChainState, detail: string): PairState {
  const qd = d.vault.quoteDecimals;
  return {
    exposed: d.vault.exposed as Cls,
    halted: d.vault.halted,
    event: d.vault.sessionKind === SESSION_EVENT,
    nav: { day: Number(d.vault.dayNav) / 1e18, night: Number(d.vault.nightNav) / 1e18 },
    supply: { day: atoms(d.daySupply, qd), night: atoms(d.nightSupply, qd) },
    value: { day: atoms(d.valueDay, qd), night: atoms(d.valueNight, qd) },
    held: d.me ? { day: atoms(d.me.day, qd), night: atoms(d.me.night, qd) } : { day: null, night: null },
    source: { kind: 'chain', detail, ageSec: Math.max(0, Math.floor(Date.now() / 1000) - d.fetchedAt) },
  };
}

const WORDS = { equity: { day: 'DAY', night: 'NIGHT' }, event: { day: 'NOW', night: 'THEN' } } as const;
const ROLE = {
  equity: { day: 'Regular session, 09:30–16:00 ET · no overnight gap', night: 'Overnight, weekends, holidays · carries the gap' },
  event: { day: 'Holds the token while the premium stays in range', night: 'Wears a print, or a premium past tolerance' },
} as const;

const qty = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

function whenNext(cls: Cls, exposed: Cls | null, now: number) {
  // The next boundary that changes this class's role, from the calendar.
  const next = upcoming(now, 2);
  return next.find(b => (exposed === cls ? b.to !== cls.toUpperCase() : b.to === cls.toUpperCase())) ?? null;
}

export function ClassPair({ asset, state, vaultSymbol, tradeHref, onMint, compact, detailed, hinge, virtual }: {
  asset: Asset | undefined;
  state: PairState | null;
  vaultSymbol: string;
  /** Where "Mint" goes; `?class=` is appended. Ignored when `onMint` is given. */
  tradeHref?: string;
  /** On a page with its own trade panel, minting selects the class there. */
  onMint?: (cls: Cls) => void;
  compact?: boolean;
  /** The asset page: adds class value and the reader's own holding. */
  detailed?: boolean;
  /** Replaces the calendar hinge — an event vault has no bell to count to. */
  hinge?: ReactNode;
  /** A sandbox with its own clock (the demo): no comparison against the live
      calendar, whose bells are not this vault's. */
  virtual?: boolean;
}) {
  const sess = useSession();
  const handoff = useHandoff();
  const exposed: Cls | null = state ? state.exposed : null;
  const halted = state?.halted ?? false;
  const event = state?.event ?? false;
  const vocab = event ? 'event' : 'equity';
  /* The bell has rung but the vault has not been cranked yet: the calendar and
     the chain disagree about who holds the stock, and the chain is right until
     the settlement lands. Said plainly rather than papered over. An event
     vault has no calendar to disagree with. */
  const settling = !!(!event && !virtual && sess && exposed && sess.holder.toLowerCase() !== exposed);

  const card = (cls: Cls) => {
    const isExposed = exposed === cls;
    const parked = exposed !== null && !isExposed;
    const stats = cls === 'day' ? asset?.day : asset?.night;
    const word = WORDS[vocab][cls];
    const next = sess && !event && !virtual ? whenNext(cls, exposed, sess.now) : null;
    const nextAt = next ? `${etClock(next.at)} ET${next.label === 'Today' ? '' : ` · ${next.label}`}` : '—';
    const held = state ? state.held[cls] : null;

    return (
      <article className={s.card} data-class={cls} data-exposed={isExposed || undefined} data-handoff={handoff.active || undefined}
               aria-label={`${vaultSymbol}.${word}`}>
        <header className={s.head}>
          <ClassTag cls={cls} active={isExposed}>{word}</ClassTag>
          <span className={`mono ${s.ticker}`}>{vaultSymbol}.{word}</span>
        </header>
        <p className={s.role}>{ROLE[vocab][cls]}</p>

        <div className={s.state}>
          {halted ? <Status kind="halted" label="Vault halted" />
            : exposed === null ? <span className="skeleton" style={{ width: 120, height: 14 }} />
            : settling ? <Status kind="handoff" label={isExposed ? 'Handing off · settling' : 'Taking over · settling'} />
            : isExposed ? <Status kind="live" label={event ? 'Holding the token' : 'Holding the stock'} pulse />
            : <Status kind="mint-available" label="Parked in quote · mint open" />}
        </div>

        {/* NAV is the figure a class is priced at, so it leads; everything else
            is a row — label left, value right — which stays legible at the
            width of half a column, where side-by-side figures collide. */}
        <div className={s.navBlock}>
          <span className={s.navLabel}>NAV <span className={s.unit}>quote per share</span></span>
          <span className={s.navLine}>
            <span className={`num ${s.nav}`} data-field="nav">
              {state ? state.nav[cls].toFixed(6) : <span className="skeleton" style={{ width: 110, height: 26, display: 'inline-block' }} />}
            </span>
            {state && <Source kind={state.source.kind} detail={state.source.detail} ageSec={state.source.ageSec} />}
          </span>
        </div>

        <dl className={s.rows}>
          {!compact && (
            <div>
              <dt>In class</dt>
              <dd>
                <span className="num" data-field="supply">{state ? qty(state.supply[cls]) : '—'}</span>
                {detailed && <span className={s.subVal}><span className="num" data-field="value">{state ? fmtUsd(state.value[cls], 2) : '—'}</span></span>}
              </dd>
            </div>
          )}
          {detailed && (
            <div>
              <dt>You hold</dt>
              <dd data-mine={!!held || undefined}>
                <span className="num" data-field="held">{held === null ? '—' : qty(held)}</span>
                <span className={s.subVal}>
                  {held === null ? 'no wallet'
                    : held > 0 && state ? <span className="num">{fmtUsd(held * state.nav[cls], 2)}</span>
                    : 'none'}
                </span>
              </dd>
            </div>
          )}
          <div>
            <dt>Measured, {asset ? Math.round(asset.days) : '—'}d</dt>
            <dd><Delta value={stats?.cumulative ?? null} /></dd>
          </div>
          <div>
            <dt>σ per session</dt>
            <dd className="num">{stats ? `${(stats.stdev * 100).toFixed(2)}%` : '—'}</dd>
          </div>
        </dl>

        {!event && (
          <p className={s.next}>
            <Icon name="clock" size={13} />
            <span>
              {settling ? <>The bell has rung; the vault settles on the next crank.</>
                : virtual ? (isExposed ? <>Hands the stock to {cls === 'day' ? 'NIGHT' : 'DAY'} at the sandbox&rsquo;s next bell</> : <>Takes the stock at the sandbox&rsquo;s next bell</>)
                : isExposed ? <>Hands the stock to {cls === 'day' ? 'NIGHT' : 'DAY'} at <span className="num">{nextAt}</span></>
                : <>Takes the stock at <span className="num">{nextAt}</span></>}
            </span>
          </p>
        )}

        <div className={s.act}>
          {parked && !halted ? (
            onMint
              ? <Button tone={cls} block onClick={() => onMint(cls)}>Mint {word}</Button>
              : <Button to={`${tradeHref ?? '/trade'}${(tradeHref ?? '').includes('?') ? '&' : '?'}class=${cls}`} tone={cls} block>Mint {word}</Button>
          ) : (
            <>
              <Button tone={cls} block disabled aria-describedby={`why-${vaultSymbol}-${cls}`}>
                {word} mint {halted ? 'paused' : 'closed'}
              </Button>
              <p className={s.why} id={`why-${vaultSymbol}-${cls}`}>
                {halted ? 'The vault is halted; the program refuses mint and redeem until it resumes.'
                  : exposed === null ? 'Reading the vault…'
                  : event ? <>{word} is holding the token, so it cannot be issued until the boundary moves it back to quote.</>
                  : virtual ? <>{word} holds the stock, so it cannot be issued until the next bell hands it back.</>
                  : <>{word} holds the stock, so it cannot be issued. Reopens at <span className="num">{next ? etClock(next.at) : '—'} ET</span>.</>}
              </p>
            </>
          )}
        </div>
      </article>
    );
  };

  const nextHandoff = sess?.next ?? null;
  return (
    <section className={s.pair} data-compact={compact || undefined} aria-label={`${vaultSymbol} share classes`}>
      {card('day')}
      <div className={s.hinge}>
        <span className={s.hingeLine} />
        {hinge ?? (
          <span className={s.hingeBox} data-to={sess?.handsTo.toLowerCase()}>
            <span className={s.hingeLabel}>Next handoff</span>
            {sess ? <Countdown seconds={sess.until} className={s.hingeTime} label="Next handoff in" /> : <span className="skeleton" style={{ width: 80, height: 18 }} />}
            <span className={s.hingeTo}>{sess ? <>{sess.holder} → {sess.handsTo}{nextHandoff ? <> · {etClock(nextHandoff)} ET</> : null}</> : null}</span>
          </span>
        )}
        <span className={s.hingeLine} />
      </div>
      {card('night')}
    </section>
  );
}

/** The hinge for an event vault: the next print, not a bell. */
export function EventHinge({ nextPrint }: { nextPrint: { ts: number } | null }) {
  const sess = useSession();
  const now = sess?.now ?? Math.floor(Date.now() / 1000);
  return (
    <span className={s.hingeBox}>
      <span className={s.hingeLabel}>Next print</span>
      {nextPrint
        ? <Countdown seconds={Math.max(0, nextPrint.ts - now)} className={s.hingeTime} label="Next print in" />
        : <span className={s.hingeTime}>none set</span>}
      <span className={s.hingeTo}>NOW ⇄ THEN</span>
    </span>
  );
}
