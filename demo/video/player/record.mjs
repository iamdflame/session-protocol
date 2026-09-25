/* Record scenes in real time: the Remotion Player plays each one at 1920×1080
   in Chrome and the capture rig records the screencast, because this machine
   takes over a second per screenshot and cannot render frame by frame in time.

     node player/record.mjs P01 P02 ... | pitch | technical
*/
import { mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from '../../capture/rig.mjs';
import { serve } from './serve.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = join(HERE, '../../..');
const durations = JSON.parse(readFileSync(join(HERE, '../src/durations.json'), 'utf8'));
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
let ids = process.argv.slice(2);
if (ids[0] === 'pitch') ids = Object.keys(durations).filter((k) => k.startsWith('P'));
if (ids[0] === 'technical') ids = Object.keys(durations).filter((k) => k.startsWith('T'));

const server = await serve(4600);
try {
  for (const id of ids) {
    const page = await launch({ width: 1920, height: 1080 });
    try {
      await page.navigate(`http://localhost:4600/?c=${id}`);
      await page.until(() => page.ev(`!!window.__player && window.__ready === true`), 30000);
      await page.sleep(2500); // media and fonts settle
      await page.ev(`window.__player.seekTo(0)`);
      await page.sleep(600);
      const rec = await page.record(`render-${id}`);
      await page.sleep(300);
      // a real click: Chrome only lets a user gesture start playback
      await page.ev(`document.addEventListener('mousedown', () => window.__player.play(), { once: true })`);
      await page.mouse.park(-40, -40);
      await page.mouse.click();
      const secs = durations[id].seconds;
      await page.until(() => page.ev(`window.__ended === true`), (secs + 20) * 1000, 250);
      await page.sleep(200);
      const r = await rec.stop();
      const video = id.startsWith('P') ? 'pitch' : 'technical';
      const dir = join(ROOT, 'demo/out', video);
      mkdirSync(dir, { recursive: true });
      const dest = join(dir, `${id}-${slug(durations[id].title)}.mp4`);
      renameSync(r.out, dest);
      console.log(`${id}  ${secs}s scene → ${r.seconds.toFixed(1)}s recorded, ${r.frames} frames (${(r.frames / r.seconds).toFixed(1)} fps)  ${dest}`);
    } finally { page.close(); }
  }
} finally { server.close(); }
process.exit(0);
