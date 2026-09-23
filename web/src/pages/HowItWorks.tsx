import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BoundaryWalk } from '@/components/BoundaryWalk';
import { Mechanism } from '@/components/how/Mechanism';
import { SessionRail, type ScrubState } from '@/components/session/SessionRail';
import { useSession, upcoming, etClock, closureReason, countdown } from '@/lib/session';
import { useMarkets } from '@/lib/data';
import { useDevnets, explorerAddr } from '@/lib/chain';
import { Icon } from '@/components/ui/Icon';
import s from './HowItWorks.module.css';

const PROGRAM = '8gWC37AFvgnPMAZSqiimbkpqPVhF3PrA1rao5agVKqKZ';

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
  const vaults = useDevnets();
  const head = markets.data?.headline;
  const [open, setOpen] = useState<number | null>(0);
  const [scrub, setScrub] = useState<ScrubState | null>(null);
  const next = sess ? upcoming(sess.now, 6) : [];
  const simulated = head && vaults ? head.assets - vaults.length : null;

  return (
    <div className={s.page}>
      <header className={s.head}>
        <span className={s.eyebrow}>How it works</span>
        <h1 className={s.title}>One vault, two claims, and a bell.</h1>
        <p className={s.lead}>
          A single program account holds the stock or the quote — never neither, never borrowed. DAY owns the regular
          session, NIGHT everything else, and at every bell the exposure moves from one to the other.
        </p>
      </header>

      <Mechanism />

      {/* ── the exact order ─────────────────────────────────────────────── */}
      <section className={s.section} id="cycle" aria-labelledby="cycle-h">
        <div className={s.secHead}>
          <span className={s.eyebrow}>At every bell</span>
          <h2 className={s.h2} id="cycle-h">The exact order, inside one transaction</h2>
        </div>
        <ol className={s.cycle}>
          {[
            { n: 'Roll', t: 'The exposed class earns its session', b: <>NAV moves by the return on the inventory the vault <em>actually held</em>, not the price ratio — so an unfilled handoff is never credited a return the vault did not make. Gains round down, losses round up.</> },
            { n: 'Fund', t: 'The larger side pays the smaller', b: <>A transfer proportional to the skew moves value from the crowded class to the thin one, capped so it never becomes the dominant term.</> },
            { n: 'Hand over', t: 'Exposure flips; only the difference trades', b: <>The flat class becomes exposed. What a filler trades is the gap between what the incoming class is owed and what the outgoing class held — not the whole position.</> },
            { n: 'Check', t: 'Solvency, or a halt', b: <>Backing must cover claims. A loss beyond the exposed class is reported as a shortfall and the settlement is <strong>not applied</strong>: the vault stops instead of writing it into the other class.</> },
          ].map((st, i) => (
            <li key={st.n} className={s.cycleItem}>
              <span className={`num ${s.cycleN}`}>{i + 1}</span>
              <span className={s.cycleName}>{st.n}</span>
              <h3 className={s.cycleTitle}>{st.t}</h3>
              <p className={s.cycleText}>{st.b}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* ── the calendar ────────────────────────────────────────────────── */}
      <section className={s.section} id="calendar" aria-labelledby="cal-h">
        <div className={s.secHead}>
          <span className={s.eyebrow}>The calendar</span>
          <h2 className={s.h2} id="cal-h">The bell is not a guess</h2>
          <p className={s.secLead}>
            The clock in the corner, every countdown, which class is parked and when a vault reopens all come from one module
            of integer date arithmetic, pinned to the on-chain program by 4,734 shared vectors — DST, every NYSE holiday and the
            13:00 early closes included.
          </p>
        </div>

        <div className={s.card}>
          <div className={s.cardHead}>
            <h3 className={s.cardTitle}>Today, as the program sees it</h3>
            <span className={s.scrubOut} aria-live="polite">
              {scrub
                ? <>At <span className="num">{etClock(scrub.t)} ET</span>, <b data-cls={scrub.cls}>{scrub.cls.toUpperCase()}</b> holds the stock{scrub.handoff ? <> · {scrub.handoff.label}</> : null}</>
                : 'Drag across the day, or tab to it and use the arrow keys'}
            </span>
          </div>
          <SessionRail interactive size="md" onScrub={setScrub} label="Today's sessions, draggable" />
        </div>

        <div className={s.calGrid}>
          <div className={s.card}><BoundaryWalk /></div>
          <div className={s.card}>
            <h3 className={s.cardTitle}>The next six boundaries</h3>
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
                <li key={i}><span className="skeleton" style={{ width: '100%', height: 12 }} /></li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* ── status ──────────────────────────────────────────────────────── */}
      <section className={s.section} id="status" aria-labelledby="status-h">
        <div className={s.secHead}>
          <span className={s.eyebrow}>Status</span>
          <h2 className={s.h2} id="status-h">What is live, and what is not</h2>
          <p className={s.secLead}>
            The program is deployed on Solana devnet as{' '}
            <a className={s.statusLink} href={explorerAddr(PROGRAM)} target="_blank" rel="noreferrer">
              <span className="mono">8gWC37…KqKZ</span> <Icon name="external" size={11} />
            </a>, and one token is live on <strong>mainnet</strong>. What stands in on devnet is about what devnet does not
            have, and nothing else.
          </p>
        </div>

        <div className={s.statusGrid}>
            <div className={s.statusCol} data-on="true">
              <h3 className={s.statusTitle}>
                <span className={s.statusDot} data-on="true" aria-hidden="true" />
                Real
              </h3>
              <ul>
                <li>The program itself, on devnet — every instruction, every check</li>
                <li>
                  <strong>Two vaults.</strong>{' '}
                  <Link className={s.statusLink} to="/markets/NVDAx">NVDAx</Link> settles on
                  NYSE hours;{' '}
                  <Link className={s.statusLink} to="/markets/OPENAI">OPENAI</Link> has no
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
                  <strong>A call auction that cleared.</strong> The next bell left a $7,528
                  residual and it went to auction instead of to whoever arrived first: one
                  price for everyone, open for two minutes, filled in full at the bell&rsquo;s
                  own mark. Funding moved with it — NIGHT&rsquo;s NAV went 1.000000 to
                  1.005000, which is the 50 bp cap, because DAY was three-quarters larger.
                </li>
                <li>
                  <strong>Anyone can open one.</strong>{' '}
                  <code className="mono">initialize_vault</code> takes no permission, and{' '}
                  <Link className={s.statusLink} to="/list">/list</Link> is that instruction from
                  your own wallet. The catalog finds new vaults by scanning the program.
                </li>
                <li>
                  <strong><code className="mono">$BELL</code>, on mainnet</strong> — the
                  keeper&rsquo;s token, quoted in real NVDAx rather than SOL.{' '}
                  <Link className={s.statusLink} to="/bell">What it cannot do</Link> is the half
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
                  The other {simulated ?? 'listed'} assets have no vault on chain. Their pages run the same
                  settlement code locally, with balances in your browser, and say so.
                </li>
              </ul>
              <p className={s.statusNote}>
                Mainnet needs a Hermes key to post the xStock feeds, a funded authority,
                and the local-validator initialisation run described in the runbook. The
                program account alone is 5.95 SOL settled, 11.9 at the peak of an upgrade.
              </p>
            </div>
        </div>
      </section>

      {/* ── failure modes ───────────────────────────────────────────────── */}
      <section className={s.section} id="failure" aria-labelledby="fail-h">
        <div className={s.secHead}>
          <span className={s.eyebrow}>Failure modes</span>
          <h2 className={s.h2} id="fail-h">What breaks, and what happens then</h2>
        </div>

        <div className={s.faq}>
          {FAQ.map((f, i) => (
            <div key={f.q} className={s.faqItem} data-open={open === i}>
              <h3>
                <button
                  className={s.faqQ}
                  onClick={() => setOpen(open === i ? null : i)}
                  aria-expanded={open === i}
                  aria-controls={`faq-${i}`}
                >
                  <span>{f.q}</span>
                  <Icon name="chevronDown" size={16} aria-hidden="true" />
                </button>
              </h3>
              <div className={s.faqA} id={`faq-${i}`} hidden={open !== i}>
                <p>{f.a}</p>
              </div>
            </div>
          ))}
        </div>

        <p className={s.faqFoot}>
          These are not hypotheticals. Each was found by an adversarial simulation that ran randomised year-long
          lifecycles and checked solvency after every operation — three were silent insolvency paths that passed the unit
          tests. <Link to="/research#method" className={s.faqLink}>The method, in full</Link>
        </p>
      </section>
    </div>
  );
}
