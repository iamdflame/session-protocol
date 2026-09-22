/* Standard status language.
 *
 * LIVE, DEVNET, SIMULATED are the honesty labels and appear wherever a figure
 * could be mistaken for another kind. The rest describe a vault or a market.
 * Each is a dot and one word: identity by text as well as colour, so a
 * colour-blind reader and a screen reader get the same answer. */
import s from './Status.module.css';

export type StatusKind =
  | 'live' | 'devnet' | 'simulated' | 'demo' | 'mainnet' | 'open' | 'closed' | 'handoff'
  | 'mint-available' | 'mint-closed' | 'healthy' | 'paused' | 'stale' | 'halted'
  | 'confirmed' | 'event';

const WORD: Record<StatusKind, string> = {
  live: 'Live', devnet: 'Devnet', simulated: 'Simulated', demo: 'Demo', mainnet: 'Mainnet',
  open: 'Open', closed: 'Closed', handoff: 'Handoff', 'mint-available': 'Mint available',
  'mint-closed': 'Mint closed', healthy: 'Healthy', paused: 'Paused', stale: 'Stale',
  halted: 'Halted', confirmed: 'Confirmed', event: 'No session',
};

export function Status({ kind, label, title, bare, pulse }: {
  kind: StatusKind; label?: string; title?: string; bare?: boolean; pulse?: boolean;
}) {
  return (
    <span className={s.status} data-kind={kind} data-bare={bare || undefined} title={title}>
      <span className={s.dot} data-live={pulse || kind === 'live' || undefined} aria-hidden="true" />
      {label ?? WORD[kind]}
    </span>
  );
}

/** DAY or NIGHT, in its own colour and its own word. */
export function ClassTag({ cls, active, quiet, children }: {
  cls: 'day' | 'night'; active?: boolean; quiet?: boolean; children?: React.ReactNode;
}) {
  return (
    <span className={s.tag} data-cls={cls} data-active={active || undefined} data-quiet={quiet || undefined}>
      <span className={s.tagDot} aria-hidden="true" />
      {children ?? cls.toUpperCase()}
    </span>
  );
}
