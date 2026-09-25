/* Put the real screen recordings into the rendered scenes.

   Scenes are rendered frame by frame with an empty browser window (NO_VIDEO),
   because seeking video one frame at a time costs seconds here. This drops
   the recording into that window with ffmpeg, cut into its segments, fading
   in with the frame, and draws the callouts over it in the site's font.

     node player/composite.mjs P03 [P04 ...]
*/
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = join(HERE, '../../..');
const FONT = join(HERE, '../public/fonts/geist-latin-v5.woff2');
const durations = JSON.parse(readFileSync(join(HERE, '../src/durations.json'), 'utf8'));
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const K = 1600 / 1920; // the window shows the 1920×1080 capture at this scale, at (160, 116)
const box = (x, y, w, h) => ({ x: Math.round(160 + x * K) - 10, y: Math.round(116 + y * K) - 10, w: Math.round(w * K) + 20, h: Math.round(h * K) + 20 });

export const SCENES = {
  P03: {
    video: 'demo/captures/ticket-order.mp4', at: 4,
    // typing; the quote beside the bell; the bell; the click and the toast; "Your orders"
    segments: [{ from: 5.5, to: 9.5 }, { from: 18.5, to: 22.5 }, { from: 31, to: 34 }, { from: 38.5, to: 46.5, rate: 1.5 }, { from: 48.5, to: 53 }],
    callouts: [
      { ...box(465, 495, 180, 110), label: 'Now, on Jupiter', color: '0xFF9B3D', from: 8.5, to: 12 },
      { ...box(665, 495, 185, 110), label: 'At the bell', color: '0x4EA3FF', from: 12.2, to: 15 },
    ],
    // drawn over the recording, where the rendered one is hidden behind it; the honesty chips stay
    lowerThird: { from: 18, title: 'Devnet sandbox', sub: 'Fixture NVDAx · test USDC · a real order at today’s real open', chips: [['DEVNET', '0xC9A2FF'], ['SIMULATED PRINTS', '0xF5B84B']] },
  },
  P04: { video: 'demo/captures/oracle-prints.mp4', at: 20, segments: [{ from: 1.5, to: 8 }], callouts: [] },
};

function composite(id) {
  const sc = SCENES[id];
  const video = id.startsWith('P') ? 'pitch' : 'technical';
  const base = join(ROOT, 'demo/out', video, `${id}-${slug(durations[id].title)}.mp4`);
  const src = join(ROOT, sc.video);
  if (!existsSync(base) || !existsSync(src)) throw new Error(`${id}: need ${base} and ${src}`);
  // the recording, cut and joined
  const cuts = sc.segments.map((s, i) => `[1:v]trim=${s.from}:${s.to},setpts=(PTS-STARTPTS)/${s.rate ?? 1}[s${i}]`).join(';');
  const joined = `${sc.segments.map((_, i) => `[s${i}]`).join('')}concat=n=${sc.segments.length}:v=1:a=0,fps=30,scale=1600:900:flags=lanczos,format=yuva420p,fade=in:st=0:d=0.6:alpha=1,setpts=PTS+${sc.at}/TB[rec]`;
  const draw = sc.callouts.flatMap((c) => {
    const en = `enable='between(t,${c.from},${c.to})'`;
    return [
      `drawbox=x=${c.x}:y=${c.y}:w=${c.w}:h=${c.h}:color=${c.color}@0.95:t=4:${en}`,
      `drawtext=fontfile='${FONT}':text='${c.label.replace(/'/g, "’").replace(/:/g, '\\:')}':fontsize=24:fontcolor=0x06080A:box=1:boxcolor=${c.color}:boxborderw=10:x=${c.x}:y=${c.y - 48}:${en}`,
    ];
  });
  if (sc.lowerThird) {
    const l = sc.lowerThird, en = `enable='gte(t,${l.from})'`, esc = (t) => t.replace(/'/g, '\u2019').replace(/:/g, '\\:');
    draw.push(
      `drawbox=x=66:y=856:w=720:h=168:color=0x0B0E12@1:t=fill:${en}`,
      `drawbox=x=66:y=856:w=720:h=168:color=0xFFFFFF@0.14:t=2:${en}`,
      `drawtext=fontfile='${FONT}':text='${esc(l.title)}':fontsize=32:fontcolor=0xF3F5F7:x=92:y=878:${en}`,
      `drawtext=fontfile='${FONT}':text='${esc(l.sub)}':fontsize=21:fontcolor=0x9AA3AE:x=92:y=924:${en}`,
    );
    let x = 92;
    for (const [label, col] of l.chips) {
      draw.push(`drawtext=fontfile='${FONT}':text='• ${label}':fontsize=17:fontcolor=${col}:box=1:boxcolor=${col}@0.14:boxborderw=8:x=${x}:y=968:${en}`);
      x += 30 + label.length * 12;
    }
  }
  const filter = `${cuts};${joined};[0:v][rec]overlay=160:116:eof_action=pass${draw.length ? ',' + draw.join(',') : ''},format=yuv420p[out]`;
  const tmp = base.replace(/\.mp4$/, '.composite.mp4');
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', base, '-i', src, '-filter_complex', filter, '-map', '[out]',
    '-t', String(durations[id].seconds), '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-movflags', '+faststart', tmp], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${id}: ffmpeg failed`);
  renameSync(tmp, base);
  console.log(`${id}: recording composited into ${base}`);
}

for (const id of process.argv.slice(2)) composite(id);
