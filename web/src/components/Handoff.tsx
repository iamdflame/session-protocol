import { useEffect, useId, useRef, useState } from 'react';
import { fmtPctAbs } from '@/lib/data';
import s from './Handoff.module.css';

/**
 * The handoff, at one bell.
 *
 * Drag either side and watch what actually reaches a market. The matched part
 * is a ledger entry inside the vault; only the imbalance is ever a trade. This
 * is the mechanism the whole product rests on, so it is worth being able to
 * push on rather than read about.
 */

const ROUND_TRIPS_PER_YEAR = 504;   // two boundaries a day × 252 sessions

const DAY_START = 1000;
const NIGHT_FROM = 340;             // the sides badly mismatched
const NIGHT_TO = 940;               // and then nearly cleared

export function Handoff() {
  const [day, setDay] = useState(DAY_START);
  const [night, setNight] = useState(NIGHT_FROM);
  const wrap = useRef<HTMLDivElement>(null);
  const played = useRef(false);
  const intro = useRef<ReturnType<typeof setInterval> | null>(null);
  const id = useId();

  /**
   * One pass, on the way in: the two sides converge and the orange sliver that
   * reaches a market collapses. That is the whole argument, told in a second.
   *
   * It plays once and then rests. An endless drift would mean re-rendering two
   * sliders sixty times a second forever — measured at half the main thread on
   * a mid-range phone — to say something the first pass already said.
   */
  useEffect(() => {
    const el = wrap.current;
    if (!el || played.current) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setNight(NIGHT_TO);
      played.current = true;
      return;
    }

    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting || played.current) return;
      played.current = true;
      io.disconnect();

      // ~24 steps over 1.2s: smooth enough to read as motion, and a fixed,
      // finite amount of work rather than an open-ended frame loop.
      const STEPS = 24, MS = 50;
      let i = 0;
      intro.current = setInterval(() => {
        i++;
        const t = i / STEPS;
        const eased = 1 - Math.pow(1 - t, 3);
        setNight(Math.round(NIGHT_FROM + (NIGHT_TO - NIGHT_FROM) * eased));
        if (i >= STEPS && intro.current) clearInterval(intro.current);
      }, MS);
    }, { threshold: 0.35 });

    io.observe(el);
    return () => {
      io.disconnect();
      if (intro.current) clearInterval(intro.current);
    };
  }, []);

  // Any touch cancels a still-running intro, so the control never fights back.
  const stop = () => {
    played.current = true;
    if (intro.current) { clearInterval(intro.current); intro.current = null; }
  };

  const matched = Math.min(day, night);
  const imbalance = Math.abs(day - night);
  const larger = Math.max(day, night, 1);
  const internalShare = matched / larger;
  const marketShare = imbalance / larger;
  const buyer = day > night ? 'NIGHT' : 'DAY';

  return (
    <div className={s.wrap} ref={wrap}>
      <div className={s.stage}>
        <div className={s.lanes}>
          <Lane
            label="X.DAY" hint="wants to be flat at the bell" tone="day"
            value={day} max={1400}
            onChange={v => { stop(); setDay(v); }}
            id={`${id}-day`}
          />
          <Lane
            label="X.NIGHT" hint="wants to be long at the bell" tone="night"
            value={night} max={1400}
            onChange={v => { stop(); setNight(v); }}
            id={`${id}-night`}
          />
        </div>

        <div className={s.flow} aria-hidden="true">
          <div className={s.flowBar}>
            <div
              className={s.internal}
              style={{ flexGrow: Math.max(internalShare, 0.001) }}
            >
              <span>transferred inside the vault</span>
            </div>
            <div
              className={s.external}
              style={{ flexGrow: Math.max(marketShare, 0.001) }}
              data-tiny={marketShare < 0.08}
            >
              <span>to market</span>
            </div>
          </div>
        </div>

        <dl className={s.readout}>
          <div>
            <dt>Matched internally</dt>
            <dd className={`${s.big} num`}>{matched.toLocaleString()} <em>sh</em></dd>
            <dd className={s.sub}>{fmtPctAbs(internalShare, 1)} of the larger side</dd>
          </div>
          <div data-emph="true">
            <dt>Actually traded</dt>
            <dd className={`${s.big} num`}>{imbalance.toLocaleString()} <em>sh</em></dd>
            <dd className={s.sub}>
              {imbalance === 0
                ? 'nothing — the sides cleared'
                : `${buyer} buys the difference`}
            </dd>
          </div>
          <div>
            <dt>Round trips avoided</dt>
            <dd className={`${s.big} num`}>{ROUND_TRIPS_PER_YEAR}<em>/yr</em></dd>
            <dd className={s.sub}>on the matched part</dd>
          </div>
        </dl>
      </div>

      <p className={s.caption}>
        Holding only the day, in a brokerage account, means selling at every close and
        buying back at every open — about {ROUND_TRIPS_PER_YEAR} round trips a year, each
        one paying a spread. The reason nobody runs that trade is not that it is a bad
        idea. It is that the friction is larger than the edge.
      </p>
    </div>
  );
}

function Lane({
  label, hint, tone, value, max, onChange, id,
}: {
  label: string; hint: string; tone: 'day' | 'night';
  value: number; max: number; onChange: (v: number) => void; id: string;
}) {
  return (
    <div className={s.lane} data-tone={tone}>
      <div className={s.laneHead}>
        <label htmlFor={id} className={s.laneLabel}>{label}</label>
        <span className={`num ${s.laneVal}`}>{value.toLocaleString()} sh</span>
      </div>
      <p className={s.laneHint}>{hint}</p>
      <div className={s.track}>
        <div className={s.fill} style={{ width: `${(value / max) * 100}%` }} />
        <input
          id={id}
          type="range"
          min={0}
          max={max}
          step={10}
          value={value}
          onChange={e => onChange(Number(e.target.value))}
          aria-label={`${label} supply, in shares`}
          aria-valuetext={`${value.toLocaleString()} shares`}
          className={s.range}
        />
      </div>
    </div>
  );
}
