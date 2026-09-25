/* Bell orders: buy or sell NVDAx at the NYSE open or close, at one price with
 * everyone else.
 *
 * The ticket places an order in a cross, the book beside it is the cross as
 * the chain holds it, and the result is what programs/session-cross cleared.
 * Nothing on the page decides a price: the bell's print does, and the page
 * only estimates from the last one, saying so. On devnet the token is a
 * fixture NVDAx and the prints come from a test signer; both are labelled
 * wherever a number could be taken for the real thing. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { bellTs, etDay, type BellKind } from '@sdk/bell.ts';
import { cancelOrderIx, crossPda, orderPda, placeOrderIx, type CrossAccount } from '@sdk/cross-ix.ts';
import { WAD } from '@sdk/cross.ts';
import {
  addNote, displayed, markCancelled, noteState, priceOf, readNotes, toRaw, useBellOrders, useSwapNow, type BellOrdersState, type NoteState,
} from '@/lib/bellOrders';
import { explorer, explorerAddr, requestFaucet, short, useSendTx } from '@/lib/chain';
import { countdown, etDate, etParts } from '@/lib/session';
import { useWalletModal } from '@/components/wallet/WalletModal';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Segmented';
import { Status } from '@/components/ui/Status';
import { Source } from '@/components/ui/Source';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import s from './Bells.module.css';

const REPO = 'https://github.com/iamdflame/session-protocol/blob/main';
const usd = (n: number, d = 2) => `$${n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const tok = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 4 });
const etTime = (ts: number) => {
  const p = etParts(ts);
  return `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
};
/** Short enough for two segments on a 375 px phone: "Close · Fri 16:00". */
const bellName = (kind: BellKind, ts: number) => `${kind === 'open' ? 'Open' : 'Close'} · ${etParts(ts).dow} ${etTime(ts)}`;

/** The next bell of each kind that is still taking orders. */
function nextBells(now: number, freeze: number): Record<BellKind, { day: number; ts: number }> {
  const out = {} as Record<BellKind, { day: number; ts: number }>;
  for (const kind of ['open', 'close'] as const) {
    for (let d = etDay(now); d < etDay(now) + 12; d++) {
      const ts = bellTs(d, kind);
      if (ts !== null && ts - freeze > now) { out[kind] = { day: d, ts }; break; }
    }
  }
  return out;
}

function Ticket({ st, now, onPlaced }: { st: BellOrdersState; now: number; onPlaced: () => void }) {
  const { publicKey, signMessage } = useWallet();
  const { connection } = useConnection();
  const { setOpen } = useWalletModal();
  const send = useSendTx();
  const toast = useToast();
  const freeze = st.manifest.params.freezeSecs;
  const bells = nextBells(now, freeze);
  const [kind, setKind] = useState<BellKind>(() => (bells.open && bells.close && bells.open.ts < bells.close.ts ? 'open' : 'close'));
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('');
  const [limit, setLimit] = useState('');
  const [busy, setBusy] = useState<'order' | 'faucet' | null>(null);

  const bell = bells[kind];
  const amt = Number(amount);
  const lim = Number(limit);
  const m = st.multiplier;
  const last = st.lastPrint ? priceOf(st.lastPrint.equity.price, st.lastPrint.equity.expo) : null;
  const heldRaw = st.balances ? displayed(st.balances.raw, m, 8) : null;
  const heldQuote = st.balances ? Number(st.balances.quote) / 1e6 : null;
  const valid = amt > 0 && (side === 'buy' ? amt >= 1 : amt >= 0.01) && (!limit || lim > 0);
  const overdrawn = side === 'buy' ? heldQuote !== null && amt > heldQuote : heldRaw !== null && amt > heldRaw;

  const place = async () => {
    if (!publicKey) { setOpen(true); return; }
    if (!bell || !valid) return;
    setBusy('order');
    try {
      const cross = crossPda(st.ref.market, bell.day, kind);
      // a nonce this wallet has no live order under in this cross
      let nonce = Math.floor(Math.random() * 65_536);
      while (await connection.getAccountInfo(orderPda(cross, publicKey, nonce))) nonce = (nonce + 1) % 65_536;
      const raw = side === 'buy' ? BigInt(Math.floor(amt * 1e6)) : toRaw(amt, m, 8);
      const limitE8 = limit ? BigInt(Math.round(lim * 1e8)) : 0n;
      const r = await send([placeOrderIx(st.ref, { owner: publicKey, day: bell.day, kind, nonce, side, amount: raw, limitE8 })]);
      if (!r.ok) { toast({ tone: 'error', title: 'Order not placed', detail: r.error }); return; }
      addNote(publicKey, {
        order: orderPda(cross, publicKey, nonce).toBase58(), cross: cross.toBase58(), day: bell.day, kind, side,
        amount: raw.toString(), limitE8: limitE8.toString(), bellTs: bell.ts, signature: r.signature, placedAt: Date.now(),
      });
      toast({
        tone: 'ok',
        title: `${side === 'buy' ? `Buy ${usd(amt)}` : `Sell ${tok(amt)} NVDAx`} at the ${kind}`,
        detail: `Fills at the ${kind === 'open' ? '09:30' : '16:00'} ET print; you can cancel for ${countdown(bell.ts - freeze - Math.floor(Date.now() / 1000))}.`,
        href: explorer(r.signature), hrefLabel: 'View transaction',
      });
      setAmount('');
      onPlaced();
    } catch (e) {
      // the nonce probe reads the chain before the wallet is asked anything
      toast({ tone: 'error', title: 'Order not placed', detail: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const faucet = async () => {
    if (!publicKey) { setOpen(true); return; }
    setBusy('faucet');
    try {
      const r = await requestFaucet(publicKey, signMessage);
      if ('error' in r) { toast({ tone: 'error', title: 'Faucet refused', detail: r.error }); return; }
      const parts = [
        r.amount && r.amount !== '0' ? `${(Number(r.amount) / 1e6).toLocaleString()} test USDC` : null,
        r.nvdax && r.nvdax !== '0' ? `${tok(displayed(BigInt(r.nvdax), m, 8))} fixture NVDAx` : null,
        r.solDripped ? 'a little SOL for fees' : null,
      ].filter(Boolean);
      toast({ tone: 'ok', title: `Sent ${parts.join(', ')}`, href: explorer(r.signature), hrefLabel: 'View transaction' });
      onPlaced();
    } finally {
      setBusy(null);
    }
  };

  const estimate = last !== null && amt > 0
    ? side === 'buy' ? `≈ ${tok(amt / last)} NVDAx` : `≈ ${usd(amt * last)}`
    : null;

  // the alternative: the same trade on Jupiter now, for the real NVDAx
  const atoms = !valid ? 0n : side === 'buy' ? BigInt(Math.floor(amt * 1e6)) : toRaw(amt, m, 8);
  const swap = useSwapNow(side, atoms, st.manifest.realMint);
  const swapOut = swap.state === 'quote' ? (side === 'buy' ? displayed(swap.out, m, 8) : Number(swap.out) / 1e6) : null;
  const bellOut = last !== null && valid ? (side === 'buy' ? amt / last : amt * last) : null;
  const edge = swapOut && bellOut ? (bellOut / swapOut - 1) * 1e4 : null;

  return (
    <section className={s.card} aria-labelledby="ticket-h">
      <h2 id="ticket-h" className={s.cardTitle}>Place a bell order</h2>
      <Segmented
        label="Which bell"
        value={kind}
        onChange={setKind}
        block
        items={(['open', 'close'] as const).filter((k) => bells[k]).map((k) => ({ value: k, label: bellName(k, bells[k].ts) }))}
      />
      {bell && <p className={s.hint}>{kind === 'open' ? 'The opening bell' : 'The closing bell'}, {etDate(bell.ts)} at {etTime(bell.ts)} ET.</p>}
      <Segmented
        label="Side"
        value={side}
        onChange={(v) => { setSide(v); setAmount(''); setLimit(''); }}
        block
        items={[{ value: 'buy', label: 'Buy NVDAx' }, { value: 'sell', label: 'Sell NVDAx' }]}
      />
      <label className={s.field}>
        <span className={s.fieldLabel}>{side === 'buy' ? 'Spend (test USDC)' : 'Sell (NVDAx)'}</span>
        <span className={s.inputRow}>
          <input
            className={s.input} inputMode="decimal" autoComplete="off" placeholder={side === 'buy' ? '1,000' : '2.5'}
            value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
          />
          {st.balances && (
            <button type="button" className={s.max} onClick={() => setAmount(String(side === 'buy' ? heldQuote : Math.floor((heldRaw ?? 0) * 1e4) / 1e4))}>
              Max
            </button>
          )}
        </span>
        <span className={s.hint}>
          {st.balances ? `You hold ${side === 'buy' ? usd(heldQuote ?? 0) : `${tok(heldRaw ?? 0)} NVDAx`}.` : 'Connect a wallet to see your balance.'}
          {' '}Minimum {side === 'buy' ? '$1' : '0.01 NVDAx'}.
        </span>
      </label>
      <label className={s.field}>
        <span className={s.fieldLabel}>
          {side === 'buy' ? 'Only if NVDA prints at or under (optional)' : 'Only if NVDA prints at or over (optional)'}
        </span>
        <span className={s.inputRow}>
          <input
            className={s.input} inputMode="decimal" autoComplete="off" placeholder={last ? last.toFixed(2) : '224.00'}
            value={limit} onChange={(e) => setLimit(e.target.value.replace(/[^0-9.]/g, ''))}
          />
        </span>
        <span className={s.hint}>A limit the print breaks means no fill, and the order comes back whole.</span>
      </label>

      <dl className={s.estimate}>
        <div>
          <dt>Now, on Jupiter</dt>
          <dd className="num">
            {swap.state === 'quote' && swapOut !== null ? (side === 'buy' ? `≈ ${tok(swapOut)} NVDAx` : `≈ ${usd(swapOut)}`)
              : swap.state === 'loading' ? 'Quoting…' : swap.state === 'none' ? 'No route' : '—'}
            <span className={s.sub}>
              {swap.state === 'quote'
                ? `a swap of the real NVDAx on mainnet, via ${swap.route || 'a direct pool'}, ${(swap.impactPct * 100).toFixed(2)}% price impact`
                : swap.state === 'none' ? `Jupiter: ${swap.why}` : 'type an amount to compare'}
            </span>
          </dd>
        </div>
        <div>
          <dt>At the bell</dt>
          <dd className="num">
            {estimate ?? (st.lastPrint ? '—' : 'No print yet')}
            {st.lastPrint && last !== null
              ? <span className={s.sub}>
                  at the last print, NVDA {usd(last)} at the {st.lastPrint.kind} of {etDate(st.lastPrint.bellTs)}; the bell&rsquo;s own print decides
                  {edge !== null && `. Per ${side === 'buy' ? 'dollar' : 'token'}, ${Math.abs(edge).toFixed(1)} bp ${edge >= 0 ? 'more' : 'less'} than the swap, before any imbalance fee`}
                </span>
              : <span className={s.sub}>the oracle records its first print at the next bell; your order fills at that bell&rsquo;s print</span>}
          </dd>
        </div>
        <div>
          <dt>Fee</dt>
          <dd>
            <span className="num">None on the matched part</span>
            <span className={s.sub}>if your side is larger, makers fill the rest; the backstop caps it at {st.manifest.backstop.feeBps} bp, on that part only</span>
          </dd>
        </div>
        <div>
          <dt>Cancel until</dt>
          <dd>
            <span className="num">{bell ? `${etTime(bell.ts - freeze)} ET` : '—'}</span>
            <span className={s.sub}>{bell ? `the book freezes ${freeze / 60} min before the bell, in ${countdown(bell.ts - freeze - now)}` : ''}</span>
          </dd>
        </div>
      </dl>

      {overdrawn && <p className={s.warn}>That is more than you hold; the faucet below has test tokens.</p>}
      <div className={s.actions}>
        <Button size="lg" block onClick={place} loading={busy === 'order'} progress="Waiting for your wallet…" disabled={!!publicKey && (!valid || !bell || busy !== null)}>
          {publicKey ? `Place ${side} order` : 'Connect wallet'}
        </Button>
        <Button variant="secondary" block onClick={faucet} loading={busy === 'faucet'} disabled={busy !== null}>
          Get test USDC and fixture NVDAx
        </Button>
      </div>
    </section>
  );
}

function Book({ st, c, address, kind, bell, now }: {
  st: BellOrdersState; c: CrossAccount | null; address: string | null; kind: BellKind; bell: { day: number; ts: number } | undefined; now: number;
}) {
  const m = st.multiplier;
  const last = st.lastPrint ? priceOf(st.lastPrint.equity.price, st.lastPrint.equity.expo) : null;
  const buyers = c ? Number(c.buyTotal) / 1e6 : 0;
  const sellers = c ? displayed(c.sellTotal, m, 8) : 0;
  const sellersUsd = last !== null ? sellers * last : null;
  const phaseIdx = !c ? 0 : { collecting: now < c.bellTs - st.manifest.params.freezeSecs ? 0 : 1, confirming: 2, auction: 3, settling: 4, cancelled: 4 }[c.phase];
  const steps = ['Orders', 'Frozen', 'Priced', 'Auction', 'Settled'];
  return (
    <section className={s.card} aria-labelledby="book-h">
      <h2 id="book-h" className={s.cardTitle}>The book for the {kind}{bell ? `, ${etDate(bell.ts)}` : ''}</h2>
      <ol className={s.steps} aria-label="Where this cross is">
        {steps.map((label, i) => (
          <li key={label} data-state={i < phaseIdx ? 'done' : i === phaseIdx ? 'now' : 'next'}>{label}</li>
        ))}
      </ol>
      {!c ? (
        <p className={s.empty}>No orders in this cross yet. The first order creates it.</p>
      ) : (
        <>
          <dl className={s.rows}>
            <div><dt>Buyers</dt><dd><span className="num">{usd(buyers)}</span><span className={s.sub}>{c.nOrders} order(s) in all</span></dd></div>
            <div><dt>Sellers</dt><dd><span className="num">{tok(sellers)} NVDAx</span><span className={s.sub}>{sellersUsd !== null ? `≈ ${usd(sellersUsd)} at the last print` : ''}</span></dd></div>
            {c.phase !== 'settling' && sellersUsd !== null && (buyers > 0 || sellers > 0) && (
              <div>
                <dt>So far</dt>
                <dd>
                  <span className="num">{buyers > sellersUsd ? `buyers by ≈ ${usd(buyers - sellersUsd)}` : sellersUsd > buyers ? `sellers by ≈ ${usd(sellersUsd - buyers)}` : 'balanced'}</span>
                  <span className={s.sub}>the larger side is filled by makers at the bell</span>
                </dd>
              </div>
            )}
          </dl>
          {c.phase === 'settling' && <Result st={st} c={c} />}
          {c.phase === 'cancelled' && <p className={s.warn}>This cross was cancelled and every order is refunded whole.</p>}
          {address && (c.phase === 'settling' || c.phase === 'cancelled') && <Link className={s.more} to={`/b/${address}`}>Read the receipt</Link>}
        </>
      )}
    </section>
  );
}

function Result({ st, c }: { st: BellOrdersState; c: CrossAccount }) {
  const cl = c.clearing;
  const perShare = priceOf(c.priceMantissa, c.priceExpo);
  const buyTokens = displayed(cl.buyTokens, c.multiplierWad || st.multiplier, 8);
  return (
    <div className={s.result}>
      <p className={s.resultHead}>
        Cleared at <strong className="num">{usd(perShare)}</strong> a share{c.simulated && <span className={s.simTag}>simulated print</span>}
      </p>
      <dl className={s.rows}>
        <div><dt>Crowded</dt><dd><span className="num">{cl.crowded === 'balanced' ? 'neither side' : cl.crowded}</span></dd></div>
        <div><dt>Imbalance fee</dt><dd><span className="num">{cl.crowded === 'balanced' ? 'none' : `${cl.feeBps} bp`}</span><span className={s.sub}>on the part makers filled</span></dd></div>
        <div><dt>To buyers</dt><dd><span className="num">{tok(buyTokens)} NVDAx</span><span className={s.sub}>for {usd(Number(cl.buySpent) / 1e6)}</span></dd></div>
        <div><dt>To sellers</dt><dd><span className="num">{usd(Number(cl.sellQuote) / 1e6)}</span><span className={s.sub}>for {tok(displayed(cl.sellSpent, c.multiplierWad || st.multiplier, 8))} NVDAx</span></dd></div>
      </dl>
    </div>
  );
}

const CHIP: Record<NoteState['state'], string> = {
  pending: 'placing', cancelled: 'cancelled', refunded: 'refunded', closed: 'settled', filled: 'filled', unfilled: 'not filled',
};

function Mine({ st, now, onChanged }: { st: BellOrdersState; now: number; onChanged: () => void }) {
  const { publicKey } = useWallet();
  const send = useSendTx();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const byCross = new Map(st.crosses.map((x) => [x.address.toBase58(), x.c]));
  const live = new Set(st.mine.map((x) => x.address.toBase58()));
  const past = readNotes(publicKey ?? null)
    .filter((n) => !live.has(n.order))
    .map((n) => ({ n, is: noteState(n, byCross.get(n.cross), now * 1000) }));
  // An order gone while its cross is still open was cancelled, perhaps in
  // another browser. Written down now, because once the cross clears nothing
  // on chain tells a cancelled order from a filled one.
  const seenCancelled = past.filter((p) => p.is.state === 'cancelled' && !p.n.cancelledAt).map((p) => p.n.order).join(',');
  useEffect(() => {
    if (publicKey && seenCancelled) for (const o of seenCancelled.split(',')) markCancelled(publicKey, o);
  }, [publicKey, seenCancelled]);
  if (!publicKey) return null;
  const m = st.multiplier;
  const amountText = (side: 'buy' | 'sell', amount: bigint) => (side === 'buy' ? usd(Number(amount) / 1e6) : `${tok(displayed(amount, m, 8))} NVDAx`);

  const cancel = async (order: string) => {
    const x = st.mine.find((y) => y.address.toBase58() === order);
    const c = x && byCross.get(x.o.cross.toBase58());
    if (!x || !c) return;
    setBusy(order);
    try {
      const r = await send([cancelOrderIx(st.ref, { owner: publicKey, day: c.day, kind: c.kind, nonce: x.o.nonce, side: x.o.side })]);
      if (r.ok) markCancelled(publicKey, order);
      toast(r.ok ? { tone: 'ok', title: 'Order cancelled; the escrow is back', href: explorer(r.signature), hrefLabel: 'View transaction' } : { tone: 'error', title: 'Not cancelled', detail: r.error });
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  const outcome = (side: 'buy' | 'sell', is: NoteState): string => {
    switch (is.state) {
      case 'pending': return 'placed; waiting for the chain to show it';
      case 'cancelled': return 'cancelled; the escrow came back whole';
      case 'refunded': return 'the cross was cancelled: refunded whole';
      case 'closed': return 'settled; its cross has since closed';
      case 'unfilled': return 'the print broke your limit: refunded whole';
      case 'filled': return side === 'buy'
        ? `got ${tok(displayed(is.got, m, 8))} NVDAx for ${usd(Number(is.spent) / 1e6)}`
        : `got ${usd(Number(is.got) / 1e6)} for ${tok(displayed(is.spent, m, 8))} NVDAx`;
    }
  };

  if (st.mine.length === 0 && past.length === 0) {
    return (
      <section className={`${s.card} ${s.wide}`} aria-labelledby="mine-h">
        <h2 id="mine-h" className={s.cardTitle}>Your orders</h2>
        <p className={s.empty}>None yet.</p>
      </section>
    );
  }
  return (
    <section className={`${s.card} ${s.wide}`} aria-labelledby="mine-h">
      <h2 id="mine-h" className={s.cardTitle}>Your orders</h2>
      <ul className={s.orders}>
        {st.mine.map(({ address, o }) => {
          const c = byCross.get(o.cross.toBase58());
          const open = c?.phase === 'collecting' && now < c.bellTs - st.manifest.params.freezeSecs;
          // a cross missing from this read is one created a moment ago, so still open
          const chip = o.status !== 'open' ? o.status : !c || open ? 'open' : 'frozen';
          return (
            <li key={address.toBase58()} className={s.order}>
              <span className={s.orderMain}>
                <strong>{o.side === 'buy' ? 'Buy' : 'Sell'} {amountText(o.side, o.amount)}</strong>
                {c && <span className={s.sub}>at the {c.kind} of {etDate(c.bellTs)}{o.limitE8 > 0n ? `, only if NVDA ${o.side === 'buy' ? '≤' : '≥'} ${usd(Number(o.limitE8) / 1e8)}` : ''}</span>}
              </span>
              <span className={s.chip}>{chip}</span>
              {open && <Button variant="tertiary" size="sm" onClick={() => cancel(address.toBase58())} loading={busy === address.toBase58()}>Cancel</Button>}
              <a className={s.addr} href={explorerAddr(address.toBase58())} target="_blank" rel="noreferrer">{short(address.toBase58(), 4)} <Icon name="external" size={11} /></a>
            </li>
          );
        })}
        {past.slice(0, 10).map(({ n, is }) => (
          <li key={n.order} className={s.order}>
            <span className={s.orderMain}>
              <strong>{n.side === 'buy' ? 'Buy' : 'Sell'} {amountText(n.side, BigInt(n.amount))}</strong>
              <span className={s.sub}>at the {n.kind} of {etDate(n.bellTs)}: {outcome(n.side, is)}</span>
            </span>
            <span className={s.chip} data-status={is.state}>{CHIP[is.state]}</span>
            {is.state === 'filled' || is.state === 'unfilled' || is.state === 'refunded'
              ? <Link className={s.addr} to={`/b/${n.cross}`}>receipt</Link>
              : <a className={s.addr} href={explorer(n.signature)} target="_blank" rel="noreferrer">placed <Icon name="external" size={11} /></a>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function Bells() {
  const { publicKey } = useWallet();
  const { data, error, refresh } = useBellOrders(publicKey ?? null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const freeze = data?.manifest.params.freezeSecs ?? 120;
  const bells = nextBells(now, freeze);
  const [shown, setShown] = useState<BellKind | null>(null);
  const kind: BellKind = shown ?? (bells.open && bells.close && bells.open.ts < bells.close.ts ? 'open' : 'close');
  const bell = bells[kind];
  const found = data && bell ? data.crosses.find((x) => x.c.day === bell.day && x.c.kind === kind) ?? null : null;
  const cross = found?.c ?? null;
  const recent = data ? [...data.crosses].filter((x) => x.c.phase === 'settling' || x.c.phase === 'cancelled').reverse() : [];

  return (
    <div className={s.page}>
      <header className={s.head}>
        <span className={s.eyebrow}>Bell orders</span>
        <h1 className={s.title}>Trade NVDAx at the bell, at the price the bell printed</h1>
        <p className={s.lead}>
          Place an order any time. At the NYSE open or close it fills at <strong>the bell&rsquo;s print</strong>, the
          same price for everyone in it. Buyers and sellers net against each other and pay nothing for it. If one
          side is larger, market makers fill the difference in a two-minute auction, and their fee is shared across
          that side, capped by a standing backstop. The book freezes two minutes before the bell, so nobody can
          react to a price they can see coming.
        </p>
        <div className={s.badges}>
          <Status kind="devnet" />
          <Status kind="simulated" label="Fixture NVDAx · simulated prints" />
          {data && <Source kind="chain" detail={`session-cross ${short(data.manifest.program, 4)} on ${data.manifest.cluster}`} ageSec={(Date.now() - data.readAt) / 1000} staleAfter={90} />}
        </div>
      </header>

      {data === undefined ? (
        <div className="skeleton" style={{ height: 320, borderRadius: 16 }} aria-busy="true" />
      ) : data === null ? (
        <p className={s.empty}>No bell-order market is deployed for this site yet.</p>
      ) : (
        <>
          {error && <p className={s.warn} role="status">The last read failed ({error}); showing the one from {Math.round((Date.now() - data.readAt) / 1000)}s ago.</p>}
          <div className={s.body}>
            <Ticket st={data} now={now} onPlaced={refresh} />
            <div className={s.column}>
              <Segmented
                label="Which book"
                value={kind}
                onChange={(v) => setShown(v)}
                items={(['open', 'close'] as const).filter((k) => bells[k]).map((k) => ({ value: k, label: k === 'open' ? 'Next open' : 'Next close' }))}
              />
              <Book st={data} c={cross} address={found?.address.toBase58() ?? null} kind={kind} bell={bell} now={now} />
            </div>
            <Mine st={data} now={now} onChanged={refresh} />
            <section className={`${s.card} ${s.wide}`} aria-labelledby="recent-h">
              <h2 id="recent-h" className={s.cardTitle}>Recent bells</h2>
              {recent.length === 0 ? (
                <p className={s.empty}>No cross has cleared yet. The first clears at the next bell with orders in it.</p>
              ) : (
                <ul className={s.recent}>
                  {recent.map(({ address, c }) => (
                    <li key={address.toBase58()}>
                      <Link className={`num ${s.receiptLink}`} to={`/b/${address.toBase58()}`}>{c.kind === 'open' ? 'Open' : 'Close'} · {etDate(c.bellTs)}</Link>
                      {c.phase === 'cancelled' ? (
                        <span className={s.sub}>cancelled, refunded whole</span>
                      ) : (
                        <span className={s.sub}>
                          {usd(priceOf(c.priceMantissa, c.priceExpo))} a share · {c.clearing.crowded === 'balanced' ? 'balanced' : `${c.clearing.crowded} crowded, ${c.clearing.feeBps} bp`} · {c.nOrders} order(s)
                        </span>
                      )}
                      <a className={s.addr} href={explorerAddr(address.toBase58())} target="_blank" rel="noreferrer">{short(address.toBase58(), 4)} <Icon name="external" size={11} /></a>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className={`${s.card} ${s.wide}`} aria-labelledby="how-h">
              <h2 id="how-h" className={s.cardTitle}>How a bell order fills</h2>
              <ol className={s.how}>
                <li><strong>Until two minutes before the bell</strong>, orders go into escrow and can be cancelled.</li>
                <li><strong>At the bell</strong>, the oracle keeps Pyth&rsquo;s print (<Link to="/oracle">/oracle</Link>). One raw NVDAx is worth the share price times the mint&rsquo;s own multiplier ({(Number((data.multiplier * 1_000_000n) / WAD) / 1e6).toFixed(6)}).</li>
                <li><strong>Buyers and sellers net</strong> at that price. The larger side&rsquo;s remainder goes to a two-minute auction for makers, at a single clearing fee.</li>
                <li><strong>Anyone may settle</strong>: tokens and change go back to each wallet. A missing print cancels the cross and refunds everyone whole.</li>
              </ol>
              <p className={s.foot}>
                The arithmetic, its proofs and the program: <a href={`${REPO}/docs/CROSS.md`} target="_blank" rel="noreferrer">docs/CROSS.md</a>.
                Every balance the program has moved in testing matched it to the atom, over 300 random crosses on the real NVDAx mint.
              </p>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

