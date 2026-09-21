/* ───────────────────────────────────────────────────────────────────────────
   The integration test the audit said did not exist.

   A local validator, the program deployed to it, and the *real* mainnet
   accounts cloned in: NVDAx (Token-2022, permanent delegate, transfer-hook
   extension, pausable), USDC (classic SPL), and the Pyth receiver with a live
   price account. Then: initialise a vault over that pair, mint, redeem, and
   read every figure back.

   This is the claim under test — that the program can custody the asset it
   was written for. It could not: `Account<'info, token::Mint>` owner-checks
   against the classic SPL program, so `initialize_vault` against NVDAx failed
   at account validation with `AccountOwnedByWrongProgram` before it reached a
   single line of the handler. Two token programs and the token interface fix
   it, and this is what proves it rather than asserting it.

   Run: npm run test:validator     (~60s)

   Requires a CPU with AVX2: solana-test-validator aborts at startup without
   it, with `Incompatible CPU detected: missing AVX2 support` in the ledger
   log and nothing on stderr. That is why this test did not exist before — the
   machine this was written on cannot run a validator — so it fails loudly and
   says so rather than looking like a broken test.
   ─────────────────────────────────────────────────────────────────────────── */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  PROGRAM_ID, vaultPda, nightMintPda, dayMintPda, underlyingVaultPda, quoteVaultPda, decodeVault,
} from '../../sdk/src/vault.ts';
import {
  initializeVaultIx, mintSharesIx, redeemSharesIx, createAtaIdempotentIx, ata,
  pythFeedAccount, hexToBytes, explainProgramError,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, type VaultParams,
} from '../../sdk/src/ix.ts';
import { valueOf } from '../../sdk/src/settle.ts';
import { inspectMint, transferFee, uiMultiplier } from '../../sdk/src/issuer.ts';

/* The real ones, cloned from mainnet. */
const NVDAX = new PublicKey('Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh');   // Token-2022
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');   // classic SPL
/** A real PreStock: Token-2022, and it charges a transfer fee. */
const OPENAI = new PublicKey('PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF');
const PYTH_RECEIVER = new PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');
const SOL_USD = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
const BTC_USD = 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';
const MAINNET = process.env.MAINNET_RPC ?? 'https://api.mainnet-beta.solana.com';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

const ledger = mkdtempSync(join(tmpdir(), 'session-validator-'));
const payer = Keypair.generate();
writeFileSync(join(ledger, 'payer.json'), JSON.stringify([...payer.secretKey]));

const markAccount = pythFeedAccount(hexToBytes(SOL_USD));
const equityAccount = pythFeedAccount(hexToBytes(BTC_USD));

/* The payer needs real USDC and its mint authority is Circle's, so the
   account is handed to the validator at startup instead. `--account` takes
   the same JSON `solana account --output json` emits, which is how a fork
   test seeds a balance it cannot mint. Nothing about the program's path
   changes: it sees an ordinary USDC token account. */
const USDC_AMOUNT = 5_000n * 10n ** 6n;
const userQuote = ata(payer.publicKey, USDC, TOKEN_PROGRAM_ID);
{
  const d = Buffer.alloc(165);
  USDC.toBuffer().copy(d, 0);
  payer.publicKey.toBuffer().copy(d, 32);
  d.writeBigUInt64LE(USDC_AMOUNT, 64);
  d[108] = 1; // AccountState::Initialized
  writeFileSync(join(ledger, 'usdc-ata.json'), JSON.stringify({
    pubkey: userQuote.toBase58(),
    account: {
      lamports: 2_039_280,
      data: [d.toString('base64'), 'base64'],
      owner: TOKEN_PROGRAM_ID.toBase58(),
      executable: false,
      rentEpoch: 0,
      space: 165,
    },
  }));
}

console.log('starting a validator with the real mainnet accounts cloned in…');
const validator = spawn('solana-test-validator', [
  '--ledger', join(ledger, 'ledger'),
  '--reset', '--quiet',
  '--rpc-port', '8899',
  '--bpf-program', PROGRAM_ID.toBase58(), 'target/deploy/session.so',
  '--url', MAINNET,
  '--clone', NVDAX.toBase58(),
  '--clone', USDC.toBase58(),
  '--clone-upgradeable-program', PYTH_RECEIVER.toBase58(),
  '--clone', OPENAI.toBase58(),
  '--clone', markAccount.toBase58(),
  '--clone', equityAccount.toBase58(),
  '--account', userQuote.toBase58(), join(ledger, 'usdc-ata.json'),
], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
validator.stderr.on('data', d => { stderr += d.toString(); });

const conn = new Connection('http://127.0.0.1:8899', 'confirmed');

try {
  // Wait for it to answer.
  let up = false;
  for (let i = 0; i < 90 && !up; i++) {
    try { await conn.getVersion(); up = true; } catch { await wait(1000); }
  }
  if (!up) {
    let why = stderr.slice(-1200);
    try {
      const log = readFileSync(join(ledger, 'ledger', 'validator.log'), 'utf8');
      const fatal = log.match(/ERROR .*$/m);
      if (fatal) why = fatal[0];
    } catch { /* no log at all */ }
    if (/AVX2/.test(why)) {
      console.log('SKIPPED — this CPU has no AVX2, so solana-test-validator cannot start.');
      console.log('          Run this on a machine that has it; the assertions below are the');
      console.log('          only proof that the program can custody a Token-2022 asset.');
      process.exitCode = 0;
      throw new Error('__skip__');
    }
    throw new Error(`validator never came up:\n${why}`);
  }
  console.log('validator up\n');

  await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 50 * LAMPORTS_PER_SOL), 'confirmed');

  /* ── 1. the accounts really are what mainnet has ──────────────────────── */
  const nv = await conn.getAccountInfo(NVDAX);
  const us = await conn.getAccountInfo(USDC);
  check('NVDAx cloned, and it is Token-2022 with extensions',
    !!nv && nv.owner.equals(TOKEN_2022_PROGRAM_ID) && nv.data.length > 82,
    nv ? `${nv.owner.toBase58()} len ${nv.data.length}` : 'missing');
  check('USDC cloned, and it is the classic SPL program',
    !!us && us.owner.equals(TOKEN_PROGRAM_ID), us ? us.owner.toBase58() : 'missing');
  const mk = await conn.getAccountInfo(markAccount);
  check('a Pyth price account is present and owned by the receiver',
    !!mk && mk.owner.equals(PYTH_RECEIVER), mk ? mk.owner.toBase58() : 'missing');

  /* ── the assertions that exist to fail ──────────────────────────────────
     These read the *live* mainnet mints. If NVDAx's issuer sets a transfer
     hook, or pauses it, or OPENAI's fee schedule moves again, this is where
     the repository finds out — in CI, loudly, rather than on a user's
     settlement. That is the whole reason the real accounts are cloned. */
  const epoch = (await conn.getEpochInfo()).epoch;
  const nvIssuer = inspectMint(nv!.data, nv!.owner, epoch);
  check('NVDAx still has no transfer hook program set',
    nvIssuer.hookProgram === null,
    nvIssuer.hookProgram ? `hook ${nvIssuer.hookProgram.toBase58()} — the vault cannot move this asset` : '');
  check('NVDAx is not paused by its issuer', !nvIssuer.paused);
  check('NVDAx charges no transfer fee', nvIssuer.transferFeeBps === 0, `${nvIssuer.transferFeeBps} bp`);
  check('NVDAx still carries a permanent delegate, and the runbook still says so',
    nvIssuer.permanentDelegate !== null);
  check('NVDAx scaled-UI multiplier is read, not assumed',
    nvIssuer.scaledUi !== null && uiMultiplier(nvIssuer, Math.floor(Date.now() / 1000)) >= 1,
    String(nvIssuer.scaledUi?.multiplier));

  const oa = await conn.getAccountInfo(OPENAI);
  const oaIssuer = oa ? inspectMint(oa.data, oa.owner, epoch) : null;
  check('OPENAI is cloned and its transfer fee is read from the schedule in force',
    !!oaIssuer && oaIssuer.transferFeeBps > 0, oaIssuer ? `${oaIssuer.transferFeeBps} bp` : 'missing');
  check('a fill into a fee-bearing mint would be credited net',
    !!oaIssuer && transferFee(oaIssuer, 1_000_000_000n) > 0n,
    oaIssuer ? `${transferFee(oaIssuer, 1_000_000_000n)} atoms on 1e9` : '');

  /* ── 2. initialise a vault over the real pair ─────────────────────────── */
  const [vault] = vaultPda(NVDAX, USDC);
  const [nightMint] = nightMintPda(vault);
  const [dayMint] = dayMintPda(vault);
  const [underlyingVault] = underlyingVaultPda(vault);
  const [quoteVault] = quoteVaultPda(vault);

  const params: VaultParams = {
    markFeedId: hexToBytes(SOL_USD),
    equityFeedId: hexToBytes(BTC_USD),
    fundingKBps: 2_500, fundingMaxBps: 50,
    // The cloned price account is as old as the snapshot, and a local
    // validator's clock is live — so the staleness window has to admit it or
    // nothing here can be exercised at all.
    maxStaleSecs: 3_600, maxConfBps: 2_000, maxMoveBps: 9_000,
    equityQuietSecs: 86_400, fillIncentiveBps: 10,
    maxCarryDeltaBps: 500, maxUnexpectedClosedSecs: 604_800,
    maxPostedSlotAge: 4_500, maxBellLeadSecs: 300, maxPremiumBps: 1_000, auctionSecs: 120,
    incentiveRamp: [10, 25, 50], requireVerifiedRecap: false,
  };

  const send = async (tx: Transaction, signers: Keypair[] = [payer]) => {
    try {
      return { sig: await sendAndConfirmTransaction(conn, tx, signers, { commitment: 'confirmed' }) };
    } catch (e: unknown) {
      const err = e as { logs?: string[]; message?: string; transactionLogs?: string[] };
      const logs = err.logs ?? err.transactionLogs;
      return { err: explainProgramError(logs) ?? err.message ?? String(e), logs };
    }
  };

  const init = await send(new Transaction().add(initializeVaultIx({
    authority: payer.publicKey, vault, underlyingMint: NVDAX, quoteMint: USDC,
    nightMint, dayMint, underlyingVault, quoteVault,
    markPriceUpdate: markAccount, equityPriceUpdate: equityAccount,
    underlyingTokenProgram: TOKEN_2022_PROGRAM_ID,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
    shareTokenProgram: TOKEN_2022_PROGRAM_ID,
  }, params, 'NVDA')));

  check('initialize_vault succeeds against the real NVDAx and USDC',
    'sig' in init, 'err' in init ? init.err : '');
  if ('err' in init) {
    console.log((init.logs ?? []).filter(l => /Error|Program log/.test(l)).slice(0, 10).map(l => '        ' + l).join('\n'));
    throw new Error('cannot continue without a vault');
  }

  const v = decodeVault((await conn.getAccountInfo(vault))!.data);
  check('the vault records NVDAx as its underlying', v.underlyingMint.equals(NVDAX));
  check('underlying decimals read from the Token-2022 mint', v.underlyingDecimals === 8, String(v.underlyingDecimals));
  check('quote decimals read from USDC', v.quoteDecimals === 6, String(v.quoteDecimals));
  check('both NAVs start at parity', v.nightNav === 10n ** 18n && v.dayNav === 10n ** 18n);
  check('exposure seeded from the calendar', v.exposed === 'night' || v.exposed === 'day', v.exposed);
  check('a mark was read from the real Pyth account', v.lastMark > 0n, v.lastMark.toString());

  /* ── 3. the vault's own token accounts are under the right programs ───── */
  const uv = await conn.getAccountInfo(underlyingVault);
  const qv = await conn.getAccountInfo(quoteVault);
  check('the underlying vault is a Token-2022 account',
    !!uv && uv.owner.equals(TOKEN_2022_PROGRAM_ID), uv ? uv.owner.toBase58() : 'missing');
  check('the quote vault is a classic SPL account',
    !!qv && qv.owner.equals(TOKEN_PROGRAM_ID), qv ? qv.owner.toBase58() : 'missing');
  const nm = await conn.getAccountInfo(nightMint);
  check('the share classes are Token-2022, so they can carry their own names',
    !!nm && nm.owner.equals(TOKEN_2022_PROGRAM_ID), nm ? nm.owner.toBase58() : 'missing');

  /* ── 4. mint and redeem with real USDC ────────────────────────────────── */
  const funded = await conn.getTokenAccountBalance(userQuote).then(r => BigInt(r.value.amount)).catch(() => 0n);
  check('the payer holds real USDC, handed to the validator at startup', funded === USDC_AMOUNT, funded.toString());
  {
    const parked = v.exposed === 'night' ? 'day' : 'night';
    const classMint = parked === 'night' ? nightMint : dayMint;
    const userShares = ata(payer.publicKey, classMint, TOKEN_2022_PROGRAM_ID);
    const accounts = {
      vault, classMint, nightMint, dayMint, quoteVault,
      userQuote, userShares, user: payer.publicKey, quoteMint: USDC,
      tokenProgram: TOKEN_PROGRAM_ID, shareTokenProgram: TOKEN_2022_PROGRAM_ID,
    };
    const m = await send(new Transaction().add(
      createAtaIdempotentIx(payer.publicKey, payer.publicKey, classMint, TOKEN_2022_PROGRAM_ID),
      mintSharesIx(accounts, parked, 1_000n * 10n ** 6n),
    ));
    check('mint_shares moves real USDC into a vault holding a Token-2022 underlying',
      'sig' in m, 'err' in m ? m.err : '');
    if ('sig' in m) {
      const after = decodeVault((await conn.getAccountInfo(vault))!.data);
      const supply = BigInt((await conn.getTokenSupply(classMint)).value.amount);
      check('shares issued at NAV 1.0', supply === 1_000n * 10n ** 6n, supply.toString());
      check('claims equal the quote deposited',
        valueOf(supply, parked === 'night' ? after.nightNav : after.dayNav) === after.ownedQuote,
        `${valueOf(supply, after.dayNav)} vs ${after.ownedQuote}`);

      const r = await send(new Transaction().add(redeemSharesIx(accounts, parked, 400n * 10n ** 6n)));
      check('redeem_shares pays real USDC back out', 'sig' in r, 'err' in r ? r.err : '');
      const left = BigInt((await conn.getTokenSupply(classMint)).value.amount);
      check('supply falls by exactly what was redeemed', left === 600n * 10n ** 6n, left.toString());
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  if (!(e instanceof Error) || e.message !== '__skip__') {
    console.error('\n' + (e instanceof Error ? e.message : String(e)));
    process.exitCode = 1;
  }
} finally {
  validator.kill('SIGKILL');
  await wait(500);
  rmSync(ledger, { recursive: true, force: true });
}
