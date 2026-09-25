/* ───────────────────────────────────────────────────────────────────────────
   Accessibility checks, run against the live pages.

   Not a linter over the source — the questions that matter here are about the
   rendered result: does every control have a name a screen reader can say, is
   every figure's text readable against the surface it actually landed on, can
   a keyboard reach everything, and does the heading outline make sense.

   Contrast is computed from resolved colours, which is the only way to check a
   page whose palette changes with the market session.

   usage: node scripts/a11y.mjs [--ground day]
   ─────────────────────────────────────────────────────────────────────────── */

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { WebSocket } from 'ws';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const BASE = arg('base', 'http://localhost:3100');
const GROUND = arg('ground', null);

const PAGES = ['/', '/trade', '/portfolio', '/markets', '/markets/SPYx', '/markets/NVDAx', '/markets/OPENAI', '/research',
  '/how-it-works', '/bell', '/oracle', '/bells', '/list', '/nope'];
const CHROME = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find(existsSync);
/* Chrome writes ~90MB of profile per run and never cleans it up; a few
   days of harness runs filled this machine's disk. Named here so the
   teardown removes the same directory the browser was given. */
const PROFILE = '/tmp/session-a11y-' + process.pid;
const PORT = 9400 + (process.pid % 300);

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

/* The audit, as a string evaluated in the page. */
const AUDIT = `(() => {
  const problems = [];
  const add = (kind, detail, el) => problems.push({
    kind, detail,
    where: el ? (el.tagName.toLowerCase()
      + (el.id ? '#' + el.id : '')
      + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : ''))
      : '',
    text: el ? (el.textContent || '').trim().slice(0, 48) : '',
  });

  /* ── names on controls ─────────────────────────────────────────────── */
  const named = el => {
    if (el.getAttribute('aria-label')?.trim()) return true;
    const by = el.getAttribute('aria-labelledby');
    if (by && by.split(/\\s+/).some(id => document.getElementById(id)?.textContent?.trim())) return true;
    if (el.title?.trim()) return true;
    if ((el.textContent || '').trim()) return true;
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      if (el.labels && el.labels.length && [...el.labels].some(l => l.textContent.trim())) return true;
      if (el.placeholder?.trim()) return false;   // a placeholder is not a label
    }
    return false;
  };

  for (const el of document.querySelectorAll('a[href], button, input, select, textarea, [role="button"]')) {
    if (el.closest('[aria-hidden="true"]')) continue;
    if (el.type === 'hidden') continue;
    if (!named(el)) add('unnamed-control', el.tagName.toLowerCase(), el);
  }

  /* ── images ────────────────────────────────────────────────────────── */
  for (const el of document.querySelectorAll('img')) {
    if (!el.hasAttribute('alt')) add('img-no-alt', el.currentSrc || el.src, el);
  }
  for (const el of document.querySelectorAll('svg[role="img"]')) {
    if (!el.getAttribute('aria-label') && !el.querySelector('title')) {
      add('svg-img-no-label', '', el);
    }
  }

  /* ── heading outline ───────────────────────────────────────────────── */
  const heads = [...document.querySelectorAll('main h1, main h2, main h3, main h4')]
    .filter(h => {
      const st = getComputedStyle(h);
      return st.display !== 'none' && st.visibility !== 'hidden' && h.getClientRects().length > 0;
    });
  const h1s = heads.filter(h => h.tagName === 'H1');
  if (h1s.length === 0) add('no-h1', 'main has no level-1 heading');
  if (h1s.length > 1) add('multiple-h1', h1s.length + ' level-1 headings');
  let prev = 0;
  for (const h of heads) {
    const lvl = Number(h.tagName[1]);
    if (prev && lvl > prev + 1) add('heading-skip', 'h' + prev + ' -> h' + lvl, h);
    prev = lvl;
  }

  /* ── contrast ──────────────────────────────────────────────────────── */
  /* Chrome reports some backgrounds as rgb()/rgba() and others as
     color(srgb 0.98 0.97 0.96 / 0.82) — 0..1 floats. Reading the first three
     numbers of the second form gives near-black, which silently turned every
     light surface into a dark one and produced a page full of phantom
     failures. Both forms are handled, with alpha. */
  const parse = c => {
    if (!c) return null;
    const srgb = c.match(/^color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*\\/\\s*([\\d.]+))?/);
    if (srgb) {
      return {
        rgb: [1, 2, 3].map(i => Math.round(Number(srgb[i]) * 255)),
        a: srgb[4] === undefined ? 1 : Number(srgb[4]),
      };
    }
    const m = c.match(/[\\d.]+/g);
    if (!m) return null;
    return { rgb: m.slice(0, 3).map(Number), a: m.length > 3 ? Number(m[3]) : 1 };
  };
  const lum = ([r, g, b]) => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  /* Composite every translucent layer down to the first opaque one, rather
     than picking whichever layer happens to clear an alpha threshold. */
  const behind = el => {
    const layers = [];
    // Start at the element itself: a button paints its own background, and
    // skipping it measured light-on-dark button text against the page ground.
    let n = el;
    while (n) {
      const p = parse(getComputedStyle(n).backgroundColor);
      if (p && p.a > 0) {
        layers.push(p);
        if (p.a >= 0.999) break;
      }
      n = n.parentElement;
    }
    const base = parse(getComputedStyle(document.body).backgroundColor);
    if (base && base.a >= 0.999) layers.push(base);
    if (!layers.length) return [255, 255, 255];

    let out = layers[layers.length - 1].rgb;
    for (let i = layers.length - 2; i >= 0; i--) {
      const { rgb, a } = layers[i];
      out = out.map((v, k) => Math.round(rgb[k] * a + v * (1 - a)));
    }
    return out;
  };

  const seen = new Set();
  for (const el of document.querySelectorAll('main *, header *, footer *')) {
    if (el.children.length) continue;                       // leaf text only
    const text = (el.textContent || '').trim();
    if (!text || el.closest('[aria-hidden="true"]') || el.classList.contains('sr-only')) continue;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.6) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;

    const fgp = parse(st.color);
    if (!fgp) continue;
    const bg = behind(el);
    // Text with its own alpha sits on the surface behind it.
    const fg = fgp.a >= 0.999
      ? fgp.rgb
      : fgp.rgb.map((v, k) => Math.round(v * fgp.a + bg[k] * (1 - fgp.a)));
    const cr = ratio(fg, bg);
    const size = parseFloat(st.fontSize);
    const bold = Number(st.fontWeight) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;

    if (cr < need) {
      const key = st.color + '|' + text.slice(0, 20);
      if (seen.has(key)) continue;
      seen.add(key);
      add('contrast', cr.toFixed(2) + ':1 (needs ' + need + ') ' + st.color + ' at ' + size + 'px', el);
    }
  }

  /* ── keyboard reachability ─────────────────────────────────────────── */
  const focusables = [...document.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]'
  )].filter(el => {
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && !el.closest('[hidden]');
  });
  for (const el of focusables) {
    const ti = el.getAttribute('tabindex');
    if (ti && Number(ti) > 0) add('positive-tabindex', 'tabindex=' + ti, el);
  }

  return { problems, counts: { focusables: focusables.length, headings: heads.length } };
})()`;

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
  /* Audit a page in a given session by *being* in that session.

     The interface no longer accepts a pinned ground — the active identity is
     whatever the calendar says — so the day pass moves the page's clock to a
     real instant inside the regular session (Wed 23 Sep 2026, 14:00 ET, checked
     against sdk/src/calendar.ts) and the night pass to one outside it. Both
     the pre-paint script and React then reach "day" or "night" the way they
     would for a real visitor, which is the thing worth auditing. The clock
     keeps running from there so countdowns still tick. */
  const AT = { day: 1790186400, night: 1790215200 };
  if (GROUND) {
    if (!(GROUND in AT)) throw new Error(`--ground must be day or night, not ${GROUND}`);
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const RealDate = Date, start = RealDate.now(), at = ${AT[GROUND]} * 1000;
        const now = () => at + (RealDate.now() - start);
        class ShiftedDate extends RealDate {
          constructor(...a) { a.length ? super(...a) : super(now()); }
          static now() { return now(); }
        }
        globalThis.Date = ShiftedDate;
      })();`,
    });
  }

  let total = 0;
  // --page /research: one route, for checking a page while it is being built.
  const ONLY = arg('page', null);
  for (const path of ONLY ? PAGES.filter(p => p === ONLY) : PAGES) {
    await send('Page.navigate', { url: BASE + path });

    // Wait for the ground to settle before measuring anything.
    //
    // The provider mounts with the live session, then restores a pin, so a
    // pinned page genuinely flips once — and `body` and the sticky header both
    // transition their background. Sampling during that transition reads a
    // half-composited surface and reports contrast failures that do not exist
    // at rest, which is how this audit produced a different answer every run.
    const want = JSON.stringify(GROUND ?? null);
    const t0 = Date.now();
    let ready = false;
    while (Date.now() - t0 < 90000) {
      let ok = false;
      try {
        // Evaluating while the document is being swapped throws; that just
        // means "not ready yet".
        /* Every route is lazy, and Suspense fills main with a skeleton while
           the chunk loads. That skeleton satisfied the old "main has any
           child" test, so the audit sometimes measured the *fallback* — which
           has no h1, by design — and reported "main has no level-1 heading"
           against pages that have one. Three runs, one failure, a different
           page each time. Waiting for the fallback to leave is the fix; the
           fallback announces itself as a loading status, so there is a real
           thing to wait on rather than a sleep. */
        ok = await ev(`(() => {
          const g = document.documentElement.dataset.session;
          if (${want} && g !== ${want}) return false;
          if (document.readyState !== 'complete') return false;
          if (document.querySelector('main [role="status"][aria-label="Loading"]')) return false;
          /* A page that reads the chain shows its own skeleton, marked
             aria-busy, until the read lands. Auditing that measures the
             placeholder, not the page — the /trade pass once reported one
             heading and a clean bill for exactly that reason. */
          if (document.querySelector('main [aria-busy="true"]:not(button)')) return false;
          return !!document.querySelector('main *');
        })()`);
      } catch { /* mid-navigation */ }
      if (ok) { ready = true; break; }
      await new Promise(r => setTimeout(r, 150));
    }
    /* A wait that ran out used to fall through and audit whatever was on
       screen, which on a cold edge is the loading skeleton — so the audit
       reported a missing h1 and a clean run was a matter of luck. A page that
       never finished loading has not been audited, and saying so is the only
       honest thing the harness can do with it. */
    if (!ready) {
      console.log(`  FAIL  ${path.padEnd(22)} never finished loading in 25s — not audited`);
      total += 1;
      continue;
    }
    // Past the longest ground transition (--t-route, 500ms) with room to spare.
    await new Promise(r => setTimeout(r, 1400));
    // Open every disclosure so collapsed content is audited too.
    // Open every *visible* disclosure so collapsed content is audited too.
    // Clicking a display:none control (the burger, at desktop width) toggles
    // state nobody can see and puts the page in a layout the reader never has.
    await ev(`document.querySelectorAll('[aria-expanded="false"]').forEach(b => {
      const st = getComputedStyle(b);
      if (st.display !== 'none' && st.visibility !== 'hidden') b.click();
    }); true`);
    await new Promise(r => setTimeout(r, 400));

    const { problems, counts } = await ev(AUDIT);
    const label = `${path}${GROUND ? ` [${GROUND}]` : ''}`;
    if (!problems.length) {
      console.log(`  ok    ${label.padEnd(22)} ${counts.focusables} focusable, ${counts.headings} headings`);
    } else {
      console.log(`  FAIL  ${label.padEnd(22)} ${problems.length} problem(s)`);
      const byKind = {};
      for (const p of problems) (byKind[p.kind] ??= []).push(p);
      for (const [kind, list] of Object.entries(byKind)) {
        console.log(`        ${kind} (${list.length})`);
        for (const p of list.slice(0, 6)) {
          console.log(`          ${p.where} ${p.detail}${p.text ? ` — “${p.text}”` : ''}`);
        }
        if (list.length > 6) console.log(`          …and ${list.length - 6} more`);
      }
      total += problems.length;
    }
  }

  console.log(total ? `\n${total} accessibility problem(s)` : '\nno accessibility problems');
  process.exitCode = total ? 1 : 0;
} finally {
  /* Wait for it to actually go. `kill()` only sends the signal, and Chrome
     flushes its profile on the way out — removing the directory first just
     lets it write the files back, which is how ~90MB a run accumulated until
     the disk was full. */
  chrome.kill();
  await new Promise(r => { chrome.once('exit', r); setTimeout(r, 4000); });
  rmSync(PROFILE, { recursive: true, force: true });
}
