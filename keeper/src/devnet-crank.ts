/* Run one crank cycle against the devnet vault from the command line.
   The serverless endpoint does the same thing on request; this is for an
   operator at a terminal. Usage: npm run devnet:crank */

import { readFileSync } from 'node:fs';
import { Connection, Keypair } from '@solana/web3.js';
import { crank, type Manifest } from './crank-core.ts';

const m: Manifest = JSON.parse(readFileSync('keeper/.devnet/manifest.json', 'utf8'));
const operator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('keeper/.devnet/operator.json', 'utf8'))));
const conn = new Connection(process.env.DEVNET_RPC ?? m.rpc, 'confirmed');

const r = await crank(conn, m, operator);
console.log(JSON.stringify(r, null, 2));
process.exit(r.ok ? 0 : 1);
