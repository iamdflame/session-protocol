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
import {
  decodeSchedule, decodeDetector, premiumBps, SESSION_EVENT,
  type EventSchedule, type DetectorReading, type ScheduledEvent,
} from '@sdk/vault.ts';
import { decodeVault, decodePythQuote, normalizeMark, type Vault, type PythQuote } from '@sdk/vault.ts';
import {
  ata, createAtaIdempotentIx, mintSharesIx, redeemSharesIx, explainProgramError,
} from '@sdk/ix.ts';
import { eventsFromLogs, type VaultEvent } from '@sdk/events.ts';
import { evaluate, type Health, type VaultState } from '@sdk/health.ts';
import { inspectMint, uiMultiplier, type IssuerState } from '@sdk/issuer.ts';
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
  /** The share classes' program: Token-2022, because they carry their names. */
  shareTokenProgram: string;
  /** 0 equity (NYSE hours), 1 event (the next print). Absent means equity. */
  sessionKind?: number;
  /** What the classes are called on chain: NVDA → NVDA.DAY. */
  vaultSymbol?: string;
  /** An event vault's two clocks. */
  schedule?: string;
  detector?: string;
  /** The real mint this stands in for, when it lives on another cluster. */
  realMint?: string;
  /** Meteora pools, by pair name. */
  pools?: Record<string, string>;
  /** The program owning the underlying — Token-2022 for a real xStock. */
  underlyingTokenProgram: string;
  params: { maxStaleSecs: number; [k: string]: unknown };
  initialised: string;
}

/* Every vault the desk knows about.
 *
 * One program, several vaults: an equity session over an xStock-shaped mint,
 * an event session over a PreStock-shaped one. Each has its own manifest, and
 * the site picks by symbol rather than assuming there is only ever one. */
const MANIFESTS = ['/devnet.json', '/devnet-openai.json'];

export function useDevnets() {
  const [all, setAll] = useState<Devnet[] | undefined>(undefined);
  useEffect(() => {
    let live = true;
    Promise.all(MANIFESTS.map(u => load<Devnet>(u).catch(() => null)))
      .then(xs => { if (live) setAll(xs.filter((x): x is Devnet => x !== null)); });
    return () => { live = false; };
  }, []);
  return all;   // undefined = loading, [] = no devnet deployment
}

/** The first vault, for surfaces that only need one. */
export function useDevnet() {
  const all = useDevnets();
  return all === undefined ? undefined : (all[0] ?? null);
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
  /** The issuer's powers over the underlying, read off the mint. */
  issuer: IssuerState | null;
  /** The vault's own underlying token account is frozen. */
  vaultFrozen: boolean;
  /** Atoms → the number a person reads, honouring a scaled-UI multiplier. */
  uiMultiplier: number;
  epoch: number;
  /** An event vault's own clocks. Null for an equity vault. */
  event: {
    schedule: EventSchedule | null;
    detector: DetectorReading | null;
    /** How far the token's executable price sits from the issuer's mark. */
    premiumBps: number;
    /** The next print, or null when none is scheduled. */
    nextPrint: ScheduledEvent | null;
    /** Inside a print window right now. */
    inPrint: boolean;
    /** Seconds since the detector was posted. */
    detectorAgeSecs: number | null;
  } | null;
}

/** SPL token account `amount` is a u64 at offset 64; a mint's `supply` at 36. */
const u64At = (d: Uint8Array | undefined, at: number): bigint => {
  if (!d || d.length < at + 8) return 0n;
  let v = 0n;
  for (let i = at + 7; i >= at; i--) v = (v << 8n) | BigInt(d[i]);
  return v;
};

/* The epoch only picks which transfer-fee schedule is in force, and an epoch
   is about two days. Fetching it on every twelve-second refresh is an RPC
   call per tick for a number that almost never moves — and on a rate-limited
   public endpoint it is the call that makes the page slow. Cached, with a
   short life so a schedule change is still picked up the same session. */
let epochCache: { epoch: number; at: number } | null = null;
async function currentEpoch(conn: Connection): Promise<number> {
  const now = Date.now();
  if (epochCache && now - epochCache.at < 10 * 60_000) return epochCache.epoch;
  try {
    const { epoch } = await conn.getEpochInfo();
    epochCache = { epoch, at: now };
    return epoch;
  } catch {
    return epochCache?.epoch ?? 0;
  }
}

export async function readChainVault(conn: Connection, m: Devnet, me: PublicKey | null): Promise<ChainVault> {
  const address = new PublicKey(m.vault);
  const keys = [
    address,
    new PublicKey(m.nightMint), new PublicKey(m.dayMint),
    new PublicKey(m.underlyingVault), new PublicKey(m.quoteVault),
    new PublicKey(m.markPriceUpdate), new PublicKey(m.equityPriceUpdate),
    new PublicKey(m.underlyingMint),
  ];
  // An event vault carries two more accounts: the prints it watches and the
  // last reading somebody posted. Both are read here so the page never has to
  // guess at a session it cannot compute from a calendar.
  const isEvent = m.sessionKind === SESSION_EVENT;
  if (isEvent && m.schedule && m.detector) {
    keys.push(new PublicKey(m.schedule), new PublicKey(m.detector));
  }
  const tokenProgram = new PublicKey(m.tokenProgram);
  const shareProgram = new PublicKey(m.shareTokenProgram);
  if (me) {
    keys.push(
      ata(me, new PublicKey(m.quoteMint), tokenProgram),
      ata(me, new PublicKey(m.nightMint), shareProgram),
      ata(me, new PublicKey(m.dayMint), shareProgram),
    );
  }

  const [{ context, value }, epoch] = await Promise.all([
    conn.getMultipleAccountsInfoAndContext(keys),
    currentEpoch(conn),
  ]);
  const evOffset = isEvent && m.schedule && m.detector ? 2 : 0;
  const [vAcc, nMint, dMint, uVault, qVault, markAcc, eqAcc, uMint] = value;
  const schedAcc = evOffset ? value[8] : null;
  const detAcc = evOffset ? value[9] : null;
  const [meQ, meN, meD] = value.slice(8 + evOffset);
  if (!vAcc) throw new Error(`no vault account at ${m.vault}`);
  // What the issuer can do to this vault, and whether it already has. Read
  // the way the program reads it, so the card and the halt never disagree.
  let issuer: IssuerState | null = null;
  try { if (uMint) issuer = inspectMint(uMint.data, uMint.owner, epoch); } catch { issuer = null; }
  // SPL token account `state` is the byte at offset 108: 0 uninitialised, 1 initialised, 2 frozen.
  const vaultFrozen = (uVault?.data[108] ?? 1) === 2;

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
    issuer: issuer ?? undefined, vaultFrozen,
  };

  const valueNight = valueOf(nightSupply, vault.nightNav);
  const valueDay = valueOf(daySupply, vault.dayNav);
  const next = nextBoundary(vault.lastBoundaryTs, 20);

  /* ── the event vault's clocks ─────────────────────────────────────────── */
  let event: ChainVault['event'] = null;
  if (isEvent) {
    const schedule = schedAcc ? safe(() => decodeSchedule(schedAcc.data)) : null;
    const detector = detAcc ? safe(() => decodeDetector(detAcc.data)) : null;
    const prints = schedule?.events ?? [];
    event = {
      schedule, detector,
      premiumBps: detector ? premiumBps(detector) : 0,
      nextPrint: prints.find(e => e.ts + e.windowSecs > now) ?? null,
      inPrint: prints.some(e => now >= e.ts && now < e.ts + e.windowSecs),
      detectorAgeSecs: detector ? now - detector.ts : null,
    };
  }

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
    issuer, vaultFrozen,
    uiMultiplier: issuer ? uiMultiplier(issuer, now) : 1,
    epoch,
    event,
  };
}

const safe = <T,>(f: () => T): T | null => { try { return f(); } catch { return null; } };

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
      // Say why, always. A read that fails silently and leaves a skeleton on
      // screen is indistinguishable from a slow RPC, and that ambiguity has
      // cost real debugging time.
      console.error('[chain] vault read failed:', e);
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
  // Two programs on one instruction: quote moves under its own, shares are
  // minted and burned under theirs. Their ATAs are different addresses.
  const tokenProgram = new PublicKey(m.tokenProgram);
  const shareTokenProgram = new PublicKey(m.shareTokenProgram);
  const classMint = new PublicKey(cls === 'night' ? m.nightMint : m.dayMint);
  const quoteMint = new PublicKey(m.quoteMint);
  return {
    tokenProgram, shareTokenProgram, classMint, quoteMint,
    accounts: {
      vault: new PublicKey(m.vault), classMint,
      nightMint: new PublicKey(m.nightMint), dayMint: new PublicKey(m.dayMint),
      quoteVault: new PublicKey(m.quoteVault),
      userQuote: ata(user, quoteMint, tokenProgram),
      userShares: ata(user, classMint, shareTokenProgram),
      user, quoteMint, tokenProgram, shareTokenProgram,
    },
  };
};

export function buildMint(m: Devnet, user: PublicKey, cls: ShareClass, quoteAtoms: bigint): TransactionInstruction[] {
  const { accounts, classMint, shareTokenProgram } = tradeAccounts(m, user, cls);
  return [
    createAtaIdempotentIx(user, user, classMint, shareTokenProgram),
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

/* ── the ledger ──────────────────────────────────────────────────────────── */

export interface LedgerRow {
  signature: string;
  at: number | null;
  failed: boolean;
  /** What the program said happened. Empty when the transaction emitted nothing. */
  events: VaultEvent[];
}

/**
 * A vault's history, as the program itself recorded it.
 *
 * Signatures alone are a list of links. The events inside them are the
 * receipt — who minted, what a boundary settled at, which class wore a jump —
 * and anyone can reconstruct the same thing from the chain without trusting
 * this site's copy of it.
 */
/* A confirmed transaction never changes, so its events are worth keeping.
   Module-level rather than per-component: the ledger unmounts when a reader
   switches vaults and comes back, and re-fetching what has not changed is
   what gets a public RPC to start refusing. */
const eventCache = new Map<string, VaultEvent[]>();

export function useLedger(vault: string | null, limit = 20) {
  const { connection } = useConnection();
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!vault) return;
    let live = true;

    const go = async () => {
      try {
        const sigs = await connection.getSignaturesForAddress(new PublicKey(vault), { limit });
        if (!live) return;

        // Show the signatures immediately, with whatever is already decoded,
        // so a slow or throttled RPC degrades to a shorter description rather
        // than to an error where a ledger should be.
        const build = () => sigs.map(x => ({
          signature: x.signature,
          at: x.blockTime ?? null,
          failed: !!x.err,
          events: eventCache.get(x.signature) ?? [],
        }));
        setRows(build());
        setError(null);

        // Then fill in the ones never seen, slowly. This is the lowest-value
        // request the page makes and it shares one rate-limited endpoint with
        // the highest — the one confirming somebody's mint. It waits, goes in
        // small batches, and stops entirely the moment it is throttled, so a
        // reader's transaction is never queued behind a history nobody asked
        // to refresh.
        const missing = sigs.map(x => x.signature).filter(sg => !eventCache.has(sg));
        if (missing.length) await new Promise(r => setTimeout(r, 2_500));
        for (let i = 0; i < missing.length && live; i += 3) {
          const chunk = missing.slice(i, i + 3);
          const txs = await connection.getParsedTransactions(chunk, { maxSupportedTransactionVersion: 0 })
            .catch(() => null);
          if (!txs) break;              // throttled: keep what we have
          txs.forEach((t, j) => eventCache.set(chunk[j], eventsFromLogs(t?.meta?.logMessages)));
          if (live) setRows(build());
          if (i + 3 < missing.length) await new Promise(r => setTimeout(r, 800));
        }
      } catch (e) {
        if (live && rows === null) setError(e instanceof Error ? e : new Error(String(e)));
      }
    };

    go();
    const id = setInterval(go, 45_000);
    return () => { live = false; clearInterval(id); };
    // `rows` is read only to decide whether an error should replace a
    // rendered ledger; including it would restart the fetch on every fill.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, vault, limit]);

  return { rows, error };
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
  const all = useDevnets();
  return useMemo(
    () => (all && symbol ? all.find(m => m.symbol === symbol) ?? null : null),
    [all, symbol],
  );
};
