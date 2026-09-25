/* ───────────────────────────────────────────────────────────────────────────
   A cross's receipt, read from the chain. The site's /b/<cross> and the
   agent's bell_receipt both use this, so both say the same thing.

   - checkPrint: the transaction that posted the print the cross was priced
     at. Its Ed25519 signature is checked again here, over the very bytes the
     program parsed, and the signed feed is compared with what the print
     stored, field by field.
   - findCounterfactual: the keeper's Jupiter quote at the bell
     (counterfactual.ts). It is shown only from the transaction that priced
     this cross, and only when the keeper the market names signed it:
     anyone can put a memo in a transaction that touches a cross.
   - crossEventsFromLogs and ordersFromHistory: what each order asked for
     and what it was paid, from the program's own events. Any program in a
     transaction can write a `Program data:` line, so an event counts only
     when session-cross itself was executing when it was written.

   Every read here is optional. The public RPC refuses history first, and a
   part it would not serve comes back as `unavailable` with the reason, never
   as a guess.
   ─────────────────────────────────────────────────────────────────────────── */

import { PublicKey, type ConfirmedSignatureInfo, type Connection, type VersionedTransactionResponse } from '@solana/web3.js';
import nacl from 'tweetnacl';
import {
  BELL_DISCRIMINATOR, BELL_PROGRAM_ID, ED25519_PROGRAM_ID, parseLazerMessage, parseLazerPayload,
  POST_PRINT_MESSAGE_OFFSET, type LazerFeed, type LazerPayload, type Print,
} from './bell.ts';
import { COUNTERFACTUAL_TAG, MEMO_PROGRAM_ID, readCounterfactual, type Counterfactual } from './counterfactual.ts';
import { CROSS_DISCRIMINATOR, CROSS_PROGRAM_ID, type CrossAccount } from './cross-ix.ts';

export interface PrintCheck {
  /** The post_print transaction whose message the print holds. */
  signature: string;
  /** Ed25519 over the signed payload, checked here. */
  verifiedHere: boolean;
  /** The Ed25519 precompile is in this transaction, at the index post_print names, as the verifier requires. */
  precompile: boolean;
  signer: string;
  payload: LazerPayload;
  /** The listing's equity feed as signed. */
  feed: LazerFeed | null;
  /** Price, confidence, exponent, publishers, session, both timestamps and the signer all equal the print's. */
  matchesPrint: boolean;
}

/** Why a part is absent: the RPC refused, or there is nothing there. */
export type Missing = { missing: 'unavailable' | 'none'; why?: string };

export type CounterfactualRead =
  | { cf: Counterfactual; signature: string }
  | { untrusted: string; signature: string }
  | Missing;

export interface Ix { program: PublicKey; accounts: PublicKey[]; data: Uint8Array }

/** A fetched transaction's instructions, with their keys resolved. */
export function instructions(tx: VersionedTransactionResponse): Ix[] {
  const msg = tx.transaction.message;
  const loaded = tx.meta?.loadedAddresses;
  const keys = [...msg.staticAccountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
  return msg.compiledInstructions.map((ix) => ({
    program: keys[ix.programIdIndex],
    accounts: ix.accountKeyIndexes.map((i) => keys[i]),
    data: ix.data,
  }));
}

const startsWith = (data: Uint8Array, prefix: number[]) => data.length >= prefix.length && prefix.every((b, i) => data[i] === b);
const why = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160);
const getTx = (conn: Connection, signature: string) =>
  conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });

/* ── the print ──────────────────────────────────────────────────────────── */

export async function checkPrint(conn: Connection, printAddress: PublicKey, print: Print): Promise<PrintCheck | Missing> {
  if (!print.equity.present) return { missing: 'none', why: 'this bell has no price: its print is marked missing' };
  try {
    // the post the print holds is the one in the slot it recorded
    const sigs = await conn.getSignaturesForAddress(printAddress, { limit: 100 });
    const hit = sigs.find((x) => BigInt(x.slot) === print.slot && !x.err);
    if (!hit) return { missing: 'unavailable', why: `no successful transaction in slot ${print.slot} among the print's last ${sigs.length}` };
    const tx = await getTx(conn, hit.signature);
    if (!tx) return { missing: 'unavailable', why: 'the RPC did not return the transaction' };
    const ixs = instructions(tx);
    const post = ixs.find((ix) => ix.program.equals(BELL_PROGRAM_ID) && startsWith(ix.data, BELL_DISCRIMINATOR.post_print));
    if (!post) return { missing: 'none', why: 'that transaction holds no post_print' };
    const len = new DataView(post.data.buffer, post.data.byteOffset, post.data.byteLength).getUint32(8, true);
    const m = parseLazerMessage(post.data.subarray(POST_PRINT_MESSAGE_OFFSET, POST_PRINT_MESSAGE_OFFSET + len));
    const payload = parseLazerPayload(m.payload);
    const feed = payload.feeds.find((f) => f.feedId === print.equity.feedId) ?? null;
    const signer = new PublicKey(m.publicKey);
    const e = print.equity;
    const matchesPrint = !!feed && signer.equals(print.signer) && payload.timestampUs === print.messageTsUs
      && feed.price === e.price && feed.confidence === e.conf && feed.exponent === e.expo
      && feed.publishers === e.publishers && (feed.session ?? 255) === e.session && feed.feedTsUs === e.feedTsUs;
    return {
      signature: hit.signature,
      verifiedHere: nacl.sign.detached.verify(m.payload, m.signature, m.publicKey),
      // post_print ends with the index of its Ed25519 instruction (u16): 0, or 1 behind a compute budget
      precompile: ixs[post.data[post.data.length - 2] | (post.data[post.data.length - 1] << 8)]?.program.equals(ED25519_PROGRAM_ID) ?? false,
      signer: signer.toBase58(),
      payload,
      feed,
      matchesPrint,
    };
  } catch (e) {
    return { missing: 'unavailable', why: why(e) };
  }
}

/* ── the counterfactual ─────────────────────────────────────────────────── */

export async function findCounterfactual(
  conn: Connection, address: PublicKey, c: CrossAccount, history: ConfirmedSignatureInfo[], keeper: string | undefined,
): Promise<CounterfactualRead> {
  if (!c.pricedAt) return { missing: 'none', why: 'the cross has not been priced' };
  // the memo marks it; the block time finds the price even if the RPC drops memos
  const candidates = history.filter((h) => !h.err && (h.memo?.includes(COUNTERFACTUAL_TAG) || h.blockTime === c.pricedAt)).slice(0, 3);
  try {
    for (const h of candidates) {
      const tx = await getTx(conn, h.signature);
      if (!tx || tx.meta?.err) continue;
      const ixs = instructions(tx);
      const priced = ixs.some((ix) => ix.program.equals(CROSS_PROGRAM_ID) && startsWith(ix.data, CROSS_DISCRIMINATOR.price_cross) && ix.accounts[0]?.equals(address));
      if (!priced) continue;
      const memo = ixs.find((ix) => ix.program.equals(MEMO_PROGRAM_ID));
      const cf = memo ? readCounterfactual(new TextDecoder().decode(memo.data)) : null;
      if (!cf || cf.cross !== address.toBase58()) return { missing: 'none', why: 'the transaction that priced this cross carries no swap quote' };
      const payer = tx.transaction.message.staticAccountKeys[0];
      if (!keeper || !payer.equals(new PublicKey(keeper))) return { untrusted: payer.toBase58(), signature: h.signature };
      return { cf, signature: h.signature };
    }
  } catch (e) {
    return { missing: 'unavailable', why: why(e) };
  }
  return candidates.length
    ? { missing: 'none', why: 'no transaction of this cross both priced it and carried a swap quote' }
    : { missing: 'unavailable', why: 'the transaction that priced this cross is not in the history the RPC returned' };
}

/* ── the program's events ───────────────────────────────────────────────── */

/** `sha256("event:<Name>")[..8]`, precomputed so this runs in a browser; tests/receipt recomputes them. */
export const CROSS_EVENT = {
  OrderPlaced: [96, 130, 204, 234, 169, 219, 216, 227],
  OrderCancelled: [108, 56, 128, 68, 168, 113, 168, 239],
  OrderSettled: [32, 21, 123, 33, 68, 59, 136, 131],
  OfferSettled: [28, 72, 212, 133, 229, 156, 62, 254],
} as const;

export type CrossEvent =
  | { name: 'OrderPlaced'; cross: PublicKey; order: PublicKey; owner: PublicKey; day: number; kind: 'open' | 'close'; side: 'buy' | 'sell'; amount: bigint; limitE8: bigint }
  | { name: 'OrderCancelled'; cross: PublicKey; order: PublicKey; owner: PublicKey; amount: bigint }
  | { name: 'OrderSettled'; cross: PublicKey; order: PublicKey; owner: PublicKey; quote: bigint; raw: bigint }
  | { name: 'OfferSettled'; cross: PublicKey; offer: PublicKey; maker: PublicKey; quote: bigint; raw: bigint };

function base64(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

/** One event body, discriminator included, or null. Borsh, in the Rust struct's field order. */
export function decodeCrossEvent(b: Uint8Array): CrossEvent | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 8;
  const key = () => { const k = new PublicKey(b.subarray(at, at + 32)); at += 32; return k; };
  const u64 = () => { const v = dv.getBigUint64(at, true); at += 8; return v; };
  const u8 = () => b[at++];
  const is = (d: readonly number[]) => b.length >= 8 && d.every((x, i) => b[i] === x);
  const exactly = (n: number) => b.length === 8 + n;
  if (is(CROSS_EVENT.OrderPlaced) && exactly(32 * 3 + 8 + 1 + 1 + 8 + 8)) {
    const [cross, order, owner] = [key(), key(), key()];
    const day = Number(dv.getBigInt64(at, true)); at += 8;
    const kind = u8() === 0 ? 'open' : 'close';
    const side = u8() === 0 ? 'buy' : 'sell';
    return { name: 'OrderPlaced', cross, order, owner, day, kind, side, amount: u64(), limitE8: u64() };
  }
  if (is(CROSS_EVENT.OrderCancelled) && exactly(32 * 3 + 8)) {
    return { name: 'OrderCancelled', cross: key(), order: key(), owner: key(), amount: u64() };
  }
  if (is(CROSS_EVENT.OrderSettled) && exactly(32 * 3 + 16)) {
    return { name: 'OrderSettled', cross: key(), order: key(), owner: key(), quote: u64(), raw: u64() };
  }
  if (is(CROSS_EVENT.OfferSettled) && exactly(32 * 3 + 16)) {
    return { name: 'OfferSettled', cross: key(), offer: key(), maker: key(), quote: u64(), raw: u64() };
  }
  return null;
}

/**
 * The events session-cross wrote in a transaction, from its logs. The logs
 * say which program is running (`Program <id> invoke [n]` … `success`), and
 * a data line counts only while it is session-cross: a program the
 * transaction also called could write the same bytes.
 */
export function crossEventsFromLogs(logs: readonly string[] | null | undefined, program = CROSS_PROGRAM_ID): CrossEvent[] {
  if (!logs) return [];
  const id = program.toBase58();
  const stack: string[] = [];
  const out: CrossEvent[] = [];
  for (const line of logs) {
    const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (invoke) { stack.push(invoke[1]); continue; }
    if (/^Program \w+ (success|failed)/.test(line)) { stack.pop(); continue; }
    const data = /^Program data: (\S+)$/.exec(line);
    if (data && stack[stack.length - 1] === id) {
      const bytes = base64(data[1]);
      const e = bytes && decodeCrossEvent(bytes);
      if (e) out.push(e);
    }
  }
  return out;
}

export interface OrderRecord {
  order: string; owner: string; side: 'buy' | 'sell'; amount: bigint; limitE8: bigint;
  placed: string | null;
  /** Paid out: quote atoms and raw token atoms, summed over every settle. An
      issuer pause can split an order's two legs across transactions. */
  quote: bigint; raw: bigint;
  outcome: 'open' | 'cancelled' | 'settled';
}

/**
 * Every order in a cross's history, or one owner's, from the program's
 * events: what each asked for and what it was paid. Reads one transaction
 * at a time, oldest first, pausing between them for the public RPC.
 * `complete` is false when a transaction could not be read; the records
 * are then a lower bound and say so by the flag.
 */
export async function ordersFromHistory(
  conn: Connection, cross: PublicKey, history: ConfirmedSignatureInfo[],
  opts: { owner?: PublicKey; pauseMs?: number } = {},
): Promise<{ orders: OrderRecord[]; complete: boolean }> {
  const orders = new Map<string, OrderRecord>();
  let complete = true;
  for (const h of [...history].reverse()) {
    if (h.err) continue;
    let tx: VersionedTransactionResponse | null = null;
    for (let attempt = 0; attempt < 3 && !tx; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
      tx = await getTx(conn, h.signature).catch(() => null);
    }
    if (!tx) { complete = false; continue; }
    for (const e of crossEventsFromLogs(tx.meta?.logMessages)) {
      if (e.name === 'OfferSettled' || !e.cross.equals(cross)) continue;
      if (opts.owner && !e.owner.equals(opts.owner)) continue;
      const k = e.order.toBase58();
      if (e.name === 'OrderPlaced') {
        orders.set(k, {
          order: k, owner: e.owner.toBase58(), side: e.side, amount: e.amount, limitE8: e.limitE8,
          placed: h.signature, quote: 0n, raw: 0n, outcome: 'open',
        });
        continue;
      }
      const o = orders.get(k);
      if (!o) continue; // placed before the history we were given
      if (e.name === 'OrderCancelled') o.outcome = 'cancelled';
      else {
        o.quote += e.quote;
        o.raw += e.raw;
        o.outcome = 'settled';
      }
    }
    if (opts.pauseMs) await new Promise((r) => setTimeout(r, opts.pauseMs));
  }
  return { orders: [...orders.values()], complete };
}
