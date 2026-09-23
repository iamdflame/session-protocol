/* Session status, immediately under the price: which class is active, when
 * the next handoff is, and the day drawn as the rail. When the calendar and
 * the vault disagree — the bell has rung and the crank has not landed — the
 * strip says so and offers to settle, because that is the one moment a
 * reader's exposure is not what the clock says it is. */
import { useSession, etClock, closureReason } from '@/lib/session';
import { SessionRail } from '../session/SessionRail';
import { ClassTag } from '../ui/Status';
import { Countdown } from '../ui/Figures';
import { Button } from '../ui/Button';
import s from './Asset.module.css';

type Cls = 'day' | 'night';

export function SessionStrip({ symbol, exposed, due, onSettle, settling }: {
  symbol: string;
  /** Who holds the stock in this vault, per the vault — null while reading. */
  exposed: Cls | null;
  /** The calendar has passed a bell the vault has not settled. */
  due?: boolean;
  onSettle?: () => void;
  settling?: boolean;
}) {
  const sess = useSession();
  if (!sess) {
    return (
      <section className={s.strip} aria-label="Session status" aria-busy="true">
        <div className="skeleton" style={{ width: '60%', height: 22 }} />
        <div className="skeleton" style={{ width: '100%', height: 40 }} />
      </section>
    );
  }
  const active: Cls = sess.holder === 'DAY' ? 'day' : 'night';
  const closure = sess.isOpen ? null : closureReason(sess.now);
  const behind = !!exposed && exposed !== active;

  return (
    <section className={s.strip} aria-label="Session status" data-active={active}>
      <div className={s.stripTop}>
        <div className={s.stripNow}>
          <span className={s.stripEyebrow}>Session status</span>
          <span className={s.stripActive}>
            <ClassTag cls={active} active>{sess.holder}</ClassTag>
            <strong data-holder={active}>{sess.holder} active</strong>
            <span className={s.stripWhy}>{sess.isOpen ? 'NYSE regular session' : closure ?? 'NYSE closed'}</span>
          </span>
        </div>
        <div className={s.stripNext}>
          <span className={s.stripEyebrow}>Next handoff</span>
          <span className={s.stripClock}>
            <Countdown seconds={sess.until} className={s.stripCount} label="Next handoff in" />
            <span className={s.stripTo}>{sess.holder} → {sess.handsTo}{sess.next ? <> · <span className="num">{etClock(sess.next)} ET</span></> : null}</span>
          </span>
        </div>
      </div>
      <SessionRail size="md" label={`${symbol} session rail`} />
      {behind && (
        <div className={s.behind} role="status">
          <span>
            <strong>The bell has rung; this vault has not settled it yet.</strong>{' '}
            {exposed?.toUpperCase()} still holds the stock on chain until the crank lands{due ? '' : ' — it runs every few minutes around each bell'}.
          </span>
          {onSettle && (
            <Button size="sm" variant="secondary" onClick={onSettle} loading={settling}>Settle now</Button>
          )}
        </div>
      )}
    </section>
  );
}
