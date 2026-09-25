/* Render the demo videos: one numbered clip per scene for CapCut, then a
   reference cut of each video (clips joined without re-encoding), and a copy
   with the script burned in as captions, timed to the scene lengths.

     node render.mjs [pitch|technical|all] [--only P03,P05] [--no-cut]
*/
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = join(HERE, '../..');
const HS = `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`;
const durations = JSON.parse(readFileSync(join(HERE, 'src/durations.json'), 'utf8'));
const args = process.argv.slice(2);
const which = ['pitch', 'technical'].includes(args[0]) ? [args[0]] : ['pitch', 'technical'];
const only = (args[args.indexOf('--only') + 1] ?? '').split(',').filter((x) => args.includes('--only') && x);
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const run = (cmd, a) => { const r = spawnSync(cmd, a, { stdio: 'inherit', cwd: HERE }); if (r.status !== 0) throw new Error(`${cmd} failed`); };

/** Captions from the script: each scene's caption text, split into short lines, spread over its voice. */
function srt(video) {
  const script = readFileSync(join(ROOT, `demo/SCRIPT-${video}.md`), 'utf8');
  const scenes = [...script.matchAll(/^## ([PT]\d\d) · .*?\n[\s\S]*?\*\*Caption:\*\* (.+)$/gm)].map((m) => ({ id: m[1], text: m[2] }));
  const ts = (s) => { const ms = Math.round(s * 1000); const h = Math.floor(ms / 3600000), mi = Math.floor(ms / 60000) % 60, se = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(se).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
  let t0 = 0, n = 1;
  const out = [];
  for (const sc of scenes) {
    const dur = durations[sc.id].seconds;
    const words = sc.text.split(/\s+/);
    const chunks = [];
    for (let i = 0; i < words.length;) {
      let line = '';
      while (i < words.length && (line + ' ' + words[i]).trim().length <= 58) { line = (line + ' ' + words[i]).trim(); i++; if (/[.?!:]$/.test(line) && line.length > 24) break; }
      chunks.push(line || words[i++]);
    }
    const speak = Math.max(1, dur - 0.8);
    const total = chunks.reduce((a, c) => a + c.length, 0);
    let t = t0 + 0.3;
    for (const c of chunks) {
      const d = (c.length / total) * speak;
      out.push(`${n++}\n${ts(t)} --> ${ts(t + d - 0.05)}\n${c}\n`);
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

// bundle once; every render reuses it
const BUNDLE = join(HERE, 'build');
if (!args.includes('--no-bundle')) run('npx', ['remotion', 'bundle', 'src/index.ts', `--out-dir=${BUNDLE}`, '--log=error']);

for (const video of which) {
  const prefix = video === 'pitch' ? 'P' : 'T';
  const ids = Object.keys(durations).filter((k) => k.startsWith(prefix));
  const dir = join(ROOT, 'demo/out', video);
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (const id of ids) {
    const file = join(dir, `${id}-${slug(durations[id].title)}.mp4`);
    files.push(file);
    if (only.length && !only.includes(id)) continue;
    console.log(`── ${id} ${durations[id].title} (${durations[id].seconds}s)`);
    run('npx', ['remotion', 'render', BUNDLE, id, file, `--browser-executable=${HS}`, '--codec=h264', '--crf=16', `--concurrency=${process.env.CONC ?? 4}`, '--log=error', '--overwrite']);
  }
  if (args.includes('--no-cut') || files.some((f) => !existsSync(f))) continue;
  const list = join(dir, 'concat.txt');
  writeFileSync(list, files.map((f) => `file '${f}'`).join('\n') + '\n');
  const clean = join(ROOT, 'demo/out', `${video}-reference-clean.mp4`);
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', clean]);
  const subs = srt(video);
  const style = "FontName=Geist,FontSize=20,PrimaryColour=&H00F7F5F3,OutlineColour=&H660D0A08,BorderStyle=3,Outline=6,Shadow=0,MarginV=36";
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', clean, '-vf', `subtitles=${subs}:fontsdir=${join(HERE, 'public/fonts')}:force_style='${style}'`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', join(ROOT, 'demo/out', `${video}-reference.mp4`)]);
  console.log(`✓ ${video}: ${files.length} clips, reference cuts in demo/out/`);
}
