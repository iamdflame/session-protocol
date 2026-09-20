/* ───────────────────────────────────────────────────────────────────────────
   Asset metadata.

   `tags` do not create the factors — the factors are discovered from returns.
   Tags only let us put a human name on whatever the data turned out to be.

   `aliases` are how a sentence finds an asset.
   ─────────────────────────────────────────────────────────────────────────── */

export const META = {
  // ── private companies. These prices did not exist before 2025. ──────────
  OPENAI:    { co: 'OpenAI',        tags: ['private','ai','ai-lab'],             aliases: ['openai','gpt','chatgpt','sam altman','altman'] },
  ANTHROPIC: { co: 'Anthropic',     tags: ['private','ai','ai-lab'],             aliases: ['anthropic','claude'] },
  ANDURIL:   { co: 'Anduril',       tags: ['private','defense','robotics'],      aliases: ['anduril','palmer luckey'] },
  NEURALINK: { co: 'Neuralink',     tags: ['private','deeptech','robotics'],     aliases: ['neuralink','brain computer','bci'] },
  FIGUREAI:  { co: 'Figure AI',     tags: ['private','ai','robotics'],           aliases: ['figure','figure ai','humanoid'] },
  SPACEX:    { co: 'SpaceX',        tags: ['private','space','defense','deeptech'], aliases: ['spacex','starlink','starship','space x'] },

  // ── public equities ─────────────────────────────────────────────────────
  NVDAx:   { co: 'NVIDIA',        tags: ['ai','semis','bigtech'],        aliases: ['nvidia','nvda','jensen'] },
  AVGOx:   { co: 'Broadcom',      tags: ['ai','semis'],                  aliases: ['broadcom','avgo'] },
  INTCx:   { co: 'Intel',         tags: ['semis'],                       aliases: ['intel','intc'] },
  MSFTx:   { co: 'Microsoft',     tags: ['ai','bigtech'],                aliases: ['microsoft','msft','azure','copilot'] },
  GOOGLx:  { co: 'Alphabet',      tags: ['ai','bigtech'],                aliases: ['google','alphabet','googl','gemini','deepmind'] },
  METAx:   { co: 'Meta',          tags: ['ai','bigtech'],                aliases: ['meta','facebook','instagram','llama','zuckerberg'] },
  AMZNx:   { co: 'Amazon',        tags: ['ai','bigtech'],                aliases: ['amazon','amzn','aws'] },
  AAPLx:   { co: 'Apple',         tags: ['bigtech','consumer'],          aliases: ['apple','aapl','iphone','tim cook'] },
  TSLAx:   { co: 'Tesla',         tags: ['ai','robotics','consumer'],    aliases: ['tesla','tsla','robotaxi','musk','fsd','optimus'] },
  PLTRx:   { co: 'Palantir',      tags: ['ai','defense'],                aliases: ['palantir','pltr'] },
  COINx:   { co: 'Coinbase',      tags: ['crypto'],                      aliases: ['coinbase','coin'] },
  HOODx:   { co: 'Robinhood',     tags: ['crypto','consumer'],           aliases: ['robinhood','hood'] },
  MSTRx:   { co: 'MicroStrategy', tags: ['crypto'],                      aliases: ['microstrategy','mstr','saylor','bitcoin treasury'] },
  CRCLx:   { co: 'Circle',        tags: ['crypto'],                      aliases: ['circle','crcl','usdc','stablecoin'] },
  SPYx:    { co: 'S&P 500',       tags: ['index'],                       aliases: ['s&p','sp500','spy','the market','stocks','index'] },
  QQQx:    { co: 'Nasdaq 100',    tags: ['index','bigtech'],             aliases: ['nasdaq','qqq','tech index'] },
  TQQQx:   { co: 'Nasdaq 3x',     tags: ['index','bigtech'],             aliases: ['tqqq','leveraged nasdaq'] },
  GLDx:    { co: 'Gold',          tags: ['defensive','commodity'],       aliases: ['gold','gld','bullion'] },
  KOx:     { co: 'Coca-Cola',     tags: ['defensive','consumer'],        aliases: ['coca cola','coke','ko'] },
  MCDx:    { co: "McDonald's",    tags: ['defensive','consumer'],        aliases: ['mcdonalds','mcdonald','mcd'] },
  'BRK.Bx':{ co: 'Berkshire',     tags: ['defensive'],                   aliases: ['berkshire','buffett','brk'] },
  GMEx:    { co: 'GameStop',      tags: ['meme','consumer'],             aliases: ['gamestop','gme','meme stock'] },
  VIDAx:   { co: 'Vida Global',   tags: ['consumer'],                    aliases: ['vida'] },
};

/* Theme words in a sentence expand to a group of assets. */
export const THEME_WORDS = {
  ai:        ['ai','artificial intelligence','a.i.','llm','model','models','agi','inference','training'],
  'ai-lab':  ['ai lab','ai labs','frontier lab','frontier labs','foundation model'],
  semis:     ['semis','semiconductor','semiconductors','chip','chips','gpu','gpus','silicon','fab'],
  bigtech:   ['big tech','megacap','mega cap','hyperscaler','hyperscalers','faang'],
  private:   ['private','pre-ipo','pre ipo','startup','startups','unicorn','unicorns','venture'],
  crypto:    ['crypto','bitcoin','btc','ethereum','digital asset','digital assets','web3'],
  defense:   ['defense','defence','military','drone','drones','war','warfare'],
  robotics:  ['robot','robots','robotics','humanoid','humanoids','automation'],
  defensive: ['defensive','safe haven','flight to safety','staples','recession'],
  index:     ['the market','broad market','stocks in general','beta'],
  space:     ['space','satellite','satellites','orbit','rocket','rockets'],
  consumer:  ['consumer','retail spending','shopper','shoppers'],
};

/* Polarity lexicon. Weighted — "collapses" is a stronger signal than "soft". */
export const NEG = {
  bubble:1.0, crash:1.0, collapse:1.0, collapses:1.0, burst:1.0, bursts:1.0, pop:.8, pops:.8,
  short:1.0, overvalued:1.0, overpriced:.9, overhyped:.9, hype:.6, hyped:.7, froth:.9, frothy:.9,
  bearish:1.0, bear:.8, fall:.8, falls:.8, fails:.9, fail:.9, failing:.9, lose:.8, loses:.8,
  loser:.9, losers:.9, down:.6, drop:.7, drops:.7, decline:.7, declines:.7, disappoint:.8,
  disappoints:.8, disappointing:.8, weak:.6, weaker:.6, soft:.5, slow:.5, slows:.6, slowdown:.8,
  peak:.7, peaked:.8, peaking:.8, unsustainable:.9, dead:.9, dying:.8, obsolete:.9, doomed:1.0,
  commoditized:.8, commoditised:.8, crowded:.6, expensive:.7, correction:.8, unwind:.8, dump:.8,
  'too far':.7, 'ahead of itself':.8, 'priced in':.6, never:.7, wont:.7, "won't":.7,
  done:.8, finished:.9, cooked:.9, toast:.9, behind:.7, lagging:.8, lags:.8, stalls:.8,
  stalling:.8, 'further away':.9, 'further off':.9, 'longer than':.7, 'harder than':.7,
  overrated:.9, 'runs out':.8, fades:.7, fade:.7,
};
export const POS = {
  moon:1.0, soar:1.0, soars:1.0, surge:.9, surges:.9, rally:.8, rallies:.8, boom:.9, booms:.9,
  bullish:1.0, bull:.8, long:.9, wins:1.0, win:.9, winner:1.0, winners:1.0, beats:1.0, beat:1.0,
  survives:.9, survive:.9, dominates:1.0, dominate:1.0, dominant:.9, leads:.8, lead:.7,
  undervalued:1.0, cheap:.8, underrated:.9, up:.6, rise:.7, rises:.7, grow:.7, grows:.7,
  growth:.6, explode:.9, explodes:.9, accelerate:.8, accelerates:.8, outperform:1.0,
  outperforms:1.0, breakout:.8, strong:.6, stronger:.7, real:.6, works:.7, compounding:.7,
  inevitable:.9, 'takes over':.9, 'run away':.8, 'pulls ahead':.9, oversold:.8,
  underpriced:1.0, mispriced:.7, 'keeps winning':1.0, 'just getting started':.9,
};

/* Words that split a sentence into OPPOSING clauses — the second side flips. */
export const CONTRAST = ['but','however','though','although','while','whereas','yet','instead of',
  'rather than','at the expense of','unlike','vs','vs.','versus','over','against',
  'beats','beat','eats','eat','kills','kill','replaces','replace','displaces','displace',
  'takes share from','wins against','ahead of','outruns','buries'];

/* Words that split a sentence into INDEPENDENT clauses — no flip, each judged
   on its own. Without this, "Apple is done and Nvidia keeps winning" reads as
   one clause and both names inherit the same sign. */
export const SEPARATOR = ['and',',',';','.','also','plus','meanwhile'];

/* Intensity multipliers. */
export const BOOST = { massively:1.5, hugely:1.4, completely:1.4, totally:1.4, utterly:1.5,
  very:1.2, really:1.2, way:1.3, far:1.3, much:1.2, slightly:.6, somewhat:.7, a_bit:.6, mildly:.6 };
