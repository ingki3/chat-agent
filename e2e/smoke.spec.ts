import { expect, test } from "@playwright/test";
import { ADMIN, csrf, useAccount } from "./helpers.js";

test("login screen: wrong password, then sign in and out", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "로그인" })).toBeVisible();
  await page.getByLabel("이메일", { exact: true }).fill(ADMIN.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("wrong-password!");
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByRole("alert")).toHaveText(/맞지 않아요/);
  await page.getByLabel("비밀번호", { exact: true }).fill(ADMIN.password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByTestId("whoami")).toHaveText(ADMIN.name);
});

test("a temporary password must be changed first (admin resets mom's)", async ({
  browser,
  page,
  baseURL,
}) => {
  // Admin resets a throwaway account, not mom (other tests sign in as her).
  await useAccount(page, ADMIN);
  const email = `tmp-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.com`;
  const created = await page.request.post("/api/admin/users", {
    data: { name: "임시", email },
    headers: csrf(baseURL!),
  });
  const { temporaryPassword } = (await created.json()) as { temporaryPassword: string };
  const ctx = await browser.newContext({ baseURL: baseURL! });
  const p = await ctx.newPage();
  await p.goto("/");
  await p.getByLabel("이메일", { exact: true }).fill(email);
  await p.getByLabel("비밀번호", { exact: true }).fill(temporaryPassword);
  await p.getByRole("button", { name: "로그인" }).click();
  await expect(p.getByRole("heading", { name: "비밀번호 변경" })).toBeVisible();
  await p.getByLabel("현재 비밀번호").fill(temporaryPassword);
  await p.getByLabel(/^새 비밀번호 \(/).fill("a-new-password-1");
  await p.getByLabel("새 비밀번호 확인").fill("a-new-password-1");
  await p.getByRole("button", { name: "변경" }).click();
  await expect(p.getByTestId("whoami")).toHaveText("임시");
  // A member has no admin entry and cannot call the user API.
  await expect(p.getByRole("link", { name: /관리자/ })).toHaveCount(0);
  expect((await p.request.get("/api/admin/users")).status()).toBe(403);
  await ctx.close();
});

test("client routes fall back to the SPA; cross-site POSTs are refused", async ({ page, request }) => {
  const res = await page.goto("/c/does-not-exist");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: /Agent Lee/ }).first()).toBeVisible();
  const forged = await request.post("/api/auth/login", {
    data: { email: ADMIN.email, password: ADMIN.password },
    headers: { origin: "https://evil.example" },
  });
  expect(forged.status()).toBe(403);
});
