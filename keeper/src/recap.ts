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
     --marks-from-chain     Still attested on chain — the program is handed a
                            number — but the number is Pyth's own print at the
                            bell, read back out of the sponsored price
                            account's write history (keeper/src/bell-prints.ts)
                            and printed with the signature it came from, so
                            anyone can check it rather than take it on trust.

   Usage:
     node --experimental-strip-types keeper/src/recap.ts [--vault <pubkey>]
          [--marks 1774618200=2203400000000000000,...] [--absorb] [--dry-run]

   `--absorb` is the one deliberate choice: if a replayed bell wipes the
   exposed class, charge the remainder to the other class rather than stop.
   Say so on purpose; it goes in the event.
   ─────────────────────────────────────────────────────────────────────────── */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { decodeVault, normalizeMark, HALT_REASON, type Vault } from '../../sdk/src/vault.ts';
import { recapIx, resolveHaltIx, bytesToHex, explainProgramError, type RecapEntry } from '../../sdk/src/ix.ts';
import { nextBoundary } from '../../sdk/src/calendar.ts';
import { fetchAsOf, hermesConfigured, postUpdate, type PostedUpdate } from './hermes.ts';
import { bellPrints } from './bell-prints.ts';
import type { Manifest } from './crank-core.ts';

/* Replaying two bells cost 677,259 CU when this was first needed for real (22
   Sep 2026) — past the 200k default and past the 600k this was once assumed
   to fit in. The limit is only a ceiling; it costs nothing unless a priority
   fee is set, so ask for the most a transaction can have. */
const RECAP_CU = 1_400_000;

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

/* Recap and resume are the vault authority's acts, and the authority is not
   the operator: on this deployment it is the deploy wallet. The tool used to
   sign with the operator key, which the program refuses as Unauthorized — a
   recovery path that could not recover anything. Load the authority's key
   and prove it is the right one before sending a thing. */
const authorityPath = arg('authority') ?? `${homedir()}/.config/solana/id.json`;
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(authorityPath, 'utf8'))));
if (!authority.publicKey.equals(v.authority)) {
  console.error(`${authorityPath} is ${authority.publicKey.toBase58()}, but this vault's authority is ${v.authority.toBase58()}.`);
  console.error('Pass --authority <keypair.json> for the key that owns the vault.');
  process.exit(1);
}
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

if (flag('marks-from-chain')) {
  const feed = bytesToHex(v.markFeedId);
  console.log('\nsource     ATTESTED, from Pyth\'s own prints — read back out of the sponsored price account');
  const { prints, fetched, failed } = await bellPrints(conn, new PublicKey(m.markPriceUpdate), feed, bells, v.maxBellLeadSecs);
  console.log(`           read ${fetched} update transaction(s)${failed ? `, ${failed} refused by the endpoint` : ''}`);
  for (const b of bells) {
    const p = prints.find(x => x.bell === b);
    if (!p) { console.error(`no print published within ${v.maxBellLeadSecs}s before the bell at ${fmt(b)}; cannot attest one`); process.exit(1); }
    const mark = normalizeMark({ feedId: v.markFeedId, price: p.price, conf: p.conf, expo: p.expo, publishTime: p.publishTime },
      v.underlyingDecimals, v.quoteDecimals);
    entries.push({ boundaryTs: b, mark });
    console.log(`  ${fmt(b)}  published ${fmt(p.publishTime)} (${p.publishTime - b}s)  mark ${mark}  from ${p.signature}`);
  }
  if (v.requireVerifiedRecap) { console.error('this vault requires a Pyth update per bell; attested marks will be refused'); process.exit(1); }
} else if (manual) {
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
  { vault: vaultKey, authority: authority.publicKey, nightMint: new PublicKey(m.nightMint), dayMint: new PublicKey(m.dayMint) },
  entries, flag('absorb'), posted.map(p => p.account),
);
try {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: RECAP_CU })).add(ix);
  const sig = await sendAndConfirmTransaction(conn, tx, [authority], { commitment: 'confirmed' });
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
    vault: vaultKey, authority: authority.publicKey,
    nightMint: new PublicKey(m.nightMint), dayMint: new PublicKey(m.dayMint),
    underlyingMint: new PublicKey(m.underlyingMint), underlyingVault: new PublicKey(m.underlyingVault),
  }, after.haltReason as (typeof HALT_REASON)[number]);
  try {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: RECAP_CU })).add(rix);
    const sig = await sendAndConfirmTransaction(conn, tx, [authority], { commitment: 'confirmed' });
    console.log(`resumed    ${sig}`);
  } catch (e: unknown) {
    const err = e as { logs?: string[]; message?: string };
    console.error(`resume refused: ${explainProgramError(err.logs) ?? err.message}`);
    process.exit(1);
  }
}
