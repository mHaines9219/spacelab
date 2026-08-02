import { test, expect, probe } from "./fixtures";
import { addWallByHand, openRectangleRoom, resizeWidthFeet, undo } from "./app";

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

  test("resizing the room keeps a wall the user added", async ({ page }) => {
    await openRectangleRoom(page);
    await addWallByHand(page); // 2 generated + 1 drawn

    await resizeWidthFeet(page, 16);

    // Resizing regenerates the rectangle's own two walls and must leave the drawn one
    // standing. This used to drop to 2: `set_rectangle` rebuilt the list from scratch.
    await expect.poll(() => probe(page, "__wallCount")).toBe(3);
  });

  test("resizing keeps a door on a wall the user added", async ({ page }) => {
    await openRectangleRoom(page);
    await addWallByHand(page);

    // The drawn wall is the most recently allocated id, and ids are monotonic, so it is
    // the highest one — 2 here. Asserting the door landed rules out targeting a
    // generated wall by accident, which would make the test pass for the wrong reason.
    const drawnWall = 2;
    expect(await probe(page, "__addOpeningOnWall", "door", drawnWall)).toBeGreaterThanOrEqual(0);
    await expect.poll(() => probe(page, "__openingCount")).toBe(1);

    await resizeWidthFeet(page, 16);

    // Openings follow their own wall, not the operation. Keeping the wall but losing its
    // door would be a worse bug than the original, because it is selective.
    await expect.poll(() => probe(page, "__wallCount")).toBe(3);
    expect(await probe(page, "__openingCount")).toBe(1);
  });

  test("a hand-added wall survives repeated resizes without duplicating the room", async ({
    page,
  }) => {
    await openRectangleRoom(page);
    await addWallByHand(page);

    for (const feet of [16, 14, 11, 12]) {
      await resizeWidthFeet(page, feet);
      await expect.poll(() => probe(page, "__wallCount")).toBe(3);
    }
  });
});
