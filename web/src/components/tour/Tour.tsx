/* ───────────────────────────────────────────────────────────────────────────
   The 90-second tour.

   Seven stops across the pages a judge would otherwise have to find: what
   SESSION is, the two classes, the live clock, the instrument, the vault, what
   is on chain, and the research. Each stop points at the real thing on the
   real page — nothing is staged for the tour — with two sentences about it.

   It is a guide, not a modal: the page stays live and clickable underneath,
   the highlight takes no pointer events, Escape ends it anywhere, and the
   arrow keys move through it. A stop whose element is still loading (the
   vault reads devnet) waits for it rather than pointing at nothing.
   ─────────────────────────────────────────────────────────────────────────── */

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import s from './Tour.module.css';

interface Stop { path: string; target: string; title: string; body: string }

const STOPS: Stop[] = [
  {
    path: '/', target: '[data-tour="session"]', title: 'SESSION',
    body: 'A tokenized stock trades around the clock; the stock behind it trades six and a half hours a day. SESSION splits the exposure into two claims on one vault.',
  },
  {
    path: '/', target: '[data-tour="classes"]', title: 'DAY and NIGHT',
    body: 'DAY carries the regular session, NIGHT everything else. Only the class parked in quote can be minted or redeemed; the NAVs here are read from the vault account.',
  },
  {
    path: '/', target: '[data-tour="clock"]', title: 'The live clock',
    body: 'The countdown and the rail come from the same calendar the program settles on — DST, holidays and early closes included. Drag the rail to see who holds the stock at any minute.',
  },
  {
    path: '/', target: '[data-tour="nvda"]', title: 'NVDAx',
    body: 'The instrument: real NVDAx, priced live from Jupiter on mainnet. Its vault runs on devnet with test mints, and the site says so wherever that matters.',
  },
  {
    path: '/markets/NVDAx', target: '[data-tour="vault"]', title: 'The vault',
    body: 'Mint and redeem sign real devnet transactions: the preview is the program’s own floor at the on-chain NAV, and the button walks wallet, submit and confirm. No wallet? The demo does the same in a sandbox.',
  },
  {
    path: '/markets/NVDAx', target: '[data-tour="chain"]', title: 'On-chain state',
    body: 'Everything underneath — oracle, settlement, funding, health from the SDK’s evaluate(), the full ledger and every account — is in Protocol details, each linked to Solscan.',
  },
  {
    path: '/research', target: '[data-tour="research"]', title: 'The research',
    body: 'The measurement the product is built on: hour for hour NIGHT does not out-earn DAY, but it is far wider. Every figure is read from the published study, not typed in.',
  },
];

const Ctx = createContext<{ start: () => void }>({ start: () => {} });
export const useTour = () => useContext(Ctx);

export function TourProvider({ children }: { children: ReactNode }) {
  const [step, setStep] = useState<number | null>(null);
  const start = useCallback(() => setStep(0), []);
  return (
    <Ctx.Provider value={{ start }}>
      {children}
      {step !== null && <TourStop step={step} setStep={setStep} />}
    </Ctx.Provider>
  );
}

function TourStop({ step, setStep }: { step: number; setStep: (n: number | null) => void }) {
  const stop = STOPS[step];
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [rect, setRect] = useState<DOMRect | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const last = step === STOPS.length - 1;

  const end = useCallback(() => setStep(null), [setStep]);
  const go = useCallback((n: number) => { if (n >= 0 && n < STOPS.length) setStep(n); }, [setStep]);

  // Take the reader to the stop's page, then find the element — waiting for
  // it when the page is still reading the chain.
  useEffect(() => {
    if (pathname !== stop.path) navigate(stop.path);
  }, [stop.path, pathname, navigate]);

  useEffect(() => {
    setRect(null);
    let raf = 0, found = false;
    const t0 = performance.now();
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const loop = () => {
      const el = document.querySelector<HTMLElement>(stop.target);
      if (el) {
        if (!found) { found = true; el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' }); }
        const r = el.getBoundingClientRect();
        setRect(prev => (prev && prev.x === r.x && prev.y === r.y && prev.width === r.width && prev.height === r.height ? prev : r));
      }
      if (found || performance.now() - t0 < 30_000) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [stop.target, pathname]);

  useEffect(() => { next.current?.focus({ preventScroll: true }); }, [step, rect === null]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); end(); }
      else if (e.key === 'ArrowRight' && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); last ? end() : go(step + 1); }
      else if (e.key === 'ArrowLeft' && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); go(step - 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, last, end, go]);

  // Below the element when it fits, above when it does not; never off screen.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.min(340, vw - 24);
    const h = card.current?.offsetHeight ?? 200;
    if (!rect) { setPos({ top: Math.max(12, vh / 2 - h / 2), left: vw / 2 - w / 2 }); return; }
    const below = rect.bottom + 12 + h <= vh - 12;
    const top = below ? rect.bottom + 12 : Math.max(12, rect.top - 12 - h);
    const left = Math.min(Math.max(12, rect.left + rect.width / 2 - w / 2), vw - w - 12);
    setPos({ top, left });
  }, [rect]);

  return (
    <>
      {rect && (
        <div
          className={s.ring} aria-hidden="true"
          style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }}
        />
      )}
      <div
        ref={card} className={s.card} role="dialog" aria-modal="false" aria-labelledby="tour-title" aria-describedby="tour-body"
        style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}
      >
        <div className={s.head}>
          <span className={`num ${s.count}`}>{step + 1} / {STOPS.length}</span>
          <button type="button" className={s.close} onClick={end} aria-label="End the tour"><Icon name="close" size={14} /></button>
        </div>
        <h2 className={s.title} id="tour-title">{stop.title}</h2>
        <p className={s.body} id="tour-body">{rect ? stop.body : 'Loading this part of the page…'}</p>
        <div className={s.dots} aria-hidden="true">
          {STOPS.map((_, i) => <span key={i} data-on={i === step || undefined} data-done={i < step || undefined} />)}
        </div>
        <div className={s.actions}>
          <Button variant="tertiary" size="sm" onClick={() => go(step - 1)} disabled={step === 0}>Back</Button>
          <Button ref={next} size="sm" onClick={() => (last ? end() : go(step + 1))}>
            {last ? 'Finish' : 'Next'} {!last && <Icon name="chevronRight" size={14} />}
          </Button>
        </div>
      </div>
    </>
  );
}
