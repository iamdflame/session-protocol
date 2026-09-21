/* Does the statement agree with the chain?
 *
 * The site's statement panel is a claim about somebody's money, derived from
 * the vault's event log. A DOM assertion proves the page rendered what the SDK
 * computed; it does not prove the SDK computed the truth. This does, against
 * the only authority there is: the wallet's own token accounts.
 *
 * If `statement()` says a wallet holds 160 DAY, the DAY token account holds
 * 160. Nothing reconciles those two numbers except the arithmetic being right
 * — the events are written by the program, the balance is kept by the token
 * program, and they meet nowhere else.
 *
 *   npm run devnet:statement -- <wallet>        (defaults to the operator)
 */
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { decodeVault } from '../../sdk/src/vault.ts';
import { ata } from '../../sdk/src/ix.ts';
import { eventsFromLogs } from '../../sdk/src/events.ts';
import { statement, toCsv, type TimedEvent } from '../../sdk/src/statement.ts';
import type { Manifest } from './crank-core.ts';

const m: Manifest = JSON.parse(readFileSync('keeper/.devnet/manifest.json', 'utf8'));
const conn = new Connection(m.rpc, 'confirmed');
const pk = (s: string) => new PublicKey(s);

const arg = process.argv[2];
const who = arg
  ? pk(arg)
  : Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('keeper/.devnet/operator.json', 'utf8')))).publicKey;

let failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${n}${ok || !d ? '' : ' — ' + d}`);
  if (!ok) failed++;
};

/* ── the whole history, paced ────────────────────────────────────────────── */

const sigs = await conn.getSignaturesForAddress(pk(m.vault), { limit: 1000 });
console.log(`${sigs.length} signatures on ${m.vault}`);

const events: TimedEvent[] = [];
for (let i = 0; i < sigs.length; i += 5) {
  const chunk = sigs.slice(i, i + 5);
  // The endpoint throttles this call hard. Back off rather than give up: a
  // statement summed from part of a history is worse than no statement.
  let txs = null;
  for (let a = 0; a < 5 && !txs; a++) {
    if (a) await new Promise(r => setTimeout(r, 2_000 * 2 ** (a - 1)));
    txs = await conn.getParsedTransactions(chunk.map(s => s.signature),
      { maxSupportedTransactionVersion: 0 }).catch(() => null);
  }
  if (!txs) { console.log('  the endpoint stopped serving transactions; cannot verify'); process.exit(2); }
  txs.forEach((t, j) => {
    for (const event of eventsFromLogs(t?.meta?.logMessages)) {
      events.push({ signature: chunk[j].signature, at: chunk[j].blockTime ?? null, event });
    }
  });
  if (i + 5 < sigs.length) await new Promise(r => setTimeout(r, 600));
}
console.log(`${events.length} events decoded`);

/* ── the statement, and what the chain says ──────────────────────────────── */

const v = decodeVault((await conn.getAccountInfo(pk(m.vault)))!.data);
const st = statement(events, who.toBase58(), v.nightNav, v.dayNav);
const sp = pk(m.shareTokenProgram);
const held = async (mint: string) =>
  conn.getTokenAccountBalance(ata(who, pk(mint), sp)).then(r => BigInt(r.value.amount)).catch(() => 0n);

console.log(`\n${who.toBase58()}`);
console.log(toCsv(st, { symbol: m.symbol, decimals: v.quoteDecimals }));

const [onChainNight, onChainDay] = [await held(m.nightMint), await held(m.dayMint)];
check('NIGHT: the statement and the token account agree',
  st.night.shares === onChainNight, `statement ${st.night.shares}, account ${onChainNight}`);
check('DAY: the statement and the token account agree',
  st.day.shares === onChainDay, `statement ${st.day.shares}, account ${onChainDay}`);
check('the history reaches the vault opening, so the benchmark is exact', st.complete);
check('every trade is one of this wallet\'s', st.rows.length === st.night.trades + st.day.trades);

/* Before a boundary has settled, both NAVs are parity and the split has done
   nothing: a class position is worth exactly the net cash put into it, and the
   benchmark is worth the same. Once a bell has run this no longer holds, which
   is the point — so the check states which regime it is in rather than
   asserting a zero that would quietly stop meaning anything. */
if (v.nightNav === v.dayNav && st.bundle.units === st.total.quoteIn - st.total.quoteOut) {
  console.log(`\n  (no boundary has settled on this vault — both NAVs are parity, so every`
    + `\n   P&L above is zero by construction and the benchmark is the same number.`
    + `\n   The diverged case is covered in tests/statement.test.ts against settle().)`);
  check('at parity, a position is worth exactly the cash put into it',
    st.total.value === st.total.quoteIn - st.total.quoteOut && st.total.pnl === 0n,
    `value ${st.total.value}, pnl ${st.total.pnl}`);
  check('and the split is a no-op against holding it whole', st.versusBundle === 0n, `${st.versusBundle}`);
} else {
  check('the benchmark is valued at the same NAV pair the vault reports',
    st.bundleNav === (v.nightNav + v.dayNav) / 2n, `${st.bundleNav}`);
  check('the split differs from the bundle only through funding and the roll',
    st.versusBundle === st.total.pnl - st.bundle.pnl, `${st.versusBundle}`);
}

console.log(failed ? `\n${failed} failed` : '\nthe statement reconciles against the chain');
process.exit(failed ? 1 : 0);
