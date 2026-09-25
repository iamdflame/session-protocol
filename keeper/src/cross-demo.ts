/* ───────────────────────────────────────────────────────────────────────────
   Seed the next bells with the team's own test orders.

   Three test traders (keeper/.devnet/demo-*.json), funded by the operator
   with fixture NVDAx and devnet quote, put a small book into the crosses at
   the next open and the next close, so the sandbox runs whole at real bells
   before anyone else has placed an order:

     the open    alice buys $1,000, bob sells 3 NVDAx: buyers crowded, so the
                 backstop maker fills the difference
     the close   bob sells 4 NVDAx, alice buys $400: sellers crowded; carol
                 buys $250 only if NVDA prints below 90% of its last price,
                 which it will not, so her order comes back whole

   These are team orders on devnet, and the site says so. The keeper does
   everything after this.

     npm run cross:demo            place the orders for the next open and close
   ─────────────────────────────────────────────────────────────────────────── */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, type TransactionInstruction } from '@solana/web3.js';
import { createMintToInstruction, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { bellTs, etDay, type BellKind } from '../../sdk/src/bell.ts';
import { ataOf, decodeMarket, marketRef, orderPda, crossPda, placeOrderIx, TOKEN_PROGRAM } from '../../sdk/src/cross-ix.ts';
import { createAtaIdempotentIx } from '../../sdk/src/ix.ts';
import { parseSecret } from './wallet.ts';

const RPC = process.env.DEVNET_RPC ?? 'https://api.devnet.solana.com';
const DIR = 'keeper/.devnet';
const conn = new Connection(RPC, 'confirmed');
const load = (p: string) => parseSecret(readFileSync(p, 'utf8')).keypair;

function localKey(name: string): Keypair {
  const path = `${DIR}/${name}.json`;
  if (existsSync(path)) return load(path);
  mkdirSync(DIR, { recursive: true });
  const k = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 });
  return k;
}

async function send(signers: Keypair[], ixs: TransactionInstruction[], what: string) {
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: 'confirmed' });
  console.log(`  ok  ${what}  ${sig}`);
}

async function main() {
  const man = JSON.parse(readFileSync('web/public/cross-devnet.json', 'utf8'));
  const market = new PublicKey(man.market);
  const m = marketRef(market, decodeMarket((await conn.getAccountInfo(market))!.data));
  const operator = load(`${DIR}/operator.json`);
  const traders = { alice: localKey('demo-alice'), bob: localKey('demo-bob'), carol: localKey('demo-carol') };

  // fund: SOL for rent and fees, and both tokens
  for (const [name, k] of Object.entries(traders)) {
    if ((await conn.getBalance(k.publicKey)) >= 0.02 * LAMPORTS_PER_SOL) continue;
    await send([operator], [
      SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: k.publicKey, lamports: 0.03 * LAMPORTS_PER_SOL }),
      createAtaIdempotentIx(operator.publicKey, k.publicKey, m.mint, TOKEN_2022_PROGRAM_ID),
      createAtaIdempotentIx(operator.publicKey, k.publicKey, m.quoteMint, TOKEN_PROGRAM),
      createMintToInstruction(m.mint, ataOf(k.publicKey, m.mint, TOKEN_2022_PROGRAM_ID), operator.publicKey, 20n * 100_000_000n, [], TOKEN_2022_PROGRAM_ID),
      createMintToInstruction(m.quoteMint, ataOf(k.publicKey, m.quoteMint, TOKEN_PROGRAM), operator.publicKey, 5_000n * 1_000_000n, [], TOKEN_PROGRAM),
    ], `fund ${name} (${k.publicKey.toBase58()})`);
  }

  // the next open and close still collecting orders
  const now = Math.floor(Date.now() / 1000);
  const freeze = Number(man.params.freezeSecs);
  const next = (kind: BellKind) => {
    for (let d = etDay(now); d < etDay(now) + 10; d++) {
      const t = bellTs(d, kind);
      if (t !== null && t - freeze > now + 60) return d;
    }
    throw new Error(`no ${kind} ahead`);
  };
  const lastPriceE8 = 22_400_000_000n; // a floor for carol's limit, far under any NVDA print
  const book: [keyof typeof traders, BellKind, 'buy' | 'sell', bigint, bigint][] = [
    ['alice', 'open', 'buy', 1_000n * 1_000_000n, 0n],
    ['bob', 'open', 'sell', 3n * 100_000_000n, 0n],
    ['bob', 'close', 'sell', 4n * 100_000_000n, 0n],
    ['alice', 'close', 'buy', 400n * 1_000_000n, 0n],
    ['carol', 'close', 'buy', 250n * 1_000_000n, (lastPriceE8 * 9n) / 10n],
  ];
  for (const [name, kind, side, amount, limitE8] of book) {
    const day = next(kind);
    const owner = traders[name].publicKey;
    const cross = crossPda(market, day, kind);
    if (await conn.getAccountInfo(orderPda(cross, owner, 0))) {
      console.log(`  have ${name}'s ${side} at the ${kind} of day ${day}`);
      continue;
    }
    await send([traders[name]], [placeOrderIx(m, { owner, day, kind, nonce: 0, side, amount, limitE8 })],
      `${name} ${side}s ${side === 'buy' ? `$${Number(amount) / 1e6}` : `${Number(amount) / 1e8} NVDAx`} at the ${kind} of day ${day}${limitE8 ? ` (limit $${Number(limitE8) / 1e8})` : ''}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
