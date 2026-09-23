/* Vault health, the part a holder needs: is every claim backed, and is
 * anything wrong. The figures come straight out of the SDK's `evaluate` —
 * the same function the keeper runs and the runbook is written against — so
 * a signal shown here is one an operator would actually be paged for. */
import type { ReactNode } from 'react';
import type { Health } from '@sdk/health.ts';
import { fmtUsd } from '@/lib/data';
import { Status } from '../ui/Status';
import s from './Asset.module.css';

const LABEL: Record<string, string> = { ok: 'Healthy', notice: 'Notice', warning: 'Warning', critical: 'Critical' };

export function HealthCard({ health, backing, claims, margin, skew, halted, foot, action, signalsLimit = 2, onMore }: {
  health: Health;
  /** In quote units. */
  backing: number;
  claims: number;
  margin: number;
  /** Night value minus day value, over their total: −1 … +1. */
  skew: number;
  halted: string | null;
  /** Provenance: where these numbers were computed. */
  foot: ReactNode;
  action?: ReactNode;
  /** Signals shown here; the rest are one click away in the protocol details. */
  signalsLimit?: number;
  onMore?: () => void;
}) {
  const shown = health.signals.slice(0, signalsLimit);
  const hidden = health.signals.length - shown.length;
  const kind = halted ? 'halted' : health.severity === 'ok' ? 'healthy' : health.severity === 'critical' ? 'halted' : 'stale';
  return (
    <section className={s.card} aria-label="Vault health">
      <header className={s.cardHead}>
        <h2 className={s.cardTitle}>Vault health</h2>
        <Status kind={kind} label={halted ? 'Halted' : LABEL[health.severity]} />
      </header>
      <dl className={s.metrics}>
        <div><dt>Backing</dt><dd className="num">{fmtUsd(backing, 2)}</dd></div>
        <div><dt>Claims</dt><dd className="num">{fmtUsd(claims, 2)}</dd></div>
        <div><dt>Margin</dt><dd className="num" data-sign={margin >= 0 ? 'pos' : 'neg'}>{margin >= 0 ? '+' : '−'}{fmtUsd(Math.abs(margin), 2)}</dd></div>
        <div>
          <dt title="Night value minus day value, over their total">Skew</dt>
          <dd className="num" data-side={Math.abs(skew) < 0.0005 ? undefined : skew > 0 ? 'night' : 'day'}>
            {Math.abs(skew) < 0.0005 ? '' : skew > 0 ? '+' : '−'}{(Math.abs(skew) * 100).toFixed(1)}%
          </dd>
        </div>
      </dl>
      {halted && (
        <p className={s.halted} role="alert">
          <strong>Halted — {halted}.</strong> Settlement has stopped rather than write a loss into the other
          class&rsquo;s backing. The program refuses mint and redeem alike until the missed bells are replayed
          and the vault is resumed.
        </p>
      )}
      {health.signals.length === 0 ? (
        <p className={s.clear}>No signals. Claims are fully backed, the handoff is flat and the last boundary settled on time.</p>
      ) : (
        <ul className={s.signals}>
          {shown.map(sig => (
            <li key={sig.id} className={s.signal} data-sev={sig.severity}>
              <span className={s.sigDot} aria-hidden="true" />
              <div>
                <p className={s.sigMsg}><span className={s.sigId}>{sig.id.replace(/-/g, ' ')}</span>{sig.message}</p>
                {sig.action && <p className={s.sigAction}>{sig.action}</p>}
              </div>
            </li>
          ))}
          {hidden > 0 && onMore && (
            <li><button type="button" className={s.linkBtn} onClick={onMore}>{hidden} more in protocol details</button></li>
          )}
        </ul>
      )}
      <footer className={s.cardFoot}>
        <p>{foot}</p>
        {action}
      </footer>
    </section>
  );
}
