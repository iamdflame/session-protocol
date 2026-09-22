/* The top strip. On a desk it is quiet — search and the live market, nothing
 * that competes with the page. On a phone it is the whole header: mark,
 * market status, search, wallet. */
import { Link } from 'react-router-dom';
import { Mark } from '../Mark';
import { Icon } from '../ui/Icon';
import { WalletButton } from '../wallet/WalletButton';
import { SessionChip } from './SessionChip';
import { usePalette } from './CommandPalette';
import s from './Shell.module.css';

export function TopBar() {
  const { open } = usePalette();
  return (
    <header className={s.top}>
      <Link to="/" className={s.topBrand} aria-label="SESSION, home">
        <Mark size={22} />
        <span className={s.brandWord}>SESSION</span>
      </Link>

      <button className={s.search} onClick={open} aria-label="Search markets and pages" aria-keyshortcuts="Meta+K Control+K /">
        <Icon name="search" size={15} />
        <span className={s.searchText}>Search markets</span>
        <kbd className={s.searchKbd}>⌘K</kbd>
      </button>

      <div className={s.topRight}>
        <SessionChip />
        <span className={s.topWallet}><WalletButton compact /></span>
      </div>
    </header>
  );
}
