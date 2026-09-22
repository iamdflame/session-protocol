/* The button hierarchy.
 *
 * primary — the one action a screen exists for: Trade NVDA, Connect wallet,
 *           Mint NIGHT. Takes the tone of what it does: `day`, `night`, or
 *           neutral when the action belongs to neither class.
 * secondary — a real alternative: View market, Research.
 * tertiary — text-weight: Copy, View transaction, More.
 * destructive — only where something is actually given up: Disconnect.
 *
 * Loading keeps the label. A button that turns into a bare spinner hides the
 * one thing a person needs while they wait: what they are waiting for. */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import s from './Button.module.css';

type Variant = 'primary' | 'secondary' | 'tertiary' | 'destructive';
type Tone = 'neutral' | 'day' | 'night';

interface Common {
  variant?: Variant;
  tone?: Tone;
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
  loading?: boolean;
  /** Shown beside the label while loading, e.g. "Waiting for wallet…". */
  progress?: ReactNode;
  children: ReactNode;
  className?: string;
}

type ButtonProps = Common & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & { to?: undefined; href?: undefined };
type LinkProps = Common & { to: string; href?: undefined; onClick?: () => void; 'aria-label'?: string };
type AnchorProps = Common & { href: string; to?: undefined; onClick?: () => void; 'aria-label'?: string };

function classes(p: Common) {
  return [s.btn, s[p.variant ?? 'primary'], p.className].filter(Boolean).join(' ');
}
function body(p: Common) {
  return (
    <>
      {p.loading && <span className={s.spinner} aria-hidden="true" />}
      <span>{p.children}</span>
      {p.loading && p.progress && <span className={s.sub}>{p.progress}</span>}
    </>
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps | LinkProps | AnchorProps>(function Button(props, ref) {
  const { variant, tone = 'neutral', size = 'md', block, loading, progress, children, className, ...rest } = props as ButtonProps;
  const common = { variant, tone, size, block, loading, progress, children, className };
  const data = { 'data-tone': tone, 'data-size': size, 'data-block': block ? 'true' : undefined };

  if ('to' in props && props.to) {
    return <Link to={props.to} className={classes(common)} {...data} onClick={props.onClick} aria-label={props['aria-label']}>{body(common)}</Link>;
  }
  if ('href' in props && props.href) {
    return (
      <a href={props.href} className={classes(common)} {...data} target="_blank" rel="noreferrer"
         onClick={props.onClick} aria-label={props['aria-label']}>{body(common)}</a>
    );
  }
  return (
    <button ref={ref} type="button" className={classes(common)} {...data} aria-busy={loading || undefined} {...rest}>
      {body(common)}
    </button>
  );
});
