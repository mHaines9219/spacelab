import { test, expect, probe } from "./fixtures";
import { openRectangleRoom, placeFromCatalog, undo, COUCH, NIGHT_STAND } from "./app";

test.describe("furnishing", () => {
  test("placing from the catalog puts an item in the room and selects it", async ({ page }) => {
    await openRectangleRoom(page);
    await placeFromCatalog(page, NIGHT_STAND);

    expect(await probe(page, "__furnishingCount")).toBe(1);
    // A freshly placed item is selected, so the panel names it.
    await expect(page.locator(".panel")).toContainText(NIGHT_STAND, { ignoreCase: true });
  });

  test("undo removes a placed furnishing", async ({ page }) => {
    await openRectangleRoom(page);
    await placeFromCatalog(page, NIGHT_STAND);

    await undo(page);
    await expect.poll(() => probe(page, "__furnishingCount")).toBe(0);
  });

  test("set aside pulls an item out of the room, re-import brings it back", async ({ page }) => {
    await openRectangleRoom(page);
    await placeFromCatalog(page, COUCH);

    await page.getByRole("button", { name: "set aside" }).click();
    await expect.poll(() => probe(page, "__furnishingCount")).toBe(0);

    // The bullpen tray only exists while something is in it.
    const reimport = page.locator(".bullpen-reimport");
    await expect(reimport).toBeVisible();
    await reimport.click();
    await expect.poll(() => probe(page, "__furnishingCount")).toBe(1);
  });

  test("an arrow key rotates the selection", async ({ page }) => {
    await openRectangleRoom(page);
    await placeFromCatalog(page, NIGHT_STAND);

    // A fresh placement is unrotated, and the mesh follows the document's yaw.
    expect(await probe(page, "__selectedYaw")).toBeCloseTo(0, 5);
    await page.keyboard.press("ArrowLeft");
    expect(await probe(page, "__selectedYaw")).not.toBeCloseTo(0, 5);

    // A rotate is its own undo step, so undoing one rewinds the rotation and leaves the
    // furnishing in the room rather than taking the placement with it.
    await undo(page);
    await expect.poll(() => probe(page, "__furnishingCount")).toBe(1);

    // Undo also deselects (`selectFurnishing(null)` on the undo path), so
    // `__selectedYaw` reads null from here and cannot witness the restored rotation.
    // That the document rewinds the yaw is covered in Rust; this suite's job is proving
    // the mesh follows the document, which the two assertions above do.
    expect(await probe(page, "__selectedYaw")).toBeNull();
  });
});
