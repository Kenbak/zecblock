import { Component } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

class LocalBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() {
    // Do not emit decoded records or selectors to console/error telemetry.
  }
  render() {
    return this.state.failed ? <main className="max-w-7xl mx-auto px-4 py-12"><h1 className="text-lg font-semibold text-primary">Something went wrong</h1><p className="text-sm text-secondary mt-2" role="alert">This transaction could not be displayed. Reload the page to try again.</p></main> : this.props.children;
  }
}

const root = document.getElementById('app');
// No console reporting: an error object could carry decoded transaction data.
const quiet = () => {};
if (root) createRoot(root, { onCaughtError: quiet, onUncaughtError: quiet, onRecoverableError: quiet }).render(<LocalBoundary><App /></LocalBoundary>);
