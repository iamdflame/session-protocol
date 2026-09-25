/* The visual kit: the site's own tokens, type and motion, for every scene. */
import React from 'react';
import {
  AbsoluteFill, Easing, continueRender, delayRender, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig,
} from 'remotion';

export const C = {
  bg: '#080A0D', surface: '#0D1014', raised: '#12161B', sunken: '#06080A',
  border: 'rgba(255,255,255,0.08)', borderStrong: 'rgba(255,255,255,0.14)',
  text: '#F3F5F7', muted: '#9AA3AE', faint: '#7A8390',
  day: '#4EA3FF', dayDeep: '#3F95EF', night: '#FF9B3D', nightDeep: '#D77807',
  positive: '#3DC26B', negative: '#E0497C', warn: '#F5B84B', sim: '#C9A2FF',
};
export const SANS = 'Geist, system-ui, sans-serif';
export const MONO = '"Geist Mono", ui-monospace, monospace';

/* Fonts: the site's own files, loaded before the first frame. */
if (typeof document !== 'undefined' && !(window as unknown as { __fonts?: boolean }).__fonts) {
  (window as unknown as { __fonts?: boolean }).__fonts = true;
  const h = delayRender('fonts');
  const faces = [
    new FontFace('Geist', `url(${staticFile('fonts/geist-latin-v5.woff2')}) format('woff2')`, { weight: '100 900' }),
    new FontFace('Geist', `url(${staticFile('fonts/geist-latin-ext-v5.woff2')}) format('woff2')`, { weight: '100 900', unicodeRange: 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+1E00-1E9F, U+20A0-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF' }),
    new FontFace('Geist Mono', `url(${staticFile('fonts/geist-mono-latin-v6.woff2')}) format('woff2')`, { weight: '100 900' }),
  ];
  Promise.all(faces.map((f) => f.load())).then((loaded) => {
    loaded.forEach((f) => document.fonts.add(f));
    continueRender(h);
  }).catch(() => continueRender(h));
}

export const ease = Easing.bezier(0.22, 1, 0.36, 1);
export const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/** 0→1 over `dur` frames starting at `from`, eased. */
export function useIn(from = 0, dur = 18) {
  const f = useCurrentFrame();
  return interpolate(f, [from, from + dur], [0, 1], { ...clamp, easing: ease });
}
/** 1→0 over `dur` frames ending at `to` (defaults to the sequence end). */
export function useOut(to?: number, dur = 12) {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const end = to ?? durationInFrames;
  return interpolate(f, [end - dur, end], [1, 0], { ...clamp, easing: Easing.in(Easing.cubic) });
}
export function useSpring(from = 0, cfg = { damping: 200, mass: 0.8 }) {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: f - from, fps, config: cfg });
}

/** Seconds → frames at the composition rate. */
export const useS = () => { const { fps } = useVideoConfig(); return (s: number) => Math.round(s * fps); };

/** The ground: near-black with the site's two glows and a faint grid. Static: this
    machine renders in software, and a background that moves costs every frame. */
export const Ground: React.FC<{ tone?: 'day' | 'night' | 'both'; grid?: boolean }> = ({ tone = 'both', grid = true }) => {
  const blue = tone !== 'night' ? 'rgba(78,163,255,0.13)' : 'transparent';
  const amber = tone !== 'day' ? 'rgba(255,155,61,0.10)' : 'transparent';
  return (
    <AbsoluteFill style={{
      background: `radial-gradient(900px 620px at 18% 12%, ${blue}, transparent 70%), radial-gradient(1000px 700px at 86% 92%, ${amber}, transparent 70%), ${C.bg}`,
      ...(grid && { backgroundImage: `radial-gradient(900px 620px at 18% 12%, ${blue}, transparent 70%), radial-gradient(1000px 700px at 86% 92%, ${amber}, transparent 70%), linear-gradient(rgba(255,255,255,0.018) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.018) 1px, transparent 1px)`, backgroundSize: 'auto, auto, 64px 64px, 64px 64px' }),
    }} />
  );
};

/** The honesty labels, exactly as the site shows them. */
export const Chip: React.FC<{ kind: 'devnet' | 'simulated' | 'onchain' | 'live' | 'mainnet' | 'plain'; children: React.ReactNode; size?: number }> = ({ kind, children, size = 20 }) => {
  const col = { devnet: C.sim, simulated: C.warn, onchain: C.positive, live: C.positive, mainnet: C.day, plain: C.muted }[kind];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: size * 0.45, padding: `${size * 0.3}px ${size * 0.6}px`, borderRadius: size * 0.35,
      border: `1px solid ${col}55`, background: `${col}14`, color: col, font: `600 ${size * 0.8}px/1 ${SANS}`, letterSpacing: '0.08em', textTransform: 'uppercase',
    }}>
      <span style={{ width: size * 0.34, height: size * 0.34, borderRadius: '50%', background: col }} />
      {children}
    </span>
  );
};

/** Big display text that rises in, word by word. */
export const Headline: React.FC<{ text: string; from?: number; size?: number; color?: string; weight?: number; max?: number; align?: 'left' | 'center'; stagger?: number }> = ({ text, from = 0, size = 76, color = C.text, weight = 620, max = 1400, align = 'left', stagger = 3 }) => {
  const f = useCurrentFrame();
  const words = text.split(' ');
  return (
    <div style={{ font: `${weight} ${size}px/1.08 ${SANS}`, letterSpacing: '-0.035em', color, maxWidth: max, textAlign: align }}>
      {words.map((w, i) => {
        const p = interpolate(f, [from + i * stagger, from + i * stagger + 16], [0, 1], { ...clamp, easing: ease });
        return <span key={i} style={{ display: 'inline-block', opacity: p, transform: `translateY(${(1 - p) * 0.35}em)`, marginRight: '0.24em' }}>{w}</span>;
      })}
    </div>
  );
};

export const Eyebrow: React.FC<{ children: React.ReactNode; color?: string; from?: number }> = ({ children, color = C.muted, from = 0 }) => {
  const p = useIn(from, 14);
  return <div style={{ font: `650 22px/1 ${SANS}`, letterSpacing: '0.16em', textTransform: 'uppercase', color, opacity: p, transform: `translateY(${(1 - p) * 8}px)` }}>{children}</div>;
};

/** A source line, always on screen with a figure. */
export const Source: React.FC<{ children: React.ReactNode; from?: number }> = ({ children, from = 0 }) => {
  const p = useIn(from, 16);
  return <div style={{ font: `450 19px/1.4 ${SANS}`, color: C.faint, opacity: p }}>Source: {children}</div>;
};

/** A lower third: who or what, and the honesty chip. */
export const LowerThird: React.FC<{ title: string; sub?: string; chips?: React.ReactNode; from?: number; to?: number }> = ({ title, sub, chips, from = 0, to }) => {
  const f = useCurrentFrame();
  const p = useIn(from, 16);
  const o = to ? interpolate(f, [to - 12, to], [1, 0], clamp) : 1;
  return (
    <div style={{ position: 'absolute', left: 80, bottom: 80, opacity: p * o, transform: `translateX(${(1 - p) * -30}px)` }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '18px 24px', background: 'rgba(8,10,13,0.88)', border: `1px solid ${C.borderStrong}`, borderRadius: 14 }}>
        <div style={{ font: `620 30px/1.1 ${SANS}`, color: C.text, letterSpacing: '-0.02em' }}>{title}</div>
        {sub && <div style={{ font: `450 21px/1.3 ${SANS}`, color: C.muted }}>{sub}</div>}
        {chips && <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>{chips}</div>}
      </div>
    </div>
  );
};

/** A highlight around a region of the frame, with an optional label. */
export const Callout: React.FC<{ x: number; y: number; w: number; h: number; label?: string; from?: number; to?: number; color?: string; labelSide?: 'top' | 'bottom' | 'right' }> = ({ x, y, w, h, label, from = 0, to, color = C.day, labelSide = 'top' }) => {
  const f = useCurrentFrame();
  const p = interpolate(f, [from, from + 14], [0, 1], { ...clamp, easing: ease });
  const o = to ? interpolate(f, [to - 10, to], [1, 0], clamp) : 1;
  const pad = 10;
  return (
    <div style={{ position: 'absolute', left: x - pad, top: y - pad, width: w + pad * 2, height: h + pad * 2, opacity: p * o }}>
      <div style={{ position: 'absolute', inset: 0, border: `3px solid ${color}`, borderRadius: 14, boxShadow: `0 0 0 6px ${color}22`, transform: `scale(${1.04 - p * 0.04})` }} />
      {label && (
        <div style={{
          position: 'absolute', ...(labelSide === 'top' ? { bottom: '100%', left: 0, marginBottom: 12 } : labelSide === 'bottom' ? { top: '100%', left: 0, marginTop: 12 } : { left: '100%', top: 0, marginLeft: 16 }),
          padding: '8px 14px', background: color, color: '#06080A', borderRadius: 8, font: `650 22px/1.1 ${SANS}`, whiteSpace: 'nowrap',
        }}>{label}</div>
      )}
    </div>
  );
};

/** Fade a whole scene in and out at its edges. */
export const SceneFade: React.FC<{ children: React.ReactNode; inF?: number; outF?: number }> = ({ children, inF = 10, outF = 10 }) => {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const o = interpolate(f, [0, inF, durationInFrames - outF, durationInFrames], [0, 1, 1, 0], clamp);
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};

/** The SESSION mark, the site's own geometry: a 24-hour ring carrying the real
    6.5-hour / 17.5-hour split, with 09:30 to 16:00 ET as the warm arc. */
export const Mark: React.FC<{ size?: number }> = ({ size = 64 }) => (
  <svg width={size} height={size} viewBox="0 0 32 32">
    <path d="M 5.75 21.92 A 11.84 11.84 0 1 1 23.21 25.39" stroke="#3987e5" strokeWidth="4.96" strokeLinecap="round" fill="none" />
    <path d="M 23.21 25.39 A 11.84 11.84 0 0 1 5.75 21.92" stroke="#d95926" strokeWidth="4.96" strokeLinecap="round" fill="none" />
  </svg>
);

export const fmtUsd = (n: number, d = 2) => `$${n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
