/* ───────────────────────────────────────────────────────────────────────────
   An event-session vault, shaped like a real PreStock.

   OPENAI has no 09:30. It is a token wrapping an SPV claim on a private
   company, its price is whoever's mark plus whatever the market will pay, and
   the gap between those two is the only thing about it that behaves like a
   session. So the vault splits that axis instead of the clock:

     PRE.NOW    the token as it trades between prints, always exitable
     PRE.THEN   the print itself, and the divergence that precedes it

   The real OPENAI mint lives on mainnet and this is devnet, so the underlying
   here is *shaped* like it rather than being it: Token-2022, a 1% transfer
   fee, a scaled-UI multiplier, a permanent delegate, a pause switch and
   on-chain metadata — every extension the real one carries, so the paths that
   handle them are the paths that run. What cannot be faked is the detector,
   and that reads the live prestocks.com API for the actual OPENAI mark and
   the actual executable price.

     npm run devnet:event
   ─────────────────────────────────────────────────────────────────────────── */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, ExtensionType, getMintLen,
  createInitializeMint2Instruction, createInitializePermanentDelegateInstruction,
  createInitializeTransferFeeConfigInstruction, createInitializeMetadataPointerInstruction,
  createInitializePausableConfigInstruction, createInitializeScaledUiAmountConfigInstruction,
  createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { createInitializeInstruction, pack, type TokenMetadata } from '@solana/spl-token-metadata';
import {
  PROGRAM_ID, vaultPda, nightMintPda, dayMintPda, underlyingVaultPda, quoteVaultPda,
  schedulePda, detectorPda, decodeVault, decodeDetector, premiumBps, SESSION_EVENT,
} from '../../sdk/src/vault.ts';
import {
  initializeVaultIx, setScheduleIx, postDetectorIx, hexToBytes, ata,
  TOKEN_PROGRAM_ID, explainProgramError, type VaultParams,
} from '../../sdk/src/ix.ts';

const RPC = process.env.RPC ?? 'https://api.devnet.solana.com';
const OUT_DIR = 'keeper/.devnet';
const MANIFEST = `${OUT_DIR}/openai.json`;
const SITE = 'web/public/devnet-openai.json';

/** Pyth feed ids. Devnet sponsors no pre-IPO feed, so these stand in and the
 *  page says so; the *detector* is the real reading and is not a stand-in. */
const FEEDS: Record<string, string> = {
  'Crypto.SOL/USD': 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  'Crypto.BTC/USD': 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
};
const PYTH_PUSH = new PublicKey('pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT');
const feedAccount = (hex: string) => {
  const shard = new Uint8Array(2);
  return PublicKey.findProgramAddressSync([shard, hexToBytes(hex)], PYTH_PUSH)[0];
};

const VAULT_SYMBOL = 'OPENAI';
const METADATA_BASE = process.env.METADATA_BASE ?? 'https://session-roan.vercel.app/meta';
const WAD = 10n ** 18n;

const PARAMS: VaultParams = {
  markFeedId: hexToBytes(FEEDS['Crypto.SOL/USD']),
  equityFeedId: hexToBytes(FEEDS['Crypto.BTC/USD']),
  fundingKBps: 2_500,
  fundingMaxBps: 50,
  maxStaleSecs: 1_800,
  maxConfBps: 500,
  maxMoveBps: 1_000,
  // For an event vault this is the *detector's* staleness bound, not a feed's:
  // a reading older than an hour is not something to move NAV on.
  equityQuietSecs: 3_600,
  fillIncentiveBps: 10,
  maxCarryDeltaBps: 500,
  maxUnexpectedClosedSecs: 3 * 3_600,
  maxPostedSlotAge: 4_500,
  maxBellLeadSecs: 300,
  // 10% between the issuer's mark and what the token executes at. OPENAI sat
  // at +12.6% the day this was written, so THEN takes the risk immediately —
  // which is the honest reading, not a tuned one.
  maxPremiumBps: 1_000,
  auctionSecs: 120,
  incentiveRamp: [10, 25, 50],
  requireVerifiedRecap: false,
};

const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
const conn = new Connection(RPC, 'confirmed');
const operator = load(`${OUT_DIR}/operator.json`);
mkdirSync(OUT_DIR, { recursive: true });

console.log(`operator     ${operator.publicKey.toBase58()}`);
const bal = await conn.getBalance(operator.publicKey);
console.log(`             ${bal / LAMPORTS_PER_SOL} SOL`);

/* ── the live reading, before anything is created ────────────────────────── */

interface PreStock { symbol: string; markPrice: number; tokenPrice: number; contract_address: string; supply: number }
const all: PreStock[] = await fetch('https://prestocks.com/api/prestocks').then(r => r.json());
const live = all.find(p => p.symbol === 'OPENAI');
if (!live) throw new Error('prestocks.com did not return OPENAI');
const mark = BigInt(Math.round(live.markPrice * 1e6)) * WAD / 10n ** 6n;
const executable = BigInt(Math.round(live.tokenPrice * 1e6)) * WAD / 10n ** 6n;
console.log(`\nprestocks.com  OPENAI mark $${live.markPrice.toFixed(2)}  executable $${live.tokenPrice.toFixed(2)}`);
console.log(`               premium ${premiumBps({ mark, executable })} bp  —  real mint ${live.contract_address} (mainnet)`);

/* ── a PreStocks-shaped underlying ───────────────────────────────────────── */

const mintPath = `${OUT_DIR}/openai-mints.json`;
let mints: { underlying: string; quote: string };

if (existsSync(mintPath)) {
  mints = JSON.parse(readFileSync(mintPath, 'utf8'));
  console.log(`\nunderlying   ${mints.underlying}  (already created)`);
} else {
  // Every extension the real OPENAI mint carries. The transfer fee is the one
  // that matters most: a fill into a fee-bearing mint arrives short, and a
  // vault that credited the sent amount would be insolvent by 1% every time.
  const underlying = Keypair.generate();
  const md: TokenMetadata = {
    mint: underlying.publicKey,
    name: 'OpenAI PreStocks (devnet shape)',
    symbol: 'OPENAI',
    uri: '',
    additionalMetadata: [],
  };
  const exts = [
    ExtensionType.PermanentDelegate,
    ExtensionType.TransferFeeConfig,
    ExtensionType.PausableConfig,
    ExtensionType.ScaledUiAmountConfig,
    ExtensionType.MetadataPointer,
  ];
  const len = getMintLen(exts);
  const space = len + pack(md).length + 4 + 32;

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: operator.publicKey, newAccountPubkey: underlying.publicKey,
      space: len, lamports: await conn.getMinimumBalanceForRentExemption(space),
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializePermanentDelegateInstruction(underlying.publicKey, operator.publicKey, TOKEN_2022_PROGRAM_ID),
    // 1%, uncapped — the real one's schedule from epoch 1039.
    createInitializeTransferFeeConfigInstruction(
      underlying.publicKey, operator.publicKey, operator.publicKey, 100, BigInt('18446744073709551615'), TOKEN_2022_PROGRAM_ID,
    ),
    createInitializePausableConfigInstruction(underlying.publicKey, operator.publicKey, TOKEN_2022_PROGRAM_ID),
    createInitializeScaledUiAmountConfigInstruction(underlying.publicKey, operator.publicKey, 1, TOKEN_2022_PROGRAM_ID),
    createInitializeMetadataPointerInstruction(underlying.publicKey, operator.publicKey, underlying.publicKey, TOKEN_2022_PROGRAM_ID),
    createInitializeMint2Instruction(underlying.publicKey, 9, operator.publicKey, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID, mint: underlying.publicKey, metadata: underlying.publicKey,
      name: md.name, symbol: md.symbol, uri: md.uri,
      mintAuthority: operator.publicKey, updateAuthority: operator.publicKey,
    }),
  );
  await sendAndConfirmTransaction(conn, tx, [operator, underlying], { commitment: 'confirmed' });

  // The quote reuses the NVDA vault's, so one faucet serves both desks.
  const nvda = JSON.parse(readFileSync(`${OUT_DIR}/manifest.json`, 'utf8')) as { quoteMint: string };
  mints = { underlying: underlying.publicKey.toBase58(), quote: nvda.quoteMint };
  writeFileSync(mintPath, JSON.stringify(mints, null, 2));
  console.log(`\nunderlying   ${mints.underlying}  (Token-2022: 1% fee, scaled UI, permanent delegate, pausable, metadata)`);
}

const underlyingMint = new PublicKey(mints.underlying);
const quoteMint = new PublicKey(mints.quote);
console.log(`quote        ${mints.quote}  (shared with the NVDA vault)`);

/* ── the vault ───────────────────────────────────────────────────────────── */

const [vault] = vaultPda(underlyingMint, quoteMint);
const [nightMint] = nightMintPda(vault);
const [dayMint] = dayMintPda(vault);
const [underlyingVault] = underlyingVaultPda(vault);
const [quoteVault] = quoteVaultPda(vault);
const [schedule] = schedulePda(vault);
const [detector] = detectorPda(vault);
const markUpdate = feedAccount(FEEDS['Crypto.SOL/USD']);
const equityUpdate = feedAccount(FEEDS['Crypto.BTC/USD']);

const send = async (tx: Transaction, signers = [operator]) => {
  try {
    return await sendAndConfirmTransaction(conn, tx, signers, { commitment: 'confirmed' });
  } catch (e: unknown) {
    const err = e as { logs?: string[]; message?: string };
    for (const l of err.logs ?? []) console.log('    | ' + l);
    throw new Error(explainProgramError(err.logs) ?? err.message ?? String(e));
  }
};

if (await conn.getAccountInfo(vault)) {
  console.log(`vault        ${vault.toBase58()}  (already initialised)`);
} else {
  const sig = await send(new Transaction().add(initializeVaultIx({
    authority: operator.publicKey, vault, underlyingMint, quoteMint,
    nightMint, dayMint, underlyingVault, quoteVault,
    markPriceUpdate: markUpdate, equityPriceUpdate: equityUpdate,
    underlyingTokenProgram: TOKEN_2022_PROGRAM_ID,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
    shareTokenProgram: TOKEN_2022_PROGRAM_ID,
  }, PARAMS, VAULT_SYMBOL, SESSION_EVENT, METADATA_BASE)));
  console.log(`vault        ${vault.toBase58()}  initialised in ${sig}`);
}

/* ── the schedule: one print, a week out ─────────────────────────────────── */

const nextPrint = Math.floor(Date.now() / 1000) + 7 * 86_400;
const schedSig = await send(new Transaction().add(setScheduleIx(
  vault, operator.publicKey, schedule,
  // A tender is the kind of print that actually reprices a PreStock, and the
  // window is how long the market takes to absorb it.
  [{ ts: nextPrint, windowSecs: 2 * 86_400, kind: 0 }],
)));
console.log(`schedule     ${schedule.toBase58()}  one print at ${new Date(nextPrint * 1000).toISOString().slice(0, 16)}Z  ${schedSig.slice(0, 16)}…`);

/* ── the detector: the live reading, on chain ────────────────────────────── */

const detSig = await send(new Transaction().add(
  postDetectorIx(vault, operator.publicKey, detector, mark, executable),
));
const d = decodeDetector((await conn.getAccountInfo(detector))!.data);
console.log(`detector     ${detector.toBase58()}  premium ${premiumBps(d)} bp  ${detSig.slice(0, 16)}…`);

/* ── inventory, so the classes can be traded ─────────────────────────────── */

const opU = getAssociatedTokenAddressSync(underlyingMint, operator.publicKey, false, TOKEN_2022_PROGRAM_ID);
await send(new Transaction().add(
  createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, opU, operator.publicKey, underlyingMint, TOKEN_2022_PROGRAM_ID),
  createMintToInstruction(underlyingMint, opU, operator.publicKey, 1_000_000n * 10n ** 9n, [], TOKEN_2022_PROGRAM_ID),
));
console.log(`inventory    1,000,000 OPENAI to the operator`);

const v = decodeVault((await conn.getAccountInfo(vault))!.data);
console.log(`\n             exposed=${v.exposed === 'night' ? 'THEN' : 'NOW'}  nav=${v.nightNav}/${v.dayNav}  kind=event`);

/* ── manifest ────────────────────────────────────────────────────────────── */

const manifest = {
  cluster: 'devnet',
  rpc: RPC,
  programId: PROGRAM_ID.toBase58(),
  symbol: 'OPENAI',
  vaultSymbol: VAULT_SYMBOL,
  sessionKind: SESSION_EVENT,
  metadataBase: METADATA_BASE,
  note: 'Devnet stand-in for a PreStock. The underlying carries every extension the real OPENAI mint does — a 1% transfer fee, a scaled-UI multiplier, a permanent delegate, a pause switch — because those are the paths that must work. The real token is mainnet-only. The detector is not a stand-in: it is the live mark and executable price from prestocks.com, posted by the operator, because no oracle prices a pre-IPO token.',
  realMint: live.contract_address,
  vault: vault.toBase58(),
  underlyingMint: mints.underlying,
  quoteMint: mints.quote,
  nightMint: nightMint.toBase58(),
  dayMint: dayMint.toBase58(),
  underlyingVault: underlyingVault.toBase58(),
  quoteVault: quoteVault.toBase58(),
  schedule: schedule.toBase58(),
  detector: detector.toBase58(),
  markPriceUpdate: markUpdate.toBase58(),
  equityPriceUpdate: equityUpdate.toBase58(),
  markFeed: 'Crypto.SOL/USD',
  equityFeed: 'Crypto.BTC/USD',
  operator: operator.publicKey.toBase58(),
  tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
  underlyingTokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
  shareTokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
  params: { ...PARAMS, markFeedId: FEEDS['Crypto.SOL/USD'], equityFeedId: FEEDS['Crypto.BTC/USD'] },
  initialised: new Date().toISOString(),
};
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
writeFileSync(SITE, JSON.stringify(manifest, null, 2));
console.log(`\nwrote ${MANIFEST}`);
