// Headless capture over the DevTools protocol.
//
// `--virtual-time-budget` expires against real network time, so an external
// module graph plus a webfont can outrun it and the page gets dumped before
// anything executed. Driving the browser directly removes the guesswork: we
// wait for the page to actually signal it is ready, and we get the console.
//
//   node scripts/shot.mjs <url> <out.png> [--h=N] [--click=SELECTOR] [--wait=MS]
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const url = process.argv[2] || 'http://localhost:8080/';
const out = process.argv[3] || 'shot.png';
const arg = (k, d) => {
  const a = process.argv.find(x => x.startsWith(`--${k}=`));
  return a ? a.split('=').slice(1).join('=') : d;
};
const H = +arg('h', 1900), W = +arg('w', 1320);
const extraWait = +arg('wait', 1200);
const clickSel = arg('click', '');
const theme = arg('theme', '');

const PORT = 9222 + Math.floor(Math.random() * 400);
const chrome = spawn('google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--force-color-profile=srgb', '--disable-lcd-text',
  `--remote-debugging-port=${PORT}`, `--window-size=${W},${H}`,
  '--user-data-dir=/tmp/prism-chrome-profile', 'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('devtools never came up');
}

const ws = new WebSocket(await target());
await new Promise(r => ws.addEventListener('open', r, { once: true }));

let id = 0;
const pending = new Map();
const logs = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled')
    logs.push(`[${m.params.type}] ` + m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    logs.push('[EXCEPTION] ' + (d.exception?.description || d.text));
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error')
    logs.push('[log] ' + m.params.entry.text);
});
const send = (method, params = {}) => new Promise(res => {
  const i = ++id; pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride',
  { width: W, height: H, deviceScaleFactor: 2, mobile: false });

await send('Page.navigate', { url });

// wait for the app to say it is ready, not for a timer
let ready = false;
for (let i = 0; i < 80; i++) {
  await sleep(250);
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const c = document.getElementById('chips');
      const b = document.getElementById('bignum');
      return !!(c && c.children.length && b && b.textContent !== '—');
    })()`,
    returnByValue: true,
  });
  if (r.result?.result?.value) { ready = true; break; }
}

if (theme) {
  await send('Runtime.evaluate',
    { expression: `document.documentElement.setAttribute('data-theme','${theme}')` });
  await sleep(300);
}
for (const sel of clickSel.split('|').filter(Boolean)) {
  const r = await send('Runtime.evaluate', {
    expression: `(() => { const n = document.querySelector(${JSON.stringify('')} || ${JSON.stringify(sel)});
                          if (n) n.dispatchEvent(new MouseEvent('click', {bubbles:true})); return !!n; })()`,
    returnByValue: true,
  });
  if (!r.result?.result?.value) console.log(`  (no element for ${sel})`);
  await sleep(+arg('gap', 1600));
}
await sleep(extraWait);

const metrics = await send('Page.getLayoutMetrics');
const full = Math.min(Math.ceil(metrics.result?.cssContentSize?.height || H), 8000);
await send('Emulation.setDeviceMetricsOverride',
  { width: W, height: full, deviceScaleFactor: 2, mobile: false });
await sleep(400);

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));

console.log(`ready=${ready}  wrote ${out}  (${W}x${full})`);
if (logs.length) { console.log('--- console ---'); console.log(logs.slice(0, 40).join('\n')); }
else console.log('--- console clean ---');

ws.close(); chrome.kill('SIGKILL');
process.exit(0);
