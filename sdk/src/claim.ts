/* ───────────────────────────────────────────────────────────────────────────
   What the claim actually is, graded from the chain.

   A vault holds a wrapper, never the stock. The wrapper's issuer keeps powers
   over it that no amount of correct settlement can take away: it can usually
   freeze the vault's own token account, often pause every transfer, sometimes
   move the inventory out with a permanent delegate, and — if a transfer hook
   is ever attached — stop the vault from moving the asset at all, because the
   program passes no extra accounts and cannot.

   The program already reacts to all of this: `programs/session/src/issuer.rs`
   reads the same extensions and halts with a named condition rather than
   marking inventory it no longer controls. What did not exist anywhere was a
   way to say, before a vault is shown to anyone, *how bad the wrapper is*.

   This is that. It is pure — no network, no accounts, no clock beyond the one
   passed in — so it can be unit-tested against fixtures and run identically in
   the browser, in the curator CLI, and in whatever lists vaults next.

   A grade is not a safety rating and is not advice. It is a summary of powers
   that are already public, in one letter, so that "curated" can mean something
   a reader can check rather than an opinion somebody held once.
   ─────────────────────────────────────────────────────────────────────────── */

import type { IssuerState } from './issuer.ts';

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface Claim {
  grade: Grade;
  /** Every power that moved the grade, worst first. */
  reasons: string[];
  /** Why this may not be curated. Empty means it may. */
  blocking: string[];
  /** The wrapper this vault holds, in words a reader can act on. */
  wrapper: string;
  /** One sentence: what happens to this vault if the issuer pauses. */
  pause: string;
  /** The multiplier in force, and whether a different one is scheduled. */
  multiplier: { effective: number; scheduled: number | null; effectiveAt: number | null };
}

/* Grades are ordered so the worst finding wins; nothing averages. */
const RANK: Record<Grade, number> = { A: 0, B: 1, C: 2, D: 3, F: 4 };
const worst = (a: Grade, b: Grade): Grade => (RANK[b] > RANK[a] ? b : a);

/**
 * Whether the program's own arithmetic survives this mint's transfer fee.
 *
 * A fee on transfer means the vault receives less than it was sent, and a
 * solvency check that assumed otherwise would drift below its claims a little
 * at a time. The program handles it — `tests/ix.test.ts` pins the fee maths
 * against the real OPENAI mint (1e9 → 1e7, 1 → 1, 12345 → 124) — so a fee is a
 * disclosure rather than a disqualification. What it cannot survive is a fee
 * it cannot see coming: a `newerTransferFee` scheduled for a future epoch
 * changes the rate under a vault that has already quoted a mint.
 */
export function feeIsCovered(s: IssuerState): boolean {
  return s.transferFeeBps <= 10_000;
}

/**
 * Grade a wrapper from its mint alone.
 *
 * Order matters and is the order Layer 0 lists: the things that stop the vault
 * working at all, then the things that let the issuer take from it, then the
 * things that merely cost or confuse.
 */
export function gradeOf(s: IssuerState, now: number): Claim {
  const reasons: string[] = [];
  const blocking: string[] = [];
  let grade: Grade = 'A';
  const down = (g: Grade, why: string) => { grade = worst(grade, g); reasons.push(why); };

  /* ── the vault cannot hold it at all ──────────────────────────────────── */

  if (s.hookProgram) {
    down('F', `a transfer hook is set (${s.hookProgram.toBase58()}); this program passes no extra accounts, so the vault cannot move this asset`);
    blocking.push('a transfer hook is set');
  } else if (s.hookSlot) {
    // The slot exists and is empty. Nothing is broken today and the issuer can
    // break it tomorrow without asking, which is a different thing from a mint
    // that never had the extension.
    down('C', 'the issuer can attach a transfer hook at any time, which would stop this vault from moving the asset');
  }

  if (s.paused) {
    down('F', 'transfers are paused by the issuer right now; nothing can enter or leave the vault');
    blocking.push('the mint is paused');
  } else if (s.pausable) {
    down('C', 'the issuer can pause every transfer, which would strand settlement until it is lifted');
  }

  /* ── the issuer can take from it ──────────────────────────────────────── */

  if (s.permanentDelegate) {
    down('C', 'a permanent delegate can move this vault’s inventory out at any time, without the vault’s consent');
  }
  if (s.freezeAuthority) {
    down('B', 'the issuer can freeze this vault’s own token account');
  }
  if (s.defaultFrozen) {
    down('C', 'new token accounts start frozen, so a holder may be unable to receive shares until the issuer thaws them');
  }

  /* ── it costs, or it misreads ─────────────────────────────────────────── */

  if (s.transferFeeBps > 0) {
    const pct = (s.transferFeeBps / 100).toFixed(2);
    if (feeIsCovered(s)) {
      down('D', `every transfer pays ${pct}% to the issuer; the program’s maths accounts for it, and it is still a cost on every mint, redeem and fill`);
    } else {
      down('F', `a transfer fee of ${pct}% is outside what the program’s arithmetic covers`);
      blocking.push('the transfer fee is outside the program’s arithmetic');
    }
  }
  if (s.confidentialTransfer) {
    down('D', 'confidential transfers are enabled; balances this vault does not hold may be unobservable to anyone valuing it');
  }
  if (s.scaledUi) {
    const eff = s.scaledUi.newMultiplierEffectiveTs <= now
      ? s.scaledUi.newMultiplier : s.scaledUi.multiplier;
    if (eff !== 1) {
      /* The program records that the extension exists and values raw atoms.
         While the multiplier is 1 that is the same answer; the moment an
         issuer applies a dividend or a split it is not, and nothing on chain
         would notice. Blocking rather than merely noting it, because the
         failure is silent and shows up as a solvency drift. */
      down('F', `balances carry a ×${eff} UI multiplier and this program values raw atoms, so a dividend or split would be mispriced without anything failing`);
      blocking.push('a UI multiplier other than 1 is in force and the program does not apply it');
    } else {
      down('B', 'the issuer can rescale every balance by changing the UI multiplier, which is how dividends and splits arrive');
    }
  }
  if (s.mintAuthority) {
    /* True of every legitimate wrapper — an issuer mints as people deposit —
       so this is the floor rather than a fault, and it is why an A means a
       fixed-supply mint that retained nothing at all. Applied to Token-2022
       and classic SPL alike: the rule was once limited to classic mints,
       which quietly made "supply can grow" a defect only for the mints that
       had no extensions to judge instead. */
    down('B', 'the mint authority is live, so supply can grow');
  }

  return {
    grade,
    reasons,
    blocking,
    wrapper: wrapperType(s),
    pause: pauseConsequence(s),
    multiplier: {
      effective: s.scaledUi
        ? (s.scaledUi.newMultiplierEffectiveTs <= now ? s.scaledUi.newMultiplier : s.scaledUi.multiplier)
        : 1,
      scheduled: s.scaledUi && s.scaledUi.newMultiplierEffectiveTs > now ? s.scaledUi.newMultiplier : null,
      effectiveAt: s.scaledUi && s.scaledUi.newMultiplierEffectiveTs > now ? s.scaledUi.newMultiplierEffectiveTs : null,
    },
  };
}

/**
 * What kind of claim this is, in words.
 *
 * Read from what the issuer kept rather than from a label: the powers a
 * wrapper's issuer retains are what distinguish a tracker certificate from a
 * custodied entitlement, whatever either is called in a prospectus. Deliberately
 * hedged — this is an inference from extensions, not a legal characterisation,
 * and it says so.
 */
export function wrapperType(s: IssuerState): string {
  if (!s.token2022) {
    return 'a plain SPL token: whatever backs it is a promise made off chain, with nothing on chain to enforce or reveal it';
  }
  if (s.permanentDelegate && s.pausable) {
    return 'a custodied entitlement: the issuer holds the asset, can pause the market in it and can move your wrapper itself';
  }
  if (s.permanentDelegate) {
    return 'a custodied entitlement: the issuer holds the asset and retains the power to move the wrapper without you';
  }
  if (s.freezeAuthority || s.pausable) {
    return 'a tracker certificate: the issuer does not move your balance, but can stop it moving';
  }
  return 'a tracker certificate with no retained control over an individual balance';
}

/** The one sentence Layer 0 asks for, on the vault page. */
export function pauseConsequence(s: IssuerState): string {
  if (!s.pausable) {
    return 'This issuer cannot pause transfers, so settlement cannot be stranded that way.';
  }
  if (s.paused) {
    return 'Transfers are paused now: nothing can be minted, redeemed or filled, and the vault halts rather than marking inventory it cannot move.';
  }
  return 'If the issuer pauses transfers, minting, redemption and the handoff all stop; the program halts with a named condition instead of settling against inventory it cannot move, and resumes when the pause lifts.';
}

/**
 * Whether the desk may show this vault by default.
 *
 * Curation decides where a vault appears and nothing else — an uncurated vault
 * mints, settles, funds and redeems exactly the same, and the curator key
 * cannot stop it. So this is an editorial floor, not a safety gate, and the
 * refusals are the ones where showing it first would imply something the chain
 * does not support.
 */
export function curatable(s: IssuerState, now: number): { ok: boolean; why: string[] } {
  const c = gradeOf(s, now);
  return { ok: c.blocking.length === 0, why: c.blocking };
}

/** A grade as a sentence, for a card that has room for one line. */
export const GRADE_SUMMARY: Record<Grade, string> = {
  A: 'The issuer kept no power over an individual balance.',
  B: 'The issuer can stop or rescale balances, but cannot take one.',
  C: 'The issuer can take this vault’s inventory, or stop it moving.',
  D: 'Holding it costs on every transfer, or cannot be fully observed.',
  F: 'This vault cannot be relied on to work while the mint is in this state.',
};
