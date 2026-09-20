/* ───────────────────────────────────────────────────────────────────────────
   The chain, from the browser.

   Everything on the on-chain vault page comes through here: the vault account
   decoded with the SDK's own `decodeVault`, the two Pyth accounts, the share
   supplies, the vault's balances and the connected wallet's, all read in one
   `getMultipleAccountsInfo` so no two figures on screen come from different
   slots. Transactions are built with the same instruction builders the keeper
   and the devnet tooling use.

   Nothing here falls back to a plausible number when a read fails. A market
   interface that guesses is worse than one that says it does not know.
   ─────────────────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Connection, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { decodeVault, decodePythQuote, normalizeMark, type Vault, type PythQuote } from '@sdk/vault.ts';
import {
  ata, createAtaIdempotentIx, mintSharesIx, redeemSharesIx, explainProgramError,
} from '@sdk/ix.ts';
import { evaluate, type Health, type VaultState } from '@sdk/health.ts';
import { valueOf, skewWad } from '@sdk/settle.ts';
import { nextBoundary } from '@sdk/calendar.ts';
import { load } from './data';
import type { ShareClass } from './localVault';

/* ── the manifest ────────────────────────────────────────────────────────── */

export interface Devnet {
  cluster: string;
  rpc: string;
  programId: string;
  symbol: string;
  note: string;
  vault: string;
  underlyingMint: string;
  quoteMint: string;
  nightMint: string;
  dayMint: string;
  underlyingVault: string;
  quoteVault: string;
  markPriceUpdate: string;
  equityPriceUpdate: string;
  markFeed: string;
  equityFeed: string;
  operator: string;
  /** The program owning the quote and the two share classes. Part of every
      ATA seed, so it cannot be assumed. */
  tokenProgram: string;
  /** The program owning the underlying — Token-2022 for a real xStock. */
  underlyingTokenProgram: string;
  params: { maxStaleSecs: number; [k: string]: unknown };
  initialised: string;
}

export function useDevnet() {
  const [m, setM] = useState<Devnet | null | undefined>(undefined);
  useEffect(() => {
    load<Devnet>('/devnet.json').then(setM).catch(() => setM(null));
  }, []);
  return m;   // undefined = loading, null = no devnet deployment
}

/* ── reads ───────────────────────────────────────────────────────────────── */

export interface ChainVault {
  vault: Vault;
  address: PublicKey;
  nightSupply: bigint;
  daySupply: bigint;
  balanceUnderlying: bigint;
  balanceQuote: bigint;
  mark: PythQuote | null;
  equity: PythQuote | null;
  /** The live mark in the program's units, or null when the feed is missing. */
  markWad: bigint | null;
  /** Mark as a plain USD number for display. */
  markUsd: number | null;
  markAgeSecs: number | null;
  valueNight: bigint;
  valueDay: bigint;
  skew: bigint;
  health: Health;
  nextBoundaryTs: number | null;
  boundaryDue: boolean;
  slot: number;
  fetchedAt: number;
  /** The connected wallet's balances, when one is connected. */
  me: { quote: bigint; night: bigint; day: bigint } | null;
}

/** SPL token account `amount` is a u64 at offset 64; a mint's `supply` at 36. */
const u64At = (d: Uint8Array | undefined, at: number): bigint => {
  if (!d || d.length < at + 8) return 0n;
  let v = 0n;
  for (let i = at + 7; i >= at; i--) v = (v << 8n) | BigInt(d[i]);
  return v;
};

export async function readChainVault(conn: Connection, m: Devnet, me: PublicKey | null): Promise<ChainVault> {
  const address = new PublicKey(m.vault);
  const keys = [
    address,
    new PublicKey(m.nightMint), new PublicKey(m.dayMint),
    new PublicKey(m.underlyingVault), new PublicKey(m.quoteVault),
    new PublicKey(m.markPriceUpdate), new PublicKey(m.equityPriceUpdate),
  ];
  const tokenProgram = new PublicKey(m.tokenProgram);
  if (me) {
    keys.push(
      ata(me, new PublicKey(m.quoteMint), tokenProgram),
      ata(me, new PublicKey(m.nightMint), tokenProgram),
      ata(me, new PublicKey(m.dayMint), tokenProgram),
    );
  }

  const { context, value } = await conn.getMultipleAccountsInfoAndContext(keys);
  const [vAcc, nMint, dMint, uVault, qVault, markAcc, eqAcc, meQ, meN, meD] = value;
  if (!vAcc) throw new Error(`no vault account at ${m.vault}`);

  const vault = decodeVault(vAcc.data);
  const nightSupply = u64At(nMint?.data, 36);
  const daySupply = u64At(dMint?.data, 36);
  const balanceUnderlying = u64At(uVault?.data, 64);
  const balanceQuote = u64At(qVault?.data, 64);

  const mark = markAcc ? safeQuote(markAcc.data) : null;
  const equity = eqAcc ? safeQuote(eqAcc.data) : null;
  const now = Math.floor(Date.now() / 1000);

  const state: VaultState = {
    halted: vault.halted, haltReason: vault.haltReason, paused: vault.flags,
    nightSupply, daySupply, nightNav: vault.nightNav, dayNav: vault.dayNav,
    lastMark: vault.lastMark, ownedUnderlying: vault.ownedUnderlying, ownedQuote: vault.ownedQuote,
    balanceUnderlying, balanceQuote, pendingDelta: vault.pendingDelta,
    lastBoundaryTs: vault.lastBoundaryTs, lastSessionOpen: vault.lastSessionOpen,
    maxCarryDeltaBps: vault.maxCarryDeltaBps,
    markPublishTs: mark?.publishTime ?? 0, equityPublishTs: equity?.publishTime ?? 0,
    maxStaleSecs: vault.maxStaleSecs, equityQuietSecs: vault.equityQuietSecs,
    maxUnexpectedClosedSecs: vault.maxUnexpectedClosedSecs,
  };

  const valueNight = valueOf(nightSupply, vault.nightNav);
  const valueDay = valueOf(daySupply, vault.dayNav);
  const next = nextBoundary(vault.lastBoundaryTs, 20);

  return {
    vault, address, nightSupply, daySupply, balanceUnderlying, balanceQuote,
    mark, equity,
    markWad: mark ? normalizeMark(mark, vault.underlyingDecimals, vault.quoteDecimals) : null,
    markUsd: mark ? Number(mark.price) * 10 ** mark.expo : null,
    markAgeSecs: mark ? now - mark.publishTime : null,
    valueNight, valueDay, skew: skewWad(valueNight, valueDay),
    health: evaluate(state, now),
    nextBoundaryTs: next, boundaryDue: next !== null && now >= next,
    slot: context.slot, fetchedAt: now,
    me: me ? { quote: u64At(meQ?.data, 64), night: u64At(meN?.data, 64), day: u64At(meD?.data, 64) } : null,
  };
}

function safeQuote(data: Uint8Array): PythQuote | null {
  try { return decodePythQuote(data); } catch { return null; }
}

export type ChainAsync =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: ChainVault; error: null }
  | { status: 'error'; data: ChainVault | null; error: Error };

/**
 * Poll the vault. Twelve seconds is deliberate: a boundary lands on a whole
 * minute and the crank needs a few seconds after it, so anything faster is
 * spending RPC on a number that has not changed.
 */
export function useChainVault(m: Devnet | null | undefined, intervalMs = 12_000) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [state, setState] = useState<ChainAsync>({ status: 'loading', data: null, error: null });
  const gen = useRef(0);

  const refresh = useCallback(async () => {
    if (!m) return;
    const g = ++gen.current;
    try {
      const data = await readChainVault(connection, m, publicKey);
      if (g === gen.current) setState({ status: 'ready', data, error: null });
    } catch (e) {
      if (g === gen.current) {
        setState(s => ({ status: 'error', data: s.data, error: e instanceof Error ? e : new Error(String(e)) }));
      }
    }
  }, [connection, m, publicKey]);

  useEffect(() => {
    if (!m) return;
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [m, refresh, intervalMs]);

  return { ...state, refresh };
}

/* ── writes ──────────────────────────────────────────────────────────────── */

export type TxResult = { ok: true; signature: string } | { ok: false; error: string };

/**
 * Sign and send through the connected wallet, then wait for confirmation.
 * The wallet adapter's `sendTransaction` is used rather than `signTransaction`
 * plus a manual send, because some wallets only implement the former.
 */
export function useSendTx() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();

  return useCallback(async (ixs: TransactionInstruction[]): Promise<TxResult> => {
    if (!publicKey) return { ok: false, error: 'Connect a wallet first.' };
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
      const signature = await sendTransaction(tx, connection, { preflightCommitment: 'confirmed' });
      const conf = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
      if (conf.value.err) {
        // Pull the program's own message out of the logs; a bare error code
        // tells a person nothing.
        const t = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        return { ok: false, error: explainProgramError(t?.meta?.logMessages) ?? `transaction failed: ${JSON.stringify(conf.value.err)}` };
      }
      return { ok: true, signature };
    } catch (e) {
      const err = e as { message?: string; logs?: string[] };
      const msg = explainProgramError(err.logs) ?? err.message ?? String(e);
      // Wallets phrase a rejection a dozen ways; the person knows what they did.
      if (/reject|denied|cancel/i.test(msg)) return { ok: false, error: 'Cancelled in the wallet.' };
      return { ok: false, error: msg };
    }
  }, [connection, publicKey, sendTransaction]);
}

const tradeAccounts = (m: Devnet, user: PublicKey, cls: ShareClass) => {
  const tokenProgram = new PublicKey(m.tokenProgram);
  const classMint = new PublicKey(cls === 'night' ? m.nightMint : m.dayMint);
  const quoteMint = new PublicKey(m.quoteMint);
  return {
    tokenProgram, classMint, quoteMint,
    accounts: {
      vault: new PublicKey(m.vault), classMint,
      nightMint: new PublicKey(m.nightMint), dayMint: new PublicKey(m.dayMint),
      quoteVault: new PublicKey(m.quoteVault),
      userQuote: ata(user, quoteMint, tokenProgram),
      userShares: ata(user, classMint, tokenProgram),
      user, quoteMint, tokenProgram,
    },
  };
};

export function buildMint(m: Devnet, user: PublicKey, cls: ShareClass, quoteAtoms: bigint): TransactionInstruction[] {
  const { accounts, classMint, tokenProgram } = tradeAccounts(m, user, cls);
  return [
    createAtaIdempotentIx(user, user, classMint, tokenProgram),
    mintSharesIx(accounts, cls, quoteAtoms),
  ];
}

export function buildRedeem(m: Devnet, user: PublicKey, cls: ShareClass, shareAtoms: bigint): TransactionInstruction[] {
  const { accounts, quoteMint, tokenProgram } = tradeAccounts(m, user, cls);
  return [
    createAtaIdempotentIx(user, user, quoteMint, tokenProgram),
    redeemSharesIx(accounts, cls, shareAtoms),
  ];
}

/* ── the serverless pair ─────────────────────────────────────────────────── */

export interface CrankReport {
  ok: boolean;
  boundaryDue: boolean;
  settled: { signature: string } | { skipped: string } | { failed: string };
  fills: { signature: string; underlying: string; buying: boolean }[];
  fillError?: string;
  pendingAfter: string;
  markAgeSecs: number | null;
  /** `hermes-as-of`: the print from the bell, posted for this crank. `sponsored`: the feed as it stood at crank time. */
  markSource?: 'hermes-as-of' | 'sponsored' | null;
  markNote?: string;
}

export async function pingCrank(): Promise<{ cached: boolean; report: CrankReport } | { error: string }> {
  try {
    const r = await fetch('/api/crank', { cache: 'no-store' });
    return await r.json();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Must match `faucetMessage` in api-src/faucet.ts. */
export const faucetMessage = (wallet: string, issued: number) =>
  `SESSION devnet faucet\nwallet: ${wallet}\nissued: ${issued}`;

/**
 * Ask for test quote, proving control of the wallet first.
 *
 * One extra click in the wallet, and it turns an endpoint anyone could point
 * at any address — draining the operator's SOL a fresh keypair at a time —
 * into one that can only fund a wallet its caller actually holds.
 */
export async function requestFaucet(
  wallet: PublicKey,
  signMessage: ((m: Uint8Array) => Promise<Uint8Array>) | undefined,
): Promise<{ signature: string; solDripped: boolean } | { error: string }> {
  if (!signMessage) {
    return { error: 'This wallet cannot sign messages, which the faucet needs to prove the address is yours.' };
  }
  try {
    const issued = Date.now();
    const sig = await signMessage(new TextEncoder().encode(faucetMessage(wallet.toBase58(), issued)));
    const r = await fetch('/api/faucet', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet: wallet.toBase58(), issued, signature: bs58.encode(sig) }),
    });
    return await r.json();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/reject|denied|cancel/i.test(msg)) return { error: 'Cancelled in the wallet.' };
    return { error: msg };
  }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

export const explorer = (sig: string, cluster = 'devnet') =>
  `https://explorer.solana.com/tx/${sig}?cluster=${cluster}`;
export const explorerAddr = (addr: string, cluster = 'devnet') =>
  `https://explorer.solana.com/address/${addr}?cluster=${cluster}`;
export const short = (k: string | PublicKey, n = 4) => {
  const s = typeof k === 'string' ? k : k.toBase58();
  return `${s.slice(0, n)}…${s.slice(-n)}`;
};

/** A fixed list of what this deployment stands in for, kept beside the code that reads it. */
export const useDevnetVaultFor = (symbol: string | undefined) => {
  const m = useDevnet();
  return useMemo(() => (m && symbol && m.symbol === symbol ? m : null), [m, symbol]);
};
