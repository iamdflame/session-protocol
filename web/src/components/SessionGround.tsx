/* ───────────────────────────────────────────────────────────────────────────
   The active side follows the market, and only the market.

   `data-session` on <html> names the class holding the stock right now: "day"
   while NYSE's regular session is open, "night" otherwise. It is set before
   first paint by the generated inline script (scripts/gen-ground.ts, checked
   against the calendar across 313,117 timestamps) and corrected here as the
   clock turns over.

   It used to be a theme a reader could pin. It no longer is. The surfaces are
   always dark; what this attribute moves is the *active* identity — the rail,
   the clock, the status chip, the call to act — and a pinned value would let
   the interface say DAY holds the stock while the market is shut. A stale pin
   from the old behaviour is removed on sight.
   ─────────────────────────────────────────────────────────────────────────── */

import { createContext, useContext, useEffect, useState } from 'react';
import { sessionAt, Session } from '@sdk/calendar.ts';

export type Ground = 'night' | 'day';

interface Ctx {
  /** The side carrying the stock right now. */
  ground: Ground;
  /** False for the first frame, so nothing renders a value the markup lacks. */
  ready: boolean;
}

const GroundCtx = createContext<Ctx>({ ground: 'night', ready: false });

export const useGround = () => useContext(GroundCtx);

const liveGround = (): Ground =>
  sessionAt(Math.floor(Date.now() / 1000)) === Session.Open ? 'day' : 'night';

export function GroundProvider({ children }: { children: React.ReactNode }) {
  const [ground, setGround] = useState<Ground>('night');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try { localStorage.removeItem('session.ground'); } catch { /* blocked storage */ }
    setGround(liveGround());
    setReady(true);
    // A boundary lands on a whole minute; a 5s check puts the accent within
    // seconds of the bell without a timer per frame.
    const id = setInterval(() => setGround(liveGround()), 5_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.session = ground;
  }, [ground]);

  return <GroundCtx.Provider value={{ ground, ready }}>{children}</GroundCtx.Provider>;
}
