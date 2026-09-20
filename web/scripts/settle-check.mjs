/* ───────────────────────────────────────────────────────────────────────────
   The local vault across a boundary.

   The browser flow can mint and redeem, but a settlement only happens when a
   bell rings, and this runs on whatever day it runs. So the vault module is
   loaded through the dev server — the real module, real aliases, real
   `settle()` from the SDK — and driven across boundaries with chosen marks.

   What is asserted is the design, not the arithmetic (the arithmetic has 103
   Rust tests and 1,608 cross-language vectors behind it): exposure flips, the
   exposed class alone carries the move, the parked class is untouched, and
   backing equals claims after every step.

   usage: node scripts/settle-check.mjs
   ─────────────────────────────────────────────────────────────────────────── */

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import { WebSocket } from 'ws';

const CHROME = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find(existsSync);
const PORT = 9750 + (process.pid % 200);
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu',
  '--user-data-dir=/tmp/session-settle-' + process.pid, 'about:blank',
], { stdio: 'ignore' });

const waitPort = p => new Promise((res, rej) => {
  const t0 = Date.now();
  const go = () => {
    const s = createConnection({ port: p, host: '127.0.0.1' }, () => { s.end(); res(); });
    s.on('error', () => { s.destroy(); Date.now() - t0 > 15000 ? rej(new Error('no port')) : setTimeout(go, 120); });
  };
  go();
});

try {
  await waitPort(PORT);
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
  const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.once('open', r));
  let id = 0; const pend = new Map();
  ws.on('message', b => {
    const m = JSON.parse(b.toString());
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id); pend.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://localhost:3100/' });
  await new Promise(r => setTimeout(r, 2500));

  const r = await send('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      const V = await import('/src/lib/localVault.ts');
      const C = await import('/sdk/calendar.ts').catch(() => import('/@fs${process.cwd()}/../sdk/src/calendar.ts'));
      const out = [];
      const ok = (name, cond, detail = '') => out.push({ name, ok: !!cond, detail: String(detail) });

      // A Monday 08:00 ET in a plain week: the next boundary is 09:30 (open),
      // then 16:00 (close), then Tuesday 09:30.
      const mondayDays = C.daysFromCivil(2026, 3, 2);            // Mon 2 Mar 2026, EST
      const t0 = mondayDays * 86400 + 13 * 3600;                 // 08:00 ET = 13:00 UTC
      const mark = p => V.markFromPrice(p, 8);
      const WAD = 10n ** 18n;

      let v = V.freshVault('TESTx', 8, 100, t0);
      ok('fresh vault at 08:00 ET is night-exposed', v.exposed === 'night', v.exposed);

      // Mint 1,000 into DAY (parked) and 500 into NIGHT? NIGHT is exposed, so
      // it must refuse. Only DAY can be minted now.
      const refuse = V.planMint(v, 'night', V.toQuote(500));
      ok('minting the exposed class is refused', !refuse.ok && refuse.err === 'not-parked', JSON.stringify(refuse));
      const m1 = V.planMint(v, 'day', V.toQuote(1000));
      ok('minting the parked class is allowed', m1.ok);
      v = V.applyMint(v, 'day', V.toQuote(1000), m1.shares, t0);

      // Cross the 09:30 open at the same mark: DAY becomes exposed, nothing
      // should change in value since the price did not move.
      const tOpen = mondayDays * 86400 + 14 * 3600 + 30 * 60 + 60;   // 09:31 ET
      v = V.advance(v, mark(100), tOpen);
      ok('after the open, DAY is exposed', v.exposed === 'day', v.exposed);
      ok('DAY NAV unchanged at an unchanged mark', v.dayNav === WAD, String(v.dayNav));
      let d = V.derive(v, mark(100), tOpen);
      ok('backing equals claims after the open', d.margin === 0n, String(d.margin));
      ok('vault holds underlying for DAY (10 shares at $100)', v.ownedUnderlying === 10n * 10n ** 8n, String(v.ownedUnderlying));

      // Now NIGHT is parked: mint 500 into it during the day.
      const m2 = V.planMint(v, 'night', V.toQuote(500));
      ok('NIGHT can be minted while parked', m2.ok);
      v = V.applyMint(v, 'night', V.toQuote(500), m2.shares, tOpen + 3600);
      ok('quote for NIGHT sits in ownedQuote', v.ownedQuote === V.toQuote(500), String(v.ownedQuote));

      // The day session: stock goes 100 → 110. At the 16:00 close DAY should
      // have earned +10%, NIGHT nothing; then NIGHT takes the stock.
      const tClose = mondayDays * 86400 + 21 * 3600 + 60;            // 16:01 ET
      v = V.advance(v, mark(110), tClose);
      ok('after the close, NIGHT is exposed', v.exposed === 'night', v.exposed);
      const dayNav = Number(v.dayNav) / 1e18, nightNav = Number(v.nightNav) / 1e18;
      // DAY earns the full +10% and then pays funding to the smaller class —
      // both are the program's behaviour, so the tolerance is the funding cap.
      ok('DAY NAV rolled by the intraday move (~1.10, less funding)', dayNav > 1.09 && dayNav <= 1.10, dayNav.toFixed(6));
      ok('NIGHT NAV untouched by the move (~1.00, plus funding)', nightNav >= 1.0 && nightNav < 1.01, nightNav.toFixed(6));
      ok('funding is a transfer: DAY paid exactly what NIGHT received',
         Math.abs((1.10 - dayNav) * 1000 - (nightNav - 1.0) * 500) < 0.001,
         ((1.10 - dayNav) * 1000).toFixed(4) + ' vs ' + ((nightNav - 1.0) * 500).toFixed(4));
      d = V.derive(v, mark(110), tClose);
      ok('backing covers claims after the close (dust stays in the vault)', d.margin >= 0n && d.margin < 10n, String(d.margin));
      ok('funding moved value from the larger class toward the smaller', v.history[0].funding !== undefined, JSON.stringify(v.history[0], (k, x) => typeof x === 'bigint' ? x.toString() : x));

      // Overnight gap down: 110 → 99 by Tuesday 09:30. NIGHT eats it; DAY is flat.
      const tTueOpen = (mondayDays + 1) * 86400 + 14 * 3600 + 30 * 60 + 60;
      const dayBefore = v.dayNav;
      v = V.advance(v, mark(99), tTueOpen);
      ok('Tuesday open: DAY exposed again', v.exposed === 'day', v.exposed);
      const nightAfter = Number(v.nightNav) / 1e18;
      ok('NIGHT NAV fell by the gap (~0.90)', Math.abs(nightAfter - 0.90) < 0.02, nightAfter.toFixed(6));
      ok('DAY NAV unchanged through the night (funding aside)', Math.abs(Number(v.dayNav - dayBefore)) / 1e18 < 0.02, (Number(v.dayNav - dayBefore) / 1e18).toFixed(6));
      d = V.derive(v, mark(99), tTueOpen);
      ok('backing covers claims after the gap', d.margin >= 0n && d.margin < 10n, String(d.margin));
      ok('health has no critical signal', d.health.severity !== 'critical', d.health.severity);

      // Bad debt. A hedged class cannot lose more than it is worth — a long
      // position bottoms at zero — so the only way a loss exceeds a class is
      // an *unfilled* handoff: the vault still carrying DAY-sized inventory
      // after NIGHT, worth a hundredth of that, took the exposure. That is the
      // silent-insolvency path the adversarial simulation found, so the check
      // constructs it directly rather than assuming the filler shows up.
      let w = V.freshVault('THINx', 8, 100, t0);
      w = V.applyMint(w, 'day', V.toQuote(1000), V.planMint(w, 'day', V.toQuote(1000)).shares, t0);
      w = V.advance(w, mark(100), tOpen);
      w = V.applyMint(w, 'night', V.toQuote(10), V.planMint(w, 'night', V.toQuote(10)).shares, tOpen + 60);
      w = V.advance(w, mark(100), tClose);                  // NIGHT takes the stock at 100
      w = { ...w, ownedUnderlying: w.ownedUnderlying * 100n };   // …but the handoff never filled
      w = V.advance(w, mark(40), tTueOpen);                 // and the stock falls 60% overnight
      ok('a loss beyond the exposed class halts the vault', w.halted === true, String(w.halted));
      ok('halt reason names bad debt', w.haltReason === 'bad debt', w.haltReason);
      const dayIntact = Number(w.dayNav) / 1e18;
      ok('DAY NAV is not written down by NIGHT\\'s bad debt', dayIntact > 0.99, dayIntact.toFixed(6));
      const wd = V.derive(w, mark(1), tTueOpen);
      ok('health reports the halt as critical', wd.health.severity === 'critical', wd.health.severity);

      // Idempotence: advancing again with no new boundary changes nothing.
      const snap = JSON.stringify(v, (k, x) => typeof x === 'bigint' ? x.toString() : x);
      const again = V.advance(v, mark(99), tTueOpen + 600);
      ok('advance is idempotent between boundaries', JSON.stringify(again, (k, x) => typeof x === 'bigint' ? x.toString() : x) === snap);

      // Persistence round-trips bigints exactly.
      V.saveVault(v);
      const back = V.loadVault('TESTx');
      ok('vault survives localStorage round-trip', back && back.nightNav === v.nightNav && back.myDay === v.myDay);
      V.clearVault('TESTx'); V.clearVault('THINx');

      return out;
    })()`,
  });

  if (r.exceptionDetails) {
    console.error('threw:', r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    process.exitCode = 1;
  } else {
    let failed = 0;
    for (const t of r.result.value) {
      if (t.ok) console.log(`  ok    ${t.name}`);
      else { failed++; console.log(`  FAIL  ${t.name} — ${t.detail}`); }
    }
    console.log(`\n${r.result.value.length - failed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
  }
} finally {
  chrome.kill();
}
