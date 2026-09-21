/* ───────────────────────────────────────────────────────────────────────────
   The issuer's powers over a vault, read off the mint. Mirrors
   `programs/session/src/issuer.rs` and is pinned to the same real-mint
   fixture, so the instrument card shows exactly what the program acts on.

   Type ids are Token-2022's `ExtensionType` discriminants. The TLV is walked
   directly rather than through @solana/spl-token's getters so that the site
   bundle carries no more of that library than it already does, and so the
   two parsers cannot disagree about an extension the library has not
   learned yet.
   ─────────────────────────────────────────────────────────────────────────── */

import { PublicKey } from '@solana/web3.js';

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const EXT_TRANSFER_FEE_CONFIG = 1;
const EXT_DEFAULT_ACCOUNT_STATE = 6;
const EXT_PERMANENT_DELEGATE = 12;
const EXT_TRANSFER_HOOK = 14;
const EXT_METADATA_POINTER = 18;
const EXT_TOKEN_METADATA = 19;
const EXT_SCALED_UI_AMOUNT = 25;
const EXT_PAUSABLE = 26;
const EXT_CONFIDENTIAL_TRANSFER = 4;

const MINT_BASE_LEN = 82;
const ACCOUNT_LEN = 165;
const TLV_START = ACCOUNT_LEN + 1;

export interface ScaledUi {
  multiplier: number;
  newMultiplier: number;
  /** Unix seconds at which `newMultiplier` takes effect. */
  newMultiplierEffectiveTs: number;
}

export interface IssuerState {
  token2022: boolean;
  hookProgram: PublicKey | null;
  /** The hook extension exists (a program can be set later) even when unset now. */
  hookSlot: boolean;
  pausable: boolean;
  paused: boolean;
  transferFeeBps: number;
  transferFeeMax: bigint;
  permanentDelegate: PublicKey | null;
  scaledUi: ScaledUi | null;
  defaultFrozen: boolean;
  confidentialTransfer: boolean;
  metadata: { name: string; symbol: string; uri: string } | null;
  /** From the base mint. */
  decimals: number;
  freezeAuthority: PublicKey | null;
  mintAuthority: PublicKey | null;
}

const keyAt = (d: Uint8Array, at: number): PublicKey | null => {
  const b = d.subarray(at, at + 32);
  if (b.length < 32 || b.every(x => x === 0)) return null;
  return new PublicKey(b);
};
const u16 = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset).getUint16(at, true);
const u32 = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset).getUint32(at, true);
const u64 = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset).getBigUint64(at, true);
const i64 = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset).getBigInt64(at, true);
const f64 = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset).getFloat64(at, true);

/** A borsh string: u32 length then UTF-8. */
const str = (d: Uint8Array, at: number): [string, number] => {
  const n = u32(d, at);
  return [new TextDecoder().decode(d.subarray(at + 4, at + 4 + n)), at + 4 + n];
};

/**
 * Read the issuer's powers off a mint account. `epoch` picks the transfer-fee
 * schedule in force, as the token program does.
 */
export function inspectMint(data: Uint8Array, owner: PublicKey, epoch: number): IssuerState {
  if (data.length < MINT_BASE_LEN) throw new Error('not a mint');
  // base: mint_authority COption(4+32), supply 8, decimals 1, is_initialized 1, freeze_authority COption(4+32)
  const s: IssuerState = {
    token2022: owner.toBase58() === TOKEN_2022_PROGRAM,
    hookProgram: null, hookSlot: false, pausable: false, paused: false,
    transferFeeBps: 0, transferFeeMax: 0n, permanentDelegate: null, scaledUi: null,
    defaultFrozen: false, confidentialTransfer: false, metadata: null,
    decimals: data[44],
    mintAuthority: u32(data, 0) === 1 ? keyAt(data, 4) : null,
    freezeAuthority: u32(data, 46) === 1 ? keyAt(data, 50) : null,
  };
  if (owner.toBase58() === TOKEN_PROGRAM) return s;
  if (!s.token2022) throw new Error('not a token mint');
  if (data.length <= TLV_START) return s;
  if (data[ACCOUNT_LEN] !== 1) throw new Error('not a Token-2022 mint');

  let at = TLV_START;
  while (at + 4 <= data.length) {
    const ty = u16(data, at);
    const len = u16(data, at + 2);
    if (ty === 0 && len === 0) break;
    const body = at + 4;
    const end = body + len;
    if (end > data.length) throw new Error('malformed TLV');
    const d = data.subarray(body, end);
    switch (ty) {
      case EXT_TRANSFER_HOOK: s.hookSlot = true; s.hookProgram = keyAt(d, 32); break;
      case EXT_PAUSABLE: s.pausable = true; s.paused = d[32] !== 0; break;
      case EXT_TRANSFER_FEE_CONFIG: {
        const newerEpoch = Number(u64(d, 90));
        const pick = epoch >= newerEpoch ? 90 : 72;
        s.transferFeeMax = u64(d, pick + 8);
        s.transferFeeBps = u16(d, pick + 16);
        break;
      }
      case EXT_PERMANENT_DELEGATE: s.permanentDelegate = keyAt(d, 0); break;
      case EXT_SCALED_UI_AMOUNT:
        // authority 32, multiplier f64, new_multiplier_effective_timestamp i64, new_multiplier f64
        s.scaledUi = { multiplier: f64(d, 32), newMultiplierEffectiveTs: Number(i64(d, 40)), newMultiplier: f64(d, 48) };
        break;
      case EXT_DEFAULT_ACCOUNT_STATE: s.defaultFrozen = d[0] === 2; break;
      case EXT_CONFIDENTIAL_TRANSFER: s.confidentialTransfer = true; break;
      case EXT_METADATA_POINTER: break;
      case EXT_TOKEN_METADATA: {
        // update_authority 32, mint 32, then name, symbol, uri as borsh strings
        let p = 64;
        const [name, a] = str(d, p); p = a;
        const [symbol, b] = str(d, p); p = b;
        const [uri] = str(d, p);
        s.metadata = { name, symbol, uri };
        break;
      }
      default: break;
    }
    at = end;
  }
  return s;
}

/** The fee Token-2022 takes off a transfer of `amount`. Mirrors `issuer::transfer_fee`. */
export function transferFee(s: IssuerState, amount: bigint): bigint {
  if (s.transferFeeBps === 0 || amount === 0n) return 0n;
  const raw = (amount * BigInt(s.transferFeeBps) + 9_999n) / 10_000n;
  return raw < s.transferFeeMax ? raw : s.transferFeeMax;
}

/** The multiplier in force at `now`, honouring a scheduled change. */
export function uiMultiplier(s: IssuerState, now: number): number {
  if (!s.scaledUi) return 1;
  return now >= s.scaledUi.newMultiplierEffectiveTs ? s.scaledUi.newMultiplier : s.scaledUi.multiplier;
}

/** Atoms → the number a person should read: raw / 10^decimals × multiplier. */
export function toUi(atoms: bigint, decimals: number, multiplier: number): number {
  return (Number(atoms) / 10 ** decimals) * multiplier;
}

export const ISSUER_CONDITION_LABEL: Record<number, string> = {
  1: 'a transfer hook has been set on the underlying',
  2: 'the underlying is paused by its issuer',
  3: "the vault's token account has been frozen",
  4: "inventory has been moved out of the vault by the issuer's permanent delegate",
};

/**
 * One line per power the issuer holds, for the instrument card. Empty for a
 * classic mint.
 */
export function issuerPowers(s: IssuerState): string[] {
  const out: string[] = [];
  if (s.permanentDelegate) out.push('the issuer can move this vault’s inventory out at any time (permanent delegate)');
  if (s.freezeAuthority) out.push('the issuer can freeze this vault’s token account');
  if (s.pausable) out.push(s.paused ? 'transfers are PAUSED by the issuer' : 'the issuer can pause all transfers');
  if (s.hookSlot) out.push(s.hookProgram ? `a transfer hook is set (${s.hookProgram.toBase58()}) — the vault cannot move this asset` : 'the issuer can attach a transfer hook, which would stop this vault');
  if (s.transferFeeBps) out.push(`every transfer pays a ${(s.transferFeeBps / 100).toFixed(2)}% fee to the issuer`);
  if (s.scaledUi) out.push(`balances display at ×${s.scaledUi.multiplier.toPrecision(7)} (raw atoms underneath)`);
  if (s.defaultFrozen) out.push('new token accounts start frozen');
  return out;
}
