/* Measure what the page actually costs while it sits there ticking.

   The session clock re-renders every second, so "does it idle quietly" is a
   real question and not a theoretical one. This records long tasks and frame
   gaps over a fixed window on a live page.

   usage: node scripts/perf.mjs [path] [seconds]  */

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { WebSocket } from 'ws';

const PATHNAME = process.argv[2] ?? '/';
const SECONDS = Number(process.argv[3] ?? 6);
const CHROME = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find(existsSync);
/* Chrome writes its profile here and never cleans it up; named so the
   teardown can remove the same directory it was given. */
const PROFILE = '/tmp/session-perf-' + process.pid;
const PORT = 9800 + (process.pid % 300);

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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  // A mid-range phone, roughly — the interesting case is not this machine.
  await send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.THROTTLE ?? 4) });
  if (process.env.REDUCED) {
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
  }

  await send('Page.navigate', { url: `http://localhost:3200${PATHNAME}` });

  /* Wait for the page to go quiet before starting the window.
     A fixed delay measures whatever happens to be left of the load at that
     throttle, which is why this harness swung between 22% and 85% on the same
     build. The question here is what the page costs *at rest*; loading cost is
     a different question and deserves its own measurement. */
  const t0 = Date.now();
  let quiet = false;
  while (Date.now() - t0 < 30000 && !quiet) {
    try {
      quiet = await ev(`(async () => {
        if (document.readyState !== 'complete') return false;
        let busy = 0;
        const po = new PerformanceObserver(l => { busy += l.getEntries().length; });
        try { po.observe({ entryTypes: ['longtask'] }); } catch (e) { return true; }
        await new Promise(r => setTimeout(r, 1500));
        po.disconnect();
        return busy === 0;
      })()`);
    } catch { /* mid-navigation */ }
    if (!quiet) await new Promise(r => setTimeout(r, 200));
  }
  const settleMs = Date.now() - t0;

  const out = await ev(`(async () => {
    const long = [];
    const t0 = performance.now();
    const po = new PerformanceObserver(l => {
      for (const e of l.getEntries()) long.push([Math.round(e.startTime - t0), Math.round(e.duration)]);
    });
    try { po.observe({ entryTypes: ['longtask'] }); } catch (e) {}

    const frames = [];
    let last = performance.now();
    let stop = false;
    const loop = () => {
      const t = performance.now();
      frames.push(t - last);
      last = t;
      if (!stop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);

    await new Promise(r => setTimeout(r, ${SECONDS * 1000}));
    stop = true;
    po.disconnect();

    frames.sort((a, b) => a - b);
    const q = p => Math.round(frames[Math.floor(frames.length * p)] * 10) / 10;
    return {
      frames: frames.length,
      p50: q(0.5), p95: q(0.95), worst: Math.round(frames.at(-1)),
      longTasks: long.length,
      longWorst: long.length ? Math.max(...long.map(l => l[1])) : 0,
      longTotal: long.reduce((s, v) => s + v[1], 0),
      timeline: long.slice(0, 10),
    };
  })()`);

  console.log(`${PATHNAME}  ${SECONDS}s at rest, ${process.env.THROTTLE ?? 4}× CPU throttle` +
    `${process.env.REDUCED ? ', reduced motion' : ''}` +
    `  (settled after ${(settleMs / 1000).toFixed(1)}s)`);
  console.log(`  frames       ${out.frames}  (p50 ${out.p50}ms · p95 ${out.p95}ms · worst ${out.worst}ms)`);
  console.log(`  long tasks   ${out.longTasks}  (worst ${out.longWorst}ms · total ${out.longTotal}ms)`);
  const budget = out.longTotal / (SECONDS * 1000);
  console.log(`  main thread  ${(budget * 100).toFixed(1)}% blocked`);
  if (out.timeline.length) {
    console.log(`  when         ${out.timeline.map(([t, d]) => `${t}ms:${d}`).join('  ')}`);
  }
} finally {
  /* Wait for it to actually go. `kill()` only sends the signal, and Chrome
     flushes its profile on the way out — removing the directory first just
     lets it write the files back, which is how ~90MB a run accumulated until
     the disk was full. */
  chrome.kill();
  await new Promise(r => { chrome.once('exit', r); setTimeout(r, 4000); });
  rmSync(PROFILE, { recursive: true, force: true });
}
