import { test as base, expect, type Page } from "@playwright/test";

/**
 * The dev-only probes `viewport.ts` hangs off `window` under `import.meta.env.DEV`.
 * They exist so a test can read scene state that never reaches the DOM — a wall count,
 * an outline colour — without the suite reaching into three.js itself.
 */
export type Probes = {
  __selectedYaw: () => number | null;
  __furnishingCount: () => number;
  __wallCount: () => number;
  __floorTris: () => number;
  __wallTris: () => number;
  __openingCount: () => number;
  __crowdedIds: () => number[];
  __outlines: () => { id: number; visible: boolean; colour: number }[];
  __deleteWallById: (id: number) => void;
  __addOpeningOnWall: (kind: "door" | "window", wallId: number) => number;
};

/** Furnishing outline colours, mirroring the constants in `viewport.ts`. */
export const OUTLINE = {
  selected: 0x5b9dff,
  crowded: 0xffa53d,
  crowdedSelected: 0xff5c3d,
} as const;

/**
 * Read a probe. Fails loudly rather than returning undefined if the probe is missing —
 * a renamed probe should break the test that depends on it, not silently pass.
 */
export async function probe<K extends keyof Probes>(
  page: Page,
  name: K,
  ...args: Parameters<Probes[K]>
): Promise<ReturnType<Probes[K]>> {
  const present = await page.evaluate((n) => typeof (window as never)[n] === "function", name);
  expect(present, `dev probe ${name} is missing from viewport.ts`).toBe(true);
  return page.evaluate(
    ([n, a]) => (window as never as Probes)[n as K](...(a as never[])),
    [name, args] as const,
  ) as Promise<ReturnType<Probes[K]>>;
}

/**
 * Console noise that is not the app's fault, kept as narrow as possible so it can never
 * swallow a real error.
 *
 * Textures are the deliberate one. `npm run textures` fetches ~9 MB of CC0 sets from a
 * third-party host; running it in CI would make every build depend on someone else's
 * uptime. The app runs untextured and the resulting 404s are the *absence of a fixture*,
 * not a defect — so they are ignored by exact path prefix rather than by muting 404s.
 */
const IGNORED_ERRORS = [/assets\/textures\//, /Download the React DevTools/];

/**
 * Every test gets a console guard. A thrown exception or an unexpected `console.error`
 * fails the test even when the assertions pass — several real bugs in this app have
 * surfaced as a console error beside a correct-looking scene.
 */
export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        const text = m.text();
        if (!IGNORED_ERRORS.some((re) => re.test(text))) errors.push(text);
      });
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      await use(errors);
      expect(errors, "unexpected console errors during test").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
