/* ───────────────────────────────────────────────────────────────────────────
   Mint and redeem — one panel, whichever vault is behind it.

   The one rule that shapes it: a class can only be minted or redeemed while it
   is *parked*. Money entering the exposed class mid-session would take a share
   of a return the existing holders had already earned, so the program refuses
   it — and rather than grey out a button and leave the reader guessing, the
   panel says which class is open, why the other is not, and when it reopens.

   A transaction is shown as the five things it actually is — review, the
   wallet's approval, submission, confirmation, done — with the action's own
   label kept on the button throughout. A simulated trade has none of the
   middle three and does not pretend to: it applies, and says where.
   ─────────────────────────────────────────────────────────────────────────── */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { TxStage } from '@/lib/chain';
import { explorer } from '@/lib/chain';
import { fmtUsd } from '@/lib/data';
import { useSession, countdown } from '@/lib/session';
import { useMedia } from '@/lib/useMedia';
import { OP_MESSAGE } from '@/lib/localVault';
import { Button } from '../ui/Button';
import { Segmented } from '../ui/Segmented';
import { Status, ClassTag } from '../ui/Status';
import { Source } from '../ui/Source';
import { Term } from '../ui/Tooltip';
import { Icon } from '../ui/Icon';
import { useToast } from '../ui/Toast';
import type { Cls, Mode, Outcome, TradeEngine } from './engine';
import s from './TradePanel.module.css';

type Stage = 'idle' | TxStage | 'complete';
const STEPS: { id: Stage; label: string }[] = [
  { id: 'idle', label: 'Review' },
  { id: 'wallet', label: 'Wallet' },
  { id: 'submitting', label: 'Submitting' },
  { id: 'confirming', label: 'Confirming' },
  { id: 'complete', label: 'Complete' },
];
const ORDER: Record<Stage, number> = { idle: 0, wallet: 1, submitting: 2, confirming: 3, complete: 4 };
const PROGRESS: Record<Stage, string> = {
  idle: '',
  wallet: 'Waiting for your wallet…',
  submitting: 'Submitting to devnet…',
  confirming: 'Confirming on devnet…',
  complete: 'Confirmed',
};

/** An amount as the input field would hold it: at most six decimals, no float dust. */
const asInput = (n: number) => (n > 0 ? n.toFixed(6).replace(/\.?0+$/, '') : '');
const qty = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

export interface TradeRequest { cls: Cls; mode: Mode; n: number }

export function TradePanel({ engine, symbol, name, request, initialClass }: {
  engine: TradeEngine;
  symbol: string;
  name: string;
  /** Set by the page (a Mint button on a class card) to point the panel at a class. */
  request?: TradeRequest | null;
  initialClass?: Cls | null;
}) {
  const id = useId();
  const sess = useSession();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);

  const [mode, setMode] = useState<Mode>(request?.mode ?? 'mint');
  const [cls, setCls] = useState<Cls>(request?.cls ?? initialClass ?? engine.parked);
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState<'tx' | 'faucet' | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [result, setResult] = useState<(Outcome & { from: 'trade' | 'faucet' }) | null>(null);

  const { parked, names, words, halted } = engine;
  const live = engine.kind === 'live';

  /* Follow the handover: the class that was open a second ago is now the one
     holding the stock, and leaving the form pointed at it would be a trap. */
  const lastParked = useRef(parked);
  useEffect(() => {
    if (lastParked.current !== parked) {
      lastParked.current = parked;
      setCls(parked);
    }
  }, [parked]);

  const lastReq = useRef(request?.n);
  useEffect(() => {
    if (!request || request.n === lastReq.current) return;
    lastReq.current = request.n;
    setMode(request.mode); setCls(request.cls); setRaw(''); setResult(null); setStage('idle');
    // After the page has scrolled or the sheet has opened.
    requestAnimationFrame(() => input.current?.focus({ preventScroll: false }));
  }, [request]);

  const amount = Number(raw);
  const valid = raw !== '' && Number.isFinite(amount) && amount > 0;
  const preview = valid ? engine.preview(mode, cls, amount) : null;
  const notParked = cls !== parked;
  const connected = !engine.wallet.needed || engine.wallet.connected;
  const canSubmit = !!preview?.ok && connected && !busy;
  const fees = engine.fees(mode, cls);

  // The balance the quick amounts are a share of.
  const base = mode === 'mint' ? engine.quoteBalance : engine.held[cls];
  const fixed = mode === 'mint' && base === null ? engine.quickMint : undefined;

  const reset = (m: Mode = mode) => { setMode(m); setRaw(''); setResult(null); setStage('idle'); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy('tx'); setResult(null); setStage('idle');
    const r = await engine.execute(mode, cls, amount, st => setStage(st));
    setBusy(null);
    if (r.ok) {
      setStage(live ? 'complete' : 'idle');
      setResult({ ...r, from: 'trade' });
      setRaw('');
      toast({
        tone: 'ok',
        title: live ? (mode === 'mint' ? 'Mint confirmed' : 'Redemption confirmed')
          : engine.kind === 'demo' ? (mode === 'mint' ? 'Minted in the demo' : 'Redeemed in the demo')
          : (mode === 'mint' ? 'Minted in the simulation' : 'Redeemed in the simulation'),
        detail: r.detail,
        href: r.sig ? explorer(r.sig) : undefined,
      });
    } else {
      setStage('idle');
      setResult({ ...r, from: 'trade' });
    }
  };

  const faucet = async () => {
    if (!engine.faucet) return;
    setBusy('faucet'); setResult(null);
    const r = await engine.faucet.run();
    setBusy(null);
    setResult({ ...r, from: 'faucet' });
    if (r.ok) toast({ tone: 'ok', title: 'Test quote sent', detail: r.detail, href: r.sig ? explorer(r.sig) : undefined });
  };

  /* Every disabled state carries its reason, in the same place. */
  const why: ReactNode =
    busy === 'tx' ? null
      : halted ? 'Vault halted — the program refuses every trade until it resumes.'
      : notParked ? <>{names[cls]} holds the exposure{engine.reopens ? <> until {engine.reopens}</> : null}. {names[parked]} is open.</>
      : !valid ? (mode === 'mint' ? 'Enter an amount of quote to mint with.' : 'Enter a number of shares to redeem.')
      : preview && !preview.ok ? 'Fix the amount above.'
      : null;

  const statusKind = halted ? 'halted' : notParked ? 'mint-closed' : 'mint-available';
  const statusWord = halted ? 'Halted'
    : notParked ? `${mode === 'mint' ? 'Mint' : 'Redeem'} closed`
    : `${mode === 'mint' ? 'Mint' : 'Redeem'} available`;

  return (
    <section className={s.panel} aria-label={`Trade ${symbol}`} data-kind={engine.kind}>
      <header className={s.head}>
        <div className={s.title}>
          <h2 className={s.h2}>{mode === 'mint' ? 'Mint' : 'Redeem'}</h2>
          {engine.kind === 'live' ? <Status kind="devnet" label="Live · devnet" pulse />
            : engine.kind === 'demo' ? <Status kind="demo" label="Demo · simulated" />
            : <Status kind="simulated" label="Simulated" />}
        </div>
        <dl className={s.rows}>
          <div><dt>Asset</dt><dd><span className="mono">{symbol}</span><span className={s.rowSub}>{name}</span></dd></div>
          <div>
            <dt>Session</dt>
            <dd>
              {engine.reopens === null
                ? <span className={s.rowSub}>No bell — an event vault</span>
                : sess
                  ? <><ClassTag cls={sess.holder === 'DAY' ? 'day' : 'night'} active>{sess.holder}</ClassTag><span className={`num ${s.rowSub}`}>{countdown(sess.until)}</span></>
                  : <span className="skeleton" style={{ width: 90, height: 14 }} />}
            </dd>
          </div>
          <div><dt>Status</dt><dd><Status kind={statusKind} label={statusWord} bare /></dd></div>
        </dl>
      </header>

      <form className={s.form} onSubmit={submit} noValidate>
        {/* Two columns when the panel is wide (a tablet, where it spans the
            page): what you choose on the left, what you get on the right. */}
        <div className={s.colA}>
        <Segmented
          label="Operation" value={mode} onChange={v => reset(v)} block
          items={[{ value: 'mint', label: 'Mint' }, { value: 'redeem', label: 'Redeem' }]}
        />

        <fieldset className={s.classes}>
          <legend className={s.legend}>Class</legend>
          {(['day', 'night'] as Cls[]).map(k => {
            const open = k === parked && !halted;
            return (
              <label key={k} className={s.cls} data-class={k} data-on={cls === k} data-open={open}>
                <input type="radio" name={`${id}-class`} value={k} checked={cls === k}
                       onChange={() => { setCls(k); setResult(null); setStage('idle'); }} className="sr-only" />
                <span className={s.clsTag}>{names[k]}</span>
                <span className={s.clsState}>{halted ? 'halted' : open ? 'open' : 'holding the stock'}</span>
              </label>
            );
          })}
        </fieldset>

        {notParked && !halted && (
          <p className={s.blocked} role="status">
            <strong>{names[cls]} is carrying the exposure.</strong>{' '}
            {engine.reopens !== null
              ? <>It reopens at the next boundary{sess ? <> — in <span className="num">{countdown(sess.until)}</span>, {engine.reopens}</> : ''}.</>
              : <>It reopens when the boundary moves it back to quote.</>}
            {' '}{OP_MESSAGE['not-parked']}
          </p>
        )}
        {halted && (
          <p className={s.alert} role="alert">
            <strong>Halted — {halted}.</strong> {OP_MESSAGE.halted}
          </p>
        )}

        <div className={s.field}>
          <label className={s.fieldLabel} htmlFor={`${id}-amt`}>
            {mode === 'mint' ? 'Amount · quote in' : `Amount · ${words[cls]} shares`}
          </label>
          <div className={s.inputWrap} data-invalid={(preview && !preview.ok && preview.kind === 'input') || undefined}>
            {mode === 'mint' && <span className={s.affix}>$</span>}
            <input
              ref={input} id={`${id}-amt`} data-autofocus
              className={`num ${s.input}`} type="text" inputMode="decimal" autoComplete="off"
              value={raw} placeholder="0.00"
              onChange={e => { const v = e.target.value; if (v === '' || /^\d*\.?\d{0,6}$/.test(v)) { setRaw(v); if (result) setResult(null); if (stage === 'complete') setStage('idle'); } }}
              aria-describedby={`${id}-bal ${id}-preview`}
              disabled={busy === 'tx'}
            />
            {mode === 'redeem' && <span className={`mono ${s.affix}`}>{words[cls]}</span>}
          </div>
          <p className={s.balance} id={`${id}-bal`}>
            {mode === 'mint'
              ? engine.quoteBalance !== null ? <>Balance <span className="num">{fmtUsd(engine.quoteBalance, 2)}</span> test USDC</>
                : engine.wallet.needed ? 'Connect a wallet to see your balance.'
                : 'No balance limit — the simulation mints from nothing.'
              : engine.held[cls] !== null ? <>Held <span className="num">{qty(engine.held[cls]!)}</span> {names[cls]}</>
                : 'Connect a wallet to see your shares.'}
          </p>
          <div className={s.quick} role="group" aria-label="Quick amounts">
            {fixed
              ? fixed.map(v => (
                  <button key={v} type="button" className={s.chip} onClick={() => setRaw(String(v))} disabled={busy === 'tx'}>
                    ${v >= 1000 ? `${v / 1000}k` : v}
                  </button>
                ))
              : ([25, 50, 75, 100] as const).map(p => (
                  <button key={p} type="button" className={s.chip}
                          onClick={() => setRaw(asInput(p === 100 ? base ?? 0 : Math.floor((base ?? 0) * p / 100 * 1e6) / 1e6))}
                          disabled={!base || base <= 0 || busy === 'tx'}>
                    {p === 100 ? 'max' : `${p}%`}
                  </button>
                ))}
          </div>
        </div>

        </div>
        <div className={s.colB}>
        <dl className={s.preview} id={`${id}-preview`}>
          <div><dt>NAV per share</dt><dd className="num">{engine.nav[cls].toFixed(6)}</dd></div>
          <div className={s.out}>
            <dt>{mode === 'mint' ? 'You receive · shares' : 'You receive · quote'}</dt>
            <dd className="num" data-emph={!!preview?.ok || undefined}>{preview?.ok ? preview.outText : '—'}</dd>
          </div>
          <div><dt>Network fee</dt><dd>{fees.network}</dd></div>
          <div><dt>Protocol fee</dt><dd>{fees.protocol}</dd></div>
          <div>
            <dt><Term tip="The price the next bell settles against. Mint and redeem are priced at NAV, not at this mark.">Mark · {engine.mark.label}</Term></dt>
            <dd className={s.mark}>
              <span className="num">{engine.mark.value !== null ? fmtUsd(engine.mark.value) : '—'}</span>
              <Source kind={engine.mark.source} detail={engine.mark.detail} ageSec={engine.mark.ageSec} staleAfter={engine.mark.staleAfter} />
            </dd>
          </div>
        </dl>

        {preview && !preview.ok && preview.kind === 'input' && (
          <p className={s.alert} role="alert">{preview.reason}</p>
        )}
        {preview && !preview.ok && preview.kind === 'paused' && (
          <p className={s.alert} role="alert">{preview.reason}</p>
        )}

        <div className={s.act}>
          {!connected ? (
            <Button type="button" tone={cls} size="lg" block onClick={engine.wallet.connect}>
              Connect a wallet to {mode}
            </Button>
          ) : (
            <Button type="submit" tone={cls} size="lg" block disabled={!canSubmit}
                    loading={busy === 'tx'} progress={live ? PROGRESS[stage] || 'Preparing…' : 'Applying…'}>
              {mode === 'mint' ? 'Mint' : 'Redeem'} {names[cls]}
            </Button>
          )}
          {why && connected && <p className={s.why}>{why}</p>}
        </div>

        {live && (busy === 'tx' || stage === 'complete') && (
          <ol className={s.steps} aria-label="Transaction progress">
            {STEPS.map(st => {
              const at = ORDER[stage];
              const me = ORDER[st.id];
              const state = me < at || stage === 'complete' ? 'done' : me === at ? 'now' : 'todo';
              return (
                <li key={st.id} className={s.step} data-state={state} aria-current={state === 'now' ? 'step' : undefined}>
                  <span className={s.stepDot} aria-hidden="true">{state === 'done' && <Icon name="check" size={10} />}</span>
                  {st.label}
                </li>
              );
            })}
          </ol>
        )}
        <span className="sr-only" aria-live="polite">{busy === 'tx' ? PROGRESS[stage] : ''}</span>

        {result && (result.ok ? (
          <p className={s.done} role="status">
            <svg className={s.check} viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" /><path d="M6 10.4l2.6 2.6L14 7.6" /></svg>
            <span className={s.doneText}>
              <strong>{result.headline}</strong>
              <span className={`num ${s.doneDetail}`}>{result.detail}</span>
              {result.sig && (
                <a className={s.sig} href={explorer(result.sig)} target="_blank" rel="noreferrer">
                  View transaction <Icon name="external" size={11} />
                </a>
              )}
              {!result.sig && result.from === 'trade' && !live && (
                <span className={s.doneDetail}>
                  {engine.kind === 'demo'
                    ? 'Applied to the demo sandbox — nothing was signed or sent. On devnet this is a transaction your wallet signs.'
                    : 'Applied to the simulation in this browser — nothing was sent to a chain.'}
                </span>
              )}
            </span>
          </p>
        ) : (
          <p className={s.alert} role="alert">{result.error}</p>
        ))}

        <div className={s.rule}>
          <p>{mode === 'mint' ? 'Issue' : 'Redeem'} a class only while it is parked in quote.</p>
          <details className={s.more}>
            <summary>Why only the parked class?</summary>
            <p>{OP_MESSAGE['not-parked']}</p>
            <p>
              Rounding always favours the vault: minting floors the shares out, redeeming floors the quote out,
              so no trade can round a fraction of a unit away from the other holders.
              {live ? ' Every rule here is enforced by the program, not the page — the page just says them first.' : ' The simulation runs the same arithmetic the program does.'}
            </p>
          </details>
        </div>

        {engine.faucet && (
          <div className={s.faucet}>
            <div>
              <p className={s.faucetTitle}>Test quote</p>
              <p className={s.faucetSub}>
                You hold <span className="num">{fmtUsd(engine.quoteBalance ?? 0, 2)}</span> of test quote. The faucet
                mints 10,000 of the devnet USDC stand-in to your wallet after you sign a message proving the
                address is yours. No transaction, no fee.
              </p>
            </div>
            <Button type="button" variant="secondary" size="sm" onClick={faucet} disabled={!!busy} loading={busy === 'faucet'}>
              Get 10,000
            </Button>
          </div>
        )}
        </div>
      </form>
    </section>
  );
}

/* ── the mobile sheet ────────────────────────────────────────────────────── */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * The trade panel's home on a phone: a bottom sheet over a sticky action bar.
 *
 * On a wide screen this is a plain wrapper and the panel sits in the page's
 * right column. Below 720px the panel is hidden behind a bar that names the
 * open class and opens the sheet. The panel stays mounted either way, so a
 * transaction in flight survives the sheet being closed, and there is only
 * ever one form.
 */
export function TradeDock({ open, onOpenChange, label, bar, children }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  label: string;
  bar: ReactNode;
  children: ReactNode;
}) {
  const sheet = useMedia('(max-width: 720px)');
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const active = sheet && open;

  useEffect(() => {
    if (!active) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const el = panel.current;
    requestAnimationFrame(() => (el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE))?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onOpenChange(false); return; }
      if (e.key !== 'Tab' || !el) return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(x => x.offsetParent !== null);
      if (!items.length) return;
      const [a, z] = [items[0], items[items.length - 1]];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prev;
      opener.current?.focus();
    };
  }, [active, onOpenChange]);

  return (
    <>
      <div
        ref={panel} className={s.dock} data-sheet={sheet || undefined} data-open={open || undefined}
        role={active ? 'dialog' : undefined} aria-modal={active || undefined} aria-label={active ? label : undefined}
      >
        {sheet && (
          <div className={s.dockHead}>
            <span className={s.grab} aria-hidden="true" />
            <button type="button" className={s.dockClose} onClick={() => onOpenChange(false)} aria-label="Close trade sheet">
              <Icon name="close" />
            </button>
          </div>
        )}
        {children}
      </div>
      {active && <div className={s.scrim} onClick={() => onOpenChange(false)} aria-hidden="true" />}
      {sheet && !open && (
        <div className={s.bar}>
          <div className={s.barText}>{bar}</div>
          <Button ref={opener} size="md" onClick={() => onOpenChange(true)}>Trade</Button>
        </div>
      )}
    </>
  );
}
