/* ───────────────────────────────────────────────────────────────────────────
   Crank and fill, as pure-ish functions.

   Used by the devnet CLI, the serverless endpoint the site pings, and anything
   else that wants to keep a vault current. Two jobs:

     settle   if the calendar says a bell has rung since the vault last
              settled, call `settle_boundary`. Permissionless; the only cost is
              the fee.
     fill     if the vault is carrying a handoff (`pending_delta != 0`), trade
              against it from the operator's inventory until it is flat. On
              mainnet this is a market maker's job and they are paid the
              incentive for it; on devnet the operator is the market maker.

   Both are idempotent: run it twice and the second call reports "nothing to
   do". Nothing here is trusted to be right — every state transition is read
   back from the chain after the transaction confirms.
   ─────────────────────────────────────────────────────────────────────────── */

import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { decodeVault, decodePythQuote, normalizeMark, type Vault } from '../../sdk/src/vault.ts';
import { settleBoundaryIx, fillHandoffIx, createAtaIdempotentIx, ata, explainProgramError } from '../../sdk/src/ix.ts';
import { nextBoundary, sessionAt, Session } from '../../sdk/src/calendar.ts';
import { WAD, mulDivFloor } from '../../sdk/src/settle.ts';
import { bytesToHex } from '../../sdk/src/ix.ts';
import { fetchAsOf, hermesConfigured, postUpdateAndConsume, HermesUnavailable } from './hermes.ts';

export interface Manifest {
  rpc: string;
  vault: string;
  underlyingMint: string;
  quoteMint: string;
  nightMint: string;
  dayMint: string;
  underlyingVault: string;
  quoteVault: string;
  markPriceUpdate: string;
  equityPriceUpdate: string;
  operator: string;
  /** The program owning the underlying — Token-2022 for a real xStock. */
  underlyingTokenProgram: string;
  /** The program owning the quote. */
  tokenProgram: string;
  /** The program owning the share classes — Token-2022, for their metadata. */
  shareTokenProgram: string;
}

export interface CrankReport {
  ok: boolean;
  at: number;
  vault: string;
  exposed: string;
  halted: boolean;
  haltReason: string;
  lastBoundaryTs: number;
  nextBoundaryTs: number | null;
  boundaryDue: boolean;
  settled: { signature: string } | { skipped: string } | { failed: string };
  /**
   * Where the settlement mark came from. `hermes-as-of` is the print Pyth
   * published at the bell, posted and verified for this crank; `sponsored`
   * is whatever the sponsored feed account holds at crank time, which the
   * program admits only while its bell window is wide enough.
   */
  markSource: 'hermes-as-of' | 'sponsored' | null;
  /** Why the as-of path was not taken, when it was not. */
  markNote?: string;
  pendingBefore: string;
  pendingAfter: string;
  fills: { signature: string; underlying: string; buying: boolean }[];
  fillError?: string;
  markAgeSecs: number | null;
  nightNav: string;
  dayNav: string;
}

const pk = (s: string) => new PublicKey(s);

export async function readVault(conn: Connection, m: Manifest): Promise<Vault> {
  const info = await conn.getAccountInfo(pk(m.vault));
  if (!info) throw new Error(`no vault at ${m.vault}`);
  return decodeVault(info.data);
}

/** A boundary is due when the calendar has crossed one since the last settlement. */
export function boundaryDue(v: Vault, now: number): { due: boolean; next: number | null } {
  const next = nextBoundary(v.lastBoundaryTs, 20);
  return { due: next !== null && now >= next, next };
}

async function tryTx(
  conn: Connection, tx: Transaction, signers: Keypair[],
): Promise<{ signature: string } | { failed: string }> {
  try {
    const signature = await sendAndConfirmTransaction(conn, tx, signers, { commitment: 'confirmed' });
    return { signature };
  } catch (e: unknown) {
    const err = e as { logs?: string[]; message?: string };
    return { failed: explainProgramError(err.logs) ?? err.message ?? String(e) };
  }
}

/**
 * Run one crank cycle. `operator` signs and pays; it must hold underlying and
 * quote if a fill is expected.
 */
export async function crank(conn: Connection, m: Manifest, operator: Keypair): Promise<CrankReport> {
  const now = Math.floor(Date.now() / 1000);
  let v = await readVault(conn, m);

  const report: CrankReport = {
    ok: true, at: now, vault: m.vault,
    exposed: v.exposed, halted: v.halted, haltReason: v.haltReason,
    lastBoundaryTs: v.lastBoundaryTs, nextBoundaryTs: null, boundaryDue: false,
    settled: { skipped: 'not due' }, markSource: null,
    pendingBefore: v.pendingDelta.toString(), pendingAfter: v.pendingDelta.toString(),
    fills: [], markAgeSecs: null,
    nightNav: v.nightNav.toString(), dayNav: v.dayNav.toString(),
  };

  // The mark's age, for the report — the program refuses a stale one itself.
  const markInfo = await conn.getAccountInfo(pk(m.markPriceUpdate));
  const markQ = markInfo ? decodePythQuote(markInfo.data) : null;
  report.markAgeSecs = markQ ? now - markQ.publishTime : null;

  /* ── settle ──────────────────────────────────────────────────────────── */
  const { due, next } = boundaryDue(v, now);
  report.nextBoundaryTs = next;
  report.boundaryDue = due;

  if (v.halted) {
    report.settled = { skipped: `halted: ${v.haltReason}` };
  } else if (due && next !== null) {
    const settleWith = (markPriceUpdate: PublicKey) => settleBoundaryIx({
      vault: pk(m.vault), nightMint: pk(m.nightMint), dayMint: pk(m.dayMint),
      markPriceUpdate, equityPriceUpdate: pk(m.equityPriceUpdate),
      underlyingMint: pk(m.underlyingMint), underlyingVault: pk(m.underlyingVault),
    });

    // The print at the bell, if Hermes will give it to us; the sponsored
    // account otherwise. The program decides whether either is acceptable.
    let posted = false;
    if (hermesConfigured()) {
      try {
        const feed = bytesToHex(v.markFeedId);
        const update = (await fetchAsOf(feed, next)).data;
        const r = await postUpdateAndConsume(conn, operator, feed, update, acc => [settleWith(acc)]);
        report.settled = { signature: r.signatures[r.signatures.length - 2] ?? r.signatures[0] };
        report.markSource = 'hermes-as-of';
        posted = true;
      } catch (e: unknown) {
        const err = e as { message?: string; logs?: string[] };
        report.markNote = e instanceof HermesUnavailable ? e.message : (explainProgramError(err.logs) ?? err.message ?? String(e));
      }
    } else {
      report.markNote = 'HERMES_API_KEY not set; the sponsored feed is the only mark available';
    }
    if (!posted) {
      report.settled = await tryTx(conn, new Transaction().add(settleWith(pk(m.markPriceUpdate))), [operator]);
      report.markSource = 'sponsored';
    }
    v = await readVault(conn, m);
    report.exposed = v.exposed; report.halted = v.halted; report.haltReason = v.haltReason;
    report.lastBoundaryTs = v.lastBoundaryTs;
    report.nightNav = v.nightNav.toString(); report.dayNav = v.dayNav.toString();
    report.pendingBefore = v.pendingDelta.toString();
  }

  /* ── fill ────────────────────────────────────────────────────────────── */
  if (!v.halted && v.pendingDelta !== 0n && markQ) {
    const mark = normalizeMark(markQ, v.underlyingDecimals, v.quoteDecimals);
    const quoteTokenProgram = pk(m.tokenProgram);
    const underlyingTokenProgram = pk(m.underlyingTokenProgram);
    const opU = ata(operator.publicKey, pk(m.underlyingMint), underlyingTokenProgram);
    const opQ = ata(operator.publicKey, pk(m.quoteMint), quoteTokenProgram);

    // Up to four passes: a fill can be partial when the operator's inventory
    // or the vault's stock does not cover the whole delta.
    for (let pass = 0; pass < 4 && v.pendingDelta !== 0n; pass++) {
      const buying = v.pendingDelta > 0n;
      const need = buying ? v.pendingDelta : -v.pendingDelta;          // quote atoms
      let amount = mulDivFloor(need, WAD, mark);                       // underlying atoms
      if (!buying && amount > v.ownedUnderlying) amount = v.ownedUnderlying;
      if (amount === 0n) break;

      // Bounds are generous: the operator is the vault's own market maker on
      // devnet and has no one to protect from slippage but itself.
      const gross = mulDivFloor(amount, mark, WAD);
      const ix = fillHandoffIx({
        vault: pk(m.vault), underlyingVault: pk(m.underlyingVault), quoteVault: pk(m.quoteVault),
        nightMint: pk(m.nightMint), dayMint: pk(m.dayMint),
        fillerUnderlying: opU, fillerQuote: opQ, filler: operator.publicKey,
        markPriceUpdate: pk(m.markPriceUpdate),
        underlyingMint: pk(m.underlyingMint), quoteMint: pk(m.quoteMint),
        underlyingTokenProgram, quoteTokenProgram,
      }, amount, gross * 2n + 1_000_000n, 0n);

      const tx = new Transaction().add(
        createAtaIdempotentIx(operator.publicKey, operator.publicKey, pk(m.underlyingMint), underlyingTokenProgram),
        createAtaIdempotentIx(operator.publicKey, operator.publicKey, pk(m.quoteMint), quoteTokenProgram),
        ix,
      );
      const r = await tryTx(conn, tx, [operator]);
      if ('failed' in r) { report.fillError = r.failed; break; }
      report.fills.push({ signature: r.signature, underlying: amount.toString(), buying });
      v = await readVault(conn, m);
    }
  }

  report.pendingAfter = v.pendingDelta.toString();
  report.exposed = v.exposed; report.halted = v.halted; report.haltReason = v.haltReason;
  report.nightNav = v.nightNav.toString(); report.dayNav = v.dayNav.toString();
  report.ok = !('failed' in report.settled) && !report.fillError;
  return report;
}

/** The calendar's view, for callers that want to show "next bell" without a vault read. */
export const sessionNow = (now = Math.floor(Date.now() / 1000)) =>
  sessionAt(now) === Session.Open ? 'day' : 'night';
