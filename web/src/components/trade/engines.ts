/* The two engines a trade panel can run on.
 *
 * `useChainEngine` is the vault on devnet: previews are computed from the NAV
 * read off the vault account, with the same floor the program applies, and a
 * trade is a transaction the connected wallet signs. Every rule the program
 * enforces — the parked class, the halt, the pause flags, the quote reserved
 * for an outstanding handoff — is checked here first, so the wallet's
 * rejection is never the first a person hears of one.
 *
 * `useLocalEngine` is the simulation: the same `planMint`/`planRedeem` the
 * local vault mirrors from `ops.rs`, applied to balances kept in this browser.
 * It never pretends to be a transaction — there is no wallet stage, no
 * signature, and nothing on it says "confirmed on chain". */
import { useMemo } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WAD, mulDivFloor } from '@sdk/settle.ts';
import { PAUSE_MINT, PAUSE_REDEEM, SESSION_EVENT } from '@sdk/vault.ts';
import { useWalletModal } from '../wallet/WalletModal';
import { etClock } from '@/lib/session';
import { fmtUsd } from '@/lib/data';
import {
  buildMint, buildRedeem, useSendTx, requestFaucet, type Devnet, type ChainVault as ChainState,
} from '@/lib/chain';
import {
  planMint, planRedeem, applyMint, applyRedeem, navToNumber, fromShares, fromQuote, toQuote, toShares,
  OP_MESSAGE, type LocalVault,
} from '@/lib/localVault';
import type { Cls, Mode, Outcome, Preview, TradeEngine } from './engine';

const atoms = (v: bigint, d: number) => Number(v) / 10 ** d;
const toAtoms = (n: number, d: number) => BigInt(Math.round(n * 10 ** d));
const qty = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const qty6 = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 6 });

/** The class ticker's stem: the vault's own name on chain, else the asset without its x. */
export const classStem = (symbol: string, vaultSymbol?: string) => vaultSymbol ?? symbol.replace(/x$/, '');

const WORDS = { equity: { day: 'DAY', night: 'NIGHT' }, event: { day: 'NOW', night: 'THEN' } } as const;

/* One signature, one fee: Solana charges 5,000 lamports per signature and the
   panel's transactions carry exactly one. Opening a token account the wallet
   has never had costs its rent-exempt minimum, about 0.002 SOL, once. */
const NETWORK_FEE = '≈ 0.000005 SOL';
const WITH_RENT = '≈ 0.000005 SOL + ≈ 0.002 SOL once, to open your token account';

export function useChainEngine(m: Devnet, d: ChainState, onDone: () => void): TradeEngine {
  const { connected, publicKey, signMessage } = useWallet();
  const { setOpen } = useWalletModal();
  const send = useSendTx();

  return useMemo((): TradeEngine => {
    const v = d.vault;
    const qd = v.quoteDecimals;
    const isEvent = v.sessionKind === SESSION_EVENT;
    const words = WORDS[isEvent ? 'event' : 'equity'];
    const stem = classStem(m.symbol, m.vaultSymbol);
    const names = { day: `${stem}.${words.day}`, night: `${stem}.${words.night}` };
    const parked: Cls = v.exposed === 'night' ? 'day' : 'night';
    const navOf = (c: Cls) => (c === 'night' ? v.nightNav : v.dayNav);
    const reserved = v.pendingDelta > 0n ? v.pendingDelta : 0n;
    const freeQuote = v.ownedQuote > reserved ? v.ownedQuote - reserved : 0n;
    const me = d.me;

    const preview = (mode: Mode, cls: Cls, amount: number): Preview => {
      // `check_live` runs before either operation, so a halt refuses both.
      if (v.halted) return { ok: false, kind: 'halted', reason: OP_MESSAGE.halted };
      if (mode === 'mint' && (v.flags & PAUSE_MINT)) return { ok: false, kind: 'paused', reason: 'The vault’s authority has paused minting. Redemption is unaffected.' };
      if (mode === 'redeem' && (v.flags & PAUSE_REDEEM)) return { ok: false, kind: 'paused', reason: 'The vault’s authority has paused redemption.' };
      if (cls !== parked) return { ok: false, kind: 'not-parked', reason: OP_MESSAGE['not-parked'] };
      const nav = navOf(cls);
      if (nav === 0n) return { ok: false, kind: 'input', reason: OP_MESSAGE['nav-collapsed'] };
      if (mode === 'mint') {
        const q = toAtoms(amount, qd);
        if (me && q > me.quote) {
          return { ok: false, kind: 'input', reason: `You hold ${fmtUsd(atoms(me.quote, qd), 2)} of test quote. The faucet below tops that up.` };
        }
        const shares = mulDivFloor(q, WAD, nav);
        if (shares === 0n) return { ok: false, kind: 'input', reason: OP_MESSAGE['too-small'] };
        return { ok: true, out: atoms(shares, qd), outText: qty6(atoms(shares, qd)) };
      }
      const sh = toAtoms(amount, qd);
      const held = me ? (cls === 'night' ? me.night : me.day) : null;
      if (held !== null && sh > held) return { ok: false, kind: 'input', reason: OP_MESSAGE['insufficient-shares'] };
      const q = mulDivFloor(sh, nav, WAD);
      if (q === 0n) return { ok: false, kind: 'input', reason: OP_MESSAGE['too-small'] };
      if (q > freeQuote) return { ok: false, kind: 'input', reason: OP_MESSAGE['insufficient-free-quote'] };
      return { ok: true, out: atoms(q, qd), outText: fmtUsd(atoms(q, qd), 2) };
    };

    const execute = async (mode: Mode, cls: Cls, amount: number, onStage: Parameters<TradeEngine['execute']>[3]): Promise<Outcome> => {
      if (!publicKey) return { ok: false, error: 'Connect a wallet first.' };
      const p = preview(mode, cls, amount);
      if (!p.ok) return { ok: false, error: p.reason };
      const ixs = mode === 'mint'
        ? buildMint(m, publicKey, cls, toAtoms(amount, qd))
        : buildRedeem(m, publicKey, cls, toAtoms(amount, qd));
      const r = await send(ixs, onStage);
      if (!r.ok) return { ok: false, error: r.error };
      onDone();
      return mode === 'mint'
        ? { ok: true, sig: r.signature, headline: `Minted ${qty(p.out)} ${names[cls]}`, detail: `+${qty(p.out)} ${names[cls]} for ${fmtUsd(amount, 2)}` }
        : { ok: true, sig: r.signature, headline: `Redeemed for ${p.outText}`, detail: `−${qty(amount)} ${names[cls]} · +${p.outText}` };
    };

    return {
      kind: 'live', names, words, parked,
      halted: v.halted ? String(v.haltReason) : null,
      nav: { day: navToNumber(v.dayNav), night: navToNumber(v.nightNav) },
      quoteBalance: me ? atoms(me.quote, qd) : null,
      held: me ? { day: atoms(me.day, qd), night: atoms(me.night, qd) } : { day: null, night: null },
      preview, execute,
      wallet: { needed: true, connected, connect: () => setOpen(true) },
      mark: {
        label: `Pyth · ${m.markFeed}`,
        value: d.markUsd,
        source: 'pyth',
        detail: `Pyth ${m.markFeed}, sponsored feed on devnet — a stand-in for the NVDAX feed, which devnet does not carry`,
        ageSec: d.markAgeSecs,
        staleAfter: v.maxStaleSecs,
      },
      fees: (mode, cls) => {
        const opens = !!me && (mode === 'mint' ? !me.has[cls] : !me.has.quote);
        return { network: opens ? WITH_RENT : NETWORK_FEE, protocol: 'None — rounding floors in the vault’s favour' };
      },
      faucet: connected && publicKey ? {
        run: async () => {
          const r = await requestFaucet(publicKey, signMessage);
          if ('error' in r) return { ok: false, error: r.error };
          // The faucet also serves bell orders, so it can succeed with no quote in it.
          if (r.amount === '0') return { ok: false, error: 'This wallet already holds 50,000 test quote, the faucet’s cap.' };
          onDone();
          return { ok: true, sig: r.signature, headline: `10,000 test quote sent${r.solDripped ? ', plus a little SOL for fees' : ''}`, detail: '+10,000.00 test USDC' };
        },
      } : undefined,
      reopens: isEvent ? null : d.nextBoundaryTs !== null ? `${etClock(d.nextBoundaryTs)} ET` : null,
    };
  }, [m, d, connected, publicKey, signMessage, setOpen, send, onDone]);
}

export function useLocalEngine(
  vault: LocalVault,
  onCommit: (v: LocalVault) => void,
  mark: { price: number; ageSec: number | null; live: boolean },
  opts: {
    stem: string; demo?: boolean; reopens: string | null;
    /** What the mark is, when it is not the token's own price — the demo marks to the vault's feed. */
    markInfo?: { label: string; source: 'pyth' | 'jupiter' | 'study'; detail: string; staleAfter?: number };
  },
): TradeEngine {
  return useMemo((): TradeEngine => {
    const words = WORDS.equity;
    const names = { day: `${opts.stem}.${words.day}`, night: `${opts.stem}.${words.night}` };
    const parked: Cls = vault.exposed === 'night' ? 'day' : 'night';

    const plan = (mode: Mode, cls: Cls, amount: number) =>
      mode === 'mint' ? planMint(vault, cls, toQuote(amount)) : planRedeem(vault, cls, toShares(amount));

    const preview = (mode: Mode, cls: Cls, amount: number): Preview => {
      const p = plan(mode, cls, amount);
      if (!p.ok) {
        const kind = p.err === 'not-parked' ? 'not-parked' : p.err === 'halted' ? 'halted' : 'input';
        return { ok: false, kind, reason: OP_MESSAGE[p.err] };
      }
      return p.kind === 'mint'
        ? { ok: true, out: fromShares(p.shares), outText: qty6(fromShares(p.shares)) }
        : { ok: true, out: fromQuote(p.quote), outText: fmtUsd(fromQuote(p.quote), 2) };
    };

    const execute = async (mode: Mode, cls: Cls, amount: number): Promise<Outcome> => {
      const p = plan(mode, cls, amount);
      if (!p.ok) return { ok: false, error: OP_MESSAGE[p.err] };
      const now = Math.floor(Date.now() / 1000);
      if (p.kind === 'mint') {
        onCommit(applyMint(vault, cls, toQuote(amount), p.shares, now));
        const n = fromShares(p.shares);
        return { ok: true, headline: `Minted ${qty(n)} ${names[cls]}`, detail: `+${qty(n)} ${names[cls]} · ${opts.demo ? 'in the demo sandbox' : 'in this browser'}` };
      }
      onCommit(applyRedeem(vault, cls, toShares(amount), p.quote, now));
      const q = fmtUsd(fromQuote(p.quote), 2);
      return { ok: true, headline: `Redeemed for ${q}`, detail: `−${qty(amount)} ${names[cls]} · ${opts.demo ? 'in the demo sandbox' : 'in this browser'}` };
    };

    return {
      kind: opts.demo ? 'demo' : 'simulated', names, words, parked,
      halted: vault.halted ? (vault.haltReason || 'halted') : null,
      nav: { day: navToNumber(vault.dayNav), night: navToNumber(vault.nightNav) },
      quoteBalance: null,
      held: { day: fromShares(vault.myDay), night: fromShares(vault.myNight) },
      preview, execute,
      wallet: { needed: false, connected: true, connect: () => {} },
      mark: opts.markInfo
        ? { ...opts.markInfo, value: mark.price || null, ageSec: mark.ageSec }
        : {
            label: mark.live ? 'Jupiter · live price' : 'Last measured close',
            value: mark.price || null,
            source: mark.live ? 'jupiter' : 'study',
            detail: mark.live ? 'Jupiter price of the token, marking the simulation' : 'Last hourly close in the study snapshot',
            ageSec: mark.ageSec,
          },
      fees: () => ({ network: 'None — nothing is sent', protocol: 'None — rounding floors in the vault’s favour' }),
      reopens: opts.reopens,
      quickMint: [100, 1_000, 10_000],
    };
  }, [vault, onCommit, mark.price, mark.ageSec, mark.live, opts.stem, opts.demo, opts.reopens, opts.markInfo]);
}
