import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useGround } from './SessionGround';
import { useSession, countdown, NIGHT_SHARE } from '@/lib/session';
import { Mark } from './Mark';
import { WalletButton } from './wallet/WalletButton';
import s from './Nav.module.css';

const LINKS = [
  { href: '/markets', label: 'Markets' },
  { href: '/research', label: 'Research' },
  { href: '/how-it-works', label: 'How it works' },
];

/**
 * The live state, in the chrome.
 *
 * Most products put a theme toggle here. Ours puts the market: which class
 * holds the stock right now and how long until it hands over. It is the one
 * number a holder checks most, so it belongs where they never have to look.
 */
function LivePill() {
  const sess = useSession();

  if (!sess) {
    return <div className={`${s.pill} ${s.pillLoading}`} aria-hidden="true">
      <span className={s.dot} /><span className="skeleton" style={{ width: 96, height: 10 }} />
    </div>;
  }

  const holder = sess.holder;
  return (
    <div
      className={s.pill}
      data-holder={holder.toLowerCase()}
      title={`The US market is ${sess.isOpen ? 'open' : 'closed'}. ` +
             `${holder} holds the stock until the next boundary.`}
    >
      <span className={s.dot} aria-hidden="true" />
      <span className={s.pillLabel}>{holder}</span>
      <span className={s.pillSep} aria-hidden="true" />
      <span className={`${s.pillTime} num`}>{countdown(sess.until)}</span>
      <span className="sr-only">
        {`${holder} holds the exposure. Next boundary in ${countdown(sess.until)}.`}
      </span>
    </div>
  );
}

function GroundToggle() {
  const { mode, ground, setMode, ready } = useGround();
  if (!ready) return <div style={{ width: 34, height: 34 }} aria-hidden="true" />;

  const next = mode === 'auto' ? (ground === 'night' ? 'day' : 'night') : 'auto';
  const label =
    mode === 'auto'
      ? `Following the market (${ground}). Pin to ${next}.`
      : `Pinned to ${mode}. ${next === 'auto' ? 'Follow the market again.' : ''}`;

  return (
    <button
      className={s.ground}
      onClick={() => setMode(next)}
      aria-label={label}
      title={label}
      data-pinned={mode !== 'auto'}
    >
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        {ground === 'night' ? (
          <path
            d="M15.5 12.6A6.4 6.4 0 0 1 7.4 4.5a6.4 6.4 0 1 0 8.1 8.1Z"
            fill="currentColor"
          />
        ) : (
          <>
            <circle cx="10" cy="10" r="3.6" fill="currentColor" />
            {[0, 45, 90, 135, 180, 225, 270, 315].map(a => (
              <line
                key={a} x1="10" y1="10" x2="10" y2="2.4"
                stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
                transform={`rotate(${a} 10 10)`} opacity="0.85"
              />
            ))}
          </>
        )}
      </svg>
      {mode !== 'auto' && <span className={s.pinDot} aria-hidden="true" />}
    </button>
  );
}

export function Nav() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Close the drawer on navigation, and never leave the page scroll-locked.
  useEffect(() => { setOpen(false); }, [pathname]);
  // Lock the page behind the drawer: scroll, and also tab order — a drawer you
  // can tab out of, into content you cannot see, is worse than no drawer.
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    const behind = [document.getElementById('main'), document.querySelector('footer')];
    for (const el of behind) {
      if (!el) continue;
      if (open) el.setAttribute('inert', '');
      else el.removeAttribute('inert');
    }
    return () => {
      document.body.style.overflow = '';
      for (const el of behind) el?.removeAttribute('inert');
    };
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <header className={s.header} data-scrolled={scrolled}>
        <div className={`shell ${s.bar}`}>
          <Link to="/" className={s.brand} aria-label="SESSION, home">
            <Mark size={26} />
            <span className={s.word}>SESSION</span>
          </Link>

          <nav className={s.links} aria-label="Primary">
            {LINKS.map(l => (
              <Link
                key={l.href}
                to={l.href}
                className={s.link}
                data-active={pathname === l.href || pathname.startsWith(l.href + '/')}
              >
                {l.label}
              </Link>
            ))}
          </nav>

          <div className={s.right}>
            <LivePill />
            <GroundToggle />
            <WalletButton />
            <Link to="/markets" className={s.cta}>
              Open app
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <path d="M3 8h9M8.5 4 12.5 8l-4 4" fill="none" stroke="currentColor"
                      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
            <button
              className={s.burger}
              onClick={() => setOpen(v => !v)}
              aria-label={open ? 'Close menu' : 'Open menu'}
              aria-expanded={open}
              aria-controls="mobile-menu"
            >
              <span data-open={open} />
              <span data-open={open} />
            </button>
          </div>
        </div>
      </header>

      <div id="mobile-menu" className={s.drawer} data-open={open} hidden={!open}>
        <nav aria-label="Mobile">
          {LINKS.map((l, i) => (
            <Link
              key={l.href} to={l.href} className={s.drawerLink}
              style={{ animationDelay: `${40 + i * 45}ms` }}
              data-active={pathname === l.href}
            >
              {l.label}
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path d="M3 8h9M8.5 4 12.5 8l-4 4" fill="none" stroke="currentColor"
                      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
          ))}
          <Link to="/markets" className={s.drawerCta} style={{ animationDelay: '175ms' }}>
            Open app
          </Link>
          <div className={s.drawerWallet}><WalletButton /></div>
        </nav>
        <p className={s.drawerNote}>
          <span className="num">{Math.round(NIGHT_SHARE * 100)}%</span> of every week is
          time nobody has been able to own separately.
        </p>
      </div>
    </>
  );
}
