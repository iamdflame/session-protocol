/* ───────────────────────────────────────────────────────────────────────────
   SESSION as tools, for an agent that has to decide something.

   Clawpump's agents consume MCP, and the protocol's whole argument is that
   holding a session is a position an agent can reason about: what does the
   night cost, which half am I holding, is the vault healthy, what would a
   crank do. Those are questions, and this is the surface that answers them.

   Four read tools and two that spend money, and the split is deliberate:

     session_health      what the vault is, and what would page an operator
     session_statement   a wallet's P&L, against holding the token undivided
     session_quote_pool  what DAY sells for, while it is the exposed class
     session_crank       settle a due boundary, fill the handoff  (writes)
     session_mint        buy the parked class                      (writes)

   Every write is refused unless a key is configured, capped by
   `AGENT_MAX_MINT_QUOTE`, and refused outright on mainnet unless
   `SESSION_ALLOW_MAINNET=1` is set. An agent that can be talked into
   spending is a liability; the cap and the cluster check are in the tool
   rather than in a prompt, because that is the only place they hold.

     npm run mcp            stdio, for a local agent
   ─────────────────────────────────────────────────────────────────────────── */

import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { decodeVault } from '../sdk/src/vault.ts';
import { evaluate, format, type VaultState } from '../sdk/src/health.ts';
import { fundingTransfer, skewWad, valueOf, WAD, other, type ShareClass } from '../sdk/src/settle.ts';
import { eventsFromLogs } from '../sdk/src/events.ts';
import { statement, type TimedEvent } from '../sdk/src/statement.ts';
import { ata, createAtaIdempotentIx, mintSharesIx, explainProgramError } from '../sdk/src/ix.ts';
import { load } from '../keeper/src/index.ts';
import { crank, type Manifest } from '../keeper/src/crank-core.ts';

/* ── configuration, and the limits that are not negotiable ───────────────── */

const MANIFEST = process.env.SESSION_MANIFEST ?? 'keeper/.devnet/manifest.json';
const KEYPAIR = process.env.SESSION_KEYPAIR ?? 'keeper/.devnet/operator.json';
const MAX_MINT_QUOTE = BigInt(process.env.AGENT_MAX_MINT_QUOTE ?? '1000');
const ALLOW_MAINNET = process.env.SESSION_ALLOW_MAINNET === '1';

const m: Manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const conn = new Connection(m.rpc, 'confirmed');
const pk = (s: string) => new PublicKey(s);

/** Mainnet is not a louder devnet. Nothing writes there without being told. */
const isMainnet = !/devnet|testnet|localhost|127\.0\.0\.1/.test(m.rpc);
const signer = (): Keypair | null => {
  if (!existsSync(KEYPAIR)) return null;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR, 'utf8'))));
};

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const json = (v: unknown) =>
  text(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2));

/** The one place a write is allowed or refused, so there is only one place. */
function guardWrite(): { ok: true; payer: Keypair } | { ok: false; why: string } {
  if (isMainnet && !ALLOW_MAINNET) {
    return { ok: false, why: `${m.rpc} is not a test cluster. Set SESSION_ALLOW_MAINNET=1 to permit writes there; this refusal is deliberate.` };
  }
  const payer = signer();
  if (!payer) return { ok: false, why: `no key at ${KEYPAIR}: this server can read but cannot sign.` };
  return { ok: true, payer };
}

/* ── reading the vault ───────────────────────────────────────────────────── */

const readState = () => load(conn, pk(m.vault), pk(m.markPriceUpdate), pk(m.equityPriceUpdate));

const fromAtoms = (v: bigint, d: number) => Number(v) / 10 ** d;

function fundingNow(s: VaultState, v: { fundingKBps: number; fundingMaxBps: number }) {
  const night = valueOf(s.nightSupply, s.nightNav);
  const day = valueOf(s.daySupply, s.dayNav);
  const transfer = fundingTransfer(night, day, {
    kBps: BigInt(v.fundingKBps), maxBps: BigInt(v.fundingMaxBps),
  });
  const base = night < day ? night : day;
  const bps = base > 0n ? Number((transfer < 0n ? -transfer : transfer) * 10_000n / base) : 0;
  return {
    bps,
    payer: transfer === 0n ? null : transfer > 0n ? 'night' : 'day',
    // Zero has three causes and they are not interchangeable: nothing minted,
    // one class empty (the transfer is sized on the smaller side), or a book
    // that is genuinely level.
    whyZero: transfer !== 0n ? null
      : night === 0n && day === 0n ? 'nothing minted'
        : base === 0n ? `only ${night === 0n ? 'DAY' : 'NIGHT'} has holders, and funding is sized on the smaller side`
          : 'the two classes are the same size',
    skewPct: Number(skewWad(night, day)) / 1e16,
  };
}

/* ── the server ──────────────────────────────────────────────────────────── */

const server = new McpServer({ name: 'session', version: '1.0.0' });

server.registerTool('session_health', {
  title: 'Vault health',
  description:
    'Read the SESSION vault from chain: which class is exposed, both NAVs, backing '
    + 'against claims, the funding the next bell will charge, and every signal that '
    + 'would page an operator. Read-only.',
}, async () => {
  const { vault, state } = await readState();
  const now = Math.floor(Date.now() / 1000);
  const h = evaluate(state, now);
  const qd = vault.quoteDecimals;
  return json({
    cluster: isMainnet ? 'mainnet' : 'devnet',
    vault: m.vault,
    symbol: m.symbol,
    severity: h.severity,
    signals: h.signals.map(s => ({ id: s.id, severity: s.severity, message: s.message, action: s.action })),
    exposed: vault.exposed,
    parked: other(vault.exposed as ShareClass),
    halted: vault.halted,
    haltReason: vault.haltReason,
    navNight: Number(vault.nightNav) / 1e18,
    navDay: Number(vault.dayNav) / 1e18,
    valueNight: fromAtoms(valueOf(state.nightSupply, state.nightNav), qd),
    valueDay: fromAtoms(valueOf(state.daySupply, state.dayNav), qd),
    marginQuote: fromAtoms(h.margin, qd),
    pendingDelta: state.pendingDelta.toString(),
    lastBoundaryTs: vault.lastBoundaryTs,
    crankLateSecs: h.crankLateSecs,
    funding: fundingNow(state, vault),
    report: format(h),
  });
});

server.registerTool('session_statement', {
  title: 'A wallet\'s statement',
  description:
    'What a wallet made in this vault, per class, and what the same money would have '
    + 'made held as the undivided token over the same moments. Derived from the '
    + 'program\'s own events. Read-only, and slow: it reads the vault\'s history.',
  inputSchema: { wallet: z.string().describe('Base58 wallet address') },
}, async ({ wallet }) => {
  const vault = decodeVault((await conn.getAccountInfo(pk(m.vault)))!.data);
  const sigs = await conn.getSignaturesForAddress(pk(m.vault), { limit: 1000 });
  const events: TimedEvent[] = [];
  for (let i = 0; i < sigs.length; i += 5) {
    const chunk = sigs.slice(i, i + 5);
    let txs = null;
    for (let a = 0; a < 5 && !txs; a++) {
      if (a) await new Promise(r => setTimeout(r, 2_000 * 2 ** (a - 1)));
      txs = await conn.getParsedTransactions(chunk.map(x => x.signature),
        { maxSupportedTransactionVersion: 0 }).catch(() => null);
    }
    // A statement summed from part of a history is wrong and looks right.
    if (!txs) return text('The RPC endpoint stopped serving transactions part-way through the vault\'s history. A statement summed from half of it would be wrong, so there is none. Try again.');
    txs.forEach((t, j) => {
      for (const event of eventsFromLogs(t?.meta?.logMessages)) {
        events.push({ signature: chunk[j].signature, at: chunk[j].blockTime ?? null, event });
      }
    });
    if (i + 5 < sigs.length) await new Promise(r => setTimeout(r, 600));
  }

  const st = statement(events, wallet, vault.nightNav, vault.dayNav);
  const qd = vault.quoteDecimals;
  const q = (v: bigint) => fromAtoms(v, qd);
  return json({
    wallet,
    trades: st.rows.length,
    night: { shares: q(st.night.shares), quoteIn: q(st.night.quoteIn), quoteOut: q(st.night.quoteOut), value: q(st.night.value), pnl: q(st.night.pnl) },
    day: { shares: q(st.day.shares), quoteIn: q(st.day.quoteIn), quoteOut: q(st.day.quoteOut), value: q(st.day.value), pnl: q(st.day.pnl) },
    bundle: { units: q(st.bundle.units), value: q(st.bundle.value), pnl: q(st.bundle.pnl) },
    splitVersusBundle: q(st.versusBundle),
    navNight: Number(st.navNight) / 1e18,
    navDay: Number(st.navDay) / 1e18,
    benchmarkExact: st.complete,
  });
});

server.registerTool('session_quote_pool', {
  title: 'Quote a share class on its pool',
  description:
    'Mint and redeem work only while a class is parked; a pool is the only way out '
    + 'of the exposed class. This reports the pools this vault has and what the pool '
    + 'price is against NAV, which is the number that says whether the market agrees '
    + 'with the program. Read-only.',
}, async () => {
  const pools = (m as Manifest & { pools?: Record<string, string> }).pools ?? {};
  if (!Object.keys(pools).length) return text('This vault has no pools in its manifest.');
  const vault = decodeVault((await conn.getAccountInfo(pk(m.vault)))!.data);
  const { CpAmm, getPriceFromSqrtPrice } = await import('@meteora-ag/cp-amm-sdk');
  const amm = new CpAmm(conn);
  const out: Record<string, unknown> = {};
  for (const [name, address] of Object.entries(pools)) {
    try {
      const p = await amm.fetchPoolState(pk(address));
      // Both sides are 6-decimal here; the pair name says which is which.
      const price = Number(getPriceFromSqrtPrice(p.sqrtPrice, vault.quoteDecimals, vault.quoteDecimals));
      const cls: ShareClass = name.includes('NIGHT') ? 'night' : 'day';
      const nav = Number(cls === 'night' ? vault.nightNav : vault.dayNav) / 1e18;
      out[name] = {
        address, price, nav,
        premiumPct: nav > 0 ? ((price / nav) - 1) * 100 : null,
        exposed: vault.exposed === cls,
        note: vault.exposed === cls
          ? 'this class is carrying the stock: mint and redeem are closed, the pool is the only exit'
          : 'this class is parked: redeem at NAV is open, so the pool should not trade far from it',
      };
    } catch (e) {
      out[name] = { address, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return json(out);
});

server.registerTool('session_crank', {
  title: 'Settle a due boundary',
  description:
    'Run one crank: settle the boundary if the calendar says one has passed, fill the '
    + 'handoff from the configured inventory, and open the call auction for whatever '
    + 'is left. Permissionless on chain — this tool only pays the fee. Writes.',
}, async () => {
  const g = guardWrite();
  if (!g.ok) return text(`Refused: ${g.why}`);
  const report = await crank(conn, m, g.payer);
  return json(report);
});

server.registerTool('session_mint', {
  title: 'Buy the parked class',
  description:
    'Mint shares of a class with quote, at the NAV on chain. The program refuses the '
    + 'exposed class, so this is how you take the side that is flat. Writes, and capped '
    + `at ${MAX_MINT_QUOTE} quote atoms by AGENT_MAX_MINT_QUOTE.`,
  inputSchema: {
    quote: z.number().int().positive().describe('Quote atoms to spend'),
    class: z.enum(['night', 'day', 'parked']).default('parked')
      .describe('Which class to buy. "parked" resolves to whichever is currently flat.'),
  },
}, async ({ quote, class: which }) => {
  const g = guardWrite();
  if (!g.ok) return text(`Refused: ${g.why}`);

  const amount = BigInt(quote);
  if (amount > MAX_MINT_QUOTE) {
    return text(`Refused: ${amount} exceeds the ${MAX_MINT_QUOTE} cap in AGENT_MAX_MINT_QUOTE. `
      + 'The cap is enforced here rather than asked for in a prompt, which is the only place it holds.');
  }

  const vault = decodeVault((await conn.getAccountInfo(pk(m.vault)))!.data);
  const cls: ShareClass = which === 'parked' ? other(vault.exposed as ShareClass) : which;
  if (cls === vault.exposed) {
    return text(`Refused: ${cls.toUpperCase()} is carrying the stock right now. The program would reject this, `
      + 'and so does this tool — minting into the exposed class would buy a position at a NAV that has '
      + 'already moved. The parked class is ' + other(vault.exposed as ShareClass).toUpperCase() + '.');
  }

  const shareMint = pk(cls === 'night' ? m.nightMint : m.dayMint);
  const sp = pk(m.shareTokenProgram);
  const qp = pk(m.tokenProgram);
  const owner = g.payer.publicKey;
  const tx = new Transaction()
    .add(createAtaIdempotentIx(owner, owner, shareMint, sp))
    .add(mintSharesIx({
      vault: pk(m.vault),
      classMint: shareMint,
      nightMint: pk(m.nightMint),
      dayMint: pk(m.dayMint),
      quoteVault: pk(m.quoteVault),
      userQuote: ata(owner, pk(m.quoteMint), qp),
      userShares: ata(owner, shareMint, sp),
      user: owner,
      quoteMint: pk(m.quoteMint),
      tokenProgram: qp,
      shareTokenProgram: sp,
    }, cls, amount));

  try {
    const signature = await sendAndConfirmTransaction(conn, tx, [g.payer], { commitment: 'confirmed' });
    return json({
      signature, class: cls, quote: amount.toString(),
      nav: Number(cls === 'night' ? vault.nightNav : vault.dayNav) / 1e18,
      explorer: `https://explorer.solana.com/tx/${signature}${isMainnet ? '' : '?cluster=devnet'}`,
    });
  } catch (e) {
    const err = e as { logs?: string[]; message?: string };
    return text(`The program refused it: ${explainProgramError(err.logs) ?? err.message ?? String(e)}`);
  }
});

await server.connect(new StdioServerTransport());
