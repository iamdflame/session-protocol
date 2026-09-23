/* What a night costs, right now.
 *
 * This is the number the protocol exists to produce. Every perp venue puts its
 * funding rate on the screen because it is the price of holding the position;
 * here it is the price of holding a session, and it is the first time that
 * price has been quotable at all — a brokerage cannot tell you what the
 * overnight is worth, because it never sells it separately.
 *
 * It is computed from the same `fundingTransfer` the program runs, over the
 * class values of whichever vault is on screen — read from the chain, or from
 * the simulation in this browser — so the figure is the figure the next bell
 * will charge. When the two classes are the same size it is zero, and that is
 * worth showing too: nobody is crowded, so nobody pays.
 */
import { fundingTransfer, DEFAULT_FUNDING } from '@sdk/settle.ts';
import { SESSION_EVENT } from '@sdk/vault.ts';
import type { ChainVault as ChainState } from '@/lib/chain';
import { Icon } from './ui/Icon';
import s from './FundingRate.module.css';

/** Everything the rate depends on, whichever vault it comes from. */
export interface FundingInput {
  valueNight: bigint;
  valueDay: bigint;
  skew: bigint;
  kBps: number;
  maxBps: number;
  decimals: number;
  isEvent: boolean;
}

export const fundingFromChain = (d: ChainState): FundingInput => ({
  valueNight: d.valueNight,
  valueDay: d.valueDay,
  skew: d.skew,
  kBps: d.vault.fundingKBps,
  maxBps: d.vault.fundingMaxBps,
  decimals: d.vault.quoteDecimals,
  isEvent: d.vault.sessionKind === SESSION_EVENT,
});

/** The simulation settles with the SDK's defaults, so its rate uses them too. */
export const fundingFromLocal = (valueNight: bigint, valueDay: bigint, skew: bigint, decimals: number): FundingInput => ({
  valueNight, valueDay, skew,
  kBps: Number(DEFAULT_FUNDING.kBps),
  maxBps: Number(DEFAULT_FUNDING.maxBps),
  decimals,
  isEvent: false,
});

export function FundingRate({ f, compact = false }: { f: FundingInput; compact?: boolean }) {
  const [crowded, sparse] = f.isEvent ? ['THEN', 'NOW'] : ['NIGHT', 'DAY'];

  // What the next bell would move, at the sizes the classes are now.
  const transfer = fundingTransfer(f.valueNight, f.valueDay, { kBps: BigInt(f.kBps), maxBps: BigInt(f.maxBps) });
  const base = f.valueNight < f.valueDay ? f.valueNight : f.valueDay;
  const rateBps = base > 0n ? Number((transfer < 0n ? -transfer : transfer) * 10_000n / base) : 0;
  const payer = transfer > 0n ? crowded : sparse;
  const payee = transfer > 0n ? sparse : crowded;
  const skewPct = Number(f.skew) / 1e18 * 100;

  // Two bells a weekday, about 44 a month.
  const monthly = rateBps * 2 * 22;
  const capped = rateBps >= f.maxBps;
  const amount = Number(transfer < 0n ? -transfer : transfer) / 10 ** f.decimals;
  const tone = (w: string) => (w === 'NIGHT' || w === 'THEN' ? 'night' : 'day');

  if (transfer === 0n) {
    // Three different reasons for zero, and they are not interchangeable.
    // The transfer is sized on the *smaller* side, so an empty class means
    // nothing to charge — which looks identical to a balanced book on a
    // number alone, while the skew beside it reads 100%. Saying "nothing
    // minted yet" when one side holds real value is simply false.
    const empty = f.valueNight === 0n || f.valueDay === 0n;
    const both = f.valueNight === 0n && f.valueDay === 0n;
    const full = f.valueNight === 0n ? sparse : crowded;
    return (
      <div className={s.wrap} data-flat="true" data-compact={compact || undefined}>
        <span className={s.label}>Funding · next bell</span>
        <span className={`num ${s.value}`}>0.00<span className={s.unit}>%</span></span>
        <span className={s.note}>
          {both
            ? 'Nothing minted yet, so there is nothing to charge.'
            : empty
              ? <>Only <strong>{full}</strong> has holders. Funding moves between the classes and is sized on the smaller one, so an empty side means nobody pays and nobody is paid — however lopsided the book looks.</>
              : 'The two classes are the same size. Nobody is crowded, so nobody pays.'}
        </span>
      </div>
    );
  }

  return (
    <div className={s.wrap} data-side={tone(payer)} data-compact={compact || undefined}>
      <span className={s.label}>Funding · next bell</span>
      <span className={`num ${s.value}`}>{(rateBps / 100).toFixed(2)}<span className={s.unit}>%</span></span>
      <span className={s.flow}>
        <strong data-cls={tone(payer)}>{payer}</strong>
        <Icon name="chevronRight" size={12} aria-hidden="true" />
        <strong data-cls={tone(payee)}>{payee}</strong>
        <span className={`num ${s.amount}`}>{amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} quote</span>
      </span>
      {!compact && (
        <span className={s.note}>
          {capped
            ? <>At the {(f.maxBps / 100).toFixed(2)}% cap. The crowded side is {Math.abs(skewPct).toFixed(0)}% larger; about {(monthly / 100).toFixed(0)}% a month if it stayed, which is the strongest pull in the system and the reason the cap exists.</>
            : <>The crowded side is {Math.abs(skewPct).toFixed(0)}% larger. The rate scales with that gap and stops at {(f.maxBps / 100).toFixed(2)}% per bell.</>}
        </span>
      )}
    </div>
  );
}
