/* Where a number came from, and how old it is.
 *
 * Small by default — the source name and a freshness dot — with the full
 * provenance one hover or tab away. The product is unusually specific about
 * data; this keeps that honesty without dumping it into the main view. */
import { Tooltip } from './Tooltip';
import s from './Source.module.css';

export type SourceKind = 'pyth' | 'jupiter' | 'chain' | 'devnet' | 'study' | 'simulated' | 'prestocks';

const NAME: Record<SourceKind, string> = {
  pyth: 'Pyth', jupiter: 'Jupiter', chain: 'On-chain', devnet: 'Devnet',
  study: 'Study', simulated: 'Simulated', prestocks: 'PreStocks',
};

export function ago(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return 'age unknown';
  if (sec < 5) return 'just now';
  if (sec < 90) return `${Math.round(sec)}s ago`;
  if (sec < 5400) return `${Math.round(sec / 60)}m ago`;
  if (sec < 172800) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

export function Source({ kind, detail, ageSec, staleAfter }: {
  kind: SourceKind; detail?: string; ageSec?: number | null; staleAfter?: number;
}) {
  const stale = staleAfter !== undefined && ageSec !== undefined && ageSec !== null && ageSec > staleAfter;
  const tip = [detail ?? NAME[kind], ageSec !== undefined ? `updated ${ago(ageSec)}` : null, stale ? 'older than this surface trusts' : null]
    .filter(Boolean).join(' · ');
  return (
    <Tooltip tip={tip}>
      <span className={s.src} data-stale={stale || undefined} tabIndex={0} aria-label={`Source: ${tip}`}>
        {ageSec !== undefined && <span className={s.fresh} aria-hidden="true" />}
        {NAME[kind]}
      </span>
    </Tooltip>
  );
}
