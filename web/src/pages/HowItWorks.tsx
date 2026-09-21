import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Reveal } from '@/components/Reveal';
import { BoundaryWalk } from '@/components/BoundaryWalk';
import { useSession, upcoming, etClock, closureReason, countdown } from '@/lib/session';
import { useMarkets } from '@/lib/data';
import s from './HowItWorks.module.css';

const FAQ = [
  {
    q: 'What happens if nobody fills the handoff?',
    a: `The vault carries the imbalance as a pending delta and keeps settling. Health
        reports it in basis points of total value, and past a configured limit the next
        boundary halts rather than settling on a book that does not match the claims.
        Halting is the safe direction: it freezes NAV at its last correct value instead
        of writing an error into it.`,
  },
  {
    q: 'What if the oracle goes stale?',
    a: `Settlement needs a mark, and a mark older than the configured staleness window
        is not one. The vault refuses to settle rather than roll NAV on a price nobody
        is standing behind. Health surfaces the age before it becomes a halt.`,
  },
  {
    q: 'What if the keeper misses a boundary?',
    a: `The state machine does not infer exposure from the current time — that cannot
        tell one missed boundary from two, and over a weekend outage it handed DAY the
        entire 65 hours. Instead it counts the boundaries between the last settled one
        and now. Zero means up to date, one settles, more than one is reported as stale
        and requires an explicit catch-up.`,
  },
  {
    q: 'Can a loss exceed one class entirely?',
    a: `Yes, and that is the case the design takes seriously. If the exposed class's
        claim is wiped out by a move, the excess is reported as a shortfall and the
        settlement is not applied. Silently absorbing it would take the loss out of the
        other class's backing — the one class that was, by construction, not exposed.`,
  },
  {
    q: 'Why not just use a timezone database?',
    a: `Because a tz database that updates underneath a deployed program is an
        unreviewed change to who gets paid. The calendar is integer date arithmetic
        with the DST rule and the NYSE holiday rules written out, pinned to the Rust
        implementation by 4,734 shared vectors. It is dull on purpose.`,
  },
  {
    q: 'Where does the price come from?',
    a: `On chain, a Pyth price update, parsed explicitly — owner-checked,
        discriminator-checked, and read field by field rather than through an SDK whose
        version pins conflicted with ours. On this site, live marks come from Jupiter,
        because Pyth's public endpoint now requires a key that a browser cannot hold.`,
  },
];

export default function HowItWorks() {
  const sess = useSession();
  const markets = useMarkets();
  const head = markets.data?.headline;
  const [open, setOpen] = useState<number | null>(0);
  const next = sess ? upcoming(sess.now, 6) : [];

  return (
    <div className={s.page}>
      <header className={`shell ${s.head}`}>
        <p className="eyebrow">How it works</p>
        <h1 className={`display ${s.title}`}>
          One vault, two claims, and a bell.
        </h1>
        <p className={`lead ${s.lead}`}>
          Everything below happens inside a single program account. There is no
          leverage, no synthetic exposure, and no counterparty other than the vault
          itself — which either holds the stock or holds the quote, and at any
          instant you can check which.
        </p>
      </header>

      {/* ── the cycle ───────────────────────────────────────────────────── */}
      <section className={`shell ${s.section}`} id="cycle">
        <Reveal>
          <p className="eyebrow">The cycle</p>
          <h2 className={`display ${s.h2}`}>What happens at a bell.</h2>
        </Reveal>

        <ol className={s.steps}>
          {[
            {
              n: 'Roll',
              t: 'The exposed class earns its session',
              b: <>NAV moves by the return on the inventory the vault <em>actually held</em>,
                  not by the price ratio. Those agree while the book is hedged and diverge
                  the instant a handoff goes unfilled — rolling by the ratio would credit a
                  return the vault never made. Gains round down, losses round up, so claims
                  can never outrun the assets behind them.</>,
            },
            {
              n: 'Fund',
              t: 'The larger side pays the smaller',
              b: <>If one class is worth much more than the other, the vault is structurally
                  long that side&rsquo;s risk. A funding transfer proportional to the skew
                  moves value from the crowded class to the thin one, capped so it can never
                  become the dominant term. It is the price of carrying the gap, quoted
                  continuously — which nobody has been able to do before, because nobody
                  could hold either side alone.</>,
            },
            {
              n: 'Hand over',
              t: 'Exposure flips, and only the difference trades',
              b: <>The class that was flat becomes exposed. The vault sizes the difference
                  between what the incoming class is owed and what the outgoing class held,
                  and that difference — not the whole position — is what a filler trades.
                  When the two sides are close, almost nothing touches a market.</>,
            },
            {
              n: 'Check',
              t: 'Solvency, or a halt',
              b: <>Every settlement is followed by the invariant that backing is at least
                  claims. If a loss would exceed the exposed class entirely, the excess is
                  reported as a shortfall and the settlement is <strong>not applied</strong>.
                  The vault stops instead of writing the error into the other class.</>,
            },
          ].map((step, i) => (
            <Reveal key={step.n} as="li" delay={i * 60}>
              <div className={s.step}>
                <span className={s.stepNum} aria-hidden="true">{i + 1}</span>
                <div className={s.stepBody}>
                  <p className={s.stepName}>{step.n}</p>
                  <h3 className={s.stepTitle}>{step.t}</h3>
                  <p className={s.stepText}>{step.b}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </ol>
      </section>

      {/* ── the calendar ────────────────────────────────────────────────── */}
      <section className={`${s.section} ${s.sunken}`} id="calendar">
        <div className="shell">
          <Reveal>
            <p className="eyebrow">The calendar</p>
            <h2 className={`display ${s.h2}`}>The bell is not a guess.</h2>
            <p className={`lead ${s.sectionLead}`}>
              Everything on this site — the clock in the corner, the countdown, which
              class is parked, when a vault reopens — comes from one module of integer
              date arithmetic, pinned to the on-chain program by 4,734 shared vectors.
              It handles DST, every NYSE holiday, and the 13:00 early closes, and it
              knows that when New Year&rsquo;s Day falls on a Saturday the Exchange does
              not close the Friday before.
            </p>
          </Reveal>

          <Reveal delay={60}><BoundaryWalk /></Reveal>

          <Reveal delay={100}>
            <div className={s.upcoming}>
              <h3 className={s.upcomingTitle}>The next six boundaries, live</h3>
              <ol className={s.boundaryList}>
                {next.length ? next.map(b => {
                  const reason = closureReason(b.at - 60);
                  return (
                    <li key={b.at}>
                      <span className={s.bTo} data-holder={b.to.toLowerCase()}>{b.to} takes over</span>
                      <span className={s.bWhen}>{b.label}</span>
                      <span className={`num ${s.bTime}`}>{etClock(b.at)} ET</span>
                      <span className={s.bSpan}>
                        after <span className="num">{countdown(b.span)}</span>
                        {reason && <span className={s.bReason}>{reason}</span>}
                      </span>
                    </li>
                  );
                }) : Array.from({ length: 6 }, (_, i) => (
                  <li key={i}>
                    <span className="skeleton" style={{ width: 120, height: 11 }} />
                    <span className="skeleton" style={{ width: 70, height: 11 }} />
                    <span className="skeleton" style={{ width: 64, height: 11 }} />
                    <span className="skeleton" style={{ width: 90, height: 11 }} />
                  </li>
                ))}
              </ol>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── status ──────────────────────────────────────────────────────── */}
      <section className={`shell ${s.section}`} id="status">
        <Reveal>
          <p className="eyebrow">Status</p>
          <h2 className={`display ${s.h2}`}>What is live, and what is not.</h2>
          <p className={`lead ${s.sectionLead}`}>
            The program is deployed on Solana devnet as{' '}
            <a className={s.statusLink} href="https://explorer.solana.com/address/8gWC37AFvgnPMAZSqiimbkpqPVhF3PrA1rao5agVKqKZ?cluster=devnet" target="_blank" rel="noreferrer">
              <span className="mono">8gWC37…KqKZ</span> ↗
            </a>, and one token is live on <strong>mainnet</strong>. What stands in
            on devnet is about what devnet does not have — and one thing below has
            simply never been exercised. Here is the line.
          </p>
        </Reveal>

        <div className={s.statusGrid}>
          <Reveal>
            <div className={s.statusCol} data-on="true">
              <h3 className={s.statusTitle}>
                <span className={s.statusDot} data-on="true" aria-hidden="true" />
                Real
              </h3>
              <ul>
                <li>The program itself, on devnet — every instruction, every check</li>
                <li>
                  <strong>Two vaults.</strong>{' '}
                  <a className={s.statusLink} href="/markets/NVDAx">NVDAx</a> settles on
                  NYSE hours;{' '}
                  <a className={s.statusLink} href="/markets/OPENAI">OPENAI</a> has no
                  exchange session at all and settles on the next print or a premium that
                  runs. Mint and redeem from your wallet, funding, the handoff, a halt on
                  bad debt — the same program for both.
                </li>
                <li>
                  <strong>A bell that actually settled.</strong> Exposure flipped, and the
                  handoff was filled by an arbitrageur paid 25 bp for bringing the stock —
                  which took DAY&rsquo;s NAV down by exactly that.
                </li>
                <li>
                  <strong>Anyone can open one.</strong>{' '}
                  <code className="mono">initialize_vault</code> takes no permission, and{' '}
                  <a className={s.statusLink} href="/list">/list</a> is that instruction from
                  your own wallet. The catalog finds new vaults by scanning the program.
                </li>
                <li>
                  <strong><code className="mono">$BELL</code>, on mainnet</strong> — the
                  keeper&rsquo;s token, quoted in real NVDAx rather than SOL.{' '}
                  <a className={s.statusLink} href="/bell">What it cannot do</a> is the half
                  worth reading.
                </li>
                <li>
                  A <strong>Meteora DAMM v2 pool</strong> for <code className="mono">NVDA.DAY</code>{' '}
                  against the quote, on devnet — so a class has somewhere to trade.
                </li>
                <li>The mark it settles on: a Pyth price account, owner-checked and staleness-checked on chain</li>
                <li>The OPENAI reading: the live mark and executable price from prestocks.com, posted on chain every fifteen minutes and settled against</li>
                <li>The session calendar, shared with the program</li>
                <li>Live marks from Jupiter for the other assets, polled every 20 seconds</li>
                <li>
                  {head
                    ? <>{head.closes.toLocaleString()} hourly closes across {head.assets} assets</>
                    : <>The full hourly price history</>}
                </li>
                <li>Every statistic on the research page</li>
                <li>
                  <code className="mono">settle()</code>, <code className="mono">valueOf()</code>,{' '}
                  funding and the skew — imported, not reimplemented
                </li>
                <li>The health signals, from the same <code className="mono">evaluate()</code> the keeper runs</li>
                <li>Mint and redeem policy, including the parked-class rule and rounding direction</li>
              </ul>
            </div>
          </Reveal>

          <Reveal delay={60}>
            <div className={s.statusCol}>
              <h3 className={s.statusTitle}>
                <span className={s.statusDot} aria-hidden="true" />
                Simulated
              </h3>
              <ul>
                <li>
                  The devnet vaults&rsquo; underlying and quote are test mints — devnet has
                  no xStocks and no USDC — and the mark is Pyth&rsquo;s{' '}
                  <code className="mono">SOL/USD</code>, because the NVDAX feed is not
                  sponsored there. On mainnet the feed is{' '}
                  <code className="mono">Crypto.NVDAX/USD</code>.
                </li>
                <li>
                  <strong>The closing-bell cross-check does not run on this instance.</strong>{' '}
                  The program can catch a calendar that disagrees with the market, by
                  noticing that the equity feed has gone quiet the way a feed does when its
                  exchange shuts. Devnet sponsors no equity feed, so this vault&rsquo;s is{' '}
                  <code className="mono">Crypto.BTC/USD</code> — which never sleeps, and
                  therefore never goes quiet. The check is compiled in and tested; here it
                  can only ever pass. <strong>On this instance the calendar is the only
                  clock.</strong>
                </li>
                <li>
                  <strong>The auction has never run.</strong> The residual can be offered at
                  one price to everyone for a window after the bell instead of going to
                  whoever arrives first — the code is there, the window is set, and no
                  auction account exists on this program. Nothing has needed one yet.
                </li>
                <li>
                  <strong>Recap is not required here.</strong>{' '}
                  <code className="mono">require_verified_recap</code> is off on both
                  vaults, so replaying missed boundaries does not have to carry a Pyth
                  update per boundary. On mainnet it is on, and the operator posts the
                  print for each bell being replayed.
                </li>
                <li>
                  The devnet market maker: an operator key fills handoffs from its own
                  inventory. On mainnet that is anyone who wants the incentive.
                </li>
                <li>
                  The other 25 assets have no vault on chain. Their pages run the same
                  settlement code locally, with balances in your browser, and say so.
                </li>
              </ul>
              <p className={s.statusNote}>
                Mainnet needs a Hermes key to post the xStock feeds, a funded authority,
                and the local-validator initialisation run described in the runbook. The
                program account alone is 5.95 SOL settled, 11.9 at the peak of an upgrade.
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── faq ─────────────────────────────────────────────────────────── */}
      <section className={`${s.section} ${s.sunken}`} id="failure">
        <div className="shell">
          <Reveal>
            <p className="eyebrow">Failure modes</p>
            <h2 className={`display ${s.h2}`}>What breaks, and what happens then.</h2>
          </Reveal>

          <div className={s.faq}>
            {FAQ.map((f, i) => (
              <Reveal key={f.q} delay={i * 30}>
                <div className={s.faqItem} data-open={open === i}>
                  <h3>
                    <button
                      className={s.faqQ}
                      onClick={() => setOpen(open === i ? null : i)}
                      aria-expanded={open === i}
                      aria-controls={`faq-${i}`}
                    >
                      <span>{f.q}</span>
                      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                        <path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor"
                              strokeWidth="1.6" strokeLinecap="round" />
                      </svg>
                    </button>
                  </h3>
                  <div className={s.faqA} id={`faq-${i}`} hidden={open !== i}>
                    <p>{f.a}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal>
            <p className={s.faqFoot}>
              These are not hypotheticals. Each one was found by an adversarial
              simulation that ran randomised year-long lifecycles and checked solvency
              after every operation — three of them were silent insolvency paths that
              passed the unit tests.{' '}
              <Link to="/research#method" className={s.faqLink}>The method, in full</Link>
            </p>
          </Reveal>
        </div>
      </section>
    </div>
  );
}
