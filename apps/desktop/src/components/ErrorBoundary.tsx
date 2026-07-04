import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** Top-level render-crash guard for the whole shell. Deliberately does not
 * log anything itself (see engineClient.ts's no-content-logging note) —
 * `componentDidCatch` is unused on purpose; the caught error's message is
 * rendered inline instead of printed anywhere. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Intentionally empty: React's own dev-mode overlay/console reporting
    // already surfaces crashes during development; this class only needs
    // to update state (via getDerivedStateFromError) to swap in the
    // fallback UI. Nothing here should ever call console.* — see
    // engineClient.ts's no-content-logging note.
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <div className="error-boundary" role="alert">
          <h2>Something went wrong</h2>
          <p>{error.message}</p>
          <button type="button" onClick={this.handleReset}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
