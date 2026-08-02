import { test, expect, probe } from "./fixtures";
import { openRectangleRoom, undo } from "./app";

/**
 * A generated rectangle raises its two walls with ids 0 and 1 — `build_room` assigns
 * them from the segment index. Using the ids directly keeps the suite off a probe that
 * does not exist; if wall-id allocation changes (it is due to, for the resize fix) these
 * tests should fail loudly rather than quietly target the wrong wall.
 */
const FIRST_WALL = 0;

test.describe("doors and windows", () => {
  test("a door cuts the wall it is placed in", async ({ page }) => {
    await openRectangleRoom(page);
    expect(await probe(page, "__openingCount")).toBe(0);
    const solidWall = await probe(page, "__wallTris");

    const id = await probe(page, "__addOpeningOnWall", "door", FIRST_WALL);
    expect(id).toBeGreaterThanOrEqual(0);
    await expect.poll(() => probe(page, "__openingCount")).toBe(1);

    // The hole is real geometry: the face is partitioned around it and the reveals line
    // the cut, so the shell gains triangles rather than just hiding some.
    expect(await probe(page, "__wallTris")).toBeGreaterThan(solidWall);
  });

  test("a window carries a sill that a door does not", async ({ page }) => {
    await openRectangleRoom(page);
    await probe(page, "__addOpeningOnWall", "window", FIRST_WALL);
    await expect.poll(() => probe(page, "__openingCount")).toBe(1);
    expect(await probe(page, "__wallTris")).toBeGreaterThan(0);
  });

  // Was pinned with `test.fail()` while the renderer kept a deleted wall's door in the
  // scene. `rebuildOpenings` is now paired into `syncRoomGeometry` itself, so this is an
  // ordinary passing test — the tripwire is retired in the same commit as the fix.
  test("deleting a wall takes its openings with it", async ({ page }) => {
    await openRectangleRoom(page);
    await probe(page, "__addOpeningOnWall", "door", FIRST_WALL);
    await expect.poll(() => probe(page, "__openingCount")).toBe(1);

    await probe(page, "__deleteWallById", FIRST_WALL);
    await expect.poll(() => probe(page, "__openingCount")).toBe(0);
  });

  test("undo restores a wall it deleted", async ({ page }) => {
    await openRectangleRoom(page);
    await probe(page, "__addOpeningOnWall", "door", FIRST_WALL);
    await probe(page, "__deleteWallById", FIRST_WALL);
    await expect.poll(() => probe(page, "__wallCount")).toBe(1);

    // The opening count is asserted now that the leak above is fixed: the door came back
    // with its wall, rather than the count being right only because a stale mesh was
    // never removed. Both halves matter — before the fix this read 1 the whole way
    // through and told you nothing.
    await undo(page);
    await expect.poll(() => probe(page, "__wallCount")).toBe(2);
    await expect.poll(() => probe(page, "__openingCount")).toBe(1);
  });
});
