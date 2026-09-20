import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Inline the pre-paint ground script.
 *
 * scripts/gen-ground.ts regenerates it from sdk/src/calendar.ts and refuses to
 * emit if the two ever disagree, so running it here means the shipped script
 * cannot drift from the calendar the program is pinned to. A stale build would
 * show the wrong session for a moment, which on this page is a lie.
 */
function groundScript(): Plugin {
  return {
    name: 'session-ground-script',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        execFileSync('node', ['--experimental-strip-types', 'scripts/gen-ground.ts'], {
          cwd: fileURLToPath(new URL('.', import.meta.url)),
          stdio: 'pipe',
        });
        const src = readFileSync(
          fileURLToPath(new URL('./src/generated/ground-script.ts', import.meta.url)), 'utf8');
        const js = JSON.parse(src.slice(src.indexOf('= ') + 2, src.lastIndexOf(';')));
        return html.replace('/*__GROUND__*/', js);
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), groundScript()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // The site imports the SDK directly rather than vendoring a copy. The
      // calendar is pinned to the on-chain program by 4,734 shared vectors; a
      // second copy here would be free to drift from the thing that decides
      // who gets paid.
      '@sdk': fileURLToPath(new URL('../sdk/src', import.meta.url)),
    },
  },
  // A few transitive wallet dependencies probe `process.env` at import time.
  define: { 'process.env': {} },
  server: { port: 3100, fs: { allow: ['..'] } },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // web3.js and the wallet adapter are ~600kb between them and change
        // on a different cadence from the app. A chunk of their own is
        // fetched in parallel with the entry and stays cached across deploys
        // that touch nothing but the site.
        manualChunks(id) {
          if (id.includes('node_modules/@solana/') || id.includes('node_modules/@wallet-standard/') ||
              id.includes('node_modules/@noble/') || id.includes('node_modules/buffer/') ||
              id.includes('node_modules/bn.js/') || id.includes('node_modules/borsh/') ||
              id.includes('node_modules/rpc-websockets/') || id.includes('node_modules/superstruct/') ||
              id.includes('node_modules/jayson/') || id.includes('node_modules/bs58') ||
              id.includes('node_modules/tweetnacl') || id.includes('node_modules/base-x')) {
            return 'solana';
          }
        },
      },
    },
  },
});
