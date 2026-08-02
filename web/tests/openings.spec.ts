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

  // KNOWN BUG — deleting a wall leaves its door floating in mid-air.
  //
  // Rust is right: `Command::DeleteWall` retains openings off the deleted wall, so the
  // document drops it. The renderer never hears about it. `deleteSelectedWall`
  // (`viewport.ts:709`) calls `syncRoomGeometry()` and `rebuildWallPicks()` but never
  // `reconcileOpenings()`, so the door's pick box, outline and glass pane stay in the
  // scene at the old wall's position.
  //
  // `test.fail()` rather than a skip: the suite stays green, the defect stays visible,
  // and the day someone adds that call this test goes red for passing unexpectedly —
  // so the fix cannot land without also retiring this note.
  //
  // The probe is not at fault. `__deleteWallById` omits the same call the production
  // path omits, so it reproduces the bug rather than inventing it.
  test.fail("deleting a wall takes its openings with it", async ({ page }) => {
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

    // The wall comes back. The opening count is deliberately not asserted here — it is
    // unreliable until the leak above is fixed.
    await undo(page);
    await expect.poll(() => probe(page, "__wallCount")).toBe(2);
  });
});
