// ---------------------------------------------------------------------------
// Supabase client — the single source of the auth backend for the toolkit.
//
// This is one of the two sanctioned exceptions to the single-file architecture
// (the other is src/auth/AuthProvider.jsx) — same spirit as the shims in
// src/main.jsx: small, shared infrastructure that the app code leans on.
//
// Reads PUBLIC config from Vite env vars (must be VITE_-prefixed so Vite inlines
// them into the browser bundle at build time):
//   VITE_SUPABASE_URL       — your project URL (https://xxxx.supabase.co)
//   VITE_SUPABASE_ANON_KEY  — the "anon public" key (safe in the client; the real
//                             security boundary is Row Level Security on the DB)
//
// The Anthropic fetch shim in main.jsx only rewrites api.anthropic.com URLs, so
// Supabase calls to *.supabase.co pass through untouched.
// ---------------------------------------------------------------------------
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Surface a misconfigured deploy loudly instead of failing with a cryptic
// "supabaseUrl is required" deep inside the SDK.
export const supabaseConfigured = Boolean(url && anon);
if (!supabaseConfigured) {
  console.error(
    '[supabase] Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — ' +
      'auth is disabled. Copy .env.example to .env and fill them in.'
  );
}

// When env vars are absent we still construct a client with harmless placeholders
// so importing modules don't crash at load time; AuthProvider checks
// `supabaseConfigured` and shows a setup notice instead of attempting calls.
export const supabase = createClient(
  url || 'https://placeholder.supabase.co',
  anon || 'placeholder-anon-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
);
