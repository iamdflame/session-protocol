/* ───────────────────────────────────────────────────────────────────────────
   /trade?demo=1 — the product, without a wallet and without pretending.

   A sandbox copy of the NVDAx vault, taken from devnet when the page opens,
   run with the program's own arithmetic in this browser. A visitor can drag
   the day, mint and redeem, set where the mark goes and ring the next bell,
   and watch exposure, NAV and funding move exactly as `settle()` moves them —
   then throw it all away by leaving. Nothing here is signed, sent or stored,
   and every surface says DEMO so nothing can be mistaken for the chain. The
   one thing it will not do is trade for real: that is a wallet, on the live
   page, and the button says so.
   ─────────────────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { nextBoundary } from '@sdk/calendar.ts';
import { useQuotes, fmtUsd, type Asset } from '@/lib/data';
import { useChainVault, type Devnet } from '@/lib/chain';
import { etClock, etDate } from '@/lib/session';
import { previewLocalBell, holdingChange } from '@/lib/bell';
import { sandboxFromChain } from '@/lib/sandbox';
import { settleAt, derive, fromQuote, fromShares, navToNumber, type LocalVault } from '@/lib/localVault';
import { ClassPair, type PairState } from './session/ClassPair';
import { SessionRail, type ScrubState } from './session/SessionRail';
import { TradePanel, TradeDock, type TradeRequest } from './trade/TradePanel';
import { useLocalEngine, classStem } from './trade/engines';
import { AssetHeader } from './asset/AssetHeader';
import { Position } from './asset/Position';
import { LocalActivity } from './asset/Activity';
import { AssetSkeleton } from './ChainVault';
import { useWalletModal } from './wallet/WalletModal';
import { Status, ClassTag } from './ui/Status';
import { Button } from './ui/Button';
import { Icon } from './ui/Icon';
import { useToast } from './ui/Toast';
import s from './asset/Asset.module.css';
import d from './DemoVault.module.css';

type Cls = 'day' | 'night';
const MOVE_LIMIT = 5; // percent either way

export function DemoVault({ m, asset }: { m: Devnet; asset: Asset }) {
  const chain = useChainVault(m);
  const c = chain.data;
  const [box, setBox] = useState<LocalVault | null>(null);
  const [seedSlot, setSeedSlot] = useState<number | null>(null);

  // Seed once, from the first read of the real vault.
  useEffect(() => {
    if (c && !box) { setBox(sandboxFromChain(c, asset.symbol)); setSeedSlot(c.slot); }
  }, [c, box, asset.symbol]);

  if (!c || !box) {
    if (chain.status === 'error' && !c) {
      return (
        <div className={s.gate}>
          <Status kind="stale" label="Devnet unreachable" />
          <h1 className={s.gateTitle}>{asset.symbol}: the demo could not be seeded.</h1>
          <p className={s.gateBody}>
            The demo starts from the real vault&rsquo;s state and could not read it: {chain.error.message}. It will not
            invent one instead. The public devnet endpoint rate-limits; trying again usually gets through.
          </p>
          <div className={s.gateActions}><Button onClick={() => chain.refresh()}>Try again</Button></div>
        </div>
      );
    }
    return <AssetSkeleton symbol={asset.symbol} />;
  }
  return (
    <Sandbox
      m={m} asset={asset} box={box} setBox={setBox} seedSlot={seedSlot ?? c.slot}
      markWad={c.markWad} markUsd={c.markUsd} markAge={c.markAgeSecs}
      funding={{ kBps: BigInt(c.vault.fundingKBps), maxBps: BigInt(c.vault.fundingMaxBps) }}
      reseed={() => { setBox(sandboxFromChain(c, asset.symbol)); setSeedSlot(c.slot); }}
    />
  );
}

function Sandbox({ m, asset, box, setBox, seedSlot, markWad, markUsd, markAge, funding, reseed }: {
  m: Devnet; asset: Asset; box: LocalVault; setBox: (v: LocalVault) => void; seedSlot: number;
  markWad: bigint | null; markUsd: number | null; markAge: number | null;
  funding: { kBps: bigint; maxBps: bigint }; reseed: () => void;
}) {
  const navigate = useNavigate();
  const { setOpen } = useWalletModal();
  const toast = useToast();
  const { quotes, settled } = useQuotes([asset.mint]);
  const [scrub, setScrub] = useState<ScrubState | null>(null);
  const [move, setMove] = useState(0);            // percent the mark moves before the bell
  const [rung, setRung] = useState(0);
  const [dock, setDock] = useState(false);
  const [request, setRequest] = useState<TradeRequest | null>(null);

  const stem = classStem(m.symbol, m.vaultSymbol);
  const nextBell = useMemo(() => nextBoundary(box.lastBoundaryTs, 20), [box.lastBoundaryTs]);
  // The mark at the bell: the live one, moved by the slider (tenths of a percent, exactly).
  const bellMark = markWad !== null ? (markWad * BigInt(Math.round((100 + move) * 1000))) / 100_000n : null;
  const preview = bellMark !== null ? previewLocalBell(box, bellMark) : null;
  const derived = useMemo(() => (markWad !== null ? derive(box, markWad, Math.floor(Date.now() / 1000)) : null), [box, markWad]);
  // Marks are linear in price, so the last settled mark reads back in dollars by ratio.
  const lastUsd = markUsd !== null && markWad !== null && markWad > 0n && box.lastMark > 0n
    ? markUsd * (Number(box.lastMark) / Number(markWad)) : null;

  const markInfo = useMemo(() => ({
    label: `Pyth · ${m.markFeed}`, source: 'pyth' as const,
    detail: `The devnet vault's mark, read live — the sandbox settles against it (a stand-in for NVDAX on devnet)`,
  }), [m.markFeed]);
  const engine = useLocalEngine(box, setBox, { price: markUsd ?? 0, ageSec: markAge, live: true }, {
    stem, demo: true, reopens: nextBell ? `${etClock(nextBell)} ET` : null, markInfo,
  });

  const ring = useCallback(() => {
    if (bellMark === null || !nextBell) return;
    const before = box;
    const after = settleAt(box, bellMark, nextBell, funding);
    setBox(after);
    setRung(n => n + 1);
    const f = after.history[0]?.funding ?? 0n;
    toast({
      tone: 'info',
      title: `Demo bell rung · ${after.exposed.toUpperCase()} holds the stock`,
      detail: `${before.exposed.toUpperCase()} NAV ${navToNumber(before.exposed === 'day' ? before.dayNav : before.nightNav).toFixed(6)} → ${navToNumber(before.exposed === 'day' ? after.dayNav : after.nightNav).toFixed(6)}`
        + (f !== 0n ? ` · funding ${fmtUsd(Math.abs(fromQuote(f)), 2)} ${f > 0n ? 'NIGHT → DAY' : 'DAY → NIGHT'}` : ''),
    });
    setMove(0);
  }, [bellMark, nextBell, box, setBox, funding, toast]);

  const pair: PairState = {
    exposed: box.exposed, halted: box.halted, event: false,
    nav: { day: navToNumber(box.dayNav), night: navToNumber(box.nightNav) },
    supply: { day: fromShares(box.daySupply), night: fromShares(box.nightSupply) },
    value: derived ? { day: fromQuote(derived.valueDay), night: fromQuote(derived.valueNight) } : { day: 0, night: 0 },
    held: { day: fromShares(box.myDay), night: fromShares(box.myNight) },
    source: { kind: 'simulated', detail: `Demo sandbox, seeded from the devnet vault at slot ${seedSlot.toLocaleString()}`, ageSec: null },
  };
  const held = { day: fromShares(box.myDay), night: fromShares(box.myNight) };
  const ch = preview ? holdingChange(preview, held) : null;
  const parked: Cls = box.exposed === 'night' ? 'day' : 'night';
  const real = () => { navigate(`/markets/${asset.symbol}`); setOpen(true); };

  return (
    <div className={s.page}>
      <section className={d.banner} aria-label="Demo mode">
        <span className={d.tag}>Demo · read-only</span>
        <p className={d.bannerText}>
          <strong>A sandbox copy of the {asset.symbol} vault</strong>, taken from devnet at slot{' '}
          <span className="num">{seedSlot.toLocaleString()}</span>. Everything here runs the program&rsquo;s own arithmetic in
          your browser and is thrown away when you leave — nothing is signed, sent or stored.
        </p>
        <div className={d.bannerActions}>
          <Button size="sm" variant="secondary" onClick={() => { reseed(); setRung(0); setMove(0); }}>Reset demo</Button>
          <Button size="sm" onClick={real}><Icon name="wallet" size={14} /> Trade for real</Button>
        </div>
      </section>

      <AssetHeader
        asset={asset} quote={quotes[asset.mint]} quoteSettled={settled}
        badges={<>
          <Status kind="demo" label="Demo · simulated" />
          <Status kind="devnet" label="Seeded from devnet" bare />
        </>}
        meta={<span>Marked to Pyth {m.markFeed}, read live · {rung} demo bell{rung === 1 ? '' : 's'} rung</span>}
      />

      <div className={s.grid}>
        <div className={s.main}>
          <section className={`${s.card} ${s.first}`} aria-labelledby="demo-rail-h">
            <header className={s.cardHead}>
              <h2 className={s.cardTitle} id="demo-rail-h">Drag the day</h2>
              <Status kind="live" label="The real calendar" bare />
            </header>
            <SessionRail interactive size="md" onScrub={setScrub} label="Today's sessions, draggable" />
            <p className={d.readout} aria-live="polite">
              {scrub
                ? <>At <span className="num">{etClock(scrub.t)} ET</span> <b data-cls={scrub.cls}>{scrub.cls.toUpperCase()}</b> holds the stock and{' '}
                    <b data-cls={scrub.cls === 'day' ? 'night' : 'day'}>{scrub.cls === 'day' ? 'NIGHT' : 'DAY'}</b> is the class you could mint.
                    {scrub.handoff ? <> {scrub.handoff.label}.</> : null}</>
                : <>Drag across today, or tab to the rail and use the arrow keys: at any minute one class holds the stock and the other is open to mint.</>}
            </p>
          </section>

          <div className={s.second}>
            <ClassPair
              asset={asset} detailed virtual vaultSymbol={stem} state={pair}
              onMint={cls => { setRequest({ cls, mode: 'mint', n: Date.now() }); setDock(true); }}
              hinge={
                <span className={d.hinge}>
                  <span className={d.hingeLabel}>Sandbox bell</span>
                  <span className={`num ${d.hingeTime}`}>{nextBell ? etClock(nextBell) : '—'}</span>
                  <span className={d.hingeSub}>{nextBell ? etDate(nextBell) : ''}</span>
                </span>
              }
            />
          </div>

          <section className={d.bell} aria-labelledby="demo-bell-h">
            <header className={s.cardHead}>
              <div>
                <span className={d.eyebrow}>What happens at the bell</span>
                <h2 className={s.cardTitle} id="demo-bell-h">
                  Ring the {nextBell ? `${etClock(nextBell)} ET` : 'next'} bell in the sandbox
                </h2>
              </div>
              <Status kind="demo" label="Simulated" bare />
            </header>

            <label className={d.moveRow}>
              <span className={d.moveLabel}>Where the mark is at the bell</span>
              <input
                type="range" min={-MOVE_LIMIT} max={MOVE_LIMIT} step={0.1} value={move}
                onChange={e => setMove(Number(e.target.value))}
                aria-valuetext={`${move > 0 ? '+' : ''}${move.toFixed(1)} percent`}
              />
              <span className={`num ${d.moveVal}`} data-sign={move > 0 ? 'pos' : move < 0 ? 'neg' : 'zero'}>
                {move > 0 ? '+' : move < 0 ? '−' : ''}{Math.abs(move).toFixed(1)}%
              </span>
            </label>
            <p className={d.moveNote}>
              {/* The exposed class wears the whole move since the last settled
                  bell, not just the slider's: say where that started. */}
              {lastUsd !== null && markUsd !== null && (
                <>The last bell settled at <span className="num">{fmtUsd(lastUsd)}</span>; the mark is at{' '}
                  <span className="num">{fmtUsd(markUsd)}</span> now, and at <span className="num">{fmtUsd(markUsd * (1 + move / 100))}</span> the
                  bell would settle a move of <b className="num">{((markUsd * (1 + move / 100)) / lastUsd * 100 - 100).toFixed(2)}%</b>. </>
              )}
              The class holding the stock wears that move; the parked class does not.
            </p>

            {preview ? (
              <div className={d.flip}>
                {(['day', 'night'] as Cls[]).map(k => {
                  const exposedNow = box.exposed === k;
                  const delta = preview.navAfter[k] / preview.navBefore[k] - 1;
                  return (
                    <div key={k} className={d.flipRow} data-cls={k}>
                      <ClassTag cls={k} active={exposedNow}>{k.toUpperCase()}</ClassTag>
                      <span className={d.flipNav}>
                        <span className="num">{preview.navBefore[k].toFixed(6)}</span>
                        <Icon name="chevronRight" size={12} aria-hidden="true" />
                        <span className="num">{preview.navAfter[k].toFixed(6)}</span>
                      </span>
                      <span className={`num ${d.flipDelta}`} data-sign={delta > 0.0000005 ? 'pos' : delta < -0.0000005 ? 'neg' : 'zero'}>
                        {delta > 0 ? '+' : delta < 0 ? '−' : ''}{Math.abs(delta * 100).toFixed(3)}%
                      </span>
                      <span className={d.flipRole}>{exposedNow ? 'wears the move, then goes to quote' : 'takes the stock'}</span>
                    </div>
                  );
                })}
              </div>
            ) : <p className={s.note}>The vault&rsquo;s mark is unavailable, so the sandbox cannot settle a bell.</p>}

            {preview && (
              <p className={d.fundLine}>
                {preview.funding !== 0
                  ? <>Funding: <b>{preview.funding > 0 ? 'NIGHT' : 'DAY'}</b> is the larger class and pays{' '}
                      <span className="num">{fmtUsd(Math.abs(preview.funding), 2)}</span> to {preview.funding > 0 ? 'DAY' : 'NIGHT'}.</>
                  : <>No funding at this bell — the classes are balanced, or one of them is empty.</>}
                {ch && (held.day > 0 || held.night > 0) && <> Your sandbox position goes from <span className="num">{fmtUsd(ch.before, 2)}</span> to <b className="num">{fmtUsd(ch.after, 2)}</b>.</>}
              </p>
            )}

            <div className={d.ringRow}>
              <Button onClick={ring} disabled={!preview || box.halted} tone={parked}>
                Ring the bell · {parked.toUpperCase()} takes the stock
              </Button>
              <span className={s.note}>Runs the program&rsquo;s <span className="mono">settle()</span> on the sandbox, then fills the handoff at the mark.</span>
            </div>
          </section>

          <Position
            names={engine.names} words={engine.words} held={engine.held} nav={engine.nav}
            exposed={box.exposed} event={false} preview={preview} bellAt={nextBell}
            empty={<>You hold nothing in the sandbox yet. <strong>{engine.names[parked]}</strong> is open — mint some, then ring the bell.</>}
          />

          <section className={s.card} aria-label="Sandbox activity">
            <header className={s.cardHead}>
              <h2 className={s.cardTitle}>Sandbox ledger</h2>
              <Status kind="demo" label="This page only" bare />
            </header>
            <LocalActivity history={box.history} stem={stem} />
          </section>
        </div>

        <aside className={s.side} aria-label="Trade">
          <TradeDock
            open={dock} onOpenChange={setDock} label={`Trade ${asset.symbol} in the demo`}
            bar={<><ClassTag cls={parked} active>{engine.words[parked]}</ClassTag><span>{engine.names[parked]} open · demo</span></>}
          >
            <TradePanel engine={engine} symbol={asset.symbol} name={asset.name} request={request} />
          </TradeDock>
          <section className={d.real} aria-label="Trade for real">
            <p className={d.realTitle}>Ready to do it on devnet?</p>
            <p className={d.realText}>
              Connect a wallet and mint {engine.names[parked]} from the live vault — test quote comes from the faucet on the
              vault page, so it costs nothing but a signature.
            </p>
            <Button block onClick={real}><Icon name="wallet" size={14} /> Connect wallet</Button>
          </section>
        </aside>
      </div>
    </div>
  );
}
