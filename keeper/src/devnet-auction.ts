/* ───────────────────────────────────────────────────────────────────────────
   Run one auction, end to end, so "never run" stops being true.

   The residual left by a boundary normally goes to whoever arrives first with
   inventory, at the mark plus whatever the incentive ramp has reached. The
   auction is the alternative: the same residual offered at *one* price to
   everyone for a window after the bell, so the arbitrageur who happens to be
   watching does not collect a premium for being awake.

   Every instruction here is permissionless — `open_auction`, `auction_bid`
   and `close_auction` take no authority, and `claim_auction` takes only the
   bidder's own signature. The operator key is used because it is the one with
   devnet inventory, not because the program asks for it.

   The sequence has to beat the crank. `crank` fills the handoff directly as
   soon as it settles, which would leave nothing to auction, so this settles
   *without* filling and then runs the window. The window itself has to close
   before the cron's next tick for the same reason.

     npm run devnet:auction            wait for the next bell, then run it
     npm run devnet:auction -- --now   use the boundary already settled
   ─────────────────────────────────────────────────────────────────────────── */

import { readFileSync } from 'node:fs';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  decodeVault, decodeAuction, auctionPda, bidPda, type Vault,
} from '../../sdk/src/vault.ts';
import { nextBoundary } from '../../sdk/src/calendar.ts';
import {
  openAuctionIx, auctionBidIx, closeAuctionIx, claimAuctionIx, settleBoundaryIx,
  setParamsIx, createAtaIdempotentIx, ata, explainProgramError,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, type VaultParams,
} from '../../sdk/src/ix.ts';
import type { Manifest } from './crank-core.ts';

/** SPL / Token-2022 `MintTo`: discriminant 7, then the amount as a u64. */
function mintToIx(
  mint: PublicKey, to: PublicKey, authority: PublicKey, amount: bigint, programId: PublicKey,
) {
  const data = Buffer.alloc(9);
  data[0] = 7;
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

const m: Manifest = JSON.parse(readFileSync('keeper/.devnet/manifest.json', 'utf8'));
const op = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync('keeper/.devnet/operator.json', 'utf8'))));
/* Two keys, and the split is the point. `set_params` is the only thing here
   that needs the vault's authority — opening, bidding and closing take no
   authority at all, and claiming takes only the bidder's own signature. The
   operator bids because it is the key holding devnet inventory, not because
   the program asks it to. */
const authority = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/id.json`, 'utf8'))));
const conn = new Connection(m.rpc, 'confirmed');
const pk = (s: string) => new PublicKey(s);
const argv = process.argv.slice(2);
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/* The auction has to open, take a bid and close before anything else fills
   the residual. On this instance that is the cron, five minutes after the
   bell, so the window is set shorter than that — a longer one could never
   clear against a real residual here, whatever the program allows. */
const WINDOW_SECS = 120;

const send = async (label: string, signers: Keypair[], ...ix: Parameters<Transaction['add']>) => {
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
    .add(...ix);
  try {
    const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: 'confirmed' });
    console.log(`  ${label}  ${sig}`);
    return sig;
  } catch (e) {
    const err = e as { logs?: string[]; message?: string };
    console.log(`  ${label}  FAILED: ${explainProgramError(err.logs) ?? err.message ?? String(e)}`);
    return null;
  }
};

const read = async (): Promise<Vault> =>
  decodeVault((await conn.getAccountInfo(pk(m.vault)))!.data);

const accounts = {
  vault: pk(m.vault),
  underlyingVault: pk(m.underlyingVault),
  quoteVault: pk(m.quoteVault),
  underlyingMint: pk(m.underlyingMint),
  quoteMint: pk(m.quoteMint),
  underlyingTokenProgram: pk(m.underlyingTokenProgram ?? TOKEN_PROGRAM_ID.toBase58()),
  quoteTokenProgram: pk(m.tokenProgram ?? TOKEN_PROGRAM_ID.toBase58()),
};

/* ── 1. a window that can actually close ─────────────────────────────────── */

/* Built from the vault as it is, not from the manifest.
   `set_params` writes the whole struct, so anything the blob gets wrong is
   silently applied to everything else — and the manifest stores feed ids as
   hex strings while the instruction wants bytes, which is exactly the kind of
   difference that would go through without complaining. Reading the live
   vault and changing one field cannot drift. */
const paramsOf = (v: Vault): VaultParams => ({
  markFeedId: v.markFeedId, equityFeedId: v.equityFeedId,
  fundingKBps: v.fundingKBps, fundingMaxBps: v.fundingMaxBps,
  maxStaleSecs: v.maxStaleSecs, maxConfBps: v.maxConfBps, maxMoveBps: v.maxMoveBps,
  equityQuietSecs: v.equityQuietSecs, fillIncentiveBps: v.fillIncentiveBps,
  maxCarryDeltaBps: v.maxCarryDeltaBps, maxUnexpectedClosedSecs: v.maxUnexpectedClosedSecs,
  maxPostedSlotAge: v.maxPostedSlotAge, maxBellLeadSecs: v.maxBellLeadSecs,
  maxPremiumBps: v.maxPremiumBps, auctionSecs: v.auctionSecs,
  incentiveRamp: v.incentiveRamp, requireVerifiedRecap: v.requireVerifiedRecap,
});

let v = await read();
if (v.auctionSecs !== WINDOW_SECS) {
  console.log(`auction window ${v.auctionSecs}s → ${WINDOW_SECS}s`);
  await send('set_params ', [authority], setParamsIx(
    { vault: pk(m.vault), authority: authority.publicKey },
    { ...paramsOf(v), auctionSecs: WINDOW_SECS },
  ));
  const after = await read();
  const unchanged = after.fundingKBps === v.fundingKBps && after.maxStaleSecs === v.maxStaleSecs
    && after.maxMoveBps === v.maxMoveBps && after.fillIncentiveBps === v.fillIncentiveBps
    && after.requireVerifiedRecap === v.requireVerifiedRecap
    && after.incentiveRamp.join() === v.incentiveRamp.join();
  console.log(`           every other parameter ${unchanged ? 'unchanged' : 'CHANGED — stop and look'}`);
  if (!unchanged) process.exit(1);
  v = after;
}

/* ── 2. a boundary with something left over ──────────────────────────────── */

if (!argv.includes('--now')) {
  const bell = nextBoundary(v.lastBoundaryTs, 20);
  if (bell === null) { console.log('no bell ahead within the calendar window'); process.exit(1); }
  const wait = bell - now();
  if (wait > 0) {
    console.log(`waiting ${wait}s for the ${new Date(bell * 1000).toISOString()} bell`);
    await sleep((wait + 8) * 1000);   // a little past it, so the clock has moved
  }
  console.log('settling, without filling — a filled handoff leaves nothing to auction');
  await send('settle     ', [op], settleBoundaryIx({
    vault: pk(m.vault), nightMint: pk(m.nightMint), dayMint: pk(m.dayMint),
    markPriceUpdate: pk(m.markPriceUpdate), equityPriceUpdate: pk(m.equityPriceUpdate),
    underlyingMint: pk(m.underlyingMint), underlyingVault: pk(m.underlyingVault),
  }));
  v = await read();
}

console.log(`\nboundary ${new Date(v.lastBoundaryTs * 1000).toISOString()}`);
console.log(`residual  ${v.pendingDelta} quote atoms  (mark ${(Number(v.lastMark) / 1e18).toFixed(4)})`);
if (v.pendingDelta === 0n) { console.log('nothing to auction'); process.exit(1); }

/* ── 3. open it ──────────────────────────────────────────────────────────── */

const [auction] = auctionPda(pk(m.vault), v.lastBoundaryTs);
if (!(await conn.getAccountInfo(auction))) {
  await send('open       ', [op], openAuctionIx(pk(m.vault), auction, op.publicKey));
}
const aInfo = await conn.getAccountInfo(auction);
if (!aInfo) { console.log('the auction did not open'); process.exit(1); }
let a = decodeAuction(aInfo.data);
console.log(`auction   ${auction.toBase58()}`);
console.log(`          wants ${a.wantedUnderlying} underlying atoms, ${a.vaultBuys ? 'vault buys' : 'vault sells'}, closes ${new Date(a.closesAt * 1000).toISOString()}`);

/* ── 4. bid ──────────────────────────────────────────────────────────────── */

const [bid] = bidPda(auction, op.publicKey);
const bidderAccounts = {
  ...accounts, auction, bidder: op.publicKey,
  bidderUnderlying: ata(op.publicKey, pk(m.underlyingMint), accounts.underlyingTokenProgram),
  bidderQuote: ata(op.publicKey, pk(m.quoteMint), accounts.quoteTokenProgram),
};
/* A bid escrows whatever the side demands — underlying when the vault is
   buying, quote when it is selling — and the program refuses rather than
   part-filling if the bidder is short. The operator is mint authority for
   both devnet mints, so being short is fixable; being surprised by it thirty
   seconds before the window closes is not. */
{
  const needUnderlying = a.vaultBuys;
  const mint = needUnderlying ? pk(m.underlyingMint) : pk(m.quoteMint);
  const prog = needUnderlying ? accounts.underlyingTokenProgram : accounts.quoteTokenProgram;
  const acct = ata(op.publicKey, mint, prog);
  const held = await conn.getTokenAccountBalance(acct).then(r => BigInt(r.value.amount)).catch(() => 0n);
  const want = needUnderlying
    ? a.wantedUnderlying
    // Quote is rounded up, exactly as `auction_bid` computes it.
    : (a.wantedUnderlying * v.lastMark + (10n ** 18n - 1n)) / 10n ** 18n;
  console.log(`bidder needs ${want} ${needUnderlying ? 'underlying' : 'quote'} atoms, holds ${held}`);
  if (held < want) {
    console.log(`  topping up ${want - held} atoms — the operator is mint authority for both`);
    await send('mint to bid', [op],
      createAtaIdempotentIx(op.publicKey, op.publicKey, mint, prog),
      mintToIx(mint, acct, op.publicKey, want - held, prog));
  }
}

if (!(await conn.getAccountInfo(bid))) {
  await send('bid        ', [op],
    createAtaIdempotentIx(op.publicKey, op.publicKey, pk(m.underlyingMint), accounts.underlyingTokenProgram),
    createAtaIdempotentIx(op.publicKey, op.publicKey, pk(m.quoteMint), accounts.quoteTokenProgram),
    auctionBidIx(bidderAccounts, bid, a.wantedUnderlying));
}

/* ── 5. close, once the window is up ─────────────────────────────────────── */

a = decodeAuction((await conn.getAccountInfo(auction))!.data);
const left = a.closesAt - now();
if (left > 0) {
  console.log(`\nwaiting ${left}s for the window to close — it cannot be cleared early`);
  await sleep((left + 3) * 1000);
}
await send('close      ', [op], closeAuctionIx(pk(m.vault), auction, pk(m.markPriceUpdate)));

a = decodeAuction((await conn.getAccountInfo(auction))!.data);
console.log(`\ncleared at ${(Number(a.clearingMark) / 1e18).toFixed(6)}  fill ratio ${(Number(a.fillRatio) / 1e16).toFixed(2)}%`);
console.log(`bids ${a.bids}  bid ${a.bidUnderlying} of ${a.wantedUnderlying} wanted`);

/* ── 6. claim ────────────────────────────────────────────────────────────── */

if (await conn.getAccountInfo(bid)) {
  await send('claim      ', [op], claimAuctionIx(bidderAccounts, bid, pk(m.nightMint), pk(m.dayMint)));
}

v = await read();
console.log(`\nresidual now ${v.pendingDelta} quote atoms`);
console.log(`bid account  ${(await conn.getAccountInfo(bid)) ? 'still open' : 'closed, rent returned'}`);
