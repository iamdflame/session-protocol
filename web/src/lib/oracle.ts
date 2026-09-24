/* ───────────────────────────────────────────────────────────────────────────
   The bell oracle, from the browser.

   Everything on /oracle comes through here: the manifest the devnet setup
   wrote (/bell-devnet.json), then the chain itself. It reads the config and
   the listings in one getMultipleAccountsInfo, and every print in one
   getProgramAccounts filtered to the Print discriminator. All of it is
   decoded by sdk/src/bell.ts, the same decoder the poster uses and the
   print layout vector pins.

   As in chain.ts, a failed read is reported as a failure, never replaced by
   a plausible number.
   ─────────────────────────────────────────────────────────────────────────── */

import { useEffect, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useConnection } from '@solana/wallet-adapter-react';
import bs58 from 'bs58';
import {
  BELL_ACCOUNT, BELL_PROGRAM_ID, bellConfigPda, decodeBellConfig, decodeListing, decodePrint,
  type BellConfig, type BellParams, type Listing, type Print,
} from '@sdk/bell.ts';
import { load } from './data';

export interface OracleManifest {
  cluster: string;
  program: string;
  config: string;
  verifier: string;
  verifierSource: string;
  verifierStorage: string;
  treasury: string;
  signer: string;
  simulated: boolean;
  priceSource: string;
  placeholders: string;
  params: BellParams;
  poster: string;
  listings: {
    symbol: string;
    listing: string;
    feeds: { equity: number; rr?: number; token?: number; index?: number };
    feedNames: Record<string, string>;
    mint: string;
  }[];
  writtenAt: string;
}

export interface PrintRow extends Print {
  address: string;
  symbol: string;
}

export interface OracleState {
  manifest: OracleManifest;
  config: BellConfig;
  listings: { symbol: string; address: string; account: Listing }[];
  /** Newest bell first. */
  prints: PrintRow[];
  readAt: number;
}

async function read(conn: ReturnType<typeof useConnection>['connection'], m: OracleManifest): Promise<OracleState> {
  const program = new PublicKey(m.program);
  if (!program.equals(BELL_PROGRAM_ID)) throw new Error(`manifest names program ${m.program}, the SDK ${BELL_PROGRAM_ID.toBase58()}`);
  const keys = [bellConfigPda()[0], ...m.listings.map((l) => new PublicKey(l.listing))];
  const [infos, printAccts] = await Promise.all([
    conn.getMultipleAccountsInfo(keys),
    conn.getProgramAccounts(program, {
      filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.from(BELL_ACCOUNT.Print)) } }],
    }),
  ]);
  const [cfgInfo, ...listingInfos] = infos;
  if (!cfgInfo) throw new Error('the bell config is not on this cluster');
  const config = decodeBellConfig(cfgInfo.data);
  const listings = m.listings.flatMap((l, i) => {
    const info = listingInfos[i];
    return info ? [{ symbol: l.symbol, address: l.listing, account: decodeListing(info.data) }] : [];
  });
  const bySymbol = new Map(m.listings.map((l) => [l.listing, l.symbol]));
  const prints = printAccts
    .map((a) => ({ ...decodePrint(a.account.data), address: a.pubkey.toBase58() }))
    .map((p) => ({ ...p, symbol: bySymbol.get(p.listing.toBase58()) ?? p.listing.toBase58().slice(0, 4) }))
    .sort((a, b) => b.bellTs - a.bellTs || a.symbol.localeCompare(b.symbol));
  return { manifest: m, config, listings, prints, readAt: Date.now() };
}

/** `undefined` while the first read is in flight, `null` when there is no deployment. */
export function useOracle(intervalMs = 30_000): { data: OracleState | null | undefined; error: string | null } {
  const { connection } = useConnection();
  const [data, setData] = useState<OracleState | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let manifest: OracleManifest;
      try {
        manifest = await load<OracleManifest>('/bell-devnet.json');
      } catch {
        if (live) setData(null);
        return;
      }
      try {
        const next = await read(connection, manifest);
        if (live) { setData(next); setError(null); }
      } catch (e) {
        // keep the last good read on screen, and say it is stale
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
      if (live) timer = setTimeout(tick, intervalMs);
    };
    tick();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [connection, intervalMs]);

  return { data, error };
}
