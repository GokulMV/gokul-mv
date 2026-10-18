import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches a render-time failure in its subtree (the WebGL layer: renderer
 * creation, a lost context, a shader that cannot compile) and shows
 * `fallback` instead of unmounting the whole page.
 */
export class ErrorBoundary extends Component<
  { fallback: ReactNode; onError?: (error: unknown) => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.warn('[ErrorBoundary] the 3D layer failed; showing the fallback.', error, info.componentStack);
    this.props.onError?.(error);
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export default ErrorBoundary;
