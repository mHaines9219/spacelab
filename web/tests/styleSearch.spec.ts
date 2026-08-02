import { test, expect, probe } from "./fixtures";
import { openRectangleRoom, designWithAI, placeAISet } from "./app";

/**
 * AI style search is a web-layer *intent* producer: it proposes a set and finishes, and
 * applying it routes through the same Rust paths a manual place or finish click uses. The
 * resolver's own logic is unit-tested (`styleSearch.test.ts`); these specs prove the panel
 * is wired to the document — that "place this set" actually furnishes the room and repaints
 * it, which a green resolver alone cannot show.
 */
test.describe("AI style search", () => {
  test("a '70s bedroom' proposal furnishes the room and applies retro finishes", async ({
    page,
  }) => {
    await openRectangleRoom(page);
    await designWithAI(page, "a 70s bedroom");

    // The card reads back the room and aesthetic it settled on.
    await expect(page.locator(".ai-label")).toContainText("bedroom", { ignoreCase: true });

    // No OpenRouter key in CI, so the offline local resolver answers — the card says so.
    await expect(page.locator(".ai-source")).toHaveText("local");

    // Two nightstands means the same asset placed twice; the proposal card shows a ×2.
    // Asserted before applying, since "place this set" dismisses the card.
    await expect(page.locator(".ai-strip")).toContainText("×2");

    // A bedroom set: a bed, two nightstands, a lamp, a rug and a plant — six pieces.
    await placeAISet(page, 6);

    // Finishes are document state, so applying them must move the picker's active swatch,
    // not just the 3D look. "70s" resolves to dark wood, clay, evening.
    await expect(page.getByRole("button", { name: "Dark wood", exact: true })).toHaveClass(
      /active/,
    );
    await expect(page.getByRole("button", { name: "Clay", exact: true })).toHaveClass(/active/);
    await expect(page.getByRole("button", { name: "Evening", exact: true })).toHaveClass(
      /active/,
    );
  });

  test("the proposal can be dismissed without touching the room", async ({ page }) => {
    await openRectangleRoom(page);
    const before = await probe(page, "__furnishingCount");
    await designWithAI(page, "a minimal living room");
    await page.getByRole("button", { name: "dismiss" }).click();
    await expect(page.locator(".ai-proposal")).toHaveCount(0);
    expect(await probe(page, "__furnishingCount")).toBe(before);
  });
});
