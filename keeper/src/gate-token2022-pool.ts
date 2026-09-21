/* ───────────────────────────────────────────────────────────────────────────
   The gate before the share classes move to Token-2022.

   Making NIGHT and DAY Token-2022 mints buys on-chain metadata — an explorer
   and a wallet show `NVDA.DAY`, not a base58 address. It costs whatever
   Token-2022 support the venues lack. The one that matters is Meteora: if a
   share class cannot back a DAMM v2 pool, then DAY is not sellable while it
   is exposed, and the whole point of Phase B is gone.

   So: mint a Token-2022 token with a metadata pointer and metadata, exactly
   as `initialize_vault` would, pair it with a classic-SPL quote, and open a
   real pool on devnet. If Meteora refuses — a token badge it will not issue,
   an unsupported extension — this prints what it refused and the program
   keeps classic share mints.

     node --experimental-strip-types keeper/src/gate-token2022-pool.ts
   ─────────────────────────────────────────────────────────────────────────── */

import { readFileSync } from 'node:fs';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ExtensionType, getMintLen,
  createInitializeMint2Instruction, createInitializeMetadataPointerInstruction,
  createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction,
  getAssociatedTokenAddressSync, getMint, getTokenMetadata,
} from '@solana/spl-token';
import { createInitializeInstruction, pack, type TokenMetadata } from '@solana/spl-token-metadata';
import {
  CpAmm, getSqrtPriceFromPrice, getBaseFeeParams, getDynamicFeeParams, BaseFeeMode,
  MIN_SQRT_PRICE, MAX_SQRT_PRICE,
} from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';

const RPC = process.env.RPC ?? 'https://api.devnet.solana.com';
const conn = new Connection(RPC, 'confirmed');
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('keeper/.devnet/operator.json', 'utf8'))));

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ' — ' + detail}`);
  if (!ok) failed++;
};

console.log(`gate: can a Token-2022 share class back a Meteora pool?`);
console.log(`payer ${payer.publicKey.toBase58()}  ${(await conn.getBalance(payer.publicKey)) / 1e9} SOL\n`);

/* ── 1. the share mint, exactly as initialize_vault would make it ───────── */

const mint = Keypair.generate();
const metadata: TokenMetadata = {
  mint: mint.publicKey,
  name: 'SESSION NVDA.DAY',
  symbol: 'NVDA.DAY',
  uri: 'https://session-roan.vercel.app/meta/NVDA.day.json',
  additionalMetadata: [],
};
// The metadata lives in the mint account itself, so the account must be
// allocated for the pointer plus the packed metadata.
const mintLen = getMintLen([ExtensionType.MetadataPointer]);
const space = mintLen + pack(metadata).length + 4 + 32; // TLV header + slack
const lamports = await conn.getMinimumBalanceForRentExemption(space);

const tx = new Transaction().add(
  SystemProgram.createAccount({
    fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey,
    space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID,
  }),
  createInitializeMetadataPointerInstruction(mint.publicKey, payer.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
  createInitializeMint2Instruction(mint.publicKey, 6, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
  createInitializeInstruction({
    programId: TOKEN_2022_PROGRAM_ID, mint: mint.publicKey, metadata: mint.publicKey,
    name: metadata.name, symbol: metadata.symbol, uri: metadata.uri,
    mintAuthority: payer.publicKey, updateAuthority: payer.publicKey,
  }),
);
await sendAndConfirmTransaction(conn, tx, [payer, mint], { commitment: 'confirmed' });

const info = await getMint(conn, mint.publicKey, 'confirmed', TOKEN_2022_PROGRAM_ID);
const md = await getTokenMetadata(conn, mint.publicKey, 'confirmed', TOKEN_2022_PROGRAM_ID);
check('a Token-2022 share mint with on-chain metadata exists', info.decimals === 6 && md?.symbol === 'NVDA.DAY', md?.symbol);
console.log(`        ${mint.publicKey.toBase58()}  "${md?.name}" (${md?.symbol})`);

/* ── 2. a classic-SPL quote, as USDC is ─────────────────────────────────── */

const m = JSON.parse(readFileSync('keeper/.devnet/manifest.json', 'utf8')) as { quoteMint: string };
const quote = new PublicKey(m.quoteMint);

/* ── 3. fund the payer with both sides ──────────────────────────────────── */

const shareAta = getAssociatedTokenAddressSync(mint.publicKey, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
const quoteAta = getAssociatedTokenAddressSync(quote, payer.publicKey, false, TOKEN_PROGRAM_ID);
const SHARES = 1_000n * 10n ** 6n;
await sendAndConfirmTransaction(conn, new Transaction().add(
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, shareAta, payer.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
  createMintToInstruction(mint.publicKey, shareAta, payer.publicKey, SHARES, [], TOKEN_2022_PROGRAM_ID),
), [payer], { commitment: 'confirmed' });
const quoteBal = await conn.getTokenAccountBalance(quoteAta).then(r => BigInt(r.value.amount)).catch(() => 0n);
check('the payer holds both sides', quoteBal > 0n, `${quoteBal} quote atoms`);

/* ── 4. the pool ────────────────────────────────────────────────────────── */

const cpAmm = new CpAmm(conn);
const positionNft = Keypair.generate();
// NAV starts at parity, so one share is worth one quote atom-for-atom.
const initSqrtPrice = getSqrtPriceFromPrice('1', 6, 6);
// At parity a share is worth a quote atom, so both sides go in equal or the
// implied liquidity asks for more of one than exists.
const SEED = SHARES / 2n;
const tokenAAmount = new BN(SEED.toString());
const tokenBAmount = new BN(SEED.toString());
if (quoteBal < SEED) throw new Error(`payer holds ${quoteBal} quote, needs ${SEED}`);
const { liquidityDelta } = cpAmm.preparePoolCreationParams({
  tokenAAmount, tokenBAmount, minSqrtPrice: MIN_SQRT_PRICE, maxSqrtPrice: MAX_SQRT_PRICE, initSqrtPrice,
});

try {
  const { tx: poolTx, pool } = await cpAmm.createCustomPool({
    payer: payer.publicKey, creator: payer.publicKey, positionNft: positionNft.publicKey,
    tokenAMint: mint.publicKey, tokenBMint: quote,
    tokenAAmount, tokenBAmount,
    sqrtMinPrice: MIN_SQRT_PRICE, sqrtMaxPrice: MAX_SQRT_PRICE, initSqrtPrice, liquidityDelta,
    poolFees: {
      // A flat 30 bp base (a scheduler that starts and ends at the same fee),
      // plus the dynamic fee: the night is where the volatility is, and a
      // volatility-responsive fee is the only session-awareness either venue
      // actually offers.
      baseFee: getBaseFeeParams({
        baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear,
        feeTimeSchedulerParam: { startingFeeBps: 30, endingFeeBps: 30, numberOfPeriod: 0, totalDuration: 0 },
      }),
      compoundingFeeBps: 0,
      padding: 0,
      dynamicFee: getDynamicFeeParams(30),
    },
    hasAlphaVault: false, collectFeeMode: 0, activationPoint: null, activationType: 1,
    tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
    isLockLiquidity: false,
  });
  const sig = await sendAndConfirmTransaction(conn, poolTx, [payer, positionNft], { commitment: 'confirmed', skipPreflight: false });
  check('Meteora opened a DAMM v2 pool with a Token-2022 share class', true);
  console.log(`        pool ${pool.toBase58()}`);
  console.log(`        ${sig}`);
  const state = await cpAmm.fetchPoolState(pool);
  check('the pool prices the share class against the classic quote',
    state.tokenAMint.equals(mint.publicKey) && state.tokenBMint.equals(quote));
} catch (e: unknown) {
  const err = e as { logs?: string[]; message?: string };
  check('Meteora opened a DAMM v2 pool with a Token-2022 share class', false, err.message?.split('\n')[0]);
  for (const l of (err.logs ?? []).filter(l => /Error|failed|badge|Program log/i.test(l)).slice(0, 12)) {
    console.log('        ' + l);
  }
}

console.log(failed
  ? `\n${failed} failed — the share classes stay on the classic SPL program, and the reason is above`
  : '\nGATE PASSED: Token-2022 share classes can be pooled, so they can carry their own names');
process.exit(failed ? 1 : 0);
