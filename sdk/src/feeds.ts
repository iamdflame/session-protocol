/* ───────────────────────────────────────────────────────────────────────────
   The Pyth feeds a vault can be pointed at, and which of them actually exist
   where.

   A feed id is not a promise that anybody is publishing it. Pyth sponsors a
   handful of price accounts on devnet and the rest are mainnet-only or need a
   Hermes key to post; a vault pointed at an unsponsored feed initialises fine
   and then refuses every settlement, because the account it reads is empty.
   That is the correct behaviour and a baffling one to debug, so the table
   says which is which and the listing form will not let you pick the wrong
   one by accident.
   ─────────────────────────────────────────────────────────────────────────── */

export interface Feed {
  /** Pyth's own name for it. */
  name: string;
  /** The 32-byte feed id, hex, no 0x. */
  id: string;
  /** Whether Pyth sponsors a price account for it on devnet. */
  devnet: boolean;
  note: string;
}

export const FEEDS: Feed[] = [
  {
    name: 'Crypto.SOL/USD',
    id: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
    devnet: true,
    note: 'Sponsored on devnet and refreshed every few minutes. The stand-in mark for every devnet vault here.',
  },
  {
    name: 'Crypto.BTC/USD',
    id: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
    devnet: true,
    note: 'Sponsored on devnet. Used as the equity feed on devnet, where it never goes quiet — which is exactly why it cannot detect a close.',
  },
  {
    name: 'Crypto.NVDAX/USD',
    id: '4244d07890e4610f46bbde67de8f43a4bf8b569eebe904f136b469f148503b7f',
    devnet: false,
    note: 'The real tokenized-NVDA mark. Mainnet only — this is the feed a live vault would use.',
  },
  {
    name: 'Equity.US.NVDA/USD',
    id: 'b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593',
    devnet: false,
    note: 'The underlying share itself. It goes quiet at the closing bell, which is how a vault cross-checks the calendar against the market.',
  },
];

export const feedByName = (name: string): Feed | undefined => FEEDS.find(f => f.name === name);
