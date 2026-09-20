/* ───────────────────────────────────────────────────────────────────────────
   Belief → naive position.

   Turns an English sentence into the trade a normal person would actually put
   on. Deliberately naive: this is the "obvious" expression of the idea, the
   one that is mostly a bet on something else. Prism's whole point is to show
   you how little of it is your idea — so this step must be honest about being
   the dumb version.
   ─────────────────────────────────────────────────────────────────────────── */

import { META, THEME_WORDS, NEG, POS, CONTRAST, SEPARATOR, BOOST } from './meta.js';

/* Comparison idioms that contain market words but assert nothing about them.
   Without this, "further away than the market thinks" buys the S&P 500. */
const IDIOMS = [
  /\bthan (the market|people|everyone|wall street|consensus|anyone) (thinks|think|expects|expect|believes|believe)\b/g,
  /\bthan (expected|priced|consensus)\b/g,
  /\b(the market|wall street|everyone) (is wrong|has it wrong|doesn't get it|does not get it)\b/g,
];

const norm = s => {
  let t = ' ' + s.toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9&.,;\s'-]/g, ' ') + ' ';
  for (const re of IDIOMS) t = t.replace(re, ' ');
  return t.replace(/([.,;])/g, ' $1 ').replace(/\s+/g, ' ');
};

/* Longest-alias-first index so "openai" wins over "ai" inside "openai". */
function aliasIndex(symbols) {
  const idx = [];
  const add = (phrase, extra) => {
    const p = phrase.trim();
    if (p.length < 2) return;
    idx.push({ phrase: ' ' + p + ' ', ...extra });
    if (!/s$/.test(p)) idx.push({ phrase: ' ' + p + 's ', ...extra });   // robotaxi → robotaxis
  };
  for (const sym of symbols) {
    const m = META[sym];
    if (!m) continue;
    for (const a of [...m.aliases, m.co.toLowerCase(), sym.toLowerCase().replace(/x$/, '')])
      add(a, { sym, kind: 'asset' });
  }
  for (const [theme, words] of Object.entries(THEME_WORDS))
    for (const w of words) add(w, { theme, kind: 'theme' });
  return idx.sort((a, b) => b.phrase.length - a.phrase.length);
}

/* Two kinds of boundary:
     SEPARATOR — independent clauses, each judged on its own sign
     CONTRAST  — opposing clauses, where a clause with no sign of its own
                 inherits the opposite of the one before it                     */
function clauses(text) {
  const split = (parts, marks, flips) => {
    const sorted = marks.map(c => ` ${c} `).sort((a, b) => b.length - a.length);
    for (const m of sorted) {
      const next = [];
      for (const p of parts) {
        if (!p.text.includes(m)) { next.push(p); continue; }
        p.text.split(m).forEach((b, i) =>
          next.push({ text: ' ' + b.trim() + ' ', flip: flips ? (p.flip !== (i > 0)) : p.flip }));
      }
      parts = next;
    }
    return parts;
  };
  let parts = split([{ text, flip: false }], SEPARATOR, false);
  parts = split(parts, CONTRAST, true);
  return parts.filter(p => p.text.replace(/[.,;\s]/g, '').length > 1);
}

function polarity(clause) {
  const words = clause.trim().split(' ');
  let score = 0, hits = 0, boost = 1;
  for (const w of words) if (BOOST[w]) boost = Math.max(boost, BOOST[w]);

  for (const [lex, sign] of [[NEG, -1], [POS, +1]]) {
    for (const [k, v] of Object.entries(lex)) {
      if (!clause.includes(' ' + k + ' ') && !clause.includes(' ' + k)) continue;
      // crude negation: "not a bubble", "isn't overvalued"
      const i = clause.indexOf(k);
      const before = clause.slice(Math.max(0, i - 22), i);
      const negated = /\b(not|isn't|isnt|never|no|hardly|barely)\b/.test(before);
      score += (negated ? -sign : sign) * v;
      hits++;
    }
  }
  if (!hits) return { dir: 0, mag: 0 };
  return { dir: Math.sign(score) || 1, mag: Math.min(1, Math.abs(score) / 1.4) * boost };
}

/**
 * @returns {{legs: Array<{sym,dir,weight,why}>, note: string, matched: boolean}}
 */
export function parseBelief(text, symbols) {
  const t = norm(text);
  const idx = aliasIndex(symbols);
  const cls = clauses(t);

  // which asset/theme is mentioned in which clause
  const legs = new Map();           // sym -> {score, why[]}
  let anyMatch = false;

  cls.forEach((c, ci) => {
    let body = c.text;
    const pol = polarity(body);
    const hits = [];

    for (const e of idx) {
      if (!body.includes(e.phrase)) continue;
      body = body.split(e.phrase).join(' · ');     // consume so "ai" can't re-hit "openai"
      hits.push(e);
    }
    if (!hits.length) return;
    anyMatch = true;

    // A clause that states its own sign keeps it. Only a clause with no sign of
    // its own inherits the opposite of what it was contrasted against — which is
    // what makes "AI is a bubble BUT Anthropic survives it" come out long
    // Anthropic instead of short.
    const dir = pol.dir !== 0 ? pol.dir : (c.flip ? -1 : 1);
    const mag = 0.55 + 0.45 * (pol.mag || 0.5);

    for (const h of hits) {
      const targets = h.kind === 'asset'
        ? [h.sym]
        : symbols.filter(s => (META[s]?.tags || []).includes(h.theme));
      if (!targets.length) continue;
      // a named company is a sharper signal than a whole theme
      const per = (h.kind === 'asset' ? 1.0 : 0.72 / Math.sqrt(targets.length)) * mag;
      for (const s of targets) {
        const cur = legs.get(s) || { score: 0, why: [] };
        cur.score += dir * per;
        cur.why.push(h.kind === 'asset' ? 'named' : h.theme);
        legs.set(s, cur);
      }
    }
  });

  if (!anyMatch) return { legs: [], note: 'no companies or themes recognised', matched: false };

  const out = [...legs.entries()]
    .filter(([, v]) => Math.abs(v.score) > 0.08)
    .map(([sym, v]) => ({
      sym, dir: Math.sign(v.score), raw: Math.abs(v.score),
      why: [...new Set(v.why)].join(' + '),
    }))
    .sort((a, b) => b.raw - a.raw)
    .slice(0, 14);

  const tot = out.reduce((s, l) => s + l.raw, 0) || 1;
  for (const l of out) l.weight = l.dir * (l.raw / tot);

  return { legs: out, note: '', matched: true };
}

/** Naive weight vector over the full universe, in `symbols` order. */
export function toWeights(legs, symbols) {
  const w = new Array(symbols.length).fill(0);
  const pos = Object.fromEntries(symbols.map((s, i) => [s, i]));
  for (const l of legs) if (pos[l.sym] !== undefined) w[pos[l.sym]] = l.weight;
  const s = w.reduce((a, x) => a + Math.abs(x), 0) || 1;
  return w.map(x => x / s);
}

/* ── optional: let Claude do the reading when an API key is configured ──────
   The local parser above is the default and needs no network. This is a
   straight upgrade path, not a dependency.                                   */
export async function parseBeliefLLM(text, symbols, apiKey, model = 'claude-opus-5') {
  const menu = symbols.map(s => `${s} = ${META[s]?.co ?? s}`).join('\n');
  const body = {
    model, max_tokens: 900,
    system: 'You convert an investment belief into the naive long/short expression a retail trader would actually put on. Reply with JSON only.',
    messages: [{
      role: 'user',
      content: `Universe:\n${menu}\n\nBelief: "${text}"\n\n` +
        `Return {"legs":[{"sym":"<symbol>","dir":1|-1,"weight":<0..1>,"why":"<6 words>"}]}. ` +
        `Use 3-10 legs. dir=1 long, dir=-1 short. Weights are magnitudes summing to 1. Symbols must come from the universe.`,
    }],
  };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`claude ${r.status}`);
  const j = await r.json();
  const txt = j.content?.map(c => c.text).join('') ?? '';
  const parsed = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
  const legs = (parsed.legs || [])
    .filter(l => symbols.includes(l.sym))
    .map(l => ({ sym: l.sym, dir: l.dir < 0 ? -1 : 1, raw: Math.abs(+l.weight || 0.1), why: l.why || '' }));
  const tot = legs.reduce((s, l) => s + l.raw, 0) || 1;
  for (const l of legs) l.weight = l.dir * (l.raw / tot);
  return { legs, note: '', matched: legs.length > 0 };
}
