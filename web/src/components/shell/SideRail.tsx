import { Link, NavLink, useLocation } from 'react-router-dom';
import { Mark } from '../Mark';
import { Icon } from '../ui/Icon';
import { Status } from '../ui/Status';
import { WalletButton } from '../wallet/WalletButton';
import { PRIMARY, SECONDARY, isActive, type NavItem } from './nav';
import s from './Shell.module.css';

function Item({ item }: { item: NavItem }) {
  const { pathname } = useLocation();
  const active = isActive(item, pathname);
  return (
    <NavLink to={item.to} className={s.navItem} aria-current={active ? 'page' : undefined} data-active={active || undefined}>
      <Icon name={item.icon} size={17} />
      <span className={s.navLabel}>{item.label}</span>
    </NavLink>
  );
}

/** The persistent desktop navigation: three things you do, three things you read. */
export function SideRail() {
  return (
    <aside className={s.rail} aria-label="Primary">
      <Link to="/" className={s.brand} aria-label="SESSION, home">
        <Mark size={22} />
        <span className={s.brandWord}>SESSION</span>
      </Link>

      <nav className={s.navGroup} aria-label="Product">
        {PRIMARY.map(i => <Item key={i.to} item={i} />)}
      </nav>
      <div className={s.navRule} role="separator" />
      <nav className={s.navGroup} aria-label="Learn">
        {SECONDARY.map(i => <Item key={i.to} item={i} />)}
      </nav>
      <div className={s.navRule} role="separator" />

      <div className={s.network}>
        <p className={s.networkLabel}>Network</p>
        <div className={s.networkRow}>
          <Status kind="devnet" label="Devnet" title="The two live vaults run on Solana devnet with test mints. The program is the mainnet program." />
          <span className={s.networkNote}>Test funds</span>
        </div>
        <Link to="/list" className={s.railLink}>
          <Icon name="list" size={14} /> Open a vault
        </Link>
      </div>

      <div className={s.railWallet}>
        <WalletButton />
      </div>
    </aside>
  );
}
