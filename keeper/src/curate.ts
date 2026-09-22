/* The desk's opinion, on chain.
 *
 * `curate` is the only thing a curator can do to a vault: it flips one
 * boolean and decides whether the catalog shows the vault by default. It
 * moves no tokens, halts nothing, and an uncurated vault mints, settles,
 * funds and redeems exactly the same for anyone holding its address. The
 * catalog says "curated" rather than "verified" for that reason — see
 * `docs/UPGRADE-POLICY.md` §4.
 *
 *   npm run devnet:curate                 list every vault and its state
 *   npm run devnet:curate -- --on  <addr> show it on the desk
 *   npm run devnet:curate -- --off <addr> stop showing it
 *   npm run devnet:curate -- --init       create the protocol account, once
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  decodeVault, decodeProtocol, protocolPda, PROGRAM_ID, VAULT_DISCRIMINATOR, SESSION_EVENT,
} from '../../sdk/src/vault.ts';
import { initProtocolIx, curateIx, explainProgramError } from '../../sdk/src/ix.ts';
import { inspectMint } from '../../sdk/src/issuer.ts';
import { gradeOf, GRADE_SUMMARY } from '../../sdk/src/claim.ts';
import type { Manifest } from './crank-core.ts';

const m: Manifest = JSON.parse(readFileSync('keeper/.devnet/manifest.json', 'utf8'));
const curator = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync('keeper/.devnet/operator.json', 'utf8'))));
const conn = new Connection(m.rpc, 'confirmed');
const argv = process.argv.slice(2);
const [protocol] = protocolPda();

const send = async (tx: Transaction) => {
  try { return { signature: await sendAndConfirmTransaction(conn, tx, [curator], { commitment: 'confirmed' }) }; }
  catch (e) {
    const err = e as { logs?: string[]; message?: string };
    return { failed: explainProgramError(err.logs) ?? err.message ?? String(e) };
  }
};

/* ── the protocol account ────────────────────────────────────────────────── */

let head = await conn.getAccountInfo(protocol);
if (!head && argv.includes('--init')) {
  console.log(`creating the protocol account ${protocol.toBase58()} with curator ${curator.publicKey.toBase58()}`);
  const r = await send(new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }))
    .add(initProtocolIx(protocol, curator.publicKey)));
  console.log(JSON.stringify(r));
  if ('failed' in r) process.exit(1);
  head = await conn.getAccountInfo(protocol);
}
if (!head) {
  console.log(`no protocol account at ${protocol.toBase58()} — run with --init to create it`);
  process.exit(1);
}
const proto = decodeProtocol(head.data);
// `vault_count` moves only on `curate`, so it is how many the desk shows —
// never how many exist. The scan below is the total.
console.log(`protocol ${protocol.toBase58()}  curator ${proto.curator.toBase58()}  ${proto.vaultCount} curated\n`);

/* ── every vault the program knows about ─────────────────────────────────── */

const disc = createHash('sha256').update('account:Vault').digest().subarray(0, 8);
if (bs58.encode(disc) !== bs58.encode(Uint8Array.from(VAULT_DISCRIMINATOR))) {
  throw new Error('VAULT_DISCRIMINATOR no longer matches sha256("account:Vault")');
}
const found = await conn.getProgramAccounts(PROGRAM_ID, {
  filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }],
});

let unreadable = 0;
const vaults = found.flatMap(({ pubkey, account }) => {
  try { return [{ address: pubkey, v: decodeVault(account.data) }]; }
  catch { unreadable++; return []; }
});

/* The grade of the thing each vault holds.
 *
 * `curate` flips one boolean and decides where a vault appears; it moves no
 * tokens and cannot halt anything. That is exactly why the floor has to be
 * mechanical rather than editorial — showing a vault first implies the desk
 * looked at what it holds, and until now nothing had. The grade comes from
 * powers the mint already publishes, so it is checkable rather than an
 * opinion somebody held once. */
const epoch = (await conn.getEpochInfo()).epoch;
const now = Math.floor(Date.now() / 1000);
const claims = new Map<string, ReturnType<typeof gradeOf>>();

for (const { address, v } of vaults) {
  let claim: ReturnType<typeof gradeOf> | null = null;
  const info = await conn.getAccountInfo(v.underlyingMint).catch(() => null);
  if (info) {
    claim = gradeOf(inspectMint(info.data, info.owner, epoch), now);
    claims.set(address.toBase58(), claim);
  }
  console.log(`${v.curated ? '●' : '○'} ${(v.symbol || 'unnamed').padEnd(8)} ${address.toBase58()}`
    + `  ${v.sessionKind === SESSION_EVENT ? 'event ' : 'equity'}`
    + `  ${v.halted ? `halted: ${v.haltReason}` : 'live'}`
    + `  grade ${claim ? claim.grade : '?'}${claim && claim.blocking.length ? ' (blocked)' : ''}`);
  if (claim) {
    for (const r of claim.reasons) console.log(`             · ${r}`);
    // A vault already showing that could not be curated today is the finding
    // this gate exists to surface, not a detail to leave in a list.
    if (v.curated && claim.blocking.length) {
      console.log(`             ! CURATED BUT WOULD BE REFUSED: ${claim.blocking.join('; ')}`);
    }
  }
}
if (unreadable) {
  console.log(`\n${unreadable} account(s) written by an older layout; this build refuses to decode them.`);
}

/* ── flip one ────────────────────────────────────────────────────────────── */

const on = argv.includes('--on');
const off = argv.includes('--off');
if (!on && !off) process.exit(0);

const target = argv[argv.indexOf(on ? '--on' : '--off') + 1];
if (!target) { console.log('\n--on/--off needs a vault address'); process.exit(1); }
const addr = new PublicKey(target);
if (!vaults.some(x => x.address.equals(addr))) {
  console.log(`\n${target} is not a vault of this program`);
  process.exit(1);
}

/* Refusing is the whole point of having a floor. `--force` exists because the
   curator is a person with reasons a mint cannot express, and it prints the
   override so the decision is on the record rather than implied by the
   absence of a refusal. */
if (on) {
  const claim = claims.get(addr.toBase58());
  if (!claim) {
    console.log('\ncannot read this vault’s underlying mint; refusing to curate something unexamined');
    process.exit(1);
  }
  if (claim.blocking.length) {
    console.log(`\nrefusing to curate ${target} — grade ${claim.grade}`);
    for (const b of claim.blocking) console.log(`  · ${b}`);
    if (!argv.includes('--force')) {
      console.log('\nPass --force to curate it anyway. Curation decides where a vault appears,');
      console.log('not whether it works, so this is an editorial floor and not a safety gate —');
      console.log('but a vault shown first implies somebody looked.');
      process.exit(1);
    }
    console.log('\n--force: curating against the floor. The reasons above stand.');
  } else {
    console.log(`\ngrade ${claim.grade} — ${GRADE_SUMMARY[claim.grade]}`);
  }
}

console.log(`\n${on ? 'curating' : 'uncurating'} ${target}`);
const r = await send(new Transaction()
  .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }))
  .add(curateIx(protocol, curator.publicKey, addr, on)));
console.log(JSON.stringify(r));
process.exit('failed' in r ? 1 : 0);
