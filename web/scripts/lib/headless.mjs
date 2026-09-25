/* The headless browser and wallet the flow harnesses share.

   A browser extension cannot run headless, but a wallet is only an object
   that announces itself through the Wallet Standard. `injectWallet` is one,
   backed by a devnet keypair, registered before the app loads. It signs with
   web3.js, the library the app builds its transactions with, so what is
   signed is what the UI produced. `openChrome` starts headless Chrome and
   returns the small driver the flows use. Taken from chain-flow.mjs, which
   keeps its own copy. */

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { WebSocket } from 'ws';

export const injectWallet = (wallet, rpc, { name = 'Headless Test Wallet' } = {}) => `
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
    name: ${JSON.stringify(name)},
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
          const c = new Connection(${JSON.stringify(rpc)}, 'confirmed');
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find(existsSync);

const waitPort = (p) => new Promise((res, rej) => {
  const t0 = Date.now();
  const go = () => {
    const s = createConnection({ port: p, host: '127.0.0.1' }, () => { s.end(); res(); });
    s.on('error', () => { s.destroy(); Date.now() - t0 > 15000 ? rej(new Error('no port')) : setTimeout(go, 120); });
  };
  go();
});

let launches = 0;

/** Headless Chrome with the wallet injected into every document. */
export async function openChrome(inject, { width = 1440, height = 900, dsf = 1, profile: profileName = 'flow' } = {}) {
  // a new port per launch: a process may open several browsers in turn, and
  // the last one can still be letting go of its port
  const profile = `/tmp/session-${profileName}-${process.pid}-${launches}`;
  const port = 9350 + ((process.pid + launches++ * 37) % 300);
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    // keep animation frames running: a headless page otherwise counts as backgrounded
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore' });
  await waitPort(port);
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.once('open', r));
  let id = 0;
  const pend = new Map();
  const logs = [];
  const handlers = new Map();
  ws.on('message', (b) => {
    const m = JSON.parse(b.toString());
    if (m.method && handlers.has(m.method)) for (const fn of handlers.get(m.method)) fn(m.params);
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    else if (m.method === 'Runtime.exceptionThrown') logs.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 300));
    return r.result.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dsf, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: inject });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await send('Page.bringToFront').catch(() => {});
  const until = async (fn, ms = 25000, every = 400) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (await fn()) return true; } catch { /* not yet */ }
      await wait(every);
    }
    return false;
  };
  return {
    ev,
    send,
    /** Subscribe to a CDP event, e.g. Fetch.requestPaused. */
    onEvent: (method, fn) => handlers.set(method, [...(handlers.get(method) ?? []), fn]),
    logs,
    until,
    wait,
    navigate: (url) => send('Page.navigate', { url }),
    text: () => ev('document.body.innerText'),
    type: (sel, v, nth = 0) => ev(`(() => { const el = document.querySelectorAll(${JSON.stringify(sel)})[${nth}]; if (!el) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`),
    clickText: (sel, text) => ev(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.trim().startsWith(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`),
    close: () => { try { ws.close(); } catch {} chrome.kill('SIGKILL'); try { rmSync(profile, { recursive: true, force: true }); } catch {} },
  };
}
