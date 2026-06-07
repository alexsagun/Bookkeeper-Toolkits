import React from 'react';
import { createRoot } from 'react-dom/client';
import BookkeeperProToolkit from './BookkeeperPro.jsx';

// ---------------------------------------------------------------------------
// Adapters — these let the unchanged artifact component run in a normal browser.
// ---------------------------------------------------------------------------

// 1) window.storage shim
//    The component persists state (sidebar layout, currency prefs, trackers, etc.)
//    via a Claude-artifact API: `await window.storage.get(key)` returns `{ value }`
//    and `await window.storage.set(key, value)` saves. Map both onto localStorage.
if (typeof window !== 'undefined' && !window.storage) {
  window.storage = {
    get: async (key) => {
      try {
        return { value: localStorage.getItem(key) };
      } catch {
        return { value: null };
      }
    },
    set: async (key, value) => {
      try {
        localStorage.setItem(key, value);
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
    <BookkeeperProToolkit />
  </React.StrictMode>
);
