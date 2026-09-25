/* ───────────────────────────────────────────────────────────────────────────
   A bell order through the real page, with a real wallet, on devnet.

   Connects the headless wallet on /bells, places a buy and a sell in the next
   bell's cross through the ticket, and reads the chain after each: the order
   account holds exactly what was typed, and exactly that left the wallet for
   the market's escrow and the cross's totals. The sell is typed in displayed
   NVDAx, so it also proves the page divides by the mint's multiplier the way
   the program expects. Then both are cancelled from "Your orders", and the
   chain is read again: the orders are closed, every atom and the rent is
   back, and only the four network fees are gone.

   The test wallet is funded by the operator before the run. --fresh starts
   from a new keypair and funds it with the ticket's own faucet button.
   Against a local build there is no /api, so that request is answered
   in-process by the bundled function (web/api/faucet.js, from
   `npm run functions`): the code the site deploys, minting on devnet.

   Needs the site served: the dev server on :3100 by default, or a build
   (npm run build && npx vite preview --port 3200, then --base).

   usage: node scripts/bells-flow.mjs [--base http://localhost:3100] [--fresh]
   ─────────────────────────────────────────────────────────────────────────── */

import { readFileSync } from 'node:fs';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { injectWallet, openChrome } from './lib/headless.mjs';
import { bellTs, etDay } from '../../sdk/src/bell.ts';
import { multiplierWad, readScaledUi, WAD } from '../../sdk/src/cross.ts';
import {
  ataOf, cancelOrderIx, CROSS_PROGRAM_ID, crossPda, decodeCross, decodeMarket, decodeOrder, marketRef, quoteEscrowPda, rawEscrowPda,
} from '../../sdk/src/cross-ix.ts';
import { createAtaIdempotentIx } from '../../sdk/src/ix.ts';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const BASE = arg('base', 'http://localhost:3100');
const LOCAL = /\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE + '/');
const FRESH = argv.includes('--fresh');
const ROOT = new URL('../..', import.meta.url).pathname;

const m = JSON.parse(readFileSync(`${ROOT}web/public/cross-devnet.json`, 'utf8'));
const { rpc } = JSON.parse(readFileSync(`${ROOT}keeper/.devnet/manifest.json`, 'utf8'));
const secret = (f) => Uint8Array.from(JSON.parse(readFileSync(`${ROOT}keeper/.devnet/${f}`, 'utf8')));
const operator = Keypair.fromSecretKey(secret('operator.json'));
const wallet = FRESH ? Keypair.generate() : Keypair.fromSecretKey(secret('test-wallet.json'));
const conn = new Connection(rpc, 'confirmed');

const MARKET = new PublicKey(m.market);
const MINT = new PublicKey(m.mint);
const MINT_PROGRAM = new PublicKey(m.mintProgram);
const QUOTE = new PublicKey(m.quoteMint);
const QUOTE_PROGRAM = new PublicKey(m.quoteProgram);
const myRaw = ataOf(wallet.publicKey, MINT, MINT_PROGRAM);
const myQuote = ataOf(wallet.publicKey, QUOTE, QUOTE_PROGRAM);
const rawEscrow = rawEscrowPda(MARKET);
const quoteEscrow = quoteEscrowPda(MARKET);

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

/* ── the chain, read directly ───────────────────────────────────────────── */

const tokenAmount = (info) => (info && info.data.length >= 72 ? info.data.readBigUInt64LE(64) : 0n);
/** The public RPC refuses bursts; a refused read is asked again, not failed. */
async function retry(fn, tries = 5) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries || !/429|rate limit|fetch failed/i.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 2_000 * i));
    }
  }
}
async function snapshot(cross = null) { return retry(() => snapshotOnce(cross)); }
async function snapshotOnce(cross = null) {
  const [sol, infos] = await Promise.all([
    conn.getBalance(wallet.publicKey),
    conn.getMultipleAccountsInfo([myQuote, myRaw, quoteEscrow, rawEscrow, MINT, ...(cross ? [cross] : [])]),
  ]);
  const [q, r, qe, re, mint, c] = infos;
  const scaled = readScaledUi(mint.data);
  const now = Math.floor(Date.now() / 1000);
  return {
    sol: BigInt(sol),
    quote: tokenAmount(q), raw: tokenAmount(r), quoteEscrow: tokenAmount(qe), rawEscrow: tokenAmount(re),
    cross: c ? decodeCross(c.data) : null,
    crossRent: c ? BigInt(c.lamports) : 0n,
    multiplier: (scaled && scaled !== 'malformed' ? multiplierWad(now >= scaled.newEffectiveTs ? scaled.newBits : scaled.currentBits) : null) ?? WAD,
  };
}
/** The order the page just placed: its note names the account, the chain says what is in it. */
async function placed(side, since) {
  const notes = await page.ev(`JSON.parse(localStorage.getItem('session.bell-orders.v1.${wallet.publicKey.toBase58()}') ?? '[]')`);
  const note = notes.find((n) => n.side === side && n.placedAt >= since);
  if (!note) return null;
  const info = await retry(() => conn.getAccountInfo(new PublicKey(note.order)));
  return info && info.owner.equals(CROSS_PROGRAM_ID) ? { address: note.order, o: decodeOrder(info.data) } : null;
}

/* ── fund the wallet from the operator ──────────────────────────────────── */

function mintToIx(mint, dest, amount, program) {
  const data = Buffer.alloc(9);
  data[0] = 7;
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: operator.publicKey, isSigner: true, isWritable: false },
    ],
    data,
  });
}

async function fund() {
  const before = await snapshot();
  const tx = new Transaction();
  if (before.sol < BigInt(0.03 * LAMPORTS_PER_SOL)) {
    tx.add(SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: wallet.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }));
  }
  if (before.quote < 100n * 10n ** 6n) {
    tx.add(createAtaIdempotentIx(operator.publicKey, wallet.publicKey, QUOTE, QUOTE_PROGRAM), mintToIx(QUOTE, myQuote, 1_000n * 10n ** 6n, QUOTE_PROGRAM));
  }
  if (before.raw < 10n ** 8n) {
    tx.add(createAtaIdempotentIx(operator.publicKey, wallet.publicKey, MINT, MINT_PROGRAM), mintToIx(MINT, myRaw, 2n * 10n ** 8n, MINT_PROGRAM));
  }
  if (tx.instructions.length) await sendAndConfirmTransaction(conn, tx, [operator], { commitment: 'confirmed' });
}

/* ── the run ────────────────────────────────────────────────────────────── */

console.log(`bells-flow: wallet ${wallet.publicKey.toBase58()}${FRESH ? ' (fresh)' : ''} against ${BASE}`);
if (!FRESH) await fund();

// The bell the ticket should offer first, worked out here from the SDK
// calendar rather than read off the page.
const now = Math.floor(Date.now() / 1000);
const freeze = m.params.freezeSecs;
const next = (kind) => {
  for (let d = etDay(now); d < etDay(now) + 12; d++) {
    const ts = bellTs(d, kind);
    if (ts !== null && ts - freeze > now) return { day: d, ts, kind };
  }
  return null;
};
const [o, c] = [next('open'), next('close')];
const bell = o && c && o.ts < c.ts ? o : c;
if (bell.ts - freeze - now < 180) {
  console.log(`  the ${bell.kind} freezes in ${bell.ts - freeze - now}s, too close to place and cancel in; run again after it`);
  process.exit(1);
}
const cross = crossPda(MARKET, bell.day, bell.kind);
const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
console.log(`  next bell: the ${bell.kind} at ${et.format(bell.ts * 1000)} ET, cross ${cross.toBase58()}`);

const page = await openChrome(injectWallet(wallet, rpc), { width: 1440, height: 1000 });
const { ev, until, clickText, type } = page;
const TICKET = 'section[aria-labelledby="ticket-h"]';

/* A local build has no serverless functions. Hold the page's faucet request
   and answer it with the bundled function itself, with the operator key it
   reads on Vercel. The key goes into this process's environment only. */
if (FRESH && LOCAL) {
  process.env.OPERATOR_KEYPAIR = JSON.stringify([...operator.secretKey]);
  const { default: faucet } = await import('../api/faucet.js');
  const { Readable } = await import('node:stream');
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/faucet*', requestStage: 'Request' }] });
  page.onEvent('Fetch.requestPaused', async ({ requestId, request }) => {
    const req = Object.assign(Readable.from(request.postData ? [Buffer.from(request.postData)] : []), {
      method: request.method, url: '/api/faucet', headers: { host: 'localhost', ...Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v])) },
    });
    const headers = [];
    let status = 200;
    const res = {
      set statusCode(v) { status = v; },
      setHeader: (name, value) => headers.push({ name, value: String(value) }),
      end: (buf) => page.send('Fetch.fulfillRequest', { requestId, responseCode: status, responseHeaders: headers, body: Buffer.from(buf ?? '').toString('base64') }),
    };
    await faucet(req, res);
  });
}

try {
  console.log(`\n${BASE}/bells`);
  await page.navigate(`${BASE}/bells`);
  check('the ticket renders', await until(() => ev(`!!document.querySelector('#ticket-h')`)));
  check('the book reads the market from devnet', await until(() => ev(`/The book for the/.test(document.body.innerText)`)));
  const label = `${bell.kind === 'open' ? 'Open' : 'Close'} · `;
  check(`the ticket offers the ${bell.kind} first`, await ev(`(() => { const b = document.querySelector('${TICKET} [role="radiogroup"] [aria-checked="true"]'); return !!b && b.textContent.startsWith(${JSON.stringify(label)}) && b.textContent.endsWith(${JSON.stringify(et.format(bell.ts * 1000))}); })()`),
    await ev(`document.querySelector('${TICKET} [role="radiogroup"] [aria-checked="true"]')?.textContent ?? '(none)'`));
  check('cancel-until is the freeze', await ev(`document.querySelector('${TICKET}').innerText.includes(${JSON.stringify(`${et.format((bell.ts - freeze) * 1000)} ET`)})`));

  /* ── connect ─────────────────────────────────────────────────────────── */
  check('the ticket asks to connect', await clickText(`${TICKET} button`, 'Connect wallet'));
  check('the modal lists the injected wallet', await until(() => ev(`[...document.querySelectorAll('[role="dialog"] button')].some(b => /Headless Test Wallet/.test(b.textContent))`), 8000));
  check('pick it', await clickText('[role="dialog"] button', 'Headless Test Wallet'));
  check('connected: the ticket offers a buy', await until(() => ev(`[...document.querySelectorAll('${TICKET} button')].some(b => b.textContent.trim() === 'Place buy order')`), 15000));

  if (FRESH) {
    check('ask the faucet', await clickText(`${TICKET} button`, 'Get test USDC'));
    const sent = await until(() => ev(`/Sent 10,000 test USDC, 10\\.\\d+ fixture NVDAx/.test(document.body.innerText)`), 90000, 800);
    check('the faucet sends quote and fixture NVDAx', sent, (await ev(`[...document.querySelectorAll('[role="status"], [role="alert"]')].map(e => e.textContent).join(' | ')`)).slice(0, 200));
    const f = await snapshot(cross);
    check('on chain: 10,000 test USDC and 10 raw NVDAx arrived', f.quote === 10_000n * 10n ** 6n && f.raw === 10n * 10n ** 8n, `quote ${f.quote} raw ${f.raw}`);
    check('on chain: and SOL for fees', f.sol >= BigInt(0.02 * LAMPORTS_PER_SOL), `${f.sol}`);
  }

  const s0 = await snapshot(cross);
  const usd = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  check('the ticket shows the wallet\'s quote', await until(() => ev(`document.querySelector('${TICKET}').innerText.includes(${JSON.stringify(`You hold ${usd(Number(s0.quote) / 1e6)}.`)})`), 25000),
    await ev(`document.querySelector('${TICKET}').innerText.match(/You hold [^\\n]*/)?.[0] ?? '(none)'`));
  const t0 = Date.now();

  /* ── a buy ───────────────────────────────────────────────────────────── */
  check('type $5', await type(`${TICKET} input`, '5'));
  check('the estimate reads', await until(() => ev(`/≈ [0-9.,]+ NVDAx|No print yet/.test(document.querySelector('${TICKET}').innerText)`), 5000));
  check('place it', await clickText(`${TICKET} button`, 'Place buy order'));
  check('the page confirms the buy', await until(() => ev(`/Buy \\$5\\.00 at the ${bell.kind}/.test(document.body.innerText)`), 60000, 500),
    (await ev(`[...document.querySelectorAll('[role="status"], [role="alert"]')].map(e => e.textContent).join(' | ')`)).slice(0, 200));
  let buy = null;
  await until(async () => !!(buy = await placed('buy', t0)), 30000, 1500);
  check('on chain: the buy order the page noted exists', !!buy);
  const s1 = await snapshot(cross);
  if (buy) {
    check('on chain: it holds exactly $5.000000, no limit, in this cross',
      buy.o.amount === 5_000_000n && buy.o.limitE8 === 0n && buy.o.cross.equals(cross) && buy.o.owner.equals(wallet.publicKey) && buy.o.status === 'open',
      `${buy.o.amount} ${buy.o.limitE8} ${buy.o.cross.toBase58()} ${buy.o.status}`);
  }
  check('on chain: exactly $5 left the wallet for the escrow',
    s0.quote - s1.quote === 5_000_000n && s1.quoteEscrow - s0.quoteEscrow === 5_000_000n, `wallet −${s0.quote - s1.quote}, escrow +${s1.quoteEscrow - s0.quoteEscrow}`);
  check('on chain: the cross counts it',
    s1.cross && s1.cross.buyTotal - (s0.cross?.buyTotal ?? 0n) === 5_000_000n && s1.cross.nOrders - (s0.cross?.nOrders ?? 0) === 1,
    s1.cross ? `buyTotal +${s1.cross.buyTotal - (s0.cross?.buyTotal ?? 0n)}, nOrders +${s1.cross.nOrders - (s0.cross?.nOrders ?? 0)}` : 'no cross');

  /* ── a sell, typed in displayed NVDAx, with a limit ─────────────────── */
  check('switch to sell', await clickText(`${TICKET} [role="radio"]`, 'Sell NVDAx'));
  check('the ticket offers a sell', await until(() => ev(`[...document.querySelectorAll('${TICKET} button')].some(b => b.textContent.trim() === 'Place sell order')`), 3000));
  await type(`${TICKET} input`, '0.5', 0);
  await type(`${TICKET} input`, '150.25', 1);
  check('place it', await clickText(`${TICKET} button`, 'Place sell order'));
  check('the page confirms the sell', await until(() => ev(`/Sell 0\\.5 NVDAx at the ${bell.kind}/.test(document.body.innerText)`), 60000, 500),
    (await ev(`[...document.querySelectorAll('[role="status"], [role="alert"]')].map(e => e.textContent).join(' | ')`)).slice(0, 200));
  let sell = null;
  await until(async () => !!(sell = await placed('sell', t0)), 30000, 1500);
  check('on chain: the sell order the page noted exists', !!sell);
  const s2 = await snapshot(cross);
  // 0.5 displayed NVDAx is 0.5e8 atoms of UI amount; the raw atoms are that
  // divided by the multiplier, rounded down, exactly as the program counts.
  const expectRaw = (50_000_000n * WAD) / s2.multiplier;
  if (sell) {
    check(`on chain: it holds ${expectRaw} raw atoms (0.5 ÷ the multiplier) and a $150.25 floor`,
      sell.o.amount === expectRaw && sell.o.limitE8 === 15_025_000_000n && sell.o.cross.equals(cross) && sell.o.owner.equals(wallet.publicKey),
      `${sell.o.amount} ${sell.o.limitE8}`);
  }
  check('on chain: exactly those atoms left the wallet for the escrow',
    s1.raw - s2.raw === expectRaw && s2.rawEscrow - s1.rawEscrow === expectRaw, `wallet −${s1.raw - s2.raw}, escrow +${s2.rawEscrow - s1.rawEscrow}`);
  check('on chain: the cross counts it', s2.cross && s2.cross.sellTotal - s1.cross.sellTotal === expectRaw && s2.cross.nOrders - s1.cross.nOrders === 1);

  /* ── both, listed and cancelled from "Your orders" ─────────────────── */
  const MINE = 'section[aria-labelledby="mine-h"]';
  check('"Your orders" lists both as open', await until(() => ev(`(() => { const t = document.querySelector('${MINE}')?.innerText ?? ''; return /Buy \\$5\\.00/.test(t) && /Sell 0\\.5 NVDAx/.test(t) && /only if NVDA ≥ \\$150\\.25/.test(t); })()`), 30000, 800));

  for (const [what, x] of [['buy', buy], ['sell', sell]]) {
    if (!x) continue;
    const row = `[...document.querySelectorAll('${MINE} li')].find(li => li.querySelector('a[href*="${x.address}"]'))`;
    check(`cancel the ${what}`, await ev(`(() => { const b = [...(${row})?.querySelectorAll('button') ?? []].find(b => b.textContent.trim() === 'Cancel'); if (!b) return false; b.click(); return true; })()`));
    check(`on chain: the ${what} order is closed`, await until(async () => !(await conn.getAccountInfo(new PublicKey(x.address))), 60000, 1500));
  }
  const s3 = await snapshot(cross);
  check('on chain: every atom is back in the wallet', s3.quote === s0.quote && s3.raw === s0.raw, `quote ${s3.quote - s0.quote}, raw ${s3.raw - s0.raw}`);
  check('on chain: the escrows are where they were', s3.quoteEscrow === s0.quoteEscrow && s3.rawEscrow === s0.rawEscrow);
  check('on chain: the cross no longer counts them',
    s3.cross && s3.cross.buyTotal === (s0.cross?.buyTotal ?? 0n) && s3.cross.sellTotal === (s0.cross?.sellTotal ?? 0n) && s3.cross.nOrders === (s0.cross?.nOrders ?? 0));
  // Order rent comes back on cancel; a cross this run created keeps its rent.
  const createdCross = s0.cross ? 0n : s3.crossRent;
  check('on chain: only four network fees are gone', s0.sol - s3.sol === 4n * 5000n + createdCross, `${s0.sol - s3.sol} lamports`);
  check('the page lists both as cancelled', await until(() => ev(`[...document.querySelectorAll('${MINE} li')].filter(li => /cancelled; the escrow came back whole/.test(li.innerText)).length >= 2`), 30000, 800));
  const after = await ev(`JSON.parse(localStorage.getItem('session.bell-orders.v1.${wallet.publicKey.toBase58()}') ?? '[]')`);
  check('and remembers it, so a clearing cannot read as a fill', [buy, sell].every((x) => x && after.find((n) => n.order === x.address)?.cancelledAt > 0));
  /* The public devnet RPC rate-limits per IP, and web3.js reports it as
     errors: each retry after a 429, a refused websocket, and a status poll
     inside confirmTransaction that has no catch of its own. Every check above
     read the chain and passed, so these are counted, not failed. */
  const transport = (l) => /\b429\b|rate limit|^ws error/i.test(l);
  const errors = page.logs.filter((l) => !transport(l));
  check('no errors in the console', errors.length === 0, errors.slice(0, 3).join(' | ').slice(0, 300));
  const limited = page.logs.length - errors.length;
  if (limited) console.log(`  note  the public devnet RPC refused or rate-limited the page ${limited} time(s); web3.js retried`);
} catch (e) {
  check('the run finished', false, e instanceof Error ? e.message : String(e));
} finally {
  await cleanup();
  page.close();
}

/* Whatever this run placed and the page did not get to cancel is cancelled
   here, signed by the run's own wallet, so a failed run leaves nothing in a
   real cross. A fresh wallet's key exists only in this process. */
async function cleanup() {
  try {
    const notes = [];
    for (const kind of ['buy', 'sell']) {
      const x = await placed(kind, 0).catch(() => null);
      if (x && x.o.status === 'open') notes.push(x);
    }
    if (!notes.length) return;
    const ref = marketRef(MARKET, decodeMarket((await retry(() => conn.getAccountInfo(MARKET))).data));
    for (const { address, o } of notes) {
      const c = decodeCross((await retry(() => conn.getAccountInfo(o.cross))).data);
      await retry(() => sendAndConfirmTransaction(conn, new Transaction().add(
        cancelOrderIx(ref, { owner: wallet.publicKey, day: c.day, kind: c.kind, nonce: o.nonce, side: o.side }),
      ), [wallet], { commitment: 'confirmed' }));
      console.log(`  clean up: cancelled ${o.side} ${address} the page left open`);
    }
  } catch (e) {
    console.log(`  clean up failed: ${String(e).slice(0, 160)} (wallet ${wallet.publicKey.toBase58()})`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
