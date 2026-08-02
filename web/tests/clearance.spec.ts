import { test, expect, probe, OUTLINE } from "./fixtures";
import { openRectangleRoom, placeFromCatalog, undo, COUCH } from "./app";

/**
 * The clearance warning is the one feature whose whole point is what the screen looks
 * like, so these assertions read the live outline materials rather than re-querying
 * Rust. A refresh that forgot to recolour an outline would pass a probe-only check.
 */
test.describe("clearance warnings", () => {
  test("one item alone is never crowded", async ({ page }) => {
    await openRectangleRoom(page);
    await placeFromCatalog(page, COUCH);

    expect(await probe(page, "__crowdedIds")).toEqual([]);
    const [only] = await probe(page, "__outlines");
    expect(only.colour).toBe(OUTLINE.selected);
  });

  test("a second couch lands on the first and both say so", async ({ page }) => {
    await openRectangleRoom(page);
    await placeFromCatalog(page, COUCH);
    await placeFromCatalog(page, COUCH);

    // Placement staggers by 0.3 m a step, far inside a 1.964 m couch — so the second
    // one always lands overlapping. That is a known placement bug; this test pins the
    // *warning*, and will start failing usefully if the stagger is ever fixed.
    expect(await probe(page, "__crowdedIds")).toEqual([1, 2]);

    const outlines = await probe(page, "__outlines");
    expect(outlines.every((o) => o.visible)).toBe(true);
    // The selected one must stay distinguishable from its crowded neighbour, or the
    // room is at its most confusing exactly when the app stops saying what is selected.
    expect(outlines.filter((o) => o.colour === OUTLINE.crowded)).toHaveLength(1);
    expect(outlines.filter((o) => o.colour === OUTLINE.crowdedSelected)).toHaveLength(1);
  });

  test("the warning is read from the document, so it rewinds with undo", async ({ page }) => {
    await openRectangleRoom(page);
    await placeFromCatalog(page, COUCH);
    await placeFromCatalog(page, COUCH);
    expect(await probe(page, "__crowdedIds")).toEqual([1, 2]);

    await undo(page);
    await expect.poll(() => probe(page, "__crowdedIds")).toEqual([]);
  });

  test("setting a crowding item aside clears the room", async ({ page }) => {
    await openRectangleRoom(page);
    await placeFromCatalog(page, COUCH);
    await placeFromCatalog(page, COUCH);

    await page.getByRole("button", { name: "set aside" }).click();
    // A bullpen item is not in the room to crowd it.
    await expect.poll(() => probe(page, "__crowdedIds")).toEqual([]);
  });
});
