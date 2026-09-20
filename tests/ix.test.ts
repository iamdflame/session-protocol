/* The instruction discriminators are precomputed in sdk/src/ix.ts so the module
   can run in a browser without a hashing dependency. This recomputes each one
   the way Anchor does and fails if any has drifted — a wrong discriminator is
   an instruction that silently dispatches to nothing. */
import { createHash } from 'node:crypto';
import { DISCRIMINATOR, encodeVaultParams, classByte, hexToBytes, bytesToHex } from '../sdk/src/ix.ts';

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
});
check('VaultParams is 32+32+4+4+4+2+2+4+2+2+4 = 92 bytes', params.length === 92, String(params.length));
check('funding_k_bps at offset 64, little-endian', params[64] === 0xc4 && params[65] === 0x09, `${params[64]},${params[65]}`);
check('Class encodes Night=0 Day=1', classByte('night') === 0 && classByte('day') === 1);
check('hex round-trips', bytesToHex(hexToBytes('0x00ff10')) === '00ff10');

console.log(failed ? `\n${failed} failed` : '\nall instruction checks passed');
process.exit(failed ? 1 : 0);
