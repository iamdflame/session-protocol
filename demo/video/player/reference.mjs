/* The reference cuts: each video's clips joined in order, with the script
   burned in as captions timed to the scene lengths, in one encode. A timing
   guide for the edit, not the final.

     node player/reference.mjs [pitch|technical]
*/
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = join(HERE, '../../..');
const durations = JSON.parse(readFileSync(join(HERE, '../src/durations.json'), 'utf8'));
const which = process.argv[2] ? [process.argv[2]] : ['pitch', 'technical'];

const ts = (s) => {
  const ms = Math.round(s * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

/** The script's caption text, one scene at a time, split into short lines spread over its voice. */
function srt(video) {
  const script = readFileSync(join(ROOT, `demo/SCRIPT-${video}.md`), 'utf8');
  const scenes = [...script.matchAll(/^## ([PT]\d\d) · [^\n]*\n[\s\S]*?\*\*Caption:\*\* ([^\n]+)/gm)].map((m) => ({ id: m[1], text: m[2] }));
  let t0 = 0, n = 1;
  const out = [];
  for (const sc of scenes) {
    const dur = durations[sc.id].seconds;
    const words = sc.text.split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      if ((line + ' ' + w).trim().length > 56) { lines.push(line); line = w; } else line = (line + ' ' + w).trim();
      if (/[.?!]$/.test(w) && line.length > 28) { lines.push(line); line = ''; }
    }
    if (line) lines.push(line);
    const speak = Math.max(1, dur - 0.9);
    const total = lines.reduce((a, l) => a + l.length, 0);
    let t = t0 + 0.4;
    for (const l of lines) {
      const d = (l.length / total) * speak;
      out.push(`${n++}\n${ts(t)} --> ${ts(t + d - 0.06)}\n${l}\n`);
      t += d;
    }
    t0 += dur;
  }
  const dir = join(ROOT, 'demo/captions');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${video}.srt`);
  writeFileSync(file, out.join('\n'));
  return file;
}

for (const video of which) {
  const dir = join(ROOT, 'demo/out', video);
  const clips = readdirSync(dir).filter((f) => /^[PT]\d\d-.*\.mp4$/.test(f)).sort().map((f) => join(dir, f));
  const list = join(dir, 'concat.txt');
  writeFileSync(list, clips.map((f) => `file '${f}'`).join('\n') + '\n');
  const subs = srt(video);
  const style = 'FontName=Geist,FontSize=19,PrimaryColour=&H00F7F5F3,BackColour=&H990D0A08,BorderStyle=4,Outline=0,Shadow=0,MarginV=34';
  const out = join(ROOT, 'demo/out', `${video}-reference.mp4`);
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', `subtitles=${subs}:fontsdir=${join(HERE, '../public/fonts')}:force_style='${style}'`,
    '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${video}: ffmpeg failed`);
  console.log(`${video}: ${clips.length} clips → ${out}; captions ${subs}`);
}
