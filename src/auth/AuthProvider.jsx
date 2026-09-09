// ---------------------------------------------------------------------------
// AuthProvider — app-wide authentication context backed by Supabase.
//
// Sanctioned exception to the single-file architecture (see src/lib/supabase.js).
// Wraps <BookkeeperProToolkit/> in main.jsx. Any component reads auth state via
// the useAuth() hook:
//
//   const { session, user, profile, loading, profileReady, recovery, configured,
//           signUp, signIn, signInWithGoogle, signOut, resetPassword,
//           resendConfirmation, updatePassword, clearRecovery, refreshProfile,
//           staff, staffReady, staffDegraded, staffMissing, staffMembership,
//           isSuperAdmin, can, refreshStaff } = useAuth();
//
// STAFF AUTHORITY (#45). `can('enrollments.review')` is the one predicate admin
// surfaces should ask; `profile.is_admin` now means "active Super Admin" and
// nothing else. `staff` is the normalized context from my_staff_context(), read
// live from the database on every session change rather than decoded from a JWT
// claim — which is why suspending a staff member takes effect on their next
// request instead of on their next token refresh. Both start EMPTY and stay EMPTY
// unless the server says otherwise: absent permission data means "no", not "yes".
// Wait on `staffReady` before rendering anything privileged, the same way the gate
// waits on `profileReady`.
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
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, supabaseConfigured } from '../lib/supabase';
import {
  EMPTY_STAFF_CONTEXT, EMPTY_STAFF_MEMBERSHIP, staffCan, staffContextFromRpc,
} from '../lib/staffRoles.js';

const AuthContext = createContext(null);

export const useAuth = () => useContext(AuthContext);

// Canonical inventory of the app's pre-auth global storage keys. Keep in sync
// when a tool introduces a new persisted key (see bookkeeper-conventions skill).
const LEGACY_KEYS = [
  'currency:pref', 'currency:rate',
  'sidebar:stages', 'sidebar:collapsed', 'sidebar:expandedGroups', 'sidebar:version', 'sidebar:railCollapsed',
  'certs:completed', 'certs:inProgress',
  'health:clients',
  'monthend:checked', 'yearend:checked',
  'onboarding:welcomed',
  'timetrack:entries', 'timetrack:clients', 'timetrack:rates',
  'capacity:clients', 'capacity:targets',
  'payments:invoices',
  'persfin:transactions',
  'qbdiag:name', 'qbdiag:firm', 'qbdiag:email',
  // 'nav:lastTab' was retired when "/" became unconditionally the Dashboard — it
  // has no reader and no writer, so migrating it would adopt a dead key.
  'nav:interviewSub',
  // Portfolio Generator draft. Listed per the standing rule ("add to it whenever a
  // tool introduces a new persisted key"), though it is a RULE-COMPLIANCE entry
  // rather than a live migration: the tool shipped after the auth gate, so no
  // un-namespaced copy of this key can exist and the loop below always skips it.
  'portfolio:draft:v1',
  'enroll:soundAlert',
  'community:lastSpace', 'community:lastChannel', 'community:railGroups',
  // Theme pref. Note: useTheme also keeps a BARE localStorage mirror of this key
  // on every change (for the index.html no-flash boot script + signed-out screens),
  // and adopts the bare value into a signed-in account with no saved pref itself —
  // this migration entry only covers the classic first-login path.
  'ui:theme',
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
// account_origin/onboarding_status drive the imported-student forced set-password gate
// (db #26). They're only in the PRIMARY select — on a pre-#26 project the missing-column
// fallback drops to PROFILE_SELECT_NO_APPROVAL (which lacks them), so the gate simply never
// triggers (profile.account_origin is undefined → treated as a normal signup). Safe degrade.
const PROFILE_SELECT = 'id,email,full_name,avatar_url,is_paid,plan,is_admin,approval_status,rejection_reason,account_origin,onboarding_status';
// Approval columns present but the #26 onboarding columns absent (the deploy-before-migrate
// window on an already-approval/enrollment DB) — keep approval_status, drop only onboarding.
const PROFILE_SELECT_NO_ONBOARDING = 'id,email,full_name,avatar_url,is_paid,plan,is_admin,approval_status,rejection_reason';
const PROFILE_SELECT_NO_APPROVAL = 'id,email,full_name,avatar_url,is_paid,plan,is_admin';
const PROFILE_SELECT_LEGACY = 'id,email,full_name,avatar_url,is_paid,plan';

// A PostgREST "column / schema cache" error — i.e. the requested column doesn't exist yet on
// this project — so we should retry with a smaller column set rather than treat it as fatal.
function isMissingColumnError(error) {
  return Boolean(
    error &&
      (error.code === 'PGRST204' ||
        /approval_status|rejection_reason|is_admin|avatar_url|account_origin|onboarding_status|schema cache|column/i.test(error.message || ''))
  );
}

// Fetch the profile row, narrowing the column list on each missing-column error so a
// partially-migrated `profiles` table degrades instead of failing outright.
async function fetchProfileRow(uid) {
  for (const cols of [PROFILE_SELECT, PROFILE_SELECT_NO_ONBOARDING, PROFILE_SELECT_NO_APPROVAL, PROFILE_SELECT_LEGACY]) {
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

// Race a promise against a fail-open timeout. supabase-js calls reject on network
// errors but can also simply never settle when the endpoint stalls — and `loading`
// (the full-app splash) waits on the session + revoke verdict, so an unsettled auth
// call would strand the whole app on AuthSplash. Mirrors the profile-fetch (8s) and
// enrollment-gate (7s) fail-open idiom.
const AUTH_CALL_TIMEOUT_MS = 8000;
// How often to re-attempt a profile read that failed. Slow on purpose: the focus /
// visibilitychange listeners carry the common case (the user comes back and it just
// works), and this is only the backstop for a tab left open on a dead connection.
const PROFILE_RETRY_MS = 15000;
const withTimeout = (promise, ms, fallback) =>
  Promise.race([promise, new Promise((res) => setTimeout(() => res(fallback), ms))]);

// Ask the auth server whether the cached session's account still exists/valid.
// getUser() hits the server (unlike getSession(), which only reads localStorage),
// so it detects a deleted/disabled account. Returns true ONLY on a definitive auth
// rejection (401/403); network/other failures — including a stalled endpoint (the
// timeout resolves to a no-error fallback) — return false so we fail open and
// don't sign out an offline user who is actually still valid.
/**
 * Ask the database who the caller is allowed to be. (#45)
 *
 * Raced against the same 8s fail-open timeout as the session and profile calls,
 * for the same reason: a stalled endpoint must not strand the app. Note what
 * "fail open" means here — the CALL gives up, and staffContextFromRpc() resolves
 * the result to the EMPTY context. Availability fails open; authority never does.
 */
async function fetchStaffContext() {
  if (!supabaseConfigured) return { context: EMPTY_STAFF_CONTEXT, degraded: false, missing: false };
  const TIMEOUT = { data: null, error: new Error('staff context fetch timed out (8s)') };
  try {
    const res = await withTimeout(supabase.rpc('my_staff_context'), AUTH_CALL_TIMEOUT_MS, TIMEOUT);
    return staffContextFromRpc(res);
  } catch (e) {
    return staffContextFromRpc({ data: null, error: e });
  }
}

async function accountRevoked() {
  try {
    const { error } = await withTimeout(supabase.auth.getUser(), AUTH_CALL_TIMEOUT_MS, { error: null });
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
  // ★ "The fetch FAILED" is NOT the same fact as "this account has no profile row",
  //   and conflating them is how the owner of the product got shown its pricing page.
  //   The fetch below deliberately fails OPEN (profile=null, profileFetchedFor=uid) so
  //   the gate can never hang — but every membership fact downstream is then read off a
  //   profile we could not read, and enrollGateState() bottoms out at 'paywall'. This
  //   flag lets the gate tell the two apart and hold instead of quoting a price.
  //   It grants nothing; authority still fails closed.
  const [profileFailed, setProfileFailed] = useState(false);
  // The LIVE signed-in uid, for async writes that must not land after a session
  // change. refreshProfile() closes over `session` from its own render, so it
  // cannot detect a sign-out that happened while its request was in flight — see
  // the guard in refreshProfile() for why that suddenly matters.
  const uidRef = useRef(null);
  const [loading, setLoading] = useState(true);
  // Staff authority (#45). Starts EMPTY and stays EMPTY unless the server says
  // otherwise — absent permission data means "no", never "yes".
  const [staff, setStaff] = useState(EMPTY_STAFF_CONTEXT);
  const [staffFetchedFor, setStaffFetchedFor] = useState(null);
  // True when we could not reach my_staff_context() at all. Lets an admin screen
  // show setup guidance instead of pretending the account simply has no role.
  const [staffDegraded, setStaffDegraded] = useState(false);
  // ★ NARROWER, and the distinction is load-bearing: `missing` means the function
  //   is not in this database (a pre-#45 install), which is ACTIONABLE — run the
  //   migration. `degraded` also covers a timeout or a network blip, which is
  //   TRANSIENT — retry. staffContextFromRpc() has always told the two apart;
  //   until now this provider threw that apart away, so a dropped packet and an
  //   un-migrated database produced the same screen. A caller that knows the model
  //   is absent can also skip a request that cannot possibly succeed, which is
  //   what was turning "not installed yet" into a 500 in the console.
  const [staffMissing, setStaffMissing] = useState(false);
  // ★ DESCRIPTIVE, NEVER AUTHORITATIVE (#49). `staff` above collapses any
  //   non-active membership to EMPTY, which is right for authority and is exactly
  //   why an invited member used to be indistinguishable from a student — the app
  //   had thrown away the one fact it needed to offer them the invitation screen.
  //   This holds that fact SEPARATELY, and it carries no permission list at all,
  //   so there is no boolean anywhere that could turn it into access.
  const [staffMembership, setStaffMembership] = useState(EMPTY_STAFF_MEMBERSHIP);
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
      // getSession() reads localStorage but can stall behind an in-flight token refresh;
      // fail open to "no session" after the timeout — if the real session settles later,
      // onAuthStateChange (INITIAL_SESSION/SIGNED_IN below) still delivers it.
      const res = await withTimeout(supabase.auth.getSession(), AUTH_CALL_TIMEOUT_MS, null);
      if (!res) console.warn('[auth] getSession timed out — failing open to signed-out');
      const cached = res?.data?.session ?? null;
      if (!cached) {
        if (!mounted) return;
        applyStorageUser(null);
        setSession(null);
        setLoading(false);
        return;
      }
      // Set the session optimistically so the profile fetch (effect below) and the
      // enrollment-gate queries start NOW, in parallel with the revoke check — the
      // old sequential order added a full network round-trip to every startup.
      // `loading` stays true until the revoke verdict, so nothing renders for a
      // revoked account (the gate shows AuthSplash while loading).
      applyStorageUser(cached.user?.id ?? null);
      if (mounted) setSession(cached);
      // getSession() only reads the locally-cached token — a deleted/disabled
      // account still looks "logged in". Re-check against the auth server and drop
      // the session if the account is truly gone (401/403). Any other failure
      // (network/5xx) fails open so an offline user with a valid account stays in.
      if (await accountRevoked()) {
        await supabase.auth.signOut(); // onAuthStateChange clears session + storage namespace
        if (mounted) {
          applyStorageUser(null);
          setSession(null);
        }
      }
      if (mounted) setLoading(false);
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
  // Throttled to once per minute — rapid tab switching shouldn't burn auth round-trips.
  useEffect(() => {
    if (!supabaseConfigured) return;
    let lastCheck = 0;
    const onVisible = async () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastCheck < 60_000) return;
      lastCheck = Date.now();
      const res = await withTimeout(supabase.auth.getSession(), AUTH_CALL_TIMEOUT_MS, null);
      if (res?.data?.session && (await accountRevoked())) await supabase.auth.signOut();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Load the profile row whenever the signed-in user changes.
  // The root gate waits on profileReady, so this fetch must NEVER hang: each attempt is
  // raced against an 8s timeout (same fail-open idiom as useEnrollmentGate's 7s race), with
  // one retry for a transient error/timeout before giving up with profile=null. RLS +
  // the enrollment gate remain the real boundary when we fail open.
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) {
      setProfile(null);
      setProfileFetchedFor(null);
      setProfileFailed(false);
      return;
    }
    let active = true;
    (async () => {
      const TIMEOUT = { data: null, error: new Error('profile fetch timed out (8s)') };
      let res = TIMEOUT;
      for (let attempt = 0; attempt < 2 && active; attempt++) {
        res = await Promise.race([
          fetchProfileRow(uid),
          new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), 8000)),
        ]);
        if (!res.error) break;
        console.warn(`[auth] profile fetch attempt ${attempt + 1} failed:`, res.error.message);
      }
      if (!active) return;
      if (res.error) console.error('[auth] profile fetch failed — proceeding without profile:', res.error.message);
      setProfileFailed(Boolean(res.error));
      setProfile(res.data ?? null);
      setProfileFetchedFor(uid); // mark "first fetch done" even on error (fail open, don't hang the gate)
    })();
    return () => {
      active = false;
    };
  }, [session?.user?.id]);

  // ── Staff context (#45) ────────────────────────────────────────────────────
  // Who is this person allowed to be in the admin surfaces? Fetched from
  // my_staff_context() IN PARALLEL with the profile above — its own effect on the
  // same [uid] dependency, deliberately not chained after the profile fetch,
  // because startup was explicitly parallelised once already and re-serialising it
  // would add a round trip to every sign-in.
  //
  // ★ NOT a profiles column, and that is deliberate. fetchProfileRow's four-tier
  //   fallback ladder narrows the select on a missing-column error, so a new
  //   column on a not-yet-migrated database silently disappears and reads as
  //   `undefined` — indistinguishable from "no role". An RPC either answers or
  //   fails loudly enough for staffContextFromRpc() to classify it.
  //
  // ★ Authority is read LIVE from the database on every session change, never
  //   decoded from a JWT claim. That is what makes suspending a staff member take
  //   effect on their next request instead of on their next token refresh.
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) {
      setStaff(EMPTY_STAFF_CONTEXT);
      setStaffMembership(EMPTY_STAFF_MEMBERSHIP);
      setStaffDegraded(false);
      setStaffMissing(false);
      setStaffFetchedFor(null);
      return;
    }
    let active = true;
    (async () => {
      const res = await fetchStaffContext();
      if (!active) return;
      setStaff(res.context);
      setStaffMembership(res.membership || EMPTY_STAFF_MEMBERSHIP);
      setStaffDegraded(res.degraded);
      setStaffMissing(res.missing);
      if (res.degraded && !res.missing) {
        console.warn('[auth] staff context unavailable — treating this account as non-staff');
      }
      // Mark settled even on failure. The gate waits on this to avoid flashing an
      // admin screen, and an unavailable check already resolved to EMPTY, so
      // holding the splash forever would strand the app for a decision already made.
      setStaffFetchedFor(uid);
    })();
    return () => {
      active = false;
    };
  }, [session?.user?.id]);

  // THE capability predicate every consumer should use. Memoized on the context
  // identity so passing it down does not defeat React.memo on TabPanel — the
  // keep-alive tree re-renders app-wide if any of its props changes identity.
  const can = useMemo(() => (key) => staffCan(staff, key), [staff]);

  // Re-read staff authority on demand — after accepting an invitation, after a
  // Super Admin changes someone's role, or when a screen wants to be sure.
  async function refreshStaff() {
    if (!session?.user?.id) return EMPTY_STAFF_CONTEXT;
    const res = await fetchStaffContext();
    setStaff(res.context);
    setStaffMembership(res.membership || EMPTY_STAFF_MEMBERSHIP);
    setStaffDegraded(res.degraded);
    setStaffMissing(res.missing);
    return res.context;
  }

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
    // ★ DROP A RESPONSE FOR AN ACCOUNT THAT IS NO LONGER SIGNED IN. The initial
    //   fetch has always guarded its write with an `active` flag; this one never
    //   needed to, because it only ever ran from an explicit user action (a poll
    //   button, the avatar uploader). The profileFailed retry effect below now
    //   calls it UNATTENDED every PROFILE_RETRY_MS and on every focus — and only
    //   while the connection is already bad, i.e. exactly when a reply is most
    //   likely to outlive the session. Without this, signing out and straight back
    //   in as someone else could land account A's row — including its is_admin —
    //   on account B, and the root memo's first branch turns that into FULL access.
    if (uidRef.current !== uid) return null;
    setProfile(data ?? null);
    setProfileFailed(false);   // a successful read clears the "identity unknown" hold
    return data ?? null;
  }

  // Keep uidRef pointing at the live session for the guard in refreshProfile().
  useEffect(() => { uidRef.current = session?.user?.id ?? null; }, [session?.user?.id]);

  // ── Self-heal a failed profile read ───────────────────────────────────────
  // The gate holds an unknown identity on a recoverable screen rather than
  // quoting it a price, so that hold MUST be able to end on its own — otherwise a
  // transient blip strands the user until they think to reload. Retry when the tab
  // comes back to the foreground, and on a slow interval in case it never does.
  // Inert unless a fetch actually failed, so this costs a healthy session nothing.
  useEffect(() => {
    if (!profileFailed || !session?.user?.id) return;
    let stop = false;
    const retry = () => { if (!stop && !document.hidden) refreshProfile(); };
    const id = setInterval(retry, PROFILE_RETRY_MS);
    window.addEventListener('focus', retry);
    document.addEventListener('visibilitychange', retry);
    return () => {
      stop = true;
      clearInterval(id);
      window.removeEventListener('focus', retry);
      document.removeEventListener('visibilitychange', retry);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileFailed, session?.user?.id]);

  const value = {
    session,
    user: session?.user ?? null,
    profile,
    loading,
    // True once the first profile fetch for the current user has settled (or there's no user).
    // The gate waits on this so it never renders the app/approval screens with a stale null profile.
    profileReady: !session?.user || profileFetchedFor === session?.user?.id,
    // True when the first profile read for this user ERRORED (as opposed to
    // returning no row). The gate uses it to refuse to show a PRICE for an identity
    // it could not read — see resolveGateScreen()'s PROFILE_UNAVAILABLE arm.
    profileFailed,
    refreshProfile,

    // ── Staff authority (#45) ──
    // `staff` is the normalized context; `can(key)` is what callers should use.
    // Both are EMPTY until the server answers, so a screen that renders before
    // staffReady shows nothing privileged rather than flashing an admin surface.
    staff,
    // True once the first staff lookup for the current user has settled (or there
    // is no user). The gate waits on this exactly as it waits on profileReady.
    staffReady: !session?.user || staffFetchedFor === session?.user?.id,
    staffDegraded,
    // Narrower than staffDegraded: the role model is not in this database at all.
    // A screen that knows this can render setup guidance WITHOUT firing a request
    // that cannot succeed — which is what was surfacing a missing migration as a
    // 500 in the browser console.
    staffMissing,
    // The pending/ended membership, for the invitation screen and for telling
    // someone why their access stopped. Carries no permissions by construction —
    // staffCan() is the only thing that answers "may I".
    staffMembership,
    isSuperAdmin: staff.isSuperAdmin,
    can,
    refreshStaff,
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
