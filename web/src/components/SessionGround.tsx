/* ───────────────────────────────────────────────────────────────────────────
   The ground follows the market.

   This is the one piece of chrome that is also product: the page is in its
   night state because the market is shut, not because someone picked a theme.
   A viewer can pin it — some people read better one way, and that preference
   deserves respecting — but the default is the truth.
   ─────────────────────────────────────────────────────────────────────────── */

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { sessionAt, Session } from '@sdk/calendar.ts';

export type Ground = 'night' | 'day';
export type GroundMode = 'auto' | Ground;

interface Ctx {
  ground: Ground;
  mode: GroundMode;
  /** The ground the live session implies, regardless of any override. */
  live: Ground;
  setMode: (m: GroundMode) => void;
  /** False for the first frame, so nothing renders a value the markup lacks. */
  ready: boolean;
}

const GroundCtx = createContext<Ctx>({
  ground: 'night', mode: 'auto', live: 'night', setMode: () => {}, ready: false,
});

export const useGround = () => useContext(GroundCtx);

const KEY = 'session.ground';
const liveGround = (): Ground =>
  sessionAt(Math.floor(Date.now() / 1000)) === Session.Open ? 'day' : 'night';

export function GroundProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<GroundMode>('auto');
  const [live, setLive] = useState<Ground>('night');
  const [ready, setReady] = useState(false);

  // Restore any pin before the first tick so the ground does not flicker from
  // the live value to the pinned one.
  useEffect(() => {
    let stored: GroundMode = 'auto';
    try {
      const v = localStorage.getItem(KEY);
      if (v === 'night' || v === 'day' || v === 'auto') stored = v;
    } catch { /* private browsing, blocked storage — the default is fine */ }
    setModeState(stored);
    setLive(liveGround());
    setReady(true);
  }, []);

  // Re-check every 15s. A boundary lands on a whole minute, so this is well
  // inside a second of the turn without spending a timer per frame.
  useEffect(() => {
    const id = setInterval(() => setLive(liveGround()), 15_000);
    return () => clearInterval(id);
  }, []);

  const ground: Ground = mode === 'auto' ? live : mode;

  // Written imperatively because the blocking script in index.html already set
  // this attribute before first paint; React only ever corrects it.
  useEffect(() => {
    document.documentElement.dataset.session = ground;
  }, [ground]);

  const setMode = useCallback((m: GroundMode) => {
    setModeState(m);
    try { localStorage.setItem(KEY, m); } catch { /* not worth failing over */ }
  }, []);

  return (
    <GroundCtx.Provider value={{ ground, mode, live, setMode, ready }}>
      {children}
    </GroundCtx.Provider>
  );
}
