/* ───────────────────────────────────────────────────────────────────────────
   Drive the product, end to end, in a real browser.

   Rendering is not the same as working. This opens a vault, mints into the
   parked class, checks every figure that should have moved, tries the class
   that is holding the stock and expects to be refused, redeems back to zero,
   checks the ledger, and reloads to prove the position survived. Each step
   reads the page the way a person would — by what it says.

   usage: node scripts/flow.mjs [symbol]
   ─────────────────────────────────────────────────────────────────────────── */

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import { WebSocket } from 'ws';

const SYMBOL = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2] : 'SPYx';
const BASE = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'http://localhost:3100';
const CHROME = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find(existsSync);
const PORT = 9700 + (process.pid % 300);

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-sandbox',
  '--disable-gpu', '--hide-scrollbars', '--user-data-dir=/tmp/session-flow-' + process.pid,
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

  // A clean vault every run, so the assertions are about this run.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{ if(!sessionStorage.getItem('flow.cleared')){ localStorage.removeItem('session.vault.${SYMBOL}'); sessionStorage.setItem('flow.cleared','1'); } }catch(e){}`,
  });

  console.log(`\nvault ${SYMBOL}`);
  await send('Page.navigate', { url: `${BASE}/markets/${SYMBOL}` });
  await wait(3500);

  /* ── 1. the page knows what it is ────────────────────────────────────── */
  const h1 = await text('main h1');
  check('vault page renders the symbol', h1 === SYMBOL, `h1 was "${h1}"`);

  const parkedTag = await ev(`(() => {
    const open = [...document.querySelectorAll('label[data-open="true"]')][0];
    return open ? open.querySelector('span').textContent.trim() : null;
  })()`);
  check('one class is marked open (parked)', !!parkedTag, 'no open class found');
  const parked = parkedTag?.split('.')[1]?.toLowerCase();
  const exposed = parked === 'day' ? 'night' : 'day';

  const emptyHint = (await bodyText()).includes('Nothing minted in this browser yet');
  check('empty vault shows the instructive empty state', emptyHint);

  /* ── 2. mint into the parked class ───────────────────────────────────── */
  check('amount input present', await type('form input[inputmode="decimal"]', '1000'));
  await wait(150);
  const sharesOut = await ev(`(() => {
    const dds = [...document.querySelectorAll('form dl dd')];
    return dds[1]?.textContent.trim() ?? '';
  })()`);
  check('preview shows shares out at NAV 1.0', sharesOut.replace(/,/g, '') === '1000', `preview said "${sharesOut}"`);

  check('mint button enabled', await ev(`!document.querySelector('form button[type="submit"]').disabled`));
  check('click mint', await click('form button[type="submit"]'));
  await wait(300);

  const flash = await ev(`[...document.querySelectorAll('form p[role="status"]')].map(p => p.textContent).join(' | ')`);
  check('mint confirmation shown', /Minted 1,000/.test(flash), `status was "${flash}"`);

  const after = await ev(`(() => {
    const card = [...document.querySelectorAll('article[data-class]')].find(a => a.dataset.class === ${JSON.stringify(parked)});
    const dd = [...card.querySelectorAll('dl dd')].map(d => d.textContent.trim());
    return { supply: dd[0], value: dd[1], mine: dd[2] };
  })()`);
  check('parked class supply is 1,000', after.supply === '1,000', `supply "${after.supply}"`);
  check('parked class value is $1,000.00', after.value === '$1,000.00', `value "${after.value}"`);
  check('you hold 1,000', after.mine === '1,000', `mine "${after.mine}"`);

  const health = await ev(`(() => {
    const dd = [...document.querySelectorAll('section[aria-label="Vault health"] dl dd')].map(d => d.textContent.trim());
    return { backing: dd[0], claims: dd[1], margin: dd[2] };
  })()`);
  check('health: backing equals claims after mint', health.backing === '$1,000.00' && health.claims === '$1,000.00', JSON.stringify(health));
  check('health: margin is zero', health.margin === '+$0.00', `margin "${health.margin}"`);

  const emptyGone = !(await bodyText()).includes('Nothing minted in this browser yet');
  check('empty state disappears once minted', emptyGone);

  const ledger = await ev(`[...document.querySelectorAll('ol li[data-kind]')].map(l => l.dataset.kind)`);
  check('ledger records the mint', ledger[0] === 'mint', `ledger ${JSON.stringify(ledger)}`);

  /* ── 3. the exposed class refuses ────────────────────────────────────── */
  check('select the exposed class', await ev(`(() => {
    const l = [...document.querySelectorAll('label[data-class]')].find(l => l.dataset.class === ${JSON.stringify(exposed)});
    if (!l) return false; l.querySelector('input').click(); return true;
  })()`));
  await wait(150);
  const blocked = await ev(`document.querySelector('form p[role="status"]')?.textContent ?? ''`);
  check('exposed class explains why it is closed', /carrying the exposure/.test(blocked) && /reopens/.test(blocked), blocked.slice(0, 80));
  check('mint into exposed class is disabled', await ev(`document.querySelector('form button[type="submit"]').disabled`));

  /* ── 4. redeem everything ────────────────────────────────────────────── */
  check('select the parked class again', await ev(`(() => {
    const l = [...document.querySelectorAll('label[data-class]')].find(l => l.dataset.class === ${JSON.stringify(parked)});
    l.querySelector('input').click(); return true;
  })()`));
  check('switch to redeem', await clickText('form button[type="button"]', 'Redeem'));
  await wait(150);
  check('max button fills the held amount', await clickText('form button[type="button"]', 'max'));
  await wait(150);
  const quoteOut = await ev(`[...document.querySelectorAll('form dl dd')][1]?.textContent.trim() ?? ''`);
  check('redeem preview shows $1,000.00 out', quoteOut === '$1,000.00', `preview "${quoteOut}"`);
  check('click redeem', await click('form button[type="submit"]'));
  await wait(300);

  const zero = await ev(`(() => {
    const card = [...document.querySelectorAll('article[data-class]')].find(a => a.dataset.class === ${JSON.stringify(parked)});
    return [...card.querySelectorAll('dl dd')].map(d => d.textContent.trim());
  })()`);
  check('supply back to 0 after redeem', zero[0] === '0', `supply "${zero[0]}"`);
  check('you hold 0 after redeem', zero[2] === '0', `mine "${zero[2]}"`);

  const ledger2 = await ev(`[...document.querySelectorAll('ol li[data-kind]')].map(l => l.dataset.kind)`);
  check('ledger records redeem then mint', ledger2[0] === 'redeem' && ledger2[1] === 'mint', JSON.stringify(ledger2));

  /* ── 5. rounding cannot leak ─────────────────────────────────────────── */
  check('mint a tiny amount', await type('form input[inputmode="decimal"]', '0.000001') && await clickText('form button[type="button"]', 'Mint'));
  await wait(150);
  await type('form input[inputmode="decimal"]', '0.000001');
  await wait(150);
  const tiny = await ev(`[...document.querySelectorAll('form dl dd')][1]?.textContent.trim() ?? ''`);
  check('one quote atom mints exactly one share atom', tiny === '0.000001', `preview "${tiny}"`);

  /* ── 6. persistence ──────────────────────────────────────────────────── */
  await type('form input[inputmode="decimal"]', '250');
  await wait(100);
  await click('form button[type="submit"]');
  await wait(300);
  await send('Page.navigate', { url: `${BASE}/markets/${SYMBOL}` });
  await wait(3500);
  const persisted = await ev(`(() => {
    const card = [...document.querySelectorAll('article[data-class]')].find(a => a.dataset.class === ${JSON.stringify(parked)});
    return [...card.querySelectorAll('dl dd')].map(d => d.textContent.trim())[2];
  })()`);
  check('position survives a reload', persisted === '250', `held "${persisted}"`);

  /* ── 7. reset ────────────────────────────────────────────────────────── */
  check('reset the vault', await clickText('button', 'Reset this vault'));
  await wait(300);
  const reset = await ev(`(() => {
    const card = [...document.querySelectorAll('article[data-class]')].find(a => a.dataset.class === ${JSON.stringify(parked)});
    return [...card.querySelectorAll('dl dd')].map(d => d.textContent.trim())[2];
  })()`);
  check('reset returns to zero', reset === '0', `held "${reset}"`);

  /* ── 8. the markets table and the nav still agree on the session ────── */
  await send('Page.navigate', { url: `${BASE}/markets` });
  await wait(3000);
  const navHolder = await ev(`document.querySelector('header [data-holder]')?.dataset.holder`);
  const leadHolder = await ev(`document.querySelector('main strong[data-holder]')?.dataset.holder`);
  check('nav badge and markets lead agree on who holds', navHolder && navHolder === leadHolder, `${navHolder} vs ${leadHolder}`);

  const rows = await ev(`document.querySelectorAll('table tbody tr').length`);
  check('markets table lists every asset', rows === 26, `${rows} rows`);
  check('filter to pre-IPO', await clickText('button[aria-pressed]', 'Pre-IPO'));
  await wait(150);
  const rows2 = await ev(`document.querySelectorAll('table tbody tr').length`);
  check('pre-IPO filter shows 5', rows2 === 5, `${rows2} rows`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
} finally {
  chrome.kill();
}
