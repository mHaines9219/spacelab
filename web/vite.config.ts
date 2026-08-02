import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Dev-only: serves raw masters + reads/writes tags.json for the tag-time preview
// (web/tag.html). apply:"serve" keeps it out of every build.
import { tagServer } from "./scripts/tag-server.mjs";

export default defineConfig({
  plugins: [react(), tagServer()],
  test: {
    // jsdom for pure logic with DOM edges — `localStorage`, `visibilitychange`,
    // `pagehide`. The real app is Playwright's job; this layer exists for the failure
    // branches a browser cannot be made to reach (quota exhaustion, storage throwing).
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
