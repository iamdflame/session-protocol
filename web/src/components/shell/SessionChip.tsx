/* The market, in the chrome.
 *
 * Most products put a theme toggle here. This puts the three facts a holder
 * checks most: is NYSE open, which class is carrying the stock, and how long
 * until it hands over. On a pre-IPO page it stands down — a countdown to 16:00
 * above a company with no exchange session would be a clock for a market that
 * name does not trade on. */
import { useLocation } from 'react-router-dom';
import { useSession, closureReason } from '@/lib/session';
import { useDevnets } from '@/lib/chain';
import { SESSION_EVENT } from '@sdk/vault.ts';
import { Countdown } from '../ui/Figures';
import s from './Shell.module.css';

export function useIsEventPage(): boolean {
  const { pathname } = useLocation();
  const devnets = useDevnets();
  const symbol = pathname.startsWith('/markets/') ? decodeURIComponent(pathname.slice(9)) : null;
  return !!symbol && !!devnets?.some(m => m.symbol === symbol && m.sessionKind === SESSION_EVENT);
}

export function SessionChip({ compact = false }: { compact?: boolean }) {
  const sess = useSession();
  const event = useIsEventPage();

  if (event) {
    return (
      <div className={s.chip} data-compact={compact || undefined} title="This name is private: no exchange session, so no bell.">
        <span className={s.chipDot} data-off="true" aria-hidden="true" />
        <span className={s.chipMarket}>No session</span>
      </div>
    );
  }
  if (!sess) {
    return <div className={s.chip} data-compact={compact || undefined} aria-hidden="true"><span className="skeleton" style={{ width: compact ? 90 : 190, height: 12 }} /></div>;
  }
  const cls = sess.holder.toLowerCase() as 'day' | 'night';
  const why = sess.isOpen ? null : closureReason(sess.now);
  return (
    <div
      className={s.chip} data-cls={cls} data-holder={cls} data-compact={compact || undefined}
      role="status" aria-live="off"
      title={`NYSE is ${sess.isOpen ? 'open' : 'closed'}${why ? ` (${why.toLowerCase()})` : ''}. ${sess.holder} carries the stock; ${sess.handsTo} takes it in the next handoff.`}
    >
      <span className={s.chipDot} aria-hidden="true" />
      <span className={s.chipMarket}>NYSE {sess.isOpen ? 'open' : 'closed'}</span>
      <span className={s.chipSep} aria-hidden="true" />
      <span className={s.chipClass}>{sess.holder}{compact ? '' : ' active'}</span>
      <span className={s.chipSep} aria-hidden="true" />
      <Countdown seconds={sess.until} className={s.chipTime} label={`Next handoff in`} />
      <span className="sr-only">{`${sess.holder} carries the exposure. ${sess.handsTo} takes it at the next handoff.`}</span>
    </div>
  );
}
