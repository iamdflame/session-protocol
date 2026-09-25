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

   And bell orders, the cross the site's /bells trades: buy or sell NVDAx at
   the NYSE open or close, at the bell's print.

     bell_status         the next bells, their books, the last print
     bell_quote          a bell order against a swap on Jupiter now
     bell_receipt        what a cross cleared at, checked, and what you got
     bell_place_order    an order in the next bell's cross   (writes)
     bell_cancel_order   take one back before the freeze     (writes)

   Every write is refused unless a key is configured, capped per order
   (`AGENT_MAX_MINT_QUOTE`; `AGENT_MAX_BELL_QUOTE` and `AGENT_MAX_BELL_RAW`
   for bell orders), and refused outright on mainnet unless
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
import { BELL_ACCOUNT, BELL_PROGRAM_ID, bellTs, decimalPrice, decodePrint, etDay, PRINT_LISTING_OFFSET, type BellKind } from '../sdk/src/bell.ts';
import { multiplierWad, readScaledUi } from '../sdk/src/cross.ts';
import {
  cancelOrderIx, CROSS_ACCOUNT, CROSS_PROGRAM_ID, crossPda, decodeCross, decodeMarket, decodeOrder, marketRef, OFFSETS,
  orderPda, placeOrderIx, type CrossAccount, type MarketRef,
} from '../sdk/src/cross-ix.ts';
import { edgeBps, MAINNET_USDC, type SwapQuote } from '../sdk/src/counterfactual.ts';
import { checkPrint, findCounterfactual, ordersFromHistory } from '../sdk/src/receipt.ts';
import bs58 from 'bs58';

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

/* ── bell orders ─────────────────────────────────────────────────────────────
   The cross the site's /bells trades: on devnet, a fixture NVDAx priced at
   the devnet bell's simulated prints. Amounts are what a person would type:
   dollars for a buy, displayed NVDAx for a sell. The caps are in atoms.
   ─────────────────────────────────────────────────────────────────────────── */

const CROSS_MANIFEST = process.env.CROSS_MANIFEST ?? 'web/public/cross-devnet.json';
const SITE = process.env.SESSION_SITE ?? 'https://session-roan.vercel.app';
const MAX_BELL_QUOTE = BigInt(process.env.AGENT_MAX_BELL_QUOTE ?? '100000000'); // $100
const MAX_BELL_RAW = BigInt(process.env.AGENT_MAX_BELL_RAW ?? '50000000'); // 0.5 raw NVDAx

interface CrossManifest {
  market: string; listing: string; mint: string; realMint: string; keeper?: string;
  backstop: { feeBps: number }; params: { freezeSecs: number };
}
const cm: CrossManifest | null = existsSync(CROSS_MANIFEST) ? JSON.parse(readFileSync(CROSS_MANIFEST, 'utf8')) : null;
const discFilter = (bytes: number[]) => ({ memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.from(bytes)) } });
const iso = (ts: number) => new Date(ts * 1000).toISOString();
const receiptUrl = (cross: PublicKey | string) => `${SITE}/b/${typeof cross === 'string' ? cross : cross.toBase58()}`;

async function bellMarket(): Promise<{ m: CrossManifest; ref: MarketRef; multiplier: bigint; freeze: number }> {
  if (!cm) throw new Error(`no bell-order market: ${CROSS_MANIFEST} is missing`);
  const [marketInfo, mintInfo] = await conn.getMultipleAccountsInfo([pk(cm.market), pk(cm.mint)]);
  if (!marketInfo || !mintInfo) throw new Error('the bell-order market is not on this cluster');
  const scaled = readScaledUi(mintInfo.data);
  const now = Math.floor(Date.now() / 1000);
  const multiplier = (scaled && scaled !== 'malformed' ? multiplierWad(now >= scaled.newEffectiveTs ? scaled.newBits : scaled.currentBits) : null) ?? WAD;
  return { m: cm, ref: marketRef(pk(cm.market), decodeMarket(marketInfo.data)), multiplier, freeze: Number(cm.params.freezeSecs) };
}

/** The next bell still taking orders, of one kind or either. */
function nextBell(now: number, freeze: number, kind?: BellKind): { day: number; kind: BellKind; ts: number } {
  let best: { day: number; kind: BellKind; ts: number } | null = null;
  for (const k of kind ? [kind] : (['open', 'close'] as const)) {
    for (let d = etDay(now); d < etDay(now) + 12; d++) {
      const ts = bellTs(d, k);
      if (ts !== null && ts - freeze > now) {
        if (!best || ts < best.ts) best = { day: d, kind: k, ts };
        break;
      }
    }
  }
  if (!best) throw new Error('no bell in the next twelve days');
  return best;
}

const shown = (raw: bigint, m: bigint) => Number((raw * m) / WAD) / 1e8;
const toRaw = (tokens: number, m: bigint) => (BigInt(Math.floor(tokens * 1e8)) * WAD) / m;

async function crossesOf(market: PublicKey): Promise<{ address: PublicKey; c: CrossAccount }[]> {
  const accts = await conn.getProgramAccounts(CROSS_PROGRAM_ID, {
    filters: [discFilter(CROSS_ACCOUNT.Cross), { memcmp: { offset: OFFSETS.crossMarket, bytes: market.toBase58() } }],
  });
  return accts.map((a) => ({ address: a.pubkey, c: decodeCross(a.account.data) })).sort((a, b) => a.c.bellTs - b.c.bellTs);
}

async function lastPrint(listing: string) {
  const accts = await conn.getProgramAccounts(BELL_PROGRAM_ID, {
    filters: [discFilter(BELL_ACCOUNT.Print), { memcmp: { offset: PRINT_LISTING_OFFSET, bytes: listing } }],
  });
  const finals = accts.map((a) => decodePrint(a.account.data)).filter((p) => p.status === 'final' && p.equity.present);
  finals.sort((a, b) => b.bellTs - a.bellTs);
  return finals[0] ?? null;
}

async function jupiterNow(inputMint: string, outputMint: string, amount: bigint): Promise<SwapQuote> {
  const r = await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50&swapMode=ExactIn`,
    { signal: AbortSignal.timeout(10_000) });
  const j = (await r.json().catch(() => ({}))) as { inAmount?: string; outAmount?: string; priceImpactPct?: string; error?: string; routePlan?: { swapInfo?: { label?: string } }[] };
  if (!r.ok || !j.inAmount || !j.outAmount) return { noRoute: String(j.error ?? `HTTP ${r.status}`).slice(0, 120) };
  return { in: j.inAmount, out: j.outAmount, impactPct: Number(j.priceImpactPct ?? 0), route: (j.routePlan ?? []).map((p) => p.swapInfo?.label ?? '?').join(' > ') };
}

const HONEST = 'Devnet: a fixture NVDAx and prints from a test signer (Jupiter\'s reference price, not Pyth). The mechanics are the real program\'s.';

server.registerTool('bell_status', {
  title: 'The next bells',
  description:
    'The next NYSE open and close that bell orders can still join, the book of each (buyers in dollars, '
    + 'sellers in NVDAx, when it freezes), the last print, and the latest crosses that cleared with a link '
    + 'to each receipt. Read-only.',
}, async () => {
  const { m, ref, multiplier, freeze } = await bellMarket();
  const now = Math.floor(Date.now() / 1000);
  const [crosses, print] = await Promise.all([crossesOf(ref.market), lastPrint(m.listing)]);
  const next = (['open', 'close'] as const).map((k) => {
    const b = nextBell(now, freeze, k);
    const found = crosses.find((x) => x.c.day === b.day && x.c.kind === k);
    return {
      kind: k, bell: iso(b.ts), freezesAt: iso(b.ts - freeze), freezesInSecs: b.ts - freeze - now,
      cross: crossPda(ref.market, b.day, k).toBase58(),
      book: found
        ? { phase: found.c.phase, orders: found.c.nOrders, buyersUsd: Number(found.c.buyTotal) / 1e6, sellersNvdax: shown(found.c.sellTotal, multiplier) }
        : { phase: 'empty', orders: 0, buyersUsd: 0, sellersNvdax: 0 },
    };
  }).sort((a, b) => a.bell.localeCompare(b.bell));
  const recent = crosses.filter((x) => x.c.phase === 'settling' || x.c.phase === 'cancelled').slice(-3).reverse().map(({ address, c }) => ({
    kind: c.kind, bell: iso(c.bellTs), cross: address.toBase58(), phase: c.phase,
    price: c.phase === 'settling' ? Number(decimalPrice(c.priceMantissa, c.priceExpo)) : null,
    crowded: c.clearing.crowded, feeBps: c.clearing.feeBps, orders: c.nOrders, receipt: receiptUrl(address),
  }));
  return json({
    market: m.market, symbol: 'NVDA', token: 'NVDAx', multiplier: Number(multiplier) / 1e18,
    lastPrint: print ? { price: Number(decimalPrice(print.equity.price, print.equity.expo)), kind: print.kind, bell: iso(print.bellTs), simulated: print.simulated } : null,
    next, recent, feeCapBps: m.backstop.feeBps, note: HONEST,
  });
});

const sideSchema = z.enum(['buy', 'sell']).describe('buy NVDAx with dollars, or sell NVDAx for dollars');
const amountSchema = z.number().positive().describe('dollars to spend on a buy, or NVDAx (as a wallet shows it) to sell');
const kindSchema = z.enum(['next', 'open', 'close']).default('next').describe('which bell: the next of either, or the next open or close');

server.registerTool('bell_quote', {
  title: 'Quote a bell order against a swap now',
  description:
    'What a bell order would get at the last print, what it costs at most, and what the same trade gets '
    + 'on Jupiter right now for the real NVDAx on mainnet: at the bell against now. Read-only; nothing is '
    + 'signed.',
  inputSchema: { side: sideSchema, amount: amountSchema, kind: kindSchema },
}, async ({ side, amount, kind }) => {
  const { m, multiplier, freeze } = await bellMarket();
  const now = Math.floor(Date.now() / 1000);
  const b = nextBell(now, freeze, kind === 'next' ? undefined : kind);
  const print = await lastPrint(m.listing);
  const perShare = print ? Number(decimalPrice(print.equity.price, print.equity.expo)) : null;
  const perRaw = perShare !== null ? perShare * (Number(multiplier) / 1e18) : null;
  const atoms = side === 'buy' ? BigInt(Math.floor(amount * 1e6)) : toRaw(amount, multiplier);
  const swap = await jupiterNow(side === 'buy' ? MAINNET_USDC : m.realMint, side === 'buy' ? m.realMint : MAINNET_USDC, atoms)
    .catch((e): SwapQuote => ({ noRoute: `Jupiter did not answer: ${String(e).slice(0, 80)}` }));
  // at the last print, the cross gives out = in / price (buy) or in * price (sell), before any imbalance fee
  const bellOut = perRaw === null ? null : side === 'buy' ? BigInt(Math.floor((Number(atoms) / 1e6 / perRaw) * 1e8)) : BigInt(Math.floor((Number(atoms) / 1e8) * perRaw * 1e6));
  const edge = bellOut !== null && 'out' in swap ? edgeBps(atoms, bellOut, BigInt(swap.in), BigInt(swap.out)) : null;
  return json({
    bell: { kind: b.kind, at: iso(b.ts), cancelUntil: iso(b.ts - freeze) },
    order: side === 'buy' ? { spendUsd: amount } : { sellNvdax: amount, rawAtoms: atoms.toString() },
    atTheLastPrint: perShare === null ? 'no print yet: the order fills at whatever the bell prints' : {
      nvdaPerShare: perShare, lastPrintBell: iso(print!.bellTs),
      estimate: side === 'buy' ? { nvdax: shown(bellOut!, multiplier) } : { usd: Number(bellOut!) / 1e6 },
      worstFeeBps: m.backstop.feeBps,
      fee: `none on the part that nets against the other side; if yours is the larger side, makers fill the rest at a fee the backstop caps at ${m.backstop.feeBps} bp, on that part only`,
    },
    swapNow: 'noRoute' in swap ? { noRoute: swap.noRoute } : {
      venue: 'Jupiter, mainnet, the real NVDAx', out: side === 'buy' ? { nvdax: shown(BigInt(swap.out), multiplier) } : { usd: Number(swap.out) / 1e6 },
      route: swap.route, priceImpactPct: swap.impactPct * 100,
    },
    bellVersusSwapBps: edge,
    reading: edge === null ? null : `at the last print, before any imbalance fee, the bell gives ${Math.abs(edge).toFixed(2)} bp ${edge >= 0 ? 'more' : 'less'} per unit than swapping now. The bell prints its own price; this is an estimate.`,
    note: HONEST,
  });
});

server.registerTool('bell_place_order', {
  title: 'Place a bell order',
  description:
    'Escrow a buy or a sell in the next bell\'s cross; it fills at the bell\'s print with everyone else in it, '
    + 'and can be cancelled until two minutes before the bell. An optional limit refunds it whole if the print '
    + `breaks it. Writes. Capped at ${MAX_BELL_QUOTE} quote atoms a buy and ${MAX_BELL_RAW} raw NVDAx atoms a sell.`,
  inputSchema: {
    side: sideSchema, amount: amountSchema, kind: kindSchema,
    limit: z.number().positive().optional().describe('NVDA per share: a buy fills only at or under it, a sell only at or over'),
  },
}, async ({ side, amount, kind, limit }) => {
  const g = guardWrite();
  if (!g.ok) return text(`Refused: ${g.why}`);
  const { ref, multiplier, freeze } = await bellMarket();
  const atoms = side === 'buy' ? BigInt(Math.floor(amount * 1e6)) : toRaw(amount, multiplier);
  const cap = side === 'buy' ? MAX_BELL_QUOTE : MAX_BELL_RAW;
  if (atoms > cap) {
    return text(`Refused: ${atoms} ${side === 'buy' ? 'quote' : 'raw NVDAx'} atoms exceeds the ${cap} cap in ${side === 'buy' ? 'AGENT_MAX_BELL_QUOTE' : 'AGENT_MAX_BELL_RAW'}. `
      + 'The cap is enforced here rather than asked for in a prompt, which is the only place it holds.');
  }
  const now = Math.floor(Date.now() / 1000);
  const b = nextBell(now, freeze, kind === 'next' ? undefined : kind);
  const owner = g.payer.publicKey;
  const cross = crossPda(ref.market, b.day, b.kind);
  let nonce = Math.floor(Math.random() * 65_536);
  while (await conn.getAccountInfo(orderPda(cross, owner, nonce))) nonce = (nonce + 1) % 65_536;
  const limitE8 = limit ? BigInt(Math.round(limit * 1e8)) : 0n;
  try {
    const signature = await sendAndConfirmTransaction(conn, new Transaction().add(
      placeOrderIx(ref, { owner, day: b.day, kind: b.kind, nonce, side, amount: atoms, limitE8 }),
    ), [g.payer], { commitment: 'confirmed' });
    return json({
      order: orderPda(cross, owner, nonce).toBase58(), cross: cross.toBase58(), side, atoms: atoms.toString(), limitE8: limitE8.toString(),
      bell: { kind: b.kind, at: iso(b.ts), cancelUntil: iso(b.ts - freeze) },
      signature, receipt: receiptUrl(cross), note: HONEST,
    });
  } catch (e) {
    const err = e as { logs?: string[]; message?: string };
    return text(`The program refused it: ${explainProgramError(err.logs) ?? err.message ?? String(e)}`);
  }
});

server.registerTool('bell_cancel_order', {
  title: 'Cancel a bell order',
  description: 'Take back an order this key placed, and its escrow, before its cross freezes two minutes before the bell. Writes.',
  inputSchema: { order: z.string().describe('The order account, base58, as bell_place_order returned it') },
}, async ({ order }) => {
  const g = guardWrite();
  if (!g.ok) return text(`Refused: ${g.why}`);
  const { ref, freeze } = await bellMarket();
  const info = await conn.getAccountInfo(pk(order));
  if (!info || !info.owner.equals(CROSS_PROGRAM_ID)) return text('There is no open order at that address: it was cancelled or settled, or never existed.');
  const o = decodeOrder(info.data);
  if (!o.owner.equals(g.payer.publicKey)) return text(`Refused: that order belongs to ${o.owner.toBase58()}, not this key.`);
  const c = decodeCross((await conn.getAccountInfo(o.cross))!.data);
  if (c.phase !== 'collecting' || Date.now() / 1000 >= c.bellTs - freeze) {
    return text(`Too late: the cross froze at ${iso(c.bellTs - freeze)}. The order fills at the bell, or comes back whole if its limit is broken.`);
  }
  try {
    const signature = await sendAndConfirmTransaction(conn, new Transaction().add(
      cancelOrderIx(ref, { owner: g.payer.publicKey, day: c.day, kind: c.kind, nonce: o.nonce, side: o.side }),
    ), [g.payer], { commitment: 'confirmed' });
    return json({ cancelled: order, refunded: o.amount.toString(), side: o.side, signature });
  } catch (e) {
    const err = e as { logs?: string[]; message?: string };
    return text(`The program refused it: ${explainProgramError(err.logs) ?? err.message ?? String(e)}`);
  }
});

server.registerTool('bell_receipt', {
  title: 'A cross\'s receipt',
  description:
    'What a cross cleared at and why: the print, with its Ed25519 signature checked again here; what each side '
    + 'got and paid; the keeper\'s Jupiter quote for the same size at the bell beside it; and, for a wallet, each '
    + 'of its orders and what it was paid, from the program\'s own events. Defaults to the latest cross that '
    + 'finished, and to this key\'s wallet. Read-only, and slow: it reads the cross\'s history.',
  inputSchema: {
    cross: z.string().optional().describe('The cross account, base58. Omit for the latest that finished.'),
    wallet: z.string().optional().describe('Whose orders to list. Omit for this server\'s key.'),
  },
}, async ({ cross, wallet }) => {
  const { m, ref } = await bellMarket();
  let address: PublicKey;
  if (cross) address = pk(cross);
  else {
    const done = (await crossesOf(ref.market)).filter((x) => x.c.phase === 'settling' || x.c.phase === 'cancelled');
    if (!done.length) return text('No cross has finished yet. bell_status shows the next bells.');
    address = done[done.length - 1].address;
  }
  const info = await conn.getAccountInfo(address);
  if (!info || !info.owner.equals(CROSS_PROGRAM_ID)) return text('There is no open cross at that address. The keeper closes a cross a day after it clears; its history stays on chain.');
  const c = decodeCross(info.data);
  const printInfo = c.pricedAt ? await conn.getAccountInfo(c.print) : null;
  const print = printInfo ? decodePrint(printInfo.data) : null;
  const history = await conn.getSignaturesForAddress(address, { limit: 200 }).catch(() => null);
  const check = print ? await checkPrint(conn, c.print, print) : null;
  const cfRead = history ? await findCounterfactual(conn, address, c, history, m.keeper) : null;
  const who = wallet ? pk(wallet) : signer()?.publicKey ?? null;
  const mine = who && history ? await ordersFromHistory(conn, address, history, { owner: who, pauseMs: 300 }) : null;
  const mult = c.multiplierWad || WAD;
  const cl = c.clearing;
  const side = (s: 'buy' | 'sell') => {
    const [inA, outA] = s === 'buy' ? [cl.buySpent, cl.buyTokens] : [cl.sellSpent, cl.sellQuote];
    const q = cfRead && 'cf' in cfRead ? cfRead.cf[s] : undefined;
    return {
      put: s === 'buy' ? { usd: Number(inA) / 1e6 } : { nvdax: shown(inA, mult) },
      got: s === 'buy' ? { nvdax: shown(outA, mult) } : { usd: Number(outA) / 1e6 },
      swapAtTheBell: !q ? null : 'noRoute' in q ? { noRoute: q.noRoute } : {
        put: s === 'buy' ? { usd: Number(q.in) / 1e6 } : { nvdax: shown(BigInt(q.in), mult) },
        got: s === 'buy' ? { nvdax: shown(BigInt(q.out), mult) } : { usd: Number(q.out) / 1e6 },
        route: q.route, crossVersusSwapBps: edgeBps(inA, outA, BigInt(q.in), BigInt(q.out)),
      },
    };
  };
  return json({
    cross: address.toBase58(), kind: c.kind, bell: iso(c.bellTs), phase: c.phase, receipt: receiptUrl(address),
    price: c.pricedAt ? { nvdaPerShare: Number(decimalPrice(c.priceMantissa, c.priceExpo)), multiplier: Number(mult) / 1e18, simulated: c.simulated } : null,
    print: !check ? null : 'missing' in check ? { unavailable: check.why } : {
      signatureVerifiedHere: check.verifiedHere, ed25519Precompile: check.precompile, signedEqualsStored: check.matchesPrint,
      signer: check.signer, postedIn: check.signature,
    },
    clearing: c.phase !== 'settling' ? null : {
      crowded: cl.crowded, feeBps: cl.feeBps, buyers: side('buy'), sellers: side('sell'),
      orders: c.nOrders, settled: c.nSettled, escrowBalanced: c.quoteIn === c.quoteOut && c.rawIn === c.rawOut,
    },
    counterfactual: !cfRead ? 'the RPC would not serve the history' : 'cf' in cfRead ? { quotedAt: iso(cfRead.cf.at), in: cfRead.signature }
      : 'untrusted' in cfRead ? `a quote from ${cfRead.untrusted}, not the keeper: not shown` : cfRead.why ?? cfRead.missing,
    wallet: who?.toBase58() ?? null,
    yourOrders: !mine ? null : {
      complete: mine.complete,
      orders: mine.orders.map((o) => ({
        order: o.order, side: o.side, outcome: o.outcome, limitE8: o.limitE8.toString(),
        put: o.side === 'buy' ? { usd: Number(o.amount) / 1e6 } : { nvdax: shown(o.amount, mult) },
        paid: { usd: Number(o.quote) / 1e6, nvdax: shown(o.raw, mult) },
      })),
    },
    note: HONEST,
  });
});

await server.connect(new StdioServerTransport());
