/* ───────────────────────────────────────────────────────────────────────────
   POST /api/faucet { wallet, message, signature } — test quote for a devnet
   wallet, to someone who can prove they hold it.

   Mints 10,000 of the devnet quote token (the USDC stand-in) and 10 fixture
   NVDAx (the xStock stand-in bell orders trade) to the wallet's token
   accounts, creating them if needed, and drips a little SOL for fees if the
   wallet has almost none. Each asset has its own cap; a wallet at both caps
   is refused.

   The signature is the point. An unauthenticated faucet takes a public key in
   a JSON body, so anyone can drain the operator's SOL into fresh keypairs at
   0.02 a call, or spray tokens at addresses whose owners never asked. Asking
   the caller to sign a short dated message costs a connected wallet one click
   and makes both pointless: you can only fund a wallet you control, and the
   per-wallet cap then actually caps something.
   ─────────────────────────────────────────────────────────────────────────── */
import {
  PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { ata, createAtaIdempotentIx, TOKEN_PROGRAM_ID } from '../../sdk/src/ix.ts';
import { connection, json, loadManifest, operator, nodeHandler } from './_shared.ts';
// The bell-order sandbox: the fixture NVDAx the operator issues.
import crossManifest from '../public/cross-devnet.json' with { type: 'json' };

const AMOUNT = 10_000n * 10n ** 6n;          // 10,000.000000
const CAP = 50_000n * 10n ** 6n;             // stop at 50,000 held
const NVDAX_AMOUNT = 10n * 10n ** 8n;        // 10 fixture NVDAx, raw
const NVDAX_CAP = 50n * 10n ** 8n;
const SOL_DRIP = 0.02 * LAMPORTS_PER_SOL;
const SOL_FLOOR = 0.01 * LAMPORTS_PER_SOL;
/** How stale a signed request may be. Long enough to sign, short enough that a
    captured message is not a reusable faucet key. */
const MAX_AGE_MS = 5 * 60_000;

/** The message the site asks the wallet to sign. Must match src/lib/chain.ts. */
export const faucetMessage = (wallet: string, ts: number) =>
  `SESSION devnet faucet\nwallet: ${wallet}\nissued: ${ts}`;

/** SPL Token `MintTo`: instruction 7, then the amount as a little-endian u64. */
// MintTo is instruction 7 under both token programs, with the same layout.
function mintToIx(
  mint: PublicKey, dest: PublicKey, authority: PublicKey, amount: bigint, program = TOKEN_PROGRAM_ID,
): TransactionInstruction {
  const data = new Uint8Array(9);
  data[0] = 7;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  return new TransactionInstruction({
    programId: program,
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
  let issued: number;
  let signature: Uint8Array;
  try {
    const body = await req.json() as { wallet?: string; issued?: number; signature?: string };
    wallet = new PublicKey(String(body.wallet ?? ''));
    issued = Number(body.issued);
    signature = bs58.decode(String(body.signature ?? ''));
  } catch {
    return json({ error: 'send { wallet, issued, signature }' }, 400);
  }

  if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > MAX_AGE_MS) {
    return json({ error: 'the signed request has expired; try again' }, 400);
  }
  const expected = new TextEncoder().encode(faucetMessage(wallet.toBase58(), issued));
  if (signature.length !== 64 || !nacl.sign.detached.verify(expected, signature, wallet.toBytes())) {
    return json({ error: 'signature does not prove control of that wallet' }, 401);
  }

  try {
    const m = loadManifest();
    const conn = connection(m);
    const op = operator();
    const quoteMint = new PublicKey(m.quoteMint);
    const quoteProgram = new PublicKey(m.tokenProgram);
    const dest = ata(wallet, quoteMint, quoteProgram);

    const nvdaxMint = new PublicKey(crossManifest.mint);
    const nvdaxProgram = new PublicKey(crossManifest.mintProgram);
    const nvdaxDest = ata(wallet, nvdaxMint, nvdaxProgram);
    const [held, heldNvdax] = await Promise.all([
      conn.getTokenAccountBalance(dest).then(r => BigInt(r.value.amount)).catch(() => 0n),
      conn.getTokenAccountBalance(nvdaxDest).then(r => BigInt(r.value.amount)).catch(() => 0n),
    ]);
    const giveQuote = held < CAP;
    const giveNvdax = heldNvdax < NVDAX_CAP;
    if (!giveQuote && !giveNvdax) {
      return json({ error: `this wallet already holds ${(Number(held) / 1e6).toLocaleString()} test quote and enough fixture NVDAx` }, 429);
    }

    const tx = new Transaction();
    if (giveQuote) {
      tx.add(
        createAtaIdempotentIx(op.publicKey, wallet, quoteMint, quoteProgram),
        mintToIx(quoteMint, dest, op.publicKey, AMOUNT, quoteProgram),
      );
    }
    if (giveNvdax) {
      tx.add(
        createAtaIdempotentIx(op.publicKey, wallet, nvdaxMint, nvdaxProgram),
        mintToIx(nvdaxMint, nvdaxDest, op.publicKey, NVDAX_AMOUNT, nvdaxProgram),
      );
    }
    const sol = await conn.getBalance(wallet);
    const dripped = sol < SOL_FLOOR;
    if (dripped) {
      tx.add(SystemProgram.transfer({ fromPubkey: op.publicKey, toPubkey: wallet, lamports: SOL_DRIP }));
    }

    const signature = await sendAndConfirmTransaction(conn, tx, [op], { commitment: 'confirmed' });
    return json({
      signature,
      amount: (giveQuote ? AMOUNT : 0n).toString(),
      nvdax: (giveNvdax ? NVDAX_AMOUNT : 0n).toString(),
      solDripped: dripped,
      quoteMint: m.quoteMint,
      nvdaxMint: crossManifest.mint,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

export default nodeHandler(handler);
