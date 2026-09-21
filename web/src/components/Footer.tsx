import { Link } from 'react-router-dom';
import { useDevnets } from '@/lib/chain';
import { Mark } from './Mark';
import s from './Footer.module.css';

const GROUPS = [
  {
    title: 'Product',
    links: [
      { href: '/markets', label: 'Markets' },
      { href: '/how-it-works', label: 'How it works' },
      { href: '/list', label: 'Open a vault' },
    ],
  },
  {
    title: 'Evidence',
    links: [
      { href: '/research', label: 'The session study' },
      { href: '/research#controls', label: 'Controls' },
      { href: '/research#simulation', label: 'The halt rate' },
      { href: '/research#method', label: 'Methodology' },
    ],
  },
];

export function Footer() {
  const manifests = useDevnets();
  const vaults = manifests === undefined ? null : manifests.length;
  return (
    <footer className={s.footer}>
      <div className={`shell ${s.inner}`}>
        <div className={s.brandCol}>
          <Link to="/" className={s.brand} aria-label="SESSION, home">
            <Mark size={24} />
            <span>SESSION</span>
          </Link>
          <p className={s.tagline}>
            A tokenized share trades around the clock. The stock behind it trades
            for six and a half hours. Those are two different assets wearing one
            ticker.
          </p>
        </div>

        {GROUPS.map(g => (
          <nav key={g.title} className={s.col} aria-label={g.title}>
            <h2 className="eyebrow">{g.title}</h2>
            {g.links.map(l => (
              <Link key={l.href + l.label} to={l.href} className={s.link}>{l.label}</Link>
            ))}
          </nav>
        ))}
      </div>

      <div className={`shell ${s.legal}`}>
        <p>
          Research tool. Not investment advice. Figures are measured from real
          Solana pool history and live quotes — never illustrative.
        </p>
        <p className={s.status}>
          <span className={s.statusDot} aria-hidden="true" />
          {/* Counted, not asserted. This line read "one vault" for as long as
              there were two, on every page of the site, because a number
              written into a string stops being true the moment the thing it
              counts changes. */}
          Program live on devnet · {vaults === null ? 'vaults' : vaults === 1 ? 'one vault' : `${vaults} vaults`}
          {' · '}<code className="mono">$BELL</code> on mainnet · vaults on mainnet pending
        </p>
      </div>
    </footer>
  );
}
