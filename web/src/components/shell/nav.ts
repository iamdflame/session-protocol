import type { IconName } from '../ui/Icon';

export interface NavItem { to: string; label: string; icon: IconName; match?: (p: string) => boolean }

/* Product language: verbs and nouns a trader uses. Nothing called "Discover". */
export const PRIMARY: NavItem[] = [
  { to: '/trade', label: 'Trade', icon: 'trade' },
  { to: '/bells', label: 'Bell orders', icon: 'clock' },
  { to: '/markets', label: 'Markets', icon: 'markets', match: p => p === '/markets' || (p.startsWith('/markets/')) },
  { to: '/portfolio', label: 'Portfolio', icon: 'portfolio' },
];
export const SECONDARY: NavItem[] = [
  { to: '/research', label: 'Research', icon: 'research' },
  { to: '/how-it-works', label: 'How it works', icon: 'how' },
  { to: '/bell', label: 'Keeper', icon: 'bell' },
  { to: '/oracle', label: 'Oracle', icon: 'verified' },
];
export const isActive = (item: NavItem, pathname: string) =>
  item.match ? item.match(pathname) : pathname === item.to || pathname.startsWith(item.to + '/');
