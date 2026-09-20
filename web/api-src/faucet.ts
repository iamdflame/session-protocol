/* ───────────────────────────────────────────────────────────────────────────
   POST /api/faucet { wallet } — test quote for a devnet wallet.

   Mints 10,000 of the devnet quote token (the USDC stand-in) to the wallet's
   token account, creating the account if needed, and drips a little SOL for
   fees if the wallet has almost none. Refuses a wallet that already holds
   plenty, because a faucet is for getting started, not for farming a token
   that is worth nothing.
   ─────────────────────────────────────────────────────────────────────────── */
import {
  PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { ata, createAtaIdempotentIx, TOKEN_PROGRAM_ID } from '../../sdk/src/ix.ts';
import { connection, json, loadManifest, operator, nodeHandler } from './_shared.ts';

const AMOUNT = 10_000n * 10n ** 6n;          // 10,000.000000
const CAP = 50_000n * 10n ** 6n;             // stop at 50,000 held
const SOL_DRIP = 0.02 * LAMPORTS_PER_SOL;
const SOL_FLOOR = 0.01 * LAMPORTS_PER_SOL;

/** SPL Token `MintTo`: instruction 7, then the amount as a little-endian u64. */
function mintToIx(mint: PublicKey, dest: PublicKey, authority: PublicKey, amount: bigint): TransactionInstruction {
  const data = new Uint8Array(9);
  data[0] = 7;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: data as Buffer,
  });
}

async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return json(null, 204, { 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' });
  if (req.method !== 'POST') return json({ error: 'POST { wallet }' }, 405);

  let wallet: PublicKey;
  try {
    const body = await req.json() as { wallet?: string };
    wallet = new PublicKey(String(body.wallet ?? ''));
  } catch {
    return json({ error: 'wallet must be a valid public key' }, 400);
  }

  try {
    const m = loadManifest();
    const conn = connection(m);
    const op = operator();
    const quoteMint = new PublicKey(m.quoteMint);
    const dest = ata(wallet, quoteMint);

    const held = await conn.getTokenAccountBalance(dest).then(r => BigInt(r.value.amount)).catch(() => 0n);
    if (held >= CAP) {
      return json({ error: `this wallet already holds ${(Number(held) / 1e6).toLocaleString()} test quote` }, 429);
    }

    const tx = new Transaction().add(
      createAtaIdempotentIx(op.publicKey, wallet, quoteMint),
      mintToIx(quoteMint, dest, op.publicKey, AMOUNT),
    );
    const sol = await conn.getBalance(wallet);
    const dripped = sol < SOL_FLOOR;
    if (dripped) {
      tx.add(SystemProgram.transfer({ fromPubkey: op.publicKey, toPubkey: wallet, lamports: SOL_DRIP }));
    }

    const signature = await sendAndConfirmTransaction(conn, tx, [op], { commitment: 'confirmed' });
    return json({ signature, amount: AMOUNT.toString(), solDripped: dripped, quoteMint: m.quoteMint });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

export default nodeHandler(handler);
