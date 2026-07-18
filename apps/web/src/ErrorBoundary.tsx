import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Keeps a throw in any component from taking the whole page down.
 *
 * Without this, React unmounts the entire tree on the first render error: the screen
 * goes BLANK, no nav, nothing — indistinguishable from a site that is down. Not
 * hypothetical: this is exactly how the NamesResponse bug showed up. `truncateCid`
 * got undefined, blew up on `.length`, and the user who had just bought a name lost
 * the site — not the card, the site.
 *
 * The bug was fixed; the fragility that turned it into an outage was not. A render
 * error should cost the section where it happened, not the application.
 *
 * Only a class can do this — there is no hook equivalent to componentDidCatch. This
 * is the project's only class component, and that is why.
 */

interface Props {
  children: ReactNode;
  /** Section name, shown to the user. Helps tell "the card broke" from "the site broke". */
  section?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Goes to the browser console and, in production, to Workers Analytics via the
    // Pages/Worker's own error reporting. We do not ship it anywhere ourselves: that
    // would be the product's first piece of telemetry, and that decision does not get
    // made inside a catch.
    console.error(`[wget.club] error in ${this.props.section ?? 'app'}:`, error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <section className="panel" role="alert">
        <p className="msg msg--err">
          Something broke {this.props.section ? `in "${this.props.section}"` : 'on this screen'}.
        </p>
        <p className="muted small">
          The error is ours, not yours. Your names are NFTs on Base — they do not depend on
          this site to exist, and nothing was lost.
        </p>
        <pre className="src" style={{ maxHeight: '8rem' }}>
          {error.message}
        </pre>
        <div className="row">
          <button type="button" className="btn btn--ghost" onClick={this.reset}>
            try again
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => window.location.reload()}>
            reload
          </button>
        </div>
      </section>
    );
  }
}
