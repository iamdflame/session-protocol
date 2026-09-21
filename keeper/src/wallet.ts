/* ───────────────────────────────────────────────────────────────────────────
   Which wallet is configured, and what does it hold.

   The mainnet steps — launching $BELL through Clawpump, seeding the pool it
   pairs with — spend real SOL from a key supplied in `.env`. Before any of
   that runs, this says plainly which address that key is and what is in it,
   on both clusters.

   Wallets export secrets in several shapes and getting the shape wrong
   produces a *valid but different* address, which looks like an empty wallet
   rather than like a mistake. So every plausible encoding is tried and the
   one that parses is named.

   This never prints the secret, and `.env` is gitignored.

     npm run wallet
   ─────────────────────────────────────────────────────────────────────────── */

import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

const ENV = process.argv.includes('--file') ? process.argv[process.argv.indexOf('--file') + 1] : '.env';
const VAR = process.argv.includes('--var') ? process.argv[process.argv.indexOf('--var') + 1] : null;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s: string): Uint8Array {
  const bytes = [0];
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error(`not base58: ${JSON.stringify(ch)}`);
    let carry = i;
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of s) { if (ch !== '1') break; bytes.push(0); }
  return Uint8Array.from(bytes.reverse());
}

export interface Parsed {
  keypair: Keypair;
  /** How it was read, so a wrong guess is visible rather than silent. */
  form: string;
}

/**
 * Parse a secret in whatever shape a wallet exported it.
 *
 * Whitespace is stripped first: a key copied out of a terminal or a chat
 * window arrives with line breaks and spaces in it, and every encoding below
 * would reject those for reasons that say nothing useful.
 */
export function parseSecret(raw: string): Parsed {
  const s = raw.trim();

  if (s.startsWith('[')) {
    const arr = Uint8Array.from(JSON.parse(s));
    if (arr.length === 64) return { keypair: Keypair.fromSecretKey(arr), form: 'JSON array, 64-byte secret key' };
    if (arr.length === 32) return { keypair: Keypair.fromSeed(arr), form: 'JSON array, 32-byte seed' };
    throw new Error(`JSON array of ${arr.length} bytes; expected 32 or 64`);
  }

  const compact = s.replace(/\s+/g, '');
  const hex = /^(0x)?[0-9a-fA-F]+$/.test(compact) ? compact.replace(/^0x/, '') : null;
  if (hex && hex.length === 128) {
    return { keypair: Keypair.fromSecretKey(Uint8Array.from(Buffer.from(hex, 'hex'))), form: 'hex, 64-byte secret key' };
  }
  if (hex && hex.length === 64) {
    return { keypair: Keypair.fromSeed(Uint8Array.from(Buffer.from(hex, 'hex'))), form: 'hex, 32-byte seed' };
  }

  const bytes = b58decode(compact);
  if (bytes.length === 64) return { keypair: Keypair.fromSecretKey(bytes), form: 'base58, 64-byte secret key (Phantom/Solflare export)' };
  if (bytes.length === 32) return { keypair: Keypair.fromSeed(bytes), form: 'base58, 32-byte seed' };
  throw new Error(`could not read this as a key: ${compact.length} characters, decoding to ${bytes.length} bytes`);
}

/* ── report ──────────────────────────────────────────────────────────────── */

// Only when run directly. `parseSecret` is imported by the launcher, and a
// module that prints a wallet report on import is a module that prints it in
// the middle of somebody else's output.
const RUN_DIRECTLY = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (!RUN_DIRECTLY) {
  // nothing else to do; the parser above is the export
} else {

let text: string;
try {
  text = readFileSync(ENV, 'utf8');
} catch {
  console.error(`no ${ENV}. Put the key in it as  private_key=<secret>  and try again.`);
  process.exit(1);
}

const vars = new Map<string, string>();
for (const line of text.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i > 0) vars.set(t.slice(0, i).trim(), t.slice(i + 1).trim().replace(/^["']|["']$/g, ''));
}

const name = VAR ?? [...vars.keys()].find(k => /priv|secret|key|wallet/i.test(k)) ?? [...vars.keys()][0];
const raw = name ? vars.get(name) : undefined;
if (!raw) {
  console.error(`${ENV} has no key-looking variable. Found: ${[...vars.keys()].join(', ') || '(nothing)'}`);
  process.exit(1);
}

let parsed: Parsed;
try {
  parsed = parseSecret(raw);
} catch (e) {
  console.error(`${ENV}: ${name} could not be read as a Solana key.`);
  console.error(`  ${(e as Error).message}`);
  console.error(`\n  A Solana secret is one of:`);
  console.error(`    base58, ~88 characters   — Phantom's "Export Private Key"`);
  console.error(`    a JSON array of 64 bytes — solana-keygen's id.json`);
  console.error(`  64 hex characters is the MetaMask/EVM shape and is not a Solana key,`);
  console.error(`  though it can be read as a 32-byte seed, which gives a different address.`);
  process.exit(1);
}

const addr = parsed.keypair.publicKey;
console.log(`${ENV}: ${name}`);
console.log(`read as  ${parsed.form}`);
console.log(`address  ${addr.toBase58()}\n`);

for (const net of ['mainnet-beta', 'devnet'] as const) {
  const conn = new Connection(`https://api.${net}.solana.com`, 'confirmed');
  try {
    const lamports = await conn.getBalance(addr);
    const sol = lamports / 1e9;
    console.log(`  ${net.padEnd(13)} ${sol} SOL${sol === 0 ? '   (empty)' : ''}`);
    if (sol > 0 && net === 'mainnet-beta') {
      const tokens = await conn.getParsedTokenAccountsByOwner(addr, {
        programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      });
      for (const t of tokens.value.slice(0, 6)) {
        const info = t.account.data.parsed.info;
        if (Number(info.tokenAmount.uiAmount) > 0) {
          console.log(`                ${info.tokenAmount.uiAmountString} of ${info.mint.slice(0, 8)}…`);
        }
      }
    }
  } catch (e) {
    console.log(`  ${net.padEnd(13)} rpc error: ${(e as Error).message.split('\n')[0]}`);
  }
}

}
