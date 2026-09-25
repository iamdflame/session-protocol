/* ───────────────────────────────────────────────────────────────────────────
   The bell-order Action, driven the way a Blink client drives it.

   Runs the bundled function itself (api/bell-action.js, from
   `npm run functions`) in this process: the card and its CORS headers, every
   refusal, then a real POST for the chain-flow test wallet. The transaction
   it returns is decoded, signed by that wallet, sent to devnet and read
   back, then cancelled.

   usage: node scripts/actions-check.mjs
   ─────────────────────────────────────────────────────────────────────────── */

import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { CROSS_DISCRIMINATOR, CROSS_PROGRAM_ID, cancelOrderIx, decodeCross, decodeMarket, decodeOrder, marketRef } from '../../sdk/src/cross-ix.ts';

const ROOT = new URL('../..', import.meta.url).pathname;
const { rpc } = JSON.parse(readFileSync(`${ROOT}keeper/.devnet/manifest.json`, 'utf8'));
const cm = JSON.parse(readFileSync(`${ROOT}web/public/cross-devnet.json`, 'utf8'));
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${ROOT}keeper/.devnet/test-wallet.json`, 'utf8'))));
const conn = new Connection(rpc, 'confirmed');
const { default: action } = await import('../api/bell-action.js');

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

/** One request through the function, as Vercel would make it. */
async function call(method, path, body) {
  const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
    method, url: path, headers: { host: 'session-roan.vercel.app', 'content-type': 'application/json' },
  });
  return new Promise((resolve) => {
    const headers = {};
    let status = 200;
    action(req, {
      set statusCode(v) { status = v; },
      setHeader: (k, v) => { headers[k.toLowerCase()] = String(v); },
      end: (buf) => {
        const text = Buffer.from(buf ?? '').toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* empty */ }
        resolve({ status, headers, json });
      },
    });
  });
}

const rules = JSON.parse(readFileSync(`${ROOT}web/public/actions.json`, 'utf8')).rules;
check('actions.json maps /bells to the action', rules.some((r) => r.pathPattern === '/bells' && r.apiPath === '/api/bell-action'));
const vercel = JSON.parse(readFileSync(`${ROOT}web/vercel.json`, 'utf8'));
check('vercel.json serves actions.json to any origin', vercel.headers.some((h) => h.source === '/actions.json' && h.headers.some((x) => x.key === 'Access-Control-Allow-Origin' && x.value === '*')));

/* ── the card ────────────────────────────────────────────────────────────── */

const get = await call('GET', '/api/bell-action');
check('GET: 200', get.status === 200, String(get.status));
check('GET: any origin, and the spec\'s version and chain headers', get.headers['access-control-allow-origin'] === '*' && get.headers['x-action-version'] === '2.4' && get.headers['x-blockchain-ids'] === 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1');
check('GET: an action with an absolute icon', get.json?.type === 'action' && /^https:\/\//.test(get.json.icon));
check('GET: says what, when, and that it is devnet', /NVDAx at the NYSE (open|close)/.test(get.json?.title) && /ET print/.test(get.json?.description) && /Devnet/.test(get.json?.description));
const acts = get.json?.links?.actions ?? [];
check('GET: $25, $100, and an amount of your own', acts.length === 3 && acts[2].parameters?.[0]?.name === 'amount' && acts.every((a) => a.href.startsWith('/api/bell-action?side=buy&amount=')));
const sell = await call('GET', '/api/bell-action?side=sell');
check('GET ?side=sell: the sell card', /^Sell NVDAx/.test(sell.json?.title) && sell.json.links.actions.every((a) => a.href.includes('side=sell')));
const opt = await call('OPTIONS', '/api/bell-action');
check('OPTIONS: 204 with the CORS headers', opt.status === 204 && /POST/.test(opt.headers['access-control-allow-methods'] ?? ''));

/* ── refusals, before anything is signed ─────────────────────────────────── */

const badAccount = await call('POST', '/api/bell-action?side=buy&amount=25', { account: 'nope' });
check('POST: a bad account is 400, with a message', badAccount.status === 400 && /account/.test(badAccount.json?.message ?? ''));
const tooBig = await call('POST', '/api/bell-action?side=buy&amount=5000', { account: wallet.publicKey.toBase58() });
check('POST: over the Blink cap is 400', tooBig.status === 400 && /between \$1 and \$1,000/.test(tooBig.json?.message ?? ''), tooBig.json?.message);
const noAmount = await call('POST', '/api/bell-action?side=buy', { account: wallet.publicKey.toBase58() });
check('POST: no amount is 400', noAmount.status === 400);
const broke = await call('POST', '/api/bell-action?side=buy&amount=25', { account: Keypair.generate().publicKey.toBase58() });
check('POST: an empty wallet is told where the faucet is', broke.status === 422 && /faucet/.test(broke.json?.message ?? ''), broke.json?.message);

/* ── a real order ────────────────────────────────────────────────────────── */

const post = await call('POST', '/api/bell-action?side=buy&amount=2', { account: wallet.publicKey.toBase58() });
check('POST: a transaction to sign', post.status === 200 && post.json?.type === 'transaction' && typeof post.json.transaction === 'string', JSON.stringify(post.json).slice(0, 160));
check('POST: says when it fills and until when it cancels', /fills at the .* print\. Cancel on \/bells until/.test(post.json?.message ?? ''));
check('POST: chains to a completed card', post.json?.links?.next?.type === 'inline' && post.json.links.next.action?.type === 'completed');
if (post.json?.transaction) {
  const tx = Transaction.from(Buffer.from(post.json.transaction, 'base64'));
  check('the wallet pays its own fee', tx.feePayer?.equals(wallet.publicKey));
  const ix = tx.instructions.find((i) => i.programId.equals(CROSS_PROGRAM_ID));
  check('one place_order, to session-cross', tx.instructions.length === 1 && !!ix && CROSS_DISCRIMINATOR.place_order.every((b, i) => ix.data[i] === b));
  tx.partialSign(wallet);
  const sig = await sendAndConfirmTransaction(conn, tx, [wallet], { commitment: 'confirmed' }).catch((e) => { check('devnet accepts it', false, String(e).slice(0, 200)); return null; });
  if (sig) {
    check('devnet accepts it', true);
    // the order is the account place_order created: find it by what it holds
    const accts = await Promise.all(ix.keys.map((k) => conn.getAccountInfo(k.pubkey)));
    const i = accts.findIndex((a) => a && a.owner.equals(CROSS_PROGRAM_ID) && a.data.length === 103);
    const order = i >= 0 ? decodeOrder(accts[i].data) : null;
    check('on chain: exactly $2, a buy, this wallet\'s', !!order && order.amount === 2_000_000n && order.side === 'buy' && order.owner.equals(wallet.publicKey));
    if (order) {
      const market = new PublicKey(cm.market);
      const ref = marketRef(market, decodeMarket((await conn.getAccountInfo(market)).data));
      const c = decodeCross((await conn.getAccountInfo(order.cross)).data);
      await sendAndConfirmTransaction(conn, new Transaction().add(cancelOrderIx(ref, { owner: wallet.publicKey, day: c.day, kind: c.kind, nonce: order.nonce, side: 'buy' })), [wallet], { commitment: 'confirmed' });
      check('cancelled again, closed on chain', !(await conn.getAccountInfo(ix.keys[i].pubkey)));
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
