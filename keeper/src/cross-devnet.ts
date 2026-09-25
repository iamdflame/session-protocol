/* ───────────────────────────────────────────────────────────────────────────
   Stand up the cross on devnet.

   session-cross (Crosf1CpgcEs6G6SiX2B7KMR4hxVcE2FGU2r53a3RK9K) is deployed
   with the Solana CLI first. This script does the rest, and only what is
   missing:

     1. a fixture NVDAx: devnet has no xStocks, so a Token-2022 mint shaped
        like the real one, with the scaled-UI multiplier (set to NVDAx's own),
        the pause switch, the permanent delegate and on-chain metadata. The
        operator is its issuer, so the site's faucet can hand it out and the
        issuer drills can be run for real;
     2. the cross config, its admin the programs' upgrade authority;
     3. an NVDA market: that fixture against v1's devnet quote token, priced
        by session-bell's NVDA listing. The listing records the real NVDAx,
        so the market is a sandbox: `accept_simulated` is on, and on
        mainnet a market prices the listing's own mint;
     4. the backstop maker (keeper/.devnet/bell-maker.json), funded with
        fixture NVDAx and quote, whose standing offer caps the imbalance fee;
     5. web/public/cross-devnet.json for the site and the keeper.

     npm run cross:devnet             report what exists and what is missing
     npm run cross:devnet -- --apply  do the missing steps
   ─────────────────────────────────────────────────────────────────────────── */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  createInitializeMetadataPointerInstruction, createInitializeMint2Instruction, createInitializePausableConfigInstruction,
  createInitializePermanentDelegateInstruction, createInitializeScaledUiAmountConfigInstruction, createMintToInstruction,
  ExtensionType, getMintLen, LENGTH_SIZE, TOKEN_2022_PROGRAM_ID, TYPE_SIZE,
} from '@solana/spl-token';
import { createInitializeInstruction, pack, type TokenMetadata } from '@solana/spl-token-metadata';
import { listingPda } from '../../sdk/src/bell.ts';
import {
  ataOf, CROSS_PROGRAM_ID, createMarketIx, crossConfigPda, decodeMarket, initCrossConfigIx, marketPda,
  quoteEscrowPda, rawEscrowPda, TOKEN_PROGRAM, type MarketParams,
} from '../../sdk/src/cross-ix.ts';
import { createAtaIdempotentIx } from '../../sdk/src/ix.ts';
import { parseSecret } from './wallet.ts';

const RPC = process.env.DEVNET_RPC ?? 'https://api.devnet.solana.com';
const DIR = 'keeper/.devnet';
const MANIFEST = 'web/public/cross-devnet.json';

/** NVDAx's own multiplier since 10 Sep 2026, read from the mainnet mint. */
const NVDAX_MULTIPLIER = 1.001701196801074;

export const DEVNET_MARKET_PARAMS: MarketParams = {
  freezeSecs: 120,
  auctionSecs: 120,
  cancelAfterSecs: 21_600,
  maxFeeBps: 100,
  minOrderQuote: 1_000_000n, // $1
  minOrderRaw: 1_000_000n, // 0.01 NVDAx
  maxSideQuote: 100_000_000_000n, // $100,000 a side
  maxSideRaw: 50_000_000_000n, // 500 NVDAx a side
  rrToleranceBps: 1,
  multiplierGuardSecs: 900,
  acceptSimulated: true,
};

/** The backstop maker's standing offer. */
export const BACKSTOP = { feeBps: 15, maxRaw: 100n * 100_000_000n, maxQuote: 25_000n * 1_000_000n };

const load = (path: string): Keypair => parseSecret(readFileSync(path, 'utf8')).keypair;

function localKey(name: string): Keypair {
  const path = `${DIR}/${name}.json`;
  if (existsSync(path)) return load(path);
  mkdirSync(DIR, { recursive: true });
  const k = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 });
  console.log(`  created ${path} (${k.publicKey.toBase58()})`);
  return k;
}

async function send(conn: Connection, signers: Keypair[], ixs: TransactionInstruction[], what: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: 'confirmed' });
      console.log(`  ok    ${what}  ${sig}`);
      return sig;
    } catch (e) {
      if (attempt >= 4) throw e;
      console.log(`  retry ${what} (${String(e).slice(0, 120)})`);
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
    }
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const conn = new Connection(RPC, 'confirmed');
  const admin = load(process.env.DEPLOY_KEYPAIR ?? `${homedir()}/.config/solana/id.json`);
  const operator = load(`${DIR}/operator.json`);
  const maker = localKey('bell-maker');
  const fixture = localKey('cross-nvdax-mint');
  const v1 = JSON.parse(readFileSync('web/public/devnet.json', 'utf8')) as { quoteMint: string; tokenProgram: string };
  const quoteMint = new PublicKey(v1.quoteMint);
  const listing = listingPda('NVDA')[0];
  const market = marketPda(fixture.publicKey);

  console.log(`admin     ${admin.publicKey.toBase58()}  ${(await conn.getBalance(admin.publicKey)) / LAMPORTS_PER_SOL} SOL`);
  console.log(`operator  ${operator.publicKey.toBase58()}  ${(await conn.getBalance(operator.publicKey)) / LAMPORTS_PER_SOL} SOL`);
  console.log(`program   ${CROSS_PROGRAM_ID.toBase58()}`);
  console.log(`fixture   ${fixture.publicKey.toBase58()} (NVDAx-shaped, Token-2022)`);
  console.log(`quote     ${quoteMint.toBase58()} (v1's devnet quote)`);
  console.log(`market    ${market.toBase58()}`);
  if (!apply) console.log('\n(report only: pass --apply to do the missing steps)\n');

  const prog = await conn.getAccountInfo(CROSS_PROGRAM_ID);
  if (!prog?.executable) {
    console.log(`  todo  deploy session-cross: solana program deploy target/deploy/session_cross.so --program-id target/deploy/session_cross-keypair.json --url devnet (≈3.4 SOL)`);
    if (apply) throw new Error('session-cross is not deployed');
  }

  // 1. the fixture NVDAx
  if (!(await conn.getAccountInfo(fixture.publicKey))) {
    console.log('  todo  create the fixture NVDAx');
    if (apply) {
      const extensions = [ExtensionType.MetadataPointer, ExtensionType.ScaledUiAmountConfig, ExtensionType.PausableConfig, ExtensionType.PermanentDelegate];
      const mintLen = getMintLen(extensions);
      const metadata: TokenMetadata = {
        mint: fixture.publicKey,
        name: 'NVDAx (SESSION devnet fixture)',
        symbol: 'NVDAx',
        uri: '',
        additionalMetadata: [['shaped-like', 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh']],
      };
      const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
      const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + metadataLen);
      await send(conn, [operator, fixture], [
        SystemProgram.createAccount({ fromPubkey: operator.publicKey, newAccountPubkey: fixture.publicKey, space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID }),
        createInitializeMetadataPointerInstruction(fixture.publicKey, operator.publicKey, fixture.publicKey, TOKEN_2022_PROGRAM_ID),
        createInitializeScaledUiAmountConfigInstruction(fixture.publicKey, operator.publicKey, NVDAX_MULTIPLIER, TOKEN_2022_PROGRAM_ID),
        createInitializePausableConfigInstruction(fixture.publicKey, operator.publicKey, TOKEN_2022_PROGRAM_ID),
        createInitializePermanentDelegateInstruction(fixture.publicKey, operator.publicKey, TOKEN_2022_PROGRAM_ID),
        createInitializeMint2Instruction(fixture.publicKey, 8, operator.publicKey, operator.publicKey, TOKEN_2022_PROGRAM_ID),
        createInitializeInstruction({
          programId: TOKEN_2022_PROGRAM_ID, mint: fixture.publicKey, metadata: fixture.publicKey,
          mintAuthority: operator.publicKey, updateAuthority: operator.publicKey,
          name: metadata.name, symbol: metadata.symbol, uri: metadata.uri,
        }),
      ], 'create the fixture NVDAx');
    }
  } else {
    console.log('  have  fixture NVDAx');
  }

  // 2. the config
  const config = crossConfigPda();
  if (!(await conn.getAccountInfo(config))) {
    console.log('  todo  create the cross config');
    if (apply) await send(conn, [admin], [initCrossConfigIx({ admin: admin.publicKey, treasury: operator.publicKey })], 'cross config');
  } else {
    console.log('  have  cross config');
  }

  // 3. the market
  let marketInfo = await conn.getAccountInfo(market);
  if (!marketInfo) {
    console.log('  todo  create the NVDA market');
    if (apply) {
      await send(conn, [admin], [createMarketIx({
        admin: admin.publicKey, listing, mint: fixture.publicKey, quoteMint,
        mintProgram: TOKEN_2022_PROGRAM_ID, quoteProgram: new PublicKey(v1.tokenProgram), params: DEVNET_MARKET_PARAMS,
      })], 'create the NVDA market');
      marketInfo = await conn.getAccountInfo(market);
    }
  }
  if (marketInfo) {
    const m = decodeMarket(marketInfo.data);
    console.log(`  have  market: ${m.crosses} cross(es), ${m.orders} order(s), active ${m.active}`);
  }

  // 4. the backstop maker: SOL for fees and rent, and inventory on both sides
  const makerRaw = ataOf(maker.publicKey, fixture.publicKey, TOKEN_2022_PROGRAM_ID);
  const makerQuote = ataOf(maker.publicKey, quoteMint, TOKEN_PROGRAM);
  const rawHeld = await conn.getTokenAccountBalance(makerRaw).then((r) => BigInt(r.value.amount)).catch(() => 0n);
  if (rawHeld < BACKSTOP.maxRaw) {
    console.log('  todo  fund the backstop maker');
    if (apply) {
      await send(conn, [operator], [
        SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: maker.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
        createAtaIdempotentIx(operator.publicKey, maker.publicKey, fixture.publicKey, TOKEN_2022_PROGRAM_ID),
        createAtaIdempotentIx(operator.publicKey, maker.publicKey, quoteMint, TOKEN_PROGRAM),
        createMintToInstruction(fixture.publicKey, makerRaw, operator.publicKey, BACKSTOP.maxRaw * 5n, [], TOKEN_2022_PROGRAM_ID),
        createMintToInstruction(quoteMint, makerQuote, operator.publicKey, BACKSTOP.maxQuote * 5n, [], TOKEN_PROGRAM),
      ], 'fund the backstop maker');
    }
  } else {
    console.log(`  have  backstop maker ${maker.publicKey.toBase58()}`);
  }

  if (apply) {
    const manifest = {
      note: 'Written by `npm run cross:devnet -- --apply`. A sandbox: a fixture NVDAx priced by the devnet bell\'s simulated prints.',
      cluster: 'devnet',
      program: CROSS_PROGRAM_ID.toBase58(),
      config: config.toBase58(),
      market: market.toBase58(),
      listing: listing.toBase58(),
      symbol: 'NVDA',
      mint: fixture.publicKey.toBase58(),
      mintProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
      mintDecimals: 8,
      realMint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh',
      quoteMint: quoteMint.toBase58(),
      quoteProgram: v1.tokenProgram,
      quoteDecimals: 6,
      rawEscrow: rawEscrowPda(market).toBase58(),
      quoteEscrow: quoteEscrowPda(market).toBase58(),
      treasury: operator.publicKey.toBase58(),
      maker: maker.publicKey.toBase58(),
      // the key the keeper cranks with: a receipt shows a counterfactual only from it
      keeper: load(process.env.CROSS_CRANKER_KEYPAIR ?? `${DIR}/bell-poster.json`).publicKey.toBase58(),
      backstop: { feeBps: BACKSTOP.feeBps, maxRaw: BACKSTOP.maxRaw.toString(), maxQuote: BACKSTOP.maxQuote.toString() },
      params: Object.fromEntries(Object.entries(DEVNET_MARKET_PARAMS).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])),
      writtenAt: new Date().toISOString(),
    };
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`  wrote ${MANIFEST}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
