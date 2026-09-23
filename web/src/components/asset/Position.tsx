/* Your position in this vault, and what the next bell does to it.
 *
 * The one question a holder of a session class has that a holder of a stock
 * never does: at the next bell, am I about to hold the stock, or about to be
 * sitting in quote? That answer is computed here from the calendar and the
 * vault's own state, never assumed. */
import { useSession, etClock } from '@/lib/session';
import { fmtUsd } from '@/lib/data';
import { holdingChange, type BellPreview } from '@/lib/bell';
import { Button } from '../ui/Button';
import { ClassTag } from '../ui/Status';
import { Icon } from '../ui/Icon';
import s from './Asset.module.css';

type Cls = 'day' | 'night';

export function Position({ names, words, held, nav, exposed, event, wallet, empty, preview }: {
  names: Record<Cls, string>;
  words: Record<Cls, string>;
  held: Record<Cls, number | null>;
  nav: Record<Cls, number>;
  exposed: Cls;
  event: boolean;
  /** Present on a live vault: whether a wallet is connected, and how to connect one. */
  wallet?: { connected: boolean; connect: () => void };
  /** What to say when nothing is held. */
  empty: React.ReactNode;
  /** The program's `settle()` run at the live mark: what the bell would do. */
  preview?: BellPreview | null;
}) {
  const sess = useSession();
  if (wallet && !wallet.connected) {
    return (
      <section className={s.card} aria-label="Your position">
        <header className={s.cardHead}><h2 className={s.cardTitle}>Your position</h2></header>
        <div className={s.emptyRow}>
          <p>Connect a wallet to see what you hold in this vault and what the next bell does to it.</p>
          <Button size="sm" variant="secondary" onClick={wallet.connect}><Icon name="wallet" size={14} /> Connect wallet</Button>
        </div>
      </section>
    );
  }
  const rows = (['day', 'night'] as Cls[]).filter(k => (held[k] ?? 0) > 0);
  const total = rows.reduce((t, k) => t + (held[k] ?? 0) * nav[k], 0);
  const parked: Cls = exposed === 'day' ? 'night' : 'day';

  return (
    <section className={s.card} aria-label="Your position">
      <header className={s.cardHead}>
        <h2 className={s.cardTitle}>Your position</h2>
        {rows.length > 0 && <span className={`num ${s.total}`}>{fmtUsd(total, 2)} <span className={s.totalLabel}>at NAV</span></span>}
      </header>
      {rows.length === 0 ? (
        <div className={s.emptyNote} role="note">{empty}</div>
      ) : (
        <>
          <table className={s.posTable}>
            <thead><tr><th scope="col">Class</th><th scope="col">Shares</th><th scope="col">NAV</th><th scope="col">Value</th><th scope="col">Now</th></tr></thead>
            <tbody>
              {rows.map(k => (
                <tr key={k}>
                  <th scope="row"><span className={s.posCls} data-class={k}>{names[k]}</span></th>
                  <td className="num">{(held[k] ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
                  <td className="num">{nav[k].toFixed(4)}</td>
                  <td className="num">{fmtUsd((held[k] ?? 0) * nav[k], 2)}</td>
                  <td>{k === exposed ? <span className={s.posState} data-on>exposed</span> : <span className={s.posState}>in quote</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!event && sess && (
            <p className={s.nextBell}>
              <ClassTag cls={parked}>{words[parked]}</ClassTag>
              <span>
                {/* The chain can be a crank behind the calendar for a few minutes
                    after a bell. The handoff it owes is the same either way —
                    from the class the vault says is exposed — only the moment
                    differs, and the sentence says which. */}
                <strong>{sess.holder.toLowerCase() !== exposed
                  ? 'When the crank settles the bell that just rang:'
                  : <>At the next bell, {etClock(sess.next ?? sess.now)} ET:</>}</strong>{' '}
                {words[exposed]} hands the stock to {words[parked]}.{' '}
                {rows.map((k, i) => (
                  <span key={k}>
                    {i > 0 ? ' ' : ''}Your {(held[k] ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} {words[k]}
                    {k === parked ? ' become exposed to the stock' : ' go to quote, carrying what they earned'}.
                  </span>
                ))}
                {preview && (() => {
                  const ch = holdingChange(preview, { day: held.day ?? 0, night: held.night ?? 0 });
                  const sign = ch.change > 0.004 ? '+' : ch.change < -0.004 ? '−' : '';
                  return <> At the current mark it would settle your position at <span className="num">{fmtUsd(ch.after, 2)}</span> (<span className="num">{sign}{fmtUsd(Math.abs(ch.change), 2)}</span>), computed with the program&rsquo;s own <span className="mono">settle()</span>.</>;
                })()}
              </span>
            </p>
          )}
        </>
      )}
    </section>
  );
}
