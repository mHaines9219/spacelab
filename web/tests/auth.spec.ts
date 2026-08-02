import { expect, test } from "./fixtures";

/**
 * The account surfaces and, just as important, that adding them did not move the editor
 * out from under everyone. These assertions avoid real Google OAuth (which would leave
 * the app) and the configured/unconfigured split (a built site with Supabase env enables
 * the Google button; CI without it disables it) — so they check only what is stable
 * regardless of whether accounts are wired: the routes, the guard, and the editor.
 */

test("the landing page is the front door", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Continue with Google/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /open the editor/ })).toBeVisible();
});

test("you can skip straight into the editor", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /open the editor/ }).click();
  await expect(page).toHaveURL(/\/editor$/);
  // The editor's first screen is the floor-plan chooser — proof the editor still mounts.
  await expect(page.getByRole("button", { name: /Rectangle/ })).toBeVisible();
});

test("the editor still lives at /editor", async ({ page }) => {
  await page.goto("/editor");
  await expect(page.getByRole("button", { name: /Rectangle/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Draw/ })).toBeVisible();
});

test("the dashboard is gated when signed out", async ({ page }) => {
  await page.goto("/dashboard");
  // ProtectedRoute bounces a signed-out visitor back to the landing front door.
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("button", { name: /Continue with Google/ })).toBeVisible();
});
