/* ───────────────────────────────────────────────────────────────────────────
   The recorded scenes, one continuous take each, against the live site.

     node demo/capture/scenes.mjs <scene> [<scene> ...]

   Scenes before the bell:
     connect   the wallet modal, the demo wallet, and the site's own faucet
     ticket    Ade's order: type $200, "Now, on Jupiter" beside "At the bell",
               place it, and see it in "Your orders"
     tour      the /bells page from the ticket down to "How a bell order fills"
     stills    4K stills of /bells, /oracle and the landing page
     blink     the bell-order Action, as Dialect's dial.to renders it
   Scenes after the bell:
     oracle    /oracle with today's prints
     receipt   the open cross's receipt, with Ade's own fill
     explorer  the print's transaction, and the price's memo, on the explorer

   The demo wallet is a devnet key kept in keeper/.devnet/demo-video-wallet.json
   (gitignored). Its order notes, which the page keeps in localStorage, are
   saved to demo/captures/notes.json between runs, so the receipt scene
   shows the same browser's view.
   ─────────────────────────────────────────────────────────────────────────── */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { injectWallet } from '../../web/scripts/lib/headless.mjs';
import { launch, OUT, ROOT } from './rig.mjs';

const SITE = process.env.SITE ?? 'https://session-roan.vercel.app';
const RPC = 'https://api.devnet.solana.com';
const KEY = join(ROOT, 'keeper/.devnet/demo-video-wallet.json');
const NOTES = join(OUT, 'notes.json');
const TICKET = 'section[aria-labelledby="ticket-h"]';

const wallet = (() => {
  if (existsSync(KEY)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEY, 'utf8'))));
  const k = Keypair.generate();
  writeFileSync(KEY, JSON.stringify([...k.secretKey]), { mode: 0o600 });
  return k;
})();
const NOTE_KEY = `session.bell-orders.v1.${wallet.publicKey.toBase58()}`;

async function open(path, { connectWallet = false, restoreNotes = true, ready } = {}) {
  const page = await launch({ inject: injectWallet(wallet, RPC, { name: 'Devnet demo wallet' }) });
  await page.navigate(`${SITE}${path}`);
  if (restoreNotes && existsSync(NOTES)) {
    await page.ev(`localStorage.setItem(${JSON.stringify(NOTE_KEY)}, ${JSON.stringify(readFileSync(NOTES, 'utf8'))})`);
    await page.navigate(`${SITE}${path}`);
  }
  if (ready) await page.until(() => page.ev(ready), 40000);
  if (connectWallet) await connect(page, { fast: true });
  return page;
}

async function connect(page, { fast = false } = {}) {
  await page.clickOn(`${TICKET} button`, { text: 'Connect wallet', ms: fast ? 300 : 800 });
  await page.until(() => page.ev(`[...document.querySelectorAll('[role="dialog"] button')].some(b => /Devnet demo wallet/.test(b.textContent))`), 10000);
  await page.sleep(fast ? 300 : 900);
  await page.clickOn('[role="dialog"] button', { text: 'Devnet demo wallet', ms: fast ? 300 : 700 });
  await page.until(() => page.ev(`[...document.querySelectorAll('${TICKET} button')].some(b => b.textContent.trim() === 'Place buy order')`), 20000);
}

const saveNotes = async (page) => {
  const notes = await page.ev(`localStorage.getItem(${JSON.stringify(NOTE_KEY)})`);
  if (notes) writeFileSync(NOTES, notes);
};

const BELLS_READY = `!!document.querySelector('#ticket-h') && /The book for the/.test(document.body.innerText)`;

const scenes = {
  async connect() {
    const page = await open('/bells', { ready: BELLS_READY });
    try {
      await page.mouse.park(1300, 820);
      await page.sleep(1200);
      const rec = await page.record('connect-faucet');
      await page.sleep(900);
      await connect(page);
      await page.sleep(1500);
      await page.clickOn(`${TICKET} button`, { text: 'Get test USDC' });
      const sent = await page.until(() => page.ev(`/Sent 10,000 test USDC/.test(document.body.innerText)`), 60000, 500);
      await page.sleep(3500);
      console.log('faucet:', sent ? 'sent' : 'not confirmed on screen');
      console.log(await rec.stop());
    } finally { page.close(); }
  },

  async ticket() {
    const page = await open('/bells', { ready: BELLS_READY, connectWallet: true });
    try {
      await page.until(() => page.ev(`/You hold \\$[1-9]/.test(document.querySelector('${TICKET}').innerText)`), 40000);
      await page.scrollTo(250, 10);
      await page.mouse.park(1350, 700);
      await page.sleep(1500);
      const rec = await page.record('ticket-order');
      await page.sleep(1000);
      await page.clickOn(`${TICKET} input`);
      await page.sleep(400);
      await page.typeText('200');
      await page.until(() => page.ev(`/≈ [0-9.,]+ NVDAx/.test(document.querySelector('${TICKET} dl').innerText)`), 15000);
      await page.sleep(900);
      const now = await page.locate(`${TICKET} dl > div`);
      await page.mouse.moveTo(now.x - 40, now.y, 900);
      await page.sleep(1800);
      const bell = await page.ev(`(() => { const r = document.querySelectorAll('${TICKET} dl > div')[1].getBoundingClientRect(); return { x: r.left + r.width / 2 - 30, y: r.top + r.height / 2 }; })()`);
      await page.mouse.moveTo(bell.x, bell.y, 800);
      await page.sleep(1800);
      await page.clickOn(`${TICKET} button`, { text: 'Place buy order', ms: 900 });
      const placed = await page.until(() => page.ev(`/Buy \\$200\\.00 at the (open|close)/.test(document.body.innerText)`), 60000, 400);
      await page.sleep(2600);
      const mine = await page.ev(`document.querySelector('section[aria-labelledby="mine-h"]').getBoundingClientRect().top + scrollY - 140`);
      await page.scrollTo(mine, 1400);
      await page.until(() => page.ev(`/Buy \\$200\\.00/.test(document.querySelector('section[aria-labelledby="mine-h"]').innerText)`), 30000, 500);
      await page.sleep(3000);
      console.log('placed:', placed);
      console.log(await rec.stop());
      await saveNotes(page);
    } finally { page.close(); }
  },

  async tour() {
    const page = await open('/bells', { ready: BELLS_READY, connectWallet: true });
    try {
      await page.mouse.park(1700, 600);
      await page.sleep(1500);
      const rec = await page.record('bells-tour');
      await page.sleep(1500);
      const H = await page.ev(`document.documentElement.scrollHeight - innerHeight`);
      for (const f of [0.28, 0.55, 0.8, 1]) { await page.scrollTo(Math.round(H * f), 2200); await page.sleep(1600); }
      await page.scrollTo(0, 2600);
      await page.sleep(1200);
      console.log(await rec.stop());
    } finally { page.close(); }
  },

  async stills() {
    for (const [name, path, ready] of [
      ['bells', '/bells', BELLS_READY],
      ['oracle', '/oracle', `/prints|Every print|The next bell/i.test(document.body.innerText) && !document.querySelector('[aria-busy="true"]')`],
      ['landing', '/', `!document.querySelector('main [aria-busy="true"]')`],
    ]) {
      const page = await open(path, { ready, connectWallet: name === 'bells' });
      try {
        await page.mouse.park(-50, -50);
        await page.sleep(2500);
        console.log(await page.still(`${name}-viewport`));
        console.log(await page.still(`${name}-full`, { fullPage: true }));
      } finally { page.close(); }
    }
  },

  async blink() {
    const url = `https://dial.to/?action=${encodeURIComponent(`solana-action:${SITE}/api/bell-action`)}&cluster=devnet`;
    const page = await launch({ inject: injectWallet(wallet, RPC, { name: 'Devnet demo wallet' }) });
    try {
      await page.navigate(url);
      await page.until(() => page.ev(`/Buy NVDAx at the NYSE/.test(document.body.innerText)`), 45000);
      await page.mouse.park(1400, 800);
      await page.sleep(3000);
      console.log(await page.still('blink-dialto'));
      const rec = await page.record('blink-card');
      await page.sleep(1200);
      const b = await page.locate('button', 'Buy $25');
      if (b) { await page.mouse.moveTo(b.x, b.y, 900); await page.sleep(1500); }
      await page.sleep(1500);
      console.log(await rec.stop());
    } finally { page.close(); }
  },

  async oracle() {
    const page = await open('/oracle', { ready: `/NVDA/.test(document.body.innerText) && !document.querySelector('[aria-busy="true"]')` });
    try {
      await page.mouse.park(1600, 700);
      await page.sleep(2000);
      const rec = await page.record('oracle-prints');
      await page.sleep(2500);
      const H = await page.ev(`document.documentElement.scrollHeight - innerHeight`);
      await page.scrollTo(Math.round(H * 0.45), 2400);
      await page.sleep(2500);
      await page.scrollTo(0, 2000);
      await page.sleep(1500);
      console.log(await rec.stop());
      console.log(await page.still('oracle-after-viewport'));
      console.log(await page.still('oracle-after-full', { fullPage: true }));
    } finally { page.close(); }
  },

  async receipt() {
    const cross = process.env.CROSS;
    if (!cross) throw new Error('CROSS=<address> of the cleared cross');
    const page = await open(`/b/${cross}`, { connectWallet: false, ready: `!!document.querySelector('#cross-h') && !document.querySelector('[aria-busy="true"]')` });
    try {
      // connect from the header, the way a returning visitor would
      await page.until(() => page.ev(`!!document.querySelector('#swap-h') || /Not everything could be read/.test(document.body.innerText)`), 60000, 800);
      await page.mouse.park(1500, 700);
      await page.sleep(2500);
      console.log(await page.still('receipt-viewport'));
      console.log(await page.still('receipt-full', { fullPage: true }));
      const rec = await page.record('receipt-tour');
      await page.sleep(2500);
      const H = await page.ev(`document.documentElement.scrollHeight - innerHeight`);
      for (const f of [0.3, 0.6, 1]) { await page.scrollTo(Math.round(H * f), 2400); await page.sleep(2200); }
      await page.scrollTo(0, 2400);
      await page.sleep(1500);
      console.log(await rec.stop());
    } finally { page.close(); }
  },

  async explorer() {
    const sigs = (process.env.SIGS ?? '').split(',').filter(Boolean);
    for (const [i, sig] of sigs.entries()) {
      const page = await launch({});
      try {
        await page.navigate(`https://explorer.solana.com/tx/${sig}?cluster=devnet`);
        await page.until(() => page.ev(`/Instruction|Program Instruction Logs|Overview/i.test(document.body.innerText) && !/Loading/i.test(document.title)`), 45000);
        await page.mouse.park(-50, -50);
        await page.sleep(4000);
        console.log(await page.still(`explorer-${i + 1}-viewport`));
        console.log(await page.still(`explorer-${i + 1}-full`, { fullPage: true }));
      } finally { page.close(); }
    }
  },
};

for (const name of process.argv.slice(2)) {
  if (!scenes[name]) throw new Error(`no scene ${name}: ${Object.keys(scenes).join(', ')}`);
  console.log(`── ${name}`);
  await scenes[name]();
}
process.exit(0);
