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

   usage: node scripts/chain-flow.mjs [--base http://localhost:3100] [--list]
   ─────────────────────────────────────────────────────────────────────────── */

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { WebSocket } from 'ws';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';

/** The classic SPL token program, for the throwaway mint the listing test opens a vault over. */
const SPL_TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

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
/* Chrome writes ~90MB of profile per run and never cleans it up; a few
   days of harness runs filled this machine's disk. Named here so the
   teardown removes the same directory the browser was given. */
const PROFILE = '/tmp/session-chainflow-' + process.pid;
const PORT = 9650 + (process.pid % 300);

let passed = 0, failed = 0, skipped = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
/* Not every red line is a bug. A public endpoint that refuses to serve a
   history is an environment condition, and reporting it as a product failure
   trains the reader to ignore the output. Named, counted, and never silent. */
const skip = (name, why) => { skipped++; console.log(`  SKIP  ${name} — ${why}`); };
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
  /* Per run, always. A persisted profile would let the page's own event cache
     carry over — which is what the cache is for — but wallet-adapter also
     remembers the selected wallet there and autoconnects, so the connect flow
     under test would never run. */
  '--user-data-dir=' + PROFILE, 'about:blank',
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

  /* A statement row, as numbers. `$1,234.56` and `1,234` are what a reader
     sees; comparing one run against the last needs them back as quantities. */
  const readStatement = () => ev(`(() => {
    const sec = document.querySelector('section[aria-label="Your statement"]');
    if (!sec) return null;
    const n = t => Number(t.replace(/[$,+\\s\u2212]/g, '')) * (t.includes('\u2212') ? -1 : 1);
    return {
      rows: [...sec.querySelectorAll('tbody tr')].map(r => {
        const c = [...r.querySelectorAll('td')].map(x => x.textContent.trim());
        return { name: r.querySelector('th').textContent.trim(), shares: n(c[0]), in: n(c[1]), out: n(c[2]), pnl: n(c[3]), bench: r.dataset.bench === 'true' };
      }),
      verdict: (sec.querySelector('[data-role="verdict"]')?.textContent ?? '').trim(),
      trades: Number((sec.textContent.match(/(\\d+) trades?,/) ?? [0, 0])[1]),
    };
  })()`);
  /* Wait for the ledger to have decoded what it is going to decode, so the
     baseline is this wallet's real history and not a half-filled one — a
     short read here would show up later as a delta that is too large. A
     wallet that has never traded has no statement at all, which is a zero
     baseline rather than a failure. */
  const statementState = () => ev(`(() => {
    const sec = document.querySelector('section[aria-label="Your statement"]');
    if (!sec) return 'absent';
    return sec.dataset.loading === 'true' ? 'reading' : 'ready';
  })()`);
  const settled = async () => (await statementState()) === 'ready';

  /* Sampled the instant the wallet connects, before the ledger has read the
     history back. A statement that is already 'ready' here would be summing
     rows it has not decoded — which is precisely the wrong total this gate
     exists to prevent. */
  check('the statement waits rather than showing a partial total',
    (await statementState()) !== 'ready');
  /* A statement summed from part of a history would be wrong, so the panel
     refuses to render one until the whole window is decoded. On a public
     endpoint that is already throttling this address that read can simply not
     finish, and there is nothing to compare against. */
  const baseline = (await until(settled, 180000, 1000)) ? await readStatement() : null;
  const before = baseline ?? { rows: [], verdict: '', trades: 0 };
  const ZERO_ROW = { shares: 0, in: 0, out: 0, pnl: 0 };

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

  // Scoped to the form. The ledger below now describes past mints in the
  // same words, so a body-wide search matches history rather than this one.
  const minted = await until(() => ev(`/Minted 100/.test(document.querySelector('form')?.innerText ?? '')`), 60000, 600);
  const flash = await ev(`[...document.querySelectorAll('form p[role="status"]')].map(p => p.textContent).join(' | ')`);
  check('mint confirmed on chain with a signature link', minted && /view transaction/.test(flash), flash.slice(0, 160));
  const sig1 = await ev(`document.querySelector('form p[role="status"] a[href*="explorer.solana.com/tx/"]')?.href.match(/tx\\/([1-9A-HJ-NP-Za-km-z]+)/)?.[1] ?? null`);
  /* The page is backfilling its ledger over the same public endpoint, so this
     one competes for the per-IP budget. A 429 here says nothing about the
     product; failing on it would be a flaky test reporting a bug that is not
     there. Back off and ask again. */
  let throttled = false;
  const fetchTx = async sg => {
    for (let i = 0; i < 6; i++) {
      try { return await conn.getTransaction(sg, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); }
      catch (e) { if (!/429|Too Many/.test(String(e))) throw e; await wait(1500 * (i + 1)); }
    }
    throttled = true;
    return null;
  };
  const tx1 = sig1 && await fetchTx(sig1);
  if (throttled) skip('signature is a real devnet transaction', 'the endpoint refused six times; the page confirmed it, this could not re-read it');
  else check('signature is a real devnet transaction', !!sig1 && !!tx1, String(sig1));

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

  /* ── 6. the statement, and the thing it is measured against ──────────── */
  /* The test wallet is reused between runs, so its statement carries every
     earlier run too. Asserting "$100.00 in" would pass exactly once and then
     report a bug that is not there — the figures below are the *delta* this
     run added, which is what this run is responsible for. */
  /* The ledger re-reads after a trade, so the panel shows the previous
     history for a moment. Wait for this run's two trades to be in it before
     asking what it says — the count is an independent signal from the
     amounts asserted below, so waiting on it does not make them vacuous. */
  const stmt = baseline && await until(
    async () => ((await readStatement())?.trades ?? 0) >= before.trades + 2, 90000, 1000);
  if (!baseline) skip('the statement panel', 'the devnet endpoint would not serve the vault history');
  else check('the statement picks up this run\'s two trades', stmt, `was ${before.trades}`);
  if (stmt) {
    const after = await readStatement();
    /* Two lines always — the position, which comes from the wallet's own
       trades — and a third when the vault's whole history has been read,
       because pricing the undivided pair needs every boundary. On a
       throttled endpoint the third legitimately does not arrive, and a
       panel that showed it anyway would be showing a number it guessed. */
    check('both classes are listed', after.rows.length >= 2, JSON.stringify(after.rows.map(r => r.name)));
    const bench = after.rows.find(r => r.bench);
    if (bench) {
      check('the benchmark carries the same cash flows as both classes together',
        Math.round(bench.in * 100) === Math.round((after.rows[0].in + after.rows[1].in) * 100)
        && Math.round(bench.out * 100) === Math.round((after.rows[0].out + after.rows[1].out) * 100),
        JSON.stringify(after.rows.map(r => [r.in, r.out])));
      check('and the panel says what the split was worth against holding it whole',
        /undivided|whole|neither helped/i.test(after.verdict), after.verdict.slice(0, 140));
    } else {
      skip('the undivided benchmark', 'the vault history needed to price it did not finish loading');
      check('and the panel says the comparison is missing rather than guessing it',
        /needs every boundary/i.test(after.verdict), after.verdict.slice(0, 140));
    }
    const pick = st => st.rows.find(r => r.name.toLowerCase().endsWith(parked)) ?? ZERO_ROW;
    const a = pick(after), b = pick(before);
    check('this run added 60 shares to the traded class', a.shares - b.shares === 60, `${b.shares} -> ${a.shares}`);
    check('and $100.00 of quote in', Math.round((a.in - b.in) * 100) === 10000, `${b.in} -> ${a.in}`);
    check('and $40.00 out', Math.round((a.out - b.out) * 100) === 4000, `${b.out} -> ${a.out}`);
  }

  /* The decoded history is kept in localStorage so a return visit does not
     re-read the whole vault over a rate-limited endpoint. Its encoder is the
     fragile half: `JSON.stringify` calls `toJSON()` before the replacer sees
     a value, so a PublicKey arrives already flattened to a bare string and is
     indistinguishable from any other. If the tags below stop appearing, the
     cache has started returning strings where the ledger expects keys. */
  const cache = await ev(`(() => {
    const raw = localStorage.getItem('session.events.v1');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const fields = parsed.flatMap(([, evs]) => evs.map(e => e.fields));
    return {
      entries: parsed.length,
      keys: fields.filter(f => Object.values(f).some(v => typeof v === 'string' && v.startsWith('k:'))).length,
      bigints: fields.filter(f => Object.values(f).some(v => typeof v === 'string' && v.startsWith('n:'))).length,
    };
  })()`);
  check('the decoded history is cached for the next visit', !!cache && cache.entries > 0, JSON.stringify(cache));
  check('public keys survive the round trip as keys, not as bare strings', (cache?.keys ?? 0) > 0, JSON.stringify(cache));
  check('and u64 fields survive as bigints', (cache?.bigints ?? 0) > 0, JSON.stringify(cache));

  /* ── 7. open a vault, as somebody who is not the operator ────────────── */
  //
  // `initialize_vault` takes no permission: the signer becomes the authority
  // and the address is derived from the mint pair. That has been true since
  // the program shipped and was not reachable from a browser, which is the
  // difference between a property and a claim. This is the claim, exercised
  // by the *test* wallet — not the operator, not the deploy key.
  /* Opt-in, because this one is not idempotent: there is no `close_vault`, so
     every run leaves a vault on chain for good and spends the test wallet's
     rent doing it. `--list` runs it; the rest of the suite stays repeatable. */
  const freshMint = Keypair.generate();
  const listSymbol = 'T' + Date.now().toString(36).slice(-5).toUpperCase();
  if (!argv.includes('--list')) {
    skip('opening a vault from the browser', 'pass --list; it creates a vault that cannot be closed');
  } else try {
    const rent = await conn.getMinimumBalanceForRentExemption(82);
    const mk = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: operator.publicKey, newAccountPubkey: freshMint.publicKey,
        lamports: rent, space: 82, programId: SPL_TOKEN,
      }),
      // InitializeMint2: [0x14][decimals][mint authority][freeze option]
      new TransactionInstruction({
        programId: SPL_TOKEN,
        keys: [{ pubkey: freshMint.publicKey, isSigner: false, isWritable: true }],
        data: Buffer.concat([
          Buffer.from([20, 6]), operator.publicKey.toBuffer(), Buffer.from([0]),
        ]),
      }),
    );
    await sendAndConfirmTransaction(conn, mk, [operator, freshMint], { commitment: 'confirmed' });
  } catch (e) {
    skip('opening a vault from the browser', `could not create a mint to open it over: ${e.message ?? e}`);
  }

  const mintExists = argv.includes('--list')
    && !!(await conn.getAccountInfo(freshMint.publicKey).catch(() => null));
  if (mintExists) {
    await send('Page.navigate', { url: `${BASE}/list` });
    await until(() => ev(`!!document.querySelector('#list-symbol')`), 20000);

    check('the listing form is reachable without asking anybody',
      await ev(`!!document.querySelector('#list-underlying') && !!document.querySelector('#list-quote')`));

    await type('#list-symbol', listSymbol);
    await type('#list-underlying', freshMint.publicKey.toBase58());
    await type('#list-quote', manifest.quoteMint);
    // The form reads both mints off the chain before it derives anything.
    const read = await until(() => ev(
      `document.querySelectorAll('form [class*="read"]').length >= 2`), 20000, 400);
    check('it reads both mints from the chain rather than trusting the box', read);

    const decimalsShown = await ev(`[...document.querySelectorAll('form [class*="read"]')].map(e => e.textContent).join(' | ')`);
    check('and reports the decimals and the token program it found',
      /6 decimals/.test(decimalsShown) && /SPL Token \(classic\)/.test(decimalsShown), decimalsShown.slice(0, 160));

    // The address is not the form's opinion: it is `findProgramAddress` over
    // the two mints, so the page and the SDK must agree to the character.
    const [want] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), freshMint.publicKey.toBuffer(), new PublicKey(manifest.quoteMint).toBuffer()],
      new PublicKey(manifest.programId),
    );
    const shownAddr = await ev(`(() => {
      const rows = [...document.querySelectorAll('form [class*="derivedRow"]')];
      const v = rows.find(r => /vault/i.test(r.textContent));
      return v ? v.querySelector('a').textContent.trim() : '';
    })()`);
    const w = want.toBase58();
    check('the vault address the page shows is the one the seeds derive',
      shownAddr.startsWith(w.slice(0, 6)) && shownAddr.includes(w.slice(-6)), `${shownAddr} vs ${w}`);

    const why = await ev(`(() => {
      const b = document.querySelector('form button[type="submit"]');
      return {
        label: b ? b.textContent.trim() : 'no button',
        disabled: b ? b.disabled : null,
        connected: !!document.body.innerText.match(/Connect wallet/) ? 'nav says connect' : 'nav looks connected',
        form: [...document.querySelectorAll('form p')].map(p => p.textContent.trim()).join(' | ').slice(0, 200),
      };
    })()`);
    check('the button is live once both mints resolve', why.disabled === false, JSON.stringify(why));

    check('click open', await ev(`(() => {
      const b = document.querySelector('form button[type="submit"]');
      if (!b || b.disabled) return false; b.click(); return true;
    })()`));

    const opened = await until(() => ev(`/is open/.test(document.body.innerText)`), 90000, 1000);
    const said = await ev(`[...document.querySelectorAll('form p')].map(p => p.textContent).join(' | ')`);
    check('the vault opens, signed by a wallet that is nobody in particular', opened, said.slice(0, 200));

    if (opened) {
      const acc = await conn.getAccountInfo(want).catch(() => null);
      check('and the account exists on devnet', !!acc, w);
      // Anchor stamps sha256("account:Vault")[..8]; the census filters on it.
      check('carrying the vault discriminator the catalog scans for',
        !!acc && [211, 8, 232, 43, 2, 152, 117, 119].every((b, i) => acc.data[i] === b));

      await send('Page.navigate', { url: `${BASE}/markets` });
      /* Wait for the scan to land, not for the section to exist. An empty
         skeleton contains neither the new symbol nor the toggle, so asserting
         against it would pass for the wrong reason and then fail to click. */
      const scanned = await until(() => ev(
        `!!document.querySelector('section[aria-label="Vaults on chain"] a[class*="item"], section[aria-label="Vaults on chain"] button')`),
        30000, 500);
      check('the catalog finished scanning the program', scanned);
      const curatedOnly = await ev(`document.querySelector('section[aria-label="Vaults on chain"]').innerText`);
      check('a new vault is not curated, so the catalog does not show it by default',
        !curatedOnly.includes(listSymbol), curatedOnly.slice(0, 160));
      check('but it is one click away', await clickText('section[aria-label="Vaults on chain"] button', 'Show all'));
      const all = await until(() => ev(
        `document.querySelector('section[aria-label="Vaults on chain"]').innerText.includes(${JSON.stringify(listSymbol)})`), 10000);
      check('and then it is listed, marked uncurated', all);
    }
  }

  /* ── 8. disconnect ───────────────────────────────────────────────────── */
  check('open the account menu', await clickText('header button[aria-haspopup="menu"]', wallet.publicKey.toBase58().slice(0, 4)));
  await wait(150);
  check('disconnect', await clickText('[role="menu"] button', 'Disconnect'));
  const gone = await until(() => ev(`document.body.innerText.includes('Connect wallet')`), 8000);
  check('nav returns to "Connect wallet"', gone);

  if (logs.length) { console.log('\nconsole errors:'); for (const l of [...new Set(logs)].slice(0, 6)) console.log('  ' + l.slice(0, 200)); }
  console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exitCode = failed ? 1 : 0;
} finally {
  /* Wait for it to actually go. `kill()` only sends the signal, and Chrome
     flushes its profile on the way out — removing the directory first just
     lets it write the files back, which is how ~90MB a run accumulated until
     the disk was full. */
  chrome.kill();
  await new Promise(r => { chrome.once('exit', r); setTimeout(r, 4000); });
  rmSync(PROFILE, { recursive: true, force: true });
}
