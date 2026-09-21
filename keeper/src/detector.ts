/* ───────────────────────────────────────────────────────────────────────────
   The one reading nobody can verify, kept fresh and kept honest.

   An equity vault settles against Pyth with full verification required. A
   PreStock has no oracle at all — nothing on any chain prices a pre-IPO
   token — so the event vault settles against two numbers an operator posts:
   the issuer's **mark**, and the price at which the token actually **trades**.
   The gap between them is the premium, and a premium that runs past the
   vault's tolerance is what flips exposure to THEN.

   The program bounds what it will accept: how stale a reading may be, who
   posted it, and how far the mark may move between readings. It cannot make
   the reading true. That is stated on `/markets/OPENAI` above the fold and in
   `docs/JUDGE.md`, and it is the one place this protocol rests on somebody's
   word.

   Both numbers come from prestocks.com's own API — the mark they publish and
   the price their token last traded at. Reading the executable price from a
   second source would be better, and there is not one: the real mint lives on
   mainnet, this vault is on devnet, and a Jupiter route for a token this thin
   is itself a quote rather than a fill.

     npm run devnet:detector            post once, print the premium
     npm run devnet:detector -- --dry   read and print, write nothing
   ─────────────────────────────────────────────────────────────────────────── */

import { readFileSync } from 'node:fs';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { decodeVault, decodeDetector, premiumBps } from '../../sdk/src/vault.ts';
import { postDetectorIx, explainProgramError } from '../../sdk/src/ix.ts';
import type { Manifest } from './crank-core.ts';

const WAD = 10n ** 18n;

export interface DetectorReport {
  ok: boolean;
  at: number;
  vault: string;
  symbol: string;
  /** What the issuer says it is worth. */
  mark: number;
  /** What it actually changes hands at. */
  executable: number;
  premiumBps: number;
  /** How far past the vault's tolerance, if it is past it. */
  overToleranceBps: number | null;
  /** Seconds since the reading the vault already had. */
  previousAgeSecs: number | null;
  posted: { signature: string } | { skipped: string } | { failed: string };
  source: string;
}

interface PreStock {
  symbol: string;
  markPrice: number;
  tokenPrice: number;
  contract_address: string;
}

const SOURCE = 'https://prestocks.com/api/prestocks';

/** The issuer's mark and the executable price, as WAD-scaled integers. */
export async function readPreStock(symbol: string): Promise<{
  mark: bigint; executable: bigint; markUsd: number; executableUsd: number; realMint: string;
}> {
  const all: PreStock[] = await fetch(SOURCE).then(r => r.json());
  const live = all.find(p => p.symbol.toUpperCase() === symbol.toUpperCase());
  if (!live) throw new Error(`prestocks.com did not return ${symbol}`);
  if (!(live.markPrice > 0) || !(live.tokenPrice > 0)) {
    // A zero on either side would post a premium of 100% and flip the vault
    // on a missing field rather than on a real divergence.
    throw new Error(`${symbol} came back with a non-positive price: mark ${live.markPrice}, token ${live.tokenPrice}`);
  }
  return {
    // Cents, then scaled: the API gives dollars as floats, and going through
    // an integer first keeps the posted number exactly what was read.
    mark: BigInt(Math.round(live.markPrice * 1e6)) * WAD / 10n ** 6n,
    executable: BigInt(Math.round(live.tokenPrice * 1e6)) * WAD / 10n ** 6n,
    markUsd: live.markPrice,
    executableUsd: live.tokenPrice,
    realMint: live.contract_address,
  };
}

/**
 * Read the issuer's numbers and post them, unless the vault already has the
 * same ones. Re-posting an unchanged reading costs a fee and moves the
 * staleness clock, which makes a dead feed look alive.
 */
export async function postDetector(
  conn: Connection, m: Manifest, poster: Keypair, opts: { dry?: boolean } = {},
): Promise<DetectorReport> {
  const now = Math.floor(Date.now() / 1000);
  const pk = (s: string) => new PublicKey(s);
  if (!m.detector) throw new Error(`${m.symbol} has no detector account; it is not an event vault`);

  const v = decodeVault((await conn.getAccountInfo(pk(m.vault)))!.data);
  const reading = await readPreStock(m.symbol);
  const bps = premiumBps({ mark: reading.mark, executable: reading.executable });

  const prevInfo = await conn.getAccountInfo(pk(m.detector));
  const prev = prevInfo ? decodeDetector(prevInfo.data) : null;

  const report: DetectorReport = {
    ok: false,
    at: now,
    vault: m.vault,
    symbol: m.symbol,
    mark: reading.markUsd,
    executable: reading.executableUsd,
    premiumBps: bps,
    overToleranceBps: Math.abs(bps) > v.maxPremiumBps ? Math.abs(bps) - v.maxPremiumBps : null,
    previousAgeSecs: prev ? now - prev.ts : null,
    posted: { skipped: 'dry run' },
    source: SOURCE,
  };

  if (opts.dry) return { ...report, ok: true };

  // Unchanged *and* still inside the vault's staleness bound: nothing to say.
  // Once it approaches that bound the same numbers are worth re-posting, because
  // the program refuses to settle on a reading it considers old.
  const unchanged = prev && prev.mark === reading.mark && prev.executable === reading.executable;
  const ageBudget = Math.floor(v.maxStaleSecs * 0.6);
  if (unchanged && report.previousAgeSecs !== null && report.previousAgeSecs < ageBudget) {
    report.posted = { skipped: `unchanged, and ${report.previousAgeSecs}s old against a ${v.maxStaleSecs}s bound` };
    return { ...report, ok: true };
  }

  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 }))
    .add(postDetectorIx(pk(m.vault), poster.publicKey, pk(m.detector), reading.mark, reading.executable));
  try {
    const signature = await sendAndConfirmTransaction(conn, tx, [poster], { commitment: 'confirmed' });
    report.posted = { signature };
    report.ok = true;
  } catch (e) {
    const err = e as { logs?: string[]; message?: string };
    report.posted = { failed: explainProgramError(err.logs) ?? err.message ?? String(e) };
  }
  return report;
}
