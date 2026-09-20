import { useEffect, useId, useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from './wallet/WalletModal';
import { useSession, countdown } from '@/lib/session';
import { fmtUsd } from '@/lib/data';
import {
  buildMint, buildRedeem, useSendTx, requestFaucet, explorer, type Devnet, type ChainVault,
} from '@/lib/chain';
import { WAD, mulDivFloor } from '@sdk/settle.ts';
import { OP_MESSAGE, type ShareClass } from '@/lib/localVault';
import s from './Trade.module.css';
import c from './ChainTrade.module.css';

type Mode = 'mint' | 'redeem';
type Plan =
  | { kind: 'err'; err: string }
  | { kind: 'mint'; q: bigint; shares: bigint }
  | { kind: 'redeem'; sh: bigint; q: bigint };

const fromAtoms = (v: bigint, decimals: number) => Number(v) / 10 ** decimals;
const toAtoms = (n: number, decimals: number) => BigInt(Math.round(n * 10 ** decimals));

/**
 * Mint and redeem, for real.
 *
 * Same shape as the local trade panel, same rule — only the parked class is
 * open — but the preview is computed from the on-chain NAV, the button signs
 * a transaction in the connected wallet, and the confirmation is a signature
 * on Solana Explorer. The program enforces every rule shown here; the panel
 * explains them so the wallet's rejection is never the first a person hears
 * of one.
 */
export function ChainTrade({
  m, chain, onDone,
}: {
  m: Devnet;
  chain: ChainVault;
  onDone: () => void;
}) {
  const sess = useSession();
  const id = useId();
  const { publicKey, connected } = useWallet();
  const { setOpen } = useWalletModal();
  const send = useSendTx();

  const [mode, setMode] = useState<Mode>('mint');
  const [cls, setCls] = useState<ShareClass>(chain.vault.exposed === 'night' ? 'day' : 'night');
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState<'tx' | 'faucet' | null>(null);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string; sig?: string } | null>(null);

  const parked: ShareClass = chain.vault.exposed === 'night' ? 'day' : 'night';
  useEffect(() => { setCls(cur => (cur === chain.vault.exposed ? parked : cur)); }, [chain.vault.exposed, parked]);
  useEffect(() => {
    if (!flash || flash.kind !== 'ok') return;
    const t = setTimeout(() => setFlash(null), 9000);
    return () => clearTimeout(t);
  }, [flash]);

  const qd = chain.vault.quoteDecimals;
  const nav = cls === 'night' ? chain.vault.nightNav : chain.vault.dayNav;
  const navNum = Number(nav) / 1e18;
  const held = chain.me ? (cls === 'night' ? chain.me.night : chain.me.day) : 0n;
  const quoteHeld = chain.me?.quote ?? 0n;

  const amount = Number(raw);
  const valid = raw !== '' && Number.isFinite(amount) && amount > 0;

  const plan = useMemo((): Plan | null => {
    if (!valid) return null;
    if (chain.vault.halted && mode === 'mint') return { kind: 'err', err: OP_MESSAGE.halted };
    if (cls !== parked) return { kind: 'err', err: 'not-parked' };
    if (nav === 0n) return { kind: 'err', err: OP_MESSAGE['nav-collapsed'] };
    if (mode === 'mint') {
      const q = toAtoms(amount, qd);
      if (q > quoteHeld) return { kind: 'err', err: `You hold ${fmtUsd(fromAtoms(quoteHeld, qd), 2)} of test quote. The faucet below tops that up.` };
      const shares = mulDivFloor(q, WAD, nav);
      if (shares === 0n) return { kind: 'err', err: OP_MESSAGE['too-small'] };
      return { kind: 'mint', q, shares };
    }
    const sh = toAtoms(amount, qd);
    if (sh > held) return { kind: 'err', err: OP_MESSAGE['insufficient-shares'] };
    const q = mulDivFloor(sh, nav, WAD);
    if (q === 0n) return { kind: 'err', err: OP_MESSAGE['too-small'] };
    return { kind: 'redeem', sh, q };
  }, [valid, amount, mode, cls, parked, nav, qd, quoteHeld, held, chain.vault.halted]);

  const canSubmit = !!plan && plan.kind !== 'err' && connected && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!publicKey || !plan || plan.kind === 'err') return;
    setBusy('tx'); setFlash(null);
    const ixs = plan.kind === 'mint'
      ? buildMint(m, publicKey, cls, plan.q)
      : buildRedeem(m, publicKey, cls, plan.sh);
    const r = await send(ixs);
    setBusy(null);
    if (r.ok) {
      setFlash({
        kind: 'ok', sig: r.signature,
        text: plan.kind === 'mint'
          ? `Minted ${fromAtoms(plan.shares, qd).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${m.symbol}.${cls.toUpperCase()}`
          : `Redeemed for ${fmtUsd(fromAtoms(plan.q, qd), 2)}`,
      });
      setRaw('');
      onDone();
    } else {
      setFlash({ kind: 'err', text: r.error });
    }
  };

  const faucet = async () => {
    if (!publicKey) return;
    setBusy('faucet'); setFlash(null);
    const r = await requestFaucet(publicKey);
    setBusy(null);
    if ('error' in r) setFlash({ kind: 'err', text: r.error });
    else {
      setFlash({ kind: 'ok', sig: r.signature, text: `10,000 test quote sent${r.solDripped ? ', plus a little SOL for fees' : ''}` });
      onDone();
    }
  };

  const max = mode === 'redeem' ? fromAtoms(held, qd) : fromAtoms(quoteHeld, qd);

  return (
    <form className={`card ${s.card}`} onSubmit={submit}>
      <div className={c.live}>
        <span className={c.liveDot} aria-hidden="true" />
        <span>Live on devnet</span>
        <span className={`mono ${c.liveVault}`} title={m.vault}>{m.vault.slice(0, 4)}…{m.vault.slice(-4)}</span>
      </div>

      <div className={s.modes} role="group" aria-label="Operation">
        {(['mint', 'redeem'] as Mode[]).map(mo => (
          <button key={mo} type="button" className={s.mode} data-on={mode === mo}
                  onClick={() => { setMode(mo); setRaw(''); setFlash(null); }} aria-pressed={mode === mo}>
            {mo === 'mint' ? 'Mint' : 'Redeem'}
          </button>
        ))}
      </div>

      <fieldset className={s.classPick}>
        <legend className="eyebrow">Class</legend>
        {(['night', 'day'] as ShareClass[]).map(k => {
          const open = k === parked;
          return (
            <label key={k} className={s.classOption} data-class={k} data-on={cls === k} data-open={open}>
              <input type="radio" name={`${id}-class`} value={k} checked={cls === k} onChange={() => setCls(k)} className="sr-only" />
              <span className={s.classOptionTag}>{m.symbol}.{k.toUpperCase()}</span>
              <span className={s.classOptionState}>{open ? 'open' : 'holding the stock'}</span>
            </label>
          );
        })}
      </fieldset>

      {cls !== parked && (
        <p className={s.blocked} role="status">
          <strong>{m.symbol}.{cls.toUpperCase()} is carrying the exposure.</strong>{' '}
          It reopens at the next boundary{sess ? <> — in <span className="num">{countdown(sess.until)}</span></> : ''}.
          {' '}{OP_MESSAGE['not-parked']}
        </p>
      )}

      <label className={s.field}>
        <span className={s.fieldLabel}>
          {mode === 'mint' ? 'Quote in' : 'Shares to redeem'}
          {connected && (
            <button type="button" className={s.maxBtn} onClick={() => setRaw(String(max))} disabled={max <= 0}>
              max <span className="num">{max.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
            </button>
          )}
        </span>
        <span className={s.inputWrap}>
          {mode === 'mint' && <span className={s.prefix}>$</span>}
          <input
            className={`num ${s.input}`} type="text" inputMode="decimal" value={raw} placeholder="0.00"
            onChange={e => { const v = e.target.value; if (v === '' || /^\d*\.?\d{0,6}$/.test(v)) setRaw(v); }}
            aria-describedby={`${id}-preview`} disabled={!connected}
          />
          {mode === 'redeem' && <span className={s.suffix}>{cls.toUpperCase()}</span>}
        </span>
      </label>

      <dl className={s.preview} id={`${id}-preview`}>
        <div><dt>NAV per share, on chain</dt><dd className="num">{navNum.toFixed(6)}</dd></div>
        <div>
          <dt>{mode === 'mint' ? 'Shares out' : 'Quote out'}</dt>
          <dd className="num" data-emph={!!plan && plan.kind !== 'err'}>
            {plan?.kind === 'mint' ? fromAtoms(plan.shares, qd).toLocaleString('en-US', { maximumFractionDigits: 6 })
              : plan?.kind === 'redeem' ? fmtUsd(fromAtoms(plan.q, qd), 2) : '—'}
          </dd>
        </div>
        <div><dt>Mark · {m.markFeed}</dt><dd className="num">{chain.markUsd !== null ? fmtUsd(chain.markUsd) : '—'}</dd></div>
      </dl>

      {plan?.kind === 'err' && plan.err !== 'not-parked' && (
        <p className={s.err} role="alert">{plan.err}</p>
      )}

      {!connected ? (
        <button type="button" className={s.submit} data-class={cls} onClick={() => setOpen(true)}>
          Connect a wallet to {mode}
        </button>
      ) : (
        <button type="submit" className={s.submit} data-class={cls} disabled={!canSubmit}>
          {busy === 'tx' ? 'Confirm in your wallet…' : `${mode === 'mint' ? 'Mint' : 'Redeem'} ${m.symbol}.${cls.toUpperCase()}`}
        </button>
      )}

      {flash && (
        <p className={flash.kind === 'ok' ? s.flash : s.err} role="status">
          {flash.text}
          {flash.sig && <> · <a className={c.sigLink} href={explorer(flash.sig)} target="_blank" rel="noreferrer">view transaction ↗</a></>}
        </p>
      )}

      {connected && (
        <div className={c.faucet}>
          <div>
            <p className={c.faucetTitle}>Test quote</p>
            <p className={c.faucetSub}>
              You hold <span className="num">{fmtUsd(fromAtoms(quoteHeld, qd), 2)}</span>. The faucet mints
              10,000 of the devnet USDC stand-in to your wallet.
            </p>
          </div>
          <button type="button" className={c.faucetBtn} onClick={faucet} disabled={!!busy}>
            {busy === 'faucet' ? 'Minting…' : 'Get 10,000'}
          </button>
        </div>
      )}

      <p className={s.footnote}>
        Every rule here is enforced by the program, not the page: the parked-class
        rule, the flooring direction, the reserved quote. The page just says them first.
      </p>
    </form>
  );
}
