/* ───────────────────────────────────────────────────────────────────────────
   A Solana Action: buy or sell NVDAx at the next NYSE bell, from a Blink.

     GET  /api/bell-action[?side=sell]      the card: what it does, when it fills
     POST /api/bell-action?side=buy&amount=25   { account }
                                            the place_order transaction, built
                                            now, for the wallet that clicked

   A Blink on X, or any Actions client, renders the GET and asks the wallet to
   sign what the POST returns. The transaction is the one /bells builds, with
   a fresh nonce: the order escrows into the next bell's cross and fills at
   its print, with everyone else in it. Nothing is signed here, and this
   function holds no key.

   A wallet that cannot pay is told so before it is asked to sign: the
   function reads the balance the order would draw on. Devnet: the token is a
   fixture NVDAx, the dollars are test USDC, and the prints come from a test
   signer. The card says so, and the faucet on /bells funds a wallet.
   ─────────────────────────────────────────────────────────────────────────── */
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { bellTs, etDay, type BellKind } from '../../sdk/src/bell.ts';
import { multiplierWad, readScaledUi, WAD } from '../../sdk/src/cross.ts';
import { ataOf, crossPda, decodeMarket, marketRef, orderPda, placeOrderIx } from '../../sdk/src/cross-ix.ts';
import { loadManifest, nodeHandler } from './_shared.ts';
import crossManifest from '../public/cross-devnet.json' with { type: 'json' };

const SITE = process.env.SESSION_SITE ?? 'https://session-roan.vercel.app';
/** Devnet's genesis hash, as the Actions spec names chains. */
const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
/** Per order through a Blink. Test money, but the sandbox's backstop is finite. */
const MAX_BUY_USD = 1_000;
const MAX_SELL_NVDAX = 5;

/** Every Actions response carries these; clients refuse one without them. */
const ACTION_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Accept-Action-Version, X-Accept-Blockchain-Ids',
  'access-control-expose-headers': 'X-Action-Version, X-Blockchain-Ids',
  'x-action-version': '2.4',
  'x-blockchain-ids': DEVNET,
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};
const reply = (body: unknown, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: ACTION_HEADERS });
const refuse = (message: string, status = 400) => reply({ message }, status);

const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const et = (ts: number) => `${etFmt.format(ts * 1000)} ET`;
const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** The next bell still taking orders. */
function nextBell(now: number, freeze: number): { day: number; kind: BellKind; ts: number } {
  let best: { day: number; kind: BellKind; ts: number } | null = null;
  for (const kind of ['open', 'close'] as const) {
    for (let d = etDay(now); d < etDay(now) + 12; d++) {
      const ts = bellTs(d, kind);
      if (ts !== null && ts - freeze > now) {
        if (!best || ts < best.ts) best = { day: d, kind, ts };
        break;
      }
    }
  }
  if (!best) throw new Error('no bell in the next twelve days');
  return best;
}

function card(side: 'buy' | 'sell') {
  const freeze = crossManifest.params.freezeSecs;
  const b = nextBell(Math.floor(Date.now() / 1000), freeze);
  const at = b.kind === 'open' ? 'open' : 'close';
  const href = (q: string) => `/api/bell-action?side=${side}&${q}`;
  const actions = side === 'buy'
    ? [
      { type: 'transaction', label: 'Buy $25', href: href('amount=25') },
      { type: 'transaction', label: 'Buy $100', href: href('amount=100') },
      {
        type: 'transaction', label: 'Buy', href: href('amount={amount}'),
        parameters: [{ type: 'number', name: 'amount', label: `Dollars, up to ${usd(MAX_BUY_USD)}`, required: true, min: 1, max: MAX_BUY_USD }],
      },
    ]
    : [
      { type: 'transaction', label: 'Sell 0.1', href: href('amount=0.1') },
      {
        type: 'transaction', label: 'Sell', href: href('amount={amount}'),
        parameters: [{ type: 'number', name: 'amount', label: `NVDAx, up to ${MAX_SELL_NVDAX}`, required: true, min: 0.01, max: MAX_SELL_NVDAX }],
      },
    ];
  return {
    type: 'action',
    icon: `${SITE}/bell.png`,
    title: `${side === 'buy' ? 'Buy' : 'Sell'} NVDAx at the NYSE ${at}`,
    description:
      `Fills at the ${et(b.ts)} print, the same price for everyone in it. Buyers and sellers net for free; `
      + `if one side is larger, makers fill the rest at a fee capped at ${crossManifest.backstop.feeBps} bp on that part. `
      + `Cancel on ${SITE.replace(/^https?:\/\//, '')}/bells until ${et(b.ts - freeze)}. `
      + 'Devnet: a fixture NVDAx, test USDC and prints from a test signer; the faucet on /bells funds a wallet.',
    label: side === 'buy' ? 'Buy at the bell' : 'Sell at the bell',
    links: { actions },
  };
}

async function transaction(req: Request, url: URL): Promise<Response> {
  const side = url.searchParams.get('side') === 'sell' ? 'sell' : 'buy';
  const amount = Number(url.searchParams.get('amount'));
  if (!Number.isFinite(amount) || amount <= 0) return refuse('Give an amount greater than zero.');
  if (side === 'buy' && (amount < 1 || amount > MAX_BUY_USD)) return refuse(`A buy here is between $1 and ${usd(MAX_BUY_USD)}.`);
  if (side === 'sell' && (amount < 0.01 || amount > MAX_SELL_NVDAX)) return refuse(`A sell here is between 0.01 and ${MAX_SELL_NVDAX} NVDAx.`);

  let owner: PublicKey;
  try {
    const body = await req.json() as { account?: string };
    owner = new PublicKey(String(body.account ?? ''));
  } catch {
    return refuse('Send { "account": "<your wallet address>" }.');
  }

  const conn = new Connection(process.env.DEVNET_RPC ?? loadManifest().rpc, 'confirmed');
  const market = new PublicKey(crossManifest.market);
  const mint = new PublicKey(crossManifest.mint);
  const [marketInfo, mintInfo] = await conn.getMultipleAccountsInfo([market, mint]);
  if (!marketInfo || !mintInfo) return refuse('The bell-order market is not on devnet right now.', 503);
  const ref = marketRef(market, decodeMarket(marketInfo.data));
  const now = Math.floor(Date.now() / 1000);
  const scaled = readScaledUi(mintInfo.data);
  const m = (scaled && scaled !== 'malformed' ? multiplierWad(now >= scaled.newEffectiveTs ? scaled.newBits : scaled.currentBits) : null) ?? WAD;
  // dollars to quote atoms; displayed NVDAx to raw atoms, as the program counts them
  const atoms = side === 'buy' ? BigInt(Math.floor(amount * 1e6)) : (BigInt(Math.floor(amount * 1e8)) * WAD) / m;

  // say so now, rather than hand the wallet a transaction that will fail
  const source = side === 'buy' ? ataOf(owner, ref.quoteMint, ref.quoteProgram) : ataOf(owner, ref.mint, ref.mintProgram);
  const held = await conn.getTokenAccountBalance(source).then((r) => BigInt(r.value.amount)).catch(() => 0n);
  if (held < atoms) {
    return refuse(`This wallet holds ${side === 'buy' ? `${usd(Number(held) / 1e6)} of test USDC` : `${(Number((held * m) / WAD) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 4 })} fixture NVDAx`}. Get test tokens from the faucet at ${SITE}/bells.`, 422);
  }

  const freeze = crossManifest.params.freezeSecs;
  const b = nextBell(now, freeze);
  const cross = crossPda(market, b.day, b.kind);
  let nonce = Math.floor(Math.random() * 65_536);
  for (let tries = 0; await conn.getAccountInfo(orderPda(cross, owner, nonce)); tries++) {
    if (tries > 8) return refuse('Could not find a free order slot; try again.', 503);
    nonce = Math.floor(Math.random() * 65_536);
  }
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: owner, blockhash, lastValidBlockHeight }).add(
    placeOrderIx(ref, { owner, day: b.day, kind: b.kind, nonce, side, amount: atoms, limitE8: 0n }),
  );
  const what = side === 'buy' ? `Buy ${usd(amount)} of NVDAx` : `Sell ${amount} NVDAx`;
  return reply({
    type: 'transaction',
    transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    message: `${what} at the ${b.kind}: it fills at the ${et(b.ts)} print. Cancel on /bells until ${et(b.ts - freeze)}.`,
    links: {
      next: {
        type: 'inline',
        action: {
          type: 'completed',
          icon: `${SITE}/bell.png`,
          title: `${what} at the ${b.kind}`,
          description: `In escrow until the ${et(b.ts)} print. The receipt, once it clears: ${SITE}/b/${cross.toBase58()}`,
          label: 'Order placed',
        },
      },
    },
  });
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return reply(null, 204);
  if (req.method === 'GET') return reply(card(url.searchParams.get('side') === 'sell' ? 'sell' : 'buy'));
  if (req.method === 'POST') {
    try {
      return await transaction(req, url);
    } catch (e) {
      return refuse(`Could not build the order: ${e instanceof Error ? e.message : String(e)}`, 500);
    }
  }
  return refuse('GET for the action, POST { account } for its transaction.', 405);
}

export default nodeHandler(handler);
