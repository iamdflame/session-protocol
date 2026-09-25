/* The bell tools, called the way an agent calls them: a real MCP client over
   stdio, against the real server, on devnet. Every write is read back from
   the chain rather than taken from the tool's answer.

   The server signs with the chain-flow test wallet here (SESSION_KEYPAIR),
   which holds test USDC and fixture NVDAx; the order it places is cancelled
   before the run ends.

     npm run mcp:check
*/

import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { decodeOrder } from '../sdk/src/cross-ix.ts';

const KEY = process.env.SESSION_KEYPAIR ?? 'keeper/.devnet/test-wallet.json';
const { rpc } = JSON.parse(readFileSync('keeper/.devnet/manifest.json', 'utf8'));
const conn = new Connection(rpc, 'confirmed');

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const client = new Client({ name: 'mcp-check', version: '1.0.0' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: ['--experimental-strip-types', '--no-warnings', 'agent/mcp.ts'],
  env: { ...process.env, SESSION_KEYPAIR: KEY } as Record<string, string>,
}));

type Out = { text: string; json: Record<string, any> | null };
async function call(name: string, args: Record<string, unknown> = {}): Promise<Out> {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n');
  let json = null;
  try { json = JSON.parse(text); } catch { /* a sentence, not JSON */ }
  return { text, json };
}

try {
  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const t of ['bell_status', 'bell_quote', 'bell_receipt', 'bell_place_order', 'bell_cancel_order']) check(`lists ${t}`, tools.includes(t));
  check('keeps the session tools', tools.includes('session_health') && tools.includes('session_mint'));

  const st = await call('bell_status');
  check('bell_status: the next open and close', st.json?.next?.length === 2 && st.json.next.every((n: any) => n.cross && n.freezesAt), st.text.slice(0, 200));
  check('bell_status: the multiplier from the mint', Math.abs((st.json?.multiplier ?? 0) - 1.0017) < 0.001, String(st.json?.multiplier));
  check('bell_status: says it is devnet', /Devnet/.test(st.json?.note ?? ''));

  const qb = await call('bell_quote', { side: 'buy', amount: 50 });
  check('bell_quote buy: a bell and its freeze', !!qb.json?.bell?.at && !!qb.json?.bell?.cancelUntil, qb.text.slice(0, 200));
  check('bell_quote buy: a swap now, or why not', !!qb.json?.swapNow && ('out' in qb.json.swapNow || 'noRoute' in qb.json.swapNow));
  const qs = await call('bell_quote', { side: 'sell', amount: 0.2 });
  const m = st.json?.multiplier ?? 1;
  check('bell_quote sell: 0.2 NVDAx is 0.2 ÷ the multiplier in raw atoms', Math.abs(Number(qs.json?.order?.rawAtoms) - 0.2e8 / m) <= 1, qs.json?.order?.rawAtoms);

  const big = await call('bell_place_order', { side: 'buy', amount: 500 });
  check('bell_place_order: $500 is over the cap and refused', /^Refused: .*cap/.test(big.text), big.text.slice(0, 160));

  const placed = await call('bell_place_order', { side: 'buy', amount: 3, limit: 150 });
  check('bell_place_order: $3 with a $150 ceiling', !!placed.json?.order, placed.text.slice(0, 200));
  if (placed.json?.order) {
    const info = await conn.getAccountInfo(new PublicKey(placed.json.order));
    const o = info ? decodeOrder(info.data) : null;
    check('on chain: the order holds exactly $3, a $150 limit', !!o && o.amount === 3_000_000n && o.limitE8 === 15_000_000_000n && o.side === 'buy');
    check('on chain: in the cross it names', !!o && o.cross.toBase58() === placed.json.cross);

    const cancelled = await call('bell_cancel_order', { order: placed.json.order });
    check('bell_cancel_order: cancelled', cancelled.json?.cancelled === placed.json.order, cancelled.text.slice(0, 160));
    check('on chain: the order is closed', !(await conn.getAccountInfo(new PublicKey(placed.json.order))));
    const again = await call('bell_cancel_order', { order: placed.json.order });
    check('bell_cancel_order: twice is a plain answer', /no open order/.test(again.text), again.text.slice(0, 120));
  }

  const r = await call('bell_receipt');
  check('bell_receipt: a receipt, or a plain "not yet"', !!r.json?.cross || /No cross has finished yet/.test(r.text), r.text.slice(0, 160));
  if (r.json?.cross) {
    check('bell_receipt: the print verified here', r.json.print?.signatureVerifiedHere === true && r.json.print?.signedEqualsStored === true, JSON.stringify(r.json.print));
    check('bell_receipt: a link to the page', String(r.json.receipt).endsWith(`/b/${r.json.cross}`));
  }
} catch (e) {
  check('the run finished', false, e instanceof Error ? e.message : String(e));
} finally {
  await client.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
