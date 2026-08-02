/**
 * The Supabase client — the single door to accounts and the cloud portfolio.
 *
 * Auth is *additive* to the app the plan already shipped: the 3D editor persists to
 * `localStorage` and must keep working with no account and no network (that is the
 * "manual save to portfolio" model — see PLAN.md). So this module is written to be
 * *absent-tolerant*: when the two env vars are missing (CI, a fresh clone, an offline
 * build) `supabase` is `null` and `isSupabaseConfigured` is false, and every caller is
 * expected to degrade rather than throw. Nothing here reaches for the network on import.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** True only when both halves are present. Gate every auth/portfolio feature on this. */
export const isSupabaseConfigured = Boolean(url && anonKey);

/**
 * The client, or `null` when unconfigured. Deliberately nullable rather than a stub: a
 * stub that silently no-ops would let an "auth is broken" bug masquerade as "not signed
 * in", which is the exact invisible-failure shape the rest of this codebase works to
 * avoid. Callers check `isSupabaseConfigured` (or `if (!supabase)`) and show a clear
 * "accounts aren't set up" state instead.
 */
export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url!, anonKey!, {
      auth: {
        // The OAuth redirect comes back with the session in the URL fragment; let the
        // client pick it up and persist it so a reload keeps the user signed in.
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;
