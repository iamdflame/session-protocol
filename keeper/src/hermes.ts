/* ───────────────────────────────────────────────────────────────────────────
   The print at the bell, posted on chain.

   The program refuses a settlement mark whose publish time is outside the
   bell's own window. A crank that lands late cannot use the live sponsored
   feed for that — it is fresh and wrong — so the keeper fetches the update
   Pyth published *at the bell* from Hermes, which serves history by
   timestamp, and posts it through the Pyth receiver with full Wormhole
   verification. The ephemeral account it lands in is what `settle_boundary`
   reads, and it is closed in the same batch so the rent comes back.

   Hermes's price endpoints need an API key. Without one this module reports
   exactly that and the crank falls back to the sponsored account, which the
   devnet instance's wide window admits and a mainnet instance's would not.
   That asymmetry is a parameter on the instrument card, not a hidden
   assumption.
   ─────────────────────────────────────────────────────────────────────────── */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, VersionedTransaction,
} from '@solana/web3.js';
import * as nodeModule from 'node:module';
import type { PythSolanaReceiver as Receiver } from '@pythnetwork/pyth-solana-receiver';

type ReceiverCtor = new (args: { connection: Connection; wallet: ReturnType<typeof walletFor> }) => Receiver;

/**
 * Loaded on first use, not at import: the serverless crank is bundled without
 * this package and must keep working on the sponsored path. The package's
 * ESM build imports `jito-ts/dist/sdk/block-engine/types` without an
 * extension, which Node's ESM resolver refuses; the CJS build resolves
 * cleanly, and jito is never called from here.
 */
function loadReceiver(): ReceiverCtor {
  try {
    return (nodeModule.createRequire(import.meta.url)('@pythnetwork/pyth-solana-receiver') as { PythSolanaReceiver: ReceiverCtor })
      .PythSolanaReceiver;
  } catch {
    throw new Error('the Pyth receiver SDK is not available here; as-of posting runs from the CLI keeper (npm run keeper)');
  }
}

export const HERMES_URL = process.env.HERMES_URL ?? 'https://hermes.pyth.network';

export interface HermesConfig {
  url?: string;
  apiKey?: string;
}

export class HermesUnavailable extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(status === 401
      ? 'Hermes price endpoints need an API key (HERMES_API_KEY); without one the keeper can only read the sponsored feed'
      : `Hermes ${status}: ${detail}`);
    this.status = status;
  }
}

export interface AsOfUpdate {
  /** The base64 blob the receiver program takes. */
  data: string;
  price: bigint;
  conf: bigint;
  expo: number;
  publishTime: number;
}

/**
 * The update Pyth published for `feedId` at (or just before) `ts`: the
 * bytes to post, and the parsed price so a recap can be written from it.
 */
export async function fetchAsOf(feedIdHex: string, ts: number, cfg: HermesConfig = {}): Promise<AsOfUpdate> {
  const url = `${cfg.url ?? HERMES_URL}/v2/updates/price/${ts}?ids[]=${feedIdHex}&encoding=base64&parsed=true`;
  const headers: Record<string, string> = {};
  const key = cfg.apiKey ?? process.env.HERMES_API_KEY;
  if (key) headers.authorization = `Bearer ${key}`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new HermesUnavailable(r.status, (await r.text()).slice(0, 200));
  const body = await r.json() as {
    binary?: { data?: string[] };
    parsed?: { price: { price: string; conf: string; expo: number; publish_time: number } }[];
  };
  const data = body.binary?.data?.[0];
  const p = body.parsed?.[0]?.price;
  if (!data || !p) throw new Error('Hermes returned no update data');
  return { data, price: BigInt(p.price), conf: BigInt(p.conf), expo: p.expo, publishTime: p.publish_time };
}



/** Whether a key is configured — the crank reports which path it took. */
export const hermesConfigured = (): boolean => Boolean(process.env.HERMES_API_KEY);

/** The little of Anchor's `Wallet` the receiver SDK actually calls. */
function walletFor(kp: Keypair) {
  const sign = async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
    if (tx instanceof VersionedTransaction) tx.sign([kp]);
    else tx.partialSign(kp);
    return tx;
  };
  return {
    publicKey: kp.publicKey,
    signTransaction: sign,
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]) =>
      Promise.all(txs.map(sign)),
  };
}

export interface PostedUpdate {
  account: PublicKey;
  signatures: string[];
  /** Instructions that give the rent back once the account has been read. */
  close: () => Promise<string[]>;
}

/**
 * Post one update and leave its account open. A recap needs one account per
 * replayed bell, all readable in the same instruction, so they cannot be
 * closed in the posting batch the way a settlement's can.
 */
export async function postUpdate(conn: Connection, payer: Keypair, updateData: string): Promise<PostedUpdate> {
  const PythSolanaReceiver = loadReceiver();
  const receiver = new PythSolanaReceiver({ connection: conn, wallet: walletFor(payer) });
  const { postInstructions, priceFeedIdToPriceUpdateAccount, closeInstructions } =
    await receiver.buildPostPriceUpdateInstructions([updateData]);
  const accounts = Object.values(priceFeedIdToPriceUpdateAccount);
  if (accounts.length !== 1) throw new Error(`expected one price update account, got ${accounts.length}`);
  const txs = await receiver.batchIntoVersionedTransactions(postInstructions, { computeUnitPriceMicroLamports: 50_000, tightComputeBudget: true });
  const signatures = await receiver.provider.sendAll(txs, { skipPreflight: false, preflightCommitment: 'confirmed' });
  return {
    account: accounts[0],
    signatures,
    close: async () => {
      const ctx = await receiver.batchIntoVersionedTransactions(closeInstructions, { computeUnitPriceMicroLamports: 50_000, tightComputeBudget: true });
      return receiver.provider.sendAll(ctx, { skipPreflight: false, preflightCommitment: 'confirmed' });
    },
  };
}

export interface PostedSettle {
  /** Signatures in order: VAA post(s), the settle, the close. */
  signatures: string[];
  priceUpdateAccount: PublicKey;
}

/**
 * Post `updateData` with full verification, run the caller's instruction
 * against the resulting price-update account, then close it. One batch,
 * several transactions; the SDK splits them by size.
 */
export async function postUpdateAndConsume(
  conn: Connection,
  payer: Keypair,
  feedIdHex: string,
  updateData: string,
  consume: (priceUpdateAccount: PublicKey) => TransactionInstruction[],
): Promise<PostedSettle> {
  const PythSolanaReceiver = loadReceiver();
  const receiver = new PythSolanaReceiver({ connection: conn, wallet: walletFor(payer) });
  const tb = receiver.newTransactionBuilder({ closeUpdateAccounts: true });
  await tb.addPostPriceUpdates([updateData]);
  const id = feedIdHex.replace(/^0x/, '');
  let account: PublicKey | null = null;
  await tb.addPriceConsumerInstructions(async (getPriceUpdateAccount) => {
    account = getPriceUpdateAccount(`0x${id}`);
    return consume(account).map(instruction => ({ instruction, signers: [] }));
  });
  if (!account) throw new Error('no price update account was allocated for the feed');
  const txs = await tb.buildVersionedTransactions({ computeUnitPriceMicroLamports: 50_000, tightComputeBudget: true });
  const signatures = await receiver.provider.sendAll(txs, { skipPreflight: false, preflightCommitment: 'confirmed' });
  return { signatures, priceUpdateAccount: account };
}
