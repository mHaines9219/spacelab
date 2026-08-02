/**
 * The front door: what a signed-out visitor sees. One job — get them into an account —
 * plus a way straight into the local editor, because the plan's product still works with
 * no account at all (localStorage is the working store; the cloud is a manual save).
 *
 * A signed-in visitor never lingers here: they are redirected to the dashboard. The
 * `loading` guard is what keeps that redirect from flashing the landing page for a frame
 * on every reload while the session is looked up.
 */
import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";

export function Landing() {
  const { user, loading, configured, signInWithGoogle } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading) {
    return (
      <div className="auth-screen">
        <span className="auth-muted">loading…</span>
      </div>
    );
  }
  if (user) return <Navigate to="/dashboard" replace />;

  const signIn = async () => {
    setError(null);
    setBusy(true);
    try {
      await signInWithGoogle();
      // On success the browser redirects to Google, so control does not return here.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">spacelab</div>
        <h1 className="auth-title">Design a room without learning Blender.</h1>
        <p className="auth-sub">
          Lay out a living room, bedroom, or office in 3D — then keep every version in your
          portfolio.
        </p>

        <div className="auth-actions">
          <button
            type="button"
            className="auth-google"
            onClick={signIn}
            disabled={!configured || busy}
          >
            <GoogleMark />
            {busy ? "Redirecting…" : "Continue with Google"}
          </button>
          <button type="button" className="auth-ghost" onClick={() => navigate("/editor")}>
            Skip — just open the editor
          </button>
        </div>

        {!configured && (
          <p className="auth-notice">
            Accounts aren’t configured for this build. Set <code>VITE_SUPABASE_URL</code> and{" "}
            <code>VITE_SUPABASE_ANON_KEY</code> to enable sign-in. The editor still works
            without an account.
          </p>
        )}
        {error && <p className="auth-error">{error}</p>}

        <p className="auth-fineprint">
          Signing in creates an account if you don’t have one yet.
        </p>
      </div>
    </div>
  );
}

/** The Google "G", inline so there is no asset to fetch or theme to fight. */
function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
