/* The instrument card: what this vault actually holds, and what its issuer
   can do to it. Every line is read from the chain the way the program reads
   it — the same parser, the same bytes — so the card and a halt can never
   disagree about the asset. */
import { Link } from 'react-router-dom';
import { issuerPowers, toUi } from '@sdk/issuer.ts';
import { gradeOf, GRADE_SUMMARY } from '@sdk/claim.ts';
import { SESSION_EVENT } from '@sdk/vault.ts';
import { explorerAddr, short, type ChainVault as ChainState, type Devnet } from '@/lib/chain';
import s from './Instrument.module.css';

const PROGRAM_NAME: Record<string, string> = {
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'Token-2022',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'SPL Token (classic)',
};

const when = (ts: number) =>
  ts > 0 ? new Date(ts * 1000).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET' : '—';

export function Instrument({ m, d }: { m: Devnet; d: ChainState }) {
  const { vault: v, issuer } = d;
  const isEvent = v.sessionKind === SESSION_EVENT;
  const ud = v.underlyingDecimals;
  const powers = issuer ? issuerPowers(issuer) : [];
  /* The same grade the curator refuses on, computed from the same bytes. If
     the page and the desk could disagree about what a wrapper is, the letter
     would be decoration. */
  const claim = issuer ? gradeOf(issuer, d.fetchedAt) : null;
  const inventoryUi = toUi(v.ownedUnderlying, ud, d.uiMultiplier);
  const balanceUi = toUi(d.balanceUnderlying, ud, d.uiMultiplier);
  /* The program can catch a calendar that disagrees with the market, by
     noticing the equity feed has gone quiet the way a feed does when its
     exchange shuts. That needs a feed with an exchange. Devnet sponsors none,
     so this vault points at a crypto feed, which trades through the night and
     can therefore never be silent — the check is compiled in and tested, and
     on this instance it can only ever pass.

     Read from the manifest rather than hardcoded: repoint the vault at a real
     equity feed and every sentence below corrects itself. */
  const bellFeedSleeps = !/^Crypto\./i.test(m.equityFeed);
  const nextMult = issuer?.scaledUi && issuer.scaledUi.newMultiplierEffectiveTs > d.fetchedAt ? issuer.scaledUi : null;

  return (
    <section className={`card ${s.card}`} aria-label="Instrument">
      <header className={s.head}>
        <h2 className={s.title}>Instrument</h2>
        <span className={s.cluster} data-standin>{m.cluster} · stand-in</span>
      </header>

      <p className={s.lede}>
        {isEvent
          ? <>An <strong>event session</strong>: the classes are NOW and THEN, the boundary is the next print or a premium divergence, and the detector is posted by the operator — there is no Pyth feed for a PreStock.</>
          : bellFeedSleeps
            ? <>An <strong>equity session</strong>: NYSE hours from the calendar, cross-checked against Pyth&rsquo;s US-equity feed going quiet at the bell.</>
            : <>An <strong>equity session</strong>: NYSE hours from the calendar. <strong>On this instance the calendar is the only clock</strong> — the cross-check below needs a feed that sleeps, and this one does not.</>}
      </p>

      <dl className={s.rows}>
        <div>
          <dt>Underlying</dt>
          <dd>
            <a className={`num ${s.addr}`} href={explorerAddr(m.underlyingMint)} target="_blank" rel="noreferrer">{short(m.underlyingMint, 6)} ↗</a>
            <span className={s.sub}>{PROGRAM_NAME[m.underlyingTokenProgram] ?? short(m.underlyingTokenProgram, 4)} · {ud} dp{issuer?.metadata ? ` · ${issuer.metadata.symbol}` : ''}</span>
          </dd>
        </div>
        <div>
          <dt>Quote</dt>
          <dd>
            <a className={`num ${s.addr}`} href={explorerAddr(m.quoteMint)} target="_blank" rel="noreferrer">{short(m.quoteMint, 6)} ↗</a>
            <span className={s.sub}>{PROGRAM_NAME[m.tokenProgram] ?? short(m.tokenProgram, 4)} · {v.quoteDecimals} dp</span>
          </dd>
        </div>
        <div>
          <dt>Inventory</dt>
          <dd>
            <span className="num">{inventoryUi.toLocaleString('en-US', { maximumFractionDigits: 4 })}</span>
            <span className={s.sub}>
              owned · account holds <span className="num">{balanceUi.toLocaleString('en-US', { maximumFractionDigits: 4 })}</span>
              {d.uiMultiplier !== 1 && <> · shown at ×<span className="num">{d.uiMultiplier.toPrecision(7)}</span>, raw atoms underneath</>}
              {nextMult && <> · ×<span className="num">{nextMult.newMultiplier.toPrecision(7)}</span> from {when(nextMult.newMultiplierEffectiveTs)}</>}
            </span>
          </dd>
        </div>
        <div>
          <dt>Mark feed</dt>
          <dd><span className="mono">{m.markFeed}</span><span className={s.sub}>Pyth · verification required: Full · posted within {v.maxPostedSlotAge.toLocaleString()} slots</span></dd>
        </div>
        <div>
          <dt>{isEvent ? 'Detector' : 'Bell feed'}</dt>
          <dd>
            {isEvent
              ? <><span className="mono">operator-posted</span><span className={s.sub}>premium vs mark, flips THEN at {(v.maxPremiumBps / 100).toFixed(1)}%</span></>
              : <><span className="mono">{m.equityFeed}</span><span className={s.sub} data-standin={!bellFeedSleeps || undefined}>
                  {bellFeedSleeps
                    ? <>quiet for {Math.round(v.equityQuietSecs / 60)} min = closed</>
                    : <>a crypto feed never goes quiet, so this check can only pass — {Math.round(v.equityQuietSecs / 60)} min of silence would mean closed, and there is never silence</>}
                </span></>}
          </dd>
        </div>
        <div>
          <dt>Settlement mark</dt>
          <dd><span className={s.sub}>published within {Math.round(v.maxBellLeadSecs / 60)} min before the bell to {Math.round(v.maxStaleSecs / 60)} min after; anything else is refused</span></dd>
        </div>
        <div>
          <dt>Last bell</dt>
          <dd><span className="num">{when(v.lastBoundaryTs)}</span><span className={s.sub}>{v.boundaryCount.toString()} settled</span></dd>
        </div>
        <div>
          <dt>Recap</dt>
          <dd>
            <span>{v.recapCount === 0 ? 'never' : <><span className="num">{v.recapCount}</span>, last {when(v.lastRecapTs)}</>}</span>
            <span className={s.sub}>{v.requireVerifiedRecap ? 'Pyth-verified only' : 'attested by operator permitted, bounded by the move limit'}</span>
          </dd>
        </div>
        <div>
          <dt>State</dt>
          <dd>
            <span data-halted={v.halted}>{v.halted ? `halted — ${v.haltReason}` : v.flags ? `paused (flags ${v.flags})` : 'live'}</span>
            {v.fillPausedUntil > d.fetchedAt && <span className={s.sub}>fills paused until {when(v.fillPausedUntil)} after a jump</span>}
          </dd>
        </div>
      </dl>

      {claim && (
        <div className={s.claim} data-grade={claim.grade}>
          <div className={s.claimHead}>
            <span className={s.grade} aria-hidden="true">{claim.grade}</span>
            <div>
              {/* The mint is the identity; the ticker is a label. Two wrappers
                  of the same company are not the same claim, and a page that
                  leads with the ticker invites treating them as if they were. */}
              <h3 className={s.claimTitle}>
                {m.realMint ? 'The claim this stands in for' : 'The claim'}
              </h3>
              <p className={s.claimSummary}>{GRADE_SUMMARY[claim.grade]}</p>
            </div>
          </div>

          <p className={s.claimWrapper}>{claim.wrapper[0].toUpperCase() + claim.wrapper.slice(1)}.</p>
          <p className={s.claimPause}>{claim.pause}</p>

          {claim.multiplier.effective !== 1 && (
            <p className={s.claimMultiplier}>
              Balances read at <span className="num">×{claim.multiplier.effective}</span> the raw
              amount. <strong>This program values raw atoms</strong>, so a dividend or split
              applied this way would be mispriced with nothing failing — which is why a vault
              in this state is not curated.
            </p>
          )}
          {claim.multiplier.scheduled !== null && (
            <p className={s.claimMultiplier}>
              A multiplier of <span className="num">×{claim.multiplier.scheduled}</span> takes
              effect {when(claim.multiplier.effectiveAt!)} — the adjacent field, not the one
              a stale reader would take for current.
            </p>
          )}

          {claim.blocking.length > 0 && (
            <p className={s.claimBlocked}>
              Not eligible to be shown by default: {claim.blocking.join('; ')}. It settles,
              funds and redeems exactly the same — curation decides where a vault appears,
              never whether it works.
            </p>
          )}

          <p className={s.claimNote}>
            Graded from powers the mint publishes, not from a rating anyone issued. It is a
            summary of what the issuer kept, in one letter, so that &ldquo;curated&rdquo; means
            something checkable. It is not advice and not a safety rating.
          </p>
        </div>
      )}

      <div className={s.powers}>
        <h3 className={s.powersTitle}>What the issuer can do to this vault</h3>
        {issuer === null ? (
          <p className={s.sub}>The mint could not be read.</p>
        ) : powers.length === 0 ? (
          <p className={s.sub}>Nothing beyond a classic mint&rsquo;s freeze authority.</p>
        ) : (
          <ul className={s.powersList}>
            {powers.map(p => <li key={p} data-live={/PAUSED|is set/.test(p)}>{p}</li>)}
          </ul>
        )}
        <p className={s.powersNote}>
          These are properties of the asset, not of this program. A vault holding a real xStock lives with them; the program&rsquo;s job is to <strong>stop with a name</strong> the moment one is used, rather than keep marking inventory it no longer controls.
        </p>
      </div>

      <footer className={s.foot}>
        <p>{m.note} <Link to="/how-it-works#status">What is and is not live</Link></p>
      </footer>
    </section>
  );
}
