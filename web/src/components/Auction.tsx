/* The call auction at the bell.
 *
 * The handoff leaves a residual — the difference in size between the two
 * classes — and it has to trade. Offered continuously, it goes to whoever
 * shows up first, at whatever their model says, in the minutes after a bell
 * when the mark is least settled. Offered at auction, every bid clears at one
 * price: the mark from the bell's own window, the same number the settlement
 * used.
 *
 * This panel only exists while there is something to auction. A vault whose
 * classes are the same size never shows it, which is the design working — the
 * handoff was a book entry and nothing needed to trade at all.
 */
import { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { award } from '@sdk/vault.ts';
import {
  explorer, short, useSendTx, buildAuctionBid, buildAuctionClaim,
  type ChainVault as ChainState, type Devnet,
} from '@/lib/chain';
import s from './Auction.module.css';

const fromAtoms = (v: bigint, d: number) => Number(v) / 10 ** d;
const fmt = (v: number, digits = 2) => v.toLocaleString('en-US', { maximumFractionDigits: digits });

function useCountdown(to: number) {
  const [left, setLeft] = useState(() => to - Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setLeft(to - Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [to]);
  return left;
}

export function Auction({ m, d, onDone }: { m: Devnet; d: ChainState; onDone: () => void }) {
  const a = d.auction;
  const { publicKey, connected } = useWallet();
  const send = useSendTx();
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ ok: boolean; text: string; sig?: string } | null>(null);
  const left = useCountdown(a?.state.closesAt ?? 0);

  if (!a) return null;

  const ud = d.vault.underlyingDecimals;
  const qd = d.vault.quoteDecimals;
  const { state } = a;
  const open = !state.closed && left > 0;
  const overdue = !state.closed && left <= 0;
  const wanted = fromAtoms(state.wantedUnderlying, ud);
  const bid = fromAtoms(state.bidUnderlying, ud);
  const coverage = wanted > 0 ? Math.min(1, bid / wanted) : 0;

  const amount = Number(raw);
  const canBid = open && connected && Number.isFinite(amount) && amount > 0 && !busy;

  const act = async (kind: 'bid' | 'claim') => {
    if (!publicKey) return;
    setBusy(true); setFlash(null);
    const ixs = kind === 'bid'
      ? buildAuctionBid(m, d, publicKey, BigInt(Math.round(amount * 10 ** ud)))
      : buildAuctionClaim(m, d, publicKey);
    const r = await send(ixs);
    setBusy(false);
    setFlash(r.ok
      ? { ok: true, text: kind === 'bid' ? 'Bid escrowed' : 'Claimed', sig: r.signature }
      : { ok: false, text: r.error });
    if (r.ok) { setRaw(''); onDone(); }
  };

  const mine = a.mine
    ? award(state, a.mine.underlying, a.mine.escrowed)
    : null;

  return (
    <section className={`card ${s.card}`} aria-label="Bell auction" data-open={open}>
      <header className={s.head}>
        <div>
          <h2 className={s.title}>The residual is at auction</h2>
          <p className={s.sub}>
            {state.vaultBuys ? 'The vault is short stock and buys it.' : 'The vault is long stock it no longer needs.'}{' '}
            Every bid clears at one price — the mark from this bell&rsquo;s own window, the same
            number the settlement used.
          </p>
        </div>
        <span className={s.state} data-phase={state.closed ? 'cleared' : open ? 'open' : 'due'}>
          {state.closed ? 'cleared' : open ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left` : 'ready to clear'}
        </span>
      </header>

      <div className={s.book}>
        <div className={s.bookRow}>
          <span className={s.label}>Wanted</span>
          <span className={`num ${s.big}`}>{fmt(wanted, 4)}</span>
        </div>
        <div className={s.bookRow}>
          <span className={s.label}>Bid</span>
          <span className={`num ${s.big}`} data-over={bid > wanted}>{fmt(bid, 4)}</span>
        </div>
        <div className={s.bookRow}>
          <span className={s.label}>Bidders</span>
          <span className={`num ${s.big}`}>{state.bids}</span>
        </div>
      </div>

      <div className={s.gauge} role="img" aria-label={`${(coverage * 100).toFixed(0)} percent of the residual is bid for`}>
        <div className={s.gaugeFill} style={{ width: `${coverage * 100}%` }} data-full={bid >= wanted} />
      </div>
      <p className={s.coverage}>
        {bid === 0
          ? 'Nothing bid yet. Whatever the auction does not take goes back to the continuous path, where the incentive keeps rising.'
          : bid >= wanted
            ? `Oversubscribed — every bid fills pro rata at the same price, and the rest of each escrow comes back.`
            : `${(coverage * 100).toFixed(0)}% covered. Bids fill whole; the remainder stays for the continuous path.`}
      </p>

      {state.closed && (
        <p className={s.cleared}>
          Cleared at <span className="num">{(Number(state.clearingMark) / 1e18).toFixed(6)}</span>{' '}
          {state.fillRatio >= 10n ** 18n
            ? '— every bid filled whole.'
            : `— each bid filled ${((Number(state.fillRatio) / 1e18) * 100).toFixed(2)}% pro rata.`}
        </p>
      )}

      {/* ── this wallet's position ──────────────────────────────────────── */}
      {a.mine && (
        <div className={s.mine}>
          <span className={s.label}>Your bid</span>
          <span className="num">{fmt(fromAtoms(a.mine.underlying, ud), 4)}</span>
          {mine && state.closed && (
            <span className={s.mineAward}>
              takes {fmt(fromAtoms(mine.underlying, ud), 4)} for{' '}
              {fmt(fromAtoms(mine.quote, qd), 2)} quote
              {mine.refund > 0n && <>, {fmt(fromAtoms(mine.refund, state.vaultBuys ? ud : qd), 4)} returned</>}
            </span>
          )}
        </div>
      )}

      {/* ── act ─────────────────────────────────────────────────────────── */}
      {open && (
        <form className={s.form} onSubmit={e => { e.preventDefault(); act('bid'); }}>
          <label className={s.field}>
            <span className="sr-only">Amount of underlying to bid</span>
            <input
              inputMode="decimal" value={raw} disabled={!connected || busy}
              onChange={e => setRaw(e.target.value.replace(/[^\d.]/g, ''))}
              placeholder={connected ? fmt(wanted, 4) : 'connect a wallet to bid'}
              className={s.input}
            />
            <button type="button" className={s.max} disabled={!connected || busy} onClick={() => setRaw(String(wanted))}>
              all of it
            </button>
          </label>
          <button type="submit" className={s.submit} disabled={!canBid}>
            {busy ? 'Confirm in your wallet…' : 'Bid'}
          </button>
          <p className={s.escrowNote}>
            Escrowed until the auction clears, then either filled at the clearing price or
            returned whole. It never counts as the vault&rsquo;s backing while it sits there.
          </p>
        </form>
      )}

      {state.closed && a.mine && (
        <button type="button" className={s.submit} disabled={busy} onClick={() => act('claim')}>
          {busy ? 'Confirm in your wallet…' : 'Claim'}
        </button>
      )}

      {overdue && (
        <p className={s.note}>
          The window has passed and the price has not been fixed yet. Closing is
          permissionless — the next crank does it, and the price is not a choice.
        </p>
      )}

      {flash && (
        <p className={flash.ok ? s.ok : s.err} role="status">
          {flash.text}
          {flash.sig && <> · <a className={s.sig} href={explorer(flash.sig)} target="_blank" rel="noreferrer">view transaction ↗</a></>}
        </p>
      )}

      <footer className={s.foot}>
        <a className={s.sig} href={explorer(a.address.toBase58())} target="_blank" rel="noreferrer">
          {short(a.address.toBase58(), 4)} ↗
        </a>
        {' · '}a fill outside the auction pays <span className="num">{d.incentiveBps}</span> bp right now
        {' · '}measured round-trip cost is <span className="num">21</span> bp at $10k
      </footer>
    </section>
  );
}
