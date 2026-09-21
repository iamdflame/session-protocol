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
  ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction,
  sendAndConfirmTransaction, type TransactionInstruction,
} from '@solana/web3.js';
import {
  decodeVault, decodePythQuote, normalizeMark, incentiveAt, decodeSchedule, decodeDetector,
  eventBoundaryDue, SESSION_EVENT,
  type Vault, type EventSchedule, type DetectorReading,
} from '../../sdk/src/vault.ts';
import { settleBoundaryIx, fillHandoffIx, openAuctionIx, createAtaIdempotentIx, ata, explainProgramError } from '../../sdk/src/ix.ts';
import { auctionPda } from '../../sdk/src/vault.ts';
import { nextBoundary, sessionAt, Session } from '../../sdk/src/calendar.ts';
import { WAD, mulDivFloor } from '../../sdk/src/settle.ts';
import { bytesToHex } from '../../sdk/src/ix.ts';
import { fetchAsOf, hermesConfigured, postUpdateAndConsume, HermesUnavailable } from './hermes.ts';

export interface Manifest {
  rpc: string;
  vault: string;
  /** The asset's ticker, as the site lists it: `NVDAx`, `OPENAI`. */
  symbol: string;
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
  /** 0 equity (NYSE hours), 1 event (the next print). Absent means equity. */
  sessionKind?: number;
  /** An event vault's two clocks. */
  schedule?: string;
  detector?: string;
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
  /** The call auction opened for this bell's residual, when one was. */
  auction?: { signature: string; address: string; closesAt: number } | { skipped: string };
  markAgeSecs: number | null;
  nightNav: string;
  dayNav: string;
}

const pk = (s: string) => new PublicKey(s);

/* Settling a boundary costs about 265,000 compute units — the oracle reads,
   the issuer inspection, the roll, funding, and the handoff sizing, in one
   instruction. The runtime's default is 200,000, so every settle this keeper
   ever sent failed with `exceeded CUs meter` and reported it as a failed
   simulation, which is why no boundary had settled on chain.
   
   Asked for explicitly, with headroom, rather than left to a default that is
   smaller than the work. */
export const CRANK_CU = 400_000;
const budgeted = (...ix: TransactionInstruction[]) =>
  new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: CRANK_CU }))
    .add(...ix);

export async function readVault(conn: Connection, m: Manifest): Promise<Vault> {
  const info = await conn.getAccountInfo(pk(m.vault));
  if (!info) throw new Error(`no vault at ${m.vault}`);
  return decodeVault(info.data);
}

/**
 * Whether there is a boundary to settle, and when the next one is.
 *
 * Two vaults, two clocks. An equity vault crosses a boundary when the NYSE
 * calendar says so. An event vault has no calendar — that is the whole
 * argument for it — and asking one anyway is what this function used to do
 * for both: it cranked the OPENAI vault whenever the exchange happened to
 * agree, and the program's correct refusal came back as
 * `settled: { failed: "no session boundary has elapsed" }`, which reads like
 * a broken keeper rather than a vault that is up to date.
 *
 * `reason` carries why, so a report says "THEN already holds it" instead of
 * reporting a refusal as a failure.
 */
export function boundaryDue(
  v: Vault,
  now: number,
  ev?: { schedule: EventSchedule | null; detector: DetectorReading | null },
): { due: boolean; next: number | null; reason?: string } {
  if (v.sessionKind === SESSION_EVENT) {
    if (!ev) return { due: false, next: null, reason: 'the schedule and the reading were not read' };
    const { due, why } = eventBoundaryDue(v, ev.schedule, ev.detector, now);
    const nextPrint = ev.schedule?.events.find(e => e.ts + e.windowSecs > now) ?? null;
    return { due, next: nextPrint ? nextPrint.ts : null, reason: why };
  }
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
  // An event vault's clocks live in two accounts of its own.
  let ev: { schedule: EventSchedule | null; detector: DetectorReading | null } | undefined;
  if (v.sessionKind === SESSION_EVENT && m.schedule && m.detector) {
    const [sAcc, dAcc] = await conn.getMultipleAccountsInfo([pk(m.schedule), pk(m.detector)]);
    ev = {
      schedule: sAcc ? decodeSchedule(sAcc.data) : null,
      detector: dAcc ? decodeDetector(dAcc.data) : null,
    };
  }

  const { due, next, reason } = boundaryDue(v, now, ev);
  report.nextBoundaryTs = next;
  report.boundaryDue = due;

  if (v.halted) {
    report.settled = { skipped: `halted: ${v.haltReason}` };
  } else if (!due) {
    report.settled = { skipped: reason ?? 'not due' };
  } else if (due) {
    // An event vault reads a schedule of prints and a posted divergence
    // instead of the calendar; the program refuses rather than guessing if
    // they are missing, so they are passed whenever the manifest has them.
    const settleWith = (markPriceUpdate: PublicKey) => settleBoundaryIx({
      vault: pk(m.vault), nightMint: pk(m.nightMint), dayMint: pk(m.dayMint),
      markPriceUpdate, equityPriceUpdate: pk(m.equityPriceUpdate),
      underlyingMint: pk(m.underlyingMint), underlyingVault: pk(m.underlyingVault),
      schedule: m.schedule ? pk(m.schedule) : undefined,
      detector: m.detector ? pk(m.detector) : undefined,
    });

    // The print at the bell, if Hermes will give it to us; the sponsored
    // account otherwise. The program decides whether either is acceptable.
    let posted = false;
    // The as-of print is the *bell's* tick. An event vault has no bell, so
    // there is no instant to ask Hermes about.
    if (hermesConfigured() && next !== null && v.sessionKind !== SESSION_EVENT) {
      try {
        const feed = bytesToHex(v.markFeedId);
        const update = (await fetchAsOf(feed, next)).data;
        const r = await postUpdateAndConsume(conn, operator, feed, update, acc => [settleWith(acc)], CRANK_CU);
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
      report.settled = await tryTx(conn, budgeted(settleWith(pk(m.markPriceUpdate))), [operator]);
      report.markSource = 'sponsored';
    }
    v = await readVault(conn, m);
    report.exposed = v.exposed; report.halted = v.halted; report.haltReason = v.haltReason;
    report.lastBoundaryTs = v.lastBoundaryTs;
    report.nightNav = v.nightNav.toString(); report.dayNav = v.dayNav.toString();
    report.pendingBefore = v.pendingDelta.toString();
  }

  /* ── auction ─────────────────────────────────────────────────────────── */
  //
  // Opened immediately after the settlement that created the residual, not on
  // a later tick. The window runs from the bell, so a crank that settles at
  // bell+5m and leaves the auction for the next run finds it already closed —
  // which is how a feature ships and never once executes.
  if (!v.halted && v.pendingDelta !== 0n && v.auctionSecs > 0 && 'signature' in report.settled) {
    const closesAt = v.lastBoundaryTs + v.auctionSecs;
    if (now < closesAt) {
      const [auction] = auctionPda(pk(m.vault), v.lastBoundaryTs);
      const exists = await conn.getAccountInfo(auction);
      if (exists) {
        report.auction = { skipped: 'already open for this bell' };
      } else {
        const r = await tryTx(conn, budgeted(
          openAuctionIx(pk(m.vault), auction, operator.publicKey),
        ), [operator]);
        report.auction = 'signature' in r
          ? { signature: r.signature, address: auction.toBase58(), closesAt }
          : { skipped: r.failed };
      }
    } else {
      report.auction = { skipped: `window closed ${now - closesAt}s ago` };
    }
  }

  /* ── fill ────────────────────────────────────────────────────────────── */
  //
  // Only once the auction has had its window. Filling continuously while an
  // auction is collecting bids would take the residual at one arbitrageur's
  // price, which is the thing the auction exists to prevent.
  const auctionOpen = report.auction && 'closesAt' in report.auction && now < report.auction.closesAt;
  if (!v.halted && v.pendingDelta !== 0n && markQ && !auctionOpen) {
    const mark = normalizeMark(markQ, v.underlyingDecimals, v.quoteDecimals);
    const quoteTokenProgram = pk(m.tokenProgram);
    const underlyingTokenProgram = pk(m.underlyingTokenProgram);
    const opU = ata(operator.publicKey, pk(m.underlyingMint), underlyingTokenProgram);
    const opQ = ata(operator.publicKey, pk(m.quoteMint), quoteTokenProgram);

    // Up to four passes: a fill can be partial when the operator's inventory
    // or the vault's stock does not cover the whole delta.
    for (let pass = 0; pass < 4 && v.pendingDelta !== 0n; pass++) {
      const buying = v.pendingDelta > 0n;
      let need = buying ? v.pendingDelta : -v.pendingDelta;            // quote atoms

      /* Buying, the vault pays the filler `gross + incentive` out of its own
         quote, while the incentive is charged to the larger class's NAV. A
         vault whose quote is exactly the exposure — which is every vault
         that has only ever been minted into — therefore cannot afford the
         whole handoff in one fill: it is short by precisely the incentive.
         Asking anyway is how the first real bell produced `InsufficientQuote`
         and filled nothing at all.
         
         So take what it can pay for. Each pass leaves a residual the size of
         the incentive on the part just filled, which shrinks by four orders
         of magnitude a pass at 10 bp and reaches zero inside the loop. What
         is still open when it ends is what the auction is for. */
      if (buying) {
        // The ramp, not the flat field: the chain charges `incentive_at(now)`,
        // and sizing against the wrong tier is what refuses the whole fill.
        const bps = BigInt(incentiveAt(v, now));
        const affordable = mulDivFloor(v.ownedQuote, 10_000n, 10_000n + bps);
        if (affordable < need) need = affordable;
      }

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

      const tx = budgeted(
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
