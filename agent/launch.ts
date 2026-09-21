/* ───────────────────────────────────────────────────────────────────────────
   Launch $BELL through Clawpump, quoted in a tokenized stock.

   The agent is the keeper. It rings the session boundary, settles it, and
   clears the residual the handoff leaves — so its token is quoted in NVDAx
   rather than in SOL, because the thing it cranks is a vault holding a
   tokenized stock. That pairing is the whole point: a curve denominated in
   the asset the protocol is about, not in the chain's gas token.

   This spends real mainnet SOL. It refuses to without `--confirm`, prints
   the exact amount first, and writes down what it did afterwards.

     npm run bell            quote only, spends nothing
     npm run bell -- --confirm
   ─────────────────────────────────────────────────────────────────────────── */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { parseSecret } from '../keeper/src/wallet.ts';

const API = 'https://clawpump.tech/api/v1';
const RPC = process.env.MAINNET_RPC ?? 'https://api.mainnet-beta.solana.com';
/** The real NVDAx. The curve is denominated in this. */
const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const CONFIRM = process.argv.includes('--confirm');
const OUT = 'keeper/.devnet/bell.json';

const env = new Map<string, string>();
for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i > 0) env.set(t.slice(0, i).trim(), t.slice(i + 1).trim().replace(/^["']|["']$/g, ''));
}
const key = env.get('clawpump_api_key');
const secret = env.get('private_key');
if (!key || !secret) throw new Error('.env needs private_key and clawpump_api_key');

const payer = parseSecret(secret).keypair;
const conn = new Connection(RPC, 'confirmed');

/* The agent, as Clawpump holds it. Read rather than hardcoded, so the
   identifiers cannot drift from the account that actually exists. */
const agents = await fetch(`${API}/agents`, { headers: { authorization: `Bearer ${key}` } })
  .then(r => r.json()) as { agents: { id: string; name: string; walletAddress: string; status: string }[] };
const agent = agents.agents?.[0];
if (!agent) throw new Error('no agent on this Clawpump account');

console.log(`agent    ${agent.name}  ${agent.id}`);
console.log(`         wallet ${agent.walletAddress}  (${agent.status})`);
console.log(`payer    ${payer.publicKey.toBase58()}`);
const before = await conn.getBalance(payer.publicKey);
console.log(`         ${before / LAMPORTS_PER_SOL} SOL on mainnet\n`);

/* ── the request, in one place ───────────────────────────────────────────
   The preflight token carries a hash of this body, so the launch call has
   to send back exactly what was quoted. Building it twice is how that
   goes wrong. */
const BODY = {
  agentId: agent.id,
  agentName: agent.name,
  name: 'SESSION Bell',
  symbol: 'BELL',
  description:
    'The keeper of SESSION. Rings the session boundary at 09:30 and 16:00 ET, settles it, '
    + 'and clears the residual the handoff leaves. Paired with NVDAx because the vault it '
    + 'cranks holds a tokenized stock.',
  imageUrl: 'https://session-roan.vercel.app/bell.png',
  walletAddress: payer.publicKey.toBase58(),
  pumpQuoteMint: NVDAX,
};

const post = async (path: string, body: unknown) => {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text) as Record<string, unknown> }; }
  catch { return { status: r.status, json: { raw: text.slice(0, 400) } }; }
};

/* ── quote ───────────────────────────────────────────────────────────────── */

const pre = await post('/launch/self-funded', { ...BODY, preflight: true });
if (pre.status !== 200) {
  console.error(`preflight refused (${pre.status}):`, JSON.stringify(pre.json).slice(0, 500));
  process.exit(1);
}
const payment = pre.json.payment as { amountLamports: number; amountSol: number; payTo: string; validForSeconds: number };
const token = (pre.json.retryWith as { preflightToken: string }).preflightToken;

console.log(`quote    ${payment.amountSol} SOL to ${payment.payTo}`);
console.log(`         valid ${payment.validForSeconds}s`);
console.log(`         curve quoted in NVDAx (${NVDAX.slice(0, 8)}…)`);

if (!CONFIRM) {
  console.log('\nnothing spent. re-run with --confirm to launch.');
  process.exit(0);
}
if (before < payment.amountLamports + 5_000_000) {
  console.error(`\npayer holds ${before / LAMPORTS_PER_SOL} SOL, needs ${payment.amountSol} plus fees`);
  process.exit(1);
}

/* ── pay, then launch ────────────────────────────────────────────────────── */

console.log(`\npaying ${payment.amountSol} SOL…`);
const sig = await sendAndConfirmTransaction(
  conn,
  new Transaction().add(SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: new PublicKey(payment.payTo),
    lamports: payment.amountLamports,
  })),
  [payer],
  { commitment: 'confirmed' },
);
console.log(`  ${sig}`);

const out = await post('/launch/self-funded', { ...BODY, txSignature: sig, preflightToken: token });
if (out.status !== 200) {
  console.error(`\nlaunch refused (${out.status}):`, JSON.stringify(out.json).slice(0, 700));
  console.error(`the SOL was sent in ${sig} — quote that request id to Clawpump if it is not honoured.`);
  process.exit(1);
}

console.log('\nlaunched');
for (const k of ['mintAddress', 'txHash', 'status', 'pumpQuoteAsset']) {
  if (out.json[k] !== undefined) console.log(`  ${k.padEnd(15)} ${JSON.stringify(out.json[k])}`);
}

mkdirSync('keeper/.devnet', { recursive: true });
writeFileSync(OUT, JSON.stringify({
  agent: { id: agent.id, name: agent.name, wallet: agent.walletAddress },
  payer: payer.publicKey.toBase58(),
  paidSol: payment.amountSol,
  paymentSignature: sig,
  quoteMint: NVDAX,
  launch: out.json,
  at: new Date().toISOString(),
}, null, 2));
console.log(`\nwrote ${OUT}`);
console.log(`spent  ${(before - await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL} SOL`);
