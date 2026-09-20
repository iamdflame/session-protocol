/* Shared by the serverless functions: the devnet manifest, the operator key
   from the environment, and a JSON response helper. */
import { Connection, Keypair } from '@solana/web3.js';
import type { Manifest } from '../../keeper/src/crank-core.ts';
// The same file the site serves at /devnet.json, bundled into the function so
// the two can never describe different vaults.
import manifest from '../public/devnet.json' with { type: 'json' };

export function loadManifest(): Manifest {
  return manifest as unknown as Manifest;
}

export function operator(): Keypair {
  const raw = process.env.OPERATOR_KEYPAIR;
  if (!raw) throw new Error('OPERATOR_KEYPAIR is not configured');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

export const connection = (m: Manifest) =>
  new Connection(process.env.DEVNET_RPC ?? m.rpc, 'confirmed');

export const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      ...extra,
    },
  });

/* ── Node-style entry ────────────────────────────────────────────────────── */

import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Vercel invokes a plain `.js` function the Node way — `(req, res)` — and
 * waits for `res.end()`. The handlers above are written against the Web
 * `Request`/`Response` types, which are easier to test in isolation, so this
 * bridges the two: build a Request from the incoming message, run the handler,
 * write its Response out. Returning a Response without this leaves the
 * function hanging until the platform kills it.
 */
export function nodeHandler(handler: (req: Request) => Promise<Response>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : null;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers.set(k, v); else if (Array.isArray(v)) headers.set(k, v.join(', '));
    }
    const url = `https://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
    const method = req.method ?? 'GET';
    const request = new Request(url, {
      method, headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
    });

    let response: Response;
    try {
      response = await handler(request);
    } catch (e) {
      response = json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }

    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    const out = Buffer.from(await response.arrayBuffer());
    res.end(out);
  };
}
