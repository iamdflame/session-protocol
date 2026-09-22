/* Do the bytes on chain match the artifact in this tree?
 *
 * `solana-verify` answers a stronger question — it rebuilds from a tagged
 * commit inside a pinned container and compares *that* — and it needs Docker
 * and a toolchain this machine does not have. This answers the weaker one
 * that can be answered anywhere, and it is the half that catches the mistake
 * people actually make: deploying a build nobody kept, then changing the
 * source.
 *
 * The deployed account is longer than the artifact because a program account
 * is padded for future upgrades. Trailing zero bytes are stripped from both
 * sides before hashing, which is what `solana-verify` does too.
 *
 *   node scripts/verify-deployed.mjs [--url <cluster>] [--program-id <id>]
 */
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const URL = arg('url', 'https://api.devnet.solana.com');
const ID = arg('program-id', '8gWC37AFvgnPMAZSqiimbkpqPVhF3PrA1rao5agVKqKZ');
const LOCAL = arg('artifact', 'target/deploy/session.so');

const hash = buf => {
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0) end--;          // strip the padding
  return { bytes: buf.length, stripped: end, sha256: createHash('sha256').update(buf.subarray(0, end)).digest('hex') };
};

let local;
try {
  local = hash(readFileSync(LOCAL));
} catch {
  console.error(`no artifact at ${LOCAL} — run \`npm run build:program\` first`);
  process.exit(2);
}

const dump = join(tmpdir(), `session-onchain-${process.pid}.so`);
try {
  execFileSync('solana', ['program', 'dump', ID, dump, '--url', URL], { stdio: 'pipe' });
} catch (e) {
  console.error(`could not dump ${ID} from ${URL}: ${String(e.stderr ?? e).slice(0, 200)}`);
  process.exit(2);
}

const chain = hash(readFileSync(dump));
rmSync(dump, { force: true });

console.log(`program   ${ID}`);
console.log(`cluster   ${URL}`);
console.log(`local     ${String(local.bytes).padStart(7)} bytes, ${String(local.stripped).padStart(7)} stripped  ${local.sha256}`);
console.log(`on chain  ${String(chain.bytes).padStart(7)} bytes, ${String(chain.stripped).padStart(7)} stripped  ${chain.sha256}`);

if (local.sha256 === chain.sha256) {
  console.log('\nMATCH — the deployed program is this artifact.');
  process.exit(0);
}
console.log('\nDIFFER — the deployed program is not this artifact.');
console.log('Either the tree has moved since the deploy, or the deploy was from a build');
console.log('nobody kept. Neither is a bug on its own; both mean the source anyone can');
console.log('read is not the source running.');
process.exit(1);
