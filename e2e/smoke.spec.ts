import { expect, test } from "@playwright/test";

test("home page loads and reaches the API", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agent Lee" })).toBeVisible();
  await expect(page.getByTestId("health")).toHaveText(/서버 정상/);
});

test("client routes fall back to the SPA", async ({ page }) => {
  const res = await page.goto("/c/does-not-exist");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Agent Lee" })).toBeVisible();
});
