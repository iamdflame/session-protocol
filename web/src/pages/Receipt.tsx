/* The receipt for one cross: the price it cleared at, why that price, who
 * got what, and what a swap would have done instead.
 *
 * Every figure is read from the chain on this visit. The print's signature
 * is checked again in this browser, over the bytes the program parsed. The
 * swap beside the fill is the keeper's Jupiter quote at the bell, written
 * into the transaction that priced the cross; without it the page claims
 * nothing about savings. On devnet the cross trades a fixture NVDAx at a
 * simulated print while the swap is a real mainnet quote, and the page says
 * so where the two meet. */
import { useMemo, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { decimalPrice, SESSION, SESSION_UNREPORTED } from '@sdk/bell.ts';
import { COUNTERFACTUAL_TAG, edgeBps, type SwapQuote } from '@sdk/counterfactual.ts';
import type { CrossAccount } from '@sdk/cross-ix.ts';
import { useReceipt, type PrintCheck, type ReceiptState } from '@/lib/receipt';
import { displayed, noteState, priceOf, readNotes, type NoteState } from '@/lib/bellOrders';
import { explorer, explorerAddr, short } from '@/lib/chain';
import { etDate, etParts } from '@/lib/session';
import { Status } from '@/components/ui/Status';
import { Icon } from '@/components/ui/Icon';
import s from './Receipt.module.css';

const REPO = 'https://github.com/iamdflame/session-protocol/blob/main';
const usd = (n: number, d = 2) => `$${n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const tok = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 4 });
const pct = (n: number) => `${(n * 100).toFixed(n >= 0.9995 || n === 0 ? 0 : 2)}%`;
const bps = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(2)} bp`;
const two = (n: number) => String(n).padStart(2, '0');
/** 09:30:14 ET, and to the millisecond when given microseconds. */
const etTime = (ts: number) => { const p = etParts(ts); return `${two(p.hh)}:${two(p.mm)}:${two(p.ss)}`; };
const etTimeUs = (us: bigint) => `${etTime(Number(us / 1_000_000n))}.${String((us / 1000n) % 1000n).padStart(3, '0')}`;
function fromBell(us: bigint, bell: number): string {
  const ms = Number(us / 1000n) - bell * 1000;
  const sign = ms > 0 ? '+' : ms < 0 ? '−' : '';
  return `${sign}${(Math.abs(ms) / 1000).toFixed(Math.abs(ms) < 10_000 ? 2 : 1)} s`;
}
const confBps = (conf: bigint, price: bigint) => (price > 0n ? `${(Number((conf * 1_000_000n) / price) / 100).toFixed(2)} bp` : '—');

function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className={s.check} data-ok={ok}>
      <span className={s.mark} aria-hidden="true">{ok ? <Icon name="check" size={13} /> : '✕'}</span>
      <span><span className="sr-only">{ok ? 'Passed: ' : 'Failed: '}</span>{children}</span>
    </li>
  );
}

function Tx({ sig, label }: { sig: string; label?: string }) {
  return <a className={s.link} href={explorer(sig)} target="_blank" rel="noreferrer">{label ?? short(sig, 6)} <Icon name="external" size={11} /></a>;
}
function Addr({ addr, label }: { addr: string; label?: string }) {
  return <a className={s.link} href={explorerAddr(addr)} target="_blank" rel="noreferrer">{label ?? short(addr, 4)} <Icon name="external" size={11} /></a>;
}

/* ── against a swap ─────────────────────────────────────────────────────── */

function SwapSide({ side, q, c, m, at }: { side: 'buy' | 'sell'; q: SwapQuote | undefined; c: CrossAccount; m: bigint; at: number }) {
  const cl = c.clearing;
  const [crossIn, crossOut] = side === 'buy' ? [cl.buySpent, cl.buyTokens] : [cl.sellSpent, cl.sellQuote];
  const who = side === 'buy' ? 'Buyers' : 'Sellers';
  const inText = (v: bigint) => (side === 'buy' ? usd(Number(v) / 1e6) : `${tok(displayed(v, m, 8))} NVDAx`);
  const outText = (v: bigint) => (side === 'buy' ? `${tok(displayed(v, m, 8))} NVDAx` : usd(Number(v) / 1e6));
  if (!q) return null;
  if ('noRoute' in q) {
    return (
      <div className={s.swap}>
        <p className={s.swapHead}>{who}</p>
        <p className={s.swapLine}>Jupiter found no route for the same size at {etTime(at)} ET ({q.noRoute}). The cross filled it anyway.</p>
      </div>
    );
  }
  const edge = edgeBps(crossIn, crossOut, BigInt(q.in), BigInt(q.out));
  return (
    <div className={s.swap}>
      <p className={s.swapHead}>{who}</p>
      <dl className={s.rows}>
        <div><dt>In the cross</dt><dd><span className="num">{outText(crossOut)}</span><span className={s.sub}>for {inText(crossIn)}</span></dd></div>
        <div><dt>A swap, at {etTime(at)} ET</dt><dd><span className="num">{outText(BigInt(q.out))}</span><span className={s.sub}>for {inText(BigInt(q.in))} · {q.route || 'direct'} · impact {(q.impactPct * 100).toFixed(3)}%</span></dd></div>
        <div>
          <dt>Per {side === 'buy' ? 'dollar' : 'token'}, the cross gave</dt>
          <dd><span className="num" data-edge={edge === null ? undefined : edge >= 0 ? 'better' : 'worse'}>{edge === null ? '—' : bps(edge)}</span><span className={s.sub}>{edge === null ? 'nothing filled to compare' : edge >= 0 ? 'more than the swap' : 'less than the swap'}</span></dd>
        </div>
      </dl>
    </div>
  );
}

function AgainstASwap({ st, c }: { st: ReceiptState; c: CrossAccount }) {
  const r = st.counterfactual;
  const body = (() => {
    if ('cf' in r) {
      const cf = r.cf;
      return (
        <>
          <SwapSide side="buy" q={cf.buy} c={c} m={st.multiplier} at={cf.at} />
          <SwapSide side="sell" q={cf.sell} c={c} m={st.multiplier} at={cf.at} />
          <p className={s.note}>
            Quoted by the keeper {cf.at - c.bellTs >= 0 ? `${cf.at - c.bellTs} s after` : `${c.bellTs - cf.at} s before`} the bell, for the real
            NVDAx on mainnet (<Addr addr={cf.mint} label={short(cf.mint, 4)} />), and written into the transaction that priced this
            cross (<Tx sig={r.signature} />). {c.simulated ? 'The cross itself is a devnet sandbox at a simulated print, so this compares a real swap with a rehearsal of the cross; on mainnet both sides are real.' : ''}
          </p>
        </>
      );
    }
    if ('untrusted' in r) {
      return <p className={s.empty}>A swap quote was attached to the price by {short(r.untrusted, 4)}, not by this market&rsquo;s keeper, so it is not shown (<Tx sig={r.signature} />).</p>;
    }
    return (
      <p className={s.empty}>
        {r.missing === 'unavailable'
          ? `The swap quote could not be read just now (${r.why ?? 'the RPC refused'}). This page will try again.`
          : 'No swap was quoted beside this cross, so this receipt makes no claim about what it saved.'}
      </p>
    );
  })();
  return (
    <section className={`${s.card} ${s.wide}`} aria-labelledby="swap-h">
      <h2 id="swap-h" className={s.cardTitle}>Against a swap at the same moment</h2>
      {body}
    </section>
  );
}

/* ── the print ──────────────────────────────────────────────────────────── */

function ThePrint({ st, c }: { st: ReceiptState; c: CrossAccount }) {
  const p = st.print;
  const check = st.printCheck;
  if (!p) return null;
  const e = p.equity;
  const pc: PrintCheck | null = 'missing' in check ? null : check;
  const gap = 'missing' in check ? check : null;
  return (
    <section className={s.card} aria-labelledby="print-h">
      <h2 id="print-h" className={s.cardTitle}>The print</h2>
      {e.present ? (
        <dl className={s.rows}>
          <div><dt>NVDA</dt><dd><span className="num">${decimalPrice(e.price, e.expo)}</span><span className={s.sub}>mantissa {e.price.toString()}, exponent {e.expo}</span></dd></div>
          <div><dt>Priced at</dt><dd><span className="num">{etTimeUs(e.feedTsUs)} ET</span><span className={s.sub}>{fromBell(e.feedTsUs, c.bellTs)} from the bell</span></dd></div>
          <div><dt>Confidence</dt><dd><span className="num">{confBps(e.conf, e.price)}</span><span className={s.sub}>{e.publishers} publisher(s) · {e.session === SESSION_UNREPORTED ? 'session not reported' : SESSION[e.session] ?? e.session}</span></dd></div>
        </dl>
      ) : (
        <p className={s.warn}>No price arrived in the bell&rsquo;s window; the print is marked missing and the cross refunded everyone.</p>
      )}
      {pc ? (
        <ul className={s.checks} aria-label="Checks on the print">
          <Check ok={pc.verifiedHere}>Signature checked again in this browser: Ed25519 by {short(pc.signer, 4)} over the signed payload</Check>
          <Check ok={pc.precompile}>The transaction opens with the Ed25519 precompile, which the verifier requires</Check>
          <Check ok={pc.matchesPrint}>What was signed equals what the print stored, field by field</Check>
        </ul>
      ) : e.present && gap ? (
        <p className={s.empty}>{gap.missing === 'unavailable' ? `The print’s transaction could not be read just now (${gap.why ?? 'the RPC refused'}); the checks will run when it can be.` : gap.why}</p>
      ) : null}
      <p className={s.note}>
        {p.simulated
          ? <>Signed by a <strong>simulated signer</strong>, a test key, from Jupiter&rsquo;s reference price, and verified by Pyth&rsquo;s own verifier code redeployed on devnet to trust that key. With a Pyth Pro key the same path carries Pyth&rsquo;s signature.</>
          : <>Signed by Pyth ({short(p.signer, 4)}) and verified on chain by Pyth&rsquo;s own program.</>}
        {' '}{pc && <>Posted in <Tx sig={pc.signature} />; </>}the print account is <Addr addr={c.print.toBase58()} />. Every print is on <Link to="/oracle">/oracle</Link>.
      </p>
    </section>
  );
}

/* ── the cross ──────────────────────────────────────────────────────────── */

function TheCross({ st, c }: { st: ReceiptState; c: CrossAccount }) {
  const cl = c.clearing;
  const m = st.multiplier;
  const priced = c.pricedAt > 0;
  const freeze = Number(st.manifest.params.freezeSecs);
  const steps: { label: string; at: string | null; done: boolean }[] = [
    { label: 'Book froze', at: `${etTime(c.bellTs - freeze)} ET`, done: Date.now() / 1000 >= c.bellTs - freeze },
    { label: 'Priced', at: c.pricedAt ? `${etTime(c.pricedAt)} ET` : null, done: !!c.pricedAt },
    { label: 'Auction closed', at: c.auctionEnd ? `${etTime(c.auctionEnd)} ET` : null, done: c.phase === 'settling' },
    { label: 'Cleared', at: c.clearedAt ? `${etTime(c.clearedAt)} ET` : null, done: !!c.clearedAt },
    { label: 'Settled', at: `${c.nSettled} of ${c.nOrders} orders`, done: (c.phase === 'settling' || c.phase === 'cancelled') && c.nSettled === c.nOrders },
  ];
  const buyRatio = cl.buyIn > 0n ? Number((cl.buySpent * 10_000n) / cl.buyIn) / 10_000 : null;
  const sellRatio = cl.sellIn > 0n ? Number((cl.sellSpent * 10_000n) / cl.sellIn) / 10_000 : null;
  const balanced = c.quoteIn === c.quoteOut && c.rawIn === c.rawOut;
  return (
    <section className={`${s.card} ${st.print ? '' : s.wide}`} aria-labelledby="cross-h">
      <h2 id="cross-h" className={s.cardTitle}>The cross</h2>
      <ol className={s.steps} aria-label="What happened, in order">
        {steps.map((x) => (
          <li key={x.label} data-done={x.done}>
            <span className={s.stepLabel}>{x.label}</span>
            <span className={s.sub}>{x.at ?? '—'}</span>
          </li>
        ))}
      </ol>
      {c.phase === 'cancelled' ? (
        <p className={s.warn}>
          This cross was cancelled{st.print?.status === 'missing' ? ': the bell\u2019s print was missing' : ''}, and every order is refunded whole ({c.nSettled} of {c.nOrders} so far).
          {st.print?.status !== 'missing' && ' The program logs its reason in the cancelling transaction, listed below.'}
        </p>
      ) : (
        <dl className={s.rows}>
          <div><dt>Buyers</dt><dd><span className="num">{usd(Number(c.buyTotal) / 1e6)}</span><span className={s.sub}>{priced ? `${usd(Number(cl.buyIn) / 1e6)} inside their limits at the print` : 'limits are read against the print'}</span></dd></div>
          <div><dt>Sellers</dt><dd><span className="num">{tok(displayed(c.sellTotal, m, 8))} NVDAx</span><span className={s.sub}>{priced ? `${tok(displayed(cl.sellIn, m, 8))} inside their limits at the print` : `${c.nOrders} order(s) on both sides`}</span></dd></div>
          {priced && (
            <div><dt>Larger side</dt><dd><span className="num">{cl.crowded === 'balanced' ? 'neither' : cl.crowded}</span><span className={s.sub}>{cl.crowded === 'balanced' ? 'no maker needed, no fee' : `${c.nOffers} maker offer(s); ${cl.feeBps} bp on the part makers filled`}</span></dd></div>
          )}
          {c.phase === 'settling' && (
            <>
              <div><dt>Buyers got</dt><dd><span className="num">{tok(displayed(cl.buyTokens, m, 8))} NVDAx</span><span className={s.sub}>for {usd(Number(cl.buySpent) / 1e6)}{buyRatio !== null ? `, ${pct(buyRatio)} filled` : ''}</span></dd></div>
              <div><dt>Sellers got</dt><dd><span className="num">{usd(Number(cl.sellQuote) / 1e6)}</span><span className={s.sub}>for {tok(displayed(cl.sellSpent, m, 8))} NVDAx{sellRatio !== null ? `, ${pct(sellRatio)} filled` : ''}</span></dd></div>
            </>
          )}
          <div>
            <dt>Escrow</dt>
            <dd>
              <span className="num">{balanced && c.phase === 'settling' ? 'every atom out' : 'still held'}</span>
              <span className={s.sub}>{usd(Number(c.quoteIn) / 1e6)} in, {usd(Number(c.quoteOut) / 1e6)} out · {tok(displayed(c.rawIn, m, 8))} NVDAx in, {tok(displayed(c.rawOut, m, 8))} out</span>
            </dd>
          </div>
        </dl>
      )}
      <p className={s.note}>
        The arithmetic is <a className={s.link} href={`${REPO}/docs/CROSS.md`} target="_blank" rel="noreferrer">docs/CROSS.md</a>; the program that did it is session-cross (<Addr addr={st.manifest.program} />).
      </p>
    </section>
  );
}

/* ── the viewer's own orders ────────────────────────────────────────────── */

const MINE_TEXT: Record<NoteState['state'], string> = {
  pending: 'placed; not on chain yet', cancelled: 'cancelled before the freeze; refunded whole', refunded: 'the cross was cancelled; refunded whole',
  closed: 'settled', filled: '', unfilled: 'the print broke the limit; refunded whole',
};

function Yours({ st, c }: { st: ReceiptState; c: CrossAccount }) {
  const { publicKey } = useWallet();
  const mine = useMemo(() => readNotes(publicKey ?? null).filter((n) => n.cross === st.address.toBase58()), [publicKey, st.address]);
  if (!publicKey || mine.length === 0) return null;
  const m = st.multiplier;
  return (
    <section className={`${s.card} ${s.wide}`} aria-labelledby="yours-h">
      <h2 id="yours-h" className={s.cardTitle}>Your orders in it</h2>
      <ul className={s.list}>
        {mine.map((n) => {
          const is = noteState(n, c, Date.now());
          const amount = BigInt(n.amount);
          const what = n.side === 'buy' ? `Buy ${usd(Number(amount) / 1e6)}` : `Sell ${tok(displayed(amount, m, 8))} NVDAx`;
          const result = is.state === 'filled'
            ? n.side === 'buy'
              ? `got ${tok(displayed(is.got, m, 8))} NVDAx for ${usd(Number(is.spent) / 1e6)}`
              : `got ${usd(Number(is.got) / 1e6)} for ${tok(displayed(is.spent, m, 8))} NVDAx`
            : MINE_TEXT[is.state];
          return (
            <li key={n.order}>
              <strong>{what}</strong> <span className={s.sub}>{result}</span> <Tx sig={n.signature} label="placed" />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ── the record ─────────────────────────────────────────────────────────── */

function Record({ st }: { st: ReceiptState }) {
  const h = st.history;
  return (
    <section className={`${s.card} ${s.wide}`} aria-labelledby="record-h">
      <h2 id="record-h" className={s.cardTitle}>Every transaction that touched it</h2>
      {!h ? (
        <p className={s.empty}>The RPC would not serve the history just now; the explorer has it: <Addr addr={st.address.toBase58()} label="the cross on the explorer" />.</p>
      ) : (
        <ol className={s.record}>
          {h.slice(0, 40).map((x) => (
            <li key={x.signature}>
              <span className="num">{x.blockTime ? `${etDate(x.blockTime)} ${etTime(x.blockTime)} ET` : '—'}</span>
              <span className={s.sub}>{x.err ? 'failed' : x.memo?.includes(COUNTERFACTUAL_TAG) ? 'priced, with the swap quote' : ''}</span>
              <Tx sig={x.signature} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/* ── the page ───────────────────────────────────────────────────────────── */

function parse(param: string | undefined): PublicKey | null {
  try {
    return param ? new PublicKey(param) : null;
  } catch {
    return null;
  }
}

export default function Receipt() {
  const { cross: param } = useParams();
  const address = useMemo(() => parse(param), [param]);
  const { data, error } = useReceipt(address);
  const c = data?.cross ?? null;
  const title = c ? `NVDAx at the ${c.kind} of ${etDate(c.bellTs)}` : 'A bell-order receipt';
  const price = c && c.pricedAt && c.priceMantissa > 0n ? priceOf(c.priceMantissa, c.priceExpo) : null;
  const perRaw = price !== null && c ? price * (Number((c.multiplierWad * 1_000_000n) / 10n ** 18n) / 1e6) : null;

  return (
    <div className={s.page}>
      <header className={s.head}>
        <span className={s.eyebrow}>Receipt</span>
        <h1 className={s.title}>{title}</h1>
        {c && (
          <p className={s.lead}>
            {c.phase === 'settling' && 'Every order in this cross filled at one price, the bell’s print. Buyers and sellers netted against each other; makers filled what was left over. What follows is all read from the chain, now.'}
            {c.phase === 'cancelled' && 'This cross never traded: it was cancelled, and every order in it was refunded whole.'}
            {(c.phase === 'collecting' || c.phase === 'confirming' || c.phase === 'auction') && `This cross is not finished: ${c.phase === 'collecting' ? `it takes orders until two minutes before the ${c.kind}` : c.phase === 'confirming' ? 'the book is being confirmed at the print' : 'makers are bidding for the imbalance'}. The receipt completes when it settles.`}
          </p>
        )}
        <div className={s.badges}>
          <Status kind="devnet" />
          {c?.simulated && <Status kind="simulated" label="Simulated print" />}
          {c && <span className={s.phase} data-phase={c.phase}>{c.phase === 'settling' ? (c.nSettled === c.nOrders ? 'settled' : 'settling') : c.phase}</span>}
          <Link className={s.link} to="/bells">All bells</Link>
        </div>
      </header>

      {!address ? (
        <p className={s.empty}>That is not a cross address.</p>
      ) : data === undefined ? (
        <div className="skeleton" style={{ height: 320, borderRadius: 16 }} aria-busy="true" />
      ) : data === null ? (
        <p className={s.empty}>No bell-order market is deployed for this site.</p>
      ) : !c ? (
        <p className={s.empty}>
          There is no open cross at this address. The keeper closes a cross a day after it clears, and returns its rent;
          its transactions stay on chain: <Addr addr={address.toBase58()} label="the address on the explorer" />.
        </p>
      ) : (
        <>
          {error && <p className={s.warn} role="status">Not everything could be read: {error}.</p>}
          {price !== null && (
            <section className={s.hero} aria-label="The price">
              <p className={s.price}><span className="num">{usd(price)}</span> <span className={s.per}>a share</span></p>
              <p className={s.sub}>
                NVDA&rsquo;s print for the {c.kind}{data.print?.equity.present ? `, ${fromBell(data.print.equity.feedTsUs, c.bellTs)} from the ${etTime(c.bellTs).slice(0, 5)} ET bell` : ''}.
                {perRaw !== null && ` One raw NVDAx, which the mint scales by ${(Number((c.multiplierWad * 1_000_000n) / 10n ** 18n) / 1e6).toFixed(6)}, is ${usd(perRaw)}.`}
              </p>
            </section>
          )}
          <div className={s.body}>
            {c.phase === 'settling' && <AgainstASwap st={data} c={c} />}
            <TheCross st={data} c={c} />
            <ThePrint st={data} c={c} />
            <Yours st={data} c={c} />
            <Record st={data} />
          </div>
        </>
      )}
    </div>
  );
}
