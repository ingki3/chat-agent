import { expect, test } from "@playwright/test";
import { MOM, SON, newConversation, signIn } from "./helpers.js";

test("drawer opens and closes on narrow screens; moving to a conversation closes it", async ({
  page,
  baseURL,
}, info) => {
  await signIn(page, MOM, baseURL!);
  const c = await newConversation(page.request, baseURL!, `서랍 ${info.project.name} ${Date.now()}`);
  await page.goto("/");
  const sidebar = page.getByTestId("sidebar");
  if (info.project.name === "mobile") {
    await expect(sidebar).toBeHidden();
    await page.getByRole("button", { name: "메뉴 열기" }).click();
    await expect(sidebar).toBeVisible();
    // Tap the dimmed strip to the right of the drawer.
    const width = page.viewportSize()!.width;
    await page.getByTestId("scrim").click({ position: { x: width - 10, y: 300 } });
    await expect(sidebar).toBeHidden();
    await page.getByRole("button", { name: "메뉴 열기" }).click();
    await sidebar.getByRole("link", { name: c.title }).click();
    await expect(page).toHaveURL(new RegExp(`/c/${c.id}$`));
    await expect(sidebar).toBeHidden();
  } else {
    await expect(sidebar).toBeVisible();
    await expect(page.getByRole("button", { name: "메뉴 열기" })).toBeHidden();
    await sidebar.getByRole("link", { name: c.title }).click();
    await expect(page).toHaveURL(new RegExp(`/c/${c.id}$`));
  }
  await expect(page.locator(".topbar .title")).toHaveText(c.title);
});

test("each family member sees only their own conversations, after reload and in another browser", async ({
  browser,
  baseURL,
}, info) => {
  const tag = `${info.project.name}-${Date.now()}`;
  const mom = await browser.newContext({ baseURL: baseURL! });
  const son = await browser.newContext({ baseURL: baseURL! });
  const momPage = await mom.newPage();
  const sonPage = await son.newPage();
  await signIn(momPage, MOM, baseURL!);
  await signIn(sonPage, SON, baseURL!);
  await newConversation(momPage.request, baseURL!, `엄마 대화 ${tag}`);
  await newConversation(sonPage.request, baseURL!, `아들 대화 ${tag}`);
  for (const [p, mine, theirs] of [
    [momPage, `엄마 대화 ${tag}`, `아들 대화 ${tag}`],
    [sonPage, `아들 대화 ${tag}`, `엄마 대화 ${tag}`],
  ] as const) {
    await p.goto("/");
    if (info.project.name === "mobile") await p.getByRole("button", { name: "메뉴 열기" }).click();
    await expect(p.getByTestId("sidebar").getByText(mine)).toBeVisible();
    await expect(p.getByTestId("sidebar").getByText(theirs)).toHaveCount(0);
    await p.reload();
    if (info.project.name === "mobile") await p.getByRole("button", { name: "메뉴 열기" }).click();
    await expect(p.getByTestId("sidebar").getByText(mine)).toBeVisible();
  }
  // Another browser (a fresh context) signed in as mom sees the same list.
  const other = await browser.newContext({ baseURL: baseURL! });
  const otherPage = await other.newPage();
  await signIn(otherPage, MOM, baseURL!);
  await otherPage.goto("/");
  if (info.project.name === "mobile") await otherPage.getByRole("button", { name: "메뉴 열기" }).click();
  await expect(otherPage.getByTestId("sidebar").getByText(`엄마 대화 ${tag}`)).toBeVisible();
  await Promise.all([mom.close(), son.close(), other.close()]);
});

test("a new chat starts by typing; the reply streams in (fake runtime)", async ({ page, baseURL }) => {
  await signIn(page, SON, baseURL!);
  await page.goto("/");
  await page.getByLabel("메시지 입력").fill("사과 바나나 포도");
  await page.getByRole("button", { name: "보내기" }).click();
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/);
  await expect(page.getByTestId("assistant").last()).toContainText("사과 바나나 포도");
  await expect(page.getByTestId("assistant").last()).toContainText("fake-large");
  await expect(page.locator(".topbar .title")).toHaveText("사과 바나나 포도");
});

test("expired session: login again on the same address", async ({ page, baseURL }) => {
  await signIn(page, SON, baseURL!);
  const c = await newConversation(page.request, baseURL!, `복귀 ${Date.now()}`);
  await page.context().clearCookies();
  await page.goto(`/c/${c.id}`);
  await page.getByLabel("이메일", { exact: true }).fill(SON.email);
  await page.getByLabel("비밀번호", { exact: true }).fill(SON.password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${c.id}$`));
  await expect(page.locator(".topbar .title")).toHaveText(c.title);
});

test("dark mode follows the system and can be set by hand", async ({ page, baseURL }) => {
  await signIn(page, SON, baseURL!);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/settings");
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await bg()).toBe("rgb(29, 28, 26)");
  await page.getByText("밝게").click();
  expect(await bg()).toBe("rgb(247, 246, 243)");
  await page.reload();
  expect(await bg()).toBe("rgb(247, 246, 243)");
  await page.getByText("시스템").click();
  expect(await bg()).toBe("rgb(29, 28, 26)");
});

test("PWA manifest and service worker are served", async ({ request }) => {
  const m = await request.get("/manifest.webmanifest");
  expect(m.ok()).toBe(true);
  expect(((await m.json()) as { name: string }).name).toBe("Agent Lee");
  const sw = await request.get("/sw.js");
  expect(sw.ok()).toBe(true);
  expect(await sw.text()).toMatch(/never caches API/);
});
