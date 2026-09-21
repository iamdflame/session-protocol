/* ───────────────────────────────────────────────────────────────────────────
   Instruction builders.

   Anchor clients usually go through a generated IDL. This program is built
   with `cargo build-sbf`, which emits no IDL, and the account lists are short
   enough that writing them out is clearer than generating them: every account
   below is in the same order as the `#[derive(Accounts)]` struct it mirrors,
   and every argument is borsh-encoded by hand in the order the handler takes
   it. Anchor dispatches on `sha256("global:<name>")[..8]`.

   Used by the keeper, the devnet tooling, the serverless crank and the site,
   so there is exactly one place an account order can be wrong. It runs in a
   browser as well as in Node, so there is no `Buffer` and no `node:crypto`
   here: the discriminators are precomputed and pinned by a test.
   ─────────────────────────────────────────────────────────────────────────── */

import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from '@solana/web3.js';
import { PROGRAM_ID, SESSION_EQUITY, HALT_REASON, type ClassName, type SessionKind } from './vault.ts';

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
/** Token-2022. Every real xStock mint is owned by this, not by the classic program. */
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
/** Pyth's push-oracle program, under which the sponsored feed accounts are derived. */
export const PYTH_PUSH_ORACLE = new PublicKey('pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT');

/**
 * Anchor's instruction discriminators: `sha256("global:<name>")[..8]`.
 * Precomputed so this module needs no hashing at runtime; `tests/ix.test.ts`
 * recomputes every one of them and fails if any drifts.
 */
export const DISCRIMINATOR: Record<string, number[]> = {
  initialize_vault:   [48, 191, 163, 44, 71, 129, 63, 164],
  mint_shares:        [24, 196, 132, 0, 183, 158, 216, 142],
  redeem_shares:      [239, 154, 224, 89, 240, 196, 42, 187],
  settle_boundary:    [38, 28, 194, 78, 163, 150, 202, 153],
  fill_handoff:       [97, 215, 100, 62, 110, 170, 124, 32],
  skim_surplus:       [63, 26, 155, 114, 147, 168, 93, 21],
  resolve_halt:       [24, 105, 73, 74, 64, 191, 168, 131],
  halt:               [24, 156, 8, 121, 65, 3, 5, 82],
  set_flags:          [199, 54, 111, 124, 87, 47, 217, 198],
  set_params:         [27, 234, 178, 52, 147, 2, 187, 141],
  transfer_authority: [48, 169, 76, 72, 229, 180, 55, 161],
  accept_authority:   [107, 86, 198, 91, 33, 12, 107, 160],
  recap:              [204, 15, 215, 235, 79, 60, 231, 134],
};

export function discriminator(name: string): Uint8Array {
  const d = DISCRIMINATOR[name];
  if (!d) throw new Error(`no discriminator for ${name}`);
  return Uint8Array.from(d);
}

/* ── encoding ────────────────────────────────────────────────────────────── */

const u8 = (v: number) => Uint8Array.of(v & 0xff);
const u16 = (v: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b; };
const u32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const u64 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b; };
const i64 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, v, true); return b; };
const u128 = (v: bigint) => {
  if (v < 0n || v >= 1n << 128n) throw new Error('u128 out of range');
  const b = new Uint8Array(16);
  const dv = new DataView(b.buffer);
  dv.setBigUint64(0, v & ((1n << 64n) - 1n), true);
  dv.setBigUint64(8, v >> 64n, true);
  return b;
};

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** `Class` is a plain borsh enum: Night = 0, Day = 1. */
export const classByte = (c: ClassName): number => (c === 'night' ? 0 : 1);

export interface VaultParams {
  markFeedId: Uint8Array;
  equityFeedId: Uint8Array;
  fundingKBps: number;
  fundingMaxBps: number;
  maxStaleSecs: number;
  maxConfBps: number;
  maxMoveBps: number;
  equityQuietSecs: number;
  fillIncentiveBps: number;
  maxCarryDeltaBps: number;
  maxUnexpectedClosedSecs: number;
  // ── v2 ──
  /** How many slots behind the clock a mark's `posted_slot` may be. */
  maxPostedSlotAge: number;
  /** How long before the bell a settlement mark may have been published. */
  maxBellLeadSecs: number;
  /** Event sessions: token-vs-mark divergence, in bp, that exposes THEN. */
  maxPremiumBps: number;
  /** The residual is offered at one price to everyone for this long after a bell. */
  auctionSecs: number;
  /** Fill incentive by elapsed time: in the auction window, within twice it, after. */
  incentiveRamp: [number, number, number];
  /** Whether a recap must carry a Pyth update per replayed boundary. */
  requireVerifiedRecap: boolean;
}

/** `VaultParams` on the wire: 92 bytes of v1 fields, then 21 of v2. */
export const VAULT_PARAMS_SIZE = 113;

/** Field order and widths mirror `VaultParams` in lib.rs exactly. */
export function encodeVaultParams(p: VaultParams): Uint8Array {
  if (p.markFeedId.length !== 32 || p.equityFeedId.length !== 32) throw new Error('feed ids are 32 bytes');
  if (p.incentiveRamp.length !== 3) throw new Error('incentive ramp has three tiers');
  return concat(
    Uint8Array.from(p.markFeedId),
    Uint8Array.from(p.equityFeedId),
    u32(p.fundingKBps),
    u32(p.fundingMaxBps),
    u32(p.maxStaleSecs),
    u16(p.maxConfBps),
    u16(p.maxMoveBps),
    u32(p.equityQuietSecs),
    u16(p.fillIncentiveBps),
    u16(p.maxCarryDeltaBps),
    u32(p.maxUnexpectedClosedSecs),
    u32(p.maxPostedSlotAge),
    u32(p.maxBellLeadSecs),
    u16(p.maxPremiumBps),
    u32(p.auctionSecs),
    u16(p.incentiveRamp[0]), u16(p.incentiveRamp[1]), u16(p.incentiveRamp[2]),
    u8(p.requireVerifiedRecap ? 1 : 0),
  );
}

/** A borsh `String`: u32 length prefix, then UTF-8 bytes. */
const str = (v: string): Uint8Array => {
  const b = new TextEncoder().encode(v);
  return concat(u32(b.length), b);
};

/* ── derived addresses ───────────────────────────────────────────────────── */

/**
 * The associated token address. The token program is part of the seed, so a
 * Token-2022 mint's ATA is a different address from the classic one — passing
 * the wrong program here silently derives an account that will never exist.
 */
export function ata(owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/**
 * The sponsored Pyth feed account for a feed id — the account Pyth's own
 * scheduler keeps fresh, when it keeps it fresh at all. Shard 0 is the one
 * Pyth sponsors.
 */
export function pythFeedAccount(feedId: Uint8Array, shard = 0): PublicKey {
  return PublicKey.findProgramAddressSync([u16(shard), Uint8Array.from(feedId)], PYTH_PUSH_ORACLE)[0];
}

export const hexToBytes = (hex: string): Uint8Array => {
  const h = hex.replace(/^0x/, '');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};
export const bytesToHex = (b: Uint8Array): string =>
  Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

/* ── instructions ────────────────────────────────────────────────────────── */

const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });

/** Idempotent ATA creation — a no-op if the account already exists. */
export function createAtaIdempotentIx(
  payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM_ID,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      meta(payer, true, true),
      meta(ata(owner, mint, tokenProgram), true),
      meta(owner),
      meta(mint),
      meta(SystemProgram.programId),
      meta(tokenProgram),
    ],
    data: Uint8Array.of(1) as Buffer,   // CreateIdempotent
  });
}

export interface InitializeVaultAccounts {
  authority: PublicKey;
  vault: PublicKey;
  underlyingMint: PublicKey;
  quoteMint: PublicKey;
  nightMint: PublicKey;
  dayMint: PublicKey;
  underlyingVault: PublicKey;
  quoteVault: PublicKey;
  markPriceUpdate: PublicKey;
  equityPriceUpdate: PublicKey;
  /**
   * The two token programs. They differ in the case this protocol is for: a
   * real xStock is Token-2022 and USDC is the classic program, so one field
   * cannot serve both. Both default to classic for an all-SPL vault.
   */
  underlyingTokenProgram?: PublicKey;
  quoteTokenProgram?: PublicKey;
}

/**
 * `symbol` names the share classes (`NVDA` → `NVDA.DAY` / `NVDA.NIGHT`);
 * uppercase ASCII, at most 8 bytes. `sessionKind` is `SESSION_EQUITY` or
 * `SESSION_EVENT`.
 */
export function initializeVaultIx(
  a: InitializeVaultAccounts, p: VaultParams, symbol: string, sessionKind: SessionKind = SESSION_EQUITY,
): TransactionInstruction {
  if (!/^[A-Z0-9]{1,8}$/.test(symbol)) throw new Error('symbol is 1–8 uppercase ASCII letters or digits');
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      meta(a.authority, true, true),
      meta(a.vault, true),
      meta(a.underlyingMint),
      meta(a.quoteMint),
      meta(a.nightMint, true),
      meta(a.dayMint, true),
      meta(a.underlyingVault, true),
      meta(a.quoteVault, true),
      meta(a.markPriceUpdate),
      meta(a.equityPriceUpdate),
      meta(a.underlyingTokenProgram ?? TOKEN_PROGRAM_ID),
      meta(a.quoteTokenProgram ?? TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
      meta(SYSVAR_RENT_PUBKEY),
    ],
    data: concat(
      discriminator('initialize_vault'), encodeVaultParams(p), str(symbol), u8(sessionKind),
    ) as Buffer,
  });
}

export interface TradeAccounts {
  vault: PublicKey;
  classMint: PublicKey;
  nightMint: PublicKey;
  dayMint: PublicKey;
  quoteVault: PublicKey;
  userQuote: PublicKey;
  userShares: PublicKey;
  user: PublicKey;
  /** The quote mint — `transfer_checked` validates the transfer against it. */
  quoteMint: PublicKey;
  /** The quote program; the share mints live under it too. */
  tokenProgram?: PublicKey;
}

const tradeKeys = (a: TradeAccounts) => [
  meta(a.vault, true),
  meta(a.classMint, true),
  meta(a.nightMint),
  meta(a.dayMint),
  meta(a.quoteVault, true),
  meta(a.userQuote, true),
  meta(a.userShares, true),
  meta(a.user, false, true),
  meta(a.quoteMint),
  meta(a.tokenProgram ?? TOKEN_PROGRAM_ID),
];

export function mintSharesIx(a: TradeAccounts, cls: ClassName, quoteAmount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: tradeKeys(a),
    data: concat(discriminator('mint_shares'), u8(classByte(cls)), u64(quoteAmount)) as Buffer,
  });
}

export function redeemSharesIx(a: TradeAccounts, cls: ClassName, shares: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: tradeKeys(a),
    data: concat(discriminator('redeem_shares'), u8(classByte(cls)), u64(shares)) as Buffer,
  });
}

export interface SettleAccounts {
  vault: PublicKey;
  nightMint: PublicKey;
  dayMint: PublicKey;
  markPriceUpdate: PublicKey;
  equityPriceUpdate: PublicKey;
  /** The issuer's powers are read off the mint and the vault's own token account. */
  underlyingMint: PublicKey;
  underlyingVault: PublicKey;
}

/** No arguments and no signer: the crank is permissionless by design. */
export function settleBoundaryIx(a: SettleAccounts): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      meta(a.vault, true),
      meta(a.nightMint),
      meta(a.dayMint),
      meta(a.markPriceUpdate),
      meta(a.equityPriceUpdate),
      meta(a.underlyingMint),
      meta(a.underlyingVault),
    ],
    data: discriminator('settle_boundary') as Buffer,
  });
}

export interface FillAccounts {
  vault: PublicKey;
  underlyingVault: PublicKey;
  quoteVault: PublicKey;
  nightMint: PublicKey;
  dayMint: PublicKey;
  fillerUnderlying: PublicKey;
  fillerQuote: PublicKey;
  filler: PublicKey;
  markPriceUpdate: PublicKey;
  underlyingMint: PublicKey;
  quoteMint: PublicKey;
  underlyingTokenProgram?: PublicKey;
  quoteTokenProgram?: PublicKey;
}

export function fillHandoffIx(
  a: FillAccounts, underlyingAmount: bigint, maxQuoteIn: bigint, minQuoteOut: bigint,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      meta(a.vault, true),
      meta(a.underlyingVault, true),
      meta(a.quoteVault, true),
      meta(a.nightMint),
      meta(a.dayMint),
      meta(a.fillerUnderlying, true),
      meta(a.fillerQuote, true),
      meta(a.filler, false, true),
      meta(a.markPriceUpdate),
      meta(a.underlyingMint),
      meta(a.quoteMint),
      meta(a.underlyingTokenProgram ?? TOKEN_PROGRAM_ID),
      meta(a.quoteTokenProgram ?? TOKEN_PROGRAM_ID),
    ],
    data: concat(
      discriminator('fill_handoff'), u64(underlyingAmount), u64(maxQuoteIn), u64(minQuoteOut),
    ) as Buffer,
  });
}

/* ── halts and recaps ────────────────────────────────────────────────────── */

export type HaltReasonName = (typeof HALT_REASON)[number];
/** `HaltReason` is a plain borsh enum in declaration order. */
export const haltReasonByte = (r: HaltReasonName): number => {
  const i = HALT_REASON.indexOf(r);
  if (i < 0) throw new Error(`unknown halt reason ${r}`);
  return i;
};

export interface AdminAccounts {
  vault: PublicKey;
  authority: PublicKey;
}

/** Stop the vault. Settlement is not pausable, so this is the only brake. */
export function haltIx(a: AdminAccounts): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [meta(a.vault, true), meta(a.authority, false, true)],
    data: discriminator('halt') as Buffer,
  });
}

export function setFlagsIx(a: AdminAccounts, flags: number): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [meta(a.vault, true), meta(a.authority, false, true)],
    data: concat(discriminator('set_flags'), u8(flags)) as Buffer,
  });
}

export interface RecapEntry {
  boundaryTs: number;
  /** Quote atoms per underlying atom, WAD-scaled — `Vault.lastMark`'s units. */
  mark: bigint;
}

export interface RecapAccounts {
  vault: PublicKey;
  authority: PublicKey;
  nightMint: PublicKey;
  dayMint: PublicKey;
}

/**
 * Replay missed boundaries. `pythUpdates`, when given, is one posted price
 * update per entry, in order, each from that bell's own window; the program
 * then takes the marks from Pyth rather than from the operator.
 */
export function recapIx(
  a: RecapAccounts, entries: RecapEntry[], absorbShortfall: boolean, pythUpdates: PublicKey[] = [],
): TransactionInstruction {
  if (entries.length === 0 || entries.length > 32) throw new Error('1–32 recap entries');
  if (pythUpdates.length && pythUpdates.length !== entries.length) {
    throw new Error('one Pyth update per entry, or none');
  }
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      meta(a.vault, true),
      meta(a.authority, false, true),
      meta(a.nightMint),
      meta(a.dayMint),
      ...pythUpdates.map(k => meta(k)),
    ],
    data: concat(
      discriminator('recap'),
      u32(entries.length),
      ...entries.map(e => concat(i64(BigInt(e.boundaryTs)), u128(e.mark))),
      u8(absorbShortfall ? 1 : 0),
    ) as Buffer,
  });
}

export interface ResolveHaltAccounts extends RecapAccounts {
  underlyingMint: PublicKey;
  underlyingVault: PublicKey;
}

/** Resume a vault whose books are current. Writes nothing to the accounting. */
export function resolveHaltIx(a: ResolveHaltAccounts, ack: HaltReasonName): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      meta(a.vault, true),
      meta(a.authority, false, true),
      meta(a.nightMint),
      meta(a.dayMint),
      meta(a.underlyingMint),
      meta(a.underlyingVault),
    ],
    data: concat(discriminator('resolve_halt'), u8(haltReasonByte(ack))) as Buffer,
  });
}

/* ── errors ──────────────────────────────────────────────────────────────── */

/** Pull the program's own error message out of transaction logs. */
export function explainProgramError(logs: string[] | null | undefined): string | null {
  if (!logs) return null;
  for (const l of logs) {
    const m = l.match(/Error Message: (.+?)\.?$/);
    if (m) return m[1];
  }
  const code = logs.join('\n').match(/custom program error: 0x([0-9a-f]+)/i);
  if (code) return `program error ${parseInt(code[1], 16)}`;
  return null;
}
