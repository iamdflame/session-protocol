/* The instruction discriminators are precomputed in sdk/src/ix.ts so the module
   can run in a browser without a hashing dependency. This recomputes each one
   the way Anchor does and fails if any has drifted — a wrong discriminator is
   an instruction that silently dispatches to nothing. */
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import {
  DISCRIMINATOR, encodeVaultParams, classByte, hexToBytes, bytesToHex, initializeVaultIx, VAULT_PARAMS_SIZE,
} from '../sdk/src/ix.ts';
import { SESSION_EVENT } from '../sdk/src/vault.ts';

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
}, 'OPENAI', SESSION_EVENT);
const d = init.data;
check('init data = 8 + 113 + (4 + 6) + 1 bytes', d.length === 8 + 113 + 10 + 1, String(d.length));
check('symbol is length-prefixed', d[8 + 113] === 6 && d[8 + 113 + 4] === 'O'.charCodeAt(0));
check('session kind is the last byte', d[d.length - 1] === 1);
let threw = false;
try { initializeVaultIx(acc, {} as never, 'nvda', 0); } catch { threw = true; }
check('a lowercase symbol is refused before it reaches the chain', threw);
check('Class encodes Night=0 Day=1', classByte('night') === 0 && classByte('day') === 1);
check('hex round-trips', bytesToHex(hexToBytes('0x00ff10')) === '00ff10');

console.log(failed ? `\n${failed} failed` : '\nall instruction checks passed');
process.exit(failed ? 1 : 0);
