// ---------------------------------------------------------------------------
// AuthProvider — app-wide authentication context backed by Supabase.
//
// Sanctioned exception to the single-file architecture (see src/lib/supabase.js).
// Wraps <BookkeeperProToolkit/> in main.jsx. Any component reads auth state via
// the useAuth() hook:
//
//   const { session, user, profile, loading, profileReady, recovery, configured,
//           signUp, signIn, signInWithGoogle, signOut, resetPassword,
//           resendConfirmation, updatePassword, clearRecovery, refreshProfile } = useAuth();
//
// Responsibilities:
//  1. Track the Supabase session (initial load + live changes), and server-validate
//     the cached session so deleted/disabled accounts are signed out (not left stale).
//  2. Load the user's `profiles` row (carries is_paid / plan for the Phase-2 gate, and
//     approval_status / rejection_reason for the temporary admin-approval gate). Expose
//     `profileReady` (have we finished the first fetch for this user?) so the app shell is
//     never flashed before approval status is known, and `refreshProfile()` so the pending
//     screen can poll for an admin's decision.
//  3. Point the per-user storage namespace at the current uid BEFORE the
//     authenticated shell renders (window.__setStorageUser, installed in main.jsx).
//  4. One-time adopt any pre-auth ("legacy") global localStorage data into the
//     first signed-in user's namespace.
// ---------------------------------------------------------------------------
import React, { createContext, useContext, useEffect, useState } from 'react';
import { supabase, supabaseConfigured } from '../lib/supabase';

const AuthContext = createContext(null);

export const useAuth = () => useContext(AuthContext);

// Canonical inventory of the app's pre-auth global storage keys. Keep in sync
// when a tool introduces a new persisted key (see bookkeeper-conventions skill).
const LEGACY_KEYS = [
  'currency:pref', 'currency:rate',
  'sidebar:stages', 'sidebar:collapsed', 'sidebar:expandedGroups', 'sidebar:version', 'sidebar:railCollapsed',
  'certs:completed', 'certs:inProgress',
  'health:clients',
  'timetrack:entries', 'timetrack:clients', 'timetrack:rates',
  'capacity:clients', 'capacity:targets',
  'payments:invoices',
  'persfin:transactions',
  'qbdiag:name', 'qbdiag:firm', 'qbdiag:email',
  'budget:state', 'forecast:state',
  'nav:lastTab', 'nav:interviewSub',
];

// Marker (raw, un-namespaced) recording which uid adopted the legacy global data.
// Ensures the migration runs exactly once and never leaks the first user's data
// to a second account on a shared browser.
const LEGACY_MARKER = 'auth:legacyMigratedTo';
// Preferred column set. Degrades gracefully on a not-yet-migrated project: first drop the
// approval columns (added by db/2026-06-29-user-approval.sql), then drop is_admin/avatar_url
// (added by COURSE_SETUP.md). This ordering means a project missing ONLY the approval columns
// still keeps is_admin — so the admin never loses their controls in the window between deploy
// and running the migration, and the approval gate simply stays inert (no approval_status).
const PROFILE_SELECT = 'id,email,full_name,avatar_url,is_paid,plan,is_admin,approval_status,rejection_reason';
const PROFILE_SELECT_NO_APPROVAL = 'id,email,full_name,avatar_url,is_paid,plan,is_admin';
const PROFILE_SELECT_LEGACY = 'id,email,full_name,avatar_url,is_paid,plan';

// A PostgREST "column / schema cache" error — i.e. the requested column doesn't exist yet on
// this project — so we should retry with a smaller column set rather than treat it as fatal.
function isMissingColumnError(error) {
  return Boolean(
    error &&
      (error.code === 'PGRST204' ||
        /approval_status|rejection_reason|is_admin|avatar_url|schema cache|column/i.test(error.message || ''))
  );
}

// Fetch the profile row, narrowing the column list on each missing-column error so a
// partially-migrated `profiles` table degrades instead of failing outright.
async function fetchProfileRow(uid) {
  for (const cols of [PROFILE_SELECT, PROFILE_SELECT_NO_APPROVAL, PROFILE_SELECT_LEGACY]) {
    const { data, error } = await supabase.from('profiles').select(cols).eq('id', uid).single();
    if (!error) return { data, error: null };
    if (!isMissingColumnError(error)) return { data: null, error }; // genuine failure — stop retrying
  }
  // Even the legacy set failed with a column error (shouldn't happen) — report the last attempt.
  const { data, error } = await supabase.from('profiles').select(PROFILE_SELECT_LEGACY).eq('id', uid).single();
  return { data: data ?? null, error };
}

function migrateLegacyData(uid) {
  if (typeof window === 'undefined' || !uid) return;
  try {
    if (localStorage.getItem(LEGACY_MARKER)) return; // already handled (any user)
    localStorage.setItem(LEGACY_MARKER, uid);
    for (const key of LEGACY_KEYS) {
      const legacyVal = localStorage.getItem(key);
      if (legacyVal == null) continue;
      const nsKey = `u:${uid}:${key}`;
      if (localStorage.getItem(nsKey) == null) {
        localStorage.setItem(nsKey, legacyVal); // copy (leave original in place)
      }
    }
  } catch {
    /* localStorage unavailable — non-fatal */
  }
}

// Point the storage namespace at this uid. Synchronous + done before the
// authenticated shell renders, so the first tool mount reads the right keys.
function applyStorageUser(uid) {
  if (typeof window !== 'undefined' && typeof window.__setStorageUser === 'function') {
    window.__setStorageUser(uid || null);
  }
  if (uid) migrateLegacyData(uid);
}

// Ask the auth server whether the cached session's account still exists/valid.
// getUser() hits the server (unlike getSession(), which only reads localStorage),
// so it detects a deleted/disabled account. Returns true ONLY on a definitive auth
// rejection (401/403); network/other failures return false so we fail open and
// don't sign out an offline user who is actually still valid.
async function accountRevoked() {
  try {
    const { error } = await supabase.auth.getUser();
    return Boolean(error && (error.status === 401 || error.status === 403));
  } catch {
    return false;
  }
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  // The uid we've finished a profile fetch for. Lets the gate wait for the first fetch
  // (so a pending user never briefly sees the dashboard) without an extra loading flag —
  // and stays set across refreshProfile() refetches (profile is non-null then, so no flash).
  const [profileFetchedFor, setProfileFetchedFor] = useState(null);
  const [loading, setLoading] = useState(true);
  // True after the user returns from a password-reset email link, until they set
  // a new password. The reset link signs them in with a recovery session, so the
  // app must show a "set new password" screen instead of the toolkit (see the gate).
  const [recovery, setRecovery] = useState(false);

  // Track session: initial fetch (server-validated) + live subscription.
  useEffect(() => {
    if (!supabaseConfigured) {
      setLoading(false);
      return;
    }
    let mounted = true;

    (async () => {
      const { data } = await supabase.auth.getSession();
      let valid = data.session ?? null;
      // getSession() only reads the locally-cached token — a deleted/disabled
      // account still looks "logged in". Re-check against the auth server and drop
      // the session if the account is truly gone (401/403). Any other failure
      // (network/5xx) fails open so an offline user with a valid account stays in.
      if (valid && (await accountRevoked())) {
        await supabase.auth.signOut();
        valid = null;
      }
      if (!mounted) return;
      applyStorageUser(valid?.user?.id ?? null);
      setSession(valid);
      setLoading(false);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((event, nextSession) => {
      applyStorageUser(nextSession?.user?.id ?? null);
      setSession(nextSession ?? null);
      // The reset-link return fires PASSWORD_RECOVERY with a live session — flag it
      // so the gate routes to UpdatePasswordScreen rather than the authenticated app.
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  // Re-validate when the user returns to the tab, so a mid-session account deletion
  // signs them out promptly instead of waiting for the next token refresh (~1h).
  useEffect(() => {
    if (!supabaseConfigured) return;
    const onVisible = async () => {
      if (document.visibilityState !== 'visible') return;
      const { data } = await supabase.auth.getSession();
      if (data.session && (await accountRevoked())) await supabase.auth.signOut();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Load the profile row whenever the signed-in user changes.
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) {
      setProfile(null);
      setProfileFetchedFor(null);
      return;
    }
    let active = true;
    (async () => {
      const { data, error } = await fetchProfileRow(uid);
      if (!active) return;
      if (error) console.error('[auth] profile fetch failed:', error.message);
      setProfile(data ?? null);
      setProfileFetchedFor(uid); // mark "first fetch done" even on error (fail open, don't hang the gate)
    })();
    return () => {
      active = false;
    };
  }, [session?.user?.id]);

  // Re-read the profile on demand (e.g. the Pending Approval screen's "Check status" button /
  // poll). Keeps profileFetchedFor unchanged (same uid), so the existing profile stays visible
  // and the gate doesn't flash a splash while refreshing.
  async function refreshProfile() {
    const uid = session?.user?.id;
    if (!uid) return null;
    const { data, error } = await fetchProfileRow(uid);
    if (error) {
      console.error('[auth] profile refresh failed:', error.message);
      return null;
    }
    setProfile(data ?? null);
    return data ?? null;
  }

  const value = {
    session,
    user: session?.user ?? null,
    profile,
    loading,
    // True once the first profile fetch for the current user has settled (or there's no user).
    // The gate waits on this so it never renders the app/approval screens with a stale null profile.
    profileReady: !session?.user || profileFetchedFor === session?.user?.id,
    refreshProfile,
    recovery,
    configured: supabaseConfigured,
    signUp: (email, password, fullName) =>
      supabase.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: fullName },
          // Confirmation link returns to wherever they signed up (dev or prod),
          // not just the dashboard Site URL.
          emailRedirectTo: typeof window !== 'undefined' ? window.location.origin : undefined,
        },
      }),
    signIn: (email, password) =>
      supabase.auth.signInWithPassword({ email, password }),
    // Re-send the signup confirmation email (for users who lost or never got it).
    resendConfirmation: (email) =>
      supabase.auth.resend({
        type: 'signup',
        email,
        options: {
          emailRedirectTo: typeof window !== 'undefined' ? window.location.origin : undefined,
        },
      }),
    // One-click Google OAuth. The full-page redirect returns to the app, where the
    // client's detectSessionInUrl handling completes sign-in (no main.jsx shim needed).
    signInWithGoogle: () =>
      supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: typeof window !== 'undefined' ? window.location.origin : undefined,
        },
      }),
    signOut: () => supabase.auth.signOut(),
    resetPassword: (email) =>
      supabase.auth.resetPasswordForEmail(email, {
        redirectTo: typeof window !== 'undefined' ? window.location.origin : undefined,
      }),
    // Set a new password during a recovery session, then leave recovery mode so the
    // authenticated app renders (the user is already signed in via the reset link).
    updatePassword: (password) => supabase.auth.updateUser({ password }),
    clearRecovery: () => setRecovery(false),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
