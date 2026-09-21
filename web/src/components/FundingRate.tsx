/* What a night costs, right now.
 *
 * This is the number the protocol exists to produce and it appeared nowhere.
 * Every perp venue puts its funding rate on the screen because it is the
 * price of holding the position; here it is the price of holding a session,
 * and it is the first time that price has been quotable at all — a brokerage
 * cannot tell you what the overnight is worth, because it never sells it
 * separately.
 *
 * It is computed from the same `fundingTransfer` the program runs, over the
 * class values read from the chain, so the figure on screen is the figure the
 * next bell will charge. When the two classes are the same size it is zero,
 * and that is worth showing too: nobody is crowded, so nobody pays.
 */
import { fundingTransfer } from '@sdk/settle.ts';
import { SESSION_EVENT } from '@sdk/vault.ts';
import type { ChainVault as ChainState } from '@/lib/chain';
import s from './FundingRate.module.css';


export function FundingRate({ d, compact = false }: { d: ChainState; compact?: boolean }) {
  const v = d.vault;
  const qd = v.quoteDecimals;
  const isEvent = v.sessionKind === SESSION_EVENT;
  const [crowded, sparse] = isEvent ? ['THEN', 'NOW'] : ['NIGHT', 'DAY'];

  // What the next bell would move, at the sizes the classes are now.
  const transfer = fundingTransfer(d.valueNight, d.valueDay, {
    kBps: BigInt(v.fundingKBps),
    maxBps: BigInt(v.fundingMaxBps),
  });
  const base = d.valueNight < d.valueDay ? d.valueNight : d.valueDay;
  const rateBps = base > 0n ? Number((transfer < 0n ? -transfer : transfer) * 10_000n / base) : 0;
  const payer = transfer > 0n ? crowded : sparse;
  const payee = transfer > 0n ? sparse : crowded;
  const skewPct = Number(d.skew) / 1e18 * 100;

  // Two bells a weekday, so a per-boundary rate annualises over ~504 of them.
  const monthly = rateBps * 2 * 22;
  const capped = rateBps >= v.fundingMaxBps;
  const amount = Number(transfer < 0n ? -transfer : transfer) / 10 ** qd;

  if (transfer === 0n) {
    // Three different reasons for zero, and they are not interchangeable.
    // The transfer is sized on the *smaller* side, so an empty class means
    // nothing to charge — which looks identical to a balanced book on a
    // number alone, while the skew beside it reads 100%. Saying "nothing
    // minted yet" when one side holds real value is simply false.
    const empty = d.valueNight === 0n || d.valueDay === 0n;
    const both = d.valueNight === 0n && d.valueDay === 0n;
    const full = d.valueNight === 0n ? sparse : crowded;
    return (
      <div className={`${s.wrap} ${compact ? s.compact : ''}`} data-flat="true">
        <span className={s.label}>Funding, next bell</span>
        <span className={`num ${s.value}`}>0.00<span className={s.unit}>%</span></span>
        <span className={s.note}>
          {both
            ? 'Nothing minted yet, so there is nothing to charge.'
            : empty
              ? <>Only <strong>{full}</strong> has holders. Funding moves between the two classes and is sized on the smaller one, so an empty side means there is nobody to pay and nobody to pay them — however lopsided the book looks. It starts the moment the other class has a holder.</>
              : 'The two classes are the same size. Nobody is crowded, so nobody pays.'}
        </span>
      </div>
    );
  }

  return (
    <div className={`${s.wrap} ${compact ? s.compact : ''}`} data-side={payer.toLowerCase()}>
      <span className={s.label}>Funding, next bell</span>
      <span className={`num ${s.value}`}>
        {(rateBps / 100).toFixed(2)}<span className={s.unit}>%</span>
      </span>
      <span className={s.flow}>
        <strong>{payer}</strong> pays <strong>{payee}</strong>
        <span className={s.amount}> · {amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} quote</span>
      </span>
      {!compact && (
        <span className={s.note}>
          {capped
            ? <>At the cap. The crowded side is {Math.abs(skewPct).toFixed(0)}% larger, and the rate stops rising here — about {(monthly / 100).toFixed(0)}% a month if it stayed, which is the strongest pull in the system and the reason the cap exists.</>
            : <>The crowded side is {Math.abs(skewPct).toFixed(0)}% larger. The rate scales with that gap and stops at {(v.fundingMaxBps / 100).toFixed(2)}% per bell.</>}
        </span>
      )}
    </div>
  );
}
