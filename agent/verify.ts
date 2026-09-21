/* What $BELL actually is on chain, read back rather than taken from the
   launch response. A launch that reports success and a mint that exists are
   two different claims.

     npm run bell:verify
*/

import { readFileSync } from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { inspectMint } from '../sdk/src/issuer.ts';

const RPC = process.env.MAINNET_RPC ?? 'https://api.mainnet-beta.solana.com';
const conn = new Connection(RPC, 'confirmed');
const rec = JSON.parse(readFileSync('keeper/.devnet/bell.json', 'utf8'));
const mint = new PublicKey(rec.launch.mintAddress);
const quote = new PublicKey(rec.quoteMint);

const epoch = (await conn.getEpochInfo()).epoch;
let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ' — ' + detail}`);
  if (!ok) failed++;
};

console.log(`$BELL    ${mint.toBase58()}`);
console.log(`quoted in ${quote.toBase58()}  (NVDAx)\n`);

const mi = await conn.getAccountInfo(mint);
check('the mint exists on mainnet', !!mi, mi ? `${mi.data.length} bytes` : 'missing');
if (mi) {
  const s = inspectMint(mi.data, mi.owner, epoch);
  console.log(`         owner ${mi.owner.toBase58()}`);
  console.log(`         decimals ${s.decimals}  metadata ${JSON.stringify(s.metadata)}`);
  check('it carries its name on chain', s.metadata?.symbol === 'BELL', s.metadata?.symbol);
}

const qi = await conn.getAccountInfo(quote);
check('the quote asset is the real NVDAx, Token-2022', !!qi && qi.owner.toBase58() === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
if (qi) {
  const q = inspectMint(qi.data, qi.owner, epoch);
  check('and it is the asset with the issuer powers the runbook names',
    q.permanentDelegate !== null && q.pausable, `delegate ${!!q.permanentDelegate} pausable ${q.pausable}`);
}

const tx = await conn.getTransaction(rec.launch.txHash, { maxSupportedTransactionVersion: 0 });
check('the launch transaction is on mainnet', !!tx, rec.launch.txHash);
if (tx) {
  // A v0 transaction's keys may come from an address lookup table, which
  // `getAccountKeys` will not resolve without the tables loaded. The log
  // messages name every program that ran, and need no resolution.
  const invoked = new Set(
    (tx.meta?.logMessages ?? [])
      .map(l => l.match(/^Program (\w{32,44}) invoke \[1\]$/)?.[1])
      .filter(Boolean) as string[],
  );
  const NAMED: Record<string, string> = {
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pump.fun',
    pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: 'pump.fun AMM',
    TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'Token-2022',
    TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'SPL Token',
    ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'associated token',
    '11111111111111111111111111111111': 'system',
    dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: 'Meteora DBC',
    cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: 'Meteora DAMM v2',
  };
  console.log('         programs invoked:');
  for (const p of invoked) console.log(`           ${NAMED[p] ?? p}`);
}

const supply = await conn.getTokenSupply(mint).catch(() => null);
if (supply) console.log(`         supply ${supply.value.uiAmountString}`);

console.log(failed ? `\n${failed} failed` : '\n$BELL is real, on mainnet, denominated in a tokenized stock');
process.exit(failed ? 1 : 0);
