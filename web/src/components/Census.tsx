/* Every vault the program knows about, not every vault this site shipped.
 *
 * `initialize_vault` takes no permission: the signer becomes the authority and
 * the PDA is seeded by the mint pair. A catalog built from the manifest files
 * in this repository could not show that — a vault somebody else opened would
 * exist on chain and nowhere here — so this scans the program's accounts.
 *
 * The desk's opinion is a filter rather than a gate: `curated` decides what is
 * shown first, never what works. The rest are one click away and say so. */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { SESSION_EVENT } from '@sdk/vault.ts';
import { useVaultCensus, explorerAddr, short } from '@/lib/chain';
import { Tooltip } from './ui/Tooltip';
import { Icon } from './ui/Icon';
import s from './Census.module.css';

/**
 * `pages` maps a vault address to the symbol this site has a page for. A vault
 * stores `NVDA` in eight bytes on chain while the asset trades as `NVDAx`, so
 * matching on the symbol would silently stop linking.
 */
export function Census({ pages }: { pages: Map<string, string> }) {
  const { vaults, unreadable, error } = useVaultCensus();
  const [showAll, setShowAll] = useState(false);

  if (error) return null;           // the market table below still stands

  const curatedCount = vaults?.filter(v => v.curated).length ?? 0;
  const shown = (vaults ?? []).filter(v => showAll || v.curated);

  return (
    <section className={s.strip} aria-label="Vaults on chain">
      <div className={s.lead}>
        <Tooltip tip={<>Found by scanning the program&rsquo;s accounts, not from a list this site keeps. Curated decides what is shown first; an uncurated vault settles, funds and redeems exactly the same, and the curator cannot stop it.{unreadable > 0 ? ` ${unreadable} older-layout account${unreadable === 1 ? '' : 's'} counted but not decoded.` : ''}</>}>
          <span className={s.label} tabIndex={0}>On chain <Icon name="info" size={12} /></span>
        </Tooltip>
      </div>

      <div className={s.items}>
        {vaults === null ? (
          <><span className="skeleton" style={{ width: 150, height: 28 }} /><span className="skeleton" style={{ width: 150, height: 28 }} /></>
        ) : shown.length === 0 ? (
          <span className={s.none}>{vaults.length === 0 ? 'No vault opened yet.' : 'Nothing curated yet.'}</span>
        ) : shown.map(v => {
          const event = v.sessionKind === SESSION_EVENT;
          const page = pages.get(v.address);
          const body = (
            <>
              <span className={`mono ${s.sym}`}>{v.symbol || 'unnamed'}</span>
              <span className={s.kind}>{event ? 'event' : 'equity'}</span>
              <span className={s.tag} data-kind={v.halted ? 'halted' : v.curated ? 'curated' : 'open'}>
                {v.halted ? 'halted' : v.curated ? 'curated' : 'uncurated'}
              </span>
            </>
          );
          return (
            <span key={v.address} className={s.item} data-curated={v.curated}>
              {page ? <Link to={`/markets/${encodeURIComponent(page)}`} className={s.itemLink}>{body}</Link> : <span className={s.itemLink}>{body}</span>}
              <a className={s.addr} href={explorerAddr(v.address)} target="_blank" rel="noreferrer" aria-label={`${v.symbol || 'vault'} on Solscan`}>
                {short(v.address, 4)} <Icon name="external" size={11} />
              </a>
            </span>
          );
        })}
      </div>

      <div className={s.actions}>
        {vaults && vaults.length > curatedCount && (
          <button className={s.toggle} onClick={() => setShowAll(v => !v)} aria-pressed={showAll}>
            {showAll ? `Curated only (${curatedCount})` : `Show all (${vaults.length})`}
          </button>
        )}
        <Link to="/list" className={s.open}><Icon name="list" size={13} /> Open a vault</Link>
      </div>
    </section>
  );
}
