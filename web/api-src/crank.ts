/* ───────────────────────────────────────────────────────────────────────────
   GET /api/crank — settle a due boundary and fill any handoff.

   Permissionless by design: the program's `settle_boundary` takes no signer,
   so anyone may keep the vault current and the only thing the operator key
   adds is the fee and the inventory to fill against. The site calls this when
   its own calendar says a bell has passed; an operator can call it from a
   terminal; a cron can call it on a schedule. All three get the same
   idempotent answer.
   ─────────────────────────────────────────────────────────────────────────── */
import { crank } from '../../keeper/src/crank-core.ts';
import { connection, json, loadManifest, operator, nodeHandler } from './_shared.ts';

// A warm function remembers its last run; a cold one does not, and that is
// fine — the program itself refuses a second settlement of the same boundary.
let lastRun = 0;
let lastReport: unknown = null;

async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return json(null, 204);
  const now = Date.now();
  if (lastReport && now - lastRun < 20_000) return json({ cached: true, report: lastReport });

  try {
    const m = loadManifest();
    const report = await crank(connection(m), m, operator());
    lastRun = now; lastReport = report;
    /* One line per run, in the function log.

       The report used to live only in the response body, which the platform
       does not keep. On 22 Sep 2026 the 09:35 and 09:55 ET runs both failed to
       settle the opening bell, the 16:05 run found two bells elapsed and
       halted the vault — exactly as designed — and there was no record
       anywhere of *why* the morning settlement had been refused. A run that
       decides not to act, or tries and is refused, is the one worth reading. */
    console.log(JSON.stringify({
      crank: m.symbol, at: report.at, due: report.boundaryDue,
      settled: report.settled, markSource: report.markSource, markNote: report.markNote,
      markAgeSecs: report.markAgeSecs, exposed: report.exposed, halted: report.halted,
      haltReason: report.haltReason, pending: report.pendingAfter, fills: report.fills.length,
      fillError: report.fillError, auction: report.auction,
    }));
    return json({ cached: false, report });
  } catch (e) {
    console.error(JSON.stringify({ crank: 'error', message: e instanceof Error ? e.message : String(e) }));
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

export default nodeHandler(handler);
