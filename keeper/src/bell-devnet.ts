/* ───────────────────────────────────────────────────────────────────────────
   Stand up the bell on devnet.

   Two programs, deployed with the Solana CLI before this runs:

     session-bell   BeLLKXJwhSH6YXYQLc8xLd11GxJUvoaT1h9zCadymJv4
     the verifier   CVuKQFLc1PAuJ8y7kPckw8Hi8W6WhdeWrhM9UBVdm2qs — Pyth's own
                    Lazer program built under a devnet id (tools/lazer-devnet),
                    because Pyth's instance trusts only Pyth's signers and
                    there is no Pyth Pro key yet

   This script does the rest, and only what is missing:

     1. initialise the verifier's storage, with the deploy wallet as its
        authority and a dedicated account as its fee treasury;
     2. trust the test signer (keeper/.devnet/bell-signer.json) for a year;
     3. create the bell config, pointing at that verifier — which the program
        marks `simulated`, permanently, because it is not Pyth's id;
     4. register NVDA, SPY, TSLA, AAPL and QQQ with their Pyth Pro feed ids;
     5. fund the poster (keeper/.devnet/bell-poster.json);
     6. write web/public/bell-devnet.json, which the site reads.

   The config's parameters are method v1 with two windows widened. The
   simulated source is Jupiter's reference price for each share, which it
   refreshes every one to two minutes; a ten-second close window would make
   nearly every simulated close honestly Missing. The windows are on the
   config, on chain, and on the /oracle page. A Pyth Pro deployment runs v1 as
   written.

     npm run bell:devnet             report what exists and what is missing
     npm run bell:devnet -- --apply  do the missing steps
   ─────────────────────────────────────────────────────────────────────────── */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  BELL_PROGRAM_ID, bellConfigPda, decodeBellConfig, decodeLazerStorage, decodeListing, initConfigIx,
  lazerInitializeIx, lazerUpdateIx, listingPda, PARAMS_V1, registerListingIx, verifierStoragePda,
  type BellParams, type ListingFeeds,
} from '../../sdk/src/bell.ts';
import { parseSecret } from './wallet.ts';

const RPC = process.env.DEVNET_RPC ?? 'https://api.devnet.solana.com';
const DIR = 'keeper/.devnet';
const MANIFEST = 'web/public/bell-devnet.json';
export const DEVNET_VERIFIER = new PublicKey('CVuKQFLc1PAuJ8y7kPckw8Hi8W6WhdeWrhM9UBVdm2qs');

/** v1, with the two windows the simulated source needs. */
export const DEVNET_PARAMS: BellParams = { ...PARAMS_V1, closeLeadSecs: 180, openWindowSecs: 300 };

/** Pyth Pro feed ids, from Pyth's published symbol list (24 Sep 2026). */
export const LISTINGS: { symbol: string; feeds: ListingFeeds; mint: string; names: Record<string, string> }[] = [
  {
    symbol: 'NVDA', feeds: { equity: 1314, rr: 1832, token: 1833, index: 3188 },
    mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh',
    names: { equity: 'Equity.US.NVDA/USD', rr: 'Crypto.NVDAX/NVDA.RR', token: 'Crypto.NVDAX/USD', index: 'Equity.Index.NVDA/USD' },
  },
  {
    symbol: 'SPY', feeds: { equity: 1398, rr: 1842, token: 1843 },
    mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W',
    names: { equity: 'Equity.US.SPY/USD', rr: 'Crypto.SPYX/SPY.RR', token: 'Crypto.SPYX/USD' },
  },
  {
    symbol: 'TSLA', feeds: { equity: 1435, rr: 1846, token: 1847, index: 3185 },
    mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB',
    names: { equity: 'Equity.US.TSLA/USD', rr: 'Crypto.TSLAX/TSLA.RR', token: 'Crypto.TSLAX/USD', index: 'Equity.Index.TSLA/USD' },
  },
  {
    symbol: 'AAPL', feeds: { equity: 922, rr: 1791, token: 1792, index: 3191 },
    mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp',
    names: { equity: 'Equity.US.AAPL/USD', rr: 'Crypto.AAPLX/AAPL.RR', token: 'Crypto.AAPLX/USD', index: 'Equity.Index.AAPL/USD' },
  },
  {
    symbol: 'QQQ', feeds: { equity: 1363, rr: 1836, token: 1837 },
    mint: 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ',
    names: { equity: 'Equity.US.QQQ/USD', rr: 'Crypto.QQQX/QQQ.RR', token: 'Crypto.QQQX/USD' },
  },
];

const load = (path: string): Keypair => parseSecret(readFileSync(path, 'utf8')).keypair;

/** A keypair file under keeper/.devnet, created on first use. */
function localKey(name: string): Keypair {
  const path = `${DIR}/${name}.json`;
  if (existsSync(path)) return load(path);
  mkdirSync(DIR, { recursive: true });
  const k = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 });
  console.log(`  created ${path} (${k.publicKey.toBase58()})`);
  return k;
}

async function send(conn: Connection, payer: Keypair, ixs: TransactionInstruction[], what: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [payer], { commitment: 'confirmed' });
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
  const signer = localKey('bell-signer');
  const treasury = localKey('lazer-treasury');
  const poster = localKey('bell-poster');
  const storage = verifierStoragePda(DEVNET_VERIFIER);
  const [config] = bellConfigPda();

  console.log(`admin (upgrade authority)  ${admin.publicKey.toBase58()}  ${(await conn.getBalance(admin.publicKey)) / LAMPORTS_PER_SOL} SOL`);
  console.log(`test signer                ${signer.publicKey.toBase58()}`);
  console.log(`verifier                   ${DEVNET_VERIFIER.toBase58()}  storage ${storage.toBase58()}`);
  console.log(`bell                       ${BELL_PROGRAM_ID.toBase58()}  config ${config.toBase58()}`);
  if (!apply) console.log('\n(report only: pass --apply to do the missing steps)\n');

  for (const [name, id] of [['session-bell', BELL_PROGRAM_ID], ['verifier', DEVNET_VERIFIER]] as const) {
    const a = await conn.getAccountInfo(id);
    if (!a?.executable) throw new Error(`${name} is not deployed at ${id.toBase58()}: see tools/lazer-devnet/README.md`);
  }

  // 1. the verifier's storage, and its treasury funded to rent exemption
  const rentFloor = await conn.getMinimumBalanceForRentExemption(0);
  if ((await conn.getBalance(treasury.publicKey)) < rentFloor) {
    console.log(`  todo  fund the verifier's treasury to ${rentFloor} lamports`);
    if (apply) await send(conn, admin, [SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: treasury.publicKey, lamports: rentFloor })], 'fund treasury');
  }
  let st = await conn.getAccountInfo(storage);
  if (!st) {
    console.log('  todo  initialise the verifier');
    if (apply) {
      await send(conn, admin, [lazerInitializeIx({ verifier: DEVNET_VERIFIER, payer: admin.publicKey, topAuthority: admin.publicKey, treasury: treasury.publicKey })], 'initialise verifier');
      st = await conn.getAccountInfo(storage);
    }
  }

  // 2. trust the test signer
  if (st) {
    const s = decodeLazerStorage(st.data);
    if (!s.treasury.equals(treasury.publicKey)) throw new Error(`verifier treasury is ${s.treasury.toBase58()}, not ours`);
    const now = Math.floor(Date.now() / 1000);
    const trusted = s.trustedSigners.find((t) => t.key.equals(signer.publicKey));
    if (!trusted || trusted.expiresAt < now + 30 * 86_400) {
      console.log('  todo  trust the test signer for a year');
      if (apply) await send(conn, admin, [lazerUpdateIx({ verifier: DEVNET_VERIFIER, topAuthority: admin.publicKey, signer: signer.publicKey, expiresAt: now + 365 * 86_400 })], 'trust test signer');
    } else {
      console.log(`  have  test signer trusted until ${new Date(trusted.expiresAt * 1000).toISOString()}`);
    }
  }

  // 3. the config
  let cfgInfo = await conn.getAccountInfo(config);
  if (!cfgInfo) {
    console.log('  todo  create the bell config');
    if (apply) {
      await send(conn, admin, [initConfigIx({ admin: admin.publicKey, verifier: DEVNET_VERIFIER, params: DEVNET_PARAMS })], 'init config');
      cfgInfo = await conn.getAccountInfo(config);
    }
  }
  if (cfgInfo) {
    const c = decodeBellConfig(cfgInfo.data);
    console.log(`  have  config: verifier ${c.verifier.toBase58()}, simulated ${c.simulated}, ${c.listings} listing(s)`);
  }

  // 4. the listings
  for (const l of LISTINGS) {
    const [addr] = listingPda(l.symbol);
    const info = await conn.getAccountInfo(addr);
    if (info) {
      const d = decodeListing(info.data);
      console.log(`  have  ${l.symbol.padEnd(5)} ${addr.toBase58()} active ${d.active}, ${d.prints} print(s)`);
      continue;
    }
    console.log(`  todo  register ${l.symbol}`);
    if (apply && cfgInfo) {
      await send(conn, admin, [registerListingIx({ admin: admin.publicKey, symbol: l.symbol, feeds: l.feeds, mint: new PublicKey(l.mint) })], `register ${l.symbol}`);
    }
  }

  // 5. the poster pays each print's rent and its transaction fees
  const posterBalance = await conn.getBalance(poster.publicKey);
  if (posterBalance < 0.1 * LAMPORTS_PER_SOL) {
    console.log(`  todo  fund the poster (${posterBalance / LAMPORTS_PER_SOL} SOL)`);
    if (apply) await send(conn, admin, [SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: poster.publicKey, lamports: 0.3 * LAMPORTS_PER_SOL })], 'fund poster');
  } else {
    console.log(`  have  poster ${poster.publicKey.toBase58()} with ${posterBalance / LAMPORTS_PER_SOL} SOL`);
  }

  // 6. the manifest the site reads
  if (apply) {
    const manifest = {
      note: 'Written by `npm run bell:devnet -- --apply`. The devnet bell: a test signer, not Pyth\'s.',
      cluster: 'devnet',
      program: BELL_PROGRAM_ID.toBase58(),
      config: config.toBase58(),
      verifier: DEVNET_VERIFIER.toBase58(),
      verifierSource: 'pyth-lazer-solana-contract 0.8.0, built under a devnet id (tools/lazer-devnet)',
      verifierStorage: storage.toBase58(),
      treasury: treasury.publicKey.toBase58(),
      signer: signer.publicKey.toBase58(),
      simulated: true,
      priceSource: 'Jupiter price v3: the share\'s reference price (stockData), stamped with Jupiter\'s own update time, and the xStock\'s USD price beside it. No redemption-rate feed: Jupiter\'s scaled-UI multiplier is not shown to be the quantity Pyth\'s .RR feed carries, so simulated prints leave it absent',
      placeholders: 'Publisher count 1 (one source) and a confidence of 1 bp: Jupiter reports neither',
      params: DEVNET_PARAMS,
      poster: poster.publicKey.toBase58(),
      listings: LISTINGS.map((l) => ({ symbol: l.symbol, listing: listingPda(l.symbol)[0].toBase58(), feeds: l.feeds, feedNames: l.names, mint: l.mint })),
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
