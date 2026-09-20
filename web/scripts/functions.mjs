/* Bundle the serverless functions into self-contained files.

   Vercel compiles api/*.ts but does not trace imports that leave the project
   root, and these functions share the SDK (../../sdk) and the crank
   (../../keeper) with the rest of the repository. Bundling them here means
   Vercel receives plain files with no imports to resolve — the same code the
   CLI keeper runs, in one file each. */

import { build } from 'esbuild';
import { rmSync, mkdirSync, readdirSync } from 'node:fs';

rmSync('api', { recursive: true, force: true });
mkdirSync('api', { recursive: true });

const entries = readdirSync('api-src').filter(f => f.endsWith('.ts') && !f.startsWith('_')).map(f => `api-src/${f}`);

await build({
  entryPoints: entries,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outdir: 'api',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  // Node's own modules stay external; everything else — web3.js, the SDK,
  // the crank — is inlined.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
});

for (const f of readdirSync('api')) console.log(`api/${f}`);
