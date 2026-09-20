/* The two instructions a bell triggers cannot run until a bell rings. Their
   account lists can still be proven against the deployed program now: each is
   sent as-is and must fail with the program's *own* reason for refusing — not
   with an Anchor account error, which is what a wrong or misordered account
   produces. Reaching the program's logic is the assertion. */
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { settleBoundaryIx, fillHandoffIx, ata, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../../sdk/src/ix.ts';
import type { Manifest } from './crank-core.ts';

const m: Manifest = JSON.parse(readFileSync('keeper/.devnet/manifest.json', 'utf8'));
const op = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('keeper/.devnet/operator.json', 'utf8'))));
const conn = new Connection(m.rpc, 'confirmed');
const pk = (s: string) => new PublicKey(s);

async function simulate(name: string, tx: Transaction, expect: RegExp) {
  tx.feePayer = op.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(op);
  const r = await conn.simulateTransaction(tx);
  const logs = (r.value.logs ?? []).join('\n');
  const msg = logs.match(/Error Message: (.+?)\.?$/m)?.[1] ?? logs.match(/Error Code: (\w+)/)?.[1] ?? (r.value.err ? JSON.stringify(r.value.err) : 'succeeded');
  const ok = expect.test(msg);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name} → "${msg}"`);
  if (!ok) console.log(logs.split('\n').filter(l => /Error|failed|Program log/.test(l)).slice(0, 6).map(l => '        ' + l).join('\n'));
  return ok;
}

let failed = 0;

// settle_boundary: version ok, not halted, equity feed read → machine says UpToDate → NoBoundary.
if (!await simulate('settle_boundary reaches the state machine', new Transaction().add(settleBoundaryIx({
  vault: pk(m.vault), nightMint: pk(m.nightMint), dayMint: pk(m.dayMint),
  markPriceUpdate: pk(m.markPriceUpdate), equityPriceUpdate: pk(m.equityPriceUpdate),
})), /no session boundary has elapsed|NoBoundary/i)) failed++;

// fill_handoff: live check, pause check, mark read + checked → plan_fill → NothingToFill.
if (!await simulate('fill_handoff reaches plan_fill', new Transaction().add(fillHandoffIx({
  vault: pk(m.vault), underlyingVault: pk(m.underlyingVault), quoteVault: pk(m.quoteVault),
  nightMint: pk(m.nightMint), dayMint: pk(m.dayMint),
  fillerUnderlying: ata(op.publicKey, pk(m.underlyingMint), pk(m.underlyingTokenProgram)),
  fillerQuote: ata(op.publicKey, pk(m.quoteMint), pk(m.tokenProgram)),
  filler: op.publicKey, markPriceUpdate: pk(m.markPriceUpdate),
  underlyingMint: pk(m.underlyingMint), quoteMint: pk(m.quoteMint),
  underlyingTokenProgram: pk(m.underlyingTokenProgram), quoteTokenProgram: pk(m.tokenProgram),
}, 1_000n, 10n ** 12n, 0n)), /no imbalance to fill|NothingToFill/i)) failed++;

// A deliberately wrong account order must fail *differently* — proving the
// check above discriminates.
const wrong = settleBoundaryIx({
  vault: pk(m.vault), nightMint: pk(m.dayMint), dayMint: pk(m.nightMint),   // swapped
  markPriceUpdate: pk(m.markPriceUpdate), equityPriceUpdate: pk(m.equityPriceUpdate),
});
if (!await simulate('swapped mints are rejected by an address constraint, not by the machine', new Transaction().add(wrong), /ConstraintAddress|address constraint|An address constraint/i)) failed++;

console.log(failed ? `\n${failed} failed` : '\nboth bell instructions reach the program logic with the right accounts');
process.exit(failed ? 1 : 0);
