/* ───────────────────────────────────────────────────────────────────────────
   The cross, on chain: addresses, accounts and instructions for
   programs/session-cross.

   sdk/src/cross.ts is the arithmetic; this is the program around it. Both
   run in a browser: no Buffer, no node:crypto. The discriminators are
   recomputed by tests/cross-ix.test.ts, and the account layouts are pinned
   by tests/vectors/cross-accounts.json, which the program's own serializer
   wrote. Every account list is in the order of the `#[derive(Accounts)]`
   struct it mirrors.
   ─────────────────────────────────────────────────────────────────────────── */

import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { LADDER, type Clearing, type Crowded } from './cross.ts';
import { printPda, type BellKind, KIND } from './bell.ts';

export const CROSS_PROGRAM_ID = new PublicKey('Crosf1CpgcEs6G6SiX2B7KMR4hxVcE2FGU2r53a3RK9K');
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/** `sha256("global:<name>")[..8]`, recomputed by tests/cross-ix.test.ts. */
export const CROSS_DISCRIMINATOR: Record<string, number[]> = {
  init_config:    [23, 235, 115, 232, 168, 96, 1, 231],
  transfer_admin: [42, 242, 66, 106, 228, 10, 111, 156],
  accept_admin:   [112, 42, 45, 90, 116, 181, 13, 170],
  create_market:  [103, 226, 97, 235, 200, 188, 251, 254],
  set_market:     [24, 133, 119, 187, 28, 115, 163, 81],
  place_order:    [51, 194, 155, 175, 109, 130, 96, 106],
  cancel_order:   [95, 129, 237, 240, 8, 49, 223, 132],
  price_cross:    [168, 52, 57, 122, 152, 67, 27, 197],
  cancel_cross:   [15, 34, 8, 255, 96, 50, 169, 245],
  confirm_orders: [75, 66, 29, 213, 26, 208, 197, 185],
  post_offer:     [73, 150, 193, 114, 200, 133, 74, 58],
  clear:          [250, 39, 28, 213, 123, 163, 133, 5],
  settle_order:   [80, 74, 204, 34, 12, 183, 66, 66],
  settle_offer:   [40, 52, 19, 31, 0, 165, 52, 30],
  close_cross:    [106, 83, 120, 149, 161, 163, 38, 124],
};

export const CROSS_ACCOUNT: Record<'CrossConfig' | 'Market' | 'Cross' | 'Order' | 'Offer', number[]> = {
  CrossConfig: [165, 194, 126, 106, 119, 240, 243, 26],
  Market:      [219, 190, 213, 55, 0, 227, 198, 154],
  Cross:       [87, 211, 126, 176, 151, 205, 171, 235],
  Order:       [134, 173, 223, 185, 77, 86, 28, 51],
  Offer:       [215, 88, 60, 71, 170, 162, 73, 229],
};

export const CROSS_VERSION = 1;
export const SIDE = { buy: 0, sell: 1 } as const;
export type Side = keyof typeof SIDE;
export const PHASE = ['collecting', 'confirming', 'auction', 'settling', 'cancelled'] as const;
export type Phase = (typeof PHASE)[number];
export const ORDER_STATUS = ['open', 'in band', 'out of band'] as const;
export const LEG_QUOTE = 1;
export const LEG_RAW = 2;
export const LEGS = 3;
export const CANCEL_REASON: Record<number, string> = {
  1: 'the bell has no print',
  2: 'a multiplier activation fell within 15 minutes of the bell',
  3: 'the mint’s multiplier could not be read',
  4: 'Pyth’s redemption rate disagreed with the mint’s multiplier',
  5: 'the print could not be priced',
  6: 'no final print within six hours',
};

/* ── bytes ───────────────────────────────────────────────────────────────── */

const enc = new TextEncoder();
const u8 = (v: number) => Uint8Array.of(v & 0xff);
const u16 = (v: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b; };
const u32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const u64 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b; };
const i64 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, v, true); return b; };
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const disc = (name: string) => Uint8Array.from(CROSS_DISCRIMINATOR[name]);

/* ── addresses ───────────────────────────────────────────────────────────── */

const find = (seeds: Uint8Array[], program = CROSS_PROGRAM_ID) => PublicKey.findProgramAddressSync(seeds, program)[0];

export const crossConfigPda = (program = CROSS_PROGRAM_ID) => find([enc.encode('cross-config')], program);
export const marketPda = (mint: PublicKey, program = CROSS_PROGRAM_ID) => find([enc.encode('market'), mint.toBytes()], program);
export const rawEscrowPda = (market: PublicKey, program = CROSS_PROGRAM_ID) => find([enc.encode('raw-escrow'), market.toBytes()], program);
export const quoteEscrowPda = (market: PublicKey, program = CROSS_PROGRAM_ID) => find([enc.encode('quote-escrow'), market.toBytes()], program);
export const crossPda = (market: PublicKey, day: number, kind: BellKind, program = CROSS_PROGRAM_ID) =>
  find([enc.encode('cross'), market.toBytes(), i64(BigInt(day)), u8(KIND[kind])], program);
export const orderPda = (cross: PublicKey, owner: PublicKey, nonce: number, program = CROSS_PROGRAM_ID) =>
  find([enc.encode('order'), cross.toBytes(), owner.toBytes(), u16(nonce)], program);
export const offerPda = (cross: PublicKey, maker: PublicKey, nonce: number, program = CROSS_PROGRAM_ID) =>
  find([enc.encode('offer'), cross.toBytes(), maker.toBytes(), u16(nonce)], program);
export const ataOf = (owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey) =>
  find([owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()], ATA_PROGRAM);

/* ── accounts ────────────────────────────────────────────────────────────── */

class Cur {
  private at: number;
  private readonly b: Uint8Array;
  private readonly dv: DataView;
  constructor(b: Uint8Array, at = 0) { this.b = b; this.at = at; this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  private need(n: number): number {
    if (this.at + n > this.b.length) throw new Error(`cross account truncated at ${this.at} (+${n} of ${this.b.length})`);
    const a = this.at;
    this.at += n;
    return a;
  }
  u8(): number { return this.dv.getUint8(this.need(1)); }
  bool(): boolean { return this.u8() !== 0; }
  u16(): number { return this.dv.getUint16(this.need(2), true); }
  i16(): number { return this.dv.getInt16(this.need(2), true); }
  u32(): number { return this.dv.getUint32(this.need(4), true); }
  u64(): bigint { return this.dv.getBigUint64(this.need(8), true); }
  i64(): bigint { return this.dv.getBigInt64(this.need(8), true); }
  u128(): bigint { const lo = this.u64(); const hi = this.u64(); return (hi << 64n) | lo; }
  key(): PublicKey { const a = this.need(32); return new PublicKey(this.b.slice(a, a + 32)); }
}

function expect(data: Uint8Array, name: keyof typeof CROSS_ACCOUNT): Cur {
  const want = CROSS_ACCOUNT[name];
  if (data.length < 9 || want.some((b, i) => data[i] !== b)) throw new Error(`not a ${name} account`);
  if (data[8] !== CROSS_VERSION) throw new Error(`${name} version ${data[8]}, expected ${CROSS_VERSION}`);
  return new Cur(data, 8);
}

export interface MarketParams {
  freezeSecs: number; auctionSecs: number; cancelAfterSecs: number; maxFeeBps: number;
  minOrderQuote: bigint; minOrderRaw: bigint; maxSideQuote: bigint; maxSideRaw: bigint;
  rrToleranceBps: number; multiplierGuardSecs: number; acceptSimulated: boolean;
}

export function encodeMarketParams(p: MarketParams): Uint8Array {
  return concat(
    u32(p.freezeSecs), u32(p.auctionSecs), u32(p.cancelAfterSecs), u16(p.maxFeeBps),
    u64(p.minOrderQuote), u64(p.minOrderRaw), u64(p.maxSideQuote), u64(p.maxSideRaw),
    u16(p.rrToleranceBps), u32(p.multiplierGuardSecs), u8(p.acceptSimulated ? 1 : 0),
  );
}

export interface Market {
  version: number; bump: number; active: boolean; listing: PublicKey;
  mint: PublicKey; mintDecimals: number; mintProgram: PublicKey;
  quoteMint: PublicKey; quoteDecimals: number; quoteProgram: PublicKey;
  rawEscrow: PublicKey; quoteEscrow: PublicKey; params: MarketParams; crosses: bigint; orders: bigint;
}

export function decodeMarket(data: Uint8Array): Market {
  const c = expect(data, 'Market');
  return {
    version: c.u8(), bump: c.u8(), active: c.bool(), listing: c.key(),
    mint: c.key(), mintDecimals: c.u8(), mintProgram: c.key(),
    quoteMint: c.key(), quoteDecimals: c.u8(), quoteProgram: c.key(),
    rawEscrow: c.key(), quoteEscrow: c.key(),
    params: {
      freezeSecs: c.u32(), auctionSecs: c.u32(), cancelAfterSecs: c.u32(), maxFeeBps: c.u16(),
      minOrderQuote: c.u64(), minOrderRaw: c.u64(), maxSideQuote: c.u64(), maxSideRaw: c.u64(),
      rrToleranceBps: c.u16(), multiplierGuardSecs: c.u32(), acceptSimulated: c.bool(),
    },
    crosses: c.u64(), orders: c.u64(),
  };
}

export interface CrossAccount {
  version: number; bump: number; phase: Phase; kind: BellKind; crowded: Crowded; simulated: boolean;
  market: PublicKey; day: number; bellTs: number; createdBy: PublicKey;
  print: PublicKey; priceMantissa: bigint; priceExpo: number; priceE8: bigint; multiplierWad: bigint;
  nOrders: number; nConfirmed: number; nSettled: number; buyTotal: bigint; sellTotal: bigint;
  auctionEnd: number; nOffers: number; nOffersSettled: number; ladder: bigint[];
  /** The clearing, in the shape sdk/src/cross.ts computes it. */
  clearing: Clearing;
  quoteIn: bigint; quoteOut: bigint; rawIn: bigint; rawOut: bigint; pricedAt: number; clearedAt: number;
}

export function decodeCross(data: Uint8Array): CrossAccount {
  const c = expect(data, 'Cross');
  const version = c.u8();
  const bump = c.u8();
  const phase = PHASE[c.u8()] ?? 'collecting';
  const kind: BellKind = c.u8() === 0 ? 'open' : 'close';
  const crowdedByte = c.u8();
  const crowded: Crowded = crowdedByte === 1 ? 'buyers' : crowdedByte === 2 ? 'sellers' : 'balanced';
  const simulated = c.bool();
  const market = c.key();
  const day = Number(c.i64());
  const bellTs = Number(c.i64());
  const createdBy = c.key();
  const print = c.key();
  const priceMantissa = c.i64();
  const priceExpo = c.i16();
  const priceE8 = c.u64();
  const multiplierWad = c.u128();
  const priceWad = c.u128();
  const nOrders = c.u32();
  const nConfirmed = c.u32();
  const nSettled = c.u32();
  const buyTotal = c.u64();
  const sellTotal = c.u64();
  const buyIn = c.u64();
  const sellIn = c.u64();
  const auctionEnd = Number(c.i64());
  const nOffers = c.u32();
  const nOffersSettled = c.u32();
  const ladder = Array.from({ length: LADDER }, () => c.u64());
  const feeBps = c.u16();
  const makerPriceWad = c.u128();
  const marginalFeeBps = c.u16();
  const marginalNeed = c.u128();
  const marginalCap = c.u128();
  const buySpent = c.u128();
  const buyTokens = c.u128();
  const sellSpent = c.u128();
  const sellQuote = c.u128();
  return {
    version, bump, phase, kind, crowded, simulated, market, day, bellTs, createdBy, print,
    priceMantissa, priceExpo, priceE8, multiplierWad, nOrders, nConfirmed, nSettled, buyTotal, sellTotal,
    auctionEnd, nOffers, nOffersSettled, ladder,
    clearing: {
      crowded, priceWad, feeBps, makerPriceWad, marginalFeeBps, marginalNeed, marginalCap,
      buyIn, buySpent, buyTokens, sellIn, sellSpent, sellQuote,
    },
    quoteIn: c.u64(), quoteOut: c.u64(), rawIn: c.u64(), rawOut: c.u64(),
    pricedAt: Number(c.i64()), clearedAt: Number(c.i64()),
  };
}

export interface OrderAccount {
  version: number; bump: number; side: Side; status: (typeof ORDER_STATUS)[number]; legs: number;
  cross: PublicKey; owner: PublicKey; nonce: number; amount: bigint; limitE8: bigint; placedAt: number;
}

export function decodeOrder(data: Uint8Array): OrderAccount {
  const c = expect(data, 'Order');
  return {
    version: c.u8(), bump: c.u8(), side: c.u8() === 0 ? 'buy' : 'sell', status: ORDER_STATUS[c.u8()] ?? 'open',
    legs: c.u8(), cross: c.key(), owner: c.key(), nonce: c.u16(), amount: c.u64(), limitE8: c.u64(),
    placedAt: Number(c.i64()),
  };
}

export interface OfferAccount {
  version: number; bump: number; side: Crowded; legs: number; feeBps: number;
  cross: PublicKey; maker: PublicKey; nonce: number; size: bigint; postedAt: number;
}

export function decodeOffer(data: Uint8Array): OfferAccount {
  const c = expect(data, 'Offer');
  const version = c.u8();
  const bump = c.u8();
  const sideByte = c.u8();
  return {
    version, bump, side: sideByte === 1 ? 'buyers' : sideByte === 2 ? 'sellers' : 'balanced',
    legs: c.u8(), feeBps: c.u16(), cross: c.key(), maker: c.key(), nonce: c.u16(), size: c.u64(),
    postedAt: Number(c.i64()),
  };
}

/** Offsets for `getProgramAccounts` memcmp filters. */
export const OFFSETS = {
  crossMarket: 8 + 6,
  orderCross: 8 + 5,
  orderOwner: 8 + 5 + 32,
  offerCross: 8 + 6,
};

/* ── instructions ────────────────────────────────────────────────────────── */

const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });
const ix = (keys: ReturnType<typeof w>[], data: Uint8Array, program = CROSS_PROGRAM_ID) =>
  new TransactionInstruction({ programId: program, keys, data: data as Buffer });

/** What a client needs to know about a market to build its instructions. */
export interface MarketRef {
  market: PublicKey; mint: PublicKey; mintProgram: PublicKey; quoteMint: PublicKey; quoteProgram: PublicKey;
  rawEscrow: PublicKey; quoteEscrow: PublicKey; listing: PublicKey; program?: PublicKey;
}

export const marketRef = (address: PublicKey, m: Market, program = CROSS_PROGRAM_ID): MarketRef => ({
  market: address, mint: m.mint, mintProgram: m.mintProgram, quoteMint: m.quoteMint, quoteProgram: m.quoteProgram,
  rawEscrow: m.rawEscrow, quoteEscrow: m.quoteEscrow, listing: m.listing, program,
});

function sideAccounts(m: MarketRef, side: Side): [PublicKey, PublicKey, PublicKey] {
  return side === 'buy' ? [m.quoteMint, m.quoteEscrow, m.quoteProgram] : [m.mint, m.rawEscrow, m.mintProgram];
}

export function placeOrderIx(m: MarketRef, a: { owner: PublicKey; day: number; kind: BellKind; nonce: number; side: Side; amount: bigint; limitE8?: bigint }) {
  const program = m.program ?? CROSS_PROGRAM_ID;
  const cross = crossPda(m.market, a.day, a.kind, program);
  const [mint, escrow, tokenProgram] = sideAccounts(m, a.side);
  return ix([
    w(a.owner, true), w(m.market), w(cross), w(orderPda(cross, a.owner, a.nonce, program)), r(m.mint), r(mint),
    w(ataOf(a.owner, mint, tokenProgram)), w(escrow), r(tokenProgram), r(SystemProgram.programId),
  ], concat(
    disc('place_order'), i64(BigInt(a.day)), u8(KIND[a.kind]), u16(a.nonce), u8(SIDE[a.side]), u64(a.amount), u64(a.limitE8 ?? 0n),
  ), program);
}

export function cancelOrderIx(m: MarketRef, a: { owner: PublicKey; day: number; kind: BellKind; nonce: number; side: Side }) {
  const program = m.program ?? CROSS_PROGRAM_ID;
  const cross = crossPda(m.market, a.day, a.kind, program);
  const [mint, escrow, tokenProgram] = sideAccounts(m, a.side);
  return ix([
    w(a.owner, true), r(m.market), w(cross), w(orderPda(cross, a.owner, a.nonce, program)), r(mint),
    w(ataOf(a.owner, mint, tokenProgram)), w(escrow), r(tokenProgram),
  ], disc('cancel_order'), program);
}

export function priceCrossIx(m: MarketRef, a: { day: number; kind: BellKind; bellProgram?: PublicKey }) {
  const program = m.program ?? CROSS_PROGRAM_ID;
  const print = printPda(m.listing, a.day, a.kind, a.bellProgram)[0];
  return ix([w(crossPda(m.market, a.day, a.kind, program)), r(m.market), r(print), r(m.mint)], disc('price_cross'), program);
}

export function cancelCrossIx(m: MarketRef, a: { day: number; kind: BellKind }) {
  const program = m.program ?? CROSS_PROGRAM_ID;
  return ix([w(crossPda(m.market, a.day, a.kind, program)), r(m.market)], disc('cancel_cross'), program);
}

export function confirmOrdersIx(m: MarketRef, a: { day: number; kind: BellKind; orders: PublicKey[] }) {
  const program = m.program ?? CROSS_PROGRAM_ID;
  return ix([w(crossPda(m.market, a.day, a.kind, program)), r(m.market), ...a.orders.map((o) => w(o))], disc('confirm_orders'), program);
}

/** `side`: what the maker escrows. 'sell' offers raw tokens to crowded buyers; 'buy' offers quote to crowded sellers. */
export function postOfferIx(m: MarketRef, a: { maker: PublicKey; day: number; kind: BellKind; nonce: number; side: Side; size: bigint; feeBps: number }) {
  const program = m.program ?? CROSS_PROGRAM_ID;
  const cross = crossPda(m.market, a.day, a.kind, program);
  const [mint, escrow, tokenProgram] = sideAccounts(m, a.side);
  return ix([
    w(a.maker, true), r(m.market), w(cross), w(offerPda(cross, a.maker, a.nonce, program)), r(m.mint), r(mint),
    w(ataOf(a.maker, mint, tokenProgram)), w(escrow), r(tokenProgram), r(SystemProgram.programId),
  ], concat(disc('post_offer'), u16(a.nonce), u64(a.size), u16(a.feeBps)), program);
}

export function clearIx(m: MarketRef, a: { day: number; kind: BellKind }) {
  const program = m.program ?? CROSS_PROGRAM_ID;
  return ix([w(crossPda(m.market, a.day, a.kind, program))], disc('clear'), program);
}

function settleKeys(m: MarketRef, cranker: PublicKey, cross: PublicKey, account: PublicKey, owner: PublicKey) {
  return [
    w(cranker, true), r(m.market), w(cross), w(account), w(owner),
    w(ataOf(owner, m.mint, m.mintProgram)), w(ataOf(owner, m.quoteMint, m.quoteProgram)),
    w(m.rawEscrow), w(m.quoteEscrow), r(m.mint), r(m.quoteMint), r(m.mintProgram), r(m.quoteProgram),
    r(ATA_PROGRAM), r(SystemProgram.programId),
  ];
}

export function settleOrderIx(m: MarketRef, a: { cranker: PublicKey; day: number; kind: BellKind; owner: PublicKey; nonce: number; legs?: number }) {
  const program = m.program ?? CROSS_PROGRAM_ID;
  const cross = crossPda(m.market, a.day, a.kind, program);
  return ix(settleKeys(m, a.cranker, cross, orderPda(cross, a.owner, a.nonce, program), a.owner),
    concat(disc('settle_order'), u8(a.legs ?? LEGS)), program);
}

export function settleOfferIx(m: MarketRef, a: { cranker: PublicKey; day: number; kind: BellKind; maker: PublicKey; nonce: number; legs?: number }) {
  const program = m.program ?? CROSS_PROGRAM_ID;
  const cross = crossPda(m.market, a.day, a.kind, program);
  return ix(settleKeys(m, a.cranker, cross, offerPda(cross, a.maker, a.nonce, program), a.maker),
    concat(disc('settle_offer'), u8(a.legs ?? LEGS)), program);
}

export function closeCrossIx(m: MarketRef, a: { cranker: PublicKey; day: number; kind: BellKind; createdBy: PublicKey; treasury: PublicKey }) {
  const program = m.program ?? CROSS_PROGRAM_ID;
  return ix([
    w(a.cranker, true), r(crossConfigPda(program)), r(m.market), w(crossPda(m.market, a.day, a.kind, program)),
    w(a.createdBy), r(a.treasury), w(ataOf(a.treasury, m.mint, m.mintProgram)), w(ataOf(a.treasury, m.quoteMint, m.quoteProgram)),
    w(m.rawEscrow), w(m.quoteEscrow), r(m.mint), r(m.quoteMint), r(m.mintProgram), r(m.quoteProgram),
    r(ATA_PROGRAM), r(SystemProgram.programId),
  ], disc('close_cross'), program);
}

export function initCrossConfigIx(a: { admin: PublicKey; treasury: PublicKey; program?: PublicKey }) {
  const program = a.program ?? CROSS_PROGRAM_ID;
  const programData = PublicKey.findProgramAddressSync([program.toBytes()], new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0];
  return ix([w(a.admin, true), w(crossConfigPda(program)), r(program), r(programData), r(SystemProgram.programId)],
    concat(disc('init_config'), a.treasury.toBytes()), program);
}

export function createMarketIx(a: {
  admin: PublicKey; listing: PublicKey; mint: PublicKey; quoteMint: PublicKey;
  mintProgram: PublicKey; quoteProgram: PublicKey; params: MarketParams; program?: PublicKey;
}) {
  const program = a.program ?? CROSS_PROGRAM_ID;
  const market = marketPda(a.mint, program);
  return ix([
    w(a.admin, true), r(crossConfigPda(program)), w(market), r(a.listing), r(a.mint), r(a.quoteMint),
    r(a.mintProgram), r(a.quoteProgram), w(rawEscrowPda(market, program)), w(quoteEscrowPda(market, program)),
    r(SystemProgram.programId),
  ], concat(disc('create_market'), encodeMarketParams(a.params)), program);
}
