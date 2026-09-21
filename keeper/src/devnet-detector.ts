/* Post the OPENAI reading to the devnet event vault, from a terminal.
   `npm run devnet:detector -- --dry` reads and prints without writing. */
import { readFileSync } from 'node:fs';
import { Connection, Keypair } from '@solana/web3.js';
import { postDetector } from './detector.ts';
import type { Manifest } from './crank-core.ts';

const m: Manifest = JSON.parse(readFileSync('web/public/devnet-openai.json', 'utf8'));
const op = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('keeper/.devnet/operator.json', 'utf8'))));
const conn = new Connection(m.rpc, 'confirmed');

const report = await postDetector(conn, m, op, { dry: process.argv.includes('--dry') });
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
