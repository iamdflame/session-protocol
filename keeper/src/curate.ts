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
console.log(`protocol ${protocol.toBase58()}  curator ${proto.curator.toBase58()}  ${proto.vaultCount} vault(s) counted\n`);

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

for (const { address, v } of vaults) {
  console.log(`${v.curated ? '●' : '○'} ${(v.symbol || 'unnamed').padEnd(8)} ${address.toBase58()}`
    + `  ${v.sessionKind === SESSION_EVENT ? 'event ' : 'equity'}`
    + `  ${v.halted ? `halted: ${v.haltReason}` : 'live'}`);
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

console.log(`\n${on ? 'curating' : 'uncurating'} ${target}`);
const r = await send(new Transaction()
  .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }))
  .add(curateIx(protocol, curator.publicKey, addr, on)));
console.log(JSON.stringify(r));
process.exit('failed' in r ? 1 : 0);
