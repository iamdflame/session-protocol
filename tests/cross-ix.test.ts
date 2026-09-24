/* sdk/src/cross-ix.ts against the program:
   - every discriminator, recomputed the way Anchor computes it;
   - the market, cross, order and offer layouts, decoded from bytes the
     program's own serializer wrote (tests/vectors/cross-accounts.json);
   - a decoded clearing feeds sdk/src/cross.ts's legs unchanged. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import {
  CROSS_ACCOUNT, CROSS_DISCRIMINATOR, decodeCross, decodeMarket, decodeOffer, decodeOrder, encodeMarketParams,
  OFFSETS, placeOrderIx, crossPda, orderPda, marketPda, type MarketRef,
} from '../sdk/src/cross-ix.ts';
import { buyerLeg, makerLeg, sellerLeg } from '../sdk/src/cross.ts';

let failed = 0;
let passed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) passed++;
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
};
const eq = (name: string, got: unknown, want: unknown) => check(name, String(got) === String(want), `${got} vs ${want}`);

for (const [name, bytes] of Object.entries(CROSS_DISCRIMINATOR)) {
  const want = [...createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)];
  check(`global:${name}`, want.join() === bytes.join(), `${bytes} vs ${want}`);
}
for (const [name, bytes] of Object.entries(CROSS_ACCOUNT)) {
  const want = [...createHash('sha256').update(`account:${name}`).digest().subarray(0, 8)];
  check(`account:${name}`, want.join() === bytes.join(), `${bytes} vs ${want}`);
}

const doc = JSON.parse(readFileSync('tests/vectors/cross-accounts.json', 'utf8'));
const bytes = (k: string) => Uint8Array.from(doc[k] as number[]);
const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));

const m = decodeMarket(bytes('market'));
eq('market.active', m.active, true);
eq('market.listing', m.listing.toBase58(), key(7).toBase58());
eq('market.mint', m.mint.toBase58(), key(8).toBase58());
eq('market.mintDecimals', m.mintDecimals, 8);
eq('market.quoteDecimals', m.quoteDecimals, 6);
eq('market.quoteEscrow', m.quoteEscrow.toBase58(), key(13).toBase58());
eq('market.params.freezeSecs', m.params.freezeSecs, 120);
eq('market.params.maxSideRaw', m.params.maxSideRaw, 1_000_000_000_000n);
eq('market.params.multiplierGuardSecs', m.params.multiplierGuardSecs, 900);
eq('market.params.acceptSimulated', m.params.acceptSimulated, true);
eq('market.orders', m.orders, 345n);
eq('params re-encode to the same bytes', Array.from(encodeMarketParams(m.params)).join(), Array.from(bytes('market').subarray(8 + 3 + 32 + 32 + 1 + 32 + 32 + 1 + 32 + 32 + 32, 8 + 3 + 32 + 32 + 1 + 32 + 32 + 1 + 32 + 32 + 32 + 53)).join());

const c = decodeCross(bytes('cross'));
eq('cross.phase', c.phase, 'settling');
eq('cross.kind', c.kind, 'close');
eq('cross.crowded', c.crowded, 'buyers');
eq('cross.simulated', c.simulated, true);
eq('cross.day', c.day, 20720);
eq('cross.bellTs', c.bellTs, 1_790_280_000);
eq('cross.priceE8', c.priceE8, 22_406_000_000n);
eq('cross.multiplierWad', c.multiplierWad, 1_001_701_196_801_074_056n);
eq('cross.clearing.priceWad', c.clearing.priceWad, 2_244_411_701_552_486_529n);
eq('cross.nOrders', c.nOrders, 5);
eq('cross.ladder[15]', c.ladder[15], 500_000_000n);
eq('cross.ladder[40]', c.ladder[40], 250_000_000n);
eq('cross.clearing.feeBps', c.clearing.feeBps, 15);
eq('cross.clearing.marginalNeed', c.clearing.marginalNeed, 467_625_142n);
eq('cross.clearing.buyIn', c.clearing.buyIn, 1_500_000_000n);
eq('cross.clearing.sellQuote', c.clearing.sellQuote, 448_882_340n);
eq('cross.rawOut', c.rawOut, 445_083_428n);
eq('cross.clearedAt', c.clearedAt, 1_790_280_421);
// the decoded clearing drives the legs directly
eq('a decoded clearing settles a seller', sellerLeg(200_000_000n, c.clearing).join(), '200000000,448882340');
check('and a buyer and a maker', buyerLeg(1_000_000_000n, c.clearing)[1] > 0n && makerLeg(500_000_000n, 15, c.clearing)[0] > 0n);
eq('crossMarket offset', bytes('cross')[OFFSETS.crossMarket], 1);

const o = decodeOrder(bytes('order'));
eq('order.side', o.side, 'sell');
eq('order.status', o.status, 'in band');
eq('order.legs', o.legs, 1);
eq('order.owner', o.owner.toBase58(), key(5).toBase58());
eq('order.nonce', o.nonce, 7);
eq('order.limitE8', o.limitE8, 20_000_000_000n);
eq('orderCross offset', bytes('order')[OFFSETS.orderCross], 4);
eq('orderOwner offset', bytes('order')[OFFSETS.orderOwner], 5);

const f = decodeOffer(bytes('offer'));
eq('offer.side', f.side, 'buyers');
eq('offer.feeBps', f.feeBps, 15);
eq('offer.maker', f.maker.toBase58(), key(6).toBase58());
eq('offer.size', f.size, 500_000_000n);
eq('offerCross offset', bytes('offer')[OFFSETS.offerCross], 4);

// a place_order instruction: data layout and the accounts it names
{
  const mint = key(8);
  const market = marketPda(mint);
  const ref: MarketRef = {
    market, mint, mintProgram: key(9), quoteMint: key(10), quoteProgram: key(11),
    rawEscrow: key(12), quoteEscrow: key(13), listing: key(7),
  };
  const owner = key(20);
  const i = placeOrderIx(ref, { owner, day: 20720, kind: 'close', nonce: 3, side: 'buy', amount: 1_000_000_000n, limitE8: 23_000_000_000n });
  const d = i.data;
  eq('place_order data is 8 + 8 + 1 + 2 + 1 + 8 + 8', d.length, 36);
  eq('its side byte', d[19], 0);
  const cross = crossPda(market, 20720, 'close');
  eq('it names the cross', i.keys[2].pubkey.toBase58(), cross.toBase58());
  eq('and the order', i.keys[3].pubkey.toBase58(), orderPda(cross, owner, 3).toBase58());
  eq('and the quote escrow for a buy', i.keys[7].pubkey.toBase58(), key(13).toBase58());
}

if (failed) { console.error(`\n${failed} cross-ix check(s) failed`); process.exit(1); }
console.log(`all cross-ix checks passed (${passed})`);
