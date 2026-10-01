import { Component, type ReactNode } from "react";
import { ErrorState } from "@/kit/states.tsx";
import { browser } from "@/lib/navigation.ts";

interface State {
  error: Error | null;
}

/** Last resort around the whole app: an error nothing else caught shows a message instead of a blank page. */
export class RootErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    // The browser console is the only sink in a static SPA; never log request data here.
    console.error("Unhandled error in the UI:", error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-dvh">
        <ErrorState
          error={this.state.error}
          title="Something went wrong"
          onRetry={() => browser.reload()}
        />
      </div>
    );
  }
}
