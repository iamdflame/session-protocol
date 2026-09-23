import { useCallback, useEffect, useState } from 'react';

/* Starred markets, kept in this browser. One store for every surface that
   shows a star, so starring on an asset page shows on the markets table. */
const KEY = 'session.favorites';
const EVENT = 'session:favorites';

const read = (): Set<string> => {
  try { return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]')); } catch { return new Set(); }
};

export function useFavorites(): [Set<string>, (sym: string) => void] {
  const [favs, setFavs] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setFavs(read());
    const sync = () => setFavs(read());
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener(EVENT, sync); window.removeEventListener('storage', sync); };
  }, []);
  const toggle = useCallback((sym: string) => {
    const next = read();
    if (next.has(sym)) next.delete(sym); else next.add(sym);
    try { localStorage.setItem(KEY, JSON.stringify([...next])); } catch { /* blocked storage: the star just won't stick */ }
    setFavs(next);
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [favs, toggle];
}
