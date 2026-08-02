import { test, expect, probe } from "./fixtures";
import { openRectangleRoom, placeFromCatalog } from "./app";

/**
 * The acceptance test `PLAN.md` has wanted since PR #1: a refresh must stop eating the
 * user's room. Everything here goes through a **real page reload** rather than calling
 * the binding — a save that only survives a function call is not persistence.
 *
 * Note what these deliberately do *not* rely on: `__furnishingCount` reads the
 * **document**, so it reports the right number even when no mesh rendered. That is
 * exactly the invisible-box failure the asset id exists to prevent, so the reload tests
 * assert on the rendered outlines too.
 */

/** Wait past the autosave debounce so the write has actually happened. */
async function settleAutosave(page: import("@playwright/test").Page) {
  await page.waitForTimeout(1400);
}

test.describe("a room survives a reload", () => {
  test("walls, furniture and finishes all come back", async ({ page }) => {
    await openRectangleRoom(page);
    await placeFromCatalog(page, "Sheen Armchair");
    await page.getByRole("button", { name: "Sage", exact: true }).click();
    await page.getByRole("button", { name: "Evening", exact: true }).click();
    await settleAutosave(page);

    await page.reload();

    // The room is back without going through the start screen at all.
    await expect.poll(() => probe(page, "__wallCount")).toBe(2);
    await expect.poll(() => probe(page, "__furnishingCount")).toBe(1);

    // And it is actually *rendered*: an outline only exists for a furnishing whose mesh
    // was rebuilt, so this is the assertion that a restored room is not invisible boxes.
    await expect.poll(async () => (await probe(page, "__outlines")).length).toBe(1);

    // Document-state choices survive too, and the picker reflects them.
    await expect(page.getByRole("button", { name: "Sage", exact: true })).toHaveClass(
      /active/,
    );
    await expect(page.getByRole("button", { name: "Evening", exact: true })).toHaveClass(
      /active/,
    );
  });

  test("an undone edit stays undone across a reload", async ({ page }) => {
    await openRectangleRoom(page);
    await placeFromCatalog(page, "Sheen Armchair");
    await settleAutosave(page);

    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => probe(page, "__furnishingCount")).toBe(0);
    await settleAutosave(page);

    await page.reload();

    // The one that reads as working while silently dropping a write: undo does not go
    // through `apply`, so an autosave watching only mutations would never see it and the
    // undone item would reappear. The user watched it disappear.
    await expect.poll(() => probe(page, "__furnishingCount")).toBe(0);
  });

  test("a corrupt save leaves the app usable instead of bricking the boot", async ({
    page,
  }) => {
    await openRectangleRoom(page);
    await settleAutosave(page);

    await page.evaluate(() => localStorage.setItem("spacelab.room", "{ not json"));
    await page.reload();

    // An empty room and a message — never a white screen. The slot is cleared too,
    // because a save that will never load would otherwise re-fail on every boot.
    await expect(page.getByRole("button", { name: /Rectangle/ })).toBeVisible();
    await expect(page.getByRole("status")).toContainText(/could not be read/i);
    expect(await page.evaluate(() => localStorage.getItem("spacelab.room"))).toBeNull();
  });

  test("a save from a newer build is refused but kept", async ({ page }) => {
    await openRectangleRoom(page);
    await settleAutosave(page);

    await page.evaluate(() =>
      localStorage.setItem(
        "spacelab.room",
        JSON.stringify({ version: 9999, scene: {}, next_ids: {} }),
      ),
    );
    await page.reload();

    await expect(page.getByRole("status")).toContainText(/newer version/i);
    // Kept, deliberately: the user may simply be on an older build, and deleting the
    // only copy of a room we merely cannot read yet is data loss we caused.
    expect(
      await page.evaluate(() => localStorage.getItem("spacelab.room")),
    ).not.toBeNull();
  });
});
