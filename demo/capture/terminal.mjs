/* ───────────────────────────────────────────────────────────────────────────
   Terminal scenes, captured from real runs.

     node demo/capture/terminal.mjs <name> [<name> ...]

   Each runs a real command here, keeps its output lines with the time each
   appeared, drops build noise (Compiling, Finished, warnings), and writes
   demo/captures/terminal/<name>.json. The video's terminal replays exactly
   those lines, faster if it must, never different ones.

   A capture that contains anything shaped like a secret key (a 64-byte JSON
   array) is refused outright.
   ─────────────────────────────────────────────────────────────────────────── */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './rig.mjs';

const OUT = join(ROOT, 'demo/captures/terminal');
const NOISE = /^\s*(Compiling|Finished|Running|Blocking|Downloaded|Downloading|Updating|Fresh|warning|note:|\s*-->|\s*\||\s*=|> |npm warn|\(node:\d+\)|\(Use `node)/;

const RUNS = {
  proptest: { cwd: '.', shown: 'cargo test -p session-core cross', cmd: 'cargo', args: ['test', '-p', 'session-core', 'cross'] },
  bell: { cwd: 'tests/integration', shown: 'cargo test --test bell', cmd: 'cargo', args: ['test', '--test', 'bell'] },
  cross: { cwd: 'tests/integration', shown: 'cargo test --test cross', cmd: 'cargo', args: ['test', '--test', 'cross'] },
  fuzz: { cwd: 'tests/integration', shown: 'CROSS_FUZZ=40 cargo test --test cross_fuzz -- --nocapture', cmd: 'cargo', args: ['test', '--test', 'cross_fuzz', '--', '--nocapture'], env: { CROSS_FUZZ: '40' } },
  fuzz300: { cwd: 'tests/integration', shown: 'CROSS_FUZZ=300 cargo test --test cross_fuzz -- --nocapture', cmd: 'cargo', args: ['test', '--test', 'cross_fuzz', '--', '--nocapture'], env: { CROSS_FUZZ: '300' } },
  ts: { cwd: '.', shown: 'npm run test:ts', cmd: 'npm', args: ['run', '--silent', 'test:ts'] },
  mcp: { cwd: '.', shown: 'npm run mcp:check', cmd: 'npm', args: ['run', '--silent', 'mcp:check'] },
  drills: { cwd: '.', shown: 'npm run cross:drill -- --status', cmd: 'node', args: ['--experimental-strip-types', '--no-warnings', 'keeper/src/cross-drill.ts', '--status'] },
  poster: { cwd: '.', shown: 'npm run bell:poster -- --status', cmd: 'node', args: ['--experimental-strip-types', '--no-warnings', 'keeper/src/bell-poster.ts', '--status'] },
  keeper: { cwd: '.', shown: 'journalctl --user -u cross-keeper', cmd: 'journalctl', args: ['--user', '-u', 'cross-keeper', '--since', process.env.SINCE ?? '-60min', '--no-pager', '-o', 'cat'] },
};

function capture(name) {
  const r = RUNS[name];
  if (!r) throw new Error(`no run ${name}: ${Object.keys(RUNS).join(', ')}`);
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const lines = [];
    const child = spawn(r.cmd, r.args, { cwd: join(ROOT, r.cwd), env: { ...process.env, NODE_NO_WARNINGS: '1', CARGO_TERM_COLOR: 'never', ...(r.env ?? {}) } });
    let buf = '';
    const take = (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
        buf = buf.slice(i + 1);
        if (line && !NOISE.test(line)) lines.push({ t: (Date.now() - t0) / 1000, text: line });
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', reject);
    child.on('close', (code) => {
      if (buf.trim()) lines.push({ t: (Date.now() - t0) / 1000, text: buf.trim() });
      const all = lines.map((l) => l.text).join('\n');
      if (/\[\s*\d{1,3}(\s*,\s*\d{1,3}){63}\s*\]/.test(all) || /secretKey/i.test(all)) {
        reject(new Error(`${name}: output contains something shaped like a key; not saved`));
        return;
      }
      mkdirSync(OUT, { recursive: true });
      const file = join(OUT, `${name}.json`);
      writeFileSync(file, JSON.stringify({ name, command: r.shown, cwd: r.cwd, exit: code, capturedAt: new Date().toISOString(), seconds: (Date.now() - t0) / 1000, lines }, null, 1));
      resolve({ file, exit: code, lines: lines.length, seconds: (Date.now() - t0) / 1000 });
    });
  });
}

for (const name of process.argv.slice(2)) console.log(name, await capture(name));
