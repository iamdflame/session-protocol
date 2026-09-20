/* ───────────────────────────────────────────────────────────────────────────
   Settlement math, mirrored from `programs/session/src/settle.rs`.

   A keeper needs to know what a boundary will do before it sends it, and any
   interface needs to project NAV without an RPC round trip. Both require the
   same arithmetic the chain runs — not an approximation of it.

   BigInt gives exact u128 semantics, so this is a true mirror rather than a
   floating-point sketch. `tests/vectors/settle.json` pins the two together, in
   the same way the calendar vectors do: if they ever disagree, a keeper would
   be quoting a number the chain will not produce.
   ─────────────────────────────────────────────────────────────────────────── */

export const WAD = 10n ** 18n;

export const mulDivFloor = (a: bigint, b: bigint, d: bigint): bigint => {
  if (d === 0n) throw new Error('division by zero');
  return (a * b) / d;
};

export const mulDivCeil = (a: bigint, b: bigint, d: bigint): bigint => {
  if (d === 0n) throw new Error('division by zero');
  const n = a * b;
  return n / d + (n % d === 0n ? 0n : 1n);
};

export type ShareClass = 'night' | 'day';
export const other = (c: ShareClass): ShareClass => (c === 'night' ? 'day' : 'night');

export interface FundingParams {
  kBps: bigint;
  maxBps: bigint;
}

export const DEFAULT_FUNDING: FundingParams = { kBps: 2_500n, maxBps: 50n };

/** Signed skew in WAD: +1.0 is all capital in NIGHT, −1.0 all in DAY. */
export function skewWad(valueNight: bigint, valueDay: bigint): bigint {
  const total = valueNight + valueDay;
  if (total === 0n) return 0n;
  const diff = valueNight - valueDay;
  const mag = diff < 0n ? -diff : diff;
  const s = mulDivFloor(mag, WAD, total);
  return diff < 0n ? -s : s;
}

/** Quote atoms moved at this boundary. Positive means NIGHT pays DAY. */
export function fundingTransfer(
  valueNight: bigint, valueDay: bigint, p: FundingParams = DEFAULT_FUNDING,
): bigint {
  if (p.kBps === 0n) return 0n;
  const skew = skewWad(valueNight, valueDay);
  if (skew === 0n) return 0n;

  const mag = skew < 0n ? -skew : skew;
  const rateMag = mulDivFloor(mag, p.kBps, 10_000n);
  const cap = mulDivFloor(WAD, p.maxBps, 10_000n);
  const rate = rateMag < cap ? rateMag : cap;

  const base = valueNight < valueDay ? valueNight : valueDay;
  const amount = mulDivFloor(base, rate, WAD);
  return skew > 0n ? amount : -amount;
}

export interface NavState {
  nightSupply: bigint;
  daySupply: bigint;
  nightNav: bigint;
  dayNav: bigint;
  exposed: ShareClass;
  lastMark: bigint;
}

export interface Settlement {
  nightNav: bigint;
  dayNav: bigint;
  exposed: ShareClass;
  funding: bigint;
  handoffDelta: bigint;
  valueNight: bigint;
  valueDay: bigint;
}

export const valueOf = (supply: bigint, nav: bigint): bigint => mulDivFloor(supply, nav, WAD);

/**
 * Settle a boundary at `newMark`.
 *
 * Mirrors the on-chain order exactly: roll the exposed class by the session's
 * price move, transfer funding, then flip exposure and size the handoff.
 *
 * Funding is applied straight to NAV rather than through the class's value.
 * Round-tripping NAV through value would quantise it to the value's resolution
 * and floor it, leaking from holders at every boundary — the chain does not do
 * that, so neither does this.
 */
export function settle(
  s: NavState, newMark: bigint, p: FundingParams = DEFAULT_FUNDING,
): Settlement {
  if (s.lastMark === 0n || newMark === 0n) throw new Error('zero mark');

  let nightNav = s.nightNav;
  let dayNav = s.dayNav;
  if (s.exposed === 'night') nightNav = mulDivFloor(nightNav, newMark, s.lastMark);
  else dayNav = mulDivFloor(dayNav, newMark, s.lastMark);

  const vn0 = valueOf(s.nightSupply, nightNav);
  const vd0 = valueOf(s.daySupply, dayNav);

  const funding = fundingTransfer(vn0, vd0, p);
  if (funding !== 0n) {
    const t = funding < 0n ? -funding : funding;
    const payerSupply = funding > 0n ? s.nightSupply : s.daySupply;
    const receiverSupply = funding > 0n ? s.daySupply : s.nightSupply;
    // round against both sides so dust can only settle in the vault
    const pay = payerSupply === 0n ? 0n : mulDivCeil(t, WAD, payerSupply);
    const recv = receiverSupply === 0n ? 0n : mulDivFloor(t, WAD, receiverSupply);
    if (funding > 0n) {
      nightNav = nightNav > pay ? nightNav - pay : 0n;
      dayNav += recv;
    } else {
      dayNav = dayNav > pay ? dayNav - pay : 0n;
      nightNav += recv;
    }
  }

  const valueNight = valueOf(s.nightSupply, nightNav);
  const valueDay = valueOf(s.daySupply, dayNav);

  const exposed = other(s.exposed);
  const need = exposed === 'night' ? valueNight : valueDay;
  const have = exposed === 'night' ? valueDay : valueNight;

  return {
    nightNav, dayNav, exposed, funding,
    handoffDelta: need - have,
    valueNight, valueDay,
  };
}
