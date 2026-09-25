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

   The checks themselves are sdk/src/receipt.ts, which the agent's
   bell_receipt uses too. The history reads are the ones the public RPC
   refuses first. Each is optional. A part that could not be read says so,
   and is never filled with a guess. Once a part has a definite answer it is
   not read again.
   ─────────────────────────────────────────────────────────────────────────── */

import { useEffect, useRef, useState } from 'react';
import { PublicKey, type ConfirmedSignatureInfo } from '@solana/web3.js';
import { useConnection } from '@solana/wallet-adapter-react';
import { decodePrint, type Print } from '@sdk/bell.ts';
import { multiplierWad, readScaledUi, WAD } from '@sdk/cross.ts';
import { CROSS_PROGRAM_ID, decodeCross, decodeMarket, type CrossAccount, type Market } from '@sdk/cross-ix.ts';
import { checkPrint, findCounterfactual, type CounterfactualRead, type Missing, type PrintCheck } from '@sdk/receipt.ts';
import { load } from './data';
import type { CrossManifest } from './bellOrders';

export type { CounterfactualRead, Missing, PrintCheck };

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

const why = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160);

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
