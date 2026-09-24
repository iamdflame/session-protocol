/* The bell oracle: every NYSE open and close, as it was signed and as it was
 * verified.
 *
 * Nothing on this page is computed for the page. Each row is a Print account
 * read from the chain and decoded by the SDK, the rule shown is the one in
 * the config account, and the last card says how to check any print without
 * this site. On devnet the signer is a test key. The page says so as plainly
 * as the program does: every print recorded through a verifier other than
 * Pyth's own carries a flag it can never lose. */
import { useEffect, useMemo, useState } from 'react';
import {
  bellDeadline, bellTs, bellWindow, decimalPrice, etDay, PYTH_LAZER_PROGRAM_ID, SESSION, type BellKind,
} from '@sdk/bell.ts';
import { useOracle, type OracleState, type PrintRow } from '@/lib/oracle';
import { explorerAddr, short } from '@/lib/chain';
import { countdown, etDate, etParts } from '@/lib/session';
import { Status } from '@/components/ui/Status';
import { Source } from '@/components/ui/Source';
import { Icon } from '@/components/ui/Icon';
import s from './Oracle.module.css';

const REPO = 'https://github.com/iamdflame/session-protocol/blob/main';

/** 16:00:05 ET, to the second. */
const etTime = (ts: number) => {
  const p = etParts(ts);
  return `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}:${String(p.ss).padStart(2, '0')}`;
};

const bellLabel = (ts: number) => `${etDate(ts)}, ${etTime(ts).slice(0, 5)} ET`;

/** How far the price's own timestamp sits from the bell: −0.2 s, +41.0 s. */
function fromBell(feedTsUs: bigint, bell: number): string {
  const ms = Number(feedTsUs / 1000n) - bell * 1000;
  const sec = Math.abs(ms) / 1000;
  const sign = ms > 0 ? '+' : ms < 0 ? '−' : '';
  return `${sign}${sec < 10 ? sec.toFixed(2) : sec.toFixed(1)} s`;
}

/** Confidence as basis points of the price, two places. */
function confBps(conf: bigint, price: bigint): string {
  if (price <= 0n || conf <= 0n) return '—';
  return `${(Number((conf * 1_000_000n) / price) / 100).toFixed(2)} bp`;
}

interface Bell { day: number; kind: BellKind; ts: number }

/** The next bell after `now`, and the last one if its posting is still open. */
function bellsAround(now: number, st: OracleState): { next: Bell | null; open: Bell | null } {
  const all: Bell[] = [];
  for (let d = etDay(now) - 1; d < etDay(now) + 12; d++) {
    for (const kind of ['open', 'close'] as const) {
      const ts = bellTs(d, kind);
      if (ts !== null) all.push({ day: d, kind, ts });
    }
  }
  const next = all.find((b) => b.ts > now) ?? null;
  const open = [...all].reverse().find((b) => b.ts <= now && now < bellDeadline(b.ts, b.kind, st.config.params)) ?? null;
  return { next, open };
}

function StatusChip({ p }: { p: PrintRow }) {
  const word = p.status === 'final' ? 'Final' : p.status === 'missing' ? 'Missing' : 'Provisional';
  return <span className={s.chip} data-status={p.status}>{word}</span>;
}

function Price({ p }: { p: PrintRow }) {
  if (!p.equity.present) return <span className={s.none}>no print</span>;
  return <span className="num">${decimalPrice(p.equity.price, p.equity.expo)}</span>;
}

export default function Oracle() {
  const { data, error } = useOracle();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const around = useMemo(() => (data ? bellsAround(now, data) : null), [data, now]);

  return (
    <div className={s.page}>
      <header className={s.head}>
        <span className={s.eyebrow}>The bell oracle</span>
        <h1 className={s.title}>The open and the close, as they were signed</h1>
        <p className={s.lead}>
          Anything that settles <em>at the close</em> needs to know, on chain and after the fact, what the close
          was. For each listing and each NYSE trading day, <strong>session-bell</strong> keeps one print for the
          09:30 open and one for the 16:00 close. Each is a Pyth Pro message whose signature a Pyth verifier has
          checked in the same transaction, and which a written rule accepted. Anyone may post a print. A better one
          replaces it until its deadline, and then it is frozen for good.
        </p>
        <div className={s.badges}>
          <Status kind="devnet" />
          {data?.config.simulated && <Status kind="simulated" label="Simulated signer" />}
          {data && <Source kind="chain" detail={`session-bell ${short(data.manifest.program, 4)} on ${data.manifest.cluster}`} ageSec={(Date.now() - data.readAt) / 1000} staleAfter={90} />}
        </div>
      </header>

      {data === undefined ? (
        <div className={s.body}><div className="skeleton" style={{ height: 240, borderRadius: 16 }} /></div>
      ) : data === null ? (
        <div className={s.body}><p className={s.empty}>No bell oracle is deployed for this site yet.</p></div>
      ) : (
        <>
          {error && (
            <p className={s.warn} role="status">
              The last read failed ({error}). What follows is the read from {Math.round((Date.now() - data.readAt) / 1000)}s ago.
            </p>
          )}

          <div className={s.body}>
            {/* ── now ─────────────────────────────────────────────────────── */}
            <section className={s.card} aria-labelledby="oracle-now">
              <h2 id="oracle-now" className={s.cardTitle}>The next bell</h2>
              {around?.open && (
                <p className={s.nowLine}>
                  <strong>Posting is open</strong> for the {around.open.kind} of {etDate(around.open.ts)} until{' '}
                  <span className="num">{etTime(bellDeadline(around.open.ts, around.open.kind, data.config.params))}</span> ET.
                </p>
              )}
              {around?.next ? (() => {
                const n = around.next;
                const w = bellWindow(n.ts, n.kind, data.config.params);
                return (
                  <>
                    <p className={s.next}>
                      <span className={s.nextKind}>{n.kind === 'open' ? 'Open' : 'Close'}</span>
                      <span className="num">{bellLabel(n.ts)}</span>
                      <span className={`num ${s.countdown}`}>in {countdown(n.ts - now)}</span>
                    </p>
                    <dl className={s.rows}>
                      <div>
                        <dt>Window</dt>
                        <dd>
                          <span className="num">{etTime(Number(w.startUs / 1_000_000n))}–{etTime(Number(w.endUs / 1_000_000n))} ET</span>
                          <span className={s.sub}>{n.kind === 'close' ? 'the last price in it wins' : 'the first price in it wins'}</span>
                        </dd>
                      </div>
                      <div>
                        <dt>Frozen from</dt>
                        <dd>
                          <span className="num">{etTime(bellDeadline(n.ts, n.kind, data.config.params))} ET</span>
                          <span className={s.sub}>posting closes; finalise or mark missing</span>
                        </dd>
                      </div>
                    </dl>
                  </>
                );
              })() : <p className={s.empty}>No bell in the next twelve days.</p>}
            </section>

            {/* ── what is simulated ───────────────────────────────────────── */}
            {data.config.simulated ? (
              <section className={`${s.card} ${s.honest}`} aria-labelledby="oracle-sim">
                <h2 id="oracle-sim" className={s.cardTitle}>What is simulated here, and what is not</h2>
                <ul className={s.list}>
                  <li data-sim="true">
                    <strong>The signer.</strong> Pyth's own verifier trusts only Pyth's keys, and there is no Pyth Pro
                    key yet. So the verifier is Pyth's code under a devnet id of its own, holding a test key,{' '}
                    <span className="num">{short(data.manifest.signer, 4)}</span>. The program marks every print it
                    records this way <em>simulated</em>, permanently.
                  </li>
                  <li data-sim="true">
                    <strong>The price.</strong> {data.manifest.priceSource}. {data.manifest.placeholders}.
                  </li>
                  <li data-sim="true">
                    <strong>Two windows.</strong> The close takes the last price in {data.config.params.closeLeadSecs}s and the
                    open the first in {data.config.params.openWindowSecs}s, not v1's 10s and 60s, because Jupiter
                    refreshes every one to two minutes.
                  </li>
                  <li data-sim="false">
                    <strong>Not simulated:</strong> the program, the rule, the signature check (Pyth's own
                    <code> verify_message</code>, called in the same transaction), and the chain.
                  </li>
                </ul>
              </section>
            ) : (
              <section className={s.card} aria-labelledby="oracle-sim">
                <h2 id="oracle-sim" className={s.cardTitle}>Verified by Pyth's own program</h2>
                <p className={s.cardSub}>Every print here was checked by Pyth's Lazer verifier against Pyth's own signers.</p>
              </section>
            )}

            {/* ── listings ────────────────────────────────────────────────── */}
            <section className={`${s.card} ${s.wide}`} aria-labelledby="oracle-listings">
              <h2 id="oracle-listings" className={s.cardTitle}>Listings</h2>
              <ul className={s.listings}>
                {data.listings.map((l) => {
                  const m = data.manifest.listings.find((x) => x.symbol === l.symbol);
                  const latest = (kind: BellKind) => data.prints.find((p) => p.symbol === l.symbol && p.kind === kind);
                  return (
                    <li key={l.symbol} className={s.listing}>
                      <div className={s.listingHead}>
                        <span className={s.symbol}>{l.symbol}</span>
                        {!l.account.active && <span className={s.chip} data-status="missing">Inactive</span>}
                      </div>
                      <span className={s.feed}>{m?.feedNames.equity ?? 'equity'} · feed {l.account.equityFeed}</span>
                      {(['open', 'close'] as const).map((k) => {
                        const p = latest(k);
                        return (
                          <div key={k} className={s.latest}>
                            <span className={s.latestKind}>{k}</span>
                            {p ? <><Price p={p} /> <StatusChip p={p} /></> : <span className={s.none}>none yet</span>}
                          </div>
                        );
                      })}
                      <span className={s.sub}>{Number(l.account.prints)} print{l.account.prints === 1n ? '' : 's'}, {Number(l.account.missing)} missing</span>
                    </li>
                  );
                })}
              </ul>
            </section>

            {/* ── prints ──────────────────────────────────────────────────── */}
            <section className={`${s.card} ${s.wide}`} aria-labelledby="oracle-prints">
              <h2 id="oracle-prints" className={s.cardTitle}>Prints</h2>
              {data.prints.length === 0 ? (
                <p className={s.empty}>
                  No bell has been recorded yet.
                  {around?.next && <> The first this deployment can record is the {around.next.kind} of {bellLabel(around.next.ts)}.</>}
                </p>
              ) : (
                <div className={s.tableWrap} tabIndex={0} role="region" aria-labelledby="oracle-prints">
                  <table className={s.table}>
                    <caption className="sr-only">Every print, newest bell first</caption>
                    <thead>
                      <tr>
                        <th scope="col">Bell</th>
                        <th scope="col">Listing</th>
                        <th scope="col" className={s.r}>Price</th>
                        <th scope="col" className={s.r}>From the bell</th>
                        <th scope="col" className={s.r}>Confidence</th>
                        <th scope="col" className={s.r}>Publishers</th>
                        <th scope="col">Session</th>
                        <th scope="col">Status</th>
                        <th scope="col" className={s.r}>Posts</th>
                        <th scope="col">Account</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.prints.slice(0, 60).map((p) => (
                        <tr key={p.address}>
                          <td><span className="num">{etDate(p.bellTs)}</span> <span className={s.kind}>{p.kind}</span></td>
                          <td>{p.symbol}{p.simulated && <span className={s.simTag} title="verified through a test signer">sim</span>}</td>
                          <td className={s.r}><Price p={p} /></td>
                          <td className={`num ${s.r}`}>{p.equity.present ? fromBell(p.equity.feedTsUs, p.bellTs) : '—'}</td>
                          <td className={`num ${s.r}`}>{p.equity.present ? confBps(p.equity.conf, p.equity.price) : '—'}</td>
                          <td className={`num ${s.r}`}>{p.equity.present ? p.equity.publishers : '—'}</td>
                          <td>{p.equity.present ? (SESSION[p.equity.session] ?? '—') : '—'}</td>
                          <td><StatusChip p={p} /></td>
                          <td className={`num ${s.r}`}>{p.posts}</td>
                          <td>
                            <a className={s.addr} href={explorerAddr(p.address, data.manifest.cluster)} target="_blank" rel="noreferrer">
                              {short(p.address, 4)} <Icon name="external" size={11} />
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* ── the rule ────────────────────────────────────────────────── */}
            <section className={s.card} aria-labelledby="oracle-rule">
              <h2 id="oracle-rule" className={s.cardTitle}>The rule, as the config holds it</h2>
              <dl className={s.rows}>
                <div><dt>Close</dt><dd><span className="num">last price in {data.config.params.closeLeadSecs}s before 16:00</span><span className={s.sub}>13:00 on the three half-days</span></dd></div>
                <div><dt>Open</dt><dd><span className="num">first price in {data.config.params.openWindowSecs}s after 09:30</span></dd></div>
                <div><dt>Quality</dt><dd><span className="num">{data.config.params.minPublishers}+ publisher{data.config.params.minPublishers === 1 ? '' : 's'}, confidence ≤ {data.config.params.maxConfBps} bp</span><span className={s.sub}>regular session only; a positive price</span></dd></div>
                <div><dt>Freezes</dt><dd><span className="num">{data.config.params.finalizeAfterSecs}s after the window</span><span className={s.sub}>a later close or earlier open replaces until then</span></dd></div>
                <div><dt>Method</dt><dd><span className="num">v{data.config.params.methodVersion}</span><a className={s.addr} href={`${REPO}/docs/METHOD.md`} target="_blank" rel="noreferrer">docs/METHOD.md <Icon name="external" size={11} /></a></dd></div>
              </dl>
            </section>

            {/* ── check it yourself ───────────────────────────────────────── */}
            <section className={s.card} aria-labelledby="oracle-check">
              <h2 id="oracle-check" className={s.cardTitle}>Check a print without this site</h2>
              <ol className={s.steps}>
                <li>Read the print account and decode it with <code>decodePrint</code> from <code>sdk/src/bell.ts</code>. The layout is pinned by bytes the program itself wrote.</li>
                <li>Open the account's transactions. The one that wrote it holds an Ed25519 instruction, then <code>post_print</code> with the Pyth message at byte 12, and a CPI into <code>verify_message</code>.</li>
                <li>The print's <code>signer</code> is the key that signed the message. Its <code>verifier</code> is the program that vouched for the key: Pyth's own is <span className="num">{short(PYTH_LAZER_PROGRAM_ID.toBase58(), 5)}</span>.</li>
              </ol>
              <dl className={s.rows}>
                <div><dt>Program</dt><dd><a className={`num ${s.addr}`} href={explorerAddr(data.manifest.program, data.manifest.cluster)} target="_blank" rel="noreferrer">{short(data.manifest.program, 6)} <Icon name="external" size={11} /></a></dd></div>
                <div><dt>Verifier</dt><dd><a className={`num ${s.addr}`} href={explorerAddr(data.config.verifier.toBase58(), data.manifest.cluster)} target="_blank" rel="noreferrer">{short(data.config.verifier.toBase58(), 6)} <Icon name="external" size={11} /></a></dd></div>
                <div><dt>Config</dt><dd><a className={`num ${s.addr}`} href={explorerAddr(data.manifest.config, data.manifest.cluster)} target="_blank" rel="noreferrer">{short(data.manifest.config, 6)} <Icon name="external" size={11} /></a></dd></div>
                <div><dt>Written up</dt><dd><a className={s.addr} href={`${REPO}/docs/BELL.md`} target="_blank" rel="noreferrer">docs/BELL.md <Icon name="external" size={11} /></a></dd></div>
              </dl>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
