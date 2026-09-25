/* ───────────────────────────────────────────────────────────────────────────
   The print Pyth published at a bell, read back from the chain itself.

   A recap needs the mark each missed bell settled at. With a Hermes key that
   is Pyth's own history, verified on chain. Without one — Hermes and the
   benchmark archive both refuse unauthenticated requests — the only other
   honest source is the sponsored price account's own write history: every
   update the sponsor posts is a transaction carrying Pyth's signed price
   message, and that message holds the feed id, price, confidence, exponent
   and publish time.

   So this walks the price account's signatures around each bell, finds the
   feed's message inside each update's instruction data, and returns the last
   print published at or before the bell — with the signature it came from,
   so anyone can check the number rather than take the operator's word for it.

     npm run bell-prints -- <unix-bell> [<unix-bell> …]
   ─────────────────────────────────────────────────────────────────────────── */

import { readFileSync } from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

export interface BellPrint {
  bell: number;
  publishTime: number;
  price: bigint;
  conf: bigint;
  expo: number;
  signature: string;
}

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map(b => parseInt(b, 16)));

/** Find `feed` in `data` as a PriceFeedMessage (type 0) and parse it, big-endian. */
export function parsePriceMessage(data: Uint8Array, feed: Uint8Array) {
  outer: for (let i = 1; i + 32 + 44 <= data.length; i++) {
    if (data[i - 1] !== 0) continue;                 // message type: PriceFeedMessage
    for (let j = 0; j < 32; j++) if (data[i + j] !== feed[j]) continue outer;
    const dv = new DataView(data.buffer, data.byteOffset + i + 32, 44);
    return {
      price: dv.getBigInt64(0, false),
      conf: dv.getBigUint64(8, false),
      expo: dv.getInt32(16, false),
      publishTime: Number(dv.getBigInt64(20, false)),
    };
  }
  return null;
}

/* A print counts for a bell only if it was published inside the window the
   program itself would accept for that bell: up to `lead` seconds before it.
   Anything older is a different moment's price, however convenient. */
export async function bellPrints(
  conn: Connection, account: PublicKey, feedHex: string, bells: number[], lead = 300,
): Promise<{ prints: BellPrint[]; fetched: number; failed: number }> {
  const feed = hex(feedHex);
  const want = [...bells].sort((a, b) => a - b);
  const out = new Map<number, BellPrint>();
  const covered = new Set<number>();          // bells whose whole window has been read
  let before: string | undefined;
  let fetched = 0, failed = 0;

  for (let page = 0; page < 60 && covered.size < want.length; page++) {
    const sigs = await conn.getSignaturesForAddress(account, { limit: 1000, before });
    if (!sigs.length) break;
    before = sigs[sigs.length - 1].signature;
    const oldest = sigs[sigs.length - 1].blockTime ?? 0;

    // A print published just before the bell is posted within seconds, so
    // the transactions worth reading land in [bell − lead, bell + 30].
    /* Only the transactions posted inside a bell's window can carry its print:
       [bell − lead, bell + 30], a print being posted within seconds of being
       published. About twenty-five per bell at the sponsor's cadence. */
    const near = sigs.filter(x => !x.err && x.blockTime &&
      want.some(b => !covered.has(b) && x.blockTime! >= b - lead && x.blockTime! <= b + 30));
    /* Newest first, reading every transaction in the window — not stopping at
       the first hit — because a read the endpoint refused could be the one
       holding the print nearest the bell. Refused reads get a second, slower
       pass; any that still fail are counted and reported, never assumed empty. */
    const read = async (sig: string, attempts: number, base: number) => {
      for (let a = 0; a < attempts; a++) {
        if (a) await new Promise(r => setTimeout(r, base * 2 ** (a - 1)));
        const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 }).catch(() => null);
        if (tx) return tx;
      }
      return null;
    };
    const refused: string[] = [];
    const txs: NonNullable<Awaited<ReturnType<typeof read>>>[] = [];
    for (const one of near) {
      const tx = await read(one.signature, 5, 1200);
      if (tx) txs.push(tx); else refused.push(one.signature);
      await new Promise(r => setTimeout(r, 250));
    }
    for (const sig of refused) {
      await new Promise(r => setTimeout(r, 4000));
      const tx = await read(sig, 6, 3000);
      if (tx) txs.push(tx); else failed++;
    }
    for (const tx of txs) {
      fetched++;
      for (const ix of tx.transaction.message.compiledInstructions) {
        const msg = parsePriceMessage(ix.data, feed);
        if (!msg) continue;
        for (const b of want) {
          if (msg.publishTime > b || msg.publishTime < b - lead) continue;
          const cur = out.get(b);
          if (!cur || msg.publishTime > cur.publishTime) {
            out.set(b, { bell: b, ...msg, signature: tx.transaction.signatures[0] });
          }
        }
      }
    }
    // Once a page reaches back past a bell's window, that bell is fully read.
    for (const b of want) if (oldest < b - lead) covered.add(b);
  }
  return { prints: want.map(b => out.get(b)).filter((x): x is BellPrint => !!x), fetched, failed };
}

if (process.argv[1]?.endsWith('keeper/src/bell-prints.ts')) {
  const m = JSON.parse(readFileSync('keeper/.devnet/manifest.json', 'utf8'));
  const conn = new Connection(m.rpc, 'confirmed');
  const bells = process.argv.slice(2).map(Number).filter(Boolean);
  const { prints, fetched, failed } = await bellPrints(conn, new PublicKey(m.markPriceUpdate), m.params.markFeedId, bells);
  console.log(`read ${fetched} update transactions${failed ? `, ${failed} refused by the endpoint` : ''}`);
  for (const p of prints) {
    console.log(`${new Date(p.bell * 1000).toISOString()}  published ${new Date(p.publishTime * 1000).toISOString()} (${p.publishTime - p.bell}s)` +
      `  price ${p.price} e${p.expo}  conf ${p.conf}  ${p.signature}`);
  }
  if (prints.length < bells.length) { console.error(`found ${prints.length} of ${bells.length}`); process.exit(1); }
}
