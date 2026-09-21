/* ───────────────────────────────────────────────────────────────────────────
   Health evaluation.

   A halted vault is not an emergency — it is the protocol refusing to settle
   something it cannot pay, which is the behaviour we want. The emergency is a
   vault that is *about* to halt and nobody noticing: a crank drifting late, an
   imbalance creeping toward the carry limit, an equity feed going quiet during
   a nominal session.

   Everything here is a pure function of vault state, so the thresholds an
   operator will be paged on are testable rather than discovered in production.
   ─────────────────────────────────────────────────────────────────────────── */

import { sessionAt, nextBoundary, Session } from './calendar.ts';
import { WAD, valueOf } from './settle.ts';

import type { IssuerState } from './issuer.ts';

export const Severity = {
  /** Working as intended. */
  Ok: 'ok',
  /** Will need attention, but not now. */
  Notice: 'notice',
  /** Acting now avoids a halt. */
  Warning: 'warning',
  /** Value is at risk, or the vault has already stopped. */
  Critical: 'critical',
} as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

const RANK: Record<Severity, number> = { ok: 0, notice: 1, warning: 2, critical: 3 };

export interface Signal {
  id: string;
  severity: Severity;
  message: string;
  /** What an operator should actually do. Empty when nothing is required. */
  action: string;
}

/** The subset of on-chain state health depends on. */
export interface VaultState {
  halted: boolean;
  haltReason: string;
  paused: number;
  nightSupply: bigint;
  daySupply: bigint;
  nightNav: bigint;
  dayNav: bigint;
  lastMark: bigint;
  ownedUnderlying: bigint;
  ownedQuote: bigint;
  /** Real token-account balances, which may exceed the owned figures. */
  balanceUnderlying: bigint;
  balanceQuote: bigint;
  pendingDelta: bigint;
  lastBoundaryTs: number;
  lastSessionOpen: boolean;
  maxCarryDeltaBps: number;
  /** Publish time of the 24/7 mark feed. */
  markPublishTs: number;
  /** Publish time of the real-equity feed; stale outside market hours by design. */
  equityPublishTs: number;
  maxStaleSecs: number;
  equityQuietSecs: number;
  maxUnexpectedClosedSecs: number;
  /** The issuer's powers over the underlying, when the caller read the mint. */
  issuer?: IssuerState;
  /** Whether the vault's own underlying token account is frozen. */
  vaultFrozen?: boolean;
}

export interface Health {
  severity: Severity;
  signals: Signal[];
  /** Assets minus claims, in quote atoms. Negative is an insolvency. */
  margin: bigint;
  /** How far past its boundary the crank is, in seconds. Zero when current. */
  crankLateSecs: number;
  /** Outstanding handoff as a share of total value, in basis points. */
  carryBps: number;
  /** Positive means NIGHT is the crowded side. WAD-scaled. */
  skew: bigint;
}

const abs = (x: bigint): bigint => (x < 0n ? -x : x);

export function evaluate(v: VaultState, now: number): Health {
  const signals: Signal[] = [];

  const nightValue = valueOf(v.nightSupply, v.nightNav);
  const dayValue = valueOf(v.daySupply, v.dayNav);
  const claims = nightValue + dayValue;
  const assets = (v.ownedUnderlying * v.lastMark) / WAD + v.ownedQuote;
  const margin = assets - claims;

  /* ── solvency ─────────────────────────────────────────────────────────── */
  if (margin < 0n) {
    signals.push({
      id: 'insolvent',
      severity: Severity.Critical,
      message: `assets are ${-margin} quote atoms short of claims`,
      action: 'halt immediately and reconcile before any further redemption',
    });
  }

  /* ── halted ───────────────────────────────────────────────────────────── */
  if (v.halted) {
    signals.push({
      id: 'halted',
      severity: Severity.Critical,
      message: `vault halted: ${v.haltReason}`,
      action: 'recap the missed bells (npm run devnet:recap), fill any residue, then resolve_halt naming this reason',
    });
  }

  /* ── crank punctuality ────────────────────────────────────────────────── */
  // The boundary the vault should already have settled is the first one after
  // its last settlement. Anything past that is the crank running late.
  const due = nextBoundary(v.lastBoundaryTs, 20);
  const crankLateSecs = due !== null && now > due ? now - due : 0;
  const sessionLength = 6.5 * 3600;
  if (crankLateSecs > 0) {
    // Past a full session the *next* boundary lands and the vault halts, so the
    // urgency scales with how much of that window is gone.
    const sev =
      crankLateSecs > sessionLength * 0.75
        ? Severity.Critical
        : crankLateSecs > 900
          ? Severity.Warning
          : Severity.Notice;
    signals.push({
      id: 'crank-late',
      severity: sev,
      message: `boundary unsettled for ${Math.round(crankLateSecs / 60)} minutes`,
      action:
        sev === Severity.Critical
          ? 'settle now — once the next boundary passes the vault halts and needs manual recovery'
          : 'check the keeper is running and the mark oracle is fresh',
    });
  }

  /* ── outstanding handoff ──────────────────────────────────────────────── */
  const carryBps = claims > 0n ? Number((abs(v.pendingDelta) * 10_000n) / claims) : 0;
  if (v.pendingDelta !== 0n) {
    const limit = v.maxCarryDeltaBps;
    const sev =
      carryBps >= limit ? Severity.Critical : carryBps >= limit * 0.5 ? Severity.Warning : Severity.Notice;
    signals.push({
      id: 'unfilled-handoff',
      severity: sev,
      message:
        `${v.pendingDelta > 0n ? 'short' : 'long'} ${abs(v.pendingDelta)} quote atoms of stock ` +
        `(${carryBps}bp of value, limit ${limit}bp)`,
      // `sev` is never Ok in this branch — an unfilled handoff always wants
      // an operator to do something.
      action: 'raise the fill incentive or fill it directly; at the limit the next boundary halts',
    });
  }

  /* ── oracle ───────────────────────────────────────────────────────────── */
  const markAge = now - v.markPublishTs;
  if (markAge > v.maxStaleSecs) {
    signals.push({
      id: 'mark-stale',
      severity: Severity.Warning,
      message: `mark feed last published ${markAge}s ago, limit ${v.maxStaleSecs}s`,
      action: 'settlement and fills will revert until it recovers; check Pyth',
    });
  }

  // The equity feed is *expected* to be silent outside market hours — that
  // silence is the closing bell. It is only a fault during a nominal session.
  const calendar = sessionAt(now);
  const equityQuiet = now - v.equityPublishTs;
  if (calendar === Session.Open && equityQuiet > v.equityQuietSecs) {
    const sev =
      equityQuiet > v.maxUnexpectedClosedSecs ? Severity.Critical : Severity.Warning;
    signals.push({
      id: 'equity-feed-quiet',
      severity: sev,
      message:
        `calendar says open but the equity feed has been quiet for ${Math.round(equityQuiet / 60)} minutes`,
      action:
        'an unencoded holiday or a trading halt. The vault treats this as closed; ' +
        'past max_unexpected_closed_secs it halts outright',
    });
  }

  /* ── funding pressure ─────────────────────────────────────────────────── */
  const total = nightValue + dayValue;
  const skew = total > 0n ? ((nightValue - dayValue) * WAD) / total : 0n;
  if (abs(skew) > (WAD * 80n) / 100n && total > 0n) {
    // A skew past 80% has two very different causes and the same number.
    //
    // With both classes held, funding is at its cap and pulling hard. With
    // one class empty, funding is *zero* — the transfer is sized on the
    // smaller side, so there is nobody to pay and nobody to pay them. Saying
    // "already at its cap" in that case tells an operator to expect a pull
    // that is not coming, and it is the state every vault starts in.
    const oneSideEmpty = nightValue === 0n || dayValue === 0n;
    signals.push({
      id: 'extreme-skew',
      severity: Severity.Notice,
      message: oneSideEmpty
        ? `only ${nightValue === 0n ? 'DAY' : 'NIGHT'} has holders`
        : `${skew > 0n ? 'NIGHT' : 'DAY'} holds ${Number((abs(skew) * 100n) / WAD)}% more value`,
      action: oneSideEmpty
        ? 'funding is zero until both classes have holders, so nothing pulls the book level; '
          + 'the whole exposure hands over at every boundary'
        : 'funding is already at its cap; expect large handoffs at every boundary',
    });
  }

  /* ── unaccounted balances ─────────────────────────────────────────────── */
  const surplusU = v.balanceUnderlying - v.ownedUnderlying;
  const surplusQ = v.balanceQuote - v.ownedQuote;
  if (surplusU > 0n || surplusQ > 0n) {
    signals.push({
      id: 'surplus',
      severity: Severity.Notice,
      message: `${surplusU} underlying and ${surplusQ} quote sitting outside the accounting`,
      action: 'skim_surplus — these are not backing and should not look like it',
    });
  }
  // A balance *below* the owned figure means tokens left without the program
  // knowing. For a Token-2022 underlying there is exactly one way that
  // happens: the issuer's permanent delegate moved them. The program halts
  // the vault as IssuerAction at the next settlement; this is the earlier warning.
  if (surplusU < 0n || surplusQ < 0n) {
    const seized = surplusU < 0n && v.issuer?.permanentDelegate;
    signals.push({
      id: seized ? 'seized' : 'balance-shortfall',
      severity: Severity.Critical,
      message: seized
        ? `${-surplusU} underlying atoms left the vault without the program: the issuer's permanent delegate`
        : `token balances are below what the vault believes it owns (${surplusU}u, ${surplusQ}q)`,
      action: seized
        ? 'the next settlement halts the vault (IssuerAction); nothing on chain can reverse a seizure'
        : 'halt and investigate — this should not be reachable',
    });
  }

  /* ── the issuer ───────────────────────────────────────────────────────── */
  if (v.issuer) {
    if (v.issuer.hookProgram) {
      signals.push({
        id: 'issuer-hook',
        severity: Severity.Critical,
        message: `the issuer set a transfer hook (${v.issuer.hookProgram.toBase58()}); the vault cannot move the underlying`,
        action: 'the next settlement halts the vault (IssuerAction); fills are refused now',
      });
    }
    if (v.issuer.paused) {
      signals.push({
        id: 'issuer-paused',
        severity: Severity.Critical,
        message: 'the issuer has paused all transfers of the underlying',
        action: 'the next settlement halts the vault (IssuerAction); nothing to do but wait for the issuer',
      });
    }
    if (v.vaultFrozen) {
      signals.push({
        id: 'vault-frozen',
        severity: Severity.Critical,
        message: "the vault's underlying token account is frozen by the issuer",
        action: 'the next settlement halts the vault (IssuerAction)',
      });
    }
    if (v.issuer.transferFeeBps > 0) {
      signals.push({
        id: 'transfer-fee',
        severity: Severity.Notice,
        message: `the underlying charges ${v.issuer.transferFeeBps} bp per transfer; fills are credited net`,
        action: 'fillers are paid for what arrives, not what they send — quote accordingly',
      });
    }
  }

  /* ── paused ───────────────────────────────────────────────────────────── */
  if (v.paused !== 0) {
    signals.push({
      id: 'paused',
      severity: Severity.Notice,
      message: `operations paused (flags ${v.paused})`,
      action: 'intentional unless nobody set it',
    });
  }

  const severity = signals.reduce<Severity>(
    (worst, s) => (RANK[s.severity] > RANK[worst] ? s.severity : worst),
    Severity.Ok,
  );
  return { severity, signals, margin, crankLateSecs, carryBps, skew };
}

/** One line per signal, worst first — what a pager or a log line wants. */
export function format(h: Health): string {
  if (!h.signals.length) return 'ok — nothing to report';
  return h.signals
    .slice()
    .sort((a, b) => RANK[b.severity] - RANK[a.severity])
    .map(s => `[${s.severity.toUpperCase()}] ${s.id}: ${s.message}` + (s.action ? `\n    → ${s.action}` : ''))
    .join('\n');
}
