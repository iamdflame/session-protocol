/* ───────────────────────────────────────────────────────────────────────────
   The boundary crank and health monitor.

   `settle_boundary` is permissionless and refuses to act unless exactly one
   boundary has elapsed, so this keeper holds no privilege the protocol depends
   on. It can be late, absent or malicious and the worst it achieves is delay —
   the program checks the calendar, the elapsed-boundary count, oracle freshness,
   Pyth's confidence band and the size of the move itself.

   What it must do well is notice. A halted vault is the protocol working; a
   vault drifting toward a halt with nobody watching is the actual failure mode,
   which is why health evaluation runs on every tick and not only at boundaries.

     node --experimental-strip-types keeper/src/index.ts --schedule
     node --experimental-strip-types keeper/src/index.ts --watch  --vault <pubkey>
     node --experimental-strip-types keeper/src/index.ts --health --vault <pubkey>
   ─────────────────────────────────────────────────────────────────────────── */

import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction,
         SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { sessionAt, nextBoundary, Session, civilFromDays, weekdayFromDays,
         isDST, SEC_PER_DAY } from '../../sdk/src/calendar.ts';
import { decodeVault, decodePythQuote, PROGRAM_ID, type Vault } from '../../sdk/src/vault.ts';
import { evaluate, format, Severity, type VaultState } from '../../sdk/src/health.ts';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Format a UTC instant in Eastern wall-clock, which is how a trader reads it. */
export function etString(ts: number): string {
  const et = ts + (isDST(ts) ? -4 : -5) * 3600;
  const days = Math.floor(et / SEC_PER_DAY);
  const s = et - days * SEC_PER_DAY;
  const { y, m, d } = civilFromDays(days);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${y}-${p(m)}-${p(d)} ${DOW[weekdayFromDays(days)]} ` +
         `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))} ${isDST(ts) ? 'EDT' : 'EST'}`;
}

export interface Boundary {
  ts: number;
  to: Session;
  takes: 'NIGHT' | 'DAY';
  gapHours: number;
}

/** The next `n` boundaries after `from`. */
export function schedule(from: number, n = 10): Boundary[] {
  const out: Boundary[] = [];
  let t = from;
  for (let i = 0; i < n; i++) {
    const b = nextBoundary(t, 20);
    if (b === null) break;
    const after = sessionAt(b);
    out.push({
      ts: b, to: after,
      takes: after === Session.Closed ? 'NIGHT' : 'DAY',
      gapHours: (b - t) / 3600,
    });
    t = b;
  }
  return out;
}

/* ── instruction encoding ────────────────────────────────────────────────── */

/** Anchor dispatches on `sha256("global:<name>")[..8]`. */
const discriminator = (name: string): Buffer =>
  createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);

/**
 * `settle_boundary` takes no arguments and no signer: the vault, both mints and
 * the two price accounts are all it needs, which is what makes the crank
 * permissionless.
 */
export function settleBoundaryIx(
  vault: PublicKey, nightMint: PublicKey, dayMint: PublicKey,
  markUpdate: PublicKey, equityUpdate: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: nightMint, isSigner: false, isWritable: false },
      { pubkey: dayMint, isSigner: false, isWritable: false },
      { pubkey: markUpdate, isSigner: false, isWritable: false },
      { pubkey: equityUpdate, isSigner: false, isWritable: false },
    ],
    data: discriminator('settle_boundary'),
  });
}

/* ── chain reads ─────────────────────────────────────────────────────────── */

export interface Loaded {
  vault: Vault;
  address: PublicKey;
  state: VaultState;
}

/**
 * Read everything health needs in one pass.
 *
 * Deliberately a single `getMultipleAccounts`: reading the vault, its balances
 * and its oracles in separate calls can straddle a slot boundary and produce a
 * view that never existed, which is how monitors raise phantom alerts.
 */
export async function load(
  conn: Connection, address: PublicKey, markUpdate: PublicKey, equityUpdate: PublicKey,
): Promise<Loaded> {
  const head = await conn.getAccountInfo(address);
  if (!head) throw new Error(`no vault at ${address.toBase58()}`);
  const vault = decodeVault(head.data);

  const [uAcc, qAcc, markAcc, eqAcc] = await conn.getMultipleAccountsInfo([
    vault.underlyingVault, vault.quoteVault, markUpdate, equityUpdate,
  ]);

  // SPL token accounts carry `amount` as a u64 at offset 64.
  const amountOf = (d: Uint8Array | undefined): bigint => {
    if (!d || d.length < 72) return 0n;
    let v = 0n;
    for (let i = 71; i >= 64; i--) v = (v << 8n) | BigInt(d[i]);
    return v;
  };

  const mark = markAcc ? decodePythQuote(markAcc.data) : null;
  const equity = eqAcc ? decodePythQuote(eqAcc.data) : null;

  const state: VaultState = {
    halted: vault.halted,
    haltReason: vault.haltReason,
    paused: vault.flags,
    nightSupply: 0n,   // filled below
    daySupply: 0n,
    nightNav: vault.nightNav,
    dayNav: vault.dayNav,
    lastMark: vault.lastMark,
    ownedUnderlying: vault.ownedUnderlying,
    ownedQuote: vault.ownedQuote,
    balanceUnderlying: amountOf(uAcc?.data),
    balanceQuote: amountOf(qAcc?.data),
    pendingDelta: vault.pendingDelta,
    lastBoundaryTs: vault.lastBoundaryTs,
    lastSessionOpen: vault.lastSessionOpen,
    maxCarryDeltaBps: vault.maxCarryDeltaBps,
    markPublishTs: mark?.publishTime ?? 0,
    equityPublishTs: equity?.publishTime ?? 0,
    maxStaleSecs: vault.maxStaleSecs,
    equityQuietSecs: vault.equityQuietSecs,
    maxUnexpectedClosedSecs: vault.maxUnexpectedClosedSecs,
  };

  // SPL mints carry `supply` as a u64 at offset 36.
  const [nm, dm] = await conn.getMultipleAccountsInfo([vault.nightMint, vault.dayMint]);
  const supplyOf = (d: Uint8Array | undefined): bigint => {
    if (!d || d.length < 44) return 0n;
    let v = 0n;
    for (let i = 43; i >= 36; i--) v = (v << 8n) | BigInt(d[i]);
    return v;
  };
  state.nightSupply = supplyOf(nm?.data);
  state.daySupply = supplyOf(dm?.data);

  return { vault, address, state };
}

/* ── the loop ────────────────────────────────────────────────────────────── */

export interface KeeperConfig {
  rpc: string;
  vault: PublicKey;
  markUpdate: PublicKey;
  equityUpdate: PublicKey;
  payer?: Keypair;
  /** Report health even when nothing needs doing. */
  verbose?: boolean;
}

export async function tick(conn: Connection, cfg: KeeperConfig): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const { vault, state } = await load(conn, cfg.vault, cfg.markUpdate, cfg.equityUpdate);
  const health = evaluate(state, now);

  if (health.severity !== Severity.Ok || cfg.verbose) {
    console.log(`\n[${etString(now)}] ${health.severity.toUpperCase()}`);
    console.log(format(health));
  }

  if (vault.halted) {
    // Nothing a keeper can do. Cranking a halted vault only wastes fees; the
    // halt is deliberate and needs a human decision to clear.
    return;
  }
  if (health.crankLateSecs === 0) return;

  if (!cfg.payer) {
    console.log('  (no payer configured — would submit settle_boundary here)');
    return;
  }

  const ix = settleBoundaryIx(
    cfg.vault, vault.nightMint, vault.dayMint, cfg.markUpdate, cfg.equityUpdate,
  );
  try {
    const sig = await sendAndConfirmTransaction(
      conn, new Transaction().add(ix), [cfg.payer], { commitment: 'confirmed' },
    );
    console.log(`  settled: ${sig}`);
  } catch (e) {
    // Reverts are expected and usually transient: a stale mark, a wide
    // confidence band. The boundary stays settleable for the rest of the
    // session, so retrying on the next tick is the correct response.
    console.log(`  settle reverted, will retry: ${(e as Error).message.split('\n')[0]}`);
  }
}

/* ── entry point ─────────────────────────────────────────────────────────── */

function printSchedule(now: number) {
  console.log(`\nnow            ${etString(now)}`);
  console.log(`session        ${sessionAt(now) === Session.Open
    ? 'OPEN  — DAY holds the stock' : 'CLOSED — NIGHT holds the stock'}`);
  console.log(`\nupcoming boundaries`);
  console.log('─'.repeat(72));
  for (const b of schedule(now, 10)) {
    const wait = b.gapHours >= 24 ? `${(b.gapHours / 24).toFixed(1)}d` : `${b.gapHours.toFixed(1)}h`;
    console.log(`  ${etString(b.ts).padEnd(30)} ${b.takes.padEnd(6)} takes exposure` +
                `   after ${wait.padStart(6)}` + (b.gapHours > 20 ? '   ← weekend or holiday' : ''));
  }
  console.log('─'.repeat(72));
  console.log('A weekend is a single 65.5h NIGHT position — two thirds of every week');
  console.log('is time nobody has been able to own separately.');
}

const arg = (k: string): string | undefined => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const isMain = process.argv[1]?.endsWith('keeper/src/index.ts');
if (isMain) {
  const now = Math.floor(Date.now() / 1000);

  if (process.argv.includes('--schedule') || process.argv.length <= 2) {
    printSchedule(now);
    console.log('\n--watch --vault <pubkey> to run the crank, --health for one report.');
  } else {
    const vaultArg = arg('vault');
    if (!vaultArg) {
      console.error('--vault <pubkey> is required');
      process.exit(2);
    }
    const cfg: KeeperConfig = {
      rpc: arg('rpc') ?? 'https://api.mainnet-beta.solana.com',
      vault: new PublicKey(vaultArg),
      markUpdate: new PublicKey(arg('mark') ?? vaultArg),
      equityUpdate: new PublicKey(arg('equity') ?? vaultArg),
      verbose: process.argv.includes('--verbose'),
    };
    const keyPath = arg('keypair');
    if (keyPath) {
      cfg.payer = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(readFileSync(keyPath, 'utf8'))),
      );
    }
    const conn = new Connection(cfg.rpc, 'confirmed');

    if (process.argv.includes('--health')) {
      await tick(conn, { ...cfg, verbose: true });
    } else {
      printSchedule(now);
      console.log('\nwatching (ctrl-c to stop)');
      for (;;) {
        try {
          await tick(conn, cfg);
        } catch (e) {
          console.error(`  tick failed: ${(e as Error).message}`);
        }
        // Poll far more often than boundaries arrive: the cost is a few RPC
        // calls, and the benefit is noticing a developing problem hours before
        // it becomes a halt.
        await new Promise(r => setTimeout(r, 30_000));
      }
    }
  }
}
