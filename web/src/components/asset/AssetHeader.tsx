/* The top of an instrument page: what this is, what it costs right now, and
 * what kind of vault stands behind it — said in badges, not paragraphs. */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Asset, Quote } from '@/lib/data';
import { useFavorites } from '@/lib/favorites';
import { AssetAvatar } from '../ui/Avatar';
import { Price, Delta } from '../ui/Figures';
import { Source } from '../ui/Source';
import { Icon } from '../ui/Icon';
import s from './Asset.module.css';

export function AssetHeader({ asset, quote, quoteSettled, badges, meta, actions }: {
  asset: Asset;
  quote: Quote | undefined;
  /** The first quote request has answered, either way. */
  quoteSettled: boolean;
  badges: ReactNode;
  /** One line of facts under the price: the vault address, boundaries settled. */
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  const [favs, toggle] = useFavorites();
  const fav = favs.has(asset.symbol);
  const price = quote?.price ?? asset.price;
  const change = quote?.change24h ?? asset.change24h;
  const age = quote ? Math.max(0, Math.floor(Date.now() / 1000) - quote.at) : null;

  return (
    <header className={s.header}>
      <nav className={s.crumbs} aria-label="Breadcrumb">
        <Link to="/markets">Markets</Link>
        <Icon name="chevronRight" size={12} aria-hidden="true" />
        <span className="mono" aria-current="page">{asset.symbol}</span>
      </nav>

      <div className={s.headRow}>
        <div className={s.identity}>
          <AssetAvatar symbol={asset.symbol} kind={asset.category} size="lg" />
          <div className={s.names}>
            <div className={s.titleLine}>
              <h1 className={`mono ${s.symbol}`}>{asset.symbol}</h1>
              <button type="button" className={s.star} data-on={fav || undefined} onClick={() => toggle(asset.symbol)}
                      aria-pressed={fav} aria-label={fav ? `Remove ${asset.symbol} from favorites` : `Add ${asset.symbol} to favorites`}>
                <Icon name="star" size={15} />
              </button>
            </div>
            <p className={s.name}>{asset.name}</p>
          </div>
        </div>

        <div className={s.quote}>
          <div className={s.priceLine}>
            <Price value={price} className={s.price} />
            <Delta value={change ?? null} flash className={s.change} title="Change over 24 hours" />
            <span className={s.changeLabel}>24h</span>
          </div>
          <div className={s.priceSrc}>
            {quote
              ? <Source kind="jupiter" detail={`${asset.symbol} on Jupiter, mainnet`} ageSec={age} staleAfter={120} />
              : quoteSettled
                ? <Source kind="study" detail="Last hourly close in the study snapshot — the live quote did not answer" />
                : <span className="skeleton" style={{ width: 70, height: 14 }} />}
            <span className={s.priceNote}>{quote ? 'the token, live' : quoteSettled ? 'last measured close' : 'reading the live price'}</span>
          </div>
        </div>
      </div>

      <div className={s.headFoot}>
        <div className={s.badges}>{badges}</div>
        {meta && <div className={s.meta}>{meta}</div>}
        {actions && <div className={s.actions}>{actions}</div>}
      </div>
    </header>
  );
}
