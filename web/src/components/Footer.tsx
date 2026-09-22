/* A compact footer: where the code and the evidence live, the infrastructure
 * the product runs on, and the one status line — counted, not asserted. */
import { Link } from 'react-router-dom';
import { useDevnets } from '@/lib/chain';
import s from './Footer.module.css';

const OUT = [
  { href: 'https://github.com/iamdflame/session-protocol', label: 'GitHub' },
  { href: 'https://solana.com', label: 'Solana' },
  { href: 'https://pyth.network', label: 'Pyth' },
  { href: 'https://jup.ag', label: 'Jupiter' },
  { href: 'https://meteora.ag', label: 'Meteora' },
];

export function Footer() {
  const manifests = useDevnets();
  const vaults = manifests === undefined ? null : manifests.length;
  return (
    <footer className={s.foot}>
      <div className={s.row}>
        <nav className={s.links} aria-label="Footer">
          <Link to="/research">Research</Link>
          <Link to="/how-it-works">Docs</Link>
          <Link to="/list">Open a vault</Link>
          {OUT.map(l => <a key={l.href} href={l.href} target="_blank" rel="noreferrer">{l.label}</a>)}
        </nav>
        <p className={s.status}>
          <span className={s.dot} aria-hidden="true" />
          {/* Counted, not asserted: this line once read "one vault" for as long
              as there were two, on every page. */}
          Program on Solana devnet · {vaults === null ? 'vaults' : vaults === 1 ? 'one vault' : `${vaults} vaults`} ·{' '}
          <span className="mono">$BELL</span> on mainnet
        </p>
      </div>
      <p className={s.legal}>
        Research and protocol demonstration. Not investment advice, and not available to US persons.
        DAY and NIGHT are claims on a vault holding a tokenized wrapper, not the underlying stock.
      </p>
    </footer>
  );
}
