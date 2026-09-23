/* ───────────────────────────────────────────────────────────────────────────
   GET /api/detector — refresh the event vault's reading.

   The equity vault settles against Pyth and needs nothing from an operator
   but a fee. The event vault cannot: no oracle prices a pre-IPO token, so it
   settles against a mark and an executable price somebody posts, and the
   program bounds how old that may be. Left alone, the reading goes stale and
   the vault stops — which is the correct behaviour and a poor demonstration.

   So this runs on a schedule. It is not permissionless the way `/api/crank`
   is: `settle_boundary` takes no signer, and `post_detector` takes the
   detector authority, because a reading nobody can verify should at least be
   attributable. `/markets/OPENAI` says whose it is.
   ─────────────────────────────────────────────────────────────────────────── */
import { postDetector } from '../../keeper/src/detector.ts';
import { crank } from '../../keeper/src/crank-core.ts';
import { connection, json, loadEventManifest, operator, nodeHandler } from './_shared.ts';

let lastRun = 0;
let lastReport: unknown = null;

async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return json(null, 204);
  const now = Date.now();
  // The issuer does not reprice by the second, and a fee per page load is a
  // fee nobody meant to pay.
  if (lastReport && now - lastRun < 60_000) return json({ cached: true, report: lastReport });

  try {
    const m = loadEventManifest();
    const conn = connection(m);
    const dry = new URL(req.url).searchParams.get('dry') === '1';
    const report = await postDetector(conn, m, operator(), { dry });

    /* And then tick it. An event vault has no bell to schedule a crank
       against — its boundary is the next print, or a premium that runs past
       the vault's tolerance — so the moment a fresh reading exists is exactly
       the moment worth asking whether it has crossed. Posting the reading and
       leaving it unread would be a detector nothing consults. */
    const cranked = dry ? { skipped: 'dry run' } : await crank(conn, m, operator())
      .then(r => r as unknown)
      .catch(e => ({ failed: e instanceof Error ? e.message : String(e) }));

    const out = { ...report, cranked };
    if (!dry) { lastRun = now; lastReport = out; }
    // Logged for the same reason the crank is: the response body is not kept.
    console.log(JSON.stringify({ detector: m.symbol, premiumBps: report.premiumBps, posted: report.posted, cranked }));
    return json({ cached: false, report: out });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

export default nodeHandler(handler);
