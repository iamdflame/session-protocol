/* The SDK decoder must agree with the program's serializer, byte for byte. */
import { readFileSync } from 'node:fs';
import { decodeVault, PAUSE_REDEEM } from '../sdk/src/vault.ts';

const doc = JSON.parse(readFileSync('tests/vectors/vault-account.json', 'utf8'));
const bytes = Uint8Array.from(doc.bytes as number[]);
console.log(`decoding ${doc.size} bytes (allocated ${doc.allocated})`);

const v = decodeVault(bytes);
let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = String(got) === String(want);
  if (!ok) { console.log(`  FAIL ${name}: got ${got}, want ${want}`); failed++; }
  else console.log(`  ok   ${name} = ${got}`);
};

eq('version', v.version, 2);
eq('bump', v.bump, 253);
eq('authority', v.authority.toBuffer()[0], 1);
eq('pendingAuthority', v.pendingAuthority.toBuffer()[0], 2);
eq('underlyingDecimals', v.underlyingDecimals, 8);
eq('quoteDecimals', v.quoteDecimals, 6);
eq('ownedUnderlying', v.ownedUnderlying, 123456789n);
eq('ownedQuote', v.ownedQuote, 987654321n);
eq('nightMint', v.nightMint.toBuffer()[0], 7);
eq('dayMint', v.dayMint.toBuffer()[0], 8);
eq('markFeedId[0]', v.markFeedId[0], 9);
eq('equityFeedId[0]', v.equityFeedId[0], 10);
eq('nightNav', v.nightNav, 1100000000000000000n);
eq('dayNav', v.dayNav, 900000000000000000n);
eq('lastMark', v.lastMark, 2203400000000000000n);
eq('exposed', v.exposed, 'day');
eq('lastSessionOpen', v.lastSessionOpen, true);
eq('lastBoundaryTs', v.lastBoundaryTs, 1774618201);
eq('boundaryCount', v.boundaryCount, 4242n);
eq('pendingDelta (negative i128)', v.pendingDelta, -191333n);
eq('fundingKBps', v.fundingKBps, 2500);
eq('maxConfBps', v.maxConfBps, 100);
eq('maxMoveBps', v.maxMoveBps, 2000);
eq('equityQuietSecs', v.equityQuietSecs, 900);
eq('fillIncentiveBps', v.fillIncentiveBps, 10);
eq('maxCarryDeltaBps', v.maxCarryDeltaBps, 200);
eq('maxUnexpectedClosedSecs', v.maxUnexpectedClosedSecs, 21600);
eq('flags', v.flags, PAUSE_REDEEM);
eq('halted', v.halted, true);
eq('haltReason', v.haltReason, 'MissedBoundary');
eq('cumFundingNight (negative i128)', v.cumFundingNight, -55555n);
eq('cumFillIncentive', v.cumFillIncentive, 777n);
eq('totalMintedNight', v.totalMintedNight, 111111n);
eq('totalMintedDay', v.totalMintedDay, 222222n);
// v2
eq('sessionKind', v.sessionKind, 1);
eq('symbol (NUL-padded)', v.symbol, 'OPENAI');
eq('maxPostedSlotAge', v.maxPostedSlotAge, 4500);
eq('maxBellLeadSecs', v.maxBellLeadSecs, 300);
eq('maxPremiumBps', v.maxPremiumBps, 1000);
eq('auctionSecs', v.auctionSecs, 120);
eq('incentiveRamp', v.incentiveRamp.join(','), '10,25,50');
eq('requireVerifiedRecap', v.requireVerifiedRecap, true);
eq('fillPausedUntil', v.fillPausedUntil, 1774618321);
eq('lastRecapTs', v.lastRecapTs, 1774500000);
eq('recapCount', v.recapCount, 3);
eq('detectorAuthority', v.detectorAuthority.toBuffer()[0], 11);
eq('shareTokenProgram', v.shareTokenProgram.toBuffer()[0], 12);
eq('creator', v.creator.toBuffer()[0], 13);
eq('createdAt', v.createdAt, 1774000000);
eq('escrowedQuote', v.escrowedQuote, 4242n);
eq('escrowedUnderlying', v.escrowedUnderlying, 99n);
eq('curated', v.curated, true);

// a truncated account must fail loudly rather than return nonsense
try {
  decodeVault(bytes.subarray(0, 100));
  console.log('  FAIL truncated account decoded without error'); failed++;
} catch { console.log('  ok   truncated account is rejected'); }

// so must one written by another program version
const wrong = Uint8Array.from(bytes); wrong[8] = 99;
try {
  decodeVault(wrong);
  console.log('  FAIL wrong version decoded'); failed++;
} catch (e) { console.log(`  ok   wrong version rejected (${(e as Error).message.slice(0, 40)}…)`); }

console.log(failed ? `\n${failed} FAILURES` : '\nlayout matches the program exactly');
process.exit(failed ? 1 : 0);
