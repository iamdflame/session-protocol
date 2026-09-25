/* The YouTube thumbnail for the pitch video: 1280×720, rendered at 2× and
   scaled down, in the site's own type and colours. The print on it is the
   real one from the 25 Sep open, and it keeps its devnet label.

     node demo/thumbnail/make.mjs   → demo/thumbnail/thumbnail.jpg (+ .png at 2560×1440)
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { openChrome } from '../../web/scripts/lib/headless.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const FONTS = join(HERE, '../../web/public/fonts');
const font = (f) => `data:font/woff2;base64,${readFileSync(join(FONTS, f)).toString('base64')}`;
const live = JSON.parse(readFileSync(join(HERE, '../video/src/live.json'), 'utf8'));
const price = live.print?.price ?? '225.82';

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Geist; src: url(${font('geist-latin-v5.woff2')}) format('woff2'); font-weight: 100 900; }
@font-face { font-family: 'Geist Mono'; src: url(${font('geist-mono-latin-v6.woff2')}) format('woff2'); font-weight: 100 900; }
* { box-sizing: border-box; margin: 0; }
body { width: 1280px; height: 720px; overflow: hidden; background: #080A0D; font-family: Geist, sans-serif; color: #F3F5F7; position: relative; }
.glow { position: absolute; inset: 0; background:
  radial-gradient(760px 520px at 8% 0%, rgba(78,163,255,.30), transparent 70%),
  radial-gradient(700px 520px at 100% 100%, rgba(255,155,61,.22), transparent 70%); }
.grid { position: absolute; inset: 0; background-image: linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px); background-size: 48px 48px; }
.brand { position: absolute; left: 64px; top: 56px; display: flex; align-items: center; gap: 16px; font-weight: 700; font-size: 30px; letter-spacing: .16em; }
.head { position: absolute; left: 60px; top: 150px; font-weight: 800; font-size: 138px; line-height: .9; letter-spacing: -.045em; }
.head b { color: #4EA3FF; font-weight: 800; }
.sub { position: absolute; left: 66px; top: 442px; width: 600px; font-weight: 550; font-size: 31px; line-height: 1.2; color: #C9D0D8; letter-spacing: -.01em; }
.rings { position: absolute; left: 1000px; top: 330px; }
.rings span { position: absolute; border: 3px solid rgba(78,163,255,.5); border-radius: 50%; transform: translate(-50%,-50%); }
.card { position: absolute; right: 56px; top: 176px; width: 520px; padding: 30px 34px 32px; border-radius: 26px; background: #0E1217; border: 2px solid rgba(255,255,255,.14); box-shadow: 0 30px 80px rgba(0,0,0,.6); }
.label { font-weight: 700; font-size: 21px; letter-spacing: .14em; color: #4EA3FF; }
.time { margin-top: 8px; font: 600 26px 'Geist Mono', monospace; color: #9AA3AE; }
.price { margin-top: 10px; font: 800 116px/1 Geist, sans-serif; letter-spacing: -.045em; font-variant-numeric: tabular-nums; }
.chips { margin-top: 22px; display: flex; flex-wrap: wrap; gap: 10px; }
.chip { display: inline-flex; align-items: center; gap: 9px; padding: 9px 14px; border-radius: 10px; font-weight: 700; font-size: 18px; letter-spacing: .08em; }
.chip i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.ok { color: #3DC26B; background: rgba(61,194,107,.13); border: 1px solid rgba(61,194,107,.45); } .ok i { background: #3DC26B; }
.dev { color: #F5B84B; background: rgba(245,184,75,.12); border: 1px solid rgba(245,184,75,.45); } .dev i { background: #F5B84B; }
.foot { position: absolute; left: 66px; bottom: 50px; display: flex; gap: 14px; }
.pill { padding: 10px 18px; border-radius: 999px; font-weight: 650; font-size: 22px; color: #F3F5F7; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.16); }
</style></head><body>
<div class="glow"></div><div class="grid"></div>
<div class="rings">${[380, 560, 740].map((d, i) => `<span style="width:${d}px;height:${d}px;opacity:${0.9 - i * 0.28}"></span>`).join('')}</div>
<div class="brand"><svg width="44" height="44" viewBox="0 0 32 32"><path d="M 5.75 21.92 A 11.84 11.84 0 1 1 23.21 25.39" stroke="#3987e5" stroke-width="4.96" stroke-linecap="round" fill="none"/><path d="M 23.21 25.39 A 11.84 11.84 0 0 1 5.75 21.92" stroke="#d95926" stroke-width="4.96" stroke-linecap="round" fill="none"/></svg>SESSION</div>
<div class="head">BUY AT<br><b>THE BELL</b></div>
<div class="sub">Tokenized stocks, filled at the NYSE open at the price the open printed.</div>
<div class="card">
  <div class="label">NVDA · THE OPENING PRINT</div>
  <div class="time">09:30 ET · 25 SEP</div>
  <div class="price">$${price}</div>
  <div class="chips"><span class="chip ok"><i></i>VERIFIED ON-CHAIN</span><span class="chip dev"><i></i>DEVNET</span></div>
</div>
<div class="foot"><span class="pill">Solana</span><span class="pill">One price for everyone</span></div>
</body></html>`;

const file = join(HERE, 'thumbnail.html');
writeFileSync(file, html);
const page = await openChrome('', { width: 1280, height: 720, dsf: 2, profile: 'thumb' });
try {
  await page.navigate('file://' + file);
  await page.until(() => page.ev(`document.fonts.status === 'loaded' && document.fonts.check('800 40px Geist')`), 15000);
  await page.wait(500);
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  const png = join(HERE, 'thumbnail@2x.png');
  writeFileSync(png, Buffer.from(shot.data, 'base64'));
  spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', png, '-vf', 'scale=1280:720:flags=lanczos', '-q:v', '2', join(HERE, 'thumbnail.jpg')], { stdio: 'inherit' });
  console.log('wrote', join(HERE, 'thumbnail.jpg'), 'and', png);
} finally { page.close(); }
process.exit(0);
