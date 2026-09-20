import { Component, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import s from '@/styles/status.module.css';

interface Props { children: ReactNode }
interface State { error: Error | null }

/**
 * The last line before a white screen.
 *
 * A market interface that crashes silently is worse than one that says so: a
 * holder needs to know whether what they are looking at is stale. So this names
 * the failure, offers the way back, and keeps the detail available rather than
 * swallowing it.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Left visible on purpose — a stack in the console is how this gets fixed.
    console.error('[session] render failed', error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className={`shell ${s.wrap}`}>
        <p className="eyebrow">Something broke</p>
        <h1 className={`display ${s.title}`}>This view stopped updating.</h1>
        <p className={`lead ${s.body}`}>
          Rather than show you numbers that may no longer be true, it stopped.
          Reloading usually clears it. Nothing on-chain is affected — this page
          only reads.
        </p>
        <div className={s.actions}>
          <button className={s.primary} onClick={() => window.location.reload()}>
            Reload
          </button>
          <Link to="/" className={s.secondary}>Back to the start</Link>
        </div>
        <details className={s.details}>
          <summary>Technical detail</summary>
          <pre className="mono">{error.message}</pre>
        </details>
      </div>
    );
  }
}
