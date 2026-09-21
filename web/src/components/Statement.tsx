/* Your statement, and the thing you gave up to get it.
 *
 * A position in one half of a session is only interesting against the other
 * option, which is the whole token — what every other tokenized-stock product
 * on this chain sells. So the panel is three lines, not two: NIGHT, DAY, and
 * the same money at the same instants held undivided.
 *
 * The arithmetic is `sdk/src/statement.ts`, which walks the vault's own
 * events. That matters for a reason beyond tidiness: a holder can re-derive
 * every line of this from the chain without trusting the page, and the CSV
 * carries the signature and both NAVs on every row so they can.
 */
import { useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { statement, toCsv, type TimedEvent } from '@sdk/statement.ts';
import type { ShareClass } from '@sdk/settle.ts';
import { fmtUsd } from '@/lib/data';
import type { LedgerRow, ChainVault as ChainState } from '@/lib/chain';
import s from './Statement.module.css';

const fromAtoms = (v: bigint, dec: number) => Number(v) / 10 ** dec;

export function Statement({
  rows, history, d, symbol, label,
}: {
  rows: LedgerRow[] | null;
  /** Whether every transaction in the window has been read yet. */
  history: 'reading' | 'complete' | 'partial';
  d: ChainState;
  symbol: string;
  label: (c: ShareClass) => string;
}) {
  const { publicKey } = useWallet();
  const [saved, setSaved] = useState(false);
  const qd = d.vault.quoteDecimals;

  const st = useMemo(() => {
    if (!publicKey || !rows) return null;
    const timed: TimedEvent[] = rows.flatMap(r =>
      r.failed ? [] : r.events.map(event => ({ signature: r.signature, at: r.at, event })));
    return statement(timed, publicKey.toBase58(), d.vault.nightNav, d.vault.dayNav);
  }, [rows, publicKey, d.vault.nightNav, d.vault.dayNav]);

  if (!publicKey || !st) return null;

  /* A partly-read history sums to a smaller position than the wallet holds,
     and nothing on the row says so. Showing a figure that will change in four
     seconds — as a total, in dollars, beside the word "P&L" — is worse than
     showing nothing.
     
     This applies just as much when the read *stopped* part-way as when it is
     still going: a footnote under a wrong total is not a correction. So the
     table exists only on a history that was read end to end, and the two
     incomplete cases differ in what they tell the reader to expect. */
  if (history !== 'complete') {
    return (
      <section className={`card ${s.card}`} aria-label="Your statement" data-loading="true">
        <h2 className={s.title}>Your statement</h2>
        <p className={s.sub}>
          {history === 'reading'
            ? <>Reading this vault&rsquo;s history from the chain…</>
            : <>The chain&rsquo;s endpoint stopped answering part-way through this
              vault&rsquo;s history. A position summed from half of it would be wrong,
              so there is nothing here yet — it retries every 45 seconds.</>}
        </p>
        {history === 'reading' && <div className="skeleton" style={{ height: 92 }} />}
      </section>
    );
  }
  if (st.rows.length === 0) return null;

  const money = (v: bigint) => fmtUsd(fromAtoms(v, qd), 2);
  const signed = (v: bigint) => `${v > 0n ? '+' : v < 0n ? '−' : ''}${money(v < 0n ? -v : v)}`;
  const lines = [
    { name: label('night'), ...st.night, bench: false },
    { name: label('day'), ...st.day, bench: false },
    // The same cash, at the same instants, in the token nobody split.
    { name: `${symbol}, undivided`, shares: st.bundle.units, quoteIn: st.total.quoteIn,
      quoteOut: st.total.quoteOut, pnl: st.bundle.pnl, bench: true },
  ];

  const download = () => {
    const csv = toCsv(st, { symbol, decimals: qd, cls: label });
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${symbol}-statement-${publicKey.toBase58().slice(0, 8)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setSaved(true);
  };

  return (
    <section className={`card ${s.card}`} aria-label="Your statement">
      <header className={s.head}>
        <div>
          <h2 className={s.title}>Your statement</h2>
          <p className={s.sub}>
            {st.rows.length} trade{st.rows.length === 1 ? '' : 's'}, marked at the NAVs on
            chain right now — realised and unrealised together.
          </p>
        </div>
        <button className={s.save} onClick={download}>{saved ? 'Saved ✓' : 'CSV'}</button>
      </header>

      <table className={s.table}>
        <thead>
          <tr>
            <th scope="col">Position</th>
            <th scope="col" className={s.right}>Held</th>
            <th scope="col" className={s.right}>In</th>
            <th scope="col" className={s.right}>Out</th>
            <th scope="col" className={s.right}>P&amp;L</th>
          </tr>
        </thead>
        <tbody>
          {lines.map(l => (
            <tr key={l.name} data-bench={l.bench}>
              <th scope="row" className={s.name}>{l.name}</th>
              <td className={`num ${s.right}`}>{fromAtoms(l.shares, qd).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
              <td className={`num ${s.right} ${s.muted}`}>{money(l.quoteIn)}</td>
              <td className={`num ${s.right} ${s.muted}`}>{money(l.quoteOut)}</td>
              <td className={`num ${s.right}`} data-sign={l.pnl > 0n ? 'up' : l.pnl < 0n ? 'down' : 'flat'}>{signed(l.pnl)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className={s.verdict} data-role="verdict" data-sign={st.versusBundle > 0n ? 'up' : st.versusBundle < 0n ? 'down' : 'flat'}>
        {st.versusBundle === 0n
          ? <>You hold both halves in the same proportion the vault does, so this is the undivided token by another name — the split has neither helped nor hurt.</>
          : <>Splitting the session is <strong>{signed(st.versusBundle)}</strong> against holding {symbol} whole
            with the same money at the same moments.</>}
      </p>

      <p className={s.foot}>
        The benchmark is exact, not indicative: NAV moves only at boundaries, and the
        program publishes both classes&rsquo; NAV at every one, so the price of the
        undivided pair is known at each instant you traded. One unit of it is half a{' '}
        {label('night')} and half a {label('day')} — the funding that moves
        between them nets to zero across the pair, which is why the split is fair.
        {!st.complete && ' This window does not reach the vault’s opening, so the benchmark assumes parity before the first boundary it can see.'}
      </p>
    </section>
  );
}
