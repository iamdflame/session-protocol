/* ───────────────────────────────────────────────────────────────────────────
   NVDA.DAY and NVDA.NIGHT — two halves of one mechanism.

   Everything on these cards is something the chain or the study actually
   says. A share class has no dollar price: what it has is a NAV per share in
   the vault's quote (read from the vault account), a measured history (from
   the study), and a state — holding the stock, or parked in quote and open to
   mint. The live price of the underlying is shown once, above both, as what
   it is: NVDAx on mainnet, from Jupiter.

   The two halves are deliberately not the same card in two colours. DAY is
   the short, precise window; NIGHT is the long one that carries the gap, and
   its card says so with the volatility the study measured. Between them sits
   the hinge — the next handoff — because that is the product.
   ─────────────────────────────────────────────────────────────────────────── */

import { useSession, useHandoff, etClock, upcoming } from '@/lib/session';
import type { ChainVault as ChainState } from '@/lib/chain';
import type { Asset } from '@/lib/data';
import { Button } from '../ui/Button';
import { ClassTag, Status } from '../ui/Status';
import { Source } from '../ui/Source';
import { Delta, Countdown } from '../ui/Figures';
import { Icon } from '../ui/Icon';
import s from './ClassPair.module.css';

type Cls = 'day' | 'night';

const nav = (x: bigint) => Number(x) / 1e18;

function whenNext(cls: Cls, exposed: Cls | null, now: number) {
  // The next boundary that changes this class's role, from the calendar.
  const next = upcoming(now, 2);
  const into = next.find(b => (exposed === cls ? b.to !== cls.toUpperCase() : b.to === cls.toUpperCase()));
  return into ?? null;
}

export function ClassPair({ asset, chain, vaultSymbol, tradeHref, compact }: {
  asset: Asset | undefined;
  chain: ChainState | null;
  vaultSymbol: string;
  /** Where "Mint" goes; `?class=` is appended. */
  tradeHref: string;
  compact?: boolean;
}) {
  const sess = useSession();
  const handoff = useHandoff();
  const exposed: Cls | null = chain ? (chain.vault.exposed as Cls) : null;
  const halted = chain?.vault.halted ?? false;
  /* The bell has rung but the vault has not been cranked yet: the calendar and
     the chain disagree about who holds the stock, and the chain is right until
     the settlement lands. Said plainly rather than papered over. */
  const settling = !!(sess && exposed && sess.holder.toLowerCase() !== exposed);

  const card = (cls: Cls) => {
    const isExposed = exposed === cls;
    const parked = exposed !== null && !isExposed;
    const stats = cls === 'day' ? asset?.day : asset?.night;
    const navVal = chain ? nav(cls === 'day' ? chain.vault.dayNav : chain.vault.nightNav) : null;
    const supply = chain ? Number(cls === 'day' ? chain.daySupply : chain.nightSupply) / 10 ** chain.vault.quoteDecimals : null;
    const next = sess ? whenNext(cls, exposed, sess.now) : null;
    const nextAt = next ? `${etClock(next.at)} ET${next.label === 'Today' ? '' : ` · ${next.label}`}` : '—';
    const upper = cls.toUpperCase();

    return (
      <article className={s.card} data-class={cls} data-exposed={isExposed || undefined} data-handoff={handoff.active || undefined}
               aria-label={`${vaultSymbol}.${upper}`}>
        <header className={s.head}>
          <ClassTag cls={cls} active={isExposed} />
          <span className={`mono ${s.ticker}`}>{vaultSymbol}.{upper}</span>
        </header>
        <p className={s.role}>{cls === 'day' ? 'Regular session · 09:30–16:00 ET' : 'Overnight, weekends and holidays'}</p>

        <div className={s.state}>
          {halted ? <Status kind="halted" label="Vault halted" />
            : exposed === null ? <span className="skeleton" style={{ width: 120, height: 14 }} />
            : settling ? <Status kind="handoff" label={isExposed ? 'Handing off · settling' : 'Taking over · settling'} />
            : isExposed ? <Status kind="live" label="Holding the stock" pulse />
            : <Status kind="mint-available" label="Parked in quote · mint open" />}
        </div>

        <dl className={s.figs}>
          <div className={s.fig}>
            <dt>NAV <span className={s.unit}>quote / share</span></dt>
            <dd className={`num ${s.nav}`} data-field="nav">{navVal === null ? <span className="skeleton" style={{ width: 90, height: 26, display: 'inline-block' }} /> : navVal.toFixed(6)}</dd>
            <Source kind="chain" detail={`${vaultSymbol} vault account, devnet`} ageSec={chain ? Math.max(0, Math.floor(Date.now() / 1000) - chain.fetchedAt) : null} />
          </div>
          {!compact && (
            <div className={s.fig}>
              <dt>In class</dt>
              <dd className="num" data-field="supply">{supply === null ? '—' : supply.toLocaleString('en-US', { maximumFractionDigits: 0 })}<span className={s.unit}> shares</span></dd>
            </div>
          )}
          <div className={s.fig}>
            <dt>Measured, {asset ? Math.round(asset.days) : '—'}d</dt>
            <dd><Delta value={stats?.cumulative ?? null} /></dd>
            <span className={s.sub}>σ {stats ? (stats.stdev * 100).toFixed(2) : '—'}% per session</span>
          </div>
        </dl>

        <p className={s.next}>
          <Icon name="clock" size={13} />
          {settling ? <>The bell has rung; the vault settles on the next crank.</>
            : isExposed ? <>Hands the stock to {cls === 'day' ? 'NIGHT' : 'DAY'} at <span className="num">{nextAt}</span></>
            : <>Takes the stock at <span className="num">{nextAt}</span></>}
        </p>

        <div className={s.act}>
          {parked && !halted ? (
            <Button to={`${tradeHref}${tradeHref.includes('?') ? '&' : '?'}class=${cls}`} tone={cls} block>
              Mint {upper}
            </Button>
          ) : (
            <>
              <Button tone={cls} block disabled aria-describedby={`why-${cls}`}>
                {upper} mint {halted ? 'paused' : 'closed'}
              </Button>
              <p className={s.why} id={`why-${cls}`}>
                {halted ? 'The vault is halted; nothing mints until it resumes.'
                  : exposed === null ? 'Reading the vault…'
                  : <>{upper} holds the stock, so it cannot be issued. Reopens at <span className="num">{next ? etClock(next.at) : '—'} ET</span>.</>}
              </p>
            </>
          )}
        </div>
      </article>
    );
  };

  const nextHandoff = sess?.next ?? null;
  return (
    <section className={s.pair} data-compact={compact || undefined} aria-label={`${vaultSymbol}.DAY and ${vaultSymbol}.NIGHT`}>
      {card('day')}
      <div className={s.hinge} aria-hidden={!sess}>
        <span className={s.hingeLine} />
        <span className={s.hingeBox} data-to={sess?.handsTo.toLowerCase()}>
          <span className={s.hingeLabel}>Next handoff</span>
          {sess ? <Countdown seconds={sess.until} className={s.hingeTime} label="Next handoff in" /> : <span className="skeleton" style={{ width: 80, height: 18 }} />}
          <span className={s.hingeTo}>{sess ? <>{sess.holder} → {sess.handsTo}{nextHandoff ? <> · {etClock(nextHandoff)} ET</> : null}</> : null}</span>
        </span>
        <span className={s.hingeLine} />
      </div>
      {card('night')}
    </section>
  );
}
