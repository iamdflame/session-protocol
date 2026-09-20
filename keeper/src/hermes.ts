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

/**
 * The update Pyth published for `feedId` at (or just before) `ts`, as the
 * base64 blob the receiver program takes.
 */
export async function fetchUpdateAsOf(
  feedIdHex: string, ts: number, cfg: HermesConfig = {},
): Promise<string> {
  const url = `${cfg.url ?? HERMES_URL}/v2/updates/price/${ts}?ids[]=${feedIdHex}&encoding=base64&parsed=false`;
  const headers: Record<string, string> = {};
  const key = cfg.apiKey ?? process.env.HERMES_API_KEY;
  if (key) headers.authorization = `Bearer ${key}`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new HermesUnavailable(r.status, (await r.text()).slice(0, 200));
  const body = await r.json() as { binary?: { data?: string[] } };
  const data = body.binary?.data?.[0];
  if (!data) throw new Error('Hermes returned no update data');
  return data;
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
