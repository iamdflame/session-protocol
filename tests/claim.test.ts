/* The wrapper grade, and the refusals that follow from it.
 *
 * `curated` decides where a vault appears and nothing else — an uncurated vault
 * settles identically and the curator key cannot stop it. That is exactly why
 * the floor has to be mechanical: an editorial decision dressed as a safety
 * rating is worse than no rating, and the only defence is that every letter
 * comes from a power the chain already publishes.
 *
 * The two devnet underlyings are the fixtures, because they are the shapes the
 * real assets have: an xStock-like mint with a permanent delegate, and a
 * PreStock-like mint with a 1% transfer fee, a pause switch and a delegate.
 */
import { PublicKey } from '@solana/web3.js';
import { gradeOf, curatable, wrapperType, pauseConsequence, feeIsCovered } from '../sdk/src/claim.ts';
import { switchPath, isUpgrade } from '../sdk/src/switch.ts';
import type { IssuerState } from '../sdk/src/issuer.ts';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (!cond) { console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
  else console.log(`  ok   ${name}`);
};

const NOW = 1_790_000_000;
const KEY = new PublicKey('11111111111111111111111111111111');

/** A clean Token-2022 mint with nothing retained. */
const clean = (over: Partial<IssuerState> = {}): IssuerState => ({
  token2022: true, hookProgram: null, hookSlot: false,
  pausable: false, paused: false,
  transferFeeBps: 0, transferFeeMax: 0n,
  permanentDelegate: null, scaledUi: null,
  defaultFrozen: false, confidentialTransfer: false,
  metadata: null, decimals: 8, freezeAuthority: null, mintAuthority: null,
  ...over,
});

/* ── the grade comes from the powers, worst first ────────────────────────── */

console.log('\nwhat the letter is measuring');
{
  const c = gradeOf(clean(), NOW);
  check('a fixed-supply mint that kept nothing is an A', c.grade === 'A', c.grade);
  check('and has nothing blocking it', c.blocking.length === 0);
  check('and no reasons to list', c.reasons.length === 0);
}
{
  /* True of every legitimate wrapper, so it is the floor rather than a fault
     — and the reason an A is rare. It applies to Token-2022 and classic SPL
     alike; scoring it only for mints with no extensions would have made the
     same power a defect in one place and invisible in the other. */
  const live = clean({ mintAuthority: KEY });
  check('a live mint authority is a B, whatever the token program',
    gradeOf(live, NOW).grade === 'B' && gradeOf(clean({ token2022: false, mintAuthority: KEY }), NOW).grade === 'B');
  check('and never blocks', curatable(live, NOW).ok);
}
{
  const c = gradeOf(clean({ freezeAuthority: KEY }), NOW);
  check('a freeze authority alone is a B', c.grade === 'B', c.grade);
  check('it does not block curation — it stops a balance, it does not take one',
    curatable(clean({ freezeAuthority: KEY }), NOW).ok);
}
{
  const c = gradeOf(clean({ permanentDelegate: KEY }), NOW);
  check('a permanent delegate is a C', c.grade === 'C', c.grade);
  check('and says so in words', /move this vault’s inventory out/.test(c.reasons.join(' ')));
}
{
  const c = gradeOf(clean({ hookProgram: KEY, hookSlot: true }), NOW);
  check('a set transfer hook is an F', c.grade === 'F', c.grade);
  check('and blocks curation, because the program passes no extra accounts',
    !curatable(clean({ hookProgram: KEY, hookSlot: true }), NOW).ok);
}
{
  // An empty hook slot is not a broken mint. It is a mint whose issuer can
  // break it tomorrow without asking, which the grade should distinguish.
  const c = gradeOf(clean({ hookSlot: true }), NOW);
  check('an empty hook slot is a C, not an F', c.grade === 'C', c.grade);
  check('and does not block', curatable(clean({ hookSlot: true }), NOW).ok);
}
{
  check('paused now is an F', gradeOf(clean({ pausable: true, paused: true }), NOW).grade === 'F');
  check('and blocks', !curatable(clean({ pausable: true, paused: true }), NOW).ok);
  check('pausable but not paused is a C', gradeOf(clean({ pausable: true }), NOW).grade === 'C');
}
{
  const c = gradeOf(clean({ hookProgram: KEY, hookSlot: true, freezeAuthority: KEY }), NOW);
  check('the worst finding wins rather than averaging', c.grade === 'F', c.grade);
  check('and every finding is still listed', c.reasons.length >= 2, String(c.reasons.length));
}

/* ── the fee, which the program does handle ──────────────────────────────── */

console.log('\na fee is a disclosure, not a disqualification');
{
  const fee = clean({ transferFeeBps: 100, transferFeeMax: 10n ** 12n });
  const c = gradeOf(fee, NOW);
  check('1% on transfer is a D', c.grade === 'D', c.grade);
  check('the program’s arithmetic covers it', feeIsCovered(fee));
  check('so it does not block curation', curatable(fee, NOW).ok, c.blocking.join('; '));
  check('and the cost is stated', /1.00%/.test(c.reasons.join(' ')));
}

/* ── the multiplier, which it does not ───────────────────────────────────── */

console.log('\nthe multiplier the program records but does not apply');
{
  const one = clean({ scaledUi: { multiplier: 1, newMultiplier: 1, newMultiplierEffectiveTs: 0 } });
  const c = gradeOf(one, NOW);
  check('a multiplier of 1 is a B — the power exists, the value agrees', c.grade === 'B', c.grade);
  check('and does not block', curatable(one, NOW).ok);
  check('effective multiplier reads 1', c.multiplier.effective === 1);
}
{
  // The program values raw atoms. While the multiplier is 1 that is the same
  // answer; the moment a dividend lands it is not, and nothing fails loudly.
  const two = clean({ scaledUi: { multiplier: 1.07, newMultiplier: 1.07, newMultiplierEffectiveTs: 0 } });
  const c = gradeOf(two, NOW);
  check('a multiplier other than 1 is an F', c.grade === 'F', c.grade);
  check('and blocks curation, because the mispricing is silent',
    !curatable(two, NOW).ok);
  check('effective multiplier reads the live one', c.multiplier.effective === 1.07);
}
{
  // The adjacent field, not the stale one — the record-date lesson.
  const sched = clean({ scaledUi: { multiplier: 1, newMultiplier: 1.07, newMultiplierEffectiveTs: NOW + 3_600 } });
  const c = gradeOf(sched, NOW);
  check('a scheduled multiplier is not yet in force', c.multiplier.effective === 1, String(c.multiplier.effective));
  check('but it is named, with when it lands',
    c.multiplier.scheduled === 1.07 && c.multiplier.effectiveAt === NOW + 3_600);
  const after = gradeOf(sched, NOW + 3_601);
  check('and once it lands the grade follows it', after.grade === 'F' && after.multiplier.effective === 1.07);
}

/* ── the sentences a reader gets ─────────────────────────────────────────── */

console.log('\nwhat it says, not just what it scores');
{
  check('a non-pausable mint says settlement cannot be stranded that way',
    /cannot pause/.test(pauseConsequence(clean())));
  check('a pausable one says what stops',
    /minting, redemption and the handoff all stop/.test(pauseConsequence(clean({ pausable: true }))));
  check('a paused one is in the present tense',
    /are paused now/.test(pauseConsequence(clean({ pausable: true, paused: true }))));
}
{
  check('delegate + pause reads as a custodied entitlement',
    /custodied entitlement/.test(wrapperType(clean({ permanentDelegate: KEY, pausable: true }))));
  check('freeze alone reads as a tracker certificate',
    /tracker certificate/.test(wrapperType(clean({ freezeAuthority: KEY }))));
  check('a classic SPL mint says the backing is a promise made off chain',
    /promise made off chain/.test(wrapperType(clean({ token2022: false }))));
}

/* ── the shapes the real assets have ─────────────────────────────────────── */

console.log('\nthe two devnet underlyings, which are the real shapes');
{
  // NVDAx's shape: Token-2022, permanent delegate, no fee, no pause.
  const xstock = clean({ permanentDelegate: KEY, decimals: 8 });
  const c = gradeOf(xstock, NOW);
  check('an xStock-shaped mint grades C', c.grade === 'C', c.grade);
  check('and may be curated — the power is disclosed, not disqualifying',
    curatable(xstock, NOW).ok, c.blocking.join('; '));
}
{
  // OPENAI's shape: 1% fee, pausable, permanent delegate, ScaledUI at 1.
  const prestock = clean({
    transferFeeBps: 100, transferFeeMax: 10n ** 12n,
    pausable: true, permanentDelegate: KEY,
    scaledUi: { multiplier: 1, newMultiplier: 1, newMultiplierEffectiveTs: 0 },
  });
  const c = gradeOf(prestock, NOW);
  check('a PreStock-shaped mint grades D', c.grade === 'D', c.grade);
  check('and may still be curated', curatable(prestock, NOW).ok, c.blocking.join('; '));
  check('with all four powers named', c.reasons.length === 4, String(c.reasons.length));
  check('including the one that costs on every fill', /1.00%/.test(c.reasons.join(' ')));
}

/* ── switching into the better claim ─────────────────────────────────────── */

console.log('\nswitching, which is quote-only on purpose');
{
  const weak = gradeOf(clean({ permanentDelegate: KEY, pausable: true, transferFeeBps: 100, transferFeeMax: 1n }), NOW);
  const strong = gradeOf(clean({ freezeAuthority: KEY }), NOW);
  check('D → B is an upgrade', isUpgrade(weak.grade, strong.grade), `${weak.grade} → ${strong.grade}`);
  check('B → D is not', !isUpgrade(strong.grade, weak.grade));
  check('and neither is a sideways move — an equal grade is not worth a spread',
    !isUpgrade(strong.grade, strong.grade));
}
{
  const c = gradeOf(clean(), NOW);
  const same = await switchPath({ mint: 'X', claim: c }, { mint: 'X', claim: c }, 10n);
  check('the same mint is not a switch', same.status === 'same-mint', same.status);
  const none = await switchPath({ mint: 'X', claim: c }, { mint: 'Y', claim: c }, 0n);
  check('nothing to switch is refused rather than quoted', none.status === 'no-route');
}
{
  /* Devnet has no Jupiter liquidity for these mints, so "no route" is the
     normal answer and has to be a state rather than an error. */
  const c = gradeOf(clean(), NOW);
  const fetchImpl = (async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
  const r = await switchPath({ mint: 'X', claim: c }, { mint: 'Y', claim: c }, 10n, { fetchImpl });
  check('a router with no route says so, and does not throw', r.status === 'no-route', r.status);
}
{
  const weak = gradeOf(clean({ permanentDelegate: KEY, pausable: true, transferFeeBps: 100, transferFeeMax: 1n }), NOW);
  const strong = gradeOf(clean({ freezeAuthority: KEY }), NOW);
  const fetchImpl = (async () => ({
    ok: true,
    json: async () => ({ outAmount: '994000', priceImpactPct: '0.0031', routePlan: [{ swapInfo: { label: 'Meteora' } }] }),
  })) as unknown as typeof fetch;
  const up = await switchPath({ mint: 'X', claim: weak }, { mint: 'Y', claim: strong }, 1_000_000n, { fetchImpl });
  check('an upgrade is reported as better', up.status === 'better', up.status);
  check('with the route named, not just a number',
    up.status === 'better' && up.quote.route[0] === 'Meteora' && up.quote.outAmount === 994_000n);
  const down = await switchPath({ mint: 'X', claim: strong }, { mint: 'Y', claim: weak }, 1_000_000n, { fetchImpl });
  check('and a downgrade is quoted but not recommended', down.status === 'no-gain', down.status);
}

console.log(failed ? `\n${failed} failed` : '\nall claim checks passed');
process.exit(failed ? 1 : 0);
