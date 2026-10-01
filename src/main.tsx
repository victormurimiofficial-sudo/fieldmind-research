import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('FieldMind render error:', error);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#f5f6f3', color: '#26322b', fontFamily: 'Inter, system-ui, sans-serif' }}>
          <div style={{ width: 'min(620px, 100%)', padding: 28, border: '1px solid #e0e5df', borderRadius: 18, background: '#fff', boxShadow: '0 18px 55px rgba(20,30,24,.08)' }}>
            <strong style={{ display: 'block', fontSize: 19, marginBottom: 8 }}>FieldMind could not start</strong>
            <p style={{ margin: 0, color: '#758078', fontSize: 13, lineHeight: 1.6 }}>
              The deployment loaded, but the application hit a browser error. Refresh once; if it remains, send this message to the developer.
            </p>
            <pre style={{ marginTop: 16, padding: 12, overflow: 'auto', borderRadius: 10, background: '#fff6f6', border: '1px solid #ead7d7', color: '#8b6262', fontSize: 11, whiteSpace: 'pre-wrap' }}>
              {this.state.error.message}
            </pre>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>
);
