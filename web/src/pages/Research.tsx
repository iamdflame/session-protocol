/* ───────────────────────────────────────────────────────────────────────────
   /research — the measurement, read like a terminal rather than an essay.

   The question, the four numbers that bound it, the finding and the risk as
   figures, and one chart that shows every asset. Everything else — how the
   data was cleaned, how returns were attributed, the controls, the stress
   test, the funding calibration, what none of it establishes, and how to
   reproduce it — sits in sections a reader opens when they want it.

   Every figure is read from the published study files. Nothing is typed in.
   ─────────────────────────────────────────────────────────────────────────── */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  useMarkets, useStudy, useSimulation, useFreshness, useFunding, fmtPct, fmtPctAbs,
  type StudyAsset, type StudyFile,
} from '@/lib/data';
import { useViewport } from '@/lib/session';
import { SessionDumbbell, type Metric } from '@/components/charts/SessionDumbbell';
import { Segmented } from '@/components/ui/Segmented';
import { Source } from '@/components/ui/Source';
import { Status } from '@/components/ui/Status';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import s from './Research.module.css';

type SortKey = 'symbol' | 'nightVol' | 'gap' | 'nightT';

/** |t| thresholds, Newey–West corrected — the study's own convention. */
const stars = (t: number) => {
  const a = Math.abs(t);
  return a > 2.58 ? '***' : a > 1.96 ? '**' : a > 1.64 ? '*' : '';
};

function ago(hours: number): string {
  if (hours < 1.5) return 'within the hour';
  if (hours < 36) return `${Math.floor(hours)} hours ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/** A section a reader opens. Deep links (#method) open it and scroll to it. */
function Section({ id, title, summary, children }: { id: string; title: string; summary: ReactNode; children: ReactNode }) {
  return (
    <details className={s.section} id={id}>
      <summary className={s.sumRow}>
        <h3 className={s.secTitle}>{title}</h3>
        <span className={s.secSummary}>{summary}</span>
        <Icon name="chevronDown" size={16} aria-hidden="true" />
      </summary>
      <div className={s.secBody}>{children}</div>
    </details>
  );
}

export default function Research() {
  const study = useStudy();
  const markets = useMarkets();
  const sim = useSimulation();
  const fresh = useFreshness();
  const funding = useFunding();
  const head = markets.data?.headline;
  const [metric, setMetric] = useState<Metric>('return');
  const location = useLocation();
  const root = useRef<HTMLDivElement>(null);

  // Old links point at sections that are now collapsed: open the one named.
  useEffect(() => {
    const id = location.hash.slice(1);
    if (!id) return;
    const el = root.current?.querySelector<HTMLDetailsElement>(`details#${CSS.escape(id)}`);
    if (el) { el.open = true; requestAnimationFrame(() => el.scrollIntoView({ block: 'start' })); }
  }, [location.hash, study.status]);

  const snapshot = fresh.status === 'ready' ? fresh.data : null;
  const ageH = snapshot ? (Date.now() - Date.parse(snapshot.snapshot)) / 3_600_000 : null;

  return (
    <div className={s.page} ref={root}>
      {/* ── the question ────────────────────────────────────────────────── */}
      <header className={s.head}>
        <div className={s.eyebrowRow}>
          <span className={s.eyebrow}>SESSION research</span>
          <Source kind="study" detail="study.json and markets.json, published with the site" ageSec={ageH !== null ? ageH * 3600 : undefined} />
          {ageH !== null && ageH > 24 && <Status kind="stale" label={`Snapshot ${ago(ageH)}`} />}
        </div>
        <h1 className={s.title}>Does the overnight premium survive when the night becomes tradeable?</h1>
        <p className={s.answer}>
          <strong>No.</strong> Hour for hour, the overnight stretch earns no more than the regular session
          {head ? <>, and only {head.significant} of {head.equities} assets show a session return distinguishable from zero</> : null}.
          What survives is the <strong>risk</strong>: the night is much wider.
        </p>
      </header>

      {/* ── four numbers ────────────────────────────────────────────────── */}
      <dl className={s.stats} aria-label="The data">
        {head ? [
          [head.closes.toLocaleString(), 'hourly closes'],
          [String(head.assets), 'tokenized assets'],
          [String(head.equities), 'equities analysed'],
          [String(head.spanDays), 'days of history'],
        ].map(([v, k]) => (
          <div key={k}>
            <dd className={`num ${s.statVal}`}>{v}</dd>
            <dt className={s.statKey}>{k}</dt>
          </div>
        )) : Array.from({ length: 4 }, (_, i) => <div key={i}><div className="skeleton" style={{ width: 110, height: 36 }} /></div>)}
      </dl>

      {/* ── the finding and the risk ────────────────────────────────────── */}
      <div className={s.findings} data-tour="research">
        <section className={s.panel} aria-labelledby="finding-h">
          <span className={s.panelEyebrow}>Key finding</span>
          <h2 className={s.panelTitle} id="finding-h">NIGHT does not outperform DAY</h2>
          {head ? (
            <div className={s.figures}>
              <div>
                <span className={`num ${s.fig}`} data-sign={head.spreadBpPerHour < 0 ? 'neg' : 'pos'}>
                  {head.spreadBpPerHour < 0 ? '−' : '+'}{Math.abs(head.spreadBpPerHour).toFixed(2)}<span className={s.figUnit}> bp/h</span>
                </span>
                <span className={s.figKey}>NIGHT minus DAY, pooled mean per hour</span>
              </div>
              <div>
                <span className={`num ${s.fig}`}>{head.nightWins}<span className={s.figUnit}> / {head.equities}</span></span>
                <span className={s.figKey}>assets where NIGHT earned more per hour</span>
                <span className={s.wins} aria-hidden="true">
                  {Array.from({ length: head.equities }, (_, i) => <i key={i} data-on={i < head.nightWins || undefined} />)}
                </span>
              </div>
              <div>
                <span className={`num ${s.fig}`}>{head.significant}<span className={s.figUnit}> / {head.equities}</span></span>
                <span className={s.figKey}>reach |t| &gt; 1.96 in either session</span>
              </div>
            </div>
          ) : <div className="skeleton" style={{ height: 120 }} />}
        </section>

        <section className={s.panel} data-risk aria-labelledby="risk-h">
          <span className={s.panelEyebrow}>What survives</span>
          <h2 className={s.panelTitle} id="risk-h">Risk</h2>
          {head ? (
            <>
              <div className={s.riskRows}>
                {([['night', head.nightVol], ['day', head.dayVol]] as const).map(([c, v]) => (
                  <div key={c} className={s.riskRow} data-cls={c}>
                    <b>{c.toUpperCase()}</b>
                    <span className={s.riskTrack}><span style={{ width: `${(v / Math.max(head.nightVol, head.dayVol)) * 100}%` }} /></span>
                    <span className={`num ${s.riskVal}`}>{fmtPctAbs(v)}</span>
                  </div>
                ))}
              </div>
              <p className={s.riskLine}>
                <span className={`num ${s.fig}`}>+{Math.round((head.volRatio - 1) * 100)}%</span>
                <span className={s.figKey}>
                  more volatility per NIGHT session, and the wider of the two in <b className="num">{head.nightMoreVolatile}</b> of {head.equities} assets.
                  A NIGHT holder wears every gap in full; a DAY holder never holds across one.
                </span>
              </p>
            </>
          ) : <div className="skeleton" style={{ height: 120 }} />}
        </section>
      </div>

      {/* ── every asset ─────────────────────────────────────────────────── */}
      <section className={s.chartCard} id="assets" aria-labelledby="assets-h">
        <header className={s.chartHead}>
          <div>
            <h2 className={s.chartTitle} id="assets-h">DAY against NIGHT, per asset</h2>
            <p className={s.chartSub}>Hover or tab to a row for both sessions&rsquo; figures, their t-statistics and sample sizes.</p>
          </div>
          <Segmented<Metric>
            label="Measure" value={metric} onChange={setMetric}
            items={[{ value: 'return', label: 'Return' }, { value: 'risk', label: 'Risk' }]}
          />
        </header>
        {study.status === 'ready' ? (
          <>
            <SessionDumbbell rows={study.data.equities} metric={metric} label={`${metric === 'return' ? 'Mean return per hour' : 'Volatility per session'}, NIGHT against DAY, for ${study.data.equities.length} tokenized equities`} />
            <div className={s.controlsChart}>
              <h3 className={s.subTitle}>Controls <span>— assets with no NYSE session to follow</span></h3>
              <SessionDumbbell rows={study.data.controls} metric={metric} label={`The same measure for ${study.data.controls.length} control assets`} />
            </div>
          </>
        ) : study.status === 'error' ? (
          <div className={s.error} role="alert">
            <p>The study file did not load, so there is nothing to chart.</p>
            <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>Reload</Button>
          </div>
        ) : <div className="skeleton" style={{ height: 520 }} aria-busy="true" />}
      </section>

      {/* ── the depth, on request ───────────────────────────────────────── */}
      <div className={s.sections}>
        <Section id="result" title="Finding" summary={head ? <>Per hour DAY is {Math.abs(head.spreadBpPerHour).toFixed(2)} bp ahead; compounded over far more hours NIGHT is {fmtPctAbs(head.nightCum, 2)} to {fmtPctAbs(head.dayCum, 2)} — neither significant</> : 'The null result'}>
          {head && (
            <>
              <p>
                Across {head.equities} tokenized equities and {head.spanDays} days, the overnight stretch compounded to{' '}
                <b className="num">{fmtPctAbs(head.nightCum, 2)}</b> and the regular session to <b className="num">{fmtPctAbs(head.dayCum, 2)}</b> —
                but a NIGHT runs about 17.5 hours against DAY&rsquo;s 6.5, and weekends and holidays are NIGHT too. Hour for hour,
                NIGHT earned <b className="num">{Math.abs(head.spreadBpPerHour).toFixed(2)} bp</b> {head.spreadBpPerHour < 0 ? 'less' : 'more'} than DAY.
                Only {head.significant} of the {head.equities} reached <span className="mono">|t| &gt; 1.96</span> in either session.
              </p>
              <p>
                This is reported as a null result rather than mined. About {Math.round(head.sessions / head.assets)} sessions per asset,
                in books this thin, is exactly the kind of data that will produce a story if you ask it enough questions.
              </p>
              <p>
                <b>Why the risk result is structural, not a quirk of the sample.</b> A DAY holder is only exposed while the underlying
                trades, so they can always trade out ahead of a gap; a NIGHT holder cannot, and wears every gap in full. The asymmetry is
                a property of the clock, not of these {head.spanDays} days.
              </p>
            </>
          )}
        </Section>

        <Section id="data" title="Data" summary={head ? <>{head.barsTotal.toLocaleString()} closes, {head.spikesDropped} bad prints removed{snapshot && ageH !== null ? <> · newest {ago(ageH)}</> : null}</> : 'Hourly pool closes'}>
          <p>
            Hourly closes reconstructed from Solana pool history (GeckoTerminal). Every request is pinned to the token&rsquo;s mint,
            because these tokens are often the <em>quote</em> side of their pool and an unpinned query returns the other token&rsquo;s
            price. Where several pools hold an asset, the median across them is used rather than any single venue&rsquo;s quote.
          </p>
          {head && (
            <p>
              <b>Bad prints.</b> These are thin pools, and a fill against a stale quote can put one close 10% from its neighbours with
              the next bar putting it straight back. Such bars are removed at the price level before any return is attributed —{' '}
              <b className="num">{head.spikesDropped}</b> of <b className="num">{head.barsTotal.toLocaleString()}</b> closes
              ({((head.spikesDropped / Math.max(1, head.barsTotal)) * 100).toFixed(3)}%). The threshold scales with each asset&rsquo;s own
              median hourly move, so a leveraged ETF is not punished for being volatile.
            </p>
          )}
          {snapshot && ageH !== null && (
            <p className={s.fresh} data-behind={ageH > 24 || undefined}>
              Measured from <b className="num">{snapshot.bars.toLocaleString()}</b> hourly closes across <b className="num">{snapshot.assets}</b> assets,
              the newest <time dateTime={snapshot.snapshot}>{ago(ageH)}</time>.{' '}
              {ageH > 24 ? 'The collector has not run since then, so every figure here is as of that bar, not as of now.' : 'Recomputed when a bar arrives.'}
            </p>
          )}
          <StatsBlock study={study.data ?? null} status={study.status} />
        </Section>

        <Section id="method" title="Method" summary="Session attribution on the program's own calendar; Newey–West t-statistics">
          <p>
            <b>Attribution.</b> Each interval is assigned to the session it lies entirely within, using the same calendar module the
            on-chain program settles against — integer date arithmetic, no timezone database, correct through DST, holidays and early
            closes. Intervals that straddle a boundary are <b>dropped</b>, not split.
          </p>
          <p>
            <b>What that costs.</b> The 16:00 ET close lands on the hour and is clean. The 09:30 open does not, so the 09:00–10:00
            interval always straddles and is always dropped — removing the first thirty minutes of every day session. That is the window
            in which the mechanism would predict a snap-back, so if this biases anything it biases <em>against</em> the day.
          </p>
          <p>
            <b>Statistics.</b> t-statistics are Newey–West corrected for autocorrelation and heteroskedasticity. Stars are{' '}
            <span className="mono">*** |t|&gt;2.58</span>, <span className="mono">** |t|&gt;1.96</span>, <span className="mono">* |t|&gt;1.64</span>.
            A cumulative return is not evidence on its own; the t-statistic is what to read. Returns are compared per hour, so a 17.5-hour
            NIGHT and a 6.5-hour DAY are measured like for like.
          </p>
        </Section>

        <Section id="controls" title="Controls" summary={study.data ? <>{study.data.controls.length} assets with no NYSE session: gold and pre-IPO names</> : 'Negative controls'}>
          <p>
            A session effect that shows up everywhere is a bug in the measurement. So the set includes assets with no NYSE session to be
            driven by: gold, and pre-IPO names whose companies have no listed stock at all. If the split were an artifact of the clock, of
            liquidity patterns or of when Americans are awake, it would appear here too.
          </p>
          <p>
            <b>Read them sceptically too.</b> A pre-IPO token still trades more during US waking hours, so &ldquo;no session&rdquo; does
            not mean &ldquo;no time-of-day structure&rdquo;. It does mean any effect here cannot be an arbitrage against a closing bell,
            because there is no bell.
          </p>
          {study.status === 'ready' && <StatsTable rows={study.data.controls} caption="Controls" showKind />}
        </Section>

        <Section
          id="simulation" title="Stress test"
          summary={sim.status === 'ready' && sim.data ? <>{sim.data.halts} of {sim.data.runs} hostile simulated years halted once — every one solvent when it stopped</> : 'Adversarial simulation of the program'}
        >
          {sim.status === 'ready' && sim.data ? (
            <>
              <dl className={s.simGrid}>
                <div><dd className="num">{sim.data.runs}</dd><dt>simulated years</dt></div>
                <div><dd className="num">{(sim.data.runs * sim.data.bells_per_run).toLocaleString()}</dd><dt>boundaries scheduled</dt></div>
                <div><dd className="num">{sim.data.halts}</dd><dt>years that halted</dt></div>
                <div><dd className="num">{(sim.data.halt_rate * 100).toFixed(0)}%</dd><dt>of years, at least once</dt></div>
              </dl>
              <p>
                Each run is {sim.data.bells_per_run} bells of random mints, redemptions, partially filled handoffs and moves of up to 3%
                per boundary, from a fixed seed. A <b>halt is the answer, not the failure</b>: the program refusing to settle something it
                cannot pay, and every halted run is asserted solvent at the moment it stopped. A run ends at its first halt, so the
                boundaries above are the schedule rather than a tally, and {sim.data.halts} of {sim.data.runs} is a share of years, not a
                rate per boundary. The same test fails if <em>no</em> run halts — a simulation too gentle to trip a guard has not tested one.
              </p>
              <p className={s.muted}>
                Published by the test that runs it (<span className="mono">cargo test -p session --test simulation</span>) into{' '}
                <span className="mono">data/sim-report.json</span>, regenerated by CI on every change.
              </p>
            </>
          ) : (
            <p>
              The halt rate is generated by <span className="mono">cargo test -p session --test simulation</span> into{' '}
              <span className="mono">data/sim-report.json</span>, which did not load here.
            </p>
          )}
        </Section>

        <Section id="funding" title="Calibration" summary="What the vault charged, against what the study measured">
          <FundingVsPrior study={study.data} funding={funding} head={head ?? null} />
        </Section>

        <Section id="limitations" title="Limitations" summary="A measurement of these pools over these days — not a claim about equities">
          <p>
            That any of it holds at size, or forward, is not established. The window is short, the books are thin, and none of these
            venues is the primary market for the names they track. Treat it as a measurement of these pools over these days.
          </p>
          <p>
            The DAY/NIGHT figures are measured on the tokens&rsquo; own pools, not on the underlying stocks; the NVDAx vault on devnet
            settles against a stand-in feed, and the OPENAI vault against an operator-posted reading. None of it is evidence about how
            a mainnet vault would have performed.
          </p>
        </Section>

        <Section id="reproduce" title="Reproducibility" summary={<span className="mono">npm run data · npm run study · npm test</span>}>
          <p>
            Everything here is reproducible from the repository: <span className="mono">npm run data</span> rebuilds the price history,{' '}
            <span className="mono">npm run study</span> recomputes every figure on this page, and <span className="mono">npm test</span> runs
            the Rust and TypeScript suites that pin the calendar, the settlement maths and the event layouts to each other.
          </p>
          <p><Link to="/how-it-works" className={s.link}>How the vault itself works <Icon name="chevronRight" size={12} /></Link></p>
        </Section>
      </div>
    </div>
  );
}

/* ── the full table, and the calibration ─────────────────────────────────── */

function StatsBlock({ study, status }: { study: StudyFile | null; status: 'loading' | 'ready' | 'error' }) {
  const [sort, setSort] = useState<SortKey>('gap');
  const rows = useMemo(() => {
    const out = [...(study?.equities ?? [])];
    out.sort((a, b) => {
      switch (sort) {
        case 'symbol': return a.symbol.localeCompare(b.symbol);
        case 'nightVol': return b.night.stdev - a.night.stdev;
        case 'nightT': return Math.abs(b.night.t) - Math.abs(a.night.t);
        default: return (b.night.stdev - b.day.stdev) - (a.night.stdev - a.day.stdev);
      }
    });
    return out;
  }, [study, sort]);
  if (status === 'error') return <p className={s.muted}>The study file did not load.</p>;
  if (status !== 'ready') return <div className="skeleton" style={{ height: 240 }} aria-busy="true" />;
  return (
    <div className={s.tableBlock}>
      <div className={s.tableTools}>
        <b>Every equity, every figure</b>
        <label className={s.sort}>
          <span className="sr-only">Sort the table</span>
          <select value={sort} onChange={e => setSort(e.target.value as SortKey)}>
            <option value="gap">Widest volatility gap</option>
            <option value="nightVol">Most volatile night</option>
            <option value="nightT">Strongest night t-statistic</option>
            <option value="symbol">Symbol, A–Z</option>
          </select>
          <Icon name="chevronDown" size={12} aria-hidden="true" />
        </label>
      </div>
      <StatsTable rows={rows} caption="Listed equities" />
    </div>
  );
}

/** Lower-case sigma, immune to an uppercase transform that would print Σ. */
const Sigma = () => <span style={{ textTransform: 'none' }}>σ</span>;

function StatsTable({ rows, caption, showKind = false }: { rows: StudyAsset[]; caption: string; showKind?: boolean }) {
  // On a phone the σ·t pairs are hidden, so the group headers above them
  // span one column instead of two. Same breakpoint as the stylesheet.
  const narrow = useViewport() < 640;
  const span = narrow ? 1 : 2;
  if (!rows.length) return <p className={s.muted}>No assets in this group.</p>;
  return (
    <div className={s.tableWrap}>
      <table className={s.table}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Asset</th>
            {showKind && <th scope="col" className={s.kind}>Type</th>}
            <th scope="col" className={s.right} colSpan={span}>Night</th>
            <th scope="col" className={s.right} colSpan={span}>Day</th>
            <th scope="col" className={s.right}><Sigma /> gap</th>
            <th scope="col" className={`${s.right} ${s.n}`}>n</th>
          </tr>
          <tr className={s.subHead}>
            <th scope="col"><span className="sr-only">Symbol</span></th>
            {showKind && <th scope="col" className={s.kind} />}
            <th scope="col" className={s.right}>cum</th>
            <th scope="col" className={`${s.right} ${s.stat}`}><Sigma /> · t</th>
            <th scope="col" className={s.right}>cum</th>
            <th scope="col" className={`${s.right} ${s.stat}`}><Sigma /> · t</th>
            <th scope="col" className={s.right}><span className="sr-only">night minus day</span></th>
            <th scope="col" className={`${s.right} ${s.n}`}><span className="sr-only">sessions</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const gap = r.night.stdev - r.day.stdev;
            return (
              <tr key={r.symbol}>
                <th scope="row" className={`mono ${s.sym}`}>{r.symbol}</th>
                {showKind && <td className={s.kind}>{r.kind === 'private' ? 'pre-IPO' : 'commodity'}</td>}
                <td className={`num ${s.right}`}><span data-series="night" className={s.cum}>{fmtPct(r.night.cumulative, 1)}</span></td>
                <td className={`num ${s.right} ${s.stat}`}>
                  {(r.night.stdev * 100).toFixed(2)}<span className={s.statSep}>·</span>
                  <span className={s.tStat}>{r.night.t.toFixed(2)}<sup>{stars(r.night.t)}</sup></span>
                </td>
                <td className={`num ${s.right}`}><span data-series="day" className={s.cum}>{fmtPct(r.day.cumulative, 1)}</span></td>
                <td className={`num ${s.right} ${s.stat}`}>
                  {(r.day.stdev * 100).toFixed(2)}<span className={s.statSep}>·</span>
                  <span className={s.tStat}>{r.day.t.toFixed(2)}<sup>{stars(r.day.t)}</sup></span>
                </td>
                <td className={`num ${s.right} ${s.gap}`} data-wider={gap >= 0 ? 'night' : 'day'}>
                  {gap >= 0 ? '+' : '−'}{(Math.abs(gap) * 100).toFixed(2)}
                </td>
                <td className={`num ${s.right} ${s.n}`}>{r.night.n}/{r.day.n}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The rate the vault charges, beside the difference it is charging for.
 *
 * `k = 2,500 bps` capped at 50 bp a boundary are reasoned defaults, not fitted
 * ones, and only a live book calibrates them. The honest thing is to publish
 * the prior and the outcome together and let the gap be visible.
 */
function FundingVsPrior({ study, funding, head }: {
  study: StudyFile | null | undefined;
  funding: ReturnType<typeof useFunding>;
  head: { spreadBpPerHour: number } | null;
}) {
  if (funding.status !== 'ready' || !study) {
    return <p className={s.muted}>{funding.status === 'error' ? 'The funding record did not load.' : 'Reading the funding record…'}</p>;
  }
  const paid = funding.data.bells.filter(b => b.rateBps !== null);
  const spreadBp = head?.spreadBpPerHour ?? 0;
  return (
    <>
      <p>
        Funding prices <b>crowding</b>, not returns: the larger class pays the smaller one to come back towards balance, whichever
        way the market went. It will not track the study&rsquo;s spread and is not meant to. What the study gives is a{' '}
        <b>scale</b> — across every asset and hour here the two sessions differed by <b className="num">{Math.abs(spreadBp).toFixed(2)} bp</b> an
        hour. A funding rate far above that charges more for balance than the sessions are worth apart, which is the only way to tell
        that a coefficient nobody has fitted is set too high.
      </p>
      {paid.length === 0 ? (
        <p className={s.muted}>
          No boundary has charged funding yet. It is zero while one class has no holders — nobody to pay and nobody to pay them —
          which is not the same as a balanced book.
        </p>
      ) : (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <caption className="sr-only">Funding charged at each boundary</caption>
            <thead>
              <tr>
                <th scope="col">Boundary</th>
                <th scope="col">Settled (UTC)</th>
                <th scope="col">Payer</th>
                <th scope="col" className={s.right}>Rate</th>
                <th scope="col" className={s.right}>Per hour</th>
              </tr>
            </thead>
            <tbody>
              {paid.map(b => {
                // A boundary is roughly one session; per hour is the only way
                // to set it beside a study measured per hour.
                const hours = b.exposed === 'day' ? 6.5 : 17.5;
                return (
                  <tr key={b.boundary}>
                    <th scope="row" className="num">#{b.boundary}</th>
                    <td className="num">
                      {b.bellTs
                        ? new Date(b.bellTs * 1000).toISOString().slice(0, 16).replace('T', ' ')
                        : <span title="the settlement event does not carry the bell it settled">cranked {new Date(b.crankedTs * 1000).toISOString().slice(0, 16).replace('T', ' ')}</span>}
                    </td>
                    <td>{b.payer === 'night' ? 'NIGHT pays DAY' : 'DAY pays NIGHT'}</td>
                    <td className={`num ${s.right}`}>{(b.rateBps! / 100).toFixed(2)}%</td>
                    <td className={`num ${s.right}`}>{(b.rateBps! / hours).toFixed(2)} bp</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className={s.muted}>
        One vault and {paid.length === 1 ? 'one boundary' : `${paid.length} boundaries`} is not a calibration — it is the first point on
        a curve. The coefficient moves when there are twenty live sessions to fit it against, through <span className="mono">set_params</span> and
        within the caps the program already enforces.
      </p>
    </>
  );
}
