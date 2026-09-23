/* ───────────────────────────────────────────────────────────────────────────
   The mechanism, in seven steps.

   One schematic — the day as a rail, the vault with its stock and its quote,
   DAY and NIGHT as the two claims on it — and seven states of it, from a
   vault at rest through the bell to the transaction that settles it. Each
   step changes one thing in the picture, so the eye follows the mechanism
   rather than reading about it.

   It is a diagram, not a dashboard: there are no balances in it, because a
   number here would be either invented or a copy of the chain, and the vault
   pages already show the chain. The times and the funding cap are real; the
   rest is structure.
   ─────────────────────────────────────────────────────────────────────────── */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMedia } from '@/lib/useMedia';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import s from './Mechanism.module.css';

const STEPS = [
  {
    t: 'A vault holds the tokenized equity.',
    b: 'One program account holds NVDAx and quote. DAY and NIGHT are two claims on it — nothing is borrowed and nothing is synthetic.',
  },
  {
    t: 'One class is exposed.',
    b: 'During the regular session DAY holds the stock and earns its moves. NIGHT is parked in quote: flat, and the only class that can be minted or redeemed.',
  },
  {
    t: 'The market closes.',
    b: 'At 16:00 ET the bell rings. The calendar is the same integer arithmetic the program settles on — DST, holidays and early closes included.',
  },
  {
    t: 'The session changes.',
    b: 'It is now NIGHT. Settlement is due, and anyone can send it; until it lands DAY still holds the stock, and the site says so rather than pretend.',
  },
  {
    t: 'Exposure moves between DAY and NIGHT.',
    b: 'DAY’s value goes to quote and NIGHT takes the stock. Only the difference between what NIGHT is owed and what DAY held trades — when the classes are close, almost nothing touches a market.',
  },
  {
    t: 'Funding prices the transfer of risk.',
    b: 'The larger class pays the smaller, in proportion to the skew and capped at 0.50% a bell. It is the price of holding a session, quoted continuously for the first time.',
  },
  {
    t: 'Solana settles the accounting.',
    b: 'Roll, fund and flip are one settle_boundary transaction. It needs no signer, refuses a stale price, and halts rather than write a loss into the other class.',
  },
];

/* Two layouts of one picture. On a desk the claims flank the vault; on a
   phone they sit above it, so the canvas is narrow enough that its labels
   stay legible when it is scaled to the screen. */
const geometry = (tall: boolean) => {
  if (!tall) {
    return {
      w: 760, h: 400, cx: 380, hx: (h: number) => 40 + (h / 24) * 680,
      dayX: 40, nightX: 540, cy: 150, cw: 180, ch: 100, vy: 130, fundY: 84, txY: 346,
      fund: 'M630 140 C630 96 130 96 130 140',
      links: {
        dayStock: 'M220 200 C262 200 262 178 306 178', dayQuote: 'M220 200 C262 200 262 236 306 236',
        nightStock: 'M540 200 C498 200 498 178 454 178', nightQuote: 'M540 200 C498 200 498 236 454 236',
        dayRest: 'M220 200 C262 200 262 207 290 207', nightRest: 'M540 200 C498 200 498 207 470 207',
      },
    };
  }
  return {
    w: 360, h: 580, cx: 180, hx: (h: number) => 20 + (h / 24) * 320,
    dayX: 20, nightX: 190, cy: 150, cw: 150, ch: 84, vy: 290, fundY: 96, txY: 510,
    fund: 'M265 150 C265 118 95 118 95 150',
    links: {
      dayStock: 'M95 234 C95 300 70 339 106 339', dayQuote: 'M95 234 C95 360 70 397 106 397',
      nightStock: 'M265 234 C265 300 290 339 254 339', nightQuote: 'M265 234 C265 360 290 397 254 397',
      dayRest: 'M95 234 C95 330 80 363 90 363', nightRest: 'M265 234 C265 330 280 363 270 363',
    },
  };
};

export function Mechanism() {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const n = STEPS.length;

  useEffect(() => {
    if (!playing) return;
    if (step >= n - 1) { setPlaying(false); return; }
    const t = setTimeout(() => setStep(v => v + 1), 4200);
    return () => clearTimeout(t);
  }, [playing, step, n]);

  const go = (i: number, focus = false) => {
    const k = (i + n) % n;
    setStep(k);
    if (focus) tabs.current[k]?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    const map: Record<string, number> = { ArrowRight: step + 1, ArrowDown: step + 1, ArrowLeft: step - 1, ArrowUp: step - 1, Home: 0, End: n - 1 };
    if (!(e.key in map)) return;
    e.preventDefault();
    setPlaying(false);
    go(map[e.key], true);
  };

  // What the picture shows at this step.
  const dayExposed = step >= 1 && step <= 3;
  const nightExposed = step >= 4;
  const markerH = step <= 1 ? 15 : step === 2 ? 16 : 17.6;
  const sessionWord = step <= 2 ? 'DAY active' : 'NIGHT active';
  const cur = STEPS[step];
  const tall = useMedia('(max-width: 640px)');
  const G = geometry(tall);

  return (
    <section className={s.wrap} aria-labelledby="mech-h">
      <div className={s.top}>
        <div>
          <span className={s.eyebrow}>The mechanism</span>
          <h2 className={s.h2} id="mech-h">Seven steps, one bell</h2>
        </div>
        <div className={s.controls}>
          <Button variant="secondary" size="sm" onClick={() => { setPlaying(false); go(step - 1); }} disabled={step === 0} aria-label="Previous step">
            <Icon name="chevronRight" size={14} style={{ transform: 'rotate(180deg)' }} />
          </Button>
          <Button variant="secondary" size="sm" onClick={() => { if (step === n - 1) setStep(0); setPlaying(p => !p); }}
                  aria-pressed={playing}>
            <Icon name="play" size={13} /> {playing ? 'Pause' : step === n - 1 ? 'Replay' : 'Play'}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => { setPlaying(false); go(step + 1); }} disabled={step === n - 1} aria-label="Next step">
            <Icon name="chevronRight" size={14} />
          </Button>
        </div>
      </div>

      <div className={s.body}>
        <div className={s.tabs} role="tablist" aria-label="Steps" aria-orientation="vertical" onKeyDown={onKey}>
          {STEPS.map((st, i) => (
            <button
              key={st.t} ref={el => { tabs.current[i] = el; }}
              role="tab" id={`mech-tab-${i}`} aria-selected={i === step} aria-controls="mech-panel"
              tabIndex={i === step ? 0 : -1} className={s.tab} data-done={i < step || undefined}
              onClick={() => { setPlaying(false); go(i); }}
            >
              <span className={`num ${s.tabN}`}>{i + 1}</span>
              <span className={s.tabT}>{st.t}</span>
            </button>
          ))}
        </div>

        <div className={s.stage} role="tabpanel" id="mech-panel" aria-labelledby={`mech-tab-${step}`}>
          <svg viewBox={`0 0 ${G.w} ${G.h}`} className={s.svg} data-step={step + 1} data-tall={tall || undefined} role="img"
               aria-label={`Step ${step + 1} of ${n}: ${cur.t}`}>
            {/* the day */}
            <g className={s.rail}>
              <rect x={G.hx(0)} y={40} width={G.hx(9.5) - G.hx(0)} height={8} rx={4} className={s.segNight} />
              <rect x={G.hx(9.5)} y={40} width={G.hx(16) - G.hx(9.5)} height={8} className={s.segDay} />
              <rect x={G.hx(16)} y={40} width={G.hx(24) - G.hx(16)} height={8} rx={4} className={s.segNight} />
              <line x1={G.hx(9.5)} x2={G.hx(9.5)} y1={32} y2={56} className={s.bell} />
              <line x1={G.hx(16)} x2={G.hx(16)} y1={32} y2={56} className={s.bell} data-on={step === 2 || undefined} />
              <text x={G.hx(9.5)} y={24} textAnchor="middle" className={s.tick}>09:30</text>
              <text x={G.hx(16)} y={24} textAnchor="middle" className={s.tick} data-on={step === 2 || undefined}>16:00 ET</text>
              {step === 2 && <circle cx={G.hx(16)} cy={44} r={14} className={s.ring} />}
              <g className={s.marker} style={{ transform: `translateX(${G.hx(markerH)}px)` }}>
                <circle cx={0} cy={44} r={7} data-cls={step <= 2 ? 'day' : 'night'} />
              </g>
              <text x={G.hx(0)} y={74} className={s.session} data-cls={step <= 2 ? 'day' : 'night'}>{sessionWord}</text>
              <text x={G.hx(24)} y={74} textAnchor="end" className={s.market}>
                {step <= 1 ? (tall ? '15:00 ET · NYSE open' : 'an example day · 15:00 ET · NYSE open') : step === 2 ? '16:00 ET · the closing bell' : '17:36 ET · NYSE closed'}
              </text>
            </g>

            {/* funding, above the vault */}
            <g className={s.funding} data-on={step === 5 || undefined}>
              <path d={G.fund} className={s.fundPath} markerEnd="url(#mech-arrow)" />
              <rect x={G.cx - 114} y={G.fundY} width={228} height={24} rx={12} className={s.fundChip} />
              <text x={G.cx} y={G.fundY + 16} textAnchor="middle" className={s.fundText}>larger class pays · ≤ 0.50% a bell</text>
            </g>

            {/* links: which compartment each claim is on */}
            <g className={s.links}>
              <path d={G.links.dayStock} className={s.link} data-cls="day" data-on={dayExposed || undefined} />
              <path d={G.links.dayQuote} className={s.linkQ} data-on={step >= 1 && !dayExposed || undefined} />
              <path d={G.links.nightStock} className={s.link} data-cls="night" data-on={nightExposed || undefined} />
              <path d={G.links.nightQuote} className={s.linkQ} data-on={step >= 1 && !nightExposed || undefined} />
              <path d={G.links.dayRest} className={s.linkRest} data-on={step === 0 || undefined} />
              <path d={G.links.nightRest} className={s.linkRest} data-on={step === 0 || undefined} />
            </g>

            {/* the vault */}
            <g className={s.vault} data-on={step === 0 || step === 6 || undefined}>
              <rect x={G.cx - 90} y={G.vy} width={180} height={146} rx={14} className={s.vaultBox} />
              <text x={G.cx} y={G.vy + 20} textAnchor="middle" className={s.vaultLabel}>VAULT</text>
              <rect x={G.cx - 74} y={G.vy + 30} width={148} height={38} rx={8} className={s.comp} data-cls={nightExposed ? 'night' : dayExposed ? 'day' : undefined} />
              <text x={G.cx} y={G.vy + 54} textAnchor="middle" className={s.compText}>NVDAx · the stock</text>
              <rect x={G.cx - 74} y={G.vy + 88} width={148} height={38} rx={8} className={s.compQ} />
              <text x={G.cx} y={G.vy + 112} textAnchor="middle" className={s.compText}>Quote</text>
            </g>

            {/* the two claims */}
            {(['day', 'night'] as const).map(c => {
              const x = c === 'day' ? G.dayX : G.nightX;
              const on = c === 'day' ? dayExposed : nightExposed;
              return (
                <g key={c} className={s.cls} data-cls={c} data-on={on || undefined}>
                  <rect x={x} y={G.cy} width={G.cw} height={G.ch} rx={12} className={s.clsBox} />
                  <text x={x + 14} y={G.cy + 24} className={s.clsTag}>{c.toUpperCase()}</text>
                  <text x={x + 14} y={G.cy + 46} className={s.clsName}>NVDA.{c.toUpperCase()}</text>
                  <text x={x + 14} y={G.cy + G.ch - 18} className={s.clsState}>
                    {step === 0 ? 'a claim on the vault' : on ? 'holding the stock' : 'parked in quote'}
                  </text>
                </g>
              );
            })}

            {/* the handoff, below the vault */}
            <g className={s.handoff} data-on={step === 4 || undefined}>
              <path d={`M${G.cx} ${G.vy + 146} L${G.cx} ${G.vy + 170}`} className={s.handPath} markerEnd="url(#mech-arrow)" />
              <rect x={G.cx - 130} y={G.vy + 174} width={260} height={28} rx={14} className={s.handChip} />
              <text x={G.cx} y={G.vy + 192} textAnchor="middle" className={s.handText}>only the difference trades</text>
            </g>

            {/* the transaction */}
            <g className={s.tx} data-on={step === 6 || undefined}>
              <rect x={G.hx(0)} y={G.txY} width={G.hx(24) - G.hx(0)} height={tall ? 54 : 40} rx={10} className={s.txBox} />
              <text x={G.hx(0) + 16} y={G.txY + 25} className={s.txMono}>settle_boundary</text>
              <text x={tall ? G.hx(0) + 16 : G.hx(0) + 160} y={G.txY + (tall ? 44 : 25)} className={s.txText}>
                {tall ? 'roll → fund → flip · one transaction' : 'roll → fund → flip · one transaction · no signer · halts before a loss'}
              </text>
              <path d={`M${G.hx(24) - 30} ${G.txY + 14} l6 6 l12 -12`} className={s.txCheck} />
            </g>

            <g className={s.dueG} data-on={step === 3 || undefined}>
              <rect x={G.cx - 130} y={G.vy + 174} width={260} height={28} rx={14} className={s.dueChip} />
              <text x={G.cx} y={G.vy + 192} textAnchor="middle" className={s.due}>settlement due · anyone can send it</text>
            </g>

            <defs>
              <marker id="mech-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10 z" className={s.arrowHead} />
              </marker>
            </defs>
          </svg>

          <div className={s.caption} aria-live="polite">
            <span className={`num ${s.capN}`}>{String(step + 1).padStart(2, '0')} / {String(n).padStart(2, '0')}</span>
            <h3 className={s.capT}>{cur.t}</h3>
            <p className={s.capB}>{cur.b}</p>
            {step === n - 1 && (
              <p className={s.capLinks}>
                <Link to="/markets/NVDAx">See it on the NVDAx vault <Icon name="chevronRight" size={12} /></Link>
                <Link to="/bell">Watch the next bell <Icon name="chevronRight" size={12} /></Link>
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
