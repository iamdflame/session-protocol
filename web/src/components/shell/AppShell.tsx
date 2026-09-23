/* The application frame.
 *
 * ≥ 1100px: a persistent 232px rail, a quiet top strip, the page.
 * 721–1099px: the rail collapses to icons — a compact workstation.
 * ≤ 720px: a compact top bar and a thumb-reach bottom navigation.
 *
 * Route changes cross-fade the page in 180ms and nothing else moves: the rail,
 * the market chip and the wallet stay put, because they are the same object
 * on every screen. */
import { useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { SideRail } from './SideRail';
import { TopBar } from './TopBar';
import { BottomNav } from './BottomNav';
import { PaletteProvider } from './CommandPalette';
import { TourProvider } from '../tour/Tour';
import { Footer } from '../Footer';
import s from './Shell.module.css';

export function AppShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <TourProvider>
    <PaletteProvider>
      <div className={s.app}>
        <SideRail />
        <div className={s.column}>
          <TopBar />
          <main id="main" className={s.main}>
            <div key={pathname} className={s.route}>{children}</div>
          </main>
          <Footer />
        </div>
      </div>
      <BottomNav />
    </PaletteProvider>
    </TourProvider>
  );
}
