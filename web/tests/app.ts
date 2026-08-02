import { expect, type Page } from "@playwright/test";
import { probe } from "./fixtures";

/**
 * Page-object helpers. Selectors live here and nowhere else, so a UI rename is one edit
 * rather than a sweep through every spec.
 */

/** Open the app and generate a rectangular room at the form's default size. */
export async function openRectangleRoom(page: Page) {
  // The editor lives at /editor now that / is the landing page (accounts work).
  await page.goto("/editor");
  await page.getByRole("button", { name: /Rectangle/ }).click();
  await page.getByRole("button", { name: "create room" }).click();
  // A generated rectangle raises only the two far walls; wait on that rather than a
  // sleep, so a slow WASM boot can't race the assertions below.
  await expect.poll(() => probe(page, "__wallCount")).toBe(2);
}

/**
 * Place a catalog item by its visible title. Deliberately not "the first card" — that
 * silently re-points at a different asset whenever the catalog is reordered, and the
 * assertions here depend on the item's real dimensions.
 */
export async function placeFromCatalog(page: Page, title: string) {
  const before = await probe(page, "__furnishingCount");
  const card = page.locator(".catalog-card", { hasText: title }).first();
  await card.waitFor({ state: "visible" });
  await card.click();
  await expect.poll(() => probe(page, "__furnishingCount")).toBe(before + 1);
}

/** The selection panel's live width/depth/height inputs, in inches. */
export async function selectedDimensions(page: Page) {
  const boxes = page.locator(".panel input");
  return Promise.all(
    (await boxes.all()).map(async (b) => Number(await b.inputValue())),
  );
}

/** Undo via the real keyboard path, not a test-only hook. */
export async function undo(page: Page) {
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
}

/** The HUD's "enclosed" row — what the walls enclose, as the user reads it. */
export async function enclosedReadout(page: Page) {
  const row = page.locator(".hud .row", { hasText: "enclosed" });
  await row.waitFor({ state: "visible" });
  return ((await row.textContent()) ?? "").replace(/^enclosed/, "").trim();
}

/**
 * Trace a closed room through the Draw editor. Corners are clicked as fractions of the
 * SVG so the viewport size stays a config detail; the editor snaps each to a 6-inch grid
 * and "close room" shuts the loop, so the polygon is deterministic without typing exact
 * distances.
 *
 * A traced room raises *every* wall it drew, unlike the generated rectangle's two — which
 * is why this is the only flow that produces an enclosed area to read.
 */
export async function traceClosedRoom(page: Page) {
  await page.goto("/editor");
  await page.getByRole("button", { name: /Draw/ }).click();
  const svg = await page.locator("svg.draw-canvas").boundingBox();
  if (!svg) throw new Error("draw canvas has no bounding box");
  // One `<circle>` is rendered per placed corner, so wait on that rather than a sleep.
  // Clicking without waiting races React's state: several handlers close over the same
  // stale `points`, and you end up with a degenerate polygon that still has four walls
  // but encloses nothing — which is a passing wall count over a broken room.
  const corners = page.locator("svg.draw-canvas circle");
  const at: [number, number][] = [
    [0.32, 0.32],
    [0.68, 0.32],
    [0.68, 0.66],
    [0.32, 0.66],
  ];
  for (const [i, [fx, fy]] of at.entries()) {
    await page.mouse.click(svg.x + svg.width * fx, svg.y + svg.height * fy);
    await expect.poll(() => corners.count()).toBe(i + 1);
  }
  await page.getByRole("button", { name: "close room" }).click();
  await expect.poll(() => probe(page, "__wallCount")).toBe(4);
}

/**
 * Delete a wall without assuming its id. Wall ids are monotonic and never reused, so a
 * second room's walls do NOT start at 0 — a hardcoded 0 is a silent no-op there, which is
 * exactly the trap this helper exists to stop a test falling into.
 */
export async function deleteAnyWall(page: Page) {
  const before = await probe(page, "__wallCount");
  const id = await page.evaluate((n) => {
    for (let candidate = 0; candidate < 64; candidate++) {
      (window as never as { __deleteWallById: (i: number) => void }).__deleteWallById(candidate);
      if ((window as never as { __wallCount: () => number }).__wallCount() < n) return candidate;
    }
    return null;
  }, before);
  expect(id, "no wall id removed a wall").not.toBeNull();
  await expect.poll(() => probe(page, "__wallCount")).toBe(before - 1);
}

/**
 * Add a wall by hand through the real add-wall flow: arm the mode, then two floor
 * clicks. There is deliberately no probe for this — the whole point of the wall it
 * creates is that it is `WallOrigin::Drawn`, and only this path produces one.
 *
 * The two points are fractions of the canvas rather than pixels, since the camera
 * frames the footprint and the viewport size is a config detail. They sit well inside
 * the floor of a default room so the raycast lands on it rather than on a wall.
 */
export async function addWallByHand(page: Page) {
  const before = await probe(page, "__wallCount");
  await page.getByRole("button", { name: "add wall" }).click();
  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no bounding box");
  const click = (fx: number, fy: number) =>
    page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await click(0.44, 0.66);
  await click(0.64, 0.52);
  await expect.poll(() => probe(page, "__wallCount")).toBe(before + 1);
}

/**
 * Retype the room's width in feet and commit with Enter — the same path a user takes,
 * and the one that used to wipe every hand-added wall.
 */
export async function resizeWidthFeet(page: Page, feet: number) {
  const width = page.locator(".room label.row", { hasText: "width" }).locator("input").first();
  await width.fill(String(feet));
  await width.press("Enter");
}

/**
 * Describe a look to the AI style search and wait for the proposal card. Drives the real
 * input and button, not the resolver directly, so this exercises the whole panel path.
 */
export async function designWithAI(page: Page, prompt: string) {
  await page.locator(".ai-prompt").fill(prompt);
  await page.getByRole("button", { name: "design", exact: true }).click();
  await page.locator(".ai-proposal").waitFor({ state: "visible" });
}

/**
 * Apply the shown AI proposal and wait until the whole set has landed. Placement is
 * sequential and async, so the count climbs one at a time — poll to the expected total
 * rather than reading once.
 */
export async function placeAISet(page: Page, expectedTotal: number) {
  const before = await probe(page, "__furnishingCount");
  await page.getByRole("button", { name: "place this set" }).click();
  await expect
    .poll(() => probe(page, "__furnishingCount"))
    .toBe(before + expectedTotal);
}

/**
 * Hide every floating overlay so a screenshot shows the 3D scene alone. Only affects
 * presentation — the scene and the probes are untouched.
 */
export async function hideChrome(page: Page) {
  await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    for (const el of document.querySelectorAll("body *")) {
      if (el === canvas || el.contains(canvas)) continue;
      const position = getComputedStyle(el).position;
      if (position === "fixed" || position === "absolute") {
        (el as HTMLElement).style.display = "none";
      }
    }
  });
}

/** A 2-seat couch: 1.964 x 0.923 m, comfortably bigger than the 0.3 m placement stagger. */
export const COUCH = "Couch, Medium";
/** A night stand: 0.554 m square, small enough to place two of them clear of each other. */
export const NIGHT_STAND = "Night Stand";
