/* Initials-based asset marks. There are no licensed company logos in this
 * repository, and a borrowed logo on a devnet stand-in would imply an
 * affiliation that does not exist. */
import s from './Avatar.module.css';

export function initials(symbol: string): string {
  const base = symbol.replace(/x$/, '').replace(/[^A-Za-z0-9]/g, '');
  return base.slice(0, base.length > 4 ? 2 : Math.min(4, base.length)).toUpperCase() || '?';
}

export function AssetAvatar({ symbol, kind, size = 'md' }: { symbol: string; kind?: string; size?: 'sm' | 'md' | 'lg' }) {
  const text = initials(symbol);
  return (
    <span className={s.av} data-kind={kind} data-size={size} aria-hidden="true">
      {text.length > 3 ? text.slice(0, 3) : text}
    </span>
  );
}
