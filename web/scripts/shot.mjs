/* ───────────────────────────────────────────────────────────────────────────
   Screenshot harness.

   Drives headless Chrome over the DevTools protocol directly — no automation
   library. The point is control over *when* a shot is taken: these pages fetch
   data, measure themselves with ResizeObserver and animate on scroll, so a
   fixed delay either wastes seconds or captures a half-drawn chart. This waits
   for the network to settle, scrolls the whole page to fire every reveal, then
   returns to the top and waits two frames.

   Usage:
     node scripts/shot.mjs                       every page, every width
     node scripts/shot.mjs --page / --w 1440
     node scripts/shot.mjs --ground day          force the day ground
     node scripts/shot.mjs --full                full-page instead of viewport
   ─────────────────────────────────────────────────────────────────────────── */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { WebSocket } from 'ws';

const CHROME = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find(existsSync);
if (!CHROME) { console.error('no chrome found'); process.exit(1); }

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = k => argv.includes(`--${k}`);

const BASE = arg('base', 'http://localhost:3100');
const OUT = arg('out', 'shots');
const FULL = flag('full');
const GROUND = arg('ground', null);          // 'day' | 'night' | null = live
const ONLY_PAGE = arg('page', null);
const ONLY_W = arg('w', null);

const PAGES = [
  ['/', 'landing'],
  ['/markets', 'markets'],
  ['/markets/SPYx', 'vault'],
  ['/markets/NVDAx', 'vault-chain'],
  ['/research', 'research'],
  ['/how-it-works', 'how'],
  ['/no-such-page', '404'],
];

const WIDTHS = [
  [1440, 900, 1],
  [1024, 768, 1],
  [768, 1024, 2],
  [390, 844, 3],
];

/* ── minimal CDP client ──────────────────────────────────────────────────── */

const waitPort = (port, ms = 15000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const probe = () => {
    const sock = createConnection({ port, host: '127.0.0.1' }, () => { sock.end(); res(); });
    sock.on('error', () => {
      sock.destroy();
      if (Date.now() - t0 > ms) rej(new Error(`port ${port} never opened`));
      else setTimeout(probe, 120);
    });
  };
  probe();
});

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }

  static async attach(port) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
    const page = list.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
    await new Promise(r => ws.once('open', r));
    const cdp = new CDP(ws);
    ws.on('message', buf => {
      const msg = JSON.parse(buf.toString());
      if (msg.id && cdp.pending.has(msg.id)) {
        const { res, rej } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) {
        (cdp.handlers.get(msg.method) ?? []).forEach(h => h(msg.params));
      }
    });
    return cdp;
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' — ' + expr.slice(0, 80));
    return r.result.value;
  }
}

/* ── run ─────────────────────────────────────────────────────────────────── */

const PORT = 9222 + (process.pid % 400);
mkdirSync(OUT, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--no-sandbox',
  '--disable-gpu',
  '--hide-scrollbars',
  '--force-color-profile=srgb',
  '--font-render-hinting=none',
  '--user-data-dir=/tmp/session-shot-' + process.pid,
  'about:blank',
], { stdio: 'ignore' });

const errors = [];

try {
  await waitPort(PORT);
  const cdp = await CDP.attach(PORT);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Log.enable');

  cdp.on('Log.entryAdded', ({ entry }) => {
    if (entry.level === 'error') errors.push(`${entry.url ?? ''} ${entry.text}`);
  });
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text);
  });

  // A stable clock makes shots diffable: without it every capture lands on a
  // different countdown and every comparison is noise.
  if (GROUND) {
    await cdp.send('Emulation.setScriptExecutionDisabled', { value: false });
  }

  let inflight = 0, lastActivity = Date.now();
  cdp.on('Network.requestWillBeSent', () => { inflight++; lastActivity = Date.now(); });
  cdp.on('Network.loadingFinished', () => { inflight--; lastActivity = Date.now(); });
  cdp.on('Network.loadingFailed', () => { inflight--; lastActivity = Date.now(); });

  const settle = async (ms = 700, cap = 9000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < cap) {
      if (inflight <= 0 && Date.now() - lastActivity > ms) return;
      await new Promise(r => setTimeout(r, 80));
    }
  };

  const pages = ONLY_PAGE ? PAGES.filter(([p]) => p === ONLY_PAGE) : PAGES;
  const widths = ONLY_W ? WIDTHS.filter(([w]) => String(w) === ONLY_W) : WIDTHS;

  for (const [path, name] of pages) {
    for (const [w, h, scale] of widths) {
      // `mobile: false` even at phone width. The layout is width-driven, and
      // Chrome's full-page capture under mobile emulation pins sticky elements
      // to the last visual-viewport position — the header lands mid-page in
      // the image while being at the top in the browser.
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: w, height: h, deviceScaleFactor: 1, mobile: false,
      });

      if (GROUND) {
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
          source: `try{localStorage.setItem('session.ground',${JSON.stringify(GROUND)})}catch(e){}`,
        });
      }

      inflight = 0;
      await cdp.send('Page.navigate', { url: BASE + path });
      await new Promise(r => {
        const off = () => r();
        cdp.on('Page.loadEventFired', off);
        setTimeout(r, 12000);
      });
      await settle();

      // Fire every scroll reveal, then come back.
      //
      // The page grows while this runs — charts measure themselves and expand,
      // images settle — so a single pass against the height measured up front
      // stops short and leaves the last sections un-revealed. Keep going until
      // the bottom stops moving.
      await cdp.eval(`(async () => {
        const step = () => window.innerHeight * 0.75;
        let y = 0, guard = 0;
        while (guard++ < 60) {
          const H = document.documentElement.scrollHeight;
          if (y >= H) break;
          window.scrollTo(0, y);
          await new Promise(r => setTimeout(r, 100));
          y += step();
        }
        // one settle pass at the true bottom, then home
        window.scrollTo(0, document.documentElement.scrollHeight);
        await new Promise(r => setTimeout(r, 260));
        window.scrollTo(0, 0);
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        await new Promise(r => setTimeout(r, 800));
        // Nothing should ever be invisible at rest. Reveal only adds an
        // entrance animation on top of visible content, so anything at
        // opacity 0 here is a real bug, not a missed observer callback.
        const invisible = [...document.querySelectorAll('main *')]
          .filter(e => {
            const st = getComputedStyle(e);
            return st.opacity === '0' && e.getBoundingClientRect().height > 40;
          }).length;
        if (invisible) throw new Error(invisible + ' visible-height elements are at opacity 0');
      })()`);
      await settle(300, 3000);

      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: FULL,
        ...(FULL ? { clip: {
          x: 0, y: 0,
          width: w,
          height: await cdp.eval('document.documentElement.scrollHeight'),
          scale: 1,
        } } : {}),
      });

      const file = `${OUT}/${name}-${w}${GROUND ? `-${GROUND}` : ''}${FULL ? '-full' : ''}.png`;
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
      const kb = (Buffer.from(shot.data, 'base64').length / 1024).toFixed(0);
      console.log(`${file.padEnd(38)} ${kb}kb`);
      void scale;
    }
  }

  if (errors.length) {
    console.log(`\n${errors.length} console error(s):`);
    for (const e of [...new Set(errors)].slice(0, 12)) console.log('  ' + e.slice(0, 220));
    process.exitCode = 1;
  } else {
    console.log('\nno console errors');
  }
} finally {
  chrome.kill();
}
