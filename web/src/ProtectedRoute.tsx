/**
 * Gate for routes that need a signed-in user. While the session is still being looked up
 * we render nothing decisive — bouncing to the landing page before we know whether the
 * user is signed in would flash the wrong screen on every reload. Once resolved, a
 * signed-out visitor is sent to the front door.
 */
import { Navigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import type { ReactNode } from "react";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="auth-screen">
        <span className="auth-muted">loading…</span>
      </div>
    );
  }
  if (!user) return <Navigate to="/" replace />;
  return <>{children}</>;
}
