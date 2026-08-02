import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./AuthContext";
import { Landing } from "./Landing";
import { Dashboard } from "./Dashboard";
import { ProtectedRoute } from "./ProtectedRoute";
import { App } from "./App";

/**
 * Three surfaces, one session:
 *   /           the landing / sign-in front door
 *   /dashboard  the signed-in portfolio + settings (auth-gated)
 *   /editor     the 3D editor the plan already shipped — works with or without an account
 *
 * The editor stays deliberately open: the product persists to localStorage and a login is
 * only required to save into the cloud portfolio (see PLAN.md, "manual save" model). So it
 * is not wrapped in ProtectedRoute.
 */
createRoot(document.getElementById("root")!).render(
  <AuthProvider>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
        <Route path="/editor" element={<App />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </AuthProvider>,
);
