/* The phone navigation: four destinations under a thumb, and More for the
 * rest. Fixed to the bottom, clear of the home indicator. */
import { useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { Icon } from '../ui/Icon';
import { Sheet } from '../ui/Sheet';
import { Status } from '../ui/Status';
import { isActive, PRIMARY } from './nav';
import s from './Shell.module.css';

const MOBILE = [...PRIMARY, { to: '/research', label: 'Research', icon: 'research' as const }];

export function BottomNav() {
  const { pathname } = useLocation();
  const [more, setMore] = useState(false);
  const moreActive = ['/how-it-works', '/bell', '/list'].some(p => pathname.startsWith(p));
  return (
    <>
      <nav className={s.bottom} aria-label="Primary">
        {MOBILE.map(item => {
          const active = isActive(item, pathname);
          return (
            <NavLink key={item.to} to={item.to} className={s.tab} aria-current={active ? 'page' : undefined} data-active={active || undefined}>
              <Icon name={item.icon} size={20} />
              <span>{item.label}</span>
            </NavLink>
          );
        })}
        <button className={s.tab} onClick={() => setMore(true)} data-active={moreActive || undefined} aria-haspopup="dialog">
          <Icon name="more" size={20} strokeWidth={2.6} />
          <span>More</span>
        </button>
      </nav>

      <Sheet open={more} onClose={() => setMore(false)} title="More" kind="sheet">
        <div className={s.moreList}>
          {[
            { to: '/how-it-works', label: 'How it works', icon: 'how' as const, sub: 'The handoff, step by step' },
            { to: '/bell', label: 'Bell', icon: 'bell' as const, sub: 'The live heartbeat and the keeper' },
            { to: '/list', label: 'Open a vault', icon: 'list' as const, sub: 'initialize_vault from your wallet' },
          ].map(l => (
            <Link key={l.to} to={l.to} className={s.moreItem} onClick={() => setMore(false)}>
              <Icon name={l.icon} size={18} />
              <span><span className={s.moreLabel}>{l.label}</span><span className={s.moreSub}>{l.sub}</span></span>
              <Icon name="chevronRight" size={16} />
            </Link>
          ))}
        </div>
        <div className={s.moreNet}>
          <Status kind="devnet" /> <span>Live vaults run on Solana devnet with test mints.</span>
        </div>
      </Sheet>
    </>
  );
}
