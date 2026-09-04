// ─────────────────────────────────────────────────────────────────────────────
// AppErrorBoundary.jsx — the app's only React error boundary.
// ─────────────────────────────────────────────────────────────────────────────
// Until this existed, ANY uncaught render error unmounted the whole tree and left
// #root empty: a blank white page, no message, no recovery, nothing in the UI to
// tell you what happened. That is not hypothetical — a null `entitlement` reached
// `entitlement.allowsTab('community')` in the root component body and blanked
// production for the account that owns the product. The owner found it by opening
// DevTools.
//
// ★ IT IMPORTS NOTHING FROM BookkeeperPro.jsx, AND THAT IS THE POINT. Pulling in
//   the 35k-line monolith would mean the safety net shares every module-scope
//   hazard of the thing it is catching. It uses only React, the shared classes
//   already loaded from src/index.css, and the logo from /public. The one other
//   import is the Supabase client, so "Sign out" can actually clear the session
//   that may be what is wedged.
//
// ★ ONE BOUNDARY, AT THE ROOT — do NOT add per-TabPanel boundaries. TabPanel and
//   RestrictedTab each apply `hidden={!active}` to their OWN root div, so a
//   boundary wrapping one of them replaces that div when it catches and the
//   fallback loses `hidden` — a crashed BACKGROUND tab would then paint its error
//   card over the tab you are actually looking at.
import React from 'react';
import { supabase } from './lib/supabase';

const wrap = {
  minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 24, boxSizing: 'border-box',
  fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  // backgroundColor, NOT the `background` shorthand: .gh-app-bg paints its identity
  // through five stacked gradients in background-image, and the shorthand resets those.
  color: 'var(--c-text)', backgroundColor: 'var(--c-bg)',
};
const card = {
  width: '100%', maxWidth: 480, borderRadius: 20, padding: '32px 28px', textAlign: 'center',
  background: 'var(--glass-card)',
  border: '1px solid var(--glass-border)',
  boxShadow: '0 18px 48px rgba(15,23,42,0.12)',
};
const btn = {
  appearance: 'none', border: '1px solid transparent', borderRadius: 12, cursor: 'pointer',
  padding: '10px 18px', fontSize: 14, fontWeight: 600, fontFamily: 'inherit',
};

export default class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Stable prefix so this is greppable in a screenshot of the console.
    console.error('[app-error] render crashed', error, info?.componentStack);
    this.setState({ info });
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    const detail = [
      String(error?.stack || error?.message || error),
      info?.componentStack ? `\nComponent stack:${info.componentStack}` : '',
    ].join('');

    return (
      <div style={wrap} className="gh-app-bg">
        <div style={card}>
          <img
            src="/logo-alex.png"
            alt=""
            style={{ width: 56, height: 56, objectFit: 'contain', filter: 'drop-shadow(0 6px 18px rgba(10,132,255,0.22))' }}
          />
          <h1 style={{ margin: '18px 0 0', fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em' }}>
            Something went wrong
          </h1>
          <p style={{ margin: '10px 0 0', fontSize: 13.5, lineHeight: 1.6, color: 'var(--c-text-soft)' }}>
            The app hit an unexpected error and stopped rendering. Your work and your
            membership are unaffected — reloading usually clears it.
          </p>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 22, flexWrap: 'wrap' }}>
            <button
              type="button"
              style={{ ...btn, background: 'var(--primary-solid)', color: '#fff' }}
              onClick={() => window.location.reload()}
            >
              Reload the app
            </button>
            <button
              type="button"
              style={{ ...btn, background: 'transparent', borderColor: 'var(--glass-border)', color: 'var(--c-text)' }}
              onClick={async () => {
                // Best effort: a wedged session is one of the things that can put
                // the app in an unrenderable state, so never block the redirect on it.
                try { await supabase.auth.signOut(); } catch { /* non-fatal */ }
                window.location.replace('/');
              }}
            >
              Sign out
            </button>
          </div>

          <details style={{ marginTop: 20, textAlign: 'left' }}>
            <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--c-text-soft)' }}>
              Technical details
            </summary>
            <pre
              style={{
                marginTop: 10, padding: 12, borderRadius: 10, maxHeight: 220, overflow: 'auto',
                fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                background: 'var(--wash)', color: 'var(--c-text-soft)',
              }}
            >
              {detail}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
