/* Every vault the program knows about, not every vault this site shipped.
 *
 * `initialize_vault` takes no permission from anyone: the signer becomes the
 * authority and the PDA is seeded by the mint pair. A catalog built from the
 * two manifest files in this repository could not show that — a vault
 * somebody else opened would exist on chain and nowhere on the page, and
 * "permissionless" would be a word rather than something a reader can check.
 *
 * So this asks the chain directly, and the desk's opinion is a filter rather
 * than a gate: `curated` decides what is shown first, never what works. The
 * uncurated ones are one click away and say what they are.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { SESSION_EVENT } from '@sdk/vault.ts';
import { useVaultCensus, explorerAddr, short } from '@/lib/chain';
import s from './Census.module.css';

/**
 * `pages` maps a vault address to the symbol this site has a page for. The
 * two are not the same string: a vault stores `NVDA` in eight bytes on chain
 * while the asset trades as `NVDAx`, so matching on the symbol would silently
 * stop linking the moment a ticker carried a suffix.
 */
export function Census({ pages }: { pages: Map<string, string> }) {
  const { vaults, unreadable, error } = useVaultCensus();
  const [showAll, setShowAll] = useState(false);

  if (error) return null;           // the study catalog below still stands

  const curatedCount = vaults?.filter(v => v.curated).length ?? 0;
  const shown = (vaults ?? []).filter(v => showAll || v.curated);

  return (
    <section className={`shell ${s.wrap}`} aria-label="Vaults on chain">
      <div className={s.head}>
        <div>
          <h2 className={s.title}>Vaults on chain</h2>
          <p className={s.sub}>
            Read from the program by scanning its accounts, not from a list this site
            keeps. Anyone can open one — <span className="mono">initialize_vault</span> takes
            no permission, and the signer becomes its authority.{' '}
            <Link className={s.addr} to="/list">Open one →</Link>
          </p>
        </div>
        {vaults && vaults.length > curatedCount && (
          <button className={s.toggle} data-on={showAll} onClick={() => setShowAll(v => !v)}
                  aria-pressed={showAll}>
            {showAll ? `Curated only (${curatedCount})` : `Show all (${vaults.length})`}
          </button>
        )}
      </div>

      {vaults === null ? (
        <div className={s.skel}>
          {Array.from({ length: 2 }, (_, i) => <div key={i} className="skeleton" style={{ height: 78 }} />)}
        </div>
      ) : (
        shown.length === 0 ? (
        <p className={s.note}>
          {vaults.length === 0
            ? 'No vault has been opened on this program yet.'
            : `Nothing is curated yet. ${vaults.length} vault${vaults.length === 1 ? '' : 's'} exist${vaults.length === 1 ? 's' : ''} on chain and work${vaults.length === 1 ? 's' : ''} the same — “Show all” lists them.`}
        </p>
      ) : (
        <div className={s.grid}>
          {shown.map(v => {
            const event = v.sessionKind === SESSION_EVENT;
            const nav = (n: bigint) => (Number(n) / 1e18).toFixed(4);
            const body = (
              <>
                <div className={s.row}>
                  <span className={s.symbol}>{v.symbol || 'unnamed'}</span>
                  <span className={s.tag} data-kind={v.halted ? 'halted' : v.curated ? 'curated' : 'open'}>
                    {v.halted ? 'halted' : v.curated ? 'curated' : 'uncurated'}
                  </span>
                </div>
                <span className={s.meta}>
                  {event ? 'event session' : 'equity session'} · {event ? 'THEN' : 'NIGHT'} {nav(v.nightNav)} ·{' '}
                  {event ? 'NOW' : 'DAY'} {nav(v.dayNav)}
                </span>
                <span className={s.meta}>
                  <a className={`mono ${s.addr}`} href={explorerAddr(v.address)} target="_blank"
                     rel="noreferrer" onClick={e => e.stopPropagation()}>{short(v.address, 4)} ↗</a>
                  {' · opened by '}
                  <span className="mono">{short(v.creator, 4)}</span>
                </span>
              </>
            );
            const page = pages.get(v.address);
            return page ? (
              <Link key={v.address} className={s.item} data-curated={v.curated}
                    to={`/markets/${encodeURIComponent(page)}`}>{body}</Link>
            ) : (
              <div key={v.address} className={s.item} data-curated={v.curated}>{body}</div>
            );
          })}
        </div>
      ))}

      <p className={s.note}>
        Curation is the desk&rsquo;s opinion and nothing more: an uncurated vault mints,
        settles, funds and redeems exactly the same, and the curator key cannot stop it.
        The catalog says <strong>curated</strong> rather than <strong>verified</strong> for
        that reason.
        {unreadable > 0 && (
          <> {unreadable} account{unreadable === 1 ? '' : 's'} on this program{' '}
            {unreadable === 1 ? 'was' : 'were'} written by an older layout and this build
            refuses to decode {unreadable === 1 ? 'it' : 'them'} rather than guess — counted
            here instead of quietly dropped.</>
        )}
      </p>
    </section>
  );
}
