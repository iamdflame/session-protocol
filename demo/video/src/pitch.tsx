/* The pitch video, scene by scene. Scene numbers match demo/SCRIPT-pitch.md. */
import React from 'react';
import { AbsoluteFill, Img, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, Chip, Eyebrow, Ground, Headline, LowerThird, MONO, Mark, SANS, SceneFade, Source, Callout, clamp, ease, useIn, useS } from './kit';
import { Bars, BlinkCard, BrowserFrame, Checklist, Clip, Dim, NO_VIDEO, Netting, Still, Terminal, Week } from './graphics';
import live from './live.json';
import blink from '../../captures/blink-action.json';
import mcp from '../../captures/terminal/mcp.json';
import fuzz from '../../captures/terminal/fuzz.json';

const Pad: React.FC<{ children: React.ReactNode; x?: number; y?: number }> = ({ children, x = 140, y = 140 }) => (
  <div style={{ position: 'absolute', left: x, top: y, right: x, display: 'flex', flexDirection: 'column', gap: 28 }}>{children}</div>
);

/** A slow push-in on a B-roll still, graded down to sit behind type. */
const Broll: React.FC<{ src: string; dim?: number }> = ({ src, dim = 0.5 }) => {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const z = interpolate(f, [0, durationInFrames], [1.04, 1.14]);
  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      <Img src={staticFile(src)} style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${z})` }} />
      <AbsoluteFill style={{ background: `linear-gradient(180deg, rgba(8,10,13,${dim * 0.6}) 0%, rgba(8,10,13,${dim}) 55%, rgba(8,10,13,0.92) 100%)` }} />
    </AbsoluteFill>
  );
};

const Pending: React.FC<{ what: string }> = ({ what }) => (
  <div style={{ position: 'absolute', left: 160, top: 116, width: 1600, height: 900, display: 'grid', placeItems: 'center', border: `2px dashed ${C.warn}`, borderRadius: 18, color: C.warn, font: `600 34px/1.3 ${SANS}`, textAlign: 'center' }}>
    {what}<br /><span style={{ font: `450 24px/1.4 ${SANS}`, color: C.muted }}>recorded at the 25 Sep 13:30 UTC open</span>
  </div>
);

/* ── P01 · Hook ────────────────────────────────────────────────────────── */
export const P01: React.FC = () => {
  const s = useS();
  return (
    <SceneFade>
      <Ground />
      <Sequence durationInFrames={s(6.5)}>
        <Broll src="captures/stills/broll-ny.png" dim={0.55} />
        <Pad y={690}>
          <Eyebrow color={C.day}>New York · 16:00 ET · the close</Eyebrow>
          <Headline text="NVIDIA's price is made six and a half hours a day." size={78} />
        </Pad>
      </Sequence>
      <Sequence from={s(6.5)} durationInFrames={s(6)}>
        <SceneFade inF={8} outF={8}>
          <Pad y={110}>
            <Eyebrow>One week, in half-hours</Eyebrow>
            <Headline text="On Solana, its token trades all 168 hours." size={60} />
            <div style={{ marginTop: 18 }}><Week /></div>
            <div style={{ display: 'flex', gap: 40, font: `500 24px/1 ${SANS}`, color: C.muted }}>
              <span><span style={{ color: C.day }}>■</span> the price is made (NYSE, 09:30–16:00 ET)</span>
              <span><span style={{ color: C.night }}>■</span> the token trades anyway</span>
            </div>
          </Pad>
        </SceneFade>
      </Sequence>
      <Sequence from={s(12.5)}>
        <SceneFade inF={8} outF={1}>
          <Pad y={250}>
            <div style={{ font: `700 260px/0.9 ${SANS}`, letterSpacing: '-0.06em', color: C.night }}><Count to={63} />%</div>
            <Headline text="of that volume happens while the price isn't being made." size={56} from={8} max={1300} />
            <Source from={20}>Solana Foundation newsletter; Crypto Briefing (tokenized-equity volume outside US market hours, through Aug 2026)</Source>
          </Pad>
        </SceneFade>
      </Sequence>
    </SceneFade>
  );
};

const Count: React.FC<{ to: number; from?: number; dur?: number; decimals?: number }> = ({ to, from = 0, dur = 24, decimals = 0 }) => {
  const f = useCurrentFrame();
  const v = interpolate(f, [from, from + dur], [0, to], { ...clamp, easing: ease });
  return <>{v.toFixed(decimals)}</>;
};

/* ── P02 · The cost ────────────────────────────────────────────────────── */
export const P02: React.FC = () => {
  const s = useS();
  return (
    <SceneFade>
      <Ground tone="night" />
      <Sequence durationInFrames={s(9)}>
        <Pad y={190}>
          <Eyebrow color={C.night}>Pool price vs. the stock's first price back</Eyebrow>
          <Headline text="Weekend pools drift about eight times further." size={64} />
          <div style={{ marginTop: 30 }}>
            <Bars from={10} max={31} width={1000} rows={[
              { label: 'Weekday · TSLAx', value: 2.7, text: '2.7 bp', color: C.day },
              { label: 'Weekday · QQQx', value: 3.5, text: '3.5 bp', color: C.day },
              { label: 'Weekend · TSLAx', value: 22, text: '22 bp', color: C.night },
              { label: 'Weekend · QQQx', value: 31, text: '31 bp', color: C.night },
            ]} />
          </div>
          <Source from={30}>bozBasket, live measurement, 18–20 Sep 2026 (median deviation)</Source>
        </Pad>
      </Sequence>
      <Sequence from={s(9)} durationInFrames={s(7)}>
        <SceneFade inF={8} outF={8}>
          <Pad y={190}>
            <Eyebrow color={C.night}>A $10,000 round trip, in market hours</Eyebrow>
            <Headline text="For some names, more than one percent." size={64} />
            <div style={{ marginTop: 30 }}>
              <Bars from={8} max={126.4} width={980} rows={[
                { label: 'SPYx', value: 3.0, text: '3.0 bp', color: C.day },
                { label: 'NVDAx', value: 9.9, text: '9.9 bp', color: C.day },
                { label: 'AAPLx', value: 57.6, text: '57.6 bp', color: C.night },
                { label: 'METAx', value: 126.4, text: '126.4 bp', color: C.negative },
              ]} />
            </div>
            <Source from={24}>Haircut, 14 Sep 2026 (round trip at $10k during US market hours)</Source>
          </Pad>
        </SceneFade>
      </Sequence>
      <Sequence from={s(16)}>
        <AbsoluteFill style={{ display: 'grid', placeItems: 'center' }}>
          <Headline text="You pay for the noise." size={110} align="center" />
        </AbsoluteFill>
      </Sequence>
    </SceneFade>
  );
};

/* ── P03 · Ade, late at night ──────────────────────────────────────────── */
// ticket-order.mp4 (captured 25 Sep): type at 5–9.5 s, quote from ~18 s, hover "Now" ~21 s, "At the bell" ~31 s, click ~39 s, toast ~45 s, "Your orders" ~50 s
const TICKET_SEGMENTS = [
  { from: 5.5, to: 9.5 }, { from: 18.5, to: 22.5 }, { from: 31, to: 34 }, { from: 38.5, to: 46.5, rate: 1.5 }, { from: 48.5, to: 53 },
];
export const P03: React.FC = () => {
  const s = useS();
  const at = (sec: number) => s(4 + sec); // the browser starts 4 s in
  return (
    <SceneFade>
      <Ground />
      <Sequence durationInFrames={s(4.4)}>
        <Broll src="captures/stills/broll-phone.png" dim={0.35} />
        <LowerThird title="Ade · Lagos · late at night" sub="New York is shut. She wants $200 of NVIDIA." from={8} />
      </Sequence>
      <Sequence from={s(4)}>
        <BrowserFrame url="session-roan.vercel.app/bells">
          <Clip src="captures/ticket-order.mp4" segments={TICKET_SEGMENTS} />
        </BrowserFrame>
      </Sequence>
      {/* the two choices, side by side (positions from the capture at 1920×1080, framed at 0.833×) */}
      {/* drawn over the recording by ffmpeg when frames are rendered here (demo/video/player/composite.mjs) */}
      {!NO_VIDEO && <Callout x={160 + 465 * 0.8333} y={116 + 495 * 0.8333} w={180 * 0.8333} h={110 * 0.8333} label="Now, on Jupiter" color={C.night} from={at(4.5)} to={at(8)} />}
      {!NO_VIDEO && <Callout x={160 + 665 * 0.8333} y={116 + 495 * 0.8333} w={185 * 0.8333} h={110 * 0.8333} label="At the bell" color={C.day} from={at(8.2)} to={at(11)} />}
      <LowerThird title="Devnet sandbox" sub="Fixture NVDAx · test USDC · a real order at today's real open" chips={<><Chip kind="devnet">Devnet</Chip><Chip kind="simulated">Simulated prints</Chip></>} from={at(14)} />
    </SceneFade>
  );
};

/* ── P04 · The bell ────────────────────────────────────────────────────── */
const Clock: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sec = Math.min(60, 56 + Math.floor(f / fps));
  const rung = sec >= 60;
  const t = rung ? '09:30:00' : `09:29:${String(sec).padStart(2, '0')}`;
  const ring = interpolate(f, [4 * fps, 4 * fps + 40], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ display: 'grid', placeItems: 'center' }}>
      {rung && [0, 1, 2].map((i) => (
        <div key={i} style={{ position: 'absolute', width: 300 + (ring + i * 0.33) * 900, height: 300 + (ring + i * 0.33) * 900, borderRadius: '50%', border: `3px solid ${C.day}`, opacity: Math.max(0, 0.6 - ring - i * 0.15) }} />
      ))}
      <div style={{ textAlign: 'center' }}>
        <div style={{ font: `650 26px/1 ${SANS}`, letterSpacing: '0.16em', color: rung ? C.day : C.muted, marginBottom: 20 }}>{rung ? 'THE OPENING BELL' : 'NEW YORK'}</div>
        <div style={{ font: `600 180px/1 ${MONO}`, color: rung ? C.text : C.muted, letterSpacing: '-0.04em' }}>{t}</div>
        <div style={{ font: `500 30px/1 ${SANS}`, color: C.faint, marginTop: 16 }}>ET</div>
      </div>
    </AbsoluteFill>
  );
};

const PrintCard: React.FC = () => {
  const p = useIn(0, 18);
  return (
    <AbsoluteFill style={{ display: 'grid', placeItems: 'center' }}>
      <div style={{ width: 1100, padding: '40px 48px', borderRadius: 24, background: C.surface, border: `1px solid ${C.borderStrong}`, opacity: p, transform: `translateY(${(1 - p) * 40}px)` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ font: `650 24px/1 ${SANS}`, letterSpacing: '0.14em', color: C.day }}>NVDA · THE OPENING PRINT</div>
          <Chip kind="simulated">Simulated signer</Chip>
        </div>
        <div style={{ font: `650 130px/1 ${MONO}`, color: C.text, letterSpacing: '-0.04em', margin: '26px 0 18px' }}>{live.ready ? `$${live.print.price}` : '$ · · ·'}</div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <Chip kind="onchain" size={22}>Signature verified on-chain</Chip>
          <Chip kind="plain" size={22}>Pyth's own verifier code</Chip>
          <Chip kind="plain" size={22}>{live.ready ? `Priced ${live.print.fromBell} after the bell` : 'the bell’s window'}</Chip>
        </div>
        <div style={{ marginTop: 22, font: `450 21px/1.45 ${SANS}`, color: C.muted }}>On devnet a test key signs, and every print says so. With a Pyth Pro key, the same path carries Pyth’s signature.</div>
      </div>
    </AbsoluteFill>
  );
};

export const P04: React.FC = () => {
  const s = useS();
  return (
    <SceneFade>
      <Ground tone="day" />
      <Sequence durationInFrames={s(6.5)}><Clock /></Sequence>
      <Sequence from={s(6.5)} durationInFrames={s(6.5)}><SceneFade inF={6} outF={8}><PrintCard /></SceneFade></Sequence>
      <Sequence from={s(13)} durationInFrames={s(7)}>
        <SceneFade inF={8} outF={8}>
          <Pad y={170}>
            <Eyebrow color={C.day}>The cross for today's open</Eyebrow>
            <Headline text="Everyone trades at that one price." size={64} />
            <div style={{ marginTop: 40 }}>
              <Netting buyers={Math.round(live.book.buyersUsd)} sellers={Math.round(live.book.sellersUsd)} price={live.ready ? `$${live.print.price}` : 'the print'} from={8} />
            </div>
          </Pad>
        </SceneFade>
      </Sequence>
      <Sequence from={s(20)}>
        {live.ready ? (
          <BrowserFrame url="session-roan.vercel.app/oracle">
            <Clip src="captures/oracle-prints.mp4" segments={[{ from: 1.5, to: 8 }]} />
          </BrowserFrame>
        ) : <Pending what="/oracle with today's print" />}
      </Sequence>
    </SceneFade>
  );
};

/* ── P05 · The receipt ─────────────────────────────────────────────────── */
export const P05: React.FC = () => {
  const s = useS();
  return (
    <SceneFade>
      <Ground />
      {live.ready ? (
        <BrowserFrame url={`session-roan.vercel.app/b/${live.cross.slice(0, 8)}…`}>
          <Still src="captures/stills/receipt-full.png" imgW={3840} imgH={live.receiptHeight ?? 5714} box={{ w: 1600, h: 900 }} cams={[
            { at: 0, cx: 0.56, cy: 0.115, zoom: 1.3 }, { at: 4.5, cx: 0.56, cy: 0.19, zoom: 1.5 }, { at: 9.5, cx: 0.73, cy: 0.31, zoom: 1.75 },
            { at: 14.5, cx: 0.40, cy: 0.31, zoom: 1.7 }, { at: 19.5, cx: 0.56, cy: 0.20, zoom: 1.3 },
          ]} />
        </BrowserFrame>
      ) : <Pending what="The receipt of today's open cross" />}
      <LowerThird title="The receipt" sub="Read from the chain on every visit; the signature re-checked in your browser" from={s(1)} to={s(6)} />
    </SceneFade>
  );
};

/* ── P06 · Trust ───────────────────────────────────────────────────────── */
export const P06: React.FC = () => {
  const s = useS();
  const d = live.drills;
  const passed = (k: 'pause' | 'multiplier') => d[k].result === 'passed';
  return (
    <SceneFade>
      <Ground />
      <Sequence durationInFrames={s(17)}>
        <Pad y={100}>
          <Eyebrow color={C.warn}>Issuer drills · devnet · today's real open</Eyebrow>
          <Headline text="Tokenized stocks come with issuer powers. We drilled them." size={56} />
        </Pad>
        <div style={{ position: 'absolute', left: 140, top: 330, display: 'flex', gap: 60 }}>
          <Checklist title="The issuer pauses the mint" from={s(1.5)} items={[
            { text: 'The cross prices and clears anyway', at: 1 },
            { text: 'Quote legs paid while paused', at: 2.4 },
            { text: 'The tokens are held, not lost', at: 3.6, tone: 'hold' },
            { text: 'The issuer resumes; the tokens follow', at: 5 },
            { text: passed('pause') ? 'Escrow reads zero · passed' : 'Escrow reads zero', at: 6.4 },
          ]} />
          <Checklist title="A new multiplier near the bell" from={s(7.5)} items={[
            { text: 'Pricing refuses to guess the multiplier', at: 1 },
            { text: 'The cross is cancelled', at: 2.4, tone: 'info' },
            { text: 'Everyone refunded, whole', at: 3.8 },
            { text: passed('multiplier') ? 'Escrow reads zero · passed' : 'Escrow reads zero', at: 5.2 },
          ]} />
        </div>
      </Sequence>
      <Sequence from={s(17)}>
        <SceneFade inF={8} outF={1}>
          <Pad y={260}>
            <div style={{ font: `700 200px/0.9 ${SANS}`, letterSpacing: '-0.06em', color: C.positive }}>300</div>
            <Headline text="random crosses, every balance matched to the atom." size={58} from={6} />
            <Source from={16}>tests/integration/tests/cross_fuzz.rs, on the real NVDAx mint in LiteSVM</Source>
          </Pad>
        </SceneFade>
      </Sequence>
    </SceneFade>
  );
};

/* ── P07 · Why Solana ──────────────────────────────────────────────────── */
const Tile: React.FC<{ title: string; sub: string; children?: React.ReactNode; from: number; x: number; y: number; w?: number; h?: number }> = ({ title, sub, children, from, x, y, w = 800, h = 400 }) => {
  const p = useIn(from, 18);
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, borderRadius: 22, background: C.surface, border: `1px solid ${C.borderStrong}`, padding: '28px 32px', opacity: p, transform: `translateY(${(1 - p) * 30}px)`, overflow: 'hidden' }}>
      <div style={{ font: `650 34px/1.1 ${SANS}`, color: C.text, letterSpacing: '-0.02em' }}>{title}</div>
      <div style={{ marginTop: 10, font: `450 22px/1.4 ${SANS}`, color: C.muted }}>{sub}</div>
      <div style={{ marginTop: 22 }}>{children}</div>
    </div>
  );
};
const Ix: React.FC<{ n: number; name: string; note: string; color: string }> = ({ n, name, note, color }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px', borderRadius: 12, border: `1px solid ${color}66`, background: `${color}12`, marginBottom: 10 }}>
    <span style={{ font: `600 20px/1 ${MONO}`, color }}>#{n}</span>
    <span style={{ font: `600 22px/1 ${MONO}`, color: C.text }}>{name}</span>
    <span style={{ marginLeft: 'auto', font: `450 19px/1 ${SANS}`, color: C.muted }}>{note}</span>
  </div>
);
export const P07: React.FC = () => {
  const s = useS();
  return (
    <SceneFade>
      <Ground />
      <Pad y={60}><Eyebrow color={C.day}>Why it belongs on Solana</Eyebrow></Pad>
      <Tile title="Verified in the same transaction" sub="The signature is checked before the program reads a digit." from={s(0.6)} x={140} y={120}>
        <Ix n={0} name="Ed25519 precompile" note="signature ✓" color={C.positive} />
        <Ix n={1} name="post_print → verify_message" note="trusted signer ✓" color={C.day} />
      </Tile>
      <Tile title="One instruction clears the book" sub="Aggregates and a 101-step fee ladder: the same cost at 3 orders or 3,000." from={s(4.5)} x={980} y={120}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 150 }}>
          {Array.from({ length: 40 }, (_, i) => <div key={i} style={{ flex: 1, height: 20 + ((i * 37) % 120), borderRadius: 3, background: i === 17 ? C.warn : i < 17 ? `${C.day}aa` : `${C.faint}55` }} />)}
        </div>
      </Tile>
      <Tile title="A token is a share" sub="The price per raw token is the print times the mint's own multiplier, read on-chain." from={s(9)} x={140} y={560}>
        <div style={{ font: `600 40px/1.2 ${MONO}`, color: C.text }}>$ print × <span style={{ color: C.day }}>1.001701</span></div>
        <div style={{ font: `450 20px/1.4 ${SANS}`, color: C.faint, marginTop: 8 }}>NVDAx's Token-2022 scaled-UI multiplier</div>
      </Tile>
      <Tile title="It travels" sub="A Blink on X, or an AI agent with its limits in code." from={s(13.5)} x={980} y={560}>
        <div style={{ transform: 'scale(0.42)', transformOrigin: 'top left', position: 'absolute', left: 32, top: 150 }}><BlinkCard card={blink} /></div>
        <div style={{ position: 'absolute', left: 330, top: 150, width: 440 }}>
          <div style={{ font: `500 18px/1.6 ${MONO}`, color: C.muted, whiteSpace: 'pre' }}>
            {['✓ bell_quote: at the bell vs a swap now', '✓ $500 order: over the cap, refused', '✓ $3 order: placed, then cancelled'].join('\n')}
          </div>
        </div>
      </Tile>
    </SceneFade>
  );
};

/* ── P08 · Where it stands ─────────────────────────────────────────────── */
export const P08: React.FC = () => {
  const s = useS();
  const rows = ['The bell oracle · 5 listings · every open and close', 'The cross · real NYSE bells', 'Receipts, re-verified in the browser', 'A Blink, and agent tools with caps', 'Issuer drills, in public'];
  return (
    <SceneFade>
      <Ground />
      <Pad y={120}>
        <div style={{ display: 'flex', gap: 14 }}><Chip kind="devnet" size={24}>Live on devnet since 25 Sep 2026</Chip><Chip kind="simulated" size={24}>Test signer until Pyth Pro</Chip></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, marginTop: 20 }}>
          {rows.map((r, i) => <Row key={r} text={r} from={s(0.6 + i * 0.7)} />)}
        </div>
        <Road from={s(9)} />
      </Pad>
    </SceneFade>
  );
};
const Row: React.FC<{ text: string; from: number }> = ({ text, from }) => {
  const p = useIn(from, 14);
  return <div style={{ display: 'flex', alignItems: 'center', gap: 18, opacity: p, transform: `translateX(${(1 - p) * 24}px)`, font: `550 38px/1.2 ${SANS}`, color: C.text }}><span style={{ width: 16, height: 16, borderRadius: '50%', background: C.positive }} />{text}</div>;
};
const Road: React.FC<{ from: number }> = ({ from }) => {
  const steps = ['Pyth Pro key', 'An audit', 'Mainnet, with caps'];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginTop: 50 }}>
      <div style={{ font: `650 24px/1 ${SANS}`, letterSpacing: '0.14em', color: C.muted, marginRight: 10 }}>NEXT</div>
      {steps.map((t, i) => <Step key={t} text={t} from={from + i * 10} last={i === steps.length - 1} />)}
    </div>
  );
};
const Step: React.FC<{ text: string; from: number; last: boolean }> = ({ text, from, last }) => {
  const p = useIn(from, 14);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 20, opacity: p }}>
      <div style={{ padding: '16px 26px', borderRadius: 14, border: `1px solid ${C.day}66`, background: `${C.day}14`, font: `600 30px/1 ${SANS}`, color: C.text }}>{text}</div>
      {!last && <div style={{ font: `500 34px/1 ${SANS}`, color: C.faint }}>→</div>}
    </div>
  );
};

/* ── P09 · End card ────────────────────────────────────────────────────── */
export const P09: React.FC = () => {
  const p = useIn(0, 20);
  const q = useIn(14, 20);
  return (
    <AbsoluteFill>
      <Ground />
      <AbsoluteFill style={{ display: 'grid', placeItems: 'center' }}>
        <div style={{ textAlign: 'center', opacity: p, transform: `scale(${0.96 + p * 0.04})` }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 28 }}>
            <Mark size={120} />
            <div style={{ font: `700 120px/1 ${SANS}`, letterSpacing: '0.12em', color: C.text }}>SESSION</div>
          </div>
          <div style={{ marginTop: 34, font: `550 56px/1 ${SANS}`, color: C.day, letterSpacing: '-0.02em', opacity: q }}>Trade at the bell.</div>
          <div style={{ marginTop: 56, font: `450 28px/1.6 ${MONO}`, color: C.muted, opacity: q }}>session-roan.vercel.app<br />github.com/iamdflame/session-protocol</div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const PITCH = { P01, P02, P03, P04, P05, P06, P07, P08, P09 } as const;
void Dim; void Terminal; void fuzz;
