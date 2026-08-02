import { test, expect, probe } from "./fixtures";
import { openRectangleRoom, undo } from "./app";

test.describe("floorplan shell", () => {
  test("a generated rectangle opens on two walls over a full floor", async ({ page }) => {
    await openRectangleRoom(page);
    // The near two walls are deliberately omitted so the room reads as a dollhouse
    // view; the floor keeps its whole rectangular footprint regardless.
    expect(await probe(page, "__wallCount")).toBe(2);
    expect(await probe(page, "__floorTris")).toBeGreaterThan(0);
    expect(await probe(page, "__wallTris")).toBeGreaterThan(0);
  });

  test("deleting a wall leaves the floor alone", async ({ page }) => {
    await openRectangleRoom(page);
    const floorBefore = await probe(page, "__floorTris");

    await probe(page, "__deleteWallById", 0);
    await expect.poll(() => probe(page, "__wallCount")).toBe(1);

    // `floor_outline` is owned by the document independently of the walls, so removing
    // a wall must never reshape the floor.
    expect(await probe(page, "__floorTris")).toBe(floorBefore);
  });

  test("undo restores a deleted wall", async ({ page }) => {
    await openRectangleRoom(page);
    await probe(page, "__deleteWallById", 0);
    await expect.poll(() => probe(page, "__wallCount")).toBe(1);

    await undo(page);
    await expect.poll(() => probe(page, "__wallCount")).toBe(2);
  });
});
