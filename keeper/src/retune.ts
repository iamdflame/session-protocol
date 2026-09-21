/* Change a live vault's tunables.
 *
 * Identity, mints and feeds are immutable by design — changing what a vault
 * tracks is a new vault, not a parameter change — so this reaches only the
 * bounds, the windows and the incentive ramp. Every value is printed before
 * and after, because a parameter changed silently is a parameter nobody can
 * audit.
 *
 *   npm run retune -- --auction-secs 900
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { homedir } from 'node:os';
import { decodeVault } from '../../sdk/src/vault.ts';
import { setParamsIx, hexToBytes, explainProgramError, type VaultParams } from '../../sdk/src/ix.ts';
import type { Manifest } from './crank-core.ts';

const MANIFEST = 'keeper/.devnet/manifest.json';
const m = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest & { params: Record<string, unknown> };
const conn = new Connection(m.rpc, 'confirmed');
const authority = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, 'utf8'))),
);
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : null; };

const vaultKey = new PublicKey(m.vault);
const before = decodeVault((await conn.getAccountInfo(vaultKey))!.data);
console.log(`vault      ${m.vault}`);
console.log(`authority  ${before.authority.toBase58()}  (signing as ${authority.publicKey.toBase58()})`);

const next: VaultParams = {
  markFeedId: hexToBytes(m.params.markFeedId as string),
  equityFeedId: hexToBytes(m.params.equityFeedId as string),
  fundingKBps: before.fundingKBps,
  fundingMaxBps: before.fundingMaxBps,
  maxStaleSecs: Number(arg('max-stale-secs') ?? before.maxStaleSecs),
  maxConfBps: before.maxConfBps,
  maxMoveBps: Number(arg('max-move-bps') ?? before.maxMoveBps),
  equityQuietSecs: before.equityQuietSecs,
  fillIncentiveBps: before.fillIncentiveBps,
  maxCarryDeltaBps: before.maxCarryDeltaBps,
  maxUnexpectedClosedSecs: before.maxUnexpectedClosedSecs,
  maxPostedSlotAge: Number(arg('max-posted-slot-age') ?? before.maxPostedSlotAge),
  maxBellLeadSecs: Number(arg('max-bell-lead-secs') ?? before.maxBellLeadSecs),
  maxPremiumBps: Number(arg('max-premium-bps') ?? before.maxPremiumBps),
  auctionSecs: Number(arg('auction-secs') ?? before.auctionSecs),
  incentiveRamp: (arg('incentive-ramp')?.split(',').map(Number) as [number, number, number]) ?? before.incentiveRamp,
  requireVerifiedRecap: before.requireVerifiedRecap,
};

const changed = (Object.keys(next) as (keyof VaultParams)[]).filter(k => {
  const b = (before as unknown as Record<string, unknown>)[k];
  return b !== undefined && String(b) !== String(next[k]);
});
if (!changed.length) { console.log('\nnothing to change'); process.exit(0); }

console.log('\nchanging:');
for (const k of changed) {
  console.log(`  ${String(k).padEnd(22)} ${String((before as unknown as Record<string, unknown>)[k])} → ${String(next[k])}`);
}

try {
  const sig = await sendAndConfirmTransaction(
    conn, new Transaction().add(setParamsIx({ vault: vaultKey, authority: authority.publicKey }, next)),
    [authority], { commitment: 'confirmed' },
  );
  console.log(`\n  ${sig}`);
} catch (e: unknown) {
  const err = e as { logs?: string[]; message?: string };
  console.error(`\nrefused: ${explainProgramError(err.logs) ?? err.message}`);
  process.exit(1);
}

const after = decodeVault((await conn.getAccountInfo(vaultKey))!.data);
for (const k of changed) console.log(`  ${String(k).padEnd(22)} now ${String((after as unknown as Record<string, unknown>)[k])}`);
writeFileSync(MANIFEST, JSON.stringify({ ...m, params: { ...m.params, ...next, markFeedId: m.params.markFeedId, equityFeedId: m.params.equityFeedId } }, null, 2));
writeFileSync('web/public/devnet.json', readFileSync(MANIFEST, 'utf8'));
console.log(`\nmanifest updated`);
