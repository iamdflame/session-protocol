/* ───────────────────────────────────────────────────────────────────────────
   Bell orders, from the browser: the NVDA market, its crosses, your orders.

   It reads the manifest the devnet setup wrote (/cross-devnet.json), then the
   chain:
   - the market, the xStock's mint (for its multiplier) and your two token
     balances, in one getMultipleAccountsInfo;
   - the market's crosses, and your live orders, by getProgramAccounts;
   - the latest final print from session-bell, which estimates show beside
     the ticket.
   Everything is decoded by the SDK the keeper uses.

   Receipts need one thing the chain no longer holds once an order settles:
   what you ordered, because a settled order's account is closed. So the
   page keeps a note of each order it places in this browser, and computes
   the receipt from that note and the cross's clearing, which the keeper
   leaves on chain for a day. As in chain.ts, a failed read is reported, not
   papered over.
   ─────────────────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useConnection } from '@solana/wallet-adapter-react';
import bs58 from 'bs58';
import { BELL_ACCOUNT, BELL_PROGRAM_ID, decodePrint, PRINT_LISTING_OFFSET, type Print } from '@sdk/bell.ts';
import { buyerLeg, multiplierWad, readScaledUi, sellerLeg, WAD } from '@sdk/cross.ts';
import {
  ataOf, CROSS_ACCOUNT, CROSS_PROGRAM_ID, decodeCross, decodeMarket, decodeOrder, marketRef, OFFSETS,
  type CrossAccount, type Market, type MarketRef, type OrderAccount,
} from '@sdk/cross-ix.ts';
import { load } from './data';

export interface CrossManifest {
  cluster: string; program: string; config: string; market: string; listing: string; symbol: string;
  mint: string; mintProgram: string; mintDecimals: number; realMint: string;
  quoteMint: string; quoteProgram: string; quoteDecimals: number;
  maker: string; backstop: { feeBps: number; maxRaw: string; maxQuote: string };
  params: { freezeSecs: number; auctionSecs: number; [k: string]: unknown };
}

export interface BellOrdersState {
  manifest: CrossManifest;
  market: Market;
  ref: MarketRef;
  /** The xStock's multiplier, WAD: displayed tokens per raw token. */
  multiplier: bigint;
  crosses: { address: PublicKey; c: CrossAccount }[];
  mine: { address: PublicKey; o: OrderAccount }[];
  balances: { raw: bigint; quote: bigint } | null;
  lastPrint: Print | null;
  readAt: number;
}

const discFilter = (bytes: number[]) => ({ memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.from(bytes)) } });
const tokenAmount = (data: Uint8Array | undefined) =>
  data && data.length >= 72 ? new DataView(data.buffer, data.byteOffset).getBigUint64(64, true) : 0n;

export function useBellOrders(owner: PublicKey | null, intervalMs = 20_000) {
  const { connection } = useConnection();
  const [data, setData] = useState<BellOrdersState | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      let manifest: CrossManifest;
      try {
        manifest = await load<CrossManifest>('/cross-devnet.json');
      } catch {
        if (live) setData(null);
        return;
      }
      try {
        const marketKey = new PublicKey(manifest.market);
        const mint = new PublicKey(manifest.mint);
        const quote = new PublicKey(manifest.quoteMint);
        const keys = [marketKey, mint];
        if (owner) {
          keys.push(ataOf(owner, mint, new PublicKey(manifest.mintProgram)), ataOf(owner, quote, new PublicKey(manifest.quoteProgram)));
        }
        const [infos, crossAccts, mineAccts, printAccts] = await Promise.all([
          connection.getMultipleAccountsInfo(keys),
          connection.getProgramAccounts(CROSS_PROGRAM_ID, {
            filters: [discFilter(CROSS_ACCOUNT.Cross), { memcmp: { offset: OFFSETS.crossMarket, bytes: marketKey.toBase58() } }],
          }),
          owner
            ? connection.getProgramAccounts(CROSS_PROGRAM_ID, {
              filters: [discFilter(CROSS_ACCOUNT.Order), { memcmp: { offset: OFFSETS.orderOwner, bytes: owner.toBase58() } }],
            })
            : Promise.resolve([] as Awaited<ReturnType<typeof connection.getProgramAccounts>>),
          connection.getProgramAccounts(BELL_PROGRAM_ID, {
            filters: [discFilter(BELL_ACCOUNT.Print), { memcmp: { offset: PRINT_LISTING_OFFSET, bytes: manifest.listing } }],
          }),
        ]);
        const [marketInfo, mintInfo, rawInfo, quoteInfo] = infos;
        if (!marketInfo || !mintInfo) throw new Error('the bell-order market is not on this cluster');
        const market = decodeMarket(marketInfo.data);
        const scaled = readScaledUi(mintInfo.data);
        const now = Math.floor(Date.now() / 1000);
        const multiplier = scaled && scaled !== 'malformed'
          ? multiplierWad(now >= scaled.newEffectiveTs ? scaled.newBits : scaled.currentBits) ?? WAD
          : WAD;
        const prints = printAccts.map((a) => decodePrint(a.account.data)).filter((p) => p.status === 'final' && p.equity.present);
        prints.sort((a, b) => b.bellTs - a.bellTs);
        const next: BellOrdersState = {
          manifest,
          market,
          ref: marketRef(marketKey, market),
          multiplier,
          crosses: crossAccts.map((a) => ({ address: a.pubkey, c: decodeCross(a.account.data) })).sort((a, b) => a.c.bellTs - b.c.bellTs),
          mine: mineAccts.map((a) => ({ address: a.pubkey, o: decodeOrder(a.account.data) })),
          balances: owner ? { raw: tokenAmount(rawInfo?.data), quote: tokenAmount(quoteInfo?.data) } : null,
          lastPrint: prints[0] ?? null,
          readAt: Date.now(),
        };
        if (live) { setData(next); setError(null); }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
      if (live) timer = setTimeout(read, intervalMs);
    };
    read();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [connection, owner, intervalMs, tick]);

  return { data, error, refresh };
}

/* ── units ───────────────────────────────────────────────────────────────── */

/** Raw atoms to the displayed tokens a wallet shows: raw × multiplier / 10^decimals. */
export const displayed = (raw: bigint, multiplier: bigint, decimals: number): number =>
  Number((raw * multiplier) / WAD) / 10 ** decimals;

/** Displayed tokens (as typed) to raw atoms, rounded down. */
export const toRaw = (tokens: number, multiplier: bigint, decimals: number): bigint =>
  tokens > 0 ? (BigInt(Math.floor(tokens * 10 ** decimals)) * WAD) / multiplier : 0n;

/** A Pyth mantissa and exponent as a number, for display only. */
export const priceOf = (mantissa: bigint, expo: number): number => Number(mantissa) * 10 ** expo;

/* ── the browser's own notes of what it ordered ──────────────────────────── */

export interface PlacedNote {
  order: string; cross: string; day: number; kind: 'open' | 'close'; side: 'buy' | 'sell';
  amount: string; limitE8: string; bellTs: number; signature: string; placedAt: number;
  /** When this browser saw the order cancelled. A cancelled order has no receipt,
      even after its cross clears, so this has to be remembered. */
  cancelledAt?: number;
}

const NOTES = (owner: string) => `session.bell-orders.v1.${owner}`;

export function readNotes(owner: PublicKey | null): PlacedNote[] {
  if (!owner) return [];
  try {
    return JSON.parse(localStorage.getItem(NOTES(owner.toBase58())) ?? '[]') as PlacedNote[];
  } catch {
    return [];
  }
}

export function addNote(owner: PublicKey, note: PlacedNote): void {
  try {
    const notes = readNotes(owner).filter((n) => n.order !== note.order);
    notes.unshift(note);
    localStorage.setItem(NOTES(owner.toBase58()), JSON.stringify(notes.slice(0, 50)));
  } catch {
    // a private window keeps no notes; the chain still holds live orders
  }
}

export function markCancelled(owner: PublicKey, order: string): void {
  try {
    const notes = readNotes(owner).map((n) => (n.order === order && !n.cancelledAt ? { ...n, cancelledAt: Date.now() } : n));
    localStorage.setItem(NOTES(owner.toBase58()), JSON.stringify(notes));
  } catch {
    // as above
  }
}

/** How long a just-placed order may be missing from a read before its absence
    means something: a read can come from a node a slot or two behind. */
const LAG_MS = 90_000;

export type NoteState =
  | { state: 'pending' | 'cancelled' | 'refunded' | 'closed' }
  | { state: 'filled'; spent: bigint; got: bigint }
  | { state: 'unfilled' };

/** What became of an order this browser placed that the chain no longer holds
    as a live order. An order account closes when it is cancelled or settled,
    and settling needs the cross cleared (or cancelled), so an order missing
    while its cross is still before that was cancelled. */
export function noteState(note: PlacedNote, c: CrossAccount | undefined, nowMs: number): NoteState {
  if (note.cancelledAt) return { state: 'cancelled' };
  const young = nowMs - note.placedAt < LAG_MS;
  if (!c) return { state: young ? 'pending' : 'closed' };
  if (c.phase === 'cancelled') return { state: 'refunded' };
  if (c.phase !== 'settling') return { state: young ? 'pending' : 'cancelled' };
  const r = receipt(note, c);
  return r && r.inBand ? { state: 'filled', spent: r.spent, got: r.got } : { state: 'unfilled' };
}

/** What a settled order got, from the cross's clearing. */
export function receipt(note: PlacedNote, c: CrossAccount): { spent: bigint; got: bigint; inBand: boolean } | null {
  if (c.phase !== 'settling' && c.phase !== 'cancelled') return null;
  const amount = BigInt(note.amount);
  const limit = BigInt(note.limitE8);
  const inBand = c.phase === 'settling' && (limit === 0n || (note.side === 'buy' ? c.priceE8 <= limit : c.priceE8 >= limit));
  if (!inBand) return { spent: 0n, got: 0n, inBand: false };
  const [spent, got] = note.side === 'buy' ? buyerLeg(amount, c.clearing) : sellerLeg(amount, c.clearing);
  return { spent, got, inBand: true };
}
