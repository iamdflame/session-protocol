import { Suspense, lazy, useEffect, useRef } from 'react';
import { Route, Routes, useLocation, useSearchParams } from 'react-router-dom';
import { GroundProvider } from '@/components/SessionGround';
import { WalletProviders } from '@/components/wallet/WalletProviders';
import { AppShell } from '@/components/shell/AppShell';
import { ToastProvider } from '@/components/ui/Toast';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { RouteFallback } from '@/components/RouteFallback';

const Landing = lazy(() => import('@/pages/Landing'));
const Markets = lazy(() => import('@/pages/Markets'));
const Vault = lazy(() => import('@/pages/Vault'));
const Research = lazy(() => import('@/pages/Research'));
const HowItWorks = lazy(() => import('@/pages/HowItWorks'));
const Bell = lazy(() => import('@/pages/Bell'));
const Oracle = lazy(() => import('@/pages/Oracle'));
const Bells = lazy(() => import('@/pages/Bells'));
const Receipt = lazy(() => import('@/pages/Receipt'));
const List = lazy(() => import('@/pages/List'));
const NotFound = lazy(() => import('@/pages/NotFound'));
const Portfolio = lazy(() => import('@/pages/Portfolio'));

/* /trade is the trading screen for one instrument: NVDAx unless ?asset= names
   another. It is the asset page in its trade-first form, not a second copy of
   it, so a deep link to either lands on the same state. */
function TradeRoute() {
  const [q] = useSearchParams();
  // ?demo=1 is the read-only sandbox; everything else is the live page.
  return <Vault symbol={q.get('asset') ?? 'NVDAx'} demo={q.get('demo') === '1'} />;
}

/**
 * Scroll behaviour on navigation.
 *
 * A new route starts at the top; a hash jumps to its anchor; going *back*
 * restores where you were, which the browser does on its own as long as we do
 * not fight it. The research page is long enough that losing your place in it
 * would be the difference between reading it and giving up.
 */
function Scroll() {
  const { pathname, hash, key } = useLocation();
  const seen = useRef(new Set<string>());

  useEffect(() => {
    if (hash) {
      const el = document.querySelector(hash);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    }
    // A key we have seen before is a history pop — leave the restored position.
    if (seen.current.has(key)) return;
    seen.current.add(key);
    window.scrollTo(0, 0);
  }, [pathname, hash, key]);

  return null;
}

/**
 * Moves focus to the page heading after a route change.
 *
 * Client routing replaces the document without telling a screen reader, so a
 * keyboard user is left wherever the old page's focus was. Announcing the new
 * heading is the cheapest way to keep the app usable without a mouse.
 */
function FocusOnRoute() {
  const { pathname } = useLocation();
  const first = useRef(true);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const h = document.querySelector<HTMLElement>('main h1');
    if (h) {
      h.setAttribute('tabindex', '-1');
      h.focus({ preventScroll: true });
    }
  }, [pathname]);

  return null;
}

export function App() {
  const { pathname } = useLocation();

  return (
    <GroundProvider>
    <WalletProviders>
    <ToastProvider>
      <Scroll />
      <FocusOnRoute />
      <a className="skip-link" href="#main">Skip to content</a>
      <AppShell>
        <ErrorBoundary key={pathname}>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/trade" element={<TradeRoute />} />
              <Route path="/portfolio" element={<Portfolio />} />
              <Route path="/markets" element={<Markets />} />
              <Route path="/markets/:symbol" element={<Vault />} />
              <Route path="/research" element={<Research />} />
              <Route path="/how-it-works" element={<HowItWorks />} />
              <Route path="/bell" element={<Bell />} />
              <Route path="/oracle" element={<Oracle />} />
              <Route path="/bells" element={<Bells />} />
              <Route path="/b/:cross" element={<Receipt />} />
              <Route path="/list" element={<List />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </AppShell>
    </ToastProvider>
    </WalletProviders>
    </GroundProvider>
  );
}
