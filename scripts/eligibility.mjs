#!/usr/bin/env node
/* The two rules that are not about correctness, checked on the machine that
 * actually runs things.
 *
 * They live in `.github/workflows/ci.yml` too, and for most of this project's
 * life that was the whole answer. It was not: this account's GitHub Actions
 * are locked for billing, so every push has failed in four seconds without
 * starting a job, and "CI fails the build on the mention" has never once been
 * true. A rule enforced only by a runner that never runs is a rule kept in a
 * document, which is the thing the CI job was written to avoid.
 *
 * So the same two checks run in `npm test`, where they cost nothing and fire
 * on the machine the commit is made on.
 *
 *   1. PreStocks disqualifies a submission carrying a competing pre-IPO mint.
 *      That is the eligibility condition, not a style preference.
 *   2. No key, and no private manifest, may be a tracked file.
 *
 * Tracked files only: what is in the repository is what counts, and scanning
 * the working tree would trip over anybody's local notes.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/* Word boundaries, not substrings. The first version of this rule — in the
   CI job, where it never ran — was a bare `grep -niE`, and it matched our own
   `devnet-openai.json` inside the word `devnet-openai`. It would have failed
   every push on the PreStocks-shaped vault this project entered *with*. A
   rule that cannot tell the entry from the disqualification is not a rule. */
const COMPETING = /\b(tessera|t-kalshi|t-openai|stonkfun|tspacex)\b/i;
const SECRETS = /(^|\/)(\.env|.*keypair\.json|operator\.json|manifest\.json)$/;

/* What disqualifies a submission is carrying a competing pre-IPO *mint*, not
   naming one in the document that exists to say it was refused. These two
   files and the workflow spell the terms out for that reason and no other;
   everything else in the tree is scanned. */
const EXEMPT = new Set([
  '.github/workflows/ci.yml',
  'scripts/eligibility.mjs',
  'docs/BOUNTIES.md',
]);

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n').filter(Boolean);

let failed = 0;
const fail = (what, detail) => { console.log(`  FAIL  ${what} — ${detail}`); failed++; };
const ok = what => console.log(`  ok    ${what}`);

const offenders = [];
for (const f of tracked) {
  if (EXEMPT.has(f)) continue;
  let body;
  try { body = readFileSync(f, 'utf8'); } catch { continue; }   // binary or gone
  if (COMPETING.test(body)) offenders.push(f);
}
if (offenders.length) fail('no competing pre-IPO mint is referenced', `PreStocks eligibility is lost: ${offenders.join(', ')}`);
else ok(`no competing pre-IPO mint in ${tracked.length} tracked files`);

const leaked = tracked.filter(f => SECRETS.test(f));
if (leaked.length) fail('no key or private manifest is tracked', leaked.join(', '));
else ok('no key or private manifest is tracked');

console.log(failed ? `\n${failed} failed` : '\neligibility holds');
process.exit(failed ? 1 : 0);
