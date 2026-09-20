/* ───────────────────────────────────────────────────────────────────────────
   Prism — the optical bench.

   Everything drawn here is a number from engine.js. Band thickness is variance
   share. The ribbon that fans widest is the bet you were making without
   meaning to.
   ─────────────────────────────────────────────────────────────────────────── */

import { buildReturns, buildFactors, refract, project, evidence } from './engine.js';
import { parseBelief, toWeights, parseBeliefLLM } from './belief.js';
import { META } from './meta.js';

const $ = s => document.querySelector(s);
const SVGNS = 'http://www.w3.org/2000/svg';
const FACTOR_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)'];
const YOURS = 'var(--yours)';

const EXAMPLES = [
  'Robotaxis are further away than the market thinks',
  'AI is a bubble but Anthropic survives it',
  'Private AI labs eat big tech',
  'The defense buildout is real and underpriced',
  'OpenAI beats Google',
  'Apple is done and Nvidia keeps winning',
];

const S = {
  model: null, fm: null, symbols: [],
  legs: [], w0: null, wNow: null,
  stripped: new Set(),
  bands: [], yours: 0,
  anim: [], target: [],
  raf: 0,
};

/* ── boot ───────────────────────────────────────────────────────────────── */

(async function boot() {
  $('#themer').onclick = () => {
    const now = document.documentElement.getAttribute('data-theme');
    const dark = now ? now === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
  };

  $('#chips').innerHTML = '';
  for (const e of EXAMPLES) {
    const b = document.createElement('button');
    b.className = 'chip'; b.type = 'button'; b.textContent = e;
    b.onclick = () => { $('#belief').value = e; run(); };
    $('#chips').appendChild(b);
  }

  let data;
  try {
    data = await (await fetch('../data/universe.json')).json();
  } catch {
    try { data = await (await fetch('./data/universe.json')).json(); }
    catch { $('#vsay').textContent = 'Could not load the universe snapshot.'; return; }
  }

  S.model = buildReturns(data.assets);
  S.fm = buildFactors(S.model, 5);
  S.symbols = S.model.assets.map(a => a.symbol);

  const priv = S.model.assets.filter(a => a.kind === 'private').length;
  $('#foot').innerHTML =
    `<strong>${S.model.assets.length} tokenized companies</strong> — ${priv} private ` +
    `(PreStocks) and ${S.model.assets.length - priv} public (xStocks) — over ` +
    `<strong>${S.model.T} trading days</strong> of real daily closes from their deepest Solana pools. ` +
    `Factors are principal components of the return correlation matrix, named by matching ` +
    `their loadings against sector membership. Refraction projects your weights onto the ` +
    `null space of the loadings you strip: <code>w ← w − Σ(v·w)v</code>, re-clipped for ` +
    `tradeability. Prices via Jupiter, history via GeckoTerminal. ` +
    `Snapshot ${new Date(data.generated).toISOString().slice(0, 10)}. ` +
    `Research tool, not investment advice.`;

  $('#go').onclick = run;
  $('#quote').onclick = runQuotes;
  $('#belief').addEventListener('keydown', e => { if (e.key === 'Enter') run(); });

  $('#belief').value = EXAMPLES[0];
  run();
})();

/* ── pipeline ───────────────────────────────────────────────────────────── */

async function run() {
  const text = $('#belief').value.trim();
  if (!text) return;

  let parsed = parseBelief(text, S.symbols);
  const key = localStorage.getItem('prism_key');
  if (key) {
    try { parsed = await parseBeliefLLM(text, S.symbols, key); } catch {}
  }

  if (!parsed.matched || !parsed.legs.length) {
    $('#vsay').textContent = 'No companies or themes recognised in that sentence.';
    $('#vsub').textContent = 'Name a company (OpenAI, NVIDIA, Tesla…) or a theme (AI, semis, defense, crypto, private markets).';
    $('#bignum').textContent = '—';
    S.bands = []; S.legs = []; paint();
    return;
  }

  S.legs = parsed.legs;
  S.w0 = toWeights(parsed.legs, S.symbols);
  S.stripped = new Set();
  recompute(true);
}

function recompute(reset = false) {
  const strip = [...S.stripped];
  S.wNow = strip.length ? project(S.w0, S.fm, strip) : S.w0.slice();
  const r = refract(S.wNow, S.model, S.fm);

  // a stripped band's residue is folded away from the readout entirely
  S.bands = r.bands.map((b, i) => ({ ...b, idx: i, off: S.stripped.has(i) }));
  S.yours = r.yours;

  const live = S.bands.filter(b => !b.off);
  const denom = live.reduce((s, b) => s + b.share, 0) + S.yours || 1;
  S.target = [...live.map(b => b.share / denom), S.yours / denom];
  S.shown = [...live, { name: 'Your actual idea', blurb: 'the part nothing else explains', yours: true }];
  S.yoursShare = S.yours / denom;

  if (reset || S.anim.length !== S.target.length) S.anim = S.target.map(() => 0);
  animate();
  paintBooks();
}

/* ── animation ──────────────────────────────────────────────────────────── */

function animate() {
  cancelAnimationFrame(S.raf);
  const step = () => {
    let moving = false;
    for (let i = 0; i < S.target.length; i++) {
      const d = S.target[i] - S.anim[i];
      if (Math.abs(d) > 1e-4) { S.anim[i] += d * 0.18; moving = true; }
      else S.anim[i] = S.target[i];
    }
    paint();
    if (moving) S.raf = requestAnimationFrame(step);
  };
  S.raf = requestAnimationFrame(step);
}

/* ── the optical bench ──────────────────────────────────────────────────── */

const EX = 372, EY = 262;             // where the beam leaves the prism
const SX = 640, ST = 34, SH = 428;    // the screen
const LX = 690, LW = 380;             // label column

function el(tag, attrs, parent) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

function paint() {
  const svg = $('#optics');
  svg.innerHTML = '<title id="opticsTitle">Your belief split into the factors it is exposed to</title>';
  if (!S.shown || !S.shown.length) { paintMobile(); return; }

  const n = S.shown.length;
  const colorOf = (b, i) => b.yours ? YOURS : FACTOR_COLORS[b.idx % FACTOR_COLORS.length];

  /* incoming beam */
  el('line', { x1: 24, y1: EY, x2: 286, y2: EY, stroke: 'var(--beam)', 'stroke-width': 2.2,
               'stroke-linecap': 'round', opacity: .9 }, svg);
  el('line', { x1: 24, y1: EY, x2: 286, y2: EY, stroke: 'var(--beam)', 'stroke-width': 4,
               'stroke-linecap': 'round', opacity: .35, class: 'beamflow',
               'stroke-dasharray': '10 26' }, svg);
  const t1 = el('text', { x: 24, y: EY - 16, fill: 'var(--ink-3)', 'font-size': 12.5,
                          'font-family': 'Inter, sans-serif', 'letter-spacing': '.08em' }, svg);
  t1.textContent = 'YOUR BELIEF';

  /* the prism */
  const defs = el('defs', {}, svg);
  const lg = el('linearGradient', { id: 'gGlass', x1: 0, y1: 0, x2: 1, y2: 1 }, defs);
  el('stop', { offset: '0%', 'stop-color': 'var(--beam)', 'stop-opacity': .12 }, lg);
  el('stop', { offset: '100%', 'stop-color': 'var(--beam)', 'stop-opacity': 0 }, lg);
  const PRISM = 'M330 172 L416 344 L244 344 Z';
  el('path', { d: PRISM, fill: 'var(--glass)', stroke: 'var(--line-2)',
               'stroke-width': 1.4, 'stroke-linejoin': 'round' }, svg);
  el('path', { d: PRISM, fill: 'url(#gGlass)', 'stroke-linejoin': 'round' }, svg);

  /* ribbons + screen segments + callouts */
  let y = ST;
  const rowH = SH / n;

  S.shown.forEach((b, i) => {
    const h = Math.max(S.anim[i] * SH, 0);
    const y0 = y, y1 = y + h;
    y = y1 + 2;                                    // 2px surface gap between segments
    const c = colorOf(b, i);
    const mid = (y0 + y1) / 2;
    const ry = ST + rowH * i + rowH / 2;           // label row centre (fixed)

    if (h > 0.4) {
      el('path', {
        d: `M${EX},${EY} C${EX + 130},${EY} ${SX - 170},${y0} ${SX},${y0} ` +
           `L${SX},${y1} C${SX - 170},${y1} ${EX + 130},${EY} ${EX},${EY} Z`,
        fill: c, opacity: b.yours ? .5 : .32,
      }, svg);
      el('rect', { x: SX, y: y0, width: 13, height: h, fill: c, rx: 3 }, svg);
      el('path', { d: `M${SX + 15},${mid} C${SX + 40},${mid} ${LX - 34},${ry} ${LX - 10},${ry}`,
                   fill: 'none', stroke: c, 'stroke-width': 1.3, opacity: .55 }, svg);
    }

    /* label row */
    const g = el('g', { class: 'stripbtn', role: 'button', tabindex: 0,
                        'data-band': b.yours ? 'yours' : b.idx,
                        'aria-label': `${b.name}, ${(S.anim[i] * 100).toFixed(1)} percent` +
                                      (b.yours ? '' : '. Activate to strip this factor.') }, svg);
    el('rect', { x: LX - 8, y: ry - rowH / 2 + 3, width: LW, height: rowH - 6,
                 fill: 'transparent', rx: 8 }, g);
    el('rect', { x: LX, y: ry - 7, width: 11, height: 11, fill: c, rx: 3 }, g);

    const nm = el('text', { x: LX + 22, y: ry + 1, fill: 'var(--ink)', 'font-size': 15,
                            'font-family': 'Inter, sans-serif',
                            'font-weight': b.yours ? 600 : 500 }, g);
    nm.textContent = b.yours ? 'Your actual idea' : b.name;

    const bl = el('text', { x: LX + 22, y: ry + 19, fill: 'var(--ink-3)', 'font-size': 11.5,
                            'font-family': 'Inter, sans-serif' }, g);
    bl.textContent = b.yours ? 'the part nothing else explains'
                             : (b.blurb + '  ·  click to strip');

    const pc = el('text', { x: LX + LW - 20, y: ry + 5, fill: b.yours ? YOURS : 'var(--ink)',
                            'font-size': 21, 'text-anchor': 'end', 'font-weight': b.yours ? 700 : 500,
                            'font-family': '"JetBrains Mono", monospace' }, g);
    pc.textContent = (S.anim[i] * 100).toFixed(1) + '%';

    if (!b.yours) {
      g.style.cursor = 'pointer';
      const strip = () => { hideTip(); S.stripped.add(b.idx); recompute(); };
      g.onclick = strip;
      g.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); strip(); } };
      g.onmouseenter = e => showTip(e, b);
      g.onmousemove = e => moveTip(e);
      g.onmouseleave = hideTip;
      g.onfocus = e => showTip(e, b);
      g.onblur = hideTip;
    } else {
      g.onmouseenter = e => showTip(e, b);
      g.onmousemove = e => moveTip(e);
      g.onmouseleave = hideTip;
    }
  });

  /* stripped factors, parked below the bench */
  const off = S.bands.filter(b => b.off);
  if (off.length) {
    const gy = 500;
    const lab = el('text', { x: 24, y: gy, fill: 'var(--ink-3)', 'font-size': 11.5,
                             'font-family': 'Inter, sans-serif', 'letter-spacing': '.06em' }, svg);
    lab.textContent = 'STRIPPED';
    let x = 108;
    off.forEach(b => {
      const g = el('g', { class: 'stripbtn', role: 'button', tabindex: 0,
                          'aria-label': `${b.name} stripped. Activate to restore.` }, svg);
      g.style.cursor = 'pointer';
      const w = Math.max(96, b.name.length * 7.0 + 44);
      el('rect', { x, y: gy - 14, width: w, height: 21, rx: 10, fill: 'transparent',
                   stroke: 'var(--line-2)', 'stroke-width': 1 }, g);
      el('rect', { x: x + 10, y: gy - 8, width: 8, height: 8, rx: 2,
                   fill: FACTOR_COLORS[b.idx % FACTOR_COLORS.length], opacity: .45 }, g);
      const tx = el('text', { x: x + 24, y: gy + 1, fill: 'var(--ink-3)', 'font-size': 12,
                              'font-family': 'Inter, sans-serif' }, g);
      tx.textContent = b.name + '  ↺';
      const restore = () => { S.stripped.delete(b.idx); recompute(); };
      g.onclick = restore;
      g.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); restore(); } };
      x += w + 8;
    });
  }

  paintVerdict();
  paintMobile();
}

function paintVerdict() {
  // ride the eased value so the headline counts up with the bands
  const pct = (S.anim[S.anim.length - 1] ?? S.yoursShare) * 100;
  $('#bignum').textContent = pct.toFixed(1) + '%';

  const live = S.shown.slice(0, -1);
  const topIdx = live.reduce((best, b, i) => (S.anim[i] > S.anim[best] ? i : best), 0);
  const top = live[topIdx];
  const nStripped = S.stripped.size;

  if (!nStripped) {
    $('#vsay').textContent = top
      ? `${(100 - pct).toFixed(0)}% of this trade isn't your idea.`
      : 'This position is almost purely your idea.';
    $('#vsub').textContent = top
      ? `Its biggest single exposure is ${top.name.toLowerCase()} — ` +
        `${(S.anim[topIdx] * 100).toFixed(1)}% of the risk you'd be taking. ` +
        `Strip the bands you didn't mean to bet on.`
      : '';
  } else {
    $('#vsay').textContent = pct > 70
      ? 'Now you own your idea, not the market.'
      : 'Getting purer. Strip more.';
    $('#vsub').textContent =
      `${nStripped} factor${nStripped > 1 ? 's' : ''} projected out. ` +
      `The position below re-points the same money at the same belief, with the ` +
      `bets you never meant to make removed.`;
  }
}

function paintMobile() {
  const host = $('#mstack');
  if (!S.shown || !S.shown.length) { host.innerHTML = ''; return; }
  const bar = S.shown.map((b, i) =>
    `<div class="mseg" style="flex-grow:${Math.max(S.anim[i], .004)};background:${
      b.yours ? YOURS : FACTOR_COLORS[b.idx % FACTOR_COLORS.length]}"></div>`).join('');
  const rows = S.shown.map((b, i) => `
    <div class="mrow" ${b.yours ? '' : `data-strip="${b.idx}" style="cursor:pointer"`}>
      <span class="msw" style="background:${b.yours ? YOURS : FACTOR_COLORS[b.idx % FACTOR_COLORS.length]}"></span>
      <span style="flex:1;${b.yours ? 'font-weight:600' : ''}">${b.yours ? 'Your actual idea' : b.name}</span>
      <span class="mono" style="${b.yours ? `color:${YOURS};font-weight:700` : ''}">${(S.anim[i] * 100).toFixed(1)}%</span>
    </div>`).join('');
  const off = S.bands.filter(b => b.off).map(b =>
    `<span class="pill" data-restore="${b.idx}" style="cursor:pointer">${b.name} ✕</span>`).join(' ');
  host.innerHTML = `<div class="mbar">${bar}</div>${rows}` +
    (off ? `<div style="margin-top:12px;font-size:11px;color:var(--ink-3)">STRIPPED — TAP TO RESTORE<br>${off}</div>` : '');
  host.querySelectorAll('[data-strip]').forEach(n =>
    n.onclick = () => { S.stripped.add(+n.dataset.strip); recompute(); });
  host.querySelectorAll('[data-restore]').forEach(n =>
    n.onclick = () => { S.stripped.delete(+n.dataset.restore); recompute(); });
}


/* ── hover layer ────────────────────────────────────────────────────────────
   A factor's name is an interpretation; its loadings are the fact. Hovering a
   band shows which companies actually drive it, so the label can be checked
   rather than trusted.                                                       */

let TIP = null;
function tipEl() {
  if (TIP) return TIP;
  TIP = document.createElement('div');
  TIP.className = 'tip';
  document.body.appendChild(TIP);
  return TIP;
}
function showTip(e, b) {
  const t = tipEl();
  if (b.yours) {
    t.innerHTML = `<div class="tiphead">Your actual idea</div>
      <div class="tipbody">The share of this position's variance that no factor above
      explains. In risk terms it is the idiosyncratic component — the only part that
      is a bet on the specific companies you named rather than on a pattern the whole
      market shares.</div>`;
  } else {
    const f = S.fm.factors[b.idx];
    const rank = f.loadings.map((v, i) => [S.symbols[i], v, S.model.assets[i]])
                           .sort((x, y) => y[1] - x[1]);
    const row = ([sym, v, a]) =>
      `<div class="tiprow"><span class="sym">${sym}</span>
       ${a.kind === 'private' ? '<span class="pill priv">priv</span>' : ''}
       <span class="tipv mono">${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}</span></div>`;
    t.innerHTML = `<div class="tiphead">${f.name}</div>
      <div class="tipbody">Principal component ${b.idx + 1} · explains
        ${(f.share * 100).toFixed(1)}% of variance across the whole universe.</div>
      <div class="tipcols">
        <div><div class="tipcap">moves up with</div>${rank.slice(0, 4).map(row).join('')}</div>
        <div><div class="tipcap">moves against</div>${rank.slice(-4).reverse().map(row).join('')}</div>
      </div>`;
  }
  t.style.display = 'block';
  moveTip(e);
}
function moveTip(e) {
  if (!TIP) return;
  const pad = 16, w = TIP.offsetWidth, h = TIP.offsetHeight;
  let x = e.clientX + pad, yy = e.clientY + pad;
  if (x + w > innerWidth - 8) x = e.clientX - w - pad;
  if (yy + h > innerHeight - 8) yy = e.clientY - h - pad;
  TIP.style.left = Math.max(8, x) + 'px';
  TIP.style.top = Math.max(8, yy) + 'px';
}
function hideTip() { if (TIP) TIP.style.display = 'none'; }

/* ── the two books ──────────────────────────────────────────────────────── */

function bookHTML(weights) {
  const rows = S.symbols
    .map((s, i) => ({ s, w: weights[i], a: S.model.assets[i] }))
    .filter(r => Math.abs(r.w) > 0.004)
    .sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  if (!rows.length) return '<p class="empty">Nothing left.</p>';
  const max = Math.max(...rows.map(r => Math.abs(r.w)));
  const SHOW = 9;
  const rest = rows.slice(SHOW);
  const restW = rest.reduce((s, r) => s + Math.abs(r.w), 0);
  const shown = rows.slice(0, SHOW);

  return `<table><thead><tr>
      <th>Company</th><th style="text-align:right">Side</th><th style="text-align:right">Weight</th>
    </tr></thead><tbody>` + shown.map(r => {
    const long = r.w > 0, pct = Math.abs(r.w) * 100;
    const col = long ? 'var(--long)' : 'var(--short)';
    return `<tr>
      <td><span class="sym">${r.s}</span>${r.a.kind === 'private'
        ? '<span class="pill priv">private</span>' : ''}
        <div class="co">${META[r.s]?.co ?? ''}</div></td>
      <td class="wt ${long ? 'dirL' : 'dirS'}">${long ? 'LONG' : 'SHORT'}</td>
      <td class="wt">${pct.toFixed(1)}%
        <div class="wbar" style="background:${col};width:${(Math.abs(r.w) / max) * 66}px;margin-left:auto"></div></td>
    </tr>`;
  }).join('') + (rest.length ? `<tr><td colspan="2" style="color:var(--ink-3)">
      + ${rest.length} smaller hedge leg${rest.length === 1 ? '' : 's'}</td>
      <td class="wt" style="color:var(--ink-3)">${(restW * 100).toFixed(1)}%</td></tr>` : '')
    + '</tbody></table>';
}

function paintBooks() {
  if (!S.w0) return;
  $('#book-naive').innerHTML = bookHTML(S.w0);
  $('#book-pure').innerHTML = bookHTML(S.wNow);
  const n = S.wNow.filter(x => Math.abs(x) > 0.004).length;
  $('#afternote').textContent = S.stripped.size
    ? `${n} legs · ${S.stripped.size} factor${S.stripped.size > 1 ? 's' : ''} removed`
    : 'strip a band to see this change';
  paintProof();
}

/* ── executability ──────────────────────────────────────────────────────────
   These pools are thin — a few hundred thousand dollars deep. A position that
   is elegant on paper and unfillable in practice is worth nothing, so we ask
   Jupiter what each leg would really cost right now.                         */

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

async function jupQuote(mint, usd) {
  const amount = Math.round(usd * 1e6);                 // USDC has 6 decimals
  const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${USDC}` +
              `&outputMint=${mint}&amount=${amount}&slippageBps=150`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

async function runQuotes() {
  const notional = Math.max(100, +$('#notional').value || 10000);
  const legs = S.symbols
    .map((s, i) => ({ s, w: S.wNow[i], a: S.model.assets[i] }))
    .filter(r => r.w > 0.004)
    .sort((a, b) => b.w - a.w);

  const shorts = S.wNow.filter(x => x < -0.004).length;
  if (!legs.length) { $('#exec').innerHTML = '<p class="empty">No long legs to quote.</p>'; return; }

  $('#exec').innerHTML = `<p class="empty">Quoting ${legs.length} legs on Jupiter…</p>`;
  const grossLong = legs.reduce((s, r) => s + r.w, 0);

  const rows = await Promise.all(legs.map(async r => {
    const usd = notional * (r.w / grossLong);
    try {
      const q = await jupQuote(r.a.mint, usd);
      const imp = Math.abs(+(q.priceImpactPct ?? 0)) * 100;
      const outTok = +q.outAmount / 10 ** r.a.decimals;
      return { ...r, usd, ok: true, imp, outTok, hops: q.routePlan?.length ?? 0 };
    } catch (e) { return { ...r, usd, ok: false, err: String(e.message || e) }; }
  }));

  const filled = rows.filter(r => r.ok);
  const wImp = filled.reduce((s, r) => s + r.imp * r.usd, 0) / (filled.reduce((s, r) => s + r.usd, 0) || 1);

  $('#exec').innerHTML = `<table><thead><tr>
      <th>Leg</th><th style="text-align:right">Size</th>
      <th style="text-align:right">Price impact</th><th style="text-align:right">Route</th>
    </tr></thead><tbody>` +
    rows.map(r => `<tr>
      <td><span class="sym">${r.s}</span>${r.a.kind === 'private' ? '<span class="pill priv">private</span>' : ''}
          <div class="co">${META[r.s]?.co ?? ''}</div></td>
      <td class="wt">$${r.usd.toFixed(0)}</td>
      <td class="wt" style="color:${!r.ok ? 'var(--short)' : r.imp > 1.5 ? 'var(--s2)' : 'var(--ink)'}">
        ${r.ok ? r.imp.toFixed(2) + '%' : 'no route'}</td>
      <td class="wt"><span class="co">${r.ok ? `${r.hops} hop${r.hops === 1 ? '' : 's'}` : r.err}</span></td>
    </tr>`).join('') +
    `</tbody></table>
     <div style="padding:13px 18px;border-top:1px solid var(--line);font-size:12.5px;color:var(--ink-2)">
       <strong class="mono">${wImp.toFixed(2)}%</strong> size-weighted price impact to fill
       $${notional.toLocaleString()} across ${filled.length}/${rows.length} legs, live, right now.
       ${shorts ? `The ${shorts === 1 ? 'one short leg is' : `${shorts} short legs are`} expressed as
       underweights — you sell what you hold rather than borrowing, so they need no venue at all.` : ''}
     </div>`;
}

/* The claim, made falsifiable: run both weight vectors over the real history
   and report how tied to the market each one actually was. */
function paintProof() {
  const a = evidence(S.w0, S.model), b = evidence(S.wNow, S.model);
  const f2 = x => (x >= 0 ? '' : '−') + Math.abs(x).toFixed(2);
  const cell = (lbl, from, to, note, good) => `
    <div class="pcell">
      <div class="plbl">${lbl}</div>
      <div class="pval">${(!from || from === to) ? '' :
        `<span class="pfrom">${from}</span><span class="parrow">→</span>`}
        <span class="pto ${good ? 'good' : ''}">${to}</span>
      </div>
      <div class="pnote">${note}</div>
    </div>`;

  const dropped = a.corr !== null && Math.abs(b.corr) < Math.abs(a.corr) - 0.05;
  $('#proof').innerHTML =
    (a.corr === null ? '' : cell(
      `Correlation to ${a.refSymbol}`, f2(a.corr), f2(b.corr),
      dropped ? 'the market is no longer driving this position'
              : 'strip market beta to cut this',
      dropped)) +
    cell('Annualised volatility',
      (a.vol * 100).toFixed(0) + '%', (b.vol * 100).toFixed(0) + '%',
      b.vol < a.vol ? 'less risk for the same opinion' : 'concentrated into the view', false) +
    cell('Positions held',
      String(S.w0.filter(x => Math.abs(x) > 0.004).length),
      String(S.wNow.filter(x => Math.abs(x) > 0.004).length),
      'every leg is a Jupiter swap — no borrow, no margin', false) +
    (() => {
      const inBook = S.symbols.filter((s, i) =>
        Math.abs(S.wNow[i]) > 0.004 && S.model.assets[i].kind === 'private').length;
      const total = S.model.assets.filter(a => a.kind === 'private').length;
      return cell('Private companies',
        '', inBook ? `${inBook} in book` : `${total} in universe`,
        inBook
          ? 'held in the same position as public stock — impossible at any broker'
          : 'priced live and holdable in the same order as public stock',
        inBook > 0);
    })();
}
