import { test, expect, probe } from "./fixtures";
import { openRectangleRoom, resizeWidthFeet } from "./app";

/**
 * `__roomOnScreen` projects the room's corners through the live camera: `<= 1` means
 * every corner is inside the viewport, `> 1` means the room runs off the edge. A little
 * headroom is allowed for damping, which eases the camera towards its target over a few
 * frames rather than snapping.
 */
const ON_SCREEN = 1;

/** Right-drag pans in OrbitControls; drag far enough and the room leaves the frame. */
async function panRoomOffScreen(page: import("@playwright/test").Page) {
  const box = await page.locator("canvas").first().boundingBox();
  if (!box) throw new Error("no canvas to pan");
  const midX = box.x + box.width / 2;
  const midY = box.y + box.height / 2;
  await page.mouse.move(midX, midY);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(midX - box.width * 0.45, midY - box.height * 0.45, { steps: 15 });
  await page.mouse.up({ button: "right" });
}

test.describe("camera framing", () => {
  test("a new room is fully in shot", async ({ page }) => {
    await openRectangleRoom(page);
    await expect.poll(() => probe(page, "__roomOnScreen")).toBeLessThanOrEqual(ON_SCREEN);
  });

  test("a room resized larger is reframed to fit", async ({ page }) => {
    await openRectangleRoom(page);
    // Wide enough that the old footprint-only formula ran off the sides of a portrait
    // viewport; the point is that a resize reframes rather than leaving the camera put.
    await resizeWidthFeet(page, 40);
    await expect.poll(() => probe(page, "__roomOnScreen")).toBeLessThanOrEqual(ON_SCREEN);
  });

  test("the room still fits when the window is tall and narrow", async ({ page }) => {
    // The case the old framing got wrong: field of view is vertical, so the horizontal
    // one narrows with the viewport and a wide room overflows. Nothing in a
    // footprint-only formula could notice, because aspect was not one of its inputs.
    await page.setViewportSize({ width: 620, height: 1000 });
    await openRectangleRoom(page);
    await resizeWidthFeet(page, 40);

    await page.keyboard.press("f");
    await expect.poll(() => probe(page, "__roomOnScreen")).toBeLessThanOrEqual(ON_SCREEN);
  });

  test("F brings the room back after the user loses it off the edge", async ({ page }) => {
    await openRectangleRoom(page);
    await panRoomOffScreen(page);
    // Worth stating what this is *not*: dollying out does not lose the room, it shrinks
    // it — the corners stay inside the frustum, and an assertion built on the wheel
    // reported a comfortable 0.18. Panning is what actually puts it off the edge, which
    // is also the motion a user makes by accident.
    await expect.poll(() => probe(page, "__roomOnScreen")).toBeGreaterThan(ON_SCREEN);

    await page.keyboard.press("f");
    await expect.poll(() => probe(page, "__roomOnScreen")).toBeLessThanOrEqual(ON_SCREEN);
  });

  test("typing an F into a dimension field does not reframe", async ({ page }) => {
    await openRectangleRoom(page);
    await panRoomOffScreen(page);
    await expect.poll(() => probe(page, "__roomOnScreen")).toBeGreaterThan(ON_SCREEN);

    // Focus the width field and type. If the shortcut fired from inside it, the room
    // would snap back — so the room staying lost is the assertion.
    const width = page
      .locator(".room label.row", { hasText: "width" })
      .locator("input")
      .first();
    await width.click();
    await page.keyboard.press("f");
    await page.waitForTimeout(300);

    expect(await probe(page, "__roomOnScreen")).toBeGreaterThan(ON_SCREEN);
  });
});
