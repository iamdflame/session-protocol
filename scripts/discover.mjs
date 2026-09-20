// Discover the real tokenized-equity universe on Solana: public (xStocks, mint "Xs")
// and private (PreStocks, mint "Pre"). Liquidity-filtered, deduped by company.
const JUP = 'https://lite-api.jup.ag/tokens/v2/search?query=';

const PUBLIC_Q = ['NVDA','AAPL','MSFT','GOOGL','AMZN','META','TSLA','AVGO','AMD','INTC',
  'MU','QCOM','ORCL','CRM','PLTR','NFLX','COIN','HOOD','MSTR','CRCL','SPY','QQQ','GLD',
  'JPM','V','MA','WMT','COST','KO','PEP','MCD','NKE','JNJ','LLY','UNH','PFE','MRK','ABBV',
  'XOM','CVX','BA','CAT','GE','HON','LIN','TMO','ABT','DHR','CSCO','IBM','UBER','SHOP',
  'BRK','DIS','T','VZ','GME','MRVL','TSM','ASML','ARM','SMCI','DELL','HPQ','NOW','ADBE',
  'PANW','SNOW','DDOG','NET','RBLX','SQ','PYPL','SOFI','RIVN','LCID','F','GM','NIO','BABA'];

const PRIVATE_Q = ['SpaceX','OpenAI','Anthropic','Anduril','Neuralink','Databricks',
  'Perplexity','xAI','Figure','Epic Games','Discord','Kraken','Stripe','Revolut','Canva',
  'Rippling','Scale AI','Groq','Cerebras','Starlink','Waymo','ByteDance','SSI','Mistral'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function jup(q) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(JUP + encodeURIComponent(q));
      if (r.ok) return await r.json();
    } catch {}
    await sleep(400 * (i + 1));
  }
  return [];
}

const found = new Map();
async function scan(queries, want, kind) {
  for (const q of queries) {
    const res = await jup(q);
    for (const t of res || []) {
      const mint = t.id || '';
      if (!mint.startsWith(want)) continue;
      const liq = t.liquidity || 0, px = t.usdPrice || 0;
      if (liq < 25000 || px <= 0) continue;
      if (found.has(mint)) continue;
      found.set(mint, {
        mint, symbol: t.symbol, name: t.name, kind,
        price: px, liquidity: Math.round(liq),
        holders: t.holderCount || 0, mcap: Math.round(t.mcap || 0),
        decimals: t.decimals,
      });
    }
    await sleep(120);
  }
}

await scan(PUBLIC_Q, 'Xs', 'public');
await scan(PRIVATE_Q, 'Pre', 'private');

const all = [...found.values()].sort((a, b) => b.liquidity - a.liquidity);
console.log(JSON.stringify(all, null, 1));
console.error(`\n[discover] public=${all.filter(a=>a.kind==='public').length} private=${all.filter(a=>a.kind==='private').length} total=${all.length}`);
