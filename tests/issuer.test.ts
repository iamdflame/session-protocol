/* The SDK's issuer parser must agree with the program's, on the real mints. */
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { inspectMint, transferFee, uiMultiplier, toUi, issuerPowers } from '../sdk/src/issuer.ts';

const doc = JSON.parse(readFileSync('tests/vectors/issuer-mints.json', 'utf8'));
const load = (name: string) => {
  const m = doc[name];
  return { data: Uint8Array.from(Buffer.from(m.base64, 'base64')), owner: new PublicKey(m.owner) };
};

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ' — ' + detail}`);
  if (!ok) failed++;
};

const nv = load('nvdax');
const n = inspectMint(nv.data, nv.owner, 1039);
check('NVDAx is Token-2022', n.token2022);
check('NVDAx has 8 decimals', n.decimals === 8, String(n.decimals));
check('NVDAx hook slot exists and is unset', n.hookSlot && n.hookProgram === null);
check('NVDAx is pausable and not paused', n.pausable && !n.paused);
check('NVDAx has a permanent delegate', n.permanentDelegate !== null);
check('NVDAx has a freeze authority', n.freezeAuthority !== null);
check('NVDAx has no transfer fee', n.transferFeeBps === 0);
check('NVDAx scaled UI multiplier ≈ 1.000918', !!n.scaledUi && Math.abs(n.scaledUi.multiplier - 1.000918) < 1e-5, String(n.scaledUi?.multiplier));
check('NVDAx scheduled multiplier ≈ 1.0017 in the future', !!n.scaledUi && n.scaledUi.newMultiplier > 1.0016 && n.scaledUi.newMultiplierEffectiveTs > 1_780_000_000);
check('NVDAx metadata reads', n.metadata?.symbol === 'NVDAx' && /NVIDIA/.test(n.metadata?.name ?? ''), JSON.stringify(n.metadata));
check('the multiplier in force now is the current one', uiMultiplier(n, 1_760_000_000) === n.scaledUi!.multiplier);
check('the multiplier after the switch is the new one', uiMultiplier(n, n.scaledUi!.newMultiplierEffectiveTs) === n.scaledUi!.newMultiplier);
check('toUi applies decimals then the multiplier', Math.abs(toUi(100_000_000n, 8, 1.000918) - 1.000918) < 1e-12);
check('powers are listed', issuerPowers(n).length >= 5, issuerPowers(n).join(' | '));

const oa = load('openai');
const o1038 = inspectMint(oa.data, oa.owner, 1038);
const o = inspectMint(oa.data, oa.owner, 1039);
check('OPENAI fee was 50 bp before epoch 1039', o1038.transferFeeBps === 50);
check('OPENAI fee is 100 bp from epoch 1039', o.transferFeeBps === 100 && o.transferFeeMax === (1n << 64n) - 1n);
check('OPENAI fee math matches the program (1e9 → 1e7, 1 → 1, 12345 → 124)',
  transferFee(o, 1_000_000_000n) === 10_000_000n && transferFee(o, 1n) === 1n && transferFee(o, 12_345n) === 124n);
check('OPENAI scaled UI 1 → 1.486 scheduled', !!o.scaledUi && o.scaledUi.multiplier === 1 && Math.abs(o.scaledUi.newMultiplier - 1.4861347) < 1e-6);
check('OPENAI has confidential transfer', o.confidentialTransfer);
check('OPENAI metadata', o.metadata?.symbol === 'OPENAI', JSON.stringify(o.metadata));

const us = load('usdc');
const u = inspectMint(us.data, us.owner, 1039);
check('USDC is classic with no powers beyond freeze', !u.token2022 && !u.pausable && !u.hookSlot && u.transferFeeBps === 0 && u.permanentDelegate === null && u.decimals === 6);
check('USDC has a freeze authority (Circle)', u.freezeAuthority !== null);
check('classic mints pay no fee', transferFee(u, 1_000_000n) === 0n);

console.log(failed ? `\n${failed} failed` : '\nall issuer checks passed');
process.exit(failed ? 1 : 0);
