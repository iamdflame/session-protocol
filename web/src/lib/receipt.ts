/* ───────────────────────────────────────────────────────────────────────────
   One cross's receipt, read from the chain.

   - The cross, its market, and the print it was priced at, from their
     accounts.
   - The print's own transaction. This browser checks the Ed25519 signature
     again, over the very bytes the program parsed, and compares the signed
     feed with what the print stored, field by field.
   - The counterfactual the keeper wrote beside the price. It is shown only
     from the transaction that priced this cross, and only when the keeper
     the manifest names signed it; anyone can put a memo in a transaction
     that touches a cross.

   The history reads (signatures, transactions) are the ones the public RPC
   refuses first. Each is optional. A part that could not be read says so,
   and is never filled with a guess. Once a part has a definite answer it is
   not read again.
   ─────────────────────────────────────────────────────────────────────────── */

import { useEffect, useRef, useState } from 'react';
import { PublicKey, type ConfirmedSignatureInfo, type Connection, type VersionedTransactionResponse } from '@solana/web3.js';
import { useConnection } from '@solana/wallet-adapter-react';
import nacl from 'tweetnacl';
import {
  BELL_DISCRIMINATOR, BELL_PROGRAM_ID, decodePrint, ED25519_PROGRAM_ID, parseLazerMessage, parseLazerPayload,
  POST_PRINT_MESSAGE_OFFSET, type LazerFeed, type LazerPayload, type Print,
} from '@sdk/bell.ts';
import { COUNTERFACTUAL_TAG, MEMO_PROGRAM_ID, readCounterfactual, type Counterfactual } from '@sdk/counterfactual.ts';
import { multiplierWad, readScaledUi, WAD } from '@sdk/cross.ts';
import { CROSS_DISCRIMINATOR, CROSS_PROGRAM_ID, decodeCross, decodeMarket, type CrossAccount, type Market } from '@sdk/cross-ix.ts';
import { load } from './data';
import type { CrossManifest } from './bellOrders';

export interface PrintCheck {
  /** The post_print transaction whose message the print holds. */
  signature: string;
  /** Ed25519 over the signed payload, checked in this browser. */
  verifiedHere: boolean;
  /** The transaction's first instruction is the Ed25519 precompile, as the verifier requires. */
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

export interface ReceiptState {
  address: PublicKey;
  manifest: CrossManifest;
  /** Null when the account is gone: never created, or closed a day after it cleared. */
  cross: CrossAccount | null;
  market: Market | null;
  /** Displayed tokens per raw token, WAD: the one the cross priced with, or the mint's own until then. */
  multiplier: bigint;
  print: Print | null;
  printCheck: PrintCheck | Missing;
  counterfactual: CounterfactualRead;
  /** Newest first. Null when the RPC would not serve it. */
  history: ConfirmedSignatureInfo[] | null;
  readAt: number;
}

interface Ix { program: PublicKey; accounts: PublicKey[]; data: Uint8Array }

function instructions(tx: VersionedTransactionResponse): Ix[] {
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

async function checkPrint(conn: Connection, printAddress: PublicKey, print: Print): Promise<PrintCheck | Missing> {
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
      precompile: ixs[0]?.program.equals(ED25519_PROGRAM_ID) ?? false,
      signer: signer.toBase58(),
      payload,
      feed,
      matchesPrint,
    };
  } catch (e) {
    return { missing: 'unavailable', why: why(e) };
  }
}

async function findCounterfactual(
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

const settled = (c: CrossAccount) =>
  (c.phase === 'settling' || c.phase === 'cancelled') && c.nSettled === c.nOrders && c.nOffersSettled === c.nOffers;

/** `undefined` while the first read is in flight, `null` when no market is deployed. */
export function useReceipt(address: PublicKey | null, intervalMs = 30_000) {
  const { connection } = useConnection();
  const [data, setData] = useState<ReceiptState | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // parts that have a definite answer are kept, not read again
  const kept = useRef<{ key: string; printCheck?: PrintCheck | Missing; counterfactual?: CounterfactualRead }>({ key: '' });

  useEffect(() => {
    if (!address) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const key = address.toBase58();
    if (kept.current.key !== key) kept.current = { key };
    const read = async () => {
      let manifest: CrossManifest;
      try {
        manifest = await load<CrossManifest>('/cross-devnet.json');
      } catch {
        if (live) setData(null);
        return;
      }
      let done = false;
      try {
        const info = await connection.getAccountInfo(address);
        let cross: CrossAccount | null = null;
        try {
          if (info && info.owner.equals(CROSS_PROGRAM_ID)) cross = decodeCross(info.data);
        } catch {
          // the program's other accounts (a market, an order) are not crosses
        }
        const priced = cross && !cross.print.equals(PublicKey.default) ? cross.print : null;
        const mint = new PublicKey(manifest.mint);
        const [marketInfo, printInfo, mintInfo] = cross
          ? await connection.getMultipleAccountsInfo([cross.market, priced ?? cross.market, mint])
          : [null, null, null];
        const market = marketInfo ? decodeMarket(marketInfo.data) : null;
        const print = priced && printInfo ? decodePrint(printInfo.data) : null;
        // a cross records the multiplier when it is priced; before that, the mint's own
        let multiplier = cross?.multiplierWad || WAD;
        if (cross && !cross.multiplierWad && market?.mint.equals(mint) && mintInfo) {
          const scaled = readScaledUi(mintInfo.data);
          const now = Math.floor(Date.now() / 1000);
          if (scaled && scaled !== 'malformed') multiplier = multiplierWad(now >= scaled.newEffectiveTs ? scaled.newBits : scaled.currentBits) ?? WAD;
        }
        const history = await connection.getSignaturesForAddress(address, { limit: 200 }).catch(() => null);

        const k = kept.current;
        const notes: string[] = [];
        if (!history) notes.push('the RPC would not serve this cross\u2019s history');
        if (print && priced && (print.status === 'final' || print.status === 'missing') && !k.printCheck) {
          const r = await checkPrint(connection, priced, print);
          if (!('missing' in r) || r.missing === 'none') k.printCheck = r;
          else notes.push(`the print\u2019s transaction: ${r.why ?? 'unavailable'}`);
        }
        if (cross && history && cross.pricedAt && !k.counterfactual) {
          const r = await findCounterfactual(connection, address, cross, history, manifest.keeper);
          if (!('missing' in r) || r.missing === 'none') k.counterfactual = r;
          else notes.push(`the swap quote: ${r.why ?? 'unavailable'}`);
        }
        const printCheck = k.printCheck ?? (print ? { missing: 'unavailable' as const, why: 'not read yet' } : { missing: 'none' as const, why: 'no print yet' });
        const counterfactual = k.counterfactual ?? (cross?.pricedAt ? { missing: 'unavailable' as const, why: 'the RPC would not serve this cross’s history' } : { missing: 'none' as const, why: 'the cross has not been priced' });
        // finished when nothing on chain will change and every part has its answer
        done = !cross || (settled(cross) && (!print || !!k.printCheck) && (!cross.pricedAt || !!k.counterfactual));
        if (live) {
          setData({ address, manifest, cross, market, multiplier, print, printCheck, counterfactual, history, readAt: Date.now() });
          setError(notes.length ? notes.join('; ') : null);
        }
      } catch (e) {
        if (live) setError(why(e));
      }
      // a settled cross will not change; a live one is read again
      if (live && !done) timer = setTimeout(read, intervalMs);
    };
    read();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [connection, address, intervalMs]);

  return { data, error };
}
