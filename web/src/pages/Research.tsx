import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { VolBars } from '@/components/charts/VolBars';
import { Reveal } from '@/components/Reveal';
import {
  useMarkets, useStudy, useSimulation, useFreshness, useFunding, fmtPct, fmtPctAbs,
  type StudyAsset, type StudyFile,
} from '@/lib/data';
import { useViewport } from '@/lib/session';
import s from './Research.module.css';

type SortKey = 'symbol' | 'nightVol' | 'gap' | 'nightT';

/** |t| thresholds, Newey–West corrected — the study's own convention. */
const stars = (t: number) => {
  const a = Math.abs(t);
  return a > 2.58 ? '***' : a > 1.96 ? '**' : a > 1.64 ? '*' : '';
};

/**
 * What the study is as of, and whether that is current.
 *
 * A research page that prints a t-statistic without saying when it was
 * measured is asking to be believed rather than checked. The numbers above
 * come from a file; this says which file, off how many bars, how old — and,
 * when the collector has stopped, says *that* rather than presenting a stale
 * figure as a live one.
 */
function Freshness({ state }: { state: ReturnType<typeof useFreshness> }) {
  if (state.status !== 'ready') {
    // A clone that has never run the pipeline has no freshness file at all.
    // Saying nothing is better than claiming a currency we cannot show.
    return null;
  }
  const f = state.data;
  const snapMs = Date.parse(f.snapshot);
  const ageH = (Date.now() - snapMs) / 3_600_000;
  // A collector that has not run for a day has left the study behind the
  // market. Two days is the cadence the batch pipeline used to manage.
  const behind = ageH > 24;
  return (
    <p className={s.freshness} data-behind={behind}>
      Measured from <span className="num">{f.bars.toLocaleString()}</span> hourly closes
      across <span className="num">{f.assets}</span> assets, the newest{' '}
      <time dateTime={f.snapshot}>{ago(ageH)}</time>.
      {behind
        ? <> The collector has not run since then, so every figure below is as of that
          bar and not as of now.</>
        : <> Recomputed when a bar arrives, so the figures below are the ones the
          data supports right now.</>}
    </p>
  );
}

/** Hours as something a person reads, erring shorter rather than rounding up. */
function ago(hours: number): string {
  if (hours < 1.5) return 'within the hour';
  if (hours < 36) return `${Math.floor(hours)} hours ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/**
 * The rate the vault charges, beside the difference it is charging for.
 *
 * `k = 2,500 bps` capped at 50 bp a boundary are reasoned defaults, not fitted
 * ones, and REBUILD §5.7 is blunt that only a live book calibrates them. The
 * honest thing is to publish the prior and the outcome together and let the
 * gap be visible, rather than print a funding rate as though somebody had
 * already checked it.
 */
function FundingVsPrior({ study, funding }: {
  study: StudyFile | null | undefined;
  funding: ReturnType<typeof useFunding>;
}) {
  if (funding.status !== 'ready' || !study) return null;
  const paid = funding.data.bells.filter(b => b.rateBps !== null);

  // The study's own pooled per-hour figures; NIGHT minus DAY is the thing
  // funding exists to price.
  const pooled = study.pooled as { night?: { meanPerHour?: number }; day?: { meanPerHour?: number } } | undefined;
  const nightBp = (pooled?.night?.meanPerHour ?? 0) * 1e4;
  const dayBp = (pooled?.day?.meanPerHour ?? 0) * 1e4;
  const spreadBp = nightBp - dayBp;

  return (
    <section className={`shell ${s.section}`} id="funding">
      <Reveal>
        <p className="eyebrow">Calibration</p>
        <h2 className={`display ${s.h2}`}>What the vault charged, and what it was charging for.</h2>
        <p className={`lead ${s.sectionLead}`}>
          Funding prices <strong>crowding</strong>, not returns: the larger class pays the
          smaller one to come back towards balance, whichever way the market happened to go.
          So it will not track the study&rsquo;s measured spread and is not meant to. What the
          study gives is a <strong>scale</strong> — across every asset and hour here, the two
          sessions differed by <span className="num">{spreadBp.toFixed(2)}</span> bp an hour.
          A funding rate far above that is charging more for balance than the sessions are
          worth apart, which is the only way to tell that a coefficient nobody has fitted is
          set too high.
        </p>
      </Reveal>

      <Reveal delay={60}>
        {paid.length === 0 ? (
          <p className={s.fundingNote}>
            No boundary has charged funding yet. It is zero while one class has no holders —
            there is nobody to pay and nobody to pay them — which is not the same as a
            balanced book, and the vault page says which it is.
          </p>
        ) : (
          <table className={s.fundingTable}>
            <thead>
              <tr>
                <th scope="col">Boundary</th>
                <th scope="col">Settled</th>
                <th scope="col">Payer</th>
                <th scope="col" className={s.num}>Rate</th>
                <th scope="col" className={s.num}>Per hour</th>
              </tr>
            </thead>
            <tbody>
              {paid.map(b => {
                /* A boundary is roughly one session. Dividing the per-boundary
                   rate by its hours is the only way to compare it with a
                   study measured per hour. */
                const hours = b.exposed === 'day' ? 6.5 : 17.5;
                return (
                  <tr key={b.boundary}>
                    <th scope="row" className={s.num}>#{b.boundary}</th>
                    <td>
                      {b.bellTs
                        ? new Date(b.bellTs * 1000).toISOString().slice(0, 16).replace('T', ' ')
                        : <span title="the settlement event does not carry the bell it settled">
                            cranked {new Date(b.crankedTs * 1000).toISOString().slice(0, 16).replace('T', ' ')}
                          </span>}
                    </td>
                    <td>{b.payer === 'night' ? 'NIGHT pays DAY' : 'DAY pays NIGHT'}</td>
                    <td className={s.num}>{(b.rateBps! / 100).toFixed(2)}%</td>
                    <td className={s.num}>{(b.rateBps! / hours).toFixed(2)} bp</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Reveal>

      <Reveal delay={100}>
        <p className={s.fundingNote}>
          One vault and {paid.length === 1 ? 'one boundary' : `${paid.length} boundaries`} is
          not a calibration — it is the first point on a curve. The coefficient moves when
          there are twenty live sessions to fit it against, through{' '}
          <code className="mono">set_params</code> and within the caps the program already
          enforces. Until then the rate is a reasoned default and this table is the evidence
          against it, not for it.
        </p>
      </Reveal>
    </section>
  );
}

export default function Research() {
  const study = useStudy();
  const markets = useMarkets();
  const sim = useSimulation();
  const fresh = useFreshness();
  const funding = useFunding();
  const head = markets.data?.headline;
  const [sort, setSort] = useState<SortKey>('gap');

  const equities = useMemo(() => {
    const rows = [...(study.data?.equities ?? [])];
    rows.sort((a, b) => {
      switch (sort) {
        case 'symbol': return a.symbol.localeCompare(b.symbol);
        case 'nightVol': return b.night.stdev - a.night.stdev;
        case 'nightT': return Math.abs(b.night.t) - Math.abs(a.night.t);
        default: return (b.night.stdev - b.day.stdev) - (a.night.stdev - a.day.stdev);
      }
    });
    return rows;
  }, [study.data, sort]);

  const controls = study.data?.controls ?? [];

  return (
    <div className={s.page}>
      {/* ── header ──────────────────────────────────────────────────────── */}
      <header className={`shell ${s.head}`}>
        <p className="eyebrow">The evidence</p>
        <h1 className={`display ${s.title}`}>
          We looked for the overnight anomaly. It isn&rsquo;t there.
        </h1>
        <p className={`lead ${s.lead}`}>
          The literature says US equities earn almost all of their return between
          the close and the open. If that survived on-chain, X.NIGHT would be an
          obvious buy and this page would be a sales pitch. It does not survive,
          and this page is the measurement instead.
        </p>

        {head && (
          <dl className={s.summary}>
            {[
              [head.closes.toLocaleString(), 'hourly closes', 'Every pool print we could reconstruct'],
              [`${head.equities} + ${head.assets - head.equities}`, 'equities + controls', 'Listed names, plus deliberate negatives'],
              [`${head.spanDays}`, 'days of history', 'The full window these pools have existed'],
              [`${head.significant}`, `significant of ${head.equities}`, 'At |t| > 1.96, either direction'],
            ].map(([v, k, hint]) => (
              <div key={k} title={hint}>
                <dt className={`num ${s.sumVal}`}>{v}</dt>
                <dd className={s.sumKey}>{k}</dd>
              </div>
            ))}
          </dl>
        )}

        <Freshness state={fresh} />
      </header>

      {/* ── the null result ─────────────────────────────────────────────── */}
      <section className={`shell ${s.section}`} id="result">
        <Reveal>
          <h2 className={`display ${s.h2}`}>The return result is null.</h2>
          {head ? (
            <>
              <p className={`lead ${s.sectionLead}`}>
                Across {head.equities} tokenized equities and {head.spanDays} days, the
                overnight stretch compounded to {fmtPctAbs(head.nightCum, 2)} and the
                regular session to {fmtPctAbs(head.dayCum, 2)} — the day marginally ahead.
                Only {head.significant} asset{head.significant === 1 ? '' : 's'} in the set
                reached <span className="mono">|t| &gt; 1.96</span> in either direction.
              </p>
              <p className={`lead ${s.sectionLead}`}>
                We are reporting that as a null result rather than mining it. Roughly{' '}
                {Math.round(head.sessions / head.assets)} sessions per asset, in books this
                thin, is exactly the kind of data that will produce a story if you ask it
                enough questions.
              </p>
            </>
          ) : (
            <div className={s.leadSkeleton}>
              <div className="skeleton" style={{ width: '90%', height: 16 }} />
              <div className="skeleton" style={{ width: '76%', height: 16 }} />
            </div>
          )}
        </Reveal>
      </section>

      {/* ── the risk result ─────────────────────────────────────────────── */}
      <section className={`${s.section} ${s.sunken}`} id="volatility">
        <div className="shell">
          <Reveal>
            <p className="eyebrow">What did survive</p>
            <h2 className={`display ${s.h2}`}>The risk is not null at all.</h2>
            {head && (
              <p className={`lead ${s.sectionLead}`}>
                The overnight session carries{' '}
                <strong className={s.emph}>{Math.round((head.volRatio - 1) * 100)}% more
                volatility</strong> than the regular one — {fmtPctAbs(head.nightVol)} against{' '}
                {fmtPctAbs(head.dayVol)} in standard deviation of session returns — and it is
                the wider of the two in {head.nightMoreVolatile} of {head.equities}. Same
                money, same expected return, materially more variance.
              </p>
            )}
          </Reveal>

          <Reveal delay={60}>
            <div className={`card ${s.chartCard}`}>
              <VolBars />
            </div>
          </Reveal>

          <Reveal delay={100}>
            <p className={s.why}>
              <strong>Why this is structural, not a quirk of the sample.</strong> A DAY
              holder is only exposed while the underlying is trading, so they can always
              trade out ahead of a gap. A NIGHT holder cannot — they wear every gap in
              full, by construction. The asymmetry is a property of the clock, not of
              these {head?.spanDays ?? 235} days.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ── the table ───────────────────────────────────────────────────── */}
      <section className={`shell ${s.section}`} id="assets">
        <Reveal>
          <div className={s.tableHead}>
            <div>
              <p className="eyebrow">Every asset</p>
              <h2 className={`display ${s.h2}`}>All of it, including what disagrees.</h2>
            </div>
            <label className={s.sort}>
              <span className="sr-only">Sort the table</span>
              <select value={sort} onChange={e => setSort(e.target.value as SortKey)}>
                <option value="gap">Widest volatility gap</option>
                <option value="nightVol">Most volatile night</option>
                <option value="nightT">Strongest night t-statistic</option>
                <option value="symbol">Symbol, A–Z</option>
              </select>
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path d="M4 6.5 8 10.5l4-4" fill="none" stroke="currentColor"
                      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </label>
          </div>
        </Reveal>

        {study.status === 'error' ? (
          <div className={s.error} role="alert">
            <p>The study file did not load, so there is nothing here to show you.</p>
            <button className={s.retry} onClick={() => window.location.reload()}>Reload</button>
          </div>
        ) : study.status === 'loading' ? (
          <TableSkeleton />
        ) : (
          <StatsTable rows={equities} caption="Listed equities" />
        )}
      </section>

      {/* ── controls ────────────────────────────────────────────────────── */}
      <section className={`${s.section} ${s.sunken}`} id="controls">
        <div className="shell">
          <Reveal>
            <p className="eyebrow">Controls</p>
            <h2 className={`display ${s.h2}`}>Things that should not have a session.</h2>
            <p className={`lead ${s.sectionLead}`}>
              A session effect that shows up everywhere is a bug in the measurement.
              So the set includes assets with no NYSE session to be driven by: gold,
              and five pre-IPO names whose companies are private and have no listed
              stock at all. If the split were an artifact of the clock, of liquidity
              patterns, or of when Americans are awake, it would appear here too.
            </p>
          </Reveal>

          <Reveal delay={60}>
            {study.status === 'ready'
              ? <StatsTable rows={controls} caption="Controls" showKind />
              : <TableSkeleton rows={6} />}
          </Reveal>

          <Reveal delay={100}>
            <p className={s.why}>
              <strong>Read the controls sceptically too.</strong> A pre-IPO token still
              trades more actively during US waking hours, so &ldquo;no session&rdquo;
              does not mean &ldquo;no time-of-day structure&rdquo;. What it does mean is
              that any effect here cannot be an arbitrage against a closing bell, because
              there is no bell.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ── what happens when it cannot pay ─────────────────────────────── */}
      <section className={`${s.section} ${s.sunken}`} id="simulation">
        <div className="shell">
          <Reveal>
            <p className="eyebrow">Adversarial</p>
            <h2 className={`display ${s.h2}`}>What the program does when it cannot pay.</h2>
            <p className={`lead ${s.lead}`}>
              The measurement above says the night is wider. The question that follows is
              what a vault does on the night it is wider than the class holding it can
              absorb. That is not answered by a backtest — it is answered by running the
              program against a year of deliberately hostile activity and counting how
              often it stops.
            </p>
          </Reveal>

          {sim.status === 'ready' && sim.data ? (
            <Reveal>
              <div className={s.simGrid}>
                <div className={s.simStat}>
                  <span className={`num ${s.simBig}`}>{sim.data.runs}</span>
                  <span className={s.simLabel}>simulated years</span>
                </div>
                <div className={s.simStat}>
                  {/* Scheduled, not settled: a halted run ends there, so the
                      product is the upper bound rather than a count. */}
                  <span className={`num ${s.simBig}`}>
                    {(sim.data.runs * sim.data.bells_per_run).toLocaleString()}
                  </span>
                  <span className={s.simLabel}>boundaries scheduled</span>
                </div>
                <div className={s.simStat}>
                  <span className={`num ${s.simBig}`}>{sim.data.halts}</span>
                  <span className={s.simLabel}>years that halted</span>
                </div>
                <div className={s.simStat}>
                  <span className={`num ${s.simBig}`}>
                    {(sim.data.halt_rate * 100).toFixed(0)}<span className={s.simUnit}>%</span>
                  </span>
                  <span className={s.simLabel}>of years, at least once</span>
                </div>
              </div>
              <p className={s.simNote}>
                Each run is {sim.data.bells_per_run} bells of random mints, redemptions,
                partially-filled handoffs and moves of up to 3% per boundary, from a fixed
                seed. A <strong>halt is the answer, not the failure</strong>: it is the
                program refusing to settle something it cannot pay, and every halted run is
                asserted to be <em>solvent at the moment it stopped</em> — which is the
                entire reason for stopping before applying a settlement rather than after.
                A run ends at its first halt — so the {(sim.data.runs * sim.data.bells_per_run).toLocaleString()} above
                is the schedule rather than a tally, and {sim.data.halts} of {sim.data.runs} is the share of years in
                which the vault stops once, not a rate per boundary. The
                same test fails if <em>no</em> run ever halts, because a simulation gentle
                enough to never trip a guard has not tested one.
              </p>
              <p className={s.simNote}>
                Published by the test that runs it, into{' '}
                <code className="mono">data/sim-report.json</code>, and regenerated by CI on
                every change — so the number on this page is from the last run rather than
                from the last time somebody wrote a number on a page.
              </p>
            </Reveal>
          ) : (
            <p className={s.simNote}>
              The halt rate is generated by{' '}
              <code className="mono">cargo test -p session --test simulation</code> into{' '}
              <code className="mono">data/sim-report.json</code>.
            </p>
          )}
        </div>
      </section>

      {/* ── what the vault charged, against what the study measured ─────── */}
      <FundingVsPrior study={study.data} funding={funding} />

      {/* ── method ──────────────────────────────────────────────────────── */}
      <section className={`shell ${s.section}`} id="method">
        <Reveal>
          <p className="eyebrow">Method</p>
          <h2 className={`display ${s.h2}`}>How this was measured.</h2>
        </Reveal>

        <div className={s.method}>
          {[
            {
              h: 'Prices',
              b: <>Hourly closes reconstructed from Solana pool history. Every request is
                  pinned to the token&rsquo;s mint, because these tokens are frequently the{' '}
                  <em>quote</em> side of their pool and an unpinned query returns the other
                  token&rsquo;s price — which is how an earlier pass handed one company&rsquo;s
                  chart to another. Where several pools hold an asset, the median across them
                  is used rather than any single venue&rsquo;s quote.</>,
            },
            {
              h: 'Attribution',
              b: <>Each interval is assigned to the session it lies entirely within, using the
                  same calendar module the on-chain program settles against — integer date
                  arithmetic, no timezone database, correct through DST, holidays and early
                  closes. Intervals that straddle a boundary are <strong>dropped</strong>,
                  not split.</>,
            },
            {
              h: 'What that costs us',
              b: <>The 16:00 ET close lands on the hour and is clean. The 09:30 open does not,
                  so the 09:00–10:00 interval always straddles and is always dropped —
                  removing the first thirty minutes of every day session. That is the exact
                  window in which the mechanism would predict a snap-back, so if this biases
                  anything it biases <em>against</em> the day.</>,
            },
            {
              h: 'Bad prints',
              b: head ? (
                <>These are thin pools, and a fill against a stale quote can put one close
                  10% away from its neighbours with the next bar putting it straight back.
                  Such bars are removed at the price level, before any return is attributed —{' '}
                  <span className="num">{head.spikesDropped}</span> of{' '}
                  <span className="num">{head.barsTotal.toLocaleString()}</span> closes, or{' '}
                  {((head.spikesDropped / Math.max(1, head.barsTotal)) * 100).toFixed(3)}%.
                  The threshold scales with each asset&rsquo;s own median hourly move, so a
                  3× leveraged ETF is not punished for being volatile.</>
              ) : <>Single-bar spikes that reverse are removed before any return is attributed.</>,
            },
            {
              h: 'Statistics',
              b: <>t-statistics are Newey–West corrected for autocorrelation and
                  heteroskedasticity. Stars are <span className="mono">*** |t|&gt;2.58</span>,{' '}
                  <span className="mono">** |t|&gt;1.96</span>,{' '}
                  <span className="mono">* |t|&gt;1.64</span>. A cumulative return is not
                  evidence on its own; the t-statistic is what to read.</>,
            },
            {
              h: 'What this does not establish',
              b: <>That any of it holds at size, or forward. The window is short, the books
                  are thin, and none of these venues is the primary market for the names
                  they track. Treat it as a measurement of these pools over these days, not
                  as a claim about equities.</>,
            },
          ].map((m, i) => (
            <Reveal key={m.h} delay={i * 40}>
              <article className={s.methodItem}>
                <h3 className={s.methodTitle}>{m.h}</h3>
                <p className={s.methodBody}>{m.b}</p>
              </article>
            </Reveal>
          ))}
        </div>

        <Reveal>
          <div className={s.repro}>
            <p>
              Everything here is reproducible from the repository:{' '}
              <code className="mono">npm run data</code> rebuilds the price history,{' '}
              <code className="mono">npm run study</code> recomputes every figure on this
              page, and <code className="mono">npm test</code> runs the 156 Rust tests and
              seven TypeScript suites that pin the calendar, the settlement maths and the
              event layouts to each other.
            </p>
            <Link to="/how-it-works" className={s.reproLink}>How the vault itself works →</Link>
          </div>
        </Reveal>
      </section>
    </div>
  );
}

/* ── table ───────────────────────────────────────────────────────────────── */

/** Lower-case sigma, immune to the header's uppercase transform — which
    would otherwise print Σ, the summation sign, over a column of standard
    deviations. */
const Sigma = () => <span style={{ textTransform: 'none' }}>σ</span>;

function StatsTable({
  rows, caption, showKind = false,
}: { rows: StudyAsset[]; caption: string; showKind?: boolean }) {
  // On a phone the σ·t pairs are hidden (see the module's 640px rule), so the
  // group headers above them span one column instead of two. Same breakpoint,
  // so the two never disagree.
  const narrow = useViewport() < 640;
  const span = narrow ? 1 : 2;

  if (!rows.length) {
    return <p className={s.empty}>No assets in this group.</p>;
  }
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
                {showKind && (
                  <td className={s.kind}>{r.kind === 'private' ? 'pre-IPO' : 'commodity'}</td>
                )}

                <td className={`num ${s.right}`}>
                  <span data-series="night" className={s.cum}>{fmtPct(r.night.cumulative, 1)}</span>
                </td>
                <td className={`num ${s.right} ${s.stat}`}>
                  {(r.night.stdev * 100).toFixed(2)}
                  <span className={s.statSep}>·</span>
                  <span className={s.tStat}>{r.night.t.toFixed(2)}<sup>{stars(r.night.t)}</sup></span>
                </td>

                <td className={`num ${s.right}`}>
                  <span data-series="day" className={s.cum}>{fmtPct(r.day.cumulative, 1)}</span>
                </td>
                <td className={`num ${s.right} ${s.stat}`}>
                  {(r.day.stdev * 100).toFixed(2)}
                  <span className={s.statSep}>·</span>
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

function TableSkeleton({ rows = 12 }: { rows?: number }) {
  return (
    <div className={s.tableWrap} aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={s.skelRow} style={{ opacity: 1 - i * 0.055 }}>
          <div className="skeleton" style={{ width: 78, height: 13 }} />
          <div className="skeleton" style={{ width: 62, height: 13 }} />
          <div className="skeleton" style={{ width: 84, height: 13 }} />
          <div className="skeleton" style={{ width: 62, height: 13 }} />
          <div className="skeleton" style={{ width: 84, height: 13 }} />
        </div>
      ))}
      <span className="sr-only">Loading the study</span>
    </div>
  );
}
