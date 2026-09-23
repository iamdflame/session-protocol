/* DAY against NIGHT, as two numbers a holder acts on: what the next bell will
 * charge between them, and how much more one moves than the other. Funding is
 * computed from the vault's own class values; the risk figures are the
 * study's measured per-session volatility for this asset. */
import type { Asset } from '@/lib/data';
import { FundingRate, type FundingInput } from '../FundingRate';
import { Source } from '../ui/Source';
import s from './Asset.module.css';

export function Compare({ asset, funding, event }: { asset: Asset; funding: FundingInput; event: boolean }) {
  const d = asset.day?.stdev ?? null;
  const n = asset.night?.stdev ?? null;
  const max = Math.max(d ?? 0, n ?? 0) || 1;
  const ratio = d && n ? n / d - 1 : null;
  return (
    <section className={s.compare} aria-label="DAY and NIGHT compared">
      <div><FundingRate f={funding} /></div>
      <div>
        <span className={s.riskLabel}>Risk · σ per session</span>
        {d !== null && n !== null ? (
          <>
            <div className={s.riskBars}>
              {([['day', d], ['night', n]] as const).map(([cls, v]) => (
                <div key={cls} className={s.riskRow} data-cls={cls}>
                  <b>{cls.toUpperCase()}</b>
                  <span className={s.riskBar} style={{ width: `${(v / max) * 100}%` }} aria-hidden="true" />
                  <span className="num">{(v * 100).toFixed(2)}%</span>
                </div>
              ))}
            </div>
            <p className={s.riskNote}>
              {event
                ? <>Measured on {asset.symbol}&rsquo;s pool cut by NYSE hours — a control for this vault, not its rule.</>
                : ratio !== null && ratio > 0
                  ? <>NIGHT moves <strong>{(ratio * 100).toFixed(0)}% more</strong> per session: it carries the overnight gap.</>
                  : <>DAY moves {Math.abs((ratio ?? 0) * 100).toFixed(0)}% more per session here.</>}
              {' '}<Source kind="study" detail={`Hourly closes, ${Math.round(asset.days)} days`} />
            </p>
          </>
        ) : <p className={s.riskNote}>Not enough history to measure.</p>}
      </div>
    </section>
  );
}
