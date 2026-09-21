/* The instruction discriminators are precomputed in sdk/src/ix.ts so the module
   can run in a browser without a hashing dependency. This recomputes each one
   the way Anchor does and fails if any has drifted — a wrong discriminator is
   an instruction that silently dispatches to nothing. */
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import {
  DISCRIMINATOR, encodeVaultParams, classByte, hexToBytes, bytesToHex, initializeVaultIx, VAULT_PARAMS_SIZE,
  recapIx, resolveHaltIx, haltReasonByte, settleBoundaryIx, setScheduleIx, postDetectorIx, curateIx,
  openAuctionIx, auctionBidIx, closeAuctionIx, claimAuctionIx,
} from '../sdk/src/ix.ts';
import {
  SESSION_EVENT, PROGRAM_ID, premiumBps, auctionPda, bidPda, award, VAULT_DISCRIMINATOR,
} from '../sdk/src/vault.ts';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ' — ' + detail}`);
  if (!ok) failed++;
};

for (const [name, bytes] of Object.entries(DISCRIMINATOR)) {
  const want = [...createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)];
  check(`discriminator ${name}`, want.join() === bytes.join(), `${bytes} vs ${want}`);
}

const params = encodeVaultParams({
  markFeedId: new Uint8Array(32).fill(1), equityFeedId: new Uint8Array(32).fill(2),
  fundingKBps: 2500, fundingMaxBps: 50, maxStaleSecs: 900, maxConfBps: 500, maxMoveBps: 5000,
  equityQuietSecs: 3600, fillIncentiveBps: 10, maxCarryDeltaBps: 500, maxUnexpectedClosedSecs: 10800,
  maxPostedSlotAge: 4500, maxBellLeadSecs: 300, maxPremiumBps: 1000, auctionSecs: 120,
  incentiveRamp: [10, 25, 50], requireVerifiedRecap: true,
});
check('VaultParams is 92 v1 bytes + 4+4+2+4+6+1 v2 bytes = 113', params.length === 113 && params.length === VAULT_PARAMS_SIZE, String(params.length));
check('funding_k_bps at offset 64, little-endian', params[64] === 0xc4 && params[65] === 0x09, `${params[64]},${params[65]}`);
check('max_posted_slot_age at offset 92', params[92] === 0x94 && params[93] === 0x11, `${params[92]},${params[93]}`);
check('incentive_ramp at offset 106..112', params[106] === 10 && params[108] === 25 && params[110] === 50);
check('require_verified_recap is the last byte', params[112] === 1);

// initialize_vault args: params, then a borsh string, then the session kind
const k = new PublicKey(new Uint8Array(32));
const acc = {
  authority: k, vault: k, underlyingMint: k, quoteMint: k, nightMint: k, dayMint: k,
  underlyingVault: k, quoteVault: k, markPriceUpdate: k, equityPriceUpdate: k,
};
const init = initializeVaultIx(acc, {
  markFeedId: new Uint8Array(32), equityFeedId: new Uint8Array(32),
  fundingKBps: 0, fundingMaxBps: 0, maxStaleSecs: 1, maxConfBps: 1, maxMoveBps: 1, equityQuietSecs: 60,
  fillIncentiveBps: 0, maxCarryDeltaBps: 0, maxUnexpectedClosedSecs: 3600, maxPostedSlotAge: 1,
  maxBellLeadSecs: 0, maxPremiumBps: 0, auctionSecs: 30, incentiveRamp: [0, 0, 0], requireVerifiedRecap: false,
}, 'OPENAI', SESSION_EVENT, 'https://x.io/m');
const d = init.data;
check('init data = 8 + 113 + (4+6) + 1 + (4+14) bytes', d.length === 8 + 113 + 10 + 1 + 18, String(d.length));
check('symbol is length-prefixed', d[8 + 113] === 6 && d[8 + 113 + 4] === 'O'.charCodeAt(0));
check('session kind follows the symbol', d[8 + 113 + 10] === 1);
check('metadata base is a length-prefixed string', d[8 + 113 + 11] === 14 && d[d.length - 1] === 'm'.charCodeAt(0));
check('the share program is an account, defaulted to Token-2022',
  init.keys[12].pubkey.toBase58() === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', init.keys[12].pubkey.toBase58());
let longBase = false;
try { initializeVaultIx(acc, {} as never, 'NVDA', 0, 'x'.repeat(129)); } catch { longBase = true; }
check('an over-long metadata base is refused before the chain sees it', longBase);
let threw = false;
try { initializeVaultIx(acc, {} as never, 'nvda', 0); } catch { threw = true; }
check('a lowercase symbol is refused before it reaches the chain', threw);
check('Class encodes Night=0 Day=1', classByte('night') === 0 && classByte('day') === 1);
check('hex round-trips', bytesToHex(hexToBytes('0x00ff10')) === '00ff10');

// recap: Vec<RecapEntry> is a u32 count then (i64, u128) pairs, then the absorb flag
const rc = recapIx({ vault: k, authority: k, nightMint: k, dayMint: k }, [
  { boundaryTs: -1, mark: (1n << 64n) + 5n },
  { boundaryTs: 1_774_618_201, mark: 2_203_400_000_000_000_000n },
], true);
const rd = rc.data;
check('recap data = 8 + 4 + 2×24 + 1 bytes', rd.length === 8 + 4 + 48 + 1, String(rd.length));
check('entry count is a u32', rd[8] === 2 && rd[9] === 0);
check('i64 -1 is all ones', rd.subarray(12, 20).every(b => b === 0xff));
check('u128 high word lands at +8', rd[20 + 8] === 1 && rd[20] === 5);
check('absorb flag is the last byte', rd[rd.length - 1] === 1);
check('recap keys are vault, authority(signer), night, day', rc.keys.length === 4 && rc.keys[1].isSigner);
const rc2 = recapIx({ vault: k, authority: k, nightMint: k, dayMint: k }, [{ boundaryTs: 1, mark: 1n }], false, [k]);
check('a Pyth update per entry is appended as a remaining account', rc2.keys.length === 5);
let bad = false;
try { recapIx({ vault: k, authority: k, nightMint: k, dayMint: k }, [{ boundaryTs: 1, mark: 1n }, { boundaryTs: 2, mark: 1n }], false, [k]); } catch { bad = true; }
check('a partial set of Pyth updates is refused', bad);
check('HaltReason encodes by declaration order', haltReasonByte('None') === 0 && haltReasonByte('BadDebt') === 4 && haltReasonByte('Operator') === 6);
const rh = resolveHaltIx({ vault: k, authority: k, nightMint: k, dayMint: k, underlyingMint: k, underlyingVault: k }, 'MissedBoundary');
check('resolve_halt carries the acknowledged reason', rh.data.length === 9 && rh.data[8] === 1 && rh.keys.length === 6);

// An absent Option<Account> is the program id: Anchor's own resolver pops it
// and yields None. Passing nothing at all would make the account list short
// and error out instead.
const settleEquity = settleBoundaryIx({
  vault: k, nightMint: k, dayMint: k, markPriceUpdate: k, equityPriceUpdate: k,
  underlyingMint: k, underlyingVault: k,
});
check('an equity settle passes the program id for both event clocks',
  settleEquity.keys.length === 9
  && settleEquity.keys[7].pubkey.equals(PROGRAM_ID)
  && settleEquity.keys[8].pubkey.equals(PROGRAM_ID));
const other = new PublicKey(new Uint8Array(32).fill(3));
const settleEvent = settleBoundaryIx({
  vault: k, nightMint: k, dayMint: k, markPriceUpdate: k, equityPriceUpdate: k,
  underlyingMint: k, underlyingVault: k, schedule: other, detector: other,
});
check('an event settle passes them', settleEvent.keys[7].pubkey.equals(other));

// set_schedule: Vec<ScheduledEvent> is a u32 count then (i64, u32, u8)
const sched = setScheduleIx(k, k, k, [
  { ts: 1_800_000_000, windowSecs: 7_200, kind: 0 },
  { ts: 1_800_100_000, windowSecs: 3_600, kind: 1 },
]);
check('schedule data = 8 + 4 + 2×13 bytes', sched.data.length === 8 + 4 + 26, String(sched.data.length));
check('the count is a u32', sched.data[8] === 2 && sched.data[9] === 0);
let unordered = false;
try { setScheduleIx(k, k, k, [{ ts: 2, windowSecs: 60, kind: 0 }, { ts: 1, windowSecs: 60, kind: 0 }]); } catch { unordered = true; }
check('out-of-order prints are refused before the chain sees them', unordered);

const det = postDetectorIx(k, k, k, 99_588n, 112_109n);
check('detector data = 8 + 16 + 16 bytes', det.data.length === 40, String(det.data.length));
check('premiumBps mirrors the program on the real OPENAI reading',
  premiumBps({ mark: 99_588n, executable: 112_109n }) === 1_257);
check('a discount diverges as much as a premium',
  premiumBps({ mark: 15_330n, executable: 11_968n }) === 2_193);
check('curate is a single flag', curateIx(k, k, k, true).data.length === 9 && curateIx(k, k, k, false).data[8] === 0);

// the auction: one per bell, so the boundary is in the seed
const vaultKey = new PublicKey(new Uint8Array(32).fill(4));
const [aucA] = auctionPda(vaultKey, 1_774_618_200);
const [aucB] = auctionPda(vaultKey, 1_774_618_201);
check('each bell gets its own auction address', !aucA.equals(aucB));
const [bidKey] = bidPda(aucA, k);
check('a bid is seeded by its auction and bidder', bidPda(aucA, k)[0].equals(bidKey) && !bidPda(aucB, k)[0].equals(bidKey));

const aucAccounts = {
  vault: vaultKey, auction: aucA, underlyingVault: k, quoteVault: k,
  bidderUnderlying: k, bidderQuote: k, bidder: k, underlyingMint: k, quoteMint: k,
};
check('open_auction takes no arguments', openAuctionIx(vaultKey, aucA, k).data.length === 8);
check('auction_bid carries a u64', auctionBidIx(aucAccounts, bidKey, 1_000n).data.length === 16);
check('close_auction takes no arguments', closeAuctionIx(vaultKey, aucA, k).data.length === 8);
check('claim_auction takes no arguments', claimAuctionIx(aucAccounts, bidKey, k, k).data.length === 8);
check('the bidder signs a bid and a claim',
  auctionBidIx(aucAccounts, bidKey, 1n).keys[3].isSigner && claimAuctionIx(aucAccounts, bidKey, k, k).keys[3].isSigner);

// award mirrors the program's arithmetic, including the floor that leaves dust
const WAD = 10n ** 18n;
const twoThirds = { fillRatio: (WAD * 2n) / 3n, clearingMark: 2n * WAD, vaultBuys: true };
const aw = award(twoThirds, 900n, 900n);
check('award matches the program: 900 at two-thirds is 599', aw.underlying === 599n, String(aw.underlying));
check('and every atom is filled or returned', aw.underlying + aw.refund === 900n);
const sell = award({ ...twoThirds, vaultBuys: false }, 900n, 10_000n);
check('a seller pays the ceil, never less', sell.quote >= aw.quote);


/* The account discriminator the catalog scans for. A `getProgramAccounts`
   filter on the wrong eight bytes silently returns nothing, which looks
   exactly like a program nobody has used. */
{
  const want = createHash('sha256').update('account:Vault').digest().subarray(0, 8);
  check('VAULT_DISCRIMINATOR = sha256("account:Vault")[..8]',
    VAULT_DISCRIMINATOR.join(',') === [...want].join(','),
    `${VAULT_DISCRIMINATOR.join(',')} vs ${[...want].join(',')}`);
}

console.log(failed ? `\n${failed} failed` : '\nall instruction checks passed');
process.exit(failed ? 1 : 0);
