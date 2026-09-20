import { fmtUsd } from '@/lib/data';
import { fromQuote, Severity, type Derived, type LocalVault } from '@/lib/localVault';
import s from './HealthPanel.module.css';

const LABEL: Record<string, string> = {
  ok: 'Healthy',
  notice: 'Notice',
  warning: 'Warning',
  critical: 'Critical',
};

/**
 * What the operator sees.
 *
 * Straight out of the SDK's `evaluate` — the same function the keeper runs and
 * the runbook is written against, so a signal shown here is a signal an
 * operator would actually be paged for. Each one carries what to *do*, because
 * a status light nobody can act on is decoration.
 */
export function HealthPanel({
  vault, derived, onReset,
}: {
  vault: LocalVault;
  derived: Derived;
  onReset: () => void;
}) {
  const { health, backing, totalClaims, margin, skew } = derived;
  const skewPct = Number(skew) / 1e18;

  return (
    <section className={`card ${s.card}`} aria-label="Vault health">
      <header className={s.head}>
        <h2 className={s.title}>Vault health</h2>
        <span className={s.badge} data-sev={health.severity}>
          <span className={s.dot} aria-hidden="true" />
          {LABEL[health.severity] ?? health.severity}
        </span>
      </header>

      <dl className={s.metrics}>
        <div>
          <dt>Backing</dt>
          <dd className="num">{fmtUsd(fromQuote(backing), 2)}</dd>
        </div>
        <div>
          <dt>Claims</dt>
          <dd className="num">{fmtUsd(fromQuote(totalClaims), 2)}</dd>
        </div>
        <div>
          <dt>Margin</dt>
          <dd className="num" data-sign={margin >= 0n ? 'up' : 'down'}>
            {margin >= 0n ? '+' : '−'}{fmtUsd(Math.abs(fromQuote(margin)), 2)}
          </dd>
        </div>
        <div>
          <dt title="Night value minus day value, over their total">Skew</dt>
          <dd className="num" data-side={skewPct >= 0 ? 'night' : 'day'}>
            {skewPct >= 0 ? '+' : '−'}{(Math.abs(skewPct) * 100).toFixed(1)}%
          </dd>
        </div>
      </dl>

      {health.signals.length === 0 ? (
        <p className={s.clear}>
          No signals. Claims are fully backed, the handoff is flat and the last
          boundary settled on time.
        </p>
      ) : (
        <ul className={s.signals}>
          {health.signals.map(sig => (
            <li key={sig.id} className={s.signal} data-sev={sig.severity}>
              <span className={s.sigDot} aria-hidden="true" />
              <div>
                <p className={s.sigMsg}>
                  <span className={s.sigId}>{sig.id.replace(/-/g, ' ')}</span>
                  {sig.message}
                </p>
                {sig.action && <p className={s.sigAction}>{sig.action}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}

      {vault.halted && (
        <p className={s.halted} role="alert">
          <strong>Halted — {vault.haltReason || 'unknown'}.</strong> Settlement
          has stopped rather than write a loss into the other class&rsquo;s
          backing. Redemption at the last good NAV is the only operation left.
        </p>
      )}

      <footer className={s.foot}>
        <p>
          This vault&rsquo;s balances live in this browser. Everything derived
          from them — NAV, funding, the handoff, these signals — runs the same
          code the program does.
        </p>
        <button className={s.reset} onClick={onReset}>Reset this vault</button>
      </footer>
    </section>
  );
}

export { Severity };
