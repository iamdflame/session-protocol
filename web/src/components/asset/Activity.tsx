/* What happened in this vault, newest first.
 *
 * On chain, the rows are the vault's own transactions and what the program
 * said happened in them, decoded from the events it emitted — anyone can
 * rebuild the same list from the chain. In the simulation, they are the
 * settlements and trades this browser ran. Either way a row says what kind of
 * thing it was, when, and what moved. */
import { etClock, etDate } from '@/lib/session';
import { fmtUsd } from '@/lib/data';
import { explorer, short, type LedgerRow } from '@/lib/chain';
import { describe, kindOf } from '@sdk/events.ts';
import { fromQuote, fromShares, navToNumber, type Event, type ShareClass } from '@/lib/localVault';
import { Icon } from '../ui/Icon';
import s from './Asset.module.css';

export function ChainActivity({ rows, error, dec, label, limit }: {
  rows: LedgerRow[] | null;
  error: Error | null;
  dec: number;
  label: (c: ShareClass) => string;
  limit: number;
}) {
  if (error) return <p className={s.note}>Could not load history: {error.message}</p>;
  if (rows === null) {
    return <div className={s.skelRows}>{Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton" style={{ height: 30 }} />)}</div>;
  }
  if (rows.length === 0) return <p className={s.note}>No transactions yet.</p>;
  const shown = rows.slice(0, limit);
  const unread = shown.filter(r => !r.decoded && !r.failed).length;
  return (
    <>
    <ol className={s.events}>
      {shown.map(r => {
        /* A transaction may emit several events — a settle that also halted, a
           fill that paid an incentive. Each gets its own line; one that emitted
           nothing is still shown, but only once it has actually been read:
           `events: []` is the same empty array whether the program said nothing
           or the endpoint never answered, and `decoded` tells them apart. */
        const lines = r.events.length
          ? r.events.map(ev => ({ kind: kindOf(ev.name), text: describe(ev, dec, cl => label(cl as ShareClass)) }))
          : [r.failed
              ? { kind: 'halt', text: 'Reverted — nothing was written' }
              : r.decoded
                ? { kind: 'admin', text: 'Touched the vault without emitting an event' }
                : { kind: 'pending', text: 'Reading…' }];
        return lines.map((l, i) => (
          <li key={`${r.signature}-${i}`} className={s.event} data-kind={l.kind}>
            <span className={s.eventKind}>{l.kind}</span>
            <span className={s.eventWhen}>
              {r.at ? <><span className="num">{etClock(r.at)}</span><span className={s.eventDate}>{etDate(r.at)}</span></> : <span className={s.eventDate}>pending</span>}
            </span>
            <span className={s.eventDetail}>{l.text}</span>
            {i === 0 ? (
              <a className={`mono ${s.eventSig}`} href={explorer(r.signature)} target="_blank" rel="noreferrer"
                 aria-label={`Transaction ${short(r.signature, 6)} on Solscan`}>
                {short(r.signature, 4)} <Icon name="external" size={11} />
              </a>
            ) : <span />}
          </li>
        ));
      })}
    </ol>
    {unread > 0 && (
      <p className={s.note}>
        {unread === shown.length ? 'None' : `${unread} of these`} decoded yet — the public devnet endpoint is slow to
        serve transaction details, and a row is only described once the program&rsquo;s own events have been read.
        Each signature links to the transaction meanwhile.
      </p>
    )}
    </>
  );
}

export function LocalActivity({ history, stem }: { history: Event[]; stem: string }) {
  if (!history.length) return <p className={s.note}>Nothing yet. Settlements appear here as bells pass; trades as you make them.</p>;
  return (
    <ol className={s.events}>
      {history.map((e, i) => (
        <li key={`${e.ts}-${i}`} className={s.event} data-kind={e.kind}>
          <span className={s.eventKind}>{e.kind}</span>
          <span className={s.eventWhen}><span className="num">{etClock(e.ts)}</span><span className={s.eventDate}>{etDate(e.ts)}</span></span>
          <span className={s.eventDetail}>
            {e.kind === 'settle' ? (
              <>
                NAV <span className="num">{navToNumber(e.dayNav).toFixed(4)}</span> DAY
                {' · '}<span className="num">{navToNumber(e.nightNav).toFixed(4)}</span> NIGHT
                {e.funding !== undefined && e.funding !== 0n && (
                  <> · funding {e.funding > 0n ? 'NIGHT → DAY' : 'DAY → NIGHT'} <span className="num">{fmtUsd(Math.abs(fromQuote(e.funding)), 2)}</span></>
                )}
              </>
            ) : (
              <>
                <span className={s.eventCls} data-class={e.cls}>{stem}.{e.cls?.toUpperCase()}</span>{' '}
                <span className="num">{e.kind === 'mint' ? '+' : '−'}{fromShares(e.shares ?? 0n).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
                {' shares · '}<span className="num">{fmtUsd(fromQuote(e.quote ?? 0n), 2)}</span>
              </>
            )}
          </span>
          <span />
        </li>
      ))}
    </ol>
  );
}
