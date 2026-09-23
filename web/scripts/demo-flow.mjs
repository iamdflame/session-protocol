/* ───────────────────────────────────────────────────────────────────────────
   Drive the demo the way a judge would.

   /trade?demo=1 is a sandbox copy of the NVDAx vault, seeded from devnet and
   run with the program's own arithmetic in the page. This opens it with no
   wallet, checks it says DEMO wherever a figure could be taken for the chain,
   mints into the open class, rings the bell and checks that exposure moved to
   the class just minted — and that nothing tried to sign or send.

   usage: node scripts/demo-flow.mjs [--base http://localhost:3200]
   ─────────────────────────────────────────────────────────────────────────── */

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { WebSocket } from 'ws';

const BASE = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'http://localhost:3100';
const CHROME = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find(existsSync);
/* Chrome writes ~90MB of profile per run and never cleans it up; a few
   days of harness runs filled this machine's disk. Named here so the
   teardown removes the same directory the browser was given. */
const PROFILE = '/tmp/session-demo-' + process.pid;
const PORT = 9700 + (process.pid % 300);

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-sandbox',
  '--disable-gpu', '--hide-scrollbars', '--user-data-dir=' + PROFILE,
  'about:blank',
], { stdio: 'ignore' });

const waitPort = p => new Promise((res, rej) => {
  const t0 = Date.now();
  const go = () => {
    const s = createConnection({ port: p, host: '127.0.0.1' }, () => { s.end(); res(); });
    s.on('error', () => { s.destroy(); Date.now() - t0 > 15000 ? rej(new Error('no port')) : setTimeout(go, 120); });
  };
  go();
});

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

try {
  await waitPort(PORT);
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
  const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.once('open', r));

  let id = 0; const pend = new Map();
  ws.on('message', b => {
    const m = JSON.parse(b.toString());
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id); pend.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async e => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' — ' + (r.exceptionDetails.exception?.description ?? '').slice(0, 200));
    return r.result.value;
  };
  const wait = ms => new Promise(r => setTimeout(r, ms));

  /* Wait for the page to *be* something, rather than sleeping and hoping.
     A fixed pause is a bet on how fast the machine is that day: the same
     build that passes on a warm profile reports eight failures on a cold
     one, and every one of them is a lie about the product. Poll instead,
     and say so when the condition never arrives. */
  const until = async (expression, label, ms = 20000) => {
    const t0 = Date.now();
    for (;;) {
      if (await ev(expression)) return true;
      if (Date.now() - t0 > ms) { check(`page ready: ${label}`, false, `still false after ${ms}ms`); return false; }
      await wait(100);
    }
  };
  /* The loading skeleton carries the page's h1 too — a screen reader should
     land on a heading while the vault loads — so a heading alone does not mean
     the page is ready. The trade form does. */
  const rendered = () => until(`!!document.querySelector('main h1')?.textContent && !!document.querySelector('main form input[inputmode="decimal"]')`, 'vault page painted');

  /* React-controlled inputs ignore a plain `.value =`; set it through the
     native setter and dispatch an input event, which is what typing does. */
  const type = (selector, value) => ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const click = selector => ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.click();
    return true;
  })()`);
  const clickText = (selector, text) => ev(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find(e => e.textContent.trim().startsWith(${JSON.stringify(text)}));
    if (!el) return false;
    el.click();
    return true;
  })()`);
  const text = selector => ev(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '').trim()`);
  const bodyText = () => ev(`document.body.innerText`);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  console.log('\ndemo');
  await send('Page.navigate', { url: `${BASE}/trade?demo=1` });
  // The sandbox seeds from devnet, which can take a while on a throttled endpoint.
  await until(`!!document.querySelector('main form input[inputmode="decimal"]')`, 'demo seeded from devnet', 90000);

  /* ── 1. it says what it is ───────────────────────────────────────────── */
  const txt = await bodyText();
  check('the page is labelled demo and read-only', /demo · read-only/i.test(txt));
  check('the trade panel is labelled demo, not live', /demo · simulated/i.test(await text('main section[aria-label^="Trade"]')));
  check('nothing on it claims to be live on devnet', !/live · devnet/i.test(txt), (txt.match(/.{0,30}live · devnet.{0,30}/i) ?? [''])[0]);
  check('a way to do it for real is offered', await ev(`[...document.querySelectorAll('button')].some(b => /Trade for real|Connect wallet/.test(b.textContent))`));

  /* ── 2. mint into the open class ─────────────────────────────────────── */
  const parked = await ev(`document.querySelector('label[data-open="true"]')?.dataset.class`);
  check('a parked class is open to mint', parked === 'day' || parked === 'night', String(parked));
  const exposedBefore = await ev(`document.querySelector('article[data-exposed]')?.dataset.class`);
  check('the other class holds the stock', exposedBefore && exposedBefore !== parked, String(exposedBefore));
  check('enter 1000', await type('form input[inputmode="decimal"]', '1000'));
  await until(`/^\\d/.test([...document.querySelectorAll('form dl dd')][1]?.textContent.trim() ?? '')`, 'preview computed');
  check('the mint button is live without a wallet', await ev(`!document.querySelector('form button[type="submit"]').disabled`));
  check('click mint', await click('form button[type="submit"]'));
  await until(`/Minted [\\d,.]+/.test(document.querySelector('form')?.innerText ?? '')`, 'mint applied');
  const said = await ev(`[...document.querySelectorAll('form p[role="status"]')].map(p => p.textContent).join(' | ')`);
  check('the result says it went to the sandbox, not the chain', /demo sandbox/i.test(said) && !/view transaction/i.test(said), said.slice(0, 160));
  const held = await ev(`(() => { const c = [...document.querySelectorAll('article[data-class]')].find(a => a.dataset.class === ${JSON.stringify(parked)}); return c?.querySelector('[data-field="held"]')?.textContent.trim(); })()`);
  check('the class card shows the sandbox holding', held && held !== '0' && held !== '—', String(held));

  /* ── 3. ring the bell ────────────────────────────────────────────────── */
  check('ring the bell', await clickText('button', 'Ring the bell'));
  await until(`document.querySelector('article[data-exposed]')?.dataset.class === ${JSON.stringify(parked)}`, 'exposure moved', 5000);
  const exposedAfter = await ev(`document.querySelector('article[data-exposed]')?.dataset.class`);
  check('exposure moved to the class just minted', exposedAfter === parked, `${exposedBefore} -> ${exposedAfter}`);
  const openAfter = await ev(`document.querySelector('label[data-open="true"]')?.dataset.class`);
  check('and the other class is now the open one', openAfter === exposedBefore, String(openAfter));
  const kinds = await ev(`[...document.querySelectorAll('section[aria-label="Sandbox activity"] li[data-kind]')].map(l => l.dataset.kind)`);
  check('the sandbox ledger records the settlement and the mint', kinds[0] === 'settle' && kinds.includes('mint'), JSON.stringify(kinds));

  /* ── 4. nothing was sent ─────────────────────────────────────────────── */
  check('no wallet was asked for anything', !(await ev(`!!document.querySelector('[role="dialog"]')`)));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
} finally {
  chrome.kill();
  await new Promise(r => { chrome.once('exit', r); setTimeout(r, 4000); });
  rmSync(PROFILE, { recursive: true, force: true });
}
