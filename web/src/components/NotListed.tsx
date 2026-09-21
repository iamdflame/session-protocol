/* What this page is, stated permanently.
 *
 * The site used to say it once, in a modal, dismissed with a click and
 * remembered in localStorage. After that a simulated vault looked exactly
 * like a live one: the same layout, the same NAVs, the same word on the
 * button. Somebody arriving on a shared link would see a page that behaves
 * like a market and has no market behind it.
 *
 * So the status is a fixture of the page rather than an interruption at the
 * start of it. There are two honest things to say and they are both said
 * here: the chart is real, measured from this asset's own pool history, and
 * the vault is not — it runs the same settlement code in the browser and
 * touches no chain.
 */
import { Link } from 'react-router-dom';
import s from './NotListed.module.css';

export function NotListed({ symbol, liveSymbols }: { symbol: string; liveSymbols: string[] }) {
  return (
    <div className={`shell ${s.wrap}`}>
      <div className={s.bar} role="note">
        <span className={s.tag}>not listed</span>
        <p className={s.text}>
          <strong>{symbol} has no vault.</strong> The history below is real — measured from
          this asset&rsquo;s own pool, hour by hour. Everything else on this page is a{' '}
          <strong>simulation running in your browser</strong>: it executes the same{' '}
          <span className="mono">settle()</span> the program does, on the live price, and
          writes to local storage. Nothing is minted, nothing is owned, and closing the tab
          is the end of it.
          {liveSymbols.length > 0 && (
            <>
              {' '}The vaults that are on chain:{' '}
              {liveSymbols.map((sym, i) => (
                <span key={sym}>
                  {i > 0 && ', '}
                  <Link className={s.link} to={`/markets/${sym}`}>{sym}</Link>
                </span>
              ))}
              .
            </>
          )}
        </p>
      </div>
    </div>
  );
}
