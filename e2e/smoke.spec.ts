import { expect, test } from "@playwright/test";

// One account flow, in order: the first-run screen exists only until the admin is created.
test.describe.configure({ mode: "serial" });

const PW = "e2e-admin-password";

test("first run creates the admin, then login and logout work", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "account state is shared; run the flow once");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agent Lee 처음 설정" })).toBeVisible();
  await page.getByLabel("이름").fill("관리자");
  await page.getByLabel(/^비밀번호 \(/).fill(PW);
  await page.getByLabel("비밀번호 확인").fill(PW);
  await page.getByRole("button", { name: "관리자 만들기" }).click();
  await expect(page.getByTestId("whoami")).toContainText("관리자님");

  await page.getByRole("button", { name: "로그아웃" }).click();
  await page.getByLabel("이메일").fill("ingki3@gmail.com");
  await page.getByLabel("비밀번호").fill("wrong-password!");
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByRole("alert")).toHaveText(/맞지 않아요/);
  await page.getByLabel("비밀번호").fill(PW);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByTestId("whoami")).toContainText("ingki3@gmail.com");
});

test("client routes fall back to the SPA and private APIs need a session", async ({ page, request }) => {
  const res = await page.goto("/c/does-not-exist");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: /Agent Lee/ })).toBeVisible();
  expect((await request.get("/api/auth/state")).status()).toBe(200);
  // A cross-site POST without the CSRF header is refused.
  const forged = await request.post("/api/auth/login", {
    data: { email: "ingki3@gmail.com", password: PW },
    headers: { origin: "https://evil.example" },
  });
  expect(forged.status()).toBe(403);
});
