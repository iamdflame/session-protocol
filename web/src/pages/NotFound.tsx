import { Link } from 'react-router-dom';
import { Mark } from '@/components/Mark';
import s from '@/styles/status.module.css';

export default function NotFound() {
  return (
    <div className={`shell ${s.wrap}`}>
      <Mark size={40} />
      <p className="eyebrow">404</p>
      <h1 className={`display ${s.title}`}>This page is closed.</h1>
      <p className={`lead ${s.body}`}>
        Unlike the market, it isn&rsquo;t reopening at 09:30. Head back to the
        markets, or read how the split works.
      </p>
      <div className={s.actions}>
        <Link to="/markets" className={s.primary}>View markets</Link>
        <Link to="/how-it-works" className={s.secondary}>How it works</Link>
      </div>
    </div>
  );
}
