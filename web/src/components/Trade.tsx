import { useEffect, useId, useMemo, useState } from 'react';
import { useSession, countdown } from '@/lib/session';
import { fmtUsd } from '@/lib/data';
import {
  planMint, planRedeem, applyMint, applyRedeem, navToNumber,
  fromShares, fromQuote, toQuote, toShares, OP_MESSAGE,
  type LocalVault, type ShareClass,
} from '@/lib/localVault';
import s from './Trade.module.css';

type Mode = 'mint' | 'redeem';

/**
 * Mint and redeem.
 *
 * The one rule that shapes this panel: a class can only be minted or redeemed
 * while it is *parked*. Money entering the exposed class mid-session would
 * take a share of a return the existing holders had already earned, so the
 * program refuses it — and rather than grey out the button and leave the
 * reader guessing, the panel says which class is open, why the other is not,
 * and exactly when it reopens.
 */
export function Trade({
  vault, price, onCommit,
}: {
  vault: LocalVault;
  price: number;
  onCommit: (v: LocalVault) => void;
}) {
  const sess = useSession();
  const id = useId();
  const [mode, setMode] = useState<Mode>('mint');
  const [cls, setCls] = useState<ShareClass>(vault.exposed === 'night' ? 'day' : 'night');
  const [raw, setRaw] = useState('');
  const [flash, setFlash] = useState<string | null>(null);

  // Follow the handover: the class that was open a second ago is now the one
  // holding the stock, and leaving the form pointed at it would be a trap.
  useEffect(() => {
    setCls(c => (vault.exposed === c ? (c === 'night' ? 'day' : 'night') : c));
  }, [vault.exposed]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 4200);
    return () => clearTimeout(t);
  }, [flash]);

  const parked: ShareClass = vault.exposed === 'night' ? 'day' : 'night';
  const nav = navToNumber(cls === 'night' ? vault.nightNav : vault.dayNav);
  const held = fromShares(cls === 'night' ? vault.myNight : vault.myDay);

  const amount = Number(raw);
  const valid = raw !== '' && Number.isFinite(amount) && amount > 0;

  const plan = useMemo(() => {
    if (!valid) return null;
    return mode === 'mint'
      ? planMint(vault, cls, toQuote(amount))
      : planRedeem(vault, cls, toShares(amount));
  }, [valid, mode, vault, cls, amount]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!plan || !plan.ok) return;
    const now = Math.floor(Date.now() / 1000);
    if (plan.kind === 'mint') {
      onCommit(applyMint(vault, cls, toQuote(amount), plan.shares, now));
      setFlash(`Minted ${fromShares(plan.shares).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${vault.symbol}.${cls.toUpperCase()}`);
    } else {
      onCommit(applyRedeem(vault, cls, toShares(amount), plan.quote, now));
      setFlash(`Redeemed for ${fmtUsd(fromQuote(plan.quote), 2)}`);
    }
    setRaw('');
  };

  const max = mode === 'redeem' ? held : null;

  return (
    <form className={`card ${s.card}`} onSubmit={submit}>
      <div className={s.modes} role="group" aria-label="Operation">
        {(['mint', 'redeem'] as Mode[]).map(m => (
          <button
            key={m} type="button"
            className={s.mode} data-on={mode === m}
            onClick={() => { setMode(m); setRaw(''); }}
            aria-pressed={mode === m}
          >
            {m === 'mint' ? 'Mint' : 'Redeem'}
          </button>
        ))}
      </div>

      <fieldset className={s.classPick}>
        <legend className="eyebrow">Class</legend>
        {(['night', 'day'] as ShareClass[]).map(c => {
          const open = c === parked;
          return (
            <label key={c} className={s.classOption} data-class={c} data-on={cls === c} data-open={open}>
              <input
                type="radio" name={`${id}-class`} value={c}
                checked={cls === c} onChange={() => setCls(c)}
                className="sr-only"
              />
              <span className={s.classOptionTag}>{vault.symbol}.{c.toUpperCase()}</span>
              <span className={s.classOptionState}>{open ? 'open' : 'holding the stock'}</span>
            </label>
          );
        })}
      </fieldset>

      {cls !== parked && (
        <p className={s.blocked} role="status">
          <strong>{vault.symbol}.{cls.toUpperCase()} is carrying the exposure.</strong>{' '}
          It reopens at the next boundary{sess ? <> — in <span className="num">{countdown(sess.until)}</span></> : ''}.
          {' '}{OP_MESSAGE['not-parked']}
        </p>
      )}

      <label className={s.field}>
        <span className={s.fieldLabel}>
          {mode === 'mint' ? 'Quote in' : 'Shares to redeem'}
          {max !== null && (
            <button
              type="button" className={s.maxBtn}
              onClick={() => setRaw(String(max))}
              disabled={max <= 0}
            >
              max <span className="num">{max.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
            </button>
          )}
        </span>
        <span className={s.inputWrap}>
          {mode === 'mint' && <span className={s.prefix}>$</span>}
          <input
            className={`num ${s.input}`}
            type="text" inputMode="decimal"
            value={raw}
            placeholder="0.00"
            onChange={e => {
              const v = e.target.value;
              if (v === '' || /^\d*\.?\d{0,6}$/.test(v)) setRaw(v);
            }}
            aria-describedby={`${id}-preview`}
          />
          {mode === 'redeem' && <span className={s.suffix}>{cls.toUpperCase()}</span>}
        </span>
      </label>

      <dl className={s.preview} id={`${id}-preview`}>
        <div>
          <dt>NAV per share</dt>
          <dd className="num">{nav.toFixed(6)}</dd>
        </div>
        <div>
          <dt>{mode === 'mint' ? 'Shares out' : 'Quote out'}</dt>
          <dd className="num" data-emph={!!plan?.ok}>
            {plan?.ok
              ? plan.kind === 'mint'
                ? fromShares(plan.shares).toLocaleString('en-US', { maximumFractionDigits: 6 })
                : fmtUsd(fromQuote(plan.quote), 2)
              : '—'}
          </dd>
        </div>
        <div>
          <dt>Underlying mark</dt>
          <dd className="num">{fmtUsd(price)}</dd>
        </div>
      </dl>

      {plan && !plan.ok && plan.err !== 'not-parked' && (
        <p className={s.err} role="alert">{OP_MESSAGE[plan.err]}</p>
      )}

      <button
        type="submit"
        className={s.submit}
        data-class={cls}
        disabled={!plan?.ok}
      >
        {mode === 'mint' ? 'Mint' : 'Redeem'} {vault.symbol}.{cls.toUpperCase()}
      </button>

      {flash && <p className={s.flash} role="status">{flash}</p>}

      <p className={s.footnote}>
        Rounding always favours the vault: minting floors the shares out, redeeming
        floors the quote out. Neither side can round a fraction of a unit away from
        the other holders.
      </p>
    </form>
  );
}
