/* Open a vault, without asking anybody.
 *
 * `initialize_vault` takes no permission: the signer becomes the vault's
 * authority and the PDA is seeded by the mint pair, so there is exactly one
 * vault per pair and whoever gets there first opens it. That has been true
 * since the program shipped and there was no way to exercise it from a
 * browser, which is the difference between a property and a claim.
 *
 * The form asks for the two things only a person can decide — which mints,
 * and what to call the classes — and reads everything else off the chain.
 * Decimals and the owning token program are read rather than typed because
 * they are the two fields a mistake in is silent: the program records the
 * decimals and validates every transfer against them, and a Token-2022 mint
 * passed as classic SPL fails account validation with nothing to explain it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import {
  vaultPda, nightMintPda, dayMintPda, underlyingVaultPda, quoteVaultPda,
  SESSION_EQUITY, SESSION_EVENT, type SessionKind,
} from '@sdk/vault.ts';
import {
  initializeVaultIx, pythFeedAccount, hexToBytes, TOKEN_2022_PROGRAM_ID, type VaultParams,
} from '@sdk/ix.ts';
import { FEEDS } from '@sdk/feeds.ts';
import { readMint, explorer, explorerAddr, short, useDevnet, type MintFacts } from '@/lib/chain';
import { useWalletModal } from '@/components/wallet/WalletModal';
import s from './List.module.css';

/* The same parameters the operator's own devnet vaults run, because a vault
   opened here should behave like the ones on the rest of the site. The two
   that differ from a mainnet default are about Pyth's devnet cadence: the
   sponsored feeds refresh every few minutes, so a 120-second staleness bound
   would refuse almost every settlement for no reason. */
const DEVNET_PARAMS = {
  fundingKBps: 2_500,
  fundingMaxBps: 50,
  maxStaleSecs: 1_800,
  maxConfBps: 500,
  maxMoveBps: 1_000,
  equityQuietSecs: 3_600,
  fillIncentiveBps: 10,
  maxCarryDeltaBps: 500,
  maxUnexpectedClosedSecs: 3 * 3_600,
  maxPostedSlotAge: 4_500,
  maxBellLeadSecs: 300,
  maxPremiumBps: 1_000,
  auctionSecs: 120,
  incentiveRamp: [10, 25, 50] as [number, number, number],
  requireVerifiedRecap: false,
};

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; text: string }
  | { kind: 'done'; signature: string; vault: string; symbol: string }
  | { kind: 'error'; text: string };

/** A mint field: what was typed, and what the chain says it is. */
function useMintField(address: string) {
  const { connection } = useConnection();
  const [facts, setFacts] = useState<MintFacts | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!address.trim()) { setFacts(null); setProblem(null); return; }
    let live = true;
    setFacts(null); setProblem(null);
    const t = setTimeout(() => {
      readMint(connection, address.trim()).then(r => {
        if (!live) return;
        if (typeof r === 'string') setProblem(r); else setFacts(r);
      });
    }, 350);   // a pause, so every keystroke is not an RPC call
    return () => { live = false; clearTimeout(t); };
  }, [connection, address]);

  return { facts, problem };
}

export default function List() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const { setOpen } = useWalletModal();
  const devnet = useDevnet();

  const [symbol, setSymbol] = useState('');
  const [underlying, setUnderlying] = useState('');
  const [quote, setQuote] = useState('');
  const [kind, setKind] = useState<SessionKind>(SESSION_EQUITY);
  const [markFeed, setMarkFeed] = useState(FEEDS[0].name);
  const [equityFeed, setEquityFeed] = useState(FEEDS[1].name);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const u = useMintField(underlying);
  const q = useMintField(quote);

  const symbolOk = /^[A-Z0-9]{1,8}$/.test(symbol);
  const addrs = useMemo(() => {
    if (!u.facts || !q.facts) return null;
    const [vault] = vaultPda(new PublicKey(u.facts.address), new PublicKey(q.facts.address));
    return {
      vault,
      night: nightMintPda(vault)[0],
      day: dayMintPda(vault)[0],
      underlyingVault: underlyingVaultPda(vault)[0],
      quoteVault: quoteVaultPda(vault)[0],
    };
  }, [u.facts, q.facts]);

  // One vault per mint pair, by construction. Saying so before the signature
  // beats a transaction that fails on an account that already exists.
  const [taken, setTaken] = useState<boolean | null>(null);
  useEffect(() => {
    if (!addrs) { setTaken(null); return; }
    let live = true;
    connection.getAccountInfo(addrs.vault)
      .then(i => { if (live) setTaken(!!i); })
      .catch(() => { if (live) setTaken(null); });
    return () => { live = false; };
  }, [connection, addrs]);

  const ready = !!publicKey && symbolOk && !!addrs && taken === false && status.kind !== 'busy';

  const open = useCallback(async () => {
    if (!publicKey || !addrs || !u.facts || !q.facts) return;
    setStatus({ kind: 'busy', text: 'Waiting for your wallet…' });
    try {
      const params: VaultParams = {
        ...DEVNET_PARAMS,
        markFeedId: hexToBytes(FEEDS.find(f => f.name === markFeed)!.id),
        equityFeedId: hexToBytes(FEEDS.find(f => f.name === equityFeed)!.id),
      };
      const tx = new Transaction()
        // Initialising creates two mints, two token accounts and the vault,
        // and writes metadata into both mints. It does not fit 200,000 units.
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
        .add(initializeVaultIx({
          authority: publicKey,
          vault: addrs.vault,
          underlyingMint: new PublicKey(u.facts.address),
          quoteMint: new PublicKey(q.facts.address),
          nightMint: addrs.night,
          dayMint: addrs.day,
          underlyingVault: addrs.underlyingVault,
          quoteVault: addrs.quoteVault,
          markPriceUpdate: pythFeedAccount(params.markFeedId),
          equityPriceUpdate: pythFeedAccount(params.equityFeedId),
          underlyingTokenProgram: u.facts.tokenProgram,
          quoteTokenProgram: q.facts.tokenProgram,
          shareTokenProgram: TOKEN_2022_PROGRAM_ID,
        }, params, symbol, kind, `${window.location.origin}/meta`));

      const signature = await sendTransaction(tx, connection);
      setStatus({ kind: 'busy', text: 'Confirming…' });
      const bh = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature, ...bh }, 'confirmed');
      setStatus({ kind: 'done', signature, vault: addrs.vault.toBase58(), symbol });
      setTaken(true);
    } catch (e) {
      setStatus({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  }, [publicKey, addrs, u.facts, q.facts, symbol, kind, markFeed, equityFeed, connection, sendTransaction]);

  return (
    <div className={s.page}>
      <header className={`shell ${s.head}`}>
        <p className="eyebrow">List</p>
        <h1 className={`display ${s.title}`}>Open a vault. Nobody has to let you.</h1>
        <p className={`lead ${s.lead}`}>
          <span className="mono">initialize_vault</span> takes no permission. The signer
          becomes the vault&rsquo;s authority, the address is derived from the two mints, and
          there is exactly one vault per pair — so whoever gets there first opens it. This
          page is that instruction, on devnet, from your own wallet.
        </p>
      </header>

      <div className={`shell ${s.body}`}>
        <form className={`card ${s.form}`} onSubmit={e => { e.preventDefault(); open(); }}>
          <div className={s.field}>
            <label className={s.label} htmlFor="list-symbol">Symbol</label>
            <input
              id="list-symbol" className={s.input} value={symbol} maxLength={8}
              data-bad={symbol.length > 0 && !symbolOk}
              onChange={e => setSymbol(e.target.value.toUpperCase())}
              placeholder="NVDA" autoComplete="off" spellCheck={false}
            />
            <span className={s.hint}>
              Up to eight uppercase letters or digits — it is stored on chain in eight bytes
              and names both classes. {symbolOk && <>They will be <strong>{symbol}.{kind === SESSION_EVENT ? 'THEN' : 'NIGHT'}</strong> and <strong>{symbol}.{kind === SESSION_EVENT ? 'NOW' : 'DAY'}</strong>.</>}
            </span>
          </div>

          <div className={s.field}>
            <label className={s.label} htmlFor="list-underlying">Underlying mint</label>
            <input
              id="list-underlying" className={`mono ${s.input}`} value={underlying}
              data-bad={!!u.problem}
              onChange={e => setUnderlying(e.target.value.trim())}
              placeholder="the asset the vault holds" autoComplete="off" spellCheck={false}
            />
            {u.problem && <span className={s.read} data-bad="true">{u.problem}</span>}
            {u.facts && (
              <span className={s.read}>
                {u.facts.token2022 ? 'Token-2022' : 'SPL Token (classic)'} · {u.facts.decimals} decimals ·
                supply {(Number(u.facts.supply) / 10 ** u.facts.decimals).toLocaleString('en-US', { maximumFractionDigits: 2 })}
              </span>
            )}
          </div>

          <div className={s.field}>
            <label className={s.label} htmlFor="list-quote">Quote mint</label>
            <input
              id="list-quote" className={`mono ${s.input}`} value={quote}
              data-bad={!!q.problem}
              onChange={e => setQuote(e.target.value.trim())}
              placeholder="what shares are priced and redeemed in" autoComplete="off" spellCheck={false}
            />
            {q.problem && <span className={s.read} data-bad="true">{q.problem}</span>}
            {q.facts && (
              <span className={s.read}>
                {q.facts.token2022 ? 'Token-2022' : 'SPL Token (classic)'} · {q.facts.decimals} decimals
              </span>
            )}
            {devnet && (
              <span className={s.hint}>
                The operator&rsquo;s devnet pair, if you want a vault that behaves like the ones
                on this site:{' '}
                <button type="button" className={s.sig}
                        onClick={() => { setUnderlying(devnet.underlyingMint); setQuote(devnet.quoteMint); }}>
                  use them
                </button>
              </span>
            )}
          </div>

          <div className={s.row}>
            <div className={s.field}>
              <label className={s.label} htmlFor="list-kind">Session</label>
              <select id="list-kind" className={s.select} value={kind}
                      onChange={e => setKind(Number(e.target.value) as SessionKind)}>
                <option value={SESSION_EQUITY}>Equity — an exchange calendar</option>
                <option value={SESSION_EVENT}>Event — prints and premium</option>
              </select>
              <span className={s.hint}>
                {kind === SESSION_EVENT
                  ? 'No bell. The boundary is the next scheduled print, or the executable price running past the mark — both from a reading an operator posts. You will need to post one before it can settle.'
                  : 'NYSE hours from the calendar, cross-checked against an equity feed going quiet at the close.'}
              </span>
            </div>
            <div className={s.field}>
              <label className={s.label} htmlFor="list-mark">Mark feed</label>
              <select id="list-mark" className={s.select} value={markFeed}
                      onChange={e => setMarkFeed(e.target.value)}>
                {FEEDS.map(f => (
                  <option key={f.id} value={f.name}>{f.name}{f.devnet ? '' : ' — mainnet only'}</option>
                ))}
              </select>
              <span className={s.hint}>{FEEDS.find(f => f.name === markFeed)?.note}</span>
            </div>
          </div>

          <div className={s.field}>
            <label className={s.label} htmlFor="list-equity">Equity feed</label>
            <select id="list-equity" className={s.select} value={equityFeed}
                    onChange={e => setEquityFeed(e.target.value)}>
              {FEEDS.map(f => (
                <option key={f.id} value={f.name}>{f.name}{f.devnet ? '' : ' — mainnet only'}</option>
              ))}
            </select>
            <span className={s.hint}>
              The one that goes quiet at the bell. On devnet nothing does, which is why the
              vaults here use a crypto feed and say so rather than pretending the check works.
            </span>
          </div>

          {addrs && (
            <div className={s.derived}>
              {[
                ['Vault', addrs.vault],
                [`${symbol || 'X'}.${kind === SESSION_EVENT ? 'THEN' : 'NIGHT'}`, addrs.night],
                [`${symbol || 'X'}.${kind === SESSION_EVENT ? 'NOW' : 'DAY'}`, addrs.day],
              ].map(([k, v]) => (
                <div key={String(k)} className={s.derivedRow}>
                  <span className={s.derivedKey}>{k as string}</span>
                  <a className={`mono ${s.derivedVal} ${s.sig}`} href={explorerAddr((v as PublicKey).toBase58())}
                     target="_blank" rel="noreferrer">{short((v as PublicKey).toBase58(), 6)} ↗</a>
                </div>
              ))}
              {taken && (
                <p className={`${s.status} ${s.err}`}>
                  A vault for this pair already exists — there is only ever one, and it is
                  above. That is the point of deriving the address from the mints.
                </p>
              )}
            </div>
          )}

          {publicKey ? (
            <button className={s.submit} type="submit" disabled={!ready}>
              {status.kind === 'busy' ? status.text : 'Open the vault'}
            </button>
          ) : (
            <button className={s.submit} type="button" onClick={() => setOpen(true)}>
              Connect a wallet
            </button>
          )}

          {status.kind === 'error' && <p className={`${s.status} ${s.err}`}>{status.text}</p>}
          {status.kind === 'done' && (
            <p className={`${s.status} ${s.ok}`}>
              {status.symbol} is open.{' '}
              <a className={s.sig} href={explorer(status.signature)} target="_blank" rel="noreferrer">
                transaction ↗
              </a>{' '}
              · <Link className={s.sig} to="/markets">see it in the catalog</Link>
            </p>
          )}
        </form>

        <aside className={s.side}>
          <div className={`card ${s.note}`}>
            <h2 className={s.noteTitle}>What you get, and what you owe</h2>
            <p className={s.noteBody}>
              You become the vault&rsquo;s <strong>authority</strong>: you can halt it, pause
              minting, change its parameters within the bounds the program enforces, and hand
              it to somebody else in two steps. You cannot mint yourself a share, move a token
              a holder has a claim on, or repoint the feeds — those are refused by the program,
              not by convention. <Link className={s.sig} to="/how-it-works">How it works</Link>.
            </p>
            <p className={s.noteBody}>
              Nobody cranks it for you. Settlement is permissionless, so anyone can, but the
              operator&rsquo;s cron only covers the vaults on this site — and the handoff is
              filled from an inventory that is theirs, not yours.
            </p>
          </div>

          <div className={`card ${s.note}`}>
            <h2 className={s.noteTitle}>Curated is not verified</h2>
            <p className={s.noteBody}>
              A new vault is <strong>uncurated</strong>, which decides one thing: whether the
              catalog shows it by default. It settles, funds, mints and redeems exactly the
              same either way, and the curator key cannot stop it. That is why the word is
              curated rather than verified.
            </p>
          </div>

          <div className={`card ${s.note}`}>
            <h2 className={s.noteTitle}>This is devnet</h2>
            <p className={s.noteBody}>
              The program is the mainnet program and every rule here is the real one, but the
              cluster is devnet and the feeds available on it are crypto feeds standing in for
              equity marks. A vault opened here holds devnet tokens.{' '}
              <Link className={s.sig} to="/markets">What is and is not live</Link>.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
