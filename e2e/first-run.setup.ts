import { expect, test as setup } from "@playwright/test";
import { ADMIN, MOM, SON, csrf } from "./helpers.js";

// Runs once before the desktop and mobile projects: the first-run screen creates the admin, then the admin adds
// two family accounts whose temporary passwords are replaced, so every other test can sign in directly.
setup("first run: admin and family accounts", async ({ page, baseURL }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agent Lee 처음 설정" })).toBeVisible();
  await page.getByLabel("이름", { exact: true }).fill(ADMIN.name);
  await page.getByLabel(/^비밀번호 \(/).fill(ADMIN.password);
  await page.getByLabel("비밀번호 확인").fill(ADMIN.password);
  await page.getByRole("button", { name: "관리자 만들기" }).click();
  await expect(page.getByTestId("whoami")).toHaveText(ADMIN.name);

  for (const who of [MOM, SON]) {
    const created = await page.request.post("/api/admin/users", {
      data: { name: who.name, email: who.email },
      headers: csrf(baseURL!),
    });
    expect(created.status()).toBe(201);
    const { temporaryPassword } = (await created.json()) as { temporaryPassword: string };
    // Change the temporary password as that user, in a separate request context.
    const ctx = await page.context().browser()!.newContext({ baseURL: baseURL! });
    const login = await ctx.request.post("/api/auth/login", {
      data: { email: who.email, password: temporaryPassword },
      headers: csrf(baseURL!),
    });
    expect(login.ok()).toBe(true);
    const changed = await ctx.request.post("/api/auth/password", {
      data: { currentPassword: temporaryPassword, newPassword: who.password },
      headers: csrf(baseURL!),
    });
    expect(changed.ok()).toBe(true);
    await ctx.close();
  }
});
