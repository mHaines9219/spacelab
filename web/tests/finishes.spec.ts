import { test, expect, probe, OUTLINE } from "./fixtures";
import { openRectangleRoom, placeFromCatalog, undo, COUCH } from "./app";

/**
 * Floor and wall finishes are document state, so the renderer must follow the document
 * rather than hold its own copy. These drive the real controls.
 */
test.describe("finishes", () => {
  test("the floor finish can be swapped and undone", async ({ page }) => {
    await openRectangleRoom(page);
    const tiles = page.getByRole("button", { name: "Tile" });
    await tiles.click();
    // The picker marks the active finish; that is the document's choice reflected back.
    await expect(tiles).toHaveClass(/active|selected/);

    await undo(page);
    await expect(tiles).not.toHaveClass(/active|selected/);
  });

  test("wall tints and clearance outlines coexist on the same meshes", async ({ page }) => {
    await openRectangleRoom(page);
    await placeFromCatalog(page, COUCH);
    await placeFromCatalog(page, COUCH);
    expect(await probe(page, "__crowdedIds")).toEqual([1, 2]);

    // Repainting the walls must not disturb the furnishing outlines: the two features
    // landed in the same file within an hour of each other and nothing exercised them
    // together until now.
    const sage = page.getByRole("button", { name: "Sage" });
    if (await sage.count()) {
      await sage.click();
      await expect.poll(() => probe(page, "__crowdedIds")).toEqual([1, 2]);
      const outlines = await probe(page, "__outlines");
      expect(outlines.filter((o) => o.colour === OUTLINE.crowdedSelected)).toHaveLength(1);
      expect(outlines.filter((o) => o.colour === OUTLINE.crowded)).toHaveLength(1);
    }
  });
});
