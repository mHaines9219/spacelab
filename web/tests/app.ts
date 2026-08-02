import { expect, type Page } from "@playwright/test";
import { probe } from "./fixtures";

/**
 * Page-object helpers. Selectors live here and nowhere else, so a UI rename is one edit
 * rather than a sweep through every spec.
 */

/** Open the app and generate a rectangular room at the form's default size. */
export async function openRectangleRoom(page: Page) {
  await page.goto("/");
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
