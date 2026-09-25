/* The technical video, scene by scene. Scene numbers match demo/SCRIPT-technical.md. */
import React from 'react';
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from 'remotion';
import { C, Chip, Eyebrow, Ground, Headline, MONO, Mark, SANS, SceneFade, Source, clamp, ease, useIn, useS } from './kit';
import { Arrow, BlinkCard, Box, BrowserFrame, Checklist, Still, Terminal } from './graphics';
import live from './live.json';
import blink from '../../captures/blink-action.json';
import mcp from '../../captures/terminal/mcp.json';
import bell from '../../captures/terminal/bell.json';
import cross from '../../captures/terminal/cross.json';
import proptest from '../../captures/terminal/proptest.json';
import fuzz from '../../captures/terminal/fuzz300.json';
import ts from '../../captures/terminal/ts.json';

const Pad: React.FC<{ children: React.ReactNode; x?: number; y?: number }> = ({ children, x = 120, y = 70 }) => (
  <div style={{ position: 'absolute', left: x, top: y, right: x, display: 'flex', flexDirection: 'column', gap: 18 }}>{children}</div>
);
const Title: React.FC<{ eyebrow: string; text: string; color?: string }> = ({ eyebrow, text, color = C.day }) => (
  <Pad><Eyebrow color={color}>{eyebrow}</Eyebrow><Headline text={text} size={50} /></Pad>
);

/* ── T01 + T02 · the architecture ──────────────────────────────────────── */
const Architecture: React.FC<{ from?: number }> = ({ from = 0 }) => {
  const s = useS();
  const at = (x: number) => from + s(x);
  return (
    <>
      <Box x={110} y={250} w={330} h={120} title="bell-poster" sub="posts every open and close" from={at(0.2)} />
      <Box x={560} y={235} w={520} h={150} title="session-bell" sub="the oracle · keeps prints · holds no funds" color={C.day} from={at(0.8)} />
      <Box x={1200} y={250} w={560} h={120} title="Pyth's verifier (Lazer)" sub="called by CPI · trusted signers · Ed25519" from={at(1.4)} />
      <Box x={110} y={560} w={330} h={120} title="Traders · Blink · agents" sub="place and cancel orders" from={at(2.2)} />
      <Box x={560} y={530} w={520} h={180} title="session-cross" sub="escrow · pricing · auction · settlement" color={C.night} from={at(2.8)} />
      <Box x={1200} y={560} w={560} h={120} title="the keeper" sub="prices · clears · settles · closes · permissionless" from={at(3.4)} />
      <Box x={560} y={850} w={520} h={110} title="session-core" sub="the calendar and the arithmetic, shared" from={at(4.0)} mono />
      <Arrow x1={440} y1={310} x2={556} y2={310} from={at(1.0)} />
      <Arrow x1={1196} y1={310} x2={1084} y2={310} from={at(1.6)} />
      <Arrow x1={440} y1={620} x2={556} y2={620} from={at(2.6)} />
      <Arrow x1={1196} y1={620} x2={1084} y2={620} from={at(3.6)} />
      <Arrow x1={820} y1={526} x2={820} y2={390} from={at(3.2)} label="reads the print" color={C.day} />
      <Arrow x1={820} y1={846} x2={820} y2={716} from={at(4.2)} color={C.faint} />
    </>
  );
};

export const T01: React.FC = () => {
  const s = useS();
  const p = useIn(0, 18);
  const f = useCurrentFrame();
  const out = interpolate(f, [s(6), s(7)], [1, 0], clamp);
  return (
    <SceneFade>
      <Ground />
      <AbsoluteFill style={{ display: 'grid', placeItems: 'center', opacity: out }}>
        <div style={{ textAlign: 'center', opacity: p }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 22 }}><Mark size={84} /><div style={{ font: `700 84px/1 ${SANS}`, letterSpacing: '0.12em', color: C.text }}>SESSION</div></div>
          <div style={{ marginTop: 26, font: `550 44px/1.2 ${SANS}`, color: C.muted }}>How it works: orders that fill at the bell, at a price verified on-chain</div>
        </div>
      </AbsoluteFill>
      <Sequence from={s(6.5)}>
        <SceneFade inF={10} outF={1}><Title eyebrow="Two programs, a shared core, one keeper" text="Receipts anyone can check." /><Architecture /></SceneFade>
      </Sequence>
    </SceneFade>
  );
};

export const T02: React.FC = () => (
  <SceneFade>
    <Ground />
    <Title eyebrow="The architecture" text="Every step after placing an order is permissionless." />
    <Architecture from={-200} />
    <Callouts />
  </SceneFade>
);
const Callouts: React.FC = () => {
  const s = useS();
  const a = useIn(s(4), 16);
  const b = useIn(s(12), 16);
  const c = useIn(s(18), 16);
  const st = (o: number) => ({ opacity: o, transform: `translateY(${(1 - o) * 12}px)` });
  return (
    <div style={{ position: 'absolute', left: 1200, top: 760, width: 600, display: 'flex', flexDirection: 'column', gap: 12, font: `500 23px/1.35 ${SANS}`, color: C.muted }}>
      <div style={st(a)}><span style={{ color: C.day }}>●</span> The oracle only keeps prints; it never holds funds.</div>
      <div style={st(b)}><span style={{ color: C.night }}>●</span> The exchange holds the escrow, and nothing else can move it.</div>
      <div style={st(c)}><span style={{ color: C.positive }}>●</span> The keeper is a convenience, not an authority.</div>
    </div>
  );
};

/* ── T03 · how a print gets in ─────────────────────────────────────────── */
const Seg: React.FC<{ w: number; label: string; sub?: string; color: string; from: number }> = ({ w, label, sub, color, from }) => {
  const p = useIn(from, 12);
  return (
    <div style={{ width: w, height: 96, borderRadius: 8, border: `2px solid ${color}`, background: `${color}18`, padding: '10px 12px', opacity: p, transform: `translateY(${(1 - p) * 10}px)`, overflow: 'hidden' }}>
      <div style={{ font: `600 20px/1.1 ${MONO}`, color: C.text }}>{label}</div>
      {sub && <div style={{ font: `450 16px/1.3 ${MONO}`, color: C.muted, marginTop: 6 }}>{sub}</div>}
    </div>
  );
};
export const T03: React.FC = () => {
  const s = useS();
  const f = useCurrentFrame();
  const ruleIn = useIn(s(22), 18);
  const byte12 = interpolate(f, [s(7), s(8)], [0, 1], { ...clamp, easing: ease });
  return (
    <SceneFade>
      <Ground tone="day" />
      <Title eyebrow="session-bell · post_print" text="A print arrives as one transaction." />
      <div style={{ position: 'absolute', left: 120, top: 250, width: 1680 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Instr n={0} name="Ed25519 precompile" sub="signature · public key · message: offsets into instruction 1" color={C.positive} from={s(1)} />
          <Instr n={1} name="session-bell · post_print(message, day, kind)" sub="CPI → verify_message(message, ed25519 index 0) → parse every byte → keep or refuse" color={C.day} from={s(2.5)} />
        </div>
        <div style={{ marginTop: 44, font: `600 22px/1 ${SANS}`, color: C.muted, letterSpacing: '0.1em' }}>INSTRUCTION 1 · ITS DATA, BYTE BY BYTE</div>
        <div style={{ position: 'relative', display: 'flex', gap: 6, marginTop: 58 }}>
          <Seg w={120} label="disc" sub="8 bytes" color={C.faint} from={s(4)} />
          <Seg w={110} label="len" sub="u32" color={C.faint} from={s(4.3)} />
          <Seg w={120} label="magic" sub="u32" color={C.day} from={s(5)} />
          <Seg w={300} label="signature" sub="64 bytes (Ed25519)" color={C.positive} from={s(5.3)} />
          <Seg w={220} label="public key" sub="32 bytes" color={C.positive} from={s(5.6)} />
          <Seg w={90} label="len" sub="u16" color={C.day} from={s(5.9)} />
          <Seg w={340} label="payload" sub="timestamp · feeds · price, conf, publishers, session…" color={C.day} from={s(6.2)} />
          <Seg w={110} label="day" sub="i64" color={C.faint} from={s(6.5)} />
          <Seg w={90} label="kind" sub="u8" color={C.faint} from={s(6.7)} />
          <div style={{ position: 'absolute', left: 236, top: -34, opacity: byte12, font: `650 22px/1 ${MONO}`, color: C.warn }}>▼ byte 12: the signed message</div>
        </div>
      </div>
      <div style={{ position: 'absolute', left: 120, top: 720, width: 1680, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 18, opacity: ruleIn, transform: `translateY(${(1 - ruleIn) * 20}px)` }}>
        {[
          ['The close', 'the last price in the seconds before 16:00'],
          ['The open', 'the first price after 09:30'],
          ['Accepted only if', 'regular session · confidence ≤ 25 bp · publishers ≥ 1'],
          ['Replaced only by', 'a strictly later close or an earlier open'],
          ['Refused', 'a price stamped more than 120 s in the chain’s future'],
          ['Frozen', '5 minutes after the window: final, or marked missing'],
        ].map(([a, b]) => (
          <div key={a} style={{ padding: '16px 20px', borderRadius: 14, background: C.surface, border: `1px solid ${C.borderStrong}` }}>
            <div style={{ font: `650 22px/1.2 ${SANS}`, color: C.text }}>{a}</div>
            <div style={{ font: `450 20px/1.35 ${SANS}`, color: C.muted, marginTop: 6 }}>{b}</div>
          </div>
        ))}
      </div>
      <Sequence from={s(34)}>
        <div style={{ position: 'absolute', left: 1460, top: 60 }}><Chip kind="simulated">Devnet: a test signer, wider windows</Chip></div>
      </Sequence>
    </SceneFade>
  );
};
const Instr: React.FC<{ n: number; name: string; sub: string; color: string; from: number }> = ({ n, name, sub, color, from }) => {
  const p = useIn(from, 16);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 22, padding: '18px 24px', borderRadius: 16, border: `2px solid ${color}88`, background: `${color}10`, opacity: p, transform: `translateX(${(1 - p) * -24}px)` }}>
      <div style={{ font: `700 34px/1 ${MONO}`, color }}>#{n}</div>
      <div>
        <div style={{ font: `650 28px/1.2 ${MONO}`, color: C.text }}>{name}</div>
        <div style={{ font: `450 20px/1.35 ${SANS}`, color: C.muted, marginTop: 4 }}>{sub}</div>
      </div>
    </div>
  );
};

/* ── T04 · the cross ───────────────────────────────────────────────────── */
const PHASES = ['collecting', 'frozen · T−2 min', 'priced', 'confirming', 'auction · 2 min', 'cleared', 'settling', 'closed'];
export const T04: React.FC = () => {
  const s = useS();
  const f = useCurrentFrame();
  const active = Math.min(PHASES.length - 1, Math.floor(interpolate(f, [s(1), s(20)], [0, PHASES.length - 0.01], clamp)));
  const ladderIn = useIn(s(20), 20);
  const needX = interpolate(f, [s(26), s(30)], [0, 1], { ...clamp, easing: ease });
  const round = useIn(s(40), 18);
  return (
    <SceneFade>
      <Ground tone="night" />
      <Title eyebrow="session-cross" text="One price per side, and an escrow that can't be overdrawn." color={C.night} />
      <div style={{ position: 'absolute', left: 120, top: 250, display: 'flex', gap: 10, alignItems: 'center' }}>
        {PHASES.map((p, i) => (
          <React.Fragment key={p}>
            <div style={{ padding: '14px 16px', borderRadius: 12, font: `600 21px/1 ${SANS}`, color: i <= active ? C.text : C.faint, background: i === active ? `${C.night}33` : i < active ? `${C.positive}14` : C.surface, border: `2px solid ${i === active ? C.night : i < active ? `${C.positive}66` : C.border}` }}>{p}</div>
            {i < PHASES.length - 1 && <div style={{ color: C.faint, font: `500 22px/1 ${SANS}` }}>→</div>}
          </React.Fragment>
        ))}
      </div>
      <div style={{ position: 'absolute', left: 120, top: 360, width: 1680, font: `500 30px/1.4 ${MONO}`, color: C.text, opacity: useIn(s(6), 16) }}>
        X per raw token = <span style={{ color: C.day }}>print</span> × <span style={{ color: C.day }}>mint multiplier</span> <span style={{ color: C.faint }}>(Token-2022 scaled UI, exact f64 bits → WAD)</span>
      </div>
      <div style={{ position: 'absolute', left: 120, top: 460, width: 1100, height: 440, opacity: ladderIn }}>
        <div style={{ font: `600 22px/1 ${SANS}`, color: C.muted, letterSpacing: '0.1em' }}>THE AUCTION · MAKERS' ASKS ON A 101-STEP FEE LADDER (0–100 bp)</div>
        <div style={{ position: 'relative', marginTop: 24, height: 330, display: 'flex', alignItems: 'flex-end', gap: 3 }}>
          {Array.from({ length: 101 }, (_, i) => {
            const cap = [0, 0, 3, 0, 0, 6, 0, 0, 0, 0, 4, 0, 0, 0, 0, 12, 0, 0, 0, 0, 5][i] ?? (i % 17 === 0 ? 7 : 0);
            const cum = i <= 15;
            return <div key={i} style={{ flex: 1, height: 12 + cap * 22, borderRadius: 2, background: cap ? (i === 15 ? C.warn : cum ? C.day : `${C.faint}88`) : `${C.faint}22` }} />;
          })}
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 12 + 190, height: 0, borderTop: `3px dashed ${C.night}`, transform: `scaleX(${needX})`, transformOrigin: 'left' }} />
          <div style={{ position: 'absolute', left: 8, bottom: 214, font: `600 21px/1 ${SANS}`, color: C.night, opacity: needX }}>the crowded side's need</div>
          <div style={{ position: 'absolute', left: `${(15 / 101) * 100}%`, bottom: 12 + 12 * 22 + 30, font: `650 21px/1.2 ${SANS}`, color: C.warn, opacity: needX, whiteSpace: 'nowrap' }}>▼ clearing fee: the lowest ask that covers it · the marginal bucket is rationed</div>
        </div>
      </div>
      <div style={{ position: 'absolute', left: 1280, top: 500, width: 520, display: 'flex', flexDirection: 'column', gap: 16, opacity: round, transform: `translateX(${(1 - round) * 20}px)` }}>
        {[['Consumed', 'rounds up'], ['Received', 'rounds down'], ['Escrow per cross', 'asserted: never pays out more than it holds'], ['Quote and token legs', 'settle independently: a pause holds only tokens']].map(([a, b]) => (
          <div key={a} style={{ padding: '16px 20px', borderRadius: 14, background: C.surface, border: `1px solid ${C.borderStrong}` }}>
            <div style={{ font: `650 24px/1.2 ${SANS}`, color: C.text }}>{a}</div><div style={{ font: `450 21px/1.35 ${SANS}`, color: C.muted, marginTop: 4 }}>{b}</div>
          </div>
        ))}
      </div>
    </SceneFade>
  );
};

/* ── T05 · the tests (real captured output) ────────────────────────────── */
export const T05: React.FC = () => {
  const s = useS();
  const W = 1500;
  return (
    <SceneFade>
      <Ground />
      <Pad><Eyebrow color={C.positive}>The tests, as they ran on 25 Sep</Eyebrow></Pad>
      <Sequence durationInFrames={s(8)}><Terminal data={proptest} width={W} height={720} y={170} typeFor={1} showFor={4} title="property tests · 10,000 cases each" /></Sequence>
      <Sequence from={s(8)} durationInFrames={s(10)}><Terminal data={bell} width={W} height={720} y={170} typeFor={1} showFor={5} title="LiteSVM · session-bell · Pyth's real verifier binary" /></Sequence>
      <Sequence from={s(18)} durationInFrames={s(9)}><Terminal data={cross} width={W} height={720} y={170} typeFor={1} showFor={4} title="LiteSVM · session-cross · the real NVDAx mint" /></Sequence>
      <Sequence from={s(27)} durationInFrames={s(8)}><Terminal data={fuzz} width={W} height={720} y={170} typeFor={1.2} showFor={4} title="the fuzzer · random crosses over a year of trading days" font={20} /></Sequence>
      <Sequence from={s(35)}><Terminal data={ts} pick={(t) => /^all .* passed/.test(t)} width={W} height={720} y={170} typeFor={1} showFor={3.5} title="TypeScript: the SDK decodes the bytes Rust wrote" /></Sequence>
    </SceneFade>
  );
};

/* ── T06 · failure, live ───────────────────────────────────────────────── */
export const T06: React.FC = () => {
  const s = useS();
  const d = live.drills as Record<string, { result: string; steps: { what: string; signature?: string | null }[] }>;
  const p = d.pause?.result === 'passed', m = d.multiplier?.result === 'passed';
  // the drill's own record, in order, one line a step
  const fromRecord = (k: string) => (d[k]?.steps ?? []).map((st, i) => ({
    text: st.what.replace(/^(alice|bob) /, (w) => w[0].toUpperCase() + w.slice(1)),
    at: 1 + i * 1.3,
    tone: (/pauses|schedules|cancelled/.test(st.what) ? 'info' : /held/.test(st.what) ? 'hold' : 'ok') as 'ok' | 'hold' | 'info',
  }));
  return (
    <SceneFade>
      <Ground />
      <Title eyebrow="Issuer drills · devnet · the 25 Sep open" text="Failure modes, run in public at a real bell." color={C.warn} />
      <div style={{ position: 'absolute', left: 120, top: 300, display: 'flex', gap: 60 }}>
        <Checklist title="Pause" width={800} from={s(2)} items={(fromRecord('pause').length ? fromRecord('pause') : [
          { text: 'Orders in; the issuer pauses the mint', at: 1, tone: 'info' },
          { text: 'The cross prices and clears (no token moves)', at: 3 },
          { text: 'Quote legs paid while paused; tokens held', at: 5, tone: 'hold' },
          { text: 'The issuer resumes; the tokens settle', at: 7 },
          { text: p ? 'Closed · both escrows read 0 · passed' : 'Closed · both escrows read 0', at: 9 },
        ]) as never} />
        <Checklist title="Multiplier change" width={800} from={s(14)} items={(fromRecord('multiplier').length ? fromRecord('multiplier') : [
          { text: 'Orders in; 1.0025 scheduled for 13:35 UTC', at: 1, tone: 'info' },
          { text: 'price_cross: "multiplier activation near the bell"', at: 3 },
          { text: 'Cancelled; every order refunded whole', at: 5 },
          { text: m ? 'Both escrows read 0 · passed' : 'Both escrows read 0', at: 7 },
        ]) as never} />
      </div>
      <div style={{ position: 'absolute', left: 120, bottom: 70 }}><Source from={s(4)}>web/public/cross-drills.json: every step's transaction, on devnet</Source></div>
    </SceneFade>
  );
};

/* ── T07 · the keeper, and the counterfactual ──────────────────────────── */
export const T07: React.FC = () => {
  const s = useS();
  const memo = useIn(s(8), 18);
  return (
    <SceneFade>
      <Ground />
      <Title eyebrow="The keeper" text="The alternative, written into the transaction that prices the cross." />
      <div style={{ position: 'absolute', left: 120, top: 300, width: 1680, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Instr n={0} name="ComputeBudget · 600,000 units" sub="the Memo program charges by the byte: ~124k for a real quote" color={C.faint} from={s(1)} />
        <Instr n={1} name="session-cross · price_cross" sub="the print × the mint's multiplier, or cancel" color={C.night} from={s(2.2)} />
        <Instr n={2} name="Memo · session-cross counterfactual v1 {…}" sub="Jupiter, mainnet, the real NVDAx: each side's total, quoted at the bell" color={C.day} from={s(3.4)} />
      </div>
      <div style={{ position: 'absolute', left: 120, top: 690, width: 1680, padding: '22px 26px', borderRadius: 16, background: C.surface, border: `1px solid ${C.borderStrong}`, font: `450 24px/1.5 ${MONO}`, color: C.muted, opacity: memo }}>
        <span style={{ color: C.text }}>receipt trusts it only if</span> the memo is in the transaction that priced this cross <span style={{ color: C.text }}>and</span> the keeper named in the manifest signed it.<br />
        <span style={{ color: C.positive }}>tests/receipt.test.ts</span>: the same quote from anyone else → <span style={{ color: C.warn }}>untrusted</span>; a memo elsewhere → <span style={{ color: C.warn }}>not a counterfactual</span>.<br />
        <span style={{ color: C.day }}>25 Sep, 3 s after the bell:</span> buyers' $1,205 → 5.3417 raw NVDAx via Kipseli › Meteora DLMM › Whirlpool; sellers' 3 raw → $676.10 via Raydium CLMM.
      </div>
    </SceneFade>
  );
};

/* ── T08 · agents and Blinks ───────────────────────────────────────────── */
export const T08: React.FC = () => {
  const s = useS();
  return (
    <SceneFade>
      <Ground />
      <Title eyebrow="Agents and Blinks" text="Five MCP tools. Two write, and both are capped in code." />
      <Terminal data={mcp} x={120} y={290} width={1080} height={700} typeFor={1} showFor={12} title="npm run mcp:check · a real MCP client, reading every write back from devnet" font={20} />
      <div style={{ position: 'absolute', left: 1260, top: 300 }}><BlinkCard card={blink} from={s(12)} /></div>
    </SceneFade>
  );
};

/* ── T09 · check it yourself ───────────────────────────────────────────── */
export const T09: React.FC = () => {
  const s = useS();
  const end = useIn(s(10), 20);
  return (
    <SceneFade outF={1}>
      <Ground />
      <Title eyebrow="Don't trust the page" text="Check the chain." color={C.positive} />
      <div style={{ position: 'absolute', left: 120, top: 280, width: 1680, display: 'flex', flexDirection: 'column', gap: 16, opacity: 1 - end }}>
        {[['Every receipt', 'links the print’s transaction, its signature check, and the memo beside the price'],
          ['session-bell', 'BeLLKXJwhSH6YXYQLc8xLd11GxJUvoaT1h9zCadymJv4'],
          ['session-cross', 'Crosf1CpgcEs6G6SiX2B7KMR4hxVcE2FGU2r53a3RK9K'],
          ['Open source', 'the programs, the keeper, the tests, the site']].map(([a, b], i) => <Line key={a} a={a} b={b} from={s(0.8 + i * 1.6)} />)}
      </div>
      <AbsoluteFill style={{ display: 'grid', placeItems: 'center', opacity: end }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 26 }}><Mark size={110} /><div style={{ font: `700 110px/1 ${SANS}`, letterSpacing: '0.12em', color: C.text }}>SESSION</div></div>
          <div style={{ marginTop: 44, font: `450 28px/1.6 ${MONO}`, color: C.muted }}>session-roan.vercel.app<br />github.com/iamdflame/session-protocol</div>
        </div>
      </AbsoluteFill>
    </SceneFade>
  );
};
const Line: React.FC<{ a: string; b: string; from: number }> = ({ a, b, from }) => {
  const p = useIn(from, 14);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 24, padding: '20px 24px', borderRadius: 14, background: C.surface, border: `1px solid ${C.borderStrong}`, opacity: p, transform: `translateX(${(1 - p) * 20}px)` }}>
      <div style={{ font: `650 28px/1.2 ${SANS}`, color: C.text }}>{a}</div>
      <div style={{ font: `450 26px/1.3 ${MONO}`, color: C.muted }}>{b}</div>
    </div>
  );
};

export const TECH = { T01, T02, T03, T04, T05, T06, T07, T08, T09 } as const;
void BrowserFrame; void Still;
