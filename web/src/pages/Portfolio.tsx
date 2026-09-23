/* ───────────────────────────────────────────────────────────────────────────
   /portfolio — what do I own, and what does the next bell do to it?

   Every figure is read from the chain for the connected wallet: its share
   balances in each vault on devnet, valued at the NAV the vault carries, and
   its P&L from its own mints and redeems (each priced at the NAV it landed
   at). The signature panel runs the program's `settle()` on the vault's
   current state at the live mark, so a holder can see the handoff before it
   happens — which class takes the stock, which goes to quote, and what the
   bell would pay or charge — rather than finding out after.

   Positions in the in-browser simulation are listed separately and never
   counted in the totals: they are not owned.
   ─────────────────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { SESSION_EVENT } from '@sdk/vault.ts';
import { statement } from '@sdk/statement.ts';
import {
  useChainVault, useDevnets, useWalletTrades, explorerAddr, short, type Devnet,
} from '@/lib/chain';
import { useMarkets, fmtUsd, type Asset } from '@/lib/data';
import { useSession, etClock, etDate } from '@/lib/session';
import { previewChainBell, holdingChange, type BellPreview } from '@/lib/bell';
import { loadVault, fromShares, navToNumber } from '@/lib/localVault';
import { classStem } from '@/components/trade/engines';
import { useWalletModal } from '@/components/wallet/WalletModal';
import { AssetAvatar } from '@/components/ui/Avatar';
import { Status, ClassTag } from '@/components/ui/Status';
import { Button } from '@/components/ui/Button';
import { Countdown } from '@/components/ui/Figures';
import { Source } from '@/components/ui/Source';
import { Icon } from '@/components/ui/Icon';
import s from './Portfolio.module.css';

type Cls = 'day' | 'night';
const CLASSES: Cls[] = ['day', 'night'];

/** Everything the page needs from one vault, reported up by its reader. */
interface VaultPos {
  m: Devnet;
  event: boolean;
  halted: boolean;
  exposed: Cls;
  names: Record<Cls, string>;
  words: Record<Cls, string>;
  nav: Record<Cls, number>;
  held: Record<Cls, number>;
  quote: number;
  /** Per class, value + out − in; null until every trade has been read. */
  pnl: Record<Cls, number> | null;
  pnlState: 'reading' | 'complete' | 'partial';
  preview: BellPreview | null;
  markUsd: number | null;
  markFeed: string;
  fetchedAt: number;
}

const atoms = (v: bigint, d: number) => Number(v) / 10 ** d;
const qty = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const signed = (n: number) => `${n > 0.004 ? '+' : n < -0.004 ? '−' : ''}${fmtUsd(Math.abs(n), 2)}`;

type Reader = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; pos: VaultPos };

/** A vault as the page draws it, for a given holding (zero without a wallet). */
function posFrom(
  d: NonNullable<ReturnType<typeof useChainVault>['data']>, m: Devnet,
  held: Record<Cls, number>, quote: number,
  pnl: Record<Cls, number> | null, pnlState: VaultPos['pnlState'],
): VaultPos {
  const v = d.vault;
  const event = v.sessionKind === SESSION_EVENT;
  const words = event ? { day: 'NOW', night: 'THEN' } : { day: 'DAY', night: 'NIGHT' };
  const stem = classStem(m.symbol, m.vaultSymbol);
  return {
    m, event, halted: v.halted, exposed: v.exposed as Cls,
    names: { day: `${stem}.${words.day}`, night: `${stem}.${words.night}` }, words,
    nav: { day: navToNumber(v.dayNav), night: navToNumber(v.nightNav) },
    held, quote, pnl, pnlState,
    preview: previewChainBell(d),
    markUsd: d.markUsd, markFeed: m.markFeed, fetchedAt: d.fetchedAt,
  };
}

/** Reads one vault for the wallet and reports what it found. Renders nothing. */
function VaultReader({ m, onData }: { m: Devnet; onData: (sym: string, r: Reader) => void }) {
  const { publicKey } = useWallet();
  const chain = useChainVault(m);
  const mine = useWalletTrades(m, publicKey);
  const d = chain.data;
  const failed = chain.status === 'error' && !d ? chain.error.message : null;

  useEffect(() => {
    if (failed) { onData(m.symbol, { status: 'error', message: failed }); return; }
    // `me` is null for a read that began before the wallet connected; the
    // re-read that connecting triggers carries it.
    if (!d || !d.me || !publicKey) { onData(m.symbol, { status: 'loading' }); return; }
    const qd = d.vault.quoteDecimals;
    let pnl: Record<Cls, number> | null = null;
    if (mine.state === 'complete' && mine.events) {
      const st = statement(mine.events, publicKey.toBase58(), d.vault.nightNav, d.vault.dayNav);
      pnl = { day: atoms(st.day.pnl, qd), night: atoms(st.night.pnl, qd) };
    }
    onData(m.symbol, {
      status: 'ready',
      pos: posFrom(d, m, { day: atoms(d.me.day, qd), night: atoms(d.me.night, qd) }, atoms(d.me.quote, qd), pnl, mine.state),
    });
  }, [d, failed, mine.events, mine.state, publicKey, m, onData]);

  return null;
}

export default function Portfolio() {
  const { publicKey, connected } = useWallet();
  const { setOpen } = useWalletModal();
  const vaults = useDevnets();
  const markets = useMarkets();
  const [data, setData] = useState<Record<string, Reader>>({});

  const onData = useCallback((sym: string, r: Reader) => {
    setData(prev => (prev[sym] === r ? prev : { ...prev, [sym]: r }));
  }, []);

  // Drop what the last wallet reported when the wallet changes.
  useEffect(() => { setData({}); }, [publicKey]);

  const assets = markets.data?.assets ?? [];
  const bySymbol = useMemo(() => new Map(assets.map(a => [a.symbol, a])), [assets]);
  const states = vaults ? vaults.map(m => data[m.symbol] ?? { status: 'loading' as const }) : [];
  const read = states.flatMap(r => (r.status === 'ready' ? [r.pos] : []));
  const errors = vaults ? vaults.flatMap(m => { const r = data[m.symbol]; return r?.status === 'error' ? [{ sym: m.symbol, message: r.message }] : []; }) : [];
  const loading = connected && (!vaults || states.some(r => r.status === 'loading'));

  return (
    <div className={s.page}>
      {connected && vaults?.map(m => <VaultReader key={m.symbol} m={m} onData={onData} />)}

      <header className={s.head}>
        <div>
          <h1 className={s.title}>Portfolio</h1>
          <p className={s.sub}>
            {connected && publicKey
              ? <>Positions held by <a href={explorerAddr(publicKey.toBase58())} target="_blank" rel="noreferrer" className="mono">{short(publicKey, 4)} <Icon name="external" size={11} /></a> in every SESSION vault, read from the chain.</>
              : 'What you hold in each vault, and what the next bell does to it.'}
          </p>
        </div>
        <div className={s.badges}>
          <Status kind="devnet" label="Live · devnet" pulse />
          <Status kind="devnet" label="Test funds" bare />
        </div>
      </header>

      {!connected ? (
        <section className={s.empty} aria-label="Not connected">
          <Icon name="wallet" size={22} />
          <h2 className={s.emptyTitle}>Connect a wallet to see what you own</h2>
          <p className={s.emptyBody}>
            Your DAY and NIGHT balances are read straight from your token accounts — nothing is stored here.
            Positions are on Solana devnet with test funds; the NVDAx vault has a faucet for test quote.
          </p>
          <div className={s.emptyActions}>
            <Button onClick={() => setOpen(true)}><Icon name="wallet" size={14} /> Connect wallet</Button>
            <Button variant="secondary" to="/markets">Browse markets</Button>
          </div>
        </section>
      ) : null}
      {!connected && vaults?.filter(m => m.sessionKind !== SESSION_EVENT).map(m => <PublicBell key={m.symbol} m={m} />)}
      {!connected ? null : loading ? (
        <PortfolioSkeleton />
      ) : (
        <>
          {errors.map(e => (
            <p key={e.sym} className={s.error} role="alert">
              <strong>{e.sym} could not be read.</strong> {e.message}. The public devnet endpoint rate-limits; this page
              retries on its own, and nothing from that vault is counted until it answers.
            </p>
          ))}
          <Holdings read={read} bySymbol={bySymbol} />
        </>
      )}

      <Simulated assets={assets} />
    </div>
  );
}

function Holdings({ read, bySymbol }: { read: VaultPos[]; bySymbol: Map<string, Asset> }) {
  const sess = useSession();
  const rows = read.flatMap(p => CLASSES.filter(c => p.held[c] > 0).map(c => ({ p, c })));
  const value = (p: VaultPos, c: Cls) => p.held[c] * p.nav[c];
  const total = rows.reduce((t, r) => t + value(r.p, r.c), 0);
  const byWord = (w: string) => rows.filter(r => r.p.words[r.c] === w).reduce((t, r) => t + value(r.p, r.c), 0);
  const day = byWord('DAY'), night = byWord('NIGHT'), event = byWord('NOW') + byWord('THEN');
  const exposedNow = rows.filter(r => r.p.exposed === r.c).reduce((t, r) => t + value(r.p, r.c), 0);
  // The test quote is one mint across the devnet vaults; count it once.
  const quote = new Map(read.map(p => [p.m.quoteMint, p.quote]));
  const quoteTotal = [...quote.values()].reduce((a, b) => a + b, 0);
  const pnlKnown = rows.every(r => r.p.pnl !== null);
  const pnlTotal = pnlKnown ? rows.reduce((t, r) => t + (r.p.pnl ? r.p.pnl[r.c] : 0), 0) : null;
  const nvda = read.find(p => !p.event);

  return (
    <>
      <section className={s.summary} aria-label="Summary">
        <div className={s.tile} data-lead>
          <span className={s.label}>Total value · at NAV</span>
          <span className={`num ${s.big}`}>{fmtUsd(total, 2)}</span>
          <span className={s.note}>
            {pnlTotal === null ? 'P&L: reading your trades…' : <>P&L <span className="num" data-sign={pnlTotal > 0 ? 'pos' : pnlTotal < 0 ? 'neg' : 'zero'}>{signed(pnlTotal)}</span> · plus <span className="num">{fmtUsd(quoteTotal, 2)}</span> test quote</>}
          </span>
        </div>
        <div className={s.tile} data-cls="day">
          <span className={s.label}><ClassTag cls="day" quiet>DAY</ClassTag></span>
          <span className={`num ${s.mid}`}>{fmtUsd(day, 2)}</span>
          <span className={s.note}>{total > 0 ? `${Math.round((day / total) * 100)}% of the book` : '—'}</span>
        </div>
        <div className={s.tile} data-cls="night">
          <span className={s.label}><ClassTag cls="night" quiet>NIGHT</ClassTag></span>
          <span className={`num ${s.mid}`}>{fmtUsd(night, 2)}</span>
          <span className={s.note}>{total > 0 ? `${Math.round((night / total) * 100)}% of the book` : '—'}</span>
        </div>
        {event > 0 && (
          <div className={s.tile}>
            <span className={s.label}>NOW / THEN</span>
            <span className={`num ${s.mid}`}>{fmtUsd(event, 2)}</span>
            <span className={s.note}>event vaults — no bell</span>
          </div>
        )}
        <div className={s.tile}>
          <span className={s.label}>Holding the stock now</span>
          <span className={`num ${s.mid}`}>{fmtUsd(exposedNow, 2)}</span>
          <span className={s.note}>{sess ? <>{sess.holder} active · {sess.isOpen ? 'NYSE open' : 'NYSE closed'}</> : '—'}</span>
        </div>
        <div className={s.tile}>
          <span className={s.label}>Next handoff</span>
          {sess ? <Countdown seconds={sess.until} className={s.mid} label="Next handoff in" /> : <span className="skeleton" style={{ width: 100, height: 22 }} />}
          <span className={s.note}>{sess ? <>{sess.holder} → {sess.handsTo}{sess.next ? ` · ${etClock(sess.next)} ET` : ''}</> : ''}</span>
        </div>
      </section>

      {total > 0 && (
        <div className={s.split} aria-hidden="true">
          <span data-cls="day" style={{ flexGrow: day }} />
          <span data-cls="night" style={{ flexGrow: night }} />
          {event > 0 && <span data-cls="event" style={{ flexGrow: event }} />}
        </div>
      )}

      {read.filter(p => !p.event).map(p => <NextBell key={p.m.symbol} p={p} />)}

      <section className={s.card} aria-label="Positions">
        <header className={s.cardHead}>
          <h2 className={s.cardTitle}>Positions</h2>
          <Source kind="chain" detail="Your share token accounts, devnet" ageSec={read.length ? Math.max(0, Math.floor(Date.now() / 1000) - Math.min(...read.map(p => p.fetchedAt))) : null} />
        </header>
        {rows.length === 0 ? (
          <div className={s.none}>
            <p><strong>No positions yet.</strong> You hold no DAY or NIGHT shares in any vault on devnet.</p>
            {nvda && <Button size="sm" to={`/markets/${nvda.m.symbol}`}>Mint {nvda.names[nvda.exposed === 'day' ? 'night' : 'day']}</Button>}
          </div>
        ) : (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th scope="col">Asset</th><th scope="col">Class</th><th scope="col">Shares</th><th scope="col">NAV</th>
                  <th scope="col">Value</th><th scope="col">P&amp;L</th><th scope="col">Now</th><th scope="col">At the next bell</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ p, c }) => {
                  const a = bySymbol.get(p.m.symbol);
                  const change = p.preview ? p.held[c] * (p.preview.navAfter[c] - p.preview.navBefore[c]) : null;
                  const pnl = p.pnl ? p.pnl[c] : null;
                  return (
                    <tr key={`${p.m.symbol}-${c}`}>
                      <th scope="row">
                        <Link to={`/markets/${p.m.symbol}`} className={s.asset}>
                          <AssetAvatar symbol={p.m.symbol} kind={a?.category} size="sm" />
                          <span className="mono">{p.m.symbol}</span>
                        </Link>
                      </th>
                      <td><span className={s.cls} data-class={c}>{p.names[c]}</span></td>
                      <td className="num">{qty(p.held[c])}</td>
                      <td className="num">{p.nav[c].toFixed(4)}</td>
                      <td className="num">{fmtUsd(value(p, c), 2)}</td>
                      <td className="num" data-sign={pnl === null ? undefined : pnl > 0.004 ? 'pos' : pnl < -0.004 ? 'neg' : 'zero'}>
                        {pnl !== null ? signed(pnl) : p.pnlState === 'partial' ? <span title="Not every trade could be read from the endpoint">—</span> : '…'}
                      </td>
                      <td>{p.exposed === c ? <span className={s.state} data-on>holding the stock</span> : <span className={s.state}>in quote</span>}</td>
                      <td>
                        {p.event ? <span className={s.state}>no bell · next print</span>
                          : p.halted ? <span className={s.state}>vault halted</span>
                          : (
                            <span className={s.bell}>
                              {p.exposed === c ? 'goes to quote' : 'takes the stock'}
                              {change !== null && <span className="num" data-sign={change > 0.004 ? 'pos' : change < -0.004 ? 'neg' : 'zero'}> {signed(change)}</span>}
                            </span>
                          )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className={s.foot}>
          Values are shares × the NAV each vault carries on chain. P&amp;L is value plus what you redeemed minus what
          you paid in, from your own mints and redeems. The next-bell figures run the program&rsquo;s <span className="mono">settle()</span> at
          the live mark; the bell itself settles at the mark published when it rings.
        </p>
      </section>
    </>
  );
}

/** Without a wallet: the vault's own handoff, so the page still shows what it is for. */
function PublicBell({ m }: { m: Devnet }) {
  const chain = useChainVault(m);
  const d = chain.data;
  if (!d) {
    return chain.status === 'error'
      ? <p className={s.error} role="alert"><strong>{m.symbol} could not be read.</strong> {chain.error?.message}. Retrying on its own.</p>
      : <div className="skeleton" style={{ height: 240, borderRadius: 16 }} aria-hidden="true" />;
  }
  return <NextBell p={posFrom(d, m, { day: 0, night: 0 }, 0, null, 'complete')} anon />;
}

/* The signature panel: this vault's handoff, before and after, for this wallet. */
function NextBell({ p, anon }: { p: VaultPos; anon?: boolean }) {
  const sess = useSession();
  const held = p.held;
  const holds = held.day > 0 || held.night > 0;
  const pv = p.preview;
  const after: Cls = pv?.exposedAfter ?? (p.exposed === 'day' ? 'night' : 'day');
  const before: Cls = p.exposed;
  const ch = pv ? holdingChange(pv, held) : null;
  const fundingPayer: Cls | null = pv && pv.funding !== 0 ? (pv.funding > 0 ? 'night' : 'day') : null;
  const behind = !!sess && sess.holder.toLowerCase() !== p.exposed;

  const side = (label: string, exposed: Cls, nav: Record<Cls, number> | null) => (
    <div className={s.side}>
      <span className={s.sideLabel}>{label}</span>
      {CLASSES.map(c => {
        const on = c === exposed;
        const v = nav ? held[c] * nav[c] : null;
        return (
          <div key={c} className={s.slot} data-on={on || undefined} data-cls={c}>
            <span className={s.slotRole}>{on ? 'Holding the stock' : 'In quote'}</span>
            <span className={s.slotName}>{p.names[c]}</span>
            <span className={`num ${s.slotVal}`}>{held[c] > 0 && v !== null ? fmtUsd(v, 2) : '—'}</span>
            <span className={s.slotNav}>NAV <span className="num">{nav ? nav[c].toFixed(6) : '—'}</span></span>
          </div>
        );
      })}
    </div>
  );

  return (
    <section className={s.bellCard} aria-label={`${p.m.symbol} at the next bell`}>
      <header className={s.cardHead}>
        <div>
          <span className={s.eyebrow}>Your exposure at the next bell</span>
          <h2 className={s.cardTitle}>
            {p.m.symbol} · {behind ? 'the bell that just rang' : sess?.next ? `${etClock(sess.next)} ET, ${etDate(sess.next)}` : 'next bell'}
          </h2>
        </div>
        {sess && !behind && <span className={s.bellClock}><Countdown seconds={sess.until} label="Bell in" /></span>}
      </header>

      {p.halted ? (
        <p className={s.none}>The vault is halted. Nothing settles until the missed bells are replayed and it is resumed.</p>
      ) : (
        <>
          <div className={s.flow}>
            {side('Now', before, pv?.navBefore ?? p.nav)}
            <div className={s.arrow} aria-hidden="true"><Icon name="chevronRight" size={18} /></div>
            {side(behind ? 'Once it settles' : 'After the bell', after, pv?.navAfter ?? null)}
          </div>
          <p className={s.bellText}>
            {anon && pv
              ? <>
                  This is the vault&rsquo;s own handoff at the live mark: {p.words[before]} goes to quote and{' '}
                  <strong>{p.words[after]}</strong> takes the stock
                  {fundingPayer ? <>, the {p.words[fundingPayer]} class paying <span className="num">{fmtUsd(Math.abs(pv.funding), 2)}</span> of funding to {p.words[fundingPayer === 'day' ? 'night' : 'day']}</> : ''}.
                  {' '}Connect a wallet and it shows your own position moving through it.
                </>
              : !holds
              ? <>You hold neither class, so this bell moves nothing of yours. After it, {p.words[after]} holds the stock and <strong>{p.names[before]}</strong> is the class open to mint.</>
              : ch && pv
                ? <>
                    At the current mark, the bell would move your position from <span className="num">{fmtUsd(ch.before, 2)}</span> to{' '}
                    <strong className="num">{fmtUsd(ch.after, 2)}</strong> (<span className="num" data-sign={ch.change > 0.004 ? 'pos' : ch.change < -0.004 ? 'neg' : 'zero'}>{signed(ch.change)}</span>)
                    {fundingPayer ? <>, the <strong>{p.words[fundingPayer]}</strong> class paying <span className="num">{fmtUsd(Math.abs(pv.funding), 2)}</span> of funding to {p.words[fundingPayer === 'day' ? 'night' : 'day']} across the vault</> : ', with no funding due'}.
                    {held[after] > 0 && <> Your {qty(held[after])} {p.words[after]} then carry the stock.</>}
                    {held[before] > 0 && <> Your {qty(held[before])} {p.words[before]} go to quote, carrying what they earned.</>}
                  </>
                : <>The live mark is unavailable, so the bell cannot be previewed. Your {held[after] > 0 ? p.words[after] : p.words[before]} position is shown at the NAV it carries now.</>}
          </p>
          <p className={s.bellFoot}>
            Computed with the program&rsquo;s <span className="mono">settle()</span> at the live mark
            {p.markUsd !== null ? <> (<span className="num">{fmtUsd(p.markUsd)}</span>, Pyth {p.markFeed})</> : null}. The bell settles at the mark
            published when it rings; on this devnet vault that mark is a stand-in feed, not {p.m.symbol}&rsquo;s own price.
          </p>
        </>
      )}
    </section>
  );
}

/** Simulated positions in this browser: listed for convenience, never counted as owned. */
function Simulated({ assets }: { assets: Asset[] }) {
  const [rows, setRows] = useState<{ a: Asset; day: number; night: number; nav: Record<Cls, number>; settled: number }[]>([]);
  useEffect(() => {
    const out: typeof rows = [];
    for (const a of assets) {
      const v = loadVault(a.symbol);
      if (!v) continue;
      const day = fromShares(v.myDay), night = fromShares(v.myNight);
      if (day <= 0 && night <= 0) continue;
      out.push({ a, day, night, nav: { day: navToNumber(v.dayNav), night: navToNumber(v.nightNav) }, settled: v.lastBoundaryTs });
    }
    setRows(out);
  }, [assets]);
  if (!rows.length) return null;
  return (
    <section className={s.card} aria-label="Simulated positions">
      <header className={s.cardHead}>
        <h2 className={s.cardTitle}>In the simulation</h2>
        <Status kind="simulated" label="This browser · not owned" />
      </header>
      <ul className={s.simList}>
        {rows.map(r => (
          <li key={r.a.symbol}>
            <Link to={`/markets/${r.a.symbol}`} className={s.asset}>
              <AssetAvatar symbol={r.a.symbol} kind={r.a.category} size="sm" />
              <span className="mono">{r.a.symbol}</span>
            </Link>
            <span className={s.simHold}>
              {r.day > 0 && <span><span className={s.cls} data-class="day">DAY</span> <span className="num">{qty(r.day)}</span> ≈ <span className="num">{fmtUsd(r.day * r.nav.day, 2)}</span></span>}
              {r.night > 0 && <span><span className={s.cls} data-class="night">NIGHT</span> <span className="num">{qty(r.night)}</span> ≈ <span className="num">{fmtUsd(r.night * r.nav.night, 2)}</span></span>}
            </span>
            <span className={s.simWhen}>settled to {etClock(r.settled)} ET {etDate(r.settled)}</span>
          </li>
        ))}
      </ul>
      <p className={s.foot}>Balances the simulation keeps in this browser, at the NAV of its last settlement here. They are not on any chain and are not counted above.</p>
    </section>
  );
}

function PortfolioSkeleton() {
  return (
    <div className={s.skel} aria-busy="true">
      <div className={s.summary}>
        {Array.from({ length: 5 }, (_, i) => <div key={i} className="skeleton" style={{ height: 96, borderRadius: 12 }} />)}
      </div>
      <div className="skeleton" style={{ height: 220, borderRadius: 16 }} />
      <div className="skeleton" style={{ height: 180, borderRadius: 16 }} />
      <p className="sr-only" role="status">Reading your positions from devnet</p>
    </div>
  );
}
