/**
 * Session state for the whole app, in one place.
 *
 * The rest of the UI never touches `supabase.auth` directly — it reads `useAuth()`. That
 * keeps the "is anyone signed in?" question answered from a single subscription instead
 * of each component opening its own, and it gives the unconfigured case (no Supabase env)
 * exactly one home: `configured: false`, a null user, and sign-in that surfaces a reason
 * rather than throwing.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase, isSupabaseConfigured } from "./supabase";

type AuthValue = {
  /** True until the initial session lookup resolves — gate redirects on this so a
   * signed-in user is not bounced to the landing page for a frame on every load. */
  loading: boolean;
  /** False when Supabase env is absent; the auth UI shows a setup notice instead. */
  configured: boolean;
  session: Session | null;
  user: User | null;
  /** Kicks off the Google OAuth redirect. Rejects (with a message) when unconfigured. */
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  // Start "loading" only when there is actually a session to look up. Unconfigured, we
  // already know the answer (nobody is signed in), so the app renders immediately.
  const [loading, setLoading] = useState(isSupabaseConfigured);

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setLoading(false);
    });
    // Fires on sign-in, sign-out, token refresh, and when the OAuth redirect lands.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setLoading(false);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      loading,
      configured: isSupabaseConfigured,
      session,
      user: session?.user ?? null,
      signInWithGoogle: async () => {
        if (!supabase) {
          throw new Error(
            "Accounts aren’t configured for this build. Set VITE_SUPABASE_URL and " +
              "VITE_SUPABASE_ANON_KEY to enable sign-in.",
          );
        }
        const { error } = await supabase.auth.signInWithOAuth({
          provider: "google",
          // Come back to the dashboard after Google bounces the user back to us.
          options: { redirectTo: `${window.location.origin}/dashboard` },
        });
        if (error) throw error;
      },
      signOut: async () => {
        await supabase?.auth.signOut();
      },
    }),
    [loading, session],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
