/* ───────────────────────────────────────────────────────────────────────────
   The capture rig for the demo videos.

   Headless Chrome, driven over the DevTools protocol, the same way the site's
   own flow harnesses drive it (web/scripts/lib/headless.mjs). This adds what a
   viewer needs and a test does not:

   - A visible cursor that moves on eased curves and ripples when it clicks.
     The events underneath are real input events, so hover states are real.
   - Typing at a human pace, and smooth scrolling.
   - Recording. Chrome's screencast sends a frame only when the page repaints.
     Each frame is written once, with its timestamp, and nothing is encoded
     while the page runs, because this machine cannot encode 1080p in real
     time and also render. At stop, ffmpeg holds each frame for as long as it
     was on screen and writes constant 30 fps H.264, then the frames are
     deleted.
   - Stills at twice the resolution, for camera moves in the edit.

   Nothing here prints key material. The demo wallet's key stays in this
   process and in keeper/.devnet (gitignored).
   ─────────────────────────────────────────────────────────────────────────── */

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openChrome } from '../../web/scripts/lib/headless.mjs';

export const ROOT = new URL('../..', import.meta.url).pathname;
export const OUT = join(ROOT, 'demo/captures');
export const FPS = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The cursor, drawn by the page itself so it is in every frame. */
const CURSOR = `
(() => {
  const install = () => {
    if (document.getElementById('__demo_cursor')) return;
    const c = document.createElement('div');
    c.id = '__demo_cursor';
    c.innerHTML = '<svg width="26" height="30" viewBox="0 0 26 30" xmlns="http://www.w3.org/2000/svg"><path d="M3 2 L3 24 L9 18.5 L13 27.5 L17 25.8 L13 17 L21 17 Z" fill="#fff" stroke="#0b0d10" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: 2147483647, pointerEvents: 'none', transform: 'translate(-100px,-100px)', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.45))', willChange: 'transform' });
    document.documentElement.appendChild(c);
    const ripple = (x, y) => {
      const r = document.createElement('div');
      Object.assign(r.style, { position: 'fixed', left: (x - 18) + 'px', top: (y - 18) + 'px', width: '36px', height: '36px', borderRadius: '50%', border: '2px solid rgba(78,163,255,.9)', zIndex: 2147483646, pointerEvents: 'none', transform: 'scale(.35)', opacity: '1', transition: 'transform .45s ease-out, opacity .45s ease-out' });
      document.documentElement.appendChild(r);
      requestAnimationFrame(() => { r.style.transform = 'scale(1.35)'; r.style.opacity = '0'; });
      setTimeout(() => r.remove(), 500);
    };
    addEventListener('mousemove', (e) => { c.style.transform = 'translate(' + (e.clientX - 3) + 'px,' + (e.clientY - 2) + 'px)'; }, true);
    addEventListener('mousedown', (e) => ripple(e.clientX, e.clientY), true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', install); else install();
})();
`;

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export async function launch({ inject = '', width = 1920, height = 1080, dsf = 1 } = {}) {
  const page = await openChrome(inject + CURSOR, { width, height, dsf, profile: 'demo' });
  const { send, ev, until } = page;
  let pos = { x: width * 0.62, y: height * 0.7 };

  const mouse = {
    /** Move along an eased, slightly curved path, as a hand would. */
    async moveTo(x, y, ms = 700) {
      const from = { ...pos };
      const bend = { x: (from.x + x) / 2 + (y - from.y) * 0.08, y: (from.y + y) / 2 - (x - from.x) * 0.08 };
      const steps = Math.max(8, Math.round(ms / 16));
      for (let i = 1; i <= steps; i++) {
        const t = ease(i / steps);
        const px = (1 - t) ** 2 * from.x + 2 * (1 - t) * t * bend.x + t * t * x;
        const py = (1 - t) ** 2 * from.y + 2 * (1 - t) * t * bend.y + t * t * y;
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
        await sleep(ms / steps);
      }
      pos = { x, y };
    },
    async click() {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      await sleep(90);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    },
    /** Park the cursor somewhere visible before a recording starts. */
    async park(x = width * 0.62, y = height * 0.72) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      pos = { x, y };
    },
  };

  /** Center of the first element matching `sel` (and `text`, if given), smoothly scrolled into view. */
  async function locate(sel, text) {
    const find = `(() => {
      const all = [...document.querySelectorAll(${JSON.stringify(sel)})];
      const el = ${text ? `all.find(e => e.textContent.trim().startsWith(${JSON.stringify(text)}))` : 'all[0]'};
      if (!el) return null;
      const q = el.getBoundingClientRect();
      return { x: q.left + q.width / 2, y: q.top + q.height / 2, w: q.width, h: q.height, top: q.top, bottom: q.bottom, vh: innerHeight, sy: scrollY };
    })()`;
    let p = await ev(find);
    if (p && (p.top < 80 || p.bottom > p.vh - 40)) {
      await scrollTo(Math.max(0, p.sy + p.top - p.vh / 2 + p.h / 2), 1100);
      await sleep(250);
      p = await ev(find);
    }
    return p;
  }

  async function clickOn(sel, { text, ms = 750, settle = 250 } = {}) {
    const p = await locate(sel, text);
    if (!p) throw new Error(`nothing to click: ${sel}${text ? ` "${text}"` : ''}`);
    await mouse.moveTo(p.x, p.y, ms);
    await sleep(settle);
    await mouse.click();
    return p;
  }

  /** Type into the focused field at a human pace. */
  async function typeText(text, { cps = 9 } = {}) {
    for (const ch of text) {
      await send('Input.insertText', { text: ch });
      await sleep(1000 / cps * (0.7 + Math.random() * 0.6));
    }
  }

  /** Scroll the page to `y` over `ms`, eased, from inside the page. */
  async function scrollTo(y, ms = 1200) {
    await ev(`new Promise((res) => {
      const from = scrollY, to = ${y}, t0 = performance.now();
      const e = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
      const step = (now) => { const t = Math.min(1, (now - t0) / ${ms}); scrollTo(0, from + (to - from) * e(t)); t < 1 ? requestAnimationFrame(step) : res(); };
      requestAnimationFrame(step);
    })`);
  }

  /** Start recording; `stop()` writes demo/captures/<name>.mp4 and returns its path and length. */
  async function record(name) {
    const dir = join(OUT, `.frames-${name}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const frames = [];
    const t0 = Date.now() / 1000;
    page.onEvent('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      if (!frames.stopped) {
        const file = join(dir, `${String(frames.length).padStart(6, '0')}.jpg`);
        writeFileSync(file, Buffer.from(data, 'base64'));
        frames.push({ file, t: metadata.timestamp ?? Date.now() / 1000 });
      }
    });
    await send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
    // a repaint so the first frame exists even on a still page
    await ev(`document.documentElement.style.outline = '0px solid transparent'`);
    return {
      async stop() {
        const tEnd = Date.now() / 1000;
        frames.stopped = true;
        await send('Page.stopScreencast');
        if (!frames.length) throw new Error(`${name}: no frames`);
        // hold each frame until the next one, then the last until the end
        const lines = ['ffconcat version 1.0'];
        frames.forEach((f, i) => {
          const next = i + 1 < frames.length ? frames[i + 1].t : tEnd;
          lines.push(`file '${f.file}'`, `duration ${Math.max(1 / FPS, next - f.t).toFixed(4)}`);
        });
        lines.push(`file '${frames[frames.length - 1].file}'`);
        const list = join(dir, 'list.ffconcat');
        writeFileSync(list, lines.join('\n') + '\n');
        const out = join(OUT, `${name}.mp4`);
        const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
          '-vf', `fps=${FPS},scale=1920:1080:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '16',
          '-movflags', '+faststart', out], { stdio: 'inherit' });
        rmSync(dir, { recursive: true, force: true });
        if (r.status !== 0) throw new Error(`${name}: ffmpeg failed`);
        return { out, seconds: tEnd - t0, frames: frames.length };
      },
    };
  }

  /** A still at twice the resolution, for camera moves: the viewport, or the whole page. */
  async function still(name, { fullPage = false, scale = 2 } = {}) {
    mkdirSync(join(OUT, 'stills'), { recursive: true });
    const metrics = await ev(`({ w: innerWidth, h: innerHeight, H: document.documentElement.scrollHeight })`);
    await send('Emulation.setDeviceMetricsOverride', { width: metrics.w, height: metrics.h, deviceScaleFactor: scale, mobile: false });
    await sleep(700);
    const shot = await send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: fullPage,
      ...(fullPage && { clip: { x: 0, y: 0, width: metrics.w, height: metrics.H, scale: 1 } }),
    });
    await send('Emulation.setDeviceMetricsOverride', { width: metrics.w, height: metrics.h, deviceScaleFactor: dsf, mobile: false });
    const file = join(OUT, 'stills', `${name}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return file;
  }

  return { ...page, mouse, locate, clickOn, typeText, scrollTo, record, still, sleep };
}
