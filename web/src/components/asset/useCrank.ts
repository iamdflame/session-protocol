/* The crank, run from the page.
 *
 * Settlement is permissionless, so the page itself keeps the vault current:
 * when the calendar says a bell has passed and the vault has not settled it,
 * the page pings the crank endpoint, which settles and fills. A person can
 * also press the button in the protocol details. Either way the result is
 * read back from the chain, never assumed.
 *
 * This lives at page level, not in the card that shows it: the card sits in a
 * drawer that is usually closed, and closing a drawer must not stop a vault
 * from being brought up to date. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { SESSION_EVENT } from '@sdk/vault.ts';
import { pingCrank, pingDetector, type ChainVault as ChainState } from '@/lib/chain';

export interface CrankResult { at: number; text: string; sig?: string; ok: boolean }

export function useCrank(d: ChainState | null, onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<CrankResult | null>(null);
  const auto = useRef(0);
  /* An event vault has no calendar to crank against. Its tick is the reading:
     post the issuer's mark and the executable price, then settle against them
     if the premium has run. Same act from the reader's side — bring the vault
     up to date — through a different endpoint. */
  const isEvent = d?.vault.sessionKind === SESSION_EVENT;

  const run = useCallback(async (why: 'auto' | 'manual') => {
    setBusy(true);
    const at = () => Math.floor(Date.now() / 1000);
    if (isEvent) {
      const r = await pingDetector();
      setBusy(false);
      if ('error' in r) { setLast({ at: at(), text: r.error, ok: false }); return; }
      const rep = r.report;
      const settled = rep.cranked && 'settled' in rep.cranked ? rep.cranked.settled : null;
      const premium = `premium ${(rep.premiumBps / 100).toFixed(2)}%`;
      if (settled && 'signature' in settled) {
        setLast({ at: at(), ok: true, sig: settled.signature, text: `Boundary settled at ${premium}` });
        onDone();
      } else if ('signature' in rep.posted) {
        setLast({
          at: at(), ok: true, sig: rep.posted.signature,
          text: `Reading posted — mark $${rep.mark.toFixed(2)}, executable $${rep.executable.toFixed(2)}, ${premium}`
            + (rep.overToleranceBps !== null ? ` — past tolerance by ${(rep.overToleranceBps / 100).toFixed(2)}%` : ''),
        });
        onDone();
      } else if ('failed' in rep.posted) {
        setLast({ at: at(), ok: false, text: `Could not post the reading: ${rep.posted.failed}` });
      } else {
        setLast({ at: at(), ok: true, text: `Reading is current — ${premium}` });
      }
      return;
    }
    const r = await pingCrank();
    setBusy(false);
    if ('error' in r) { setLast({ at: at(), text: r.error, ok: false }); return; }
    const rep = r.report;
    if ('signature' in rep.settled) {
      const source = rep.markSource === 'hermes-as-of' ? ' at the bell’s own print' : rep.markSource === 'sponsored' ? ' on the sponsored feed' : '';
      setLast({ at: at(), ok: true, sig: rep.settled.signature, text: `Boundary settled${source}${rep.fills.length ? ` and handoff filled (${rep.fills.length})` : ''}` });
      onDone();
    } else if ('failed' in rep.settled) {
      setLast({ at: at(), ok: false, text: `Settlement failed: ${rep.settled.failed}` });
    } else if (rep.fills.length) {
      setLast({ at: at(), ok: true, sig: rep.fills[0].signature, text: `Handoff filled (${rep.fills.length})` });
      onDone();
    } else if (rep.fillError) {
      setLast({ at: at(), ok: false, text: `Fill failed: ${rep.fillError}` });
    } else {
      setLast({ at: at(), ok: true, text: why === 'manual' ? 'Nothing due — the vault is current' : 'Checked; nothing due' });
    }
  }, [onDone, isEvent]);

  // Ping once when a boundary is due, and not again for five minutes, so a
  // page left open does not hammer the endpoint while a stale mark blocks it.
  const due = !!d?.boundaryDue;
  const halted = !!d?.vault.halted;
  useEffect(() => {
    if (!due || halted) return;
    const now = Date.now();
    if (now - auto.current < 5 * 60_000) return;
    auto.current = now;
    run('auto');
  }, [due, halted, run]);

  return { run, busy, last, isEvent };
}
