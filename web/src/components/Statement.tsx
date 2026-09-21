/* Your statement, and the thing you gave up to get it.
 *
 * A position in one half of a session is only interesting against the other
 * option, which is the whole token — what every other tokenized-stock product
 * on this chain sells. So the panel is three lines, not two: NIGHT, DAY, and
 * the same money at the same instants held undivided.
 *
 * The two halves have very different costs, and the panel is built around
 * that. Your *position* comes from your own share accounts: a handful of
 * signatures, and every mint and redeem carries the NAV it was priced at, so
 * the figures are exact the moment they land. The *benchmark* needs the price
 * of the pair at each of those instants, which only the boundaries carry, so
 * it waits on the vault's whole history — and on a public endpoint that
 * rate-limits per address, that can simply not arrive.
 *
 * Showing the position and saying the comparison is still coming is honest.
 * Showing a comparison computed from half a history is not, so it is never
 * rendered before `complete`.
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
  mine, mineState, rows, history, d, symbol, label,
}: {
  /** This wallet's own mints and redeems, read from its share accounts. */
  mine: TimedEvent[] | null;
  mineState: 'reading' | 'complete' | 'partial';
  /** The vault's whole history, which the benchmark needs and the position does not. */
  rows: LedgerRow[] | null;
  history: 'reading' | 'complete' | 'partial';
  d: ChainState;
  symbol: string;
  label: (c: ShareClass) => string;
}) {
  const { publicKey } = useWallet();
  const [saved, setSaved] = useState(false);
  const qd = d.vault.quoteDecimals;
  const { nightNav, dayNav } = d.vault;

  // The position: exact from the wallet's own trades alone.
  const st = useMemo(() => {
    if (!publicKey || !mine) return null;
    return statement(mine, publicKey.toBase58(), nightNav, dayNav);
  }, [mine, publicKey, nightNav, dayNav]);

  // The benchmark: needs every boundary, so it needs the whole history.
  const full = useMemo(() => {
    if (!publicKey || !rows || history !== 'complete') return null;
    const timed: TimedEvent[] = rows.flatMap(r =>
      r.failed ? [] : r.events.map(event => ({ signature: r.signature, at: r.at, event })));
    const walked = statement(timed, publicKey.toBase58(), nightNav, dayNav);
    return walked.complete ? walked : null;
  }, [rows, history, publicKey, nightNav, dayNav]);

  if (!publicKey || !st) return null;

  /* A partly-read position is wrong in the one way that matters: it sums to
     fewer shares than the wallet holds, and nothing on the row says so. That
     is true whether the read is still going or stopped part-way, so both wait
     — and they say different things, because one of them is going to finish. */
  if (mineState !== 'complete') {
    return (
      <section className={`card ${s.card}`} aria-label="Your statement" data-loading="true">
        <h2 className={s.title}>Your statement</h2>
        <p className={s.sub}>
          {mineState === 'reading'
            ? <>Reading your trades in this vault from the chain&hellip;</>
            : <>The chain&rsquo;s endpoint stopped answering part-way through your trades.
              A position summed from some of them would be wrong, so there is nothing
              here yet.</>}
        </p>
        {mineState === 'reading' && <div className="skeleton" style={{ height: 92 }} />}
      </section>
    );
  }
  if (st.rows.length === 0) return null;

  const money = (v: bigint) => fmtUsd(fromAtoms(v, qd), 2);
  const signed = (v: bigint) => `${v > 0n ? '+' : v < 0n ? '−' : ''}${money(v < 0n ? -v : v)}`;
  const lines = [
    { name: label('night'), ...st.night, bench: false },
    { name: label('day'), ...st.day, bench: false },
    ...(full ? [{
      name: `${symbol}, undivided`,
      shares: full.bundle.units,
      quoteIn: full.total.quoteIn,
      quoteOut: full.total.quoteOut,
      pnl: full.bundle.pnl,
      bench: true,
    }] : []),
  ];

  const download = () => {
    const csv = toCsv(full ?? st, { symbol, decimals: qd, cls: label });
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

      {full ? (
        <p className={s.verdict} data-role="verdict" data-sign={full.versusBundle > 0n ? 'up' : full.versusBundle < 0n ? 'down' : 'flat'}>
          {full.versusBundle === 0n
            ? <>You hold both halves in the same proportion the vault does, so this is the undivided token by another name — the split has neither helped nor hurt.</>
            : <>Splitting the session is <strong>{signed(full.versusBundle)}</strong> against holding {symbol} whole
              with the same money at the same moments.</>}
        </p>
      ) : (
        <p className={s.verdict} data-role="verdict" data-sign="flat">
          {history === 'partial'
            ? <>The comparison against holding {symbol} whole needs every boundary this vault
              has settled, and the chain&rsquo;s endpoint stopped answering part-way through.
              Your position above is unaffected — it comes from your own trades, each priced
              at a NAV the program published with it.</>
            : <>Working out what the same money would have made held whole&hellip; that needs
              every boundary, not just your own trades.</>}
        </p>
      )}

      <p className={s.foot}>
        The benchmark is exact, not indicative: NAV moves only at boundaries, and the
        program publishes both classes&rsquo; NAV at every one, so the price of the
        undivided pair is known at each instant you traded. One unit of it is half a{' '}
        {label('night')} and half a {label('day')} — the funding that moves between them
        nets to zero across the pair, which is why the split is fair.
      </p>
    </section>
  );
}
