import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    // jsdom for pure logic with DOM edges — `localStorage`, `visibilitychange`,
    // `pagehide`. The real app is Playwright's job; this layer exists for the failure
    // branches a browser cannot be made to reach (quota exhaustion, storage throwing).
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
