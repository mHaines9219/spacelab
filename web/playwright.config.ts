import { defineConfig, devices } from "@playwright/test";

/**
 * The suite drives the real app against a real WASM build — `npm run dev` rebuilds the
 * WASM first, so a stale `src/wasm/` cannot quietly pass a run.
 *
 * The port is deliberately odd and `--strictPort` is deliberately on. A fixed port that
 * silently *reuses* whatever is already listening will happily test another checkout of
 * this repo when a teammate's dev server holds the port: every check passes, against the
 * wrong tree. With `strictPort` and no reuse, a collision makes vite fail to bind and the
 * run dies loudly instead.
 */
const PORT = Number(process.env.SPACELAB_PORT ?? 5197);

export default defineConfig({
  testDir: "./tests",
  // WebGL is heavy and the dev server is shared; serial keeps runs comparable and stops
  // several headless GL contexts fighting over one GPU.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // A red run should mean a real regression, so no retries locally. CI gets one, because
  // a first-frame timing blip on a cold shared runner is not a product failure.
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 800 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    // Headless Chromium has no GPU on CI, so WebGL needs a software path. Without these
    // the canvas never initialises and every test fails for a reason that has nothing to
    // do with the app.
    launchOptions: { args: ["--enable-unsafe-swiftshader", "--use-gl=angle"] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    // A cold run builds the WASM from scratch, which outlasts vite's own startup.
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
