/* sdk/src/cross.ts against the Rust it mirrors:
   - 300 crosses from crates/session-core (tests/vectors/cross.json): every
     clearing total and every buyer, seller and maker leg, to the atom;
   - the multiplier read from the real NVDAx mint's bytes, exactly;
   - a raw atom's price, and a limit's units. */
import { readFileSync } from 'node:fs';
import {
  buyerLeg, clear, effectiveSharePrice, emptyLadder, makerLeg, multiplierBitsAt, multiplierWad, priceE8,
  pricePerRawWad, readScaledUi, sellerLeg, WAD,
} from '../sdk/src/cross.ts';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
};
let passed = 0;
const ok = (name: string, cond: boolean, detail = '') => { check(name, cond, detail); if (cond) passed++; };

console.log('clearing (tests/vectors/cross.json, from crates/session-core)');
{
  const doc = JSON.parse(readFileSync('tests/vectors/cross.json', 'utf8'));
  let cases = 0;
  let legs = 0;
  for (const [i, t] of (doc.cases as any[]).entries()) {
    const buys = (t.buys as string[]).map(BigInt);
    const sells = (t.sells as string[]).map(BigInt);
    const offers = (t.offers as [number, string][]).map(([f, q]) => [f, BigInt(q)] as const);
    const ladder = emptyLadder();
    for (const [f, q] of offers) ladder[f] += q;
    const c = clear(BigInt(t.x), buys.reduce((a, b) => a + b, 0n), sells.reduce((a, b) => a + b, 0n), ladder);
    const w = t.clearing;
    const same =
      c.crowded === w.crowded && c.feeBps === w.fee_bps && c.makerPriceWad === BigInt(w.maker_price_wad) &&
      c.marginalFeeBps === w.marginal_fee_bps && c.marginalNeed === BigInt(w.marginal_need) &&
      c.marginalCap === BigInt(w.marginal_cap) && c.buySpent === BigInt(w.buy_spent) &&
      c.buyTokens === BigInt(w.buy_tokens) && c.sellSpent === BigInt(w.sell_spent) && c.sellQuote === BigInt(w.sell_quote);
    check(`case ${i}: clearing`, same, JSON.stringify({ got: c, want: w }, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
    const eq = (a: [bigint, bigint], b: [string, string]) => a[0] === BigInt(b[0]) && a[1] === BigInt(b[1]);
    buys.forEach((b, j) => { check(`case ${i}: buyer ${j}`, eq(buyerLeg(b, c), t.buyer_legs[j])); legs++; });
    sells.forEach((s, j) => { check(`case ${i}: seller ${j}`, eq(sellerLeg(s, c), t.seller_legs[j])); legs++; });
    offers.forEach(([f, q], j) => { check(`case ${i}: maker ${j}`, eq(makerLeg(q, f, c), t.maker_legs[j])); legs++; });
    if (same) cases++;
  }
  ok(`all ${doc.cases.length} clearings match the Rust`, cases === doc.cases.length, `${cases} matched`);
  console.log(`  ${cases} clearings and ${legs} legs compared`);
}

console.log('what a raw atom is worth');
{
  ok('NVDAx until 10 Sep', multiplierWad(0x3ff003c2ac1bf43fn) === 1_000_918_075_849_099_642n);
  ok('NVDAx from 10 Sep', multiplierWad(0x3ff006f7d589fea9n) === 1_001_701_196_801_074_056n);
  ok('one', multiplierWad(0x3ff0000000000000n) === WAD);
  ok('negative, zero, infinite and absurd are refused',
    [0xbff0000000000000n, 0n, 0x7ff0000000000000n, 0x7ff8000000000000n, 0x4140000000000000n].every((b) => multiplierWad(b) === null));
  ok('the scheduled multiplier applies from its second',
    multiplierBitsAt(1n, 2n, 1_789_000_200, 1_789_000_199) === 1n && multiplierBitsAt(1n, 2n, 1_789_000_200, 1_789_000_200) === 2n);
  const m = multiplierWad(0x3ff006f7d589fea9n)!;
  ok('NVDA 224.06 × 1.0017, per raw atom', pricePerRawWad(22_406_000n, -5, m, 6, 8) === 2_244_411_701_552_486_529n);
  ok('a non-positive price is refused', pricePerRawWad(0n, -5, m, 6, 8) === null && pricePerRawWad(-1n, -5, m, 6, 8) === null);
  ok('a limit in 1e-8 dollars', priceE8(22_406_000n, -5) === 22_406_000_000n && priceE8(22_406_000_000n, -8) === 22_406_000_000n);

  const doc = JSON.parse(readFileSync('tests/vectors/issuer-mints.json', 'utf8'));
  const nvdax = readScaledUi(Uint8Array.from(Buffer.from(doc.nvdax.base64, 'base64')));
  ok('reads the real NVDAx mint', nvdax !== null && nvdax !== 'malformed' &&
    nvdax.currentBits === 0x3ff003c2ac1bf43fn && nvdax.newBits === 0x3ff006f7d589fea9n && nvdax.newEffectiveTs === 1_789_000_200);
  const classic = readScaledUi(new Uint8Array(82));
  ok('a classic mint has no multiplier', classic === null);

  // a receipt: 1,000 USDC bought 4.4555… raw NVDAx at X: per share, that is X / m
  const x = 2_244_411_701_552_486_529n;
  const raw = (1_000_000_000n * WAD) / x;
  const perShare = effectiveSharePrice(1_000_000_000n, raw, m, 6, 8)!;
  ok('the price per share a receipt shows is the print', Math.abs(perShare - 224.06) < 0.0001, String(perShare));
}

if (failed) { console.error(`\n${failed} cross check(s) failed`); process.exit(1); }
console.log(`\nall cross checks passed (${passed})`);
