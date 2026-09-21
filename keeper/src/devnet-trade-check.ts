/* Mint and redeem against the devnet vault with the operator's own key, and
   read every figure back from the chain. This is the instruction encoding's
   first contact with the real program. */
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { decodeVault } from '../../sdk/src/vault.ts';
import { mintSharesIx, redeemSharesIx, createAtaIdempotentIx, ata, explainProgramError } from '../../sdk/src/ix.ts';
import { valueOf } from '../../sdk/src/settle.ts';
import type { Manifest } from './crank-core.ts';

const m: Manifest = JSON.parse(readFileSync('keeper/.devnet/manifest.json', 'utf8'));
const op = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('keeper/.devnet/operator.json', 'utf8'))));
const conn = new Connection(m.rpc, 'confirmed');
const pk = (s: string) => new PublicKey(s);

const vault = () => conn.getAccountInfo(pk(m.vault)).then(i => decodeVault(i!.data));
const supply = (mint: string) => conn.getTokenSupply(pk(mint)).then(r => BigInt(r.value.amount));
const bal = (acc: PublicKey) => conn.getTokenAccountBalance(acc).then(r => BigInt(r.value.amount)).catch(() => 0n);

let failed = 0;
const check = (n: string, ok: boolean, d = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${n}${ok || !d ? '' : ' — ' + d}`); if (!ok) failed++; };
const send = async (tx: Transaction) => {
  try { return { sig: await sendAndConfirmTransaction(conn, tx, [op], { commitment: 'confirmed' }) }; }
  catch (e: any) { return { err: explainProgramError(e.logs) ?? e.message }; }
};

let v = await vault();
const parked = v.exposed === 'night' ? 'day' : 'night';
const exposedMint = v.exposed === 'night' ? m.nightMint : m.dayMint;
const parkedMint = parked === 'night' ? m.nightMint : m.dayMint;
console.log(`exposed=${v.exposed}, minting into ${parked}`);

// Quote moves under its own program; the share classes are minted and burned
// under theirs, so their ATAs are different addresses. The underlying is not
// touched by mint or redeem at all.
const qp = pk(m.tokenProgram);
const sp = pk(m.shareTokenProgram);
const userQuote = ata(op.publicKey, pk(m.quoteMint), qp);
const userShares = ata(op.publicKey, pk(parkedMint), sp);
const userExposedShares = ata(op.publicKey, pk(exposedMint), sp);
const q0 = await bal(userQuote);
const quoteIn = 250n * 10n ** 6n;   // $250

/* ── mint into the exposed class must be refused ─────────────────────── */
{
  const tx = new Transaction().add(
    createAtaIdempotentIx(op.publicKey, op.publicKey, pk(exposedMint), sp),
    mintSharesIx({
      vault: pk(m.vault), classMint: pk(exposedMint), nightMint: pk(m.nightMint), dayMint: pk(m.dayMint),
      quoteVault: pk(m.quoteVault), userQuote, userShares: userExposedShares, user: op.publicKey,
      quoteMint: pk(m.quoteMint), tokenProgram: qp, shareTokenProgram: sp,
    }, v.exposed, quoteIn),
  );
  const r = await send(tx);
  check('minting the exposed class is refused by the program', 'err' in r, JSON.stringify(r));
  if ('err' in r) console.log(`        program said: ${r.err}`);
}

/** What the operator held after the mint, carried into the redeem block. */
let sharesHeld = 0n;

/* ── mint into the parked class ──────────────────────────────────────── */
{
  const sharesBefore = await bal(userShares);
  const ownedBefore = v.ownedQuote;
  const supBefore = await supply(parkedMint);
  const mintedBefore = parked === 'day' ? v.totalMintedDay : v.totalMintedNight;
  const tx = new Transaction().add(
    createAtaIdempotentIx(op.publicKey, op.publicKey, pk(parkedMint), sp),
    mintSharesIx({
      vault: pk(m.vault), classMint: pk(parkedMint), nightMint: pk(m.nightMint), dayMint: pk(m.dayMint),
      quoteVault: pk(m.quoteVault), userQuote, userShares, user: op.publicKey,
      quoteMint: pk(m.quoteMint), tokenProgram: qp, shareTokenProgram: sp,
    }, parked, quoteIn),
  );
  const r = await send(tx);
  check('mint_shares into the parked class confirms', 'sig' in r, JSON.stringify(r));
  if ('sig' in r) console.log(`        ${r.sig}`);
  v = await vault();
  const shares = await bal(userShares);
  const q1 = await bal(userQuote);
  // Deltas, not absolutes. The operator's balances and the vault's totals are
  // whatever earlier runs, the pools and the site left them — asserting a
  // clean slate makes this fail for reasons that have nothing to do with the
  // program.
  check('shares received = quote in (NAV 1.0)', shares - sharesBefore === quoteIn, `${shares - sharesBefore} vs ${quoteIn}`);
  check('quote left the user', q0 - q1 === quoteIn, `${q0 - q1}`);
  check('vault owned_quote rose by the deposit', v.ownedQuote - ownedBefore === quoteIn, `${v.ownedQuote - ownedBefore}`);
  const sup = await supply(parkedMint);
  check(`${parked} mint supply rose by ${quoteIn}`, sup - supBefore === quoteIn, `${sup - supBefore}`);
  // The invariant that matters, and it is absolute: every share of every
  // class is covered by quote the vault owns.
  const claims = valueOf(await supply(pk(m.nightMint)), v.nightNav) + valueOf(await supply(pk(m.dayMint)), v.dayNav);
  check('claims backed: night + day value == owned_quote', claims === v.ownedQuote, `${claims} vs ${v.ownedQuote}`);
  check('total_minted counter rose by the deposit',
    (parked === 'day' ? v.totalMintedDay : v.totalMintedNight) - mintedBefore === quoteIn);
  sharesHeld = shares;
}

/* ── redeem half ─────────────────────────────────────────────────────── */
{
  const half = quoteIn / 2n;
  const tx = new Transaction().add(redeemSharesIx({
    vault: pk(m.vault), classMint: pk(parkedMint), nightMint: pk(m.nightMint), dayMint: pk(m.dayMint),
    quoteVault: pk(m.quoteVault), userQuote, userShares, user: op.publicKey,
    quoteMint: pk(m.quoteMint), tokenProgram: qp, shareTokenProgram: sp,
  }, parked, half));
  const r = await send(tx);
  check('redeem_shares confirms', 'sig' in r, JSON.stringify(r));
  const sharesAfter = await bal(userShares);
  const q2 = await bal(userQuote);
  check('half the shares burned', sharesHeld - sharesAfter === half, `${sharesHeld - sharesAfter} vs ${half}`);
  check('quote came back at NAV 1.0', q2 === q0 - half, `${q2} vs ${q0 - half}`);
  const vAfter = await vault();
  check('vault owned_quote fell by the redemption', v.ownedQuote - vAfter.ownedQuote === half, `${v.ownedQuote - vAfter.ownedQuote}`);
}

console.log(failed ? `\n${failed} failed` : '\nall on-chain trade checks passed');
process.exit(failed ? 1 : 0);
