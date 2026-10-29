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
    return this.state.failed ? <main className="private-shell private-main"><h1>Private transaction explorer</h1><p className="private-error" role="alert">This record could not be rendered safely. Reload the local prototype to restart. No public lookup was attempted.</p></main> : this.props.children;
  }
}

const root = document.getElementById('app');
if (root) createRoot(root).render(<LocalBoundary><App /></LocalBoundary>);
