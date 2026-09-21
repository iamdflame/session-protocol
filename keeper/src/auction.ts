/* ───────────────────────────────────────────────────────────────────────────
   Drive the bell auction from the command line.

   The residual a handoff leaves has to trade, and offering it continuously
   in the minutes after a bell prices it at whatever the first arbitrageur's
   model says. The auction collects bids for a window and clears all of them
   at one price — the mark from the bell's own window, the same number the
   settlement used.

   This exercises the whole path on devnet so the UI is built against
   something known to work:

     npm run auction                 what state it is in
     npm run auction -- --open       open it for this bell's residual
     npm run auction -- --bid 250    escrow a bid
     npm run auction -- --close      fix the clearing price
     npm run auction -- --claim      take the award and the refund
   ─────────────────────────────────────────────────────────────────────────── */

import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  auctionPda, bidPda, decodeVault, decodeAuction, decodeBid, award,
} from '../../sdk/src/vault.ts';
import {
  openAuctionIx, auctionBidIx, closeAuctionIx, claimAuctionIx,
  ata, createAtaIdempotentIx, explainProgramError,
} from '../../sdk/src/ix.ts';
import type { Manifest } from './crank-core.ts';

const m: Manifest = JSON.parse(readFileSync('keeper/.devnet/manifest.json', 'utf8'));
const op = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('keeper/.devnet/operator.json', 'utf8'))));
const conn = new Connection(m.rpc, 'confirmed');
const pk = (s: string) => new PublicKey(s);
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : null; };
const has = (k: string) => process.argv.includes(`--${k}`);

const vaultKey = pk(m.vault);
const v = decodeVault((await conn.getAccountInfo(vaultKey))!.data);
const qd = v.quoteDecimals;
const ud = v.underlyingDecimals;
const now = Math.floor(Date.now() / 1000);
const [auction] = auctionPda(vaultKey, v.lastBoundaryTs);
const [bid] = bidPda(auction, op.publicKey);

const U_PROG = pk(m.underlyingTokenProgram);
const Q_PROG = pk(m.tokenProgram);
const accounts = {
  vault: vaultKey, auction,
  underlyingVault: pk(m.underlyingVault), quoteVault: pk(m.quoteVault),
  bidderUnderlying: ata(op.publicKey, pk(m.underlyingMint), U_PROG),
  bidderQuote: ata(op.publicKey, pk(m.quoteMint), Q_PROG),
  bidder: op.publicKey,
  underlyingMint: pk(m.underlyingMint), quoteMint: pk(m.quoteMint),
  underlyingTokenProgram: U_PROG, quoteTokenProgram: Q_PROG,
};

const fmt = (x: bigint, d: number) => (Number(x) / 10 ** d).toLocaleString('en-US', { maximumFractionDigits: 4 });
const send = async (tx: Transaction) => {
  try {
    return await sendAndConfirmTransaction(conn, tx, [op], { commitment: 'confirmed' });
  } catch (e: unknown) {
    const err = e as { logs?: string[]; message?: string };
    throw new Error(explainProgramError(err.logs) ?? err.message ?? String(e));
  }
};

/* ── where things stand ──────────────────────────────────────────────────── */

console.log(`vault     ${m.vault}`);
console.log(`bell      ${new Date(v.lastBoundaryTs * 1000).toISOString().slice(0, 16)}Z  (${Math.round((now - v.lastBoundaryTs) / 60)}m ago)`);
console.log(`residual  ${v.pendingDelta === 0n ? 'flat — nothing to auction' : `${fmt(v.pendingDelta < 0n ? -v.pendingDelta : v.pendingDelta, qd)} quote, the vault ${v.pendingDelta > 0n ? 'buys' : 'sells'}`}`);
console.log(`window    ${v.auctionSecs}s from the bell; incentive ramp ${v.incentiveRamp.join('/')} bp`);
console.log(`auction   ${auction.toBase58()}`);

const acc = await conn.getAccountInfo(auction);
if (acc) {
  const a = decodeAuction(acc.data);
  const left = a.closesAt - now;
  console.log(`          ${a.closed ? 'closed' : left > 0 ? `open, ${left}s left` : 'window over, not yet cleared'}`);
  console.log(`          wants ${fmt(a.wantedUnderlying, ud)} underlying · ${a.bids} bid(s) totalling ${fmt(a.bidUnderlying, ud)}`);
  if (a.closed) {
    console.log(`          cleared at ${Number(a.clearingMark) / 1e18}, fill ratio ${(Number(a.fillRatio) / 1e18 * 100).toFixed(2)}%`);
  }
  const b = await conn.getAccountInfo(bid);
  if (b) {
    const mine = decodeBid(b.data);
    console.log(`your bid  ${fmt(mine.underlying, ud)} underlying, ${fmt(mine.escrowed, a.vaultBuys ? ud : qd)} escrowed`);
    if (a.closed) {
      const w = award(a, mine.underlying, mine.escrowed);
      console.log(`          would take ${fmt(w.underlying, ud)} underlying / ${fmt(w.quote, qd)} quote, ${fmt(w.refund, a.vaultBuys ? ud : qd)} back`);
    }
  }
} else {
  console.log(`          not opened`);
}

/* ── act ─────────────────────────────────────────────────────────────────── */

if (has('open')) {
  console.log(`\nopening…`);
  console.log(`  ${await send(new Transaction().add(openAuctionIx(vaultKey, auction, op.publicKey)))}`);
}

const bidAmount = arg('bid');
if (bidAmount) {
  const atoms = BigInt(Math.round(Number(bidAmount) * 10 ** ud));
  console.log(`\nbidding ${bidAmount} underlying…`);
  const tx = new Transaction().add(
    createAtaIdempotentIx(op.publicKey, op.publicKey, pk(m.underlyingMint), U_PROG),
    createAtaIdempotentIx(op.publicKey, op.publicKey, pk(m.quoteMint), Q_PROG),
    auctionBidIx(accounts, bid, atoms),
  );
  console.log(`  ${await send(tx)}`);
}

if (has('close')) {
  console.log(`\nclosing…`);
  console.log(`  ${await send(new Transaction().add(closeAuctionIx(vaultKey, auction, pk(m.markPriceUpdate))))}`);
}

if (has('claim')) {
  console.log(`\nclaiming…`);
  const tx = new Transaction().add(
    claimAuctionIx(accounts, bid, pk(m.nightMint), pk(m.dayMint)),
  );
  console.log(`  ${await send(tx)}`);
}
