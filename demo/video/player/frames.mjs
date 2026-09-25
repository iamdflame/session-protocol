/* Deterministic, frame-by-frame: several Chrome tabs each seek the Remotion
   Player through a slice of the scene, screenshot every frame, and pipe the
   JPEGs to ffmpeg; the slices are then joined. Used because this machine is
   too slow for Remotion's renderer (2 s a frame) or for real-time capture.

     node player/frames.mjs P02 [P03 ...] [--tabs 4] [--frames 0-59]
*/
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openChrome } from '../../../web/scripts/lib/headless.mjs';
import { serve } from './serve.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = join(HERE, '../../..');
const durations = JSON.parse(readFileSync(join(HERE, '../src/durations.json'), 'utf8'));
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const TABS = Number(opt('tabs', 4));
const range = opt('frames', null);
let ids = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] ?? '').startsWith('--'));
if (ids[0] === 'pitch') ids = Object.keys(durations).filter((k) => k.startsWith('P'));
if (ids[0] === 'technical') ids = Object.keys(durations).filter((k) => k.startsWith('T'));

async function slice(id, from, to, out, port) {
  const page = await openChrome('', { width: 1920, height: 1080, profile: `frames-${id}-${from}` });
  const ff = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', '30', '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '15', '-pix_fmt', 'yuv420p', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  try {
    await page.navigate(`http://localhost:${port}/?c=${id}`);
    await page.until(() => page.ev(`!!window.__player && window.__ready === true`), 30000);
    for (let f = from; f <= to; f++) {
      await page.ev(`(async () => { window.__player.seekTo(${f}); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const vids = [...document.querySelectorAll('video')]; await Promise.all(vids.map(v => v.seeking ? new Promise(r => v.addEventListener('seeked', r, { once: true })) : null)); })()`);
      const shot = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
      if (!ff.stdin.write(Buffer.from(shot.data, 'base64'))) await new Promise((r) => ff.stdin.once('drain', r));
    }
  } finally {
    ff.stdin.end();
    await new Promise((r) => ff.on('close', r));
    page.close();
  }
}

const server = await serve(4602);
try {
  for (const id of ids) {
    const total = durations[id].seconds * 30;
    const [a, b] = range ? range.split('-').map(Number) : [0, total - 1];
    const n = b - a + 1, per = Math.ceil(n / TABS);
    const tmp = join(ROOT, 'demo/out/.slices', id);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const t0 = Date.now();
    const parts = [];
    for (let i = 0; i < TABS; i++) { const f0 = a + i * per, f1 = Math.min(b, f0 + per - 1); if (f0 <= f1) parts.push({ f0, f1, out: join(tmp, `${String(i).padStart(2, '0')}.mp4`) }); }
    await Promise.all(parts.map((p) => slice(id, p.f0, p.f1, p.out, 4602)));
    const list = join(tmp, 'list.txt');
    writeFileSync(list, parts.map((p) => `file '${p.out}'`).join('\n') + '\n');
    const video = id.startsWith('P') ? 'pitch' : 'technical';
    mkdirSync(join(ROOT, 'demo/out', video), { recursive: true });
    const dest = join(ROOT, 'demo/out', video, `${id}-${slug(durations[id].title)}${range ? '-test' : ''}.mp4`);
    spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', dest], { stdio: 'inherit' });
    rmSync(tmp, { recursive: true, force: true });
    const secs = (Date.now() - t0) / 1000;
    console.log(`${id}: ${n} frames in ${secs.toFixed(0)}s (${(n / secs).toFixed(1)} fps) → ${dest}`);
  }
} finally { server.close(); }
process.exit(0);
