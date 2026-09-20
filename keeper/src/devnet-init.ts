/* ───────────────────────────────────────────────────────────────────────────
   Stand up a vault on devnet.

   Devnet has the program, the Pyth receiver and the token programs. It does
   not have xStocks, USDC, or a fresh feed for any tokenised equity — Pyth's
   scheduler sponsors a handful of crypto feeds there and nothing else. So:

     underlying  a **Token-2022** mint, 8 decimals, with a permanent delegate —
                 the same shape as the real NVDAx, so the deployment actually
                 exercises the Token-2022 path rather than a classic-SPL toy
     quote       a classic SPL mint, 6 decimals, standing in for USDC
     mark feed   Crypto.SOL/USD — kept fresh on devnet by Pyth
     equity feed Crypto.BTC/USD — kept fresh, so the session detector never
                 trips (it only fires on a feed that has gone *quiet*)

   Everything else — the vault, the two share classes, settlement, funding,
   the handoff, the health signals — is the real program doing the real thing.
   The site says exactly this on the vault page.

   One keypair (the "operator") is mint authority for both test tokens, the
   faucet's signer, and the crank/fill signer. It is written to
   keeper/.devnet/operator.json (gitignored) and its secret goes into the
   serverless functions' environment. It is never the deploy wallet.

   Run once: npm run devnet:init
   ─────────────────────────────────────────────────────────────────────────── */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  createInitializeMint2Instruction, createMintToInstruction, MINT_SIZE,
  getMinimumBalanceForRentExemptMint, createInitializePermanentDelegateInstruction,
  getMintLen, ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID as SPL_TOKEN,
} from '@solana/spl-token';
import { PROGRAM_ID, vaultPda, nightMintPda, dayMintPda, underlyingVaultPda, quoteVaultPda, decodeVault } from '../../sdk/src/vault.ts';
import {
  initializeVaultIx, createAtaIdempotentIx, ata, pythFeedAccount, hexToBytes, TOKEN_PROGRAM_ID,
  type VaultParams,
} from '../../sdk/src/ix.ts';

const RPC = process.env.DEVNET_RPC ?? 'https://api.devnet.solana.com';
const OUT_DIR = 'keeper/.devnet';
const MANIFEST = 'web/public/devnet.json';

/** Pyth feed ids. Only the first two are sponsored on devnet. */
const FEEDS = {
  'Crypto.SOL/USD':     'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  'Crypto.BTC/USD':     'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  'Crypto.NVDAX/USD':   '4244d07890e4610f46bbde67de8f43a4bf8b569eebe904f136b469f148503b7f',
  'Equity.US.NVDA/USD': 'b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593',
};

/**
 * Devnet parameters. Two differ from the mainnet defaults and both are about
 * the oracle cadence there: Pyth refreshes the sponsored devnet feeds every
 * few minutes rather than every second, so a 120s staleness window would
 * refuse most settlements for no reason.
 */
const PARAMS: VaultParams = {
  markFeedId: hexToBytes(FEEDS['Crypto.SOL/USD']),
  equityFeedId: hexToBytes(FEEDS['Crypto.BTC/USD']),
  fundingKBps: 2_500,
  fundingMaxBps: 50,
  maxStaleSecs: 900,            // mainnet: 120
  maxConfBps: 500,
  maxMoveBps: 5_000,
  equityQuietSecs: 3_600,
  fillIncentiveBps: 10,
  maxCarryDeltaBps: 500,
  maxUnexpectedClosedSecs: 3 * 3_600,
  maxPostedSlotAge: 4_500, maxBellLeadSecs: 300, maxPremiumBps: 1_000, auctionSecs: 120,
  incentiveRamp: [10, 25, 50], requireVerifiedRecap: false,
};

const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const deployer = load(`${homedir()}/.config/solana/id.json`);
  mkdirSync(OUT_DIR, { recursive: true });

  /* ── operator keypair ──────────────────────────────────────────────── */
  const opPath = `${OUT_DIR}/operator.json`;
  const operator = existsSync(opPath) ? load(opPath) : Keypair.generate();
  if (!existsSync(opPath)) writeFileSync(opPath, JSON.stringify([...operator.secretKey]));
  console.log(`operator     ${operator.publicKey.toBase58()}`);

  const opBal = await conn.getBalance(operator.publicKey);
  if (opBal < 0.4 * LAMPORTS_PER_SOL) {
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: deployer.publicKey, toPubkey: operator.publicKey,
      lamports: Math.round(0.6 * LAMPORTS_PER_SOL) - opBal,
    }));
    await sendAndConfirmTransaction(conn, tx, [deployer]);
    console.log(`funded       operator to 0.6 SOL`);
  }

  /* ── test mints ────────────────────────────────────────────────────── */
  const mintPath = `${OUT_DIR}/mints.json`;
  let mints: { underlying: string; quote: string };
  if (existsSync(mintPath)) {
    mints = JSON.parse(readFileSync(mintPath, 'utf8'));
  } else {
    const underlying = Keypair.generate();
    const quote = Keypair.generate();

    // The underlying is Token-2022 with a permanent delegate, because that is
    // what a real xStock is. A classic-SPL stand-in would let the whole
    // Token-2022 path go untested and the first mainnet vault would be the
    // first time it ran.
    const uLen = getMintLen([ExtensionType.PermanentDelegate]);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: operator.publicKey, newAccountPubkey: underlying.publicKey,
        space: uLen, lamports: await conn.getMinimumBalanceForRentExemption(uLen),
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializePermanentDelegateInstruction(
        underlying.publicKey, operator.publicKey, TOKEN_2022_PROGRAM_ID,
      ),
      createInitializeMint2Instruction(
        underlying.publicKey, 8, operator.publicKey, null, TOKEN_2022_PROGRAM_ID,
      ),
    );

    // Quote is classic SPL, like USDC.
    const rent = await getMinimumBalanceForRentExemptMint(conn);
    tx.add(
      SystemProgram.createAccount({
        fromPubkey: operator.publicKey, newAccountPubkey: quote.publicKey,
        space: MINT_SIZE, lamports: rent, programId: SPL_TOKEN,
      }),
      createInitializeMint2Instruction(quote.publicKey, 6, operator.publicKey, null, SPL_TOKEN),
    );

    await sendAndConfirmTransaction(conn, tx, [operator, underlying, quote]);
    mints = { underlying: underlying.publicKey.toBase58(), quote: quote.publicKey.toBase58() };
    writeFileSync(mintPath, JSON.stringify(mints, null, 2));
  }
  const underlyingMint = new PublicKey(mints.underlying);
  const quoteMint = new PublicKey(mints.quote);
  console.log(`underlying   ${underlyingMint.toBase58()}  (Token-2022, 8 dp, permanent delegate — NVDAx's shape)`);
  console.log(`quote        ${quoteMint.toBase58()}  (SPL, 6 dp — USDC's shape)`);

  /* ── feeds ─────────────────────────────────────────────────────────── */
  const markUpdate = pythFeedAccount(PARAMS.markFeedId);
  const equityUpdate = pythFeedAccount(PARAMS.equityFeedId);
  for (const [name, acc] of [['mark  SOL/USD', markUpdate], ['equity BTC/USD', equityUpdate]] as const) {
    const info = await conn.getAccountInfo(acc);
    if (!info) throw new Error(`${name} feed account ${acc.toBase58()} is missing on devnet`);
    console.log(`${name.padEnd(14)} ${acc.toBase58()}`);
  }

  /* ── the vault ─────────────────────────────────────────────────────── */
  const [vault] = vaultPda(underlyingMint, quoteMint);
  const [nightMint] = nightMintPda(vault);
  const [dayMint] = dayMintPda(vault);
  const [underlyingVault] = underlyingVaultPda(vault);
  const [quoteVault] = quoteVaultPda(vault);

  const existing = await conn.getAccountInfo(vault);
  if (existing) {
    console.log(`vault        ${vault.toBase58()}  (already initialised)`);
  } else {
    const ix = initializeVaultIx({
      authority: deployer.publicKey, vault, underlyingMint, quoteMint,
      nightMint, dayMint, underlyingVault, quoteVault,
      markPriceUpdate: markUpdate, equityPriceUpdate: equityUpdate,
      underlyingTokenProgram: TOKEN_2022_PROGRAM_ID,
      quoteTokenProgram: SPL_TOKEN,
    }, PARAMS, 'NVDA');
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [deployer]);
    console.log(`vault        ${vault.toBase58()}  initialised in ${sig}`);
  }

  const v = decodeVault((await conn.getAccountInfo(vault))!.data);
  console.log(`             exposed=${v.exposed}  mark=${v.lastMark}  nav=${v.nightNav}/${v.dayNav}`);

  /* ── operator inventory, for fills and the faucet ─────────────────── */
  const opUnderlying = ata(operator.publicKey, underlyingMint, TOKEN_2022_PROGRAM_ID);
  const opQuote = ata(operator.publicKey, quoteMint, SPL_TOKEN);
  const tx = new Transaction().add(
    createAtaIdempotentIx(operator.publicKey, operator.publicKey, underlyingMint, TOKEN_2022_PROGRAM_ID),
    createAtaIdempotentIx(operator.publicKey, operator.publicKey, quoteMint, SPL_TOKEN),
  );
  const bal = await conn.getTokenAccountBalance(opUnderlying).catch(() => null);
  if (!bal || Number(bal.value.amount) < 1_000_000n * 10n ** 8n / 2n) {
    tx.add(
      createMintToInstruction(underlyingMint, opUnderlying, operator.publicKey, 1_000_000n * 10n ** 8n, [], TOKEN_2022_PROGRAM_ID),
      createMintToInstruction(quoteMint, opQuote, operator.publicKey, 100_000_000n * 10n ** 6n, [], SPL_TOKEN),
    );
  }
  await sendAndConfirmTransaction(conn, tx, [operator]);
  console.log(`inventory    1,000,000 underlying + 100,000,000 quote to the operator`);

  /* ── manifest the site and the crank read ─────────────────────────── */
  const manifest = {
    cluster: 'devnet',
    rpc: RPC,
    programId: PROGRAM_ID.toBase58(),
    symbol: 'NVDAx',
    note: 'Devnet stand-in. The underlying is a Token-2022 mint with a permanent delegate — the same shape as the real NVDAx — and the quote is a classic SPL mint like USDC. The mark is Pyth SOL/USD because no tokenised-equity feed is sponsored on devnet.',
    vault: vault.toBase58(),
    underlyingMint: underlyingMint.toBase58(),
    quoteMint: quoteMint.toBase58(),
    nightMint: nightMint.toBase58(),
    dayMint: dayMint.toBase58(),
    underlyingVault: underlyingVault.toBase58(),
    quoteVault: quoteVault.toBase58(),
    markPriceUpdate: markUpdate.toBase58(),
    equityPriceUpdate: equityUpdate.toBase58(),
    markFeed: 'Crypto.SOL/USD',
    equityFeed: 'Crypto.BTC/USD',
    operator: operator.publicKey.toBase58(),
    tokenProgram: SPL_TOKEN.toBase58(),
    underlyingTokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
    params: { ...PARAMS, markFeedId: FEEDS['Crypto.SOL/USD'], equityFeedId: FEEDS['Crypto.BTC/USD'] },
    initialised: new Date().toISOString(),
  };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  writeFileSync(`${OUT_DIR}/manifest.json`, JSON.stringify(manifest, null, 2));
  console.log(`\nwrote ${MANIFEST}`);
}

main().catch(e => { console.error(e); process.exit(1); });
