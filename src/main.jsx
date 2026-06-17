import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';                 // Tailwind (compiled via PostCSS) — replaces the old CDN <script>
import BookkeeperProToolkit from './BookkeeperPro.jsx';
import { AuthProvider } from './auth/AuthProvider.jsx';

// ---------------------------------------------------------------------------
// Adapters — these let the unchanged artifact component run in a normal browser.
// ---------------------------------------------------------------------------

// 1) window.storage shim  (now per-user namespaced)
//    The component persists state (sidebar layout, currency prefs, trackers, etc.)
//    via a Claude-artifact API: `await window.storage.get(key)` returns `{ value }`
//    and `await window.storage.set(key, value)` saves. Map both onto localStorage.
//
//    Keys are namespaced per signed-in user: `window.__setStorageUser(uid)` (called
//    by src/auth/AuthProvider.jsx on every session change) makes every get/set read
//    and write `u:<uid>:<key>` instead of the bare key. This isolates each account's
//    data with ZERO changes to the ~60 tools — they still call window.storage with
//    plain keys. When no user is set, keys fall back to their bare (legacy) form.
//
//    NOTE: Supabase stores its own session under an `sb-*` localStorage key written
//    directly by supabase-js (it bypasses window.storage), so it is never namespaced
//    here and is unaffected.
if (typeof window !== 'undefined' && !window.storage) {
  let storageUid = null;
  const nsKey = (key) => (storageUid ? `u:${storageUid}:${key}` : key);

  // Called by AuthProvider whenever the signed-in user changes (or null on sign-out).
  window.__setStorageUser = (uid) => {
    storageUid = uid || null;
  };

  window.storage = {
    get: async (key) => {
      try {
        return { value: localStorage.getItem(nsKey(key)) };
      } catch {
        return { value: null };
      }
    },
    set: async (key, value) => {
      try {
        localStorage.setItem(nsKey(key), value);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// 2) Anthropic fetch shim
//    The component calls `https://api.anthropic.com/v1/messages` directly with no
//    API key. Rewrite those absolute URLs to the Vite dev proxy (`/api/anthropic`),
//    which injects `x-api-key` + `anthropic-version` server-side. The key never
//    reaches the browser, and there's no CORS problem.
if (typeof window !== 'undefined' && !window.__anthropicFetchPatched) {
  const ORIGIN = 'https://api.anthropic.com';
  const PROXY = '/api/anthropic';
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith(ORIGIN)) {
      input = input.replace(ORIGIN, PROXY);
    } else if (input instanceof Request && input.url.startsWith(ORIGIN)) {
      input = new Request(input.url.replace(ORIGIN, PROXY), input);
    }
    return realFetch(input, init);
  };
  window.__anthropicFetchPatched = true;
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <BookkeeperProToolkit />
    </AuthProvider>
  </React.StrictMode>
);
