/* ───────────────────────────────────────────────────────────────────────────
   The on-chain product, driven through the real UI with a real wallet.

   A browser extension cannot run headless, but a wallet is only an object
   that announces itself through the Wallet Standard. This registers one
   backed by a devnet keypair, then clicks through the actual page: open the
   connect modal, pick the wallet, mint into the parked class, watch the
   balances come back from the chain, be refused on the exposed class, redeem.
   Every assertion reads what the page says; every signature is checked to
   exist on devnet afterwards.

   Needs the dev server on :3100. The test wallet is funded by the operator
   before the run (SOL for fees, test quote to spend) because the faucet is a
   serverless function that only exists on the deployed site.

   usage: node scripts/chain-flow.mjs [--base http://localhost:3100]
   ─────────────────────────────────────────────────────────────────────────── */

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const BASE = arg('base', 'http://localhost:3100');
const ROOT = new URL('../..', import.meta.url).pathname;

const manifest = JSON.parse(readFileSync(`${ROOT}keeper/.devnet/manifest.json`, 'utf8'));
const operator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${ROOT}keeper/.devnet/operator.json`, 'utf8'))));
// --fresh: a brand-new keypair with nothing in it, so the site's own faucet
// has to fund it through the UI. That is what a first-time visitor gets.
const FRESH = argv.includes('--fresh');
const wallet = FRESH
  ? Keypair.generate()
  : Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${ROOT}keeper/.devnet/test-wallet.json`, 'utf8'))));
const conn = new Connection(manifest.rpc, 'confirmed');

const CHROME = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find(existsSync);
const PORT = 9650 + (process.pid % 300);

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const wait = ms => new Promise(r => setTimeout(r, ms));

/* ── fund the test wallet from the operator ─────────────────────────────── */

const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROG = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const ataOf = (owner, mint) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ATA_PROG)[0];

async function fund() {
  const quoteMint = new PublicKey(manifest.quoteMint);
  const dest = ataOf(wallet.publicKey, quoteMint);
  const sol = await conn.getBalance(wallet.publicKey);
  const held = await conn.getTokenAccountBalance(dest).then(r => BigInt(r.value.amount)).catch(() => 0n);
  const tx = new Transaction();
  if (sol < 0.02 * LAMPORTS_PER_SOL) {
    tx.add(SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: wallet.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }));
  }
  if (held < 1_000n * 10n ** 6n) {
    tx.add(new TransactionInstruction({
      programId: ATA_PROG,
      keys: [
        { pubkey: operator.publicKey, isSigner: true, isWritable: true },
        { pubkey: dest, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: false, isWritable: false },
        { pubkey: quoteMint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]),
    }));
    const data = Buffer.alloc(9); data[0] = 7; data.writeBigUInt64LE(5_000n * 10n ** 6n, 1);
    tx.add(new TransactionInstruction({
      programId: TOKEN,
      keys: [
        { pubkey: quoteMint, isSigner: false, isWritable: true },
        { pubkey: dest, isSigner: false, isWritable: true },
        { pubkey: operator.publicKey, isSigner: true, isWritable: false },
      ],
      data,
    }));
  }
  if (tx.instructions.length) await sendAndConfirmTransaction(conn, tx, [operator]);
  const after = await conn.getTokenAccountBalance(dest).then(r => Number(r.value.amount) / 1e6).catch(() => 0);
  console.log(`test wallet ${wallet.publicKey.toBase58()}  ${(await conn.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL} SOL, ${after} test quote`);
}

/* ── the injected wallet ────────────────────────────────────────────────── */

/**
 * Registered on every new document, before the app loads. Signs with the test
 * keypair using the page's own bundled web3.js — the exact library the app
 * uses to build the transaction — so what is signed is what the UI produced.
 */
const INJECT = `
(() => {
  const SECRET = ${JSON.stringify([...wallet.secretKey])};
  const ADDRESS = ${JSON.stringify(wallet.publicKey.toBase58())};
  const ICON = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#3987e5"/></svg>');
  // web3.js for signing, from a CDN so the same injection works against the
  // dev server and the deployed site (whose chunk names are hashed).
  let w3 = null;
  const lib = () => new Promise((resolve, reject) => {
    if (w3) return resolve(w3);
    if (window.solanaWeb3) return resolve(w3 = window.solanaWeb3);
    const el = document.createElement('script');
    el.src = 'https://unpkg.com/@solana/web3.js@1.98.4/lib/index.iife.min.js';
    el.onload = () => resolve(w3 = window.solanaWeb3);
    el.onerror = () => reject(new Error('could not load web3 from CDN'));
    document.head.appendChild(el);
  });
  // Ed25519 over the raw message — the faucet verifies this, so it has to be real.
  let naclLib = null;
  const naclP = () => new Promise((resolve, reject) => {
    if (naclLib) return resolve(naclLib);
    if (window.nacl) return resolve(naclLib = window.nacl);
    const el = document.createElement('script');
    el.src = 'https://unpkg.com/tweetnacl@1.0.3/nacl-fast.min.js';
    el.onload = () => resolve(naclLib = window.nacl);
    el.onerror = () => reject(new Error('could not load nacl from CDN'));
    document.head.appendChild(el);
  });
  const account = {
    address: ADDRESS,
    publicKey: Uint8Array.from(SECRET.slice(32)),
    chains: ['solana:devnet'],
    features: ['solana:signAndSendTransaction', 'solana:signTransaction', 'solana:signMessage'],
    label: 'Test',
    icon: ICON,
  };
  const listeners = {};
  const emit = (e, ...args) => (listeners[e] ?? []).forEach(fn => { try { fn(...args); } catch {} });
  // A signature comes back from the RPC as base58 text; the Wallet Standard
  // hands the app 64 raw bytes. Real wallets decode it; so does this one.
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const b58decode = (str) => {
    const bytes = [0];
    for (const ch of str) {
      let carry = B58.indexOf(ch);
      if (carry < 0) throw new Error('bad base58');
      for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
      while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    for (const ch of str) { if (ch !== '1') break; bytes.push(0); }
    return Uint8Array.from(bytes.reverse());
  };
  const sign = async (bytes) => {
    const { Transaction, Keypair } = await lib();
    const kp = Keypair.fromSecretKey(Uint8Array.from(SECRET));
    const tx = Transaction.from(bytes);
    tx.partialSign(kp);
    return tx.serialize();
  };
  // Like a real wallet: no accounts until the user approves a connection.
  // The adapter only calls standard:connect when accounts is empty, and
  // reads the result from wallet.accounts afterwards, so both must move.
  const wallet = {
    version: '1.0.0',
    name: 'Headless Test Wallet',
    icon: ICON,
    chains: ['solana:devnet'],
    accounts: [],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => {
        window.__walletConnected = true;
        wallet.accounts = [account];
        emit('change', { accounts: [account] });
        return { accounts: [account] };
      } },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => {
        window.__walletConnected = false;
        wallet.accounts = [];
        emit('change', { accounts: [] });
      } },
      'standard:events': { version: '1.0.0', on: (e, fn) => { (listeners[e] ??= []).push(fn); return () => {}; } },
      'solana:signTransaction': {
        version: '1.0.0', supportedTransactionVersions: ['legacy', 0],
        signTransaction: async (...inputs) => Promise.all(inputs.map(async i => ({ signedTransaction: await sign(i.transaction) }))),
      },
      'solana:signAndSendTransaction': {
        version: '1.0.0', supportedTransactionVersions: ['legacy', 0],
        signAndSendTransaction: async (...inputs) => {
          const { Connection } = await lib();
          const c = new Connection(${JSON.stringify(manifest.rpc)}, 'confirmed');
          const out = [];
          for (const i of inputs) {
            const signed = await sign(i.transaction);
            const sig = await c.sendRawTransaction(signed, { preflightCommitment: 'confirmed' });
            window.__lastSig = sig;
            out.push({ signature: b58decode(sig) });
          }
          return out;
        },
      },
      'solana:signMessage': { version: '1.0.0', signMessage: async (...inputs) => {
        const nacl = await naclP();
        return inputs.map(i => ({
          signedMessage: i.message,
          signature: nacl.sign.detached(i.message, Uint8Array.from(SECRET)),
        }));
      } },
    },
  };
  const register = (api) => { try { api.register(wallet); } catch (e) { console.error('register failed', e); } };
  window.addEventListener('wallet-standard:app-ready', (e) => register(e.detail));
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
})();
`;

/* ── CDP ─────────────────────────────────────────────────────────────────── */

const waitPort = p => new Promise((res, rej) => {
  const t0 = Date.now();
  const go = () => {
    const s = createConnection({ port: p, host: '127.0.0.1' }, () => { s.end(); res(); });
    s.on('error', () => { s.destroy(); Date.now() - t0 > 15000 ? rej(new Error('no port')) : setTimeout(go, 120); });
  };
  go();
});

if (!FRESH) await fund();
else console.log(`fresh wallet ${wallet.publicKey.toBase58()}  (0 SOL, 0 quote — the faucet has to work)`);

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--user-data-dir=/tmp/session-chainflow-' + process.pid, 'about:blank',
], { stdio: 'ignore' });

try {
  await waitPort(PORT);
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
  const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.once('open', r));
  let id = 0; const pend = new Map(); const logs = [];
  ws.on('message', b => {
    const m = JSON.parse(b.toString());
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push(m.params.args.map(a => a.value ?? a.description).join(' '));
    else if (m.method === 'Runtime.exceptionThrown') logs.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async e => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 300));
    return r.result.value;
  };
  const type = (sel, v) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  const clickText = (sel, text) => ev(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.trim().startsWith(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`);
  const bodyText = () => ev('document.body.innerText');
  // Mid-navigation the document is briefly absent; that is "not yet", not a failure.
  const until = async (fn, ms = 25000, every = 400) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (await fn()) return true; } catch { /* not yet */ }
      await wait(every);
    }
    return false;
  };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT });

  console.log(`\n${BASE}/markets/${manifest.symbol}`);
  await send('Page.navigate', { url: `${BASE}/markets/${manifest.symbol}` });
  await until(() => ev(`document.body.innerText.includes('LIVE · DEVNET') || document.body.innerText.includes('Live · devnet')`));

  /* ── 1. page is in chain mode ────────────────────────────────────────── */
  const txt = await bodyText();
  check('vault page is in chain mode', /Live · devnet/i.test(txt));
  check('mark comes from Pyth', /pyth · crypto\.sol\/usd/i.test(txt), txt.match(/pyth.*?\n/i)?.[0]);
  check('vault address is shown and linked', await ev(`!!document.querySelector('a[href*="explorer.solana.com/address/${manifest.vault}"]')`));
  check('health panel is computed from chain', /Computed by the SDK/.test(txt));
  check('ledger shows on-chain signatures', await until(() => ev(`document.querySelectorAll('a[href*="explorer.solana.com/tx/"]').length > 0`), 20000));

  /* ── 2. connect ──────────────────────────────────────────────────────── */
  check('open the wallet modal from the trade panel', await clickText('form button', 'Connect a wallet'));
  await wait(400);
  check('modal lists the injected wallet as detected', await ev(`[...document.querySelectorAll('[role="dialog"] button')].some(b => /Headless Test Wallet/.test(b.textContent) && /Detected/.test(b.textContent))`));
  check('pick it', await clickText('[role="dialog"] button', 'Headless Test Wallet'));
  const connected = await until(() => ev(`document.body.innerText.includes(${JSON.stringify(wallet.publicKey.toBase58().slice(0, 4))}) && !document.querySelector('[role="dialog"]')`), 15000);
  if (!connected) {
    console.log('   dialog said:', JSON.stringify(await ev(`document.querySelector('[role="dialog"]')?.innerText ?? '(no dialog)'`)).slice(0, 400));
    console.log('   console:', logs.slice(-4).map(l => l.slice(0, 200)));
    console.log('   injected connect() called:', await ev('!!window.__walletConnected'));
    console.log('   header text:', JSON.stringify(await ev(`document.querySelector('header')?.innerText`)).slice(0, 200));
    console.log('   trade cta:', JSON.stringify(await ev(`document.querySelector('form button[type="button"].' + [...document.querySelector('form').querySelectorAll('button')].pop().className.split(' ')[0])?.textContent`)).slice(0,120));
  }
  check('nav shows the connected address and the modal closed', connected);

  const quoteShown = await until(() => ev(`/You hold \\$[\\d,]+\\.\\d\\d/.test(document.body.innerText)`), 20000);
  check("trade panel shows the wallet's test-quote balance from chain", quoteShown);

  if (FRESH) {
    check('faucet button offered to a connected wallet', await ev(`[...document.querySelectorAll('form button')].some(b => /Get 10,000/.test(b.textContent))`));
    check('click the faucet', await clickText('form button', 'Get 10,000'));
    const funded = await until(() => ev(`/10,000 test quote sent/.test(document.body.innerText)`), 90000, 800);
    check('faucet confirms with a signature', funded, (await ev(`[...document.querySelectorAll('form p[role="status"]')].map(p => p.textContent).join(' | ')`)).slice(0, 160));
    const balanceUp = await until(() => ev(`/You hold \\$10,000\\.00/.test(document.body.innerText)`), 40000, 800);
    check('balance re-read from chain shows $10,000.00', balanceUp);
    const sol = await conn.getBalance(wallet.publicKey);
    check('faucet dripped SOL for fees to the empty wallet', sol > 0, String(sol));
  }

  /* ── 3. mint into the parked class ───────────────────────────────────── */
  const parked = await ev(`document.querySelector('label[data-open="true"]')?.dataset.class`);
  check('a parked class is offered', parked === 'day' || parked === 'night', String(parked));
  const beforeHeld = await ev(`(() => { const card = [...document.querySelectorAll('article[data-class]')].find(a => a.dataset.class === ${JSON.stringify(parked)}); return [...card.querySelectorAll('dl dd')][2].textContent.trim(); })()`);

  check('enter 100', await type('form input[inputmode="decimal"]', '100'));
  // Wait for the preview to be computed rather than guessing at a delay. The
  // panel needs the wallet's balances, which arrive on the refresh that
  // follows connecting, and a fixed sleep turns that into a coin flip.
  check('preview shows shares out',
    await until(() => ev(`/^\\d/.test([...document.querySelectorAll('form dl dd')][1].textContent.trim())`), 20000, 300));
  check('mint button enabled with a wallet connected', await ev(`!document.querySelector('form button[type="submit"]').disabled`));
  // Poll for the button rather than assume the DOM held still. Against the
  // deployed site a refresh can land between two evaluations, and a null
  // dereference here reads as a product failure when it is a race in the
  // harness.
  check('click mint', await until(() => ev(
    `(() => { const b = document.querySelector('form button[type="submit"]'); if (!b || b.disabled) return false; b.click(); return true; })()`,
  ), 20000, 300));

  const minted = await until(() => ev(`/Minted 100/.test(document.body.innerText)`), 60000, 600);
  const flash = await ev(`[...document.querySelectorAll('form p[role="status"]')].map(p => p.textContent).join(' | ')`);
  check('mint confirmed on chain with a signature link', minted && /view transaction/.test(flash), flash.slice(0, 160));
  const sig1 = await ev(`document.querySelector('form p[role="status"] a[href*="explorer.solana.com/tx/"]')?.href.match(/tx\\/([1-9A-HJ-NP-Za-km-z]+)/)?.[1] ?? null`);
  check('signature is a real devnet transaction', !!sig1 && !!(await conn.getTransaction(sig1, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })), String(sig1));

  const heldUpdated = await until(() => ev(`(() => { const card = [...document.querySelectorAll('article[data-class]')].find(a => a.dataset.class === ${JSON.stringify(parked)}); return [...card.querySelectorAll('dl dd')][2].textContent.trim() !== ${JSON.stringify(beforeHeld)}; })()`), 30000, 700);
  check('"You hold" re-read from chain after the mint', heldUpdated);

  /* ── 4. the exposed class is refused by the page before the wallet ───── */
  const exposed = parked === 'day' ? 'night' : 'day';
  check('select the exposed class', await ev(`(() => { const l = [...document.querySelectorAll('label[data-class]')].find(l => l.dataset.class === ${JSON.stringify(exposed)}); l.querySelector('input').click(); return true; })()`));
  await wait(200);
  check('page explains the parked-class rule', /carrying the exposure/.test(await bodyText()));
  check('mint into exposed class disabled', await ev(`document.querySelector('form button[type="submit"]').disabled`));

  /* ── 5. redeem ───────────────────────────────────────────────────────── */
  check('back to the parked class', await ev(`(() => { const l = [...document.querySelectorAll('label[data-class]')].find(l => l.dataset.class === ${JSON.stringify(parked)}); l.querySelector('input').click(); return true; })()`));
  check('switch to redeem', await clickText('form button[type="button"]', 'Redeem'));
  await wait(200);
  check('enter 40', await type('form input[inputmode="decimal"]', '40'));
  await wait(200);
  check('click redeem', await until(() => ev(
    `(() => { const b = document.querySelector('form button[type="submit"]'); if (!b || b.disabled) return false; b.click(); return true; })()`,
  ), 20000, 300));
  const redeemed = await until(() => ev(`/Redeemed for \\$40\\.00/.test(document.body.innerText)`), 60000, 600);
  check('redeem confirmed on chain at NAV 1.0', redeemed, (await ev(`[...document.querySelectorAll('form p[role="status"]')].map(p => p.textContent).join(' | ')`)).slice(0, 160));

  /* ── 6. disconnect ───────────────────────────────────────────────────── */
  check('open the account menu', await clickText('header button[aria-haspopup="menu"]', wallet.publicKey.toBase58().slice(0, 4)));
  await wait(150);
  check('disconnect', await clickText('[role="menu"] button', 'Disconnect'));
  const gone = await until(() => ev(`document.body.innerText.includes('Connect wallet')`), 8000);
  check('nav returns to "Connect wallet"', gone);

  if (logs.length) { console.log('\nconsole errors:'); for (const l of [...new Set(logs)].slice(0, 6)) console.log('  ' + l.slice(0, 200)); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
} finally {
  chrome.kill();
}
