/* The keeper, and what it is paid in.
 *
 * Every protocol that needs a crank has this problem and most of them hide
 * it: somebody has to pay the fee that settles the boundary, and if nobody
 * does, the vault drifts. SESSION's answer is that the crank is
 * permissionless — anyone may call it, and the program refuses to act unless
 * exactly one boundary has elapsed — so a keeper that is late, absent or
 * hostile can only cause delay. This page is where that claim is made
 * checkable: what the agent is, what it has actually done, and precisely how
 * little it is trusted with.
 *
 * $BELL is quoted in NVDAx rather than SOL. That is the point of it: the
 * token of the thing that keeps a tokenized-stock vault is priced in the
 * stock, so holding it is a position in the asset being kept.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDevnets, useLedger, useChainVault, explorer, explorerAddr, short } from '@/lib/chain';
import { describe, kindOf } from '@sdk/events.ts';
import { etClock, etDate } from '@/lib/session';
import { Heartbeat } from '@/components/bell/Heartbeat';
import { Icon } from '@/components/ui/Icon';
import s from './Bell.module.css';

interface BellRecord {
  note: string;
  mint: string;
  symbol: string;
  name: string;
  cluster: string;
  quote: { mint: string; symbol: string; decimals: number; creatorFeeBps: number };
  agent: { id: string; name: string; wallet: string };
  launchTx: string;
  paymentTx: string;
  paidSol: number;
  pumpUrl?: string;
  feeShare?: string;
  launchedAt: string;
}

const solscan = (kind: 'tx' | 'token' | 'account', id: string) => `https://solscan.io/${kind}/${id}`;

export default function Bell() {
  const [rec, setRec] = useState<BellRecord | null | undefined>(undefined);
  const devnets = useDevnets();
  /* Both vaults, because the keeper keeps both and they are kept differently:
     the equity one is cranked against a calendar, the event one is a reading
     posted and then settled against. Reading only the first manifest made the
     card promise "detector postings" from a vault that has no detector. */
  const equity = devnets?.[0] ?? null;
  const event = devnets?.[1] ?? null;
  const eqLedger = useLedger(equity?.vault ?? null, 12);
  const evLedger = useLedger(event?.vault ?? null, 12);
  const eqVault = useChainVault(equity);

  useEffect(() => {
    fetch('/bell.json').then(r => (r.ok ? r.json() : null)).then(setRec).catch(() => setRec(null));
  }, []);

  const rows = eqLedger.rows === null && evLedger.rows === null
    ? null
    : [...(eqLedger.rows ?? []), ...(evLedger.rows ?? [])];

  // What the keeper has actually done, as opposed to what it says it does.
  const KEEPER_EVENTS = ['BoundarySettled', 'JumpSettled', 'HandoffFilled', 'AuctionCleared', 'DetectorPosted'];
  const keeperRows = (rows ?? [])
    .filter(r => r.events.some(e => KEEPER_EVENTS.includes(e.name)))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, 14);

  return (
    <div className={s.page}>
      <Heartbeat vault={eqVault.data} ledger={eqLedger.rows} />

      <header className={s.head}>
        <span className={s.eyebrow}>The keeper</span>
        <h2 className={s.title}>Somebody has to ring the bell</h2>
        <p className={s.lead}>
          A vault that nobody cranks drifts. Cranking is permissionless — the program refuses to settle unless exactly one
          boundary has elapsed, so a keeper that is late, absent or hostile can only cause delay, never loss.{' '}
          <strong>Bell</strong> is the agent that does it anyway.
        </p>
      </header>

      {rec === undefined ? (
        <div className={s.body}><div className="skeleton" style={{ height: 220, borderRadius: 16 }} /></div>
      ) : rec === null ? (
        <div className={s.body}>
          <p className={s.empty}>No agent has been launched yet.</p>
        </div>
      ) : (
        <div className={s.body}>
          {/* ── the token ───────────────────────────────────────────────── */}
          <section className={s.card} aria-label="The token">
            <header className={s.cardHead}>
              <div className={s.tokenId}>
                <img src="/bell.png" alt="" width={44} height={44} className={s.tokenImg} />
                <div>
                  <h2 className={s.cardTitle}>${rec.symbol}</h2>
                  <p className={s.cardSub}>{rec.name}</p>
                </div>
              </div>
              <span className={s.mainnet}>mainnet</span>
            </header>

            <p className={s.pairing}>
              The curve is denominated in <strong>{rec.quote.symbol}x</strong>, not SOL. A keeper
              for a tokenized-stock vault is paid in the stock — so holding ${rec.symbol} is a
              position in the thing being kept, and the pair prices the two against each other
              directly.
            </p>

            <dl className={s.rows}>
              <div>
                <dt>Mint</dt>
                <dd><a className={`num ${s.addr}`} href={solscan('token', rec.mint)} target="_blank" rel="noreferrer">{short(rec.mint, 6)} <Icon name="external" size={11} /></a></dd>
              </div>
              <div>
                <dt>Quoted in</dt>
                <dd>
                  <a className={`num ${s.addr}`} href={solscan('token', rec.quote.mint)} target="_blank" rel="noreferrer">{short(rec.quote.mint, 6)} <Icon name="external" size={11} /></a>
                  <span className={s.sub}>the real NVDAx · Token-2022 · {rec.quote.decimals} dp</span>
                </dd>
              </div>
              <div>
                <dt>Launch</dt>
                <dd>
                  <a className={`num ${s.addr}`} href={solscan('tx', rec.launchTx)} target="_blank" rel="noreferrer">{short(rec.launchTx, 6)} <Icon name="external" size={11} /></a>
                  <span className={s.sub}>through Clawpump, on a pump.fun curve</span>
                </dd>
              </div>
              <div>
                <dt>Cost</dt>
                <dd>
                  <span className="num">{rec.paidSol} SOL</span>
                  <span className={s.sub}>paid in <a className={s.addr} href={solscan('tx', rec.paymentTx)} target="_blank" rel="noreferrer">{short(rec.paymentTx, 4)} <Icon name="external" size={11} /></a>{rec.feeShare ? ` · ${rec.feeShare} of trading fees to the agent` : ''}</span>
                </dd>
              </div>
              <div>
                <dt>Agent wallet</dt>
                <dd>
                  <a className={`num ${s.addr}`} href={solscan('account', rec.agent.wallet)} target="_blank" rel="noreferrer">{short(rec.agent.wallet, 6)} <Icon name="external" size={11} /></a>
                  <span className={s.sub}>its own key, not the operator&rsquo;s</span>
                </dd>
              </div>
              {rec.pumpUrl && (
                <div>
                  <dt>Curve</dt>
                  <dd><a className={s.addr} href={rec.pumpUrl} target="_blank" rel="noreferrer">pump.fun <Icon name="external" size={11} /></a></dd>
                </div>
              )}
            </dl>
          </section>

          {/* ── what it is trusted with ─────────────────────────────────── */}
          <section className={s.card} aria-label="What the keeper can do">
            <h2 className={s.cardTitle}>What it can and cannot do</h2>
            <p className={s.cardSub}>
              The interesting half of a keeper is the half it is not allowed to touch.
            </p>
            <ul className={s.powers}>
              <li data-can="true"><strong>Crank the boundary.</strong> So can anyone: <span className="mono">settle_boundary</span> takes no signer and refuses unless exactly one bell has elapsed.</li>
              <li data-can="true"><strong>Fill the residual</strong> from its own inventory, at the mark plus whatever the incentive ramp has reached.</li>
              <li data-can="true"><strong>Open and clear an auction.</strong> Permissionless too, and the price is the mark from the bell&rsquo;s own window — not one it chooses.</li>
              <li data-can="false"><strong>Cannot move the vault&rsquo;s money.</strong> It has no authority over the vault; every token it trades is its own.</li>
              <li data-can="false"><strong>Cannot change a NAV.</strong> Settlement is arithmetic over supplies and a Pyth price; there is no input it supplies.</li>
              <li data-can="false"><strong>Cannot halt or resume.</strong> That is the vault authority&rsquo;s, and resuming requires the books to be current.</li>
              <li data-can="false"><strong>Cannot hide.</strong> Everything it does is a transaction on the vault, listed below and on every vault page.</li>
            </ul>
            <p className={s.note}>
              The worst a broken keeper achieves is a late settlement, and a late settlement is
              still stamped with the bell it belongs to — not with the moment it happened to run.
            </p>
          </section>

          {/* ── what it has done ────────────────────────────────────────── */}
          <section className={s.card} aria-label="What the keeper has done">
            <h2 className={s.cardTitle}>What it has actually done</h2>
            <p className={s.cardSub}>
              Settlements, fills, auctions and detector postings across both vaults —{' '}
              {equity ? <a className={s.addr} href={explorerAddr(equity.vault)} target="_blank" rel="noreferrer">{short(equity.vault, 4)} <Icon name="external" size={11} /></a> : 'the equity vault'}
              {' '}and{' '}
              {event ? <a className={s.addr} href={explorerAddr(event.vault)} target="_blank" rel="noreferrer">{short(event.vault, 4)} <Icon name="external" size={11} /></a> : 'the event vault'}.
              Read from the chain, not from a log this site keeps.
            </p>
            {/* The wallet named above is the token's identity on mainnet. The key
                that signs these transactions is the devnet operator, and saying
                so is the difference between a ledger and a claim: every act here
                is attributable, and it is not attributable to $BELL's wallet. */}
            {equity && (
              <p className={s.note}>
                Signed on devnet by the operator key{' '}
                <a className={`mono ${s.addr}`} href={explorerAddr(equity.operator)} target="_blank" rel="noreferrer">
                  {short(equity.operator, 4)} <Icon name="external" size={11} />
                </a>, not by the mainnet wallet above — <code className="mono">$BELL</code> is the
                token, and this is the cluster its vaults are on. Settlement takes no signer at
                all, so any of these could have been sent by anyone; the fills could not, because
                a fill spends the filler&rsquo;s own inventory.
              </p>
            )}
            {rows === null ? (
              <div className={s.skel}>{Array.from({ length: 3 }, (_, i) => <div key={i} className="skeleton" style={{ height: 30 }} />)}</div>
            ) : keeperRows.length === 0 && (rows ?? []).some(r => !r.decoded && !r.failed) ? (
              <p className={s.note}>
                Reading the vaults&rsquo; recent transactions from devnet — the public endpoint is slow
                to serve their details, and a row is listed only once the program&rsquo;s own events have
                been read, never guessed from the signature alone.
              </p>
            ) : keeperRows.length === 0 ? (
              <p className={s.note}>
                Nothing yet on either vault in the last few transactions. Settlement is
                permissionless, so an empty list here means nothing has been due — not that
                nobody could have.
              </p>
            ) : (
              <ol className={s.acts}>
                {keeperRows.flatMap(r => r.events.map((e, i) => (
                  <li key={`${r.signature}-${i}`} className={s.act} data-kind={kindOf(e.name)}>
                    <span className={s.actKind}>{kindOf(e.name)}</span>
                    <span className={s.actWhen}>
                      {r.at ? <><span className="num">{etClock(r.at)}</span> <span className={s.sub}>{etDate(r.at)}</span></> : 'pending'}
                    </span>
                    <span className={s.actText}>
                      {describe(e, 6)}
                      <a className={`mono ${s.sig}`} href={explorer(r.signature)} target="_blank" rel="noreferrer"> {short(r.signature, 4)} <Icon name="external" size={11} /></a>
                    </span>
                  </li>
                )))}
              </ol>
            )}
          </section>

          <p className={s.foot}>
            The token is on mainnet; the vault it keeps is on devnet, because a mainnet vault
            needs the program deployed there and real inventory in it. Both facts are stated
            wherever either appears. <Link to="/how-it-works#status">What is and is not live</Link>
          </p>
        </div>
      )}
    </div>
  );
}
