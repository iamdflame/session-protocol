/* The graphics: every figure is from the scripts' claims tables or from a real capture. */
import React from 'react';
import { AbsoluteFill, Img, OffthreadVideo, Series, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, MONO, SANS, clamp, ease, useIn } from './kit';

/* ── a browser window around real captures ─────────────────────────────── */

export const BrowserFrame: React.FC<{ url: string; children: React.ReactNode; width?: number; x?: number; y?: number; from?: number }> = ({ url, children, width = 1600, x, y, from = 0 }) => {
  const p = useIn(from, 20);
  const h = width * 9 / 16 + 52;
  return (
    <div style={{
      position: 'absolute', left: x ?? (1920 - width) / 2, top: y ?? (1080 - h) / 2, width, height: h, borderRadius: 18, overflow: 'hidden',
      border: `1px solid ${C.borderStrong}`, background: C.surface, boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
      opacity: p, transform: `translateY(${(1 - p) * 40}px) scale(${0.97 + p * 0.03})`,
    }}>
      <div style={{ height: 52, display: 'flex', alignItems: 'center', gap: 10, padding: '0 20px', background: C.raised, borderBottom: `1px solid ${C.border}` }}>
        {['#FF5F57', '#FEBC2E', '#28C840'].map((c) => <span key={c} style={{ width: 13, height: 13, borderRadius: '50%', background: c, opacity: 0.85 }} />)}
        <div style={{ marginLeft: 24, flex: 1, maxWidth: 720, height: 32, borderRadius: 9, background: C.sunken, border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', padding: '0 14px', font: `450 18px/1 ${SANS}`, color: C.muted }}>
          <span style={{ color: C.positive, marginRight: 8 }}>●</span>{url}
        </div>
      </div>
      <div style={{ position: 'relative', width, height: width * 9 / 16, overflow: 'hidden', background: C.bg }}>{children}</div>
    </div>
  );
};

type Cam = { at: number; cx: number; cy: number; zoom: number };
/** A 4K still with an eased camera: centre (0–1 of the image) and zoom (1 = the image's width fills the box) per keyframe second. */
export const Still: React.FC<{ src: string; imgW: number; imgH: number; box: { w: number; h: number }; cams: Cam[] }> = ({ src, imgW, imgH, box, cams }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = f / fps;
  const at = cams.map((c) => c.at);
  const v = (k: 'cx' | 'cy' | 'zoom') => (cams.length === 1 ? cams[0][k] : interpolate(t, at, cams.map((c) => c[k]), { ...clamp, easing: ease }));
  const zoom = v('zoom');
  const w = box.w * zoom;
  const h = w * imgH / imgW;
  const left = box.w / 2 - v('cx') * w;
  const top = box.h / 2 - v('cy') * h;
  return <Img src={staticFile(src)} style={{ position: 'absolute', left, top, width: w, height: h }} />;
};

/** True when frames are rendered one by one here: recordings are composited later by ffmpeg. */
export const NO_VIDEO = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('novideo') === '1';

/** A captured recording, cut into segments (seconds in the source), played back to back. */
export const Clip: React.FC<{ src: string; segments: { from: number; to: number; rate?: number }[] }> = ({ src, segments }) => {
  const { fps } = useVideoConfig();
  if (NO_VIDEO) return <AbsoluteFill style={{ background: '#0A0C10' }} />;
  return (
    <Series>
      {segments.map((s, i) => {
        const rate = s.rate ?? 1;
        const len = Math.round(((s.to - s.from) / rate) * fps);
        return (
          <Series.Sequence key={i} durationInFrames={len}>
            <OffthreadVideo src={staticFile(src)} trimBefore={Math.round(s.from * fps)} trimAfter={Math.round(s.to * fps)} playbackRate={rate} muted
              style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </Series.Sequence>
        );
      })}
    </Series>
  );
};

/* ── the terminal, replaying real captured lines ───────────────────────── */

type TermData = { command: string; lines: { t: number; text: string }[] };
export const Terminal: React.FC<{
  data: TermData; pick?: (text: string) => boolean; width?: number; height?: number; x?: number; y?: number;
  from?: number; typeFor?: number; showFor?: number; title?: string; font?: number;
}> = ({ data, pick, width = 1240, height = 680, x, y, from = 0, typeFor = 1.1, showFor = 6, title, font = 22 }) => {
  const f = useCurrentFrame() - from;
  const { fps } = useVideoConfig();
  const lines = pick ? data.lines.filter((l) => pick(l.text)) : data.lines;
  const typed = Math.floor(interpolate(f, [0, typeFor * fps], [0, data.command.length], clamp));
  const revealStart = (typeFor + 0.35) * fps;
  // real order, real gaps, compressed to fit `showFor` seconds
  const span = Math.max(0.001, (lines[lines.length - 1]?.t ?? 1) - (lines[0]?.t ?? 0));
  const shown = lines.filter((l) => f >= revealStart + ((l.t - lines[0].t) / span) * showFor * fps).length;
  const lineH = font * 1.55;
  const visible = Math.floor((height - 110) / lineH);
  const first = Math.max(0, shown - visible);
  const p = useIn(from, 16);
  const color = (s: string) => /\bFAIL|failed|error/i.test(s) && !/0 failed/.test(s) ? C.negative : /test result: ok|passed|\bok\b|✓/.test(s) ? C.positive : C.text;
  return (
    <div style={{
      position: 'absolute', left: x ?? (1920 - width) / 2, top: y ?? (1080 - height) / 2, width, height, borderRadius: 16, overflow: 'hidden',
      background: '#07090C', border: `1px solid ${C.borderStrong}`, boxShadow: '0 20px 40px rgba(0,0,0,0.45)', opacity: p, transform: `translateY(${(1 - p) * 30}px)`,
    }}>
      <div style={{ height: 46, display: 'flex', alignItems: 'center', gap: 9, padding: '0 18px', background: C.raised, borderBottom: `1px solid ${C.border}` }}>
        {['#FF5F57', '#FEBC2E', '#28C840'].map((c) => <span key={c} style={{ width: 12, height: 12, borderRadius: '50%', background: c, opacity: 0.8 }} />)}
        <span style={{ marginLeft: 16, font: `500 17px/1 ${SANS}`, color: C.faint }}>{title ?? 'session-protocol'}</span>
      </div>
      <div style={{ padding: '22px 26px', font: `450 ${font}px/${lineH}px ${MONO}`, color: C.text, whiteSpace: 'pre', overflow: 'hidden' }}>
        <div><span style={{ color: C.day }}>$ </span>{data.command.slice(0, typed)}{typed < data.command.length && <span style={{ background: C.text, opacity: f % 30 < 15 ? 1 : 0 }}> </span>}</div>
        {lines.slice(first, shown).map((l, i) => (
          <div key={first + i} style={{ color: color(l.text), overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.text}</div>
        ))}
      </div>
    </div>
  );
};

/* ── the week: 168 hours, the price made in 32.5 of them ───────────────── */

export const Week: React.FC<{ from?: number }> = ({ from = 0 }) => {
  const f = useCurrentFrame() - from;
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const cell = 9.6, gap = 1.6, rowH = 70;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {days.map((d, di) => (
        <div key={d} style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
          <div style={{ width: 70, font: `600 22px/1 ${SANS}`, color: C.muted }}>{d}</div>
          <div style={{ display: 'flex', gap }}>
            {Array.from({ length: 24 * 2 }, (_, hh) => {
              const hour = hh / 2; // ET half-hours
              const open = di < 5 && hour >= 9.5 && hour < 16;
              const idx = di * 48 + hh;
              const p = interpolate(f, [idx * 0.12, idx * 0.12 + 10], [0, 1], { ...clamp, easing: ease });
              return <div key={hh} style={{ width: cell, height: rowH * 0.62, borderRadius: 3, background: open ? C.day : `${C.night}`, opacity: (open ? 1 : 0.34) * p }} />;
            })}
          </div>
        </div>
      ))}
    </div>
  );
};

/* ── horizontal comparison bars ────────────────────────────────────────── */

export const Bars: React.FC<{ rows: { label: string; value: number; text: string; color: string }[]; max: number; from?: number; width?: number }> = ({ rows, max, from = 0, width = 900 }) => {
  const f = useCurrentFrame() - from;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
      {rows.map((r, i) => {
        const p = interpolate(f, [i * 8, i * 8 + 28], [0, 1], { ...clamp, easing: ease });
        return (
          <div key={r.label} style={{ display: 'grid', gridTemplateColumns: '300px 1fr', alignItems: 'center', gap: 24 }}>
            <div style={{ font: `550 32px/1.1 ${SANS}`, color: C.muted }}>{r.label}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
              <div style={{ width: Math.max(8, (r.value / max) * width * p), height: 56, borderRadius: 10, background: r.color }} />
              <div style={{ font: `600 40px/1 ${MONO}`, color: C.text, opacity: p }}>{r.text}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

/* ── a checklist that ticks itself, for the drills ─────────────────────── */

export const Checklist: React.FC<{ title: string; items: { text: string; at: number; tone?: 'ok' | 'hold' | 'info' }[]; from?: number; width?: number }> = ({ title, items, from = 0, width = 760 }) => {
  const f = useCurrentFrame() - from;
  const { fps } = useVideoConfig();
  const p = useIn(from, 16);
  return (
    <div style={{ width, padding: '28px 32px', borderRadius: 20, background: C.surface, border: `1px solid ${C.borderStrong}`, opacity: p, transform: `translateY(${(1 - p) * 24}px)` }}>
      <div style={{ font: `650 30px/1.1 ${SANS}`, color: C.text, marginBottom: 22, letterSpacing: '-0.02em' }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {items.map((it) => {
          const q = interpolate(f, [it.at * fps, it.at * fps + 12], [0, 1], { ...clamp, easing: ease });
          const col = it.tone === 'hold' ? C.warn : it.tone === 'info' ? C.day : C.positive;
          return (
            <div key={it.text} style={{ display: 'flex', alignItems: 'center', gap: 16, opacity: q, transform: `translateX(${(1 - q) * 20}px)` }}>
              <div style={{ width: 34, height: 34, borderRadius: '50%', border: `2px solid ${col}`, background: `${col}22`, display: 'grid', placeItems: 'center', color: col, font: `700 20px/1 ${SANS}`, flexShrink: 0 }}>
                {it.tone === 'hold' ? '‖' : it.tone === 'info' ? '•' : '✓'}
              </div>
              <div style={{ font: `500 26px/1.25 ${SANS}`, color: C.text }}>{it.text}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/* ── the bell mechanism: two sides meet at one price ───────────────────── */

export const Netting: React.FC<{ from?: number; buyers?: number; sellers?: number; price?: string }> = ({ from = 0, buyers = 1205, sellers = 675, price = '$224.13' }) => {
  const f = useCurrentFrame() - from;
  const { fps } = useVideoConfig();
  const s = (x: number) => x * fps;
  const pIn = interpolate(f, [0, s(0.8)], [0, 1], { ...clamp, easing: ease });
  const meet = interpolate(f, [s(1.6), s(3.2)], [0, 1], { ...clamp, easing: ease });
  const maker = interpolate(f, [s(3.6), s(4.8)], [0, 1], { ...clamp, easing: ease });
  const W = 1300, H = 64;
  const scale = W / Math.max(buyers, sellers) * 0.9;
  const bw = buyers * scale, sw = sellers * scale, matched = Math.min(buyers, sellers) * scale;
  return (
    <div style={{ position: 'relative', width: W, height: 330, opacity: pIn }}>
      <div style={{ position: 'absolute', top: 0, left: 0, font: `600 24px/1 ${SANS}`, color: C.day }}>BUYERS · {`$${buyers.toLocaleString()}`}</div>
      <div style={{ position: 'absolute', top: 40, left: 0, width: bw, height: H, borderRadius: 10, background: `linear-gradient(90deg, ${C.day}, ${C.dayDeep})` }} />
      <div style={{ position: 'absolute', top: 150, left: 0, font: `600 24px/1 ${SANS}`, color: C.night }}>SELLERS · {`$${sellers.toLocaleString()}`}</div>
      <div style={{ position: 'absolute', top: 190, left: (1 - meet) * (W - sw), width: sw, height: H, borderRadius: 10, background: `linear-gradient(90deg, ${C.nightDeep}, ${C.night})` }} />
      {/* the matched part, then the makers' fill */}
      <div style={{ position: 'absolute', top: 32, left: 0, width: matched, height: 230, borderRadius: 12, border: `2px dashed ${C.positive}`, opacity: meet, display: 'flex', alignItems: 'flex-end', padding: 12 }}>
        <span style={{ font: `650 22px/1 ${SANS}`, color: C.positive, background: C.bg, padding: '4px 8px', borderRadius: 6 }}>NETTED · NO FEE</span>
      </div>
      <div style={{ position: 'absolute', top: 190, left: matched + 6, width: (bw - matched - 6) * maker, height: H, borderRadius: 10, background: `repeating-linear-gradient(45deg, ${C.warn}, ${C.warn} 10px, ${C.warn}aa 10px, ${C.warn}aa 20px)`, opacity: maker }} />
      <div style={{ position: 'absolute', top: 272, left: matched + 6, font: `600 22px/1 ${SANS}`, color: C.warn, opacity: maker, whiteSpace: 'nowrap' }}>MAKERS FILL THE REST · FEE CAPPED BY THE BACKSTOP</div>
      <div style={{ position: 'absolute', right: 0, top: -6, padding: '10px 18px', borderRadius: 12, border: `1px solid ${C.borderStrong}`, background: C.surface, font: `650 30px/1 ${MONO}`, color: C.text, opacity: meet }}>ONE PRICE · {price}</div>
    </div>
  );
};

/* ── boxes and arrows ──────────────────────────────────────────────────── */

export const Box: React.FC<{ x: number; y: number; w: number; h: number; title: string; sub?: string; color?: string; from?: number; mono?: boolean }> = ({ x, y, w, h, title, sub, color = C.borderStrong, from = 0, mono }) => {
  const p = useIn(from, 16);
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, borderRadius: 16, background: C.surface, border: `2px solid ${color}`, padding: '18px 22px', opacity: p, transform: `scale(${0.94 + p * 0.06})` }}>
      <div style={{ font: `650 28px/1.15 ${mono ? MONO : SANS}`, color: C.text, letterSpacing: mono ? 0 : '-0.02em' }}>{title}</div>
      {sub && <div style={{ marginTop: 10, font: `450 20px/1.35 ${SANS}`, color: C.muted }}>{sub}</div>}
    </div>
  );
};

export const Arrow: React.FC<{ x1: number; y1: number; x2: number; y2: number; from?: number; color?: string; label?: string }> = ({ x1, y1, x2, y2, from = 0, color = C.faint, label }) => {
  const f = useCurrentFrame();
  const p = interpolate(f, [from, from + 18], [0, 1], { ...clamp, easing: ease });
  const len = Math.hypot(x2 - x1, y2 - y1);
  const ang = Math.atan2(y2 - y1, x2 - x1);
  return (
    <svg style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }} width={1} height={1}>
      <line x1={x1} y1={y1} x2={x1 + Math.cos(ang) * len * p} y2={y1 + Math.sin(ang) * len * p} stroke={color} strokeWidth={3} strokeDasharray="1 0" />
      {p > 0.95 && <polygon points="0,-8 16,0 0,8" fill={color} transform={`translate(${x2},${y2}) rotate(${(ang * 180) / Math.PI}) translate(-16,0)`} />}
      {label && <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 12} fill={C.muted} fontSize={19} fontFamily="Geist" textAnchor="middle" opacity={p}>{label}</text>}
    </svg>
  );
};

/* ── the Blink card, as /api/bell-action serves it ─────────────────────── */

export const BlinkCard: React.FC<{ card: { title: string; description: string; label: string; links: { actions: { label: string }[] } }; from?: number }> = ({ card, from = 0 }) => {
  const p = useIn(from, 18);
  return (
    <div style={{ width: 620, borderRadius: 22, overflow: 'hidden', background: '#101418', border: `1px solid ${C.borderStrong}`, opacity: p, transform: `translateY(${(1 - p) * 30}px)`, boxShadow: '0 16px 36px rgba(0,0,0,0.45)' }}>
      <div style={{ height: 250, background: `radial-gradient(420px 220px at 30% 30%, ${C.day}33, transparent), radial-gradient(420px 220px at 75% 75%, ${C.night}2e, transparent), ${C.bg}`, display: 'grid', placeItems: 'center' }}>
        <svg width={120} height={120} viewBox="0 0 32 32">
          <path d="M 5.75 21.92 A 11.84 11.84 0 1 1 23.21 25.39" stroke="#3987e5" strokeWidth="4.96" strokeLinecap="round" fill="none" />
          <path d="M 23.21 25.39 A 11.84 11.84 0 0 1 5.75 21.92" stroke="#d95926" strokeWidth="4.96" strokeLinecap="round" fill="none" />
        </svg>
      </div>
      <div style={{ padding: '22px 26px 26px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ font: `450 17px/1 ${SANS}`, color: C.faint }}>session-roan.vercel.app</div>
        <div style={{ font: `650 28px/1.15 ${SANS}`, color: C.text }}>{card.title}</div>
        <div style={{ font: `450 18px/1.45 ${SANS}`, color: C.muted, display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{card.description}</div>
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          {card.links.actions.slice(0, 2).map((a) => (
            <div key={a.label} style={{ flex: 1, padding: '14px 0', textAlign: 'center', borderRadius: 12, background: C.day, color: '#06080A', font: `650 21px/1 ${SANS}` }}>{a.label}</div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1, padding: '14px 16px', borderRadius: 12, border: `1px solid ${C.borderStrong}`, color: C.faint, font: `450 19px/1 ${SANS}` }}>Dollars, up to $1,000</div>
          <div style={{ padding: '14px 22px', borderRadius: 12, background: C.day, color: '#06080A', font: `650 21px/1 ${SANS}` }}>Buy</div>
        </div>
      </div>
    </div>
  );
};

export const Dim: React.FC<{ opacity?: number }> = ({ opacity = 0.55 }) => <AbsoluteFill style={{ background: `rgba(8,10,13,${opacity})` }} />;
