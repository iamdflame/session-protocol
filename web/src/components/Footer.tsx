import { Link } from 'react-router-dom';
import { Mark } from './Mark';
import s from './Footer.module.css';

const GROUPS = [
  {
    title: 'Product',
    links: [
      { href: '/markets', label: 'Markets' },
      { href: '/how-it-works', label: 'How it works' },
    ],
  },
  {
    title: 'Evidence',
    links: [
      { href: '/research', label: 'The session study' },
      { href: '/research#controls', label: 'Controls' },
      { href: '/research#method', label: 'Methodology' },
    ],
  },
];

export function Footer() {
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
          Program live on devnet · one vault · mainnet pending
        </p>
      </div>
    </footer>
  );
}
