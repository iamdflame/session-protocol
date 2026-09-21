/* The clock a pre-IPO name actually has.
 *
 * OPENAI does not open at 09:30 and does not close at 16:00. Putting a NYSE
 * countdown on it would be a lie with a timer attached, so this replaces the
 * session clock entirely: the next scheduled print, and how far the token's
 * executable price has pulled away from the issuer's mark.
 *
 * The honest part is stated rather than hidden. An equity vault reads Pyth,
 * which anybody can verify against the same account. There is no oracle for a
 * pre-IPO token, so an operator posts what it sees — and this panel says who
 * posted it and how long ago, because that is the weakest link in the whole
 * protocol and the reader deserves to know where it is. */
import { premiumBps } from '@sdk/vault.ts';
import { explorerAddr, short, type ChainVault as ChainState, type Devnet } from '@/lib/chain';
import s from './EventSession.module.css';

const KIND = ['tender', 'round', 'valuation', 'other'] as const;

function until(ts: number, now: number): string {
  const d = ts - now;
  if (d <= 0) return 'now';
  const days = Math.floor(d / 86_400);
  const hours = Math.floor((d % 86_400) / 3_600);
  const mins = Math.floor((d % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

const ago = (secs: number) =>
  secs < 90 ? `${secs}s ago` : secs < 5_400 ? `${Math.round(secs / 60)}m ago` : `${Math.round(secs / 3_600)}h ago`;

export function EventSession({ m, d }: { m: Devnet; d: ChainState }) {
  const ev = d.event;
  if (!ev) return null;

  const now = d.fetchedAt;
  const { detector, nextPrint, inPrint } = ev;
  const tol = d.vault.maxPremiumBps;
  const over = ev.premiumBps > tol;
  // THEN wears the risk while a print is landing or the premium has run.
  const exposed = d.vault.exposed === 'night' ? 'THEN' : 'NOW';
  const stale = ev.detectorAgeSecs !== null && ev.detectorAgeSecs > d.vault.equityQuietSecs;

  return (
    <section className={`card ${s.card}`} aria-label="Event session">
      <header className={s.head}>
        <div>
          <h2 className={s.title}>No bell to ring</h2>
          <p className={s.sub}>
            {m.symbol} is private. There is no 09:30 and no close, so the boundary is the
            next <strong>print</strong> — or the moment the market stops believing the mark.
          </p>
        </div>
        <span className={s.holder} data-on={exposed}>{exposed} holds it</span>
      </header>

      {/* ── the premium ──────────────────────────────────────────────── */}
      <div className={s.premium} data-over={over}>
        <div className={s.premiumHead}>
          <span className={s.label}>Executable vs mark</span>
          <span className={`num ${s.premiumValue}`}>
            {ev.premiumBps === 0 ? '—' : `${detector && detector.executable > detector.mark ? '+' : '−'}${(ev.premiumBps / 100).toFixed(2)}%`}
          </span>
        </div>
        <div className={s.gauge} role="img" aria-label={`premium ${(ev.premiumBps / 100).toFixed(2)} percent against a tolerance of ${(tol / 100).toFixed(0)} percent`}>
          <div className={s.gaugeFill} style={{ width: `${Math.min(100, (ev.premiumBps / Math.max(tol * 2, 1)) * 100)}%` }} />
          <div className={s.gaugeMark} style={{ left: '50%' }} title={`tolerance ${(tol / 100).toFixed(0)}%`} />
        </div>
        <p className={s.premiumNote}>
          {over
            ? <>Past the {(tol / 100).toFixed(0)}% this vault tolerates, so <strong>THEN</strong> carries the gap between the fiction and the market. That gap is the whole reason THEN exists.</>
            : <>Inside the {(tol / 100).toFixed(0)}% this vault tolerates, so <strong>NOW</strong> holds the token and stays exitable.</>}
        </p>
      </div>

      {/* ── the numbers behind it ────────────────────────────────────── */}
      <dl className={s.rows}>
        <div>
          <dt>Issuer&rsquo;s mark</dt>
          <dd className="num">{detector ? `$${(Number(detector.mark) / 1e18).toFixed(2)}` : '—'}</dd>
        </div>
        <div>
          <dt>Executes at</dt>
          <dd className="num">{detector ? `$${(Number(detector.executable) / 1e18).toFixed(2)}` : '—'}</dd>
        </div>
        <div>
          <dt>Next print</dt>
          <dd>
            {nextPrint
              ? <>
                  <span className="num">{inPrint ? 'landing now' : until(nextPrint.ts, now)}</span>
                  <span className={s.sub2}>{KIND[nextPrint.kind] ?? 'print'} · window {Math.round(nextPrint.windowSecs / 86_400)}d</span>
                </>
              : <span className={s.sub2}>none scheduled</span>}
          </dd>
        </div>
        <div>
          <dt>Reading posted</dt>
          <dd>
            <span className="num" data-stale={stale}>
              {ev.detectorAgeSecs === null ? '—' : ago(ev.detectorAgeSecs)}
            </span>
            <span className={s.sub2}>
              {detector ? <>by <a className={s.addr} href={explorerAddr(detector.poster.toBase58())} target="_blank" rel="noreferrer">{short(detector.poster.toBase58(), 4)} ↗</a> · {detector.posts.toString()} total</> : ''}
            </span>
          </dd>
        </div>
      </dl>

      <footer className={s.foot}>
        <p>
          <strong>Where this rests on somebody&rsquo;s word.</strong> No oracle prices a pre-IPO
          token, so the two numbers above are posted on chain by the operator, read from{' '}
          <a className={s.addr} href="https://prestocks.com" target="_blank" rel="noreferrer">prestocks.com</a>{' '}
          — the issuer&rsquo;s own mark, and what the token actually executes at. The program bounds
          how stale a reading may be{stale ? ' and this one is past that bound' : ''}, records who
          posted it, and refuses to settle on one it cannot trust. It cannot make the reading true.
          {m.realMint && <> The token itself is mainnet-only (<span className="mono">{short(m.realMint, 4)}</span>); this vault holds a devnet mint built to the same shape.</>}
        </p>
      </footer>
    </section>
  );
}

/** What a class is called here. One program, two vocabularies. */
export const eventClassName = (cls: 'night' | 'day') => (cls === 'night' ? 'THEN' : 'NOW');

export { premiumBps };
