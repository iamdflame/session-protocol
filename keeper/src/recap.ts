/* ───────────────────────────────────────────────────────────────────────────
   Recap a halted vault: replay the bells it missed.

   The program decides which bells those are; this tool only finds them so it
   can fetch a mark for each. Where the marks come from is the whole question:

     HERMES_API_KEY set     Pyth's own print at each bell, fetched from Hermes
                            history, posted and verified on chain. The program
                            takes the marks from those accounts — the operator
                            chose nothing.
     --marks ts=mark,...    The operator's word. Bounded by max_move_bps on
                            chain, recorded as "attested" in the receipt, and
                            refused outright by a vault that requires
                            verification.

   Usage:
     node --experimental-strip-types keeper/src/recap.ts [--vault <pubkey>]
          [--marks 1774618200=2203400000000000000,...] [--absorb] [--dry-run]

   `--absorb` is the one deliberate choice: if a replayed bell wipes the
   exposed class, charge the remainder to the other class rather than stop.
   Say so on purpose; it goes in the event.
   ─────────────────────────────────────────────────────────────────────────── */

import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { decodeVault, normalizeMark, HALT_REASON, type Vault } from '../../sdk/src/vault.ts';
import { recapIx, resolveHaltIx, bytesToHex, explainProgramError, type RecapEntry } from '../../sdk/src/ix.ts';
import { nextBoundary } from '../../sdk/src/calendar.ts';
import { fetchAsOf, hermesConfigured, postUpdate, type PostedUpdate } from './hermes.ts';
import type { Manifest } from './crank-core.ts';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const m: Manifest = JSON.parse(readFileSync('keeper/.devnet/manifest.json', 'utf8'));
const op = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('keeper/.devnet/operator.json', 'utf8'))));
const conn = new Connection(m.rpc, 'confirmed');
const vaultKey = new PublicKey(arg('vault') ?? m.vault);

/** Every bell in (last_boundary_ts, now], in order — what the program will insist on. */
export function missedBells(v: Vault, now: number): number[] {
  const bells: number[] = [];
  let t = v.lastBoundaryTs;
  for (let i = 0; i < 64; i++) {
    const b = nextBoundary(t, 12);
    if (b === null || b > now) break;
    bells.push(b);
    t = b;
  }
  return bells;
}

const v = decodeVault((await conn.getAccountInfo(vaultKey))!.data);
const now = Math.floor(Date.now() / 1000);
const bells = missedBells(v, now);
const fmt = (ts: number) => new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 16) + 'Z';

console.log(`vault      ${vaultKey.toBase58()}`);
console.log(`halted     ${v.halted ? v.haltReason : 'no'}   last bell ${fmt(v.lastBoundaryTs)}   mark ${v.lastMark}`);
console.log(`missed     ${bells.length} bell(s): ${bells.map(fmt).join(', ') || '—'}`);
if (!v.halted) { console.log('nothing to do: the vault is not halted'); process.exit(0); }
if (bells.length === 0) { console.log('nothing to replay: no bell has passed since the last settlement'); process.exit(0); }

/* ── the marks ───────────────────────────────────────────────────────────── */

const entries: RecapEntry[] = [];
const posted: PostedUpdate[] = [];
const manual = arg('marks');

if (manual) {
  const given = new Map(manual.split(',').map(kv => { const [ts, mark] = kv.split('='); return [Number(ts), BigInt(mark)] as const; }));
  for (const b of bells) {
    const mark = given.get(b);
    if (mark === undefined) { console.error(`no mark given for the bell at ${fmt(b)} (${b})`); process.exit(1); }
    entries.push({ boundaryTs: b, mark });
  }
  console.log('\nsource     ATTESTED — these marks are the operator\'s word, bounded by max_move_bps and recorded as such');
  if (v.requireVerifiedRecap) { console.error('this vault requires a Pyth update per bell; attested marks will be refused'); process.exit(1); }
} else if (hermesConfigured()) {
  const feed = bytesToHex(v.markFeedId);
  console.log('\nsource     Pyth, via Hermes history — one verified update per bell');
  for (const b of bells) {
    const u = await fetchAsOf(feed, b);
    const mark = normalizeMark({ feedId: v.markFeedId, price: u.price, conf: u.conf, expo: u.expo, publishTime: u.publishTime },
      v.underlyingDecimals, v.quoteDecimals);
    entries.push({ boundaryTs: b, mark });
    console.log(`  ${fmt(b)}  published ${fmt(u.publishTime)}  (${u.publishTime - b >= 0 ? '+' : ''}${u.publishTime - b}s)  mark ${mark}`);
    if (!flag('dry-run')) posted.push(await postUpdate(conn, op, u.data));
  }
} else {
  console.error('\nno HERMES_API_KEY and no --marks: nothing can supply the missed prints.');
  console.error('Either set a key (Pyth\'s own history, verified on chain) or attest marks explicitly with');
  console.error(`  --marks ${bells.map(b => `${b}=<mark>`).join(',')}`);
  process.exit(1);
}

if (flag('dry-run')) { console.log('\ndry run: nothing sent'); process.exit(0); }

/* ── the replay ──────────────────────────────────────────────────────────── */

const ix = recapIx(
  { vault: vaultKey, authority: op.publicKey, nightMint: new PublicKey(m.nightMint), dayMint: new PublicKey(m.dayMint) },
  entries, flag('absorb'), posted.map(p => p.account),
);
try {
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [op], { commitment: 'confirmed' });
  console.log(`\nrecapped   ${bells.length} bell(s) in ${sig}`);
} catch (e: unknown) {
  const err = e as { logs?: string[]; message?: string };
  console.error(`\nrecap refused: ${explainProgramError(err.logs) ?? err.message}`);
  for (const p of posted) await p.close().catch(() => null);
  process.exit(1);
}
for (const p of posted) await p.close().catch(() => null);

const after = decodeVault((await conn.getAccountInfo(vaultKey))!.data);
console.log(`           now at ${fmt(after.lastBoundaryTs)}  exposed=${after.exposed}  nav ${after.nightNav}/${after.dayNav}  pending ${after.pendingDelta}`);

/* ── resume, if the books are current ────────────────────────────────────── */

if (flag('resume')) {
  const rix = resolveHaltIx({
    vault: vaultKey, authority: op.publicKey,
    nightMint: new PublicKey(m.nightMint), dayMint: new PublicKey(m.dayMint),
    underlyingMint: new PublicKey(m.underlyingMint), underlyingVault: new PublicKey(m.underlyingVault),
  }, after.haltReason as (typeof HALT_REASON)[number]);
  try {
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(rix), [op], { commitment: 'confirmed' });
    console.log(`resumed    ${sig}`);
  } catch (e: unknown) {
    const err = e as { logs?: string[]; message?: string };
    console.error(`resume refused: ${explainProgramError(err.logs) ?? err.message}`);
    process.exit(1);
  }
}
