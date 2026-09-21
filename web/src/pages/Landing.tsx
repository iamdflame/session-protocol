import { Link } from 'react-router-dom';
import { SessionClock } from '@/components/SessionClock';
import { Reveal } from '@/components/Reveal';
import { Handoff } from '@/components/Handoff';
import { CurveChart } from '@/components/charts/CurveChart';
import { VolBars } from '@/components/charts/VolBars';
import { useSession, useClockSize, countdown, upcoming, etClock, SESSION_HOURS, NIGHT_SHARE } from '@/lib/session';
import { useCurve, useMarkets, fmtPctAbs, type Headline } from '@/lib/data';
import { useDevnets } from '@/lib/chain';
import s from './Landing.module.css';

/**
 * The figures quoted on this page, with the values that ship in the bundle as
 * the pre-load fallback. Both come from the same place: scripts/prepare-data.ts
 * derives them from the study, so the sentences below cannot drift from it.
 */
const FALLBACK: Headline = {
  assets: 26, equities: 20, closes: 83_322, sessions: 6_118, spanDays: 235,
  nightVol: 0.0278, dayVol: 0.0190, volRatio: 1.46, nightMoreVolatile: 18,
  nightCum: 0.0595, dayCum: 0.0636, significant: 2,
  spikesDropped: 38, barsTotal: 83_322,
};

/**
 * Three small pieces of this page are live. The rest is not.
 *
 * `useSession` ticks every second, so whichever component calls it re-renders
 * every second — and everything below it in the tree with it. Subscribing at
 * the page root meant re-reconciling two charts, twenty dumbbell rows and a
 * 260-point path once a second to move a countdown. So the subscription lives
 * in the three leaves that actually show the time.
 */
function HeroStatus() {
  const sess = useSession();
  return (
    <p className={s.status} data-holder={sess?.holder.toLowerCase()}>
      <span className={s.statusDot} aria-hidden="true" />
      {sess ? (
        <>
          <span className={s.statusLabel}>Market {sess.isOpen ? 'open' : 'closed'}</span>
          <span className={s.statusSep} aria-hidden="true">·</span>
          <span className={s.statusHolder}>{sess.holder} holds</span>
          <span className={s.statusSep} aria-hidden="true">·</span>
          <span className={`num ${s.statusTime}`}>{countdown(sess.until)}</span>
          <span className={s.statusLabel}>to the bell</span>
        </>
      ) : (
        <span className={s.statusLabel}>Reading the session clock…</span>
      )}
    </p>
  );
}

function HeroClock() {
  return <SessionClock size={useClockSize(380)} />;
}

/**
 * What is actually deployed, above the fold.
 *
 * A reader who scrolls no further should still leave knowing the live vault
 * is on devnet against stand-in mints and a SOL mark, because the alternative
 * is that they infer from a page full of NVDAx and real prices that the thing
 * holds NVDAx. It does not, and §2 of every honest review starts there.
 */
function ChainLine() {
  const all = useDevnets();
  const m = all?.[0] ?? null;
  if (all === undefined) return null;
  if (m === null) {
    return (
      <p className={s.chainLine}>
        <span className={s.chainDot} data-live="false" aria-hidden="true" />
        No vault is deployed. Every figure below is measured from real pool
        history; the vault pages run the settlement code locally.
      </p>
    );
  }
  return (
    <p className={s.chainLine}>
      <span className={s.chainDot} data-live="true" aria-hidden="true" />
      <span>
        <strong>{all.length === 1 ? 'One vault is' : `${all.length} vaults are`} live, on devnet.</strong>{' '}
        They run the real program — settlement, funding, the handoff, the auction — but
        devnet has no xStocks, no USDC and no pre-IPO tokens, so they hold{' '}
        <em>mints built to the same shape</em> and mark them with Pyth&rsquo;s{' '}
        <span className="mono">{m.markFeed}</span>. Nothing here holds NVDAx yet.{' '}
        <Link to="/how-it-works#status" className={s.chainLink}>The full line</Link>
      </span>
    </p>
  );
}

function UpNext() {
  const sess = useSession();
  const next = sess ? upcoming(sess.now, 4) : [];
  return (
    <div className={s.upNext}>
      <p className="eyebrow">Next four boundaries</p>
      <ul>
        {next.length
          ? next.map(b => (
              <li key={b.at}>
                <span className={s.upTo} data-holder={b.to.toLowerCase()}>{b.to}</span>
                <span className={s.upWhen}>{b.label}</span>
                <span className={`num ${s.upTime}`}>{etClock(b.at)}</span>
              </li>
            ))
          : Array.from({ length: 4 }, (_, i) => (
              <li key={i}>
                <span className="skeleton" style={{ width: 44, height: 10 }} />
                <span className="skeleton" style={{ width: 96, height: 10 }} />
                <span className="skeleton" style={{ width: 52, height: 10 }} />
              </li>
            ))}
      </ul>
    </div>
  );
}

function ClosingLine() {
  const sess = useSession();
  return (
    <>
      <h2 className={`display ${s.closeTitle}`}>
        {sess?.isOpen
          ? 'The session is running.'
          : 'The market is shut. The token is not.'}
      </h2>
      <p className={`lead ${s.sectionLead}`}>
        {sess?.isOpen
          ? `DAY is carrying the exposure for another ${countdown(sess.until)}. At the bell it hands the stock to NIGHT, and the gap begins.`
          : `NIGHT is carrying the exposure right now — ${sess ? countdown(sess.until) : '…'} until the opening bell hands it back. That stretch is what you have never been able to sell separately.`}
      </p>
    </>
  );
}

export default function Landing() {
  const markets = useMarkets();
  const STUDY = markets.data?.headline ?? FALLBACK;

  // The hero curve is a real asset, not a drawing: SPYx is the deepest pool in
  // the set, so it is the least noisy illustration of a real decomposition.
  const hero = useCurve('SPYx');

  return (
    <>
      {/* ── hero ──────────────────────────────────────────────────────────── */}
      <section className={s.hero}>
        <div className="grid-bg" aria-hidden="true" />
        <div className={`shell ${s.heroInner}`}>
          <div className={s.heroCopy}>
            <HeroStatus />

            <h1 className={`display ${s.title}`}>
              Own the day.<br />Or own the night.
            </h1>

            <p className={`lead ${s.lead}`}>
              A tokenized share trades twenty-four hours. The stock behind it trades
              for six and a half. Those are two different assets wearing one ticker —
              and until now you had to hold both.
            </p>

            {/* The study is the reason this exists, and burying it below the
                fold is how a measured result becomes decoration. One sentence,
                computed from the same file the research page plots. */}
            <p className={s.finding}>
              Across <span className="num">{STUDY.equities}</span> tokenized equities and{' '}
              <span className="num">{STUDY.sessions.toLocaleString()}</span> sessions, the night
              carries <strong><span className="num">{Math.round((STUDY.volRatio - 1) * 100)}%</span> more
              volatility</strong> than the day — and pays nothing extra for it.{' '}
              <Link to="/research" className={s.findingLink}>That is the whole argument for selling it</Link>
            </p>

            <ChainLine />

            <div className={s.actions}>
              <Link to="/markets" className={s.primary}>
                Open the markets
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path d="M3 8h9M8.5 4 12.5 8l-4 4" fill="none" stroke="currentColor"
                        strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </Link>
              <Link to="/research" className={s.secondary}>Read the study</Link>
            </div>

            <dl className={s.facts}>
              {[
                [`${STUDY.assets}`, 'tokenized assets measured'],
                [STUDY.closes.toLocaleString(), 'hourly closes'],
                [STUDY.sessions.toLocaleString(), 'sessions decomposed'],
              ].map(([v, k]) => (
                <div key={k}>
                  <dt className={`num ${s.factVal}`}>{v}</dt>
                  <dd className={s.factKey}>{k}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className={s.heroClock}>
            <HeroClock />
          </div>
          {/* A sibling, not a child of the clock column, so a narrow screen can
              put the schedule after the copy. The countdown is the product and
              earns the top of the page; four rows of reference timings do not,
              and on a phone they were pushing the one line that says what is
              actually deployed below the fold. */}
          <div className={s.heroSchedule}>
            <UpNext />
          </div>
        </div>
      </section>

      {/* ── the split ─────────────────────────────────────────────────────── */}
      <section className={s.section} id="split">
        <div className="shell">
          <Reveal>
            <p className="eyebrow">The split</p>
            <h2 className={`display ${s.h2}`}>
              One token in. Two tokens out.
            </h2>
            <p className={`lead ${s.sectionLead}`}>
              Deposit a tokenized share and the vault returns two claims on it. Each one
              earns the return of exactly one session and is flat through the other. No
              leverage, no synthetic exposure, no counterparty beyond the vault — the
              underlying never moves.
            </p>
          </Reveal>

          <div className={s.pair}>
            <Reveal delay={60}>
              <article className={s.token} data-class="day">
                <header>
                  <span className={s.tokenTag}>X.DAY</span>
                  <span className={`num ${s.tokenHours}`}>{SESSION_HOURS.day}h</span>
                </header>
                <h3 className={s.tokenTitle}>The regular session</h3>
                <p className={s.tokenBody}>
                  09:30 to 16:00 Eastern, when the real stock is trading and a mispricing
                  can be arbitraged away. This is equity exposure you can always get out
                  of — every minute you hold it, someone is quoting the underlying.
                </p>
                <ul className={s.tokenList}>
                  <li>Earns the intraday move, nothing else</li>
                  <li>Flat overnight, through weekends, through holidays</li>
                  <li>Never holds an unhedgeable gap</li>
                </ul>
              </article>
            </Reveal>

            <Reveal delay={120}>
              <article className={s.token} data-class="night">
                <header>
                  <span className={s.tokenTag}>X.NIGHT</span>
                  <span className={`num ${s.tokenHours}`}>{SESSION_HOURS.night}h</span>
                </header>
                <h3 className={s.tokenTitle}>Everything else</h3>
                <p className={s.tokenBody}>
                  The close-to-open gap, and the weekend, and the holiday. Earnings land
                  here. So does the news. It is the part of the week nobody could isolate,
                  because isolating it meant round-tripping the position twice a day.
                </p>
                <ul className={s.tokenList}>
                  <li>Earns the gap, and only the gap</li>
                  <li>Flat for the whole regular session</li>
                  <li>{Math.round(NIGHT_SHARE * 100)}% of every week</li>
                </ul>
              </article>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ── the handoff ───────────────────────────────────────────────────── */}
      <section className={`${s.section} ${s.sectionSunken}`} id="handoff">
        <div className="shell">
          <Reveal>
            <p className="eyebrow">Why it works here</p>
            <h2 className={`display ${s.h2}`}>
              The two sides are each other&rsquo;s counterparty.
            </h2>
            <p className={`lead ${s.sectionLead}`}>
              At every bell, one class wants to be flat at the exact moment the other
              wants to be long. In a brokerage account that is two round trips a day,
              roughly five hundred a year, and the spread eats the trade before it
              starts. Inside one vault it is a ledger entry. Only the difference in
              size ever has to touch a market.
            </p>
          </Reveal>
          <Reveal delay={80}><Handoff /></Reveal>
        </div>
      </section>

      {/* ── the finding ───────────────────────────────────────────────────── */}
      <section className={s.section} id="finding">
        <div className="shell">
          <Reveal>
            <p className="eyebrow">What the data says</p>
            <h2 className={`display ${s.h2}`}>
              The night is not paid for.
            </h2>
            <p className={`lead ${s.sectionLead}`}>
              The well-known result is that equities earn most of their return overnight.
              We went looking for it in {STUDY.equities} tokenized equities and did not
              find it: across {STUDY.spanDays} days the night returned{' '}
              {fmtPctAbs(STUDY.nightCum, 1)} and the day {fmtPctAbs(STUDY.dayCum, 1)} — the
              day slightly ahead, if anything — and only {STUDY.significant} of{' '}
              {STUDY.equities} assets reached significance in either direction. That is a
              null result and we are reporting it as one.
            </p>
            <p className={`lead ${s.sectionLead}`}>
              What did survive is the risk. The overnight stretch carries{' '}
              <strong className={s.emph}>{Math.round((STUDY.volRatio - 1) * 100)}% more
              volatility</strong> than the regular session — {fmtPctAbs(STUDY.nightVol)} against
              {' '}{fmtPctAbs(STUDY.dayVol)} — and it is the more volatile side in{' '}
              {STUDY.nightMoreVolatile} of {STUDY.equities}. Holding overnight has been
              a way to take materially more risk for the same money.
            </p>
          </Reveal>

          <Reveal delay={60}>
            <div className={s.findingGrid}>
              <div className={`card ${s.chartCard}`}>
                <header className={s.chartHead}>
                  <div>
                    <h3 className={s.chartTitle}>Session volatility, per asset</h3>
                    <p className={s.chartSub}>
                      Standard deviation of session returns. Longer bar, more risk borne.
                    </p>
                  </div>
                </header>
                <VolBars />
              </div>

              <div className={`card ${s.chartCard}`}>
                <header className={s.chartHead}>
                  <div>
                    <h3 className={s.chartTitle}>SPYx, decomposed</h3>
                    <p className={s.chartSub}>
                      One asset, split into the two sessions and compounded separately.
                      SPYx is the deepest pool in the set, so it is the least noisy
                      illustration — it has no vault. The one you can open is NVDAx.
                    </p>
                  </div>
                  {/* The chart is the clearest decomposition; the link is the only
                      vault on this page anyone can actually open. Labelling the
                      SPYx page "Open vault" was a button promising a thing that is
                      not there — that page runs the settlement locally and says so. */}
                  <Link to="/markets/NVDAx" className={s.chartLink}>Open the live vault</Link>
                </header>
                {hero.status === 'ready' ? (
                  <CurveChart points={hero.data.points} height={268} />
                ) : hero.status === 'error' ? (
                  <p className={s.chartError}>
                    The curve for SPYx could not be loaded. The figures above come from
                    the study file and are unaffected.
                  </p>
                ) : (
                  <div className="skeleton" style={{ width: '100%', height: 268 }} />
                )}
              </div>
            </div>
          </Reveal>

          <Reveal delay={100}>
            <div className={s.caveat}>
              <p>
                <strong>Read this next to the caveats.</strong> The sample is{' '}
                {STUDY.spanDays} days of tokenized equities on Solana — thin books, a
                short history, and prices that are not the primary venue for any of these
                names. Nothing here establishes that the pattern holds at scale or
                forward.{' '}
                <Link to="/research#method" className={s.caveatLink}>
                  The full method, the controls and every t-statistic
                </Link>{' '}
                are on the research page, including the ones that disagree.
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── close ─────────────────────────────────────────────────────────── */}
      <section className={`${s.section} ${s.closing}`}>
        <div className="shell">
          <Reveal>
            <ClosingLine />
            <div className={s.actions}>
              <Link to="/markets" className={s.primary}>
                See every vault
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path d="M3 8h9M8.5 4 12.5 8l-4 4" fill="none" stroke="currentColor"
                        strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </Link>
              <Link to="/how-it-works" className={s.secondary}>How the vault works</Link>
            </div>
            <p className={s.marketCount}>
              {markets.status === 'ready'
                ? <>{markets.data.assets.length} assets modelled · {markets.data.assets.filter(a => a.kind === 'public').length} listed equities, {markets.data.assets.filter(a => a.kind === 'private').length} pre-IPO</>
                : <span className="skeleton" style={{ width: 260, height: 11, display: 'inline-block' }} />}
            </p>
          </Reveal>
        </div>
      </section>
    </>
  );
}
