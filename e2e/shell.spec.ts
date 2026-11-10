import { expect, test } from "@playwright/test";
import { ADMIN, MOM, SON, csrf, newConversation, useAccount } from "./helpers.js";

test("drawer opens and closes on narrow screens; moving to a conversation closes it", async ({
  page,
  baseURL,
}, info) => {
  await useAccount(page, MOM);
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
  const people = [
    { who: ADMIN, title: `아빠 대화 ${tag}` },
    { who: MOM, title: `엄마 대화 ${tag}` },
    { who: SON, title: `아들 대화 ${tag}` },
  ];
  const pages = [];
  for (const p of people) {
    const ctx = await browser.newContext({ baseURL: baseURL! });
    const page = await ctx.newPage();
    await useAccount(page, p.who);
    await newConversation(page.request, baseURL!, p.title);
    pages.push({ ...p, ctx, page });
  }
  for (const { page: p, title: mine } of pages) {
    const theirs = people.map((x) => x.title).filter((t) => t !== mine);
    await p.goto("/");
    if (info.project.name === "mobile") await p.getByRole("button", { name: "메뉴 열기" }).click();
    await expect(p.getByTestId("sidebar").getByText(mine)).toBeVisible();
    for (const t of theirs) await expect(p.getByTestId("sidebar").getByText(t)).toHaveCount(0);
    await p.reload();
    if (info.project.name === "mobile") await p.getByRole("button", { name: "메뉴 열기" }).click();
    await expect(p.getByTestId("sidebar").getByText(mine)).toBeVisible();
  }
  // Another browser (a fresh context) signed in as mom sees the same list.
  const other = await browser.newContext({ baseURL: baseURL! });
  const otherPage = await other.newPage();
  await useAccount(otherPage, MOM);
  await otherPage.goto("/");
  if (info.project.name === "mobile") await otherPage.getByRole("button", { name: "메뉴 열기" }).click();
  await expect(otherPage.getByTestId("sidebar").getByText(`엄마 대화 ${tag}`)).toBeVisible();
  await Promise.all([...pages.map((x) => x.ctx.close()), other.close()]);
});

test("a new chat starts by typing; the reply streams in (fake runtime)", async ({ page }) => {
  await useAccount(page, SON);
  await page.goto("/");
  await page.getByLabel("메시지 입력").fill("사과 바나나 포도");
  await page.getByRole("button", { name: "보내기" }).click();
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/);
  await expect(page.getByTestId("assistant").last()).toContainText("사과 바나나 포도");
  await expect(page.getByTestId("assistant").last()).toContainText("fake-large");
  await expect(page.locator(".topbar .title")).toHaveText("사과 바나나 포도");
});

test("expired session: login again on the same address", async ({ page, baseURL }) => {
  await useAccount(page, SON);
  const c = await newConversation(page.request, baseURL!, `복귀 ${Date.now()}`);
  await page.context().clearCookies();
  await page.goto(`/c/${c.id}`);
  await page.getByLabel("이메일", { exact: true }).fill(SON.email);
  await page.getByLabel("비밀번호", { exact: true }).fill(SON.password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${c.id}$`));
  await expect(page.locator(".topbar .title")).toHaveText(c.title);
});

test("dark mode follows the system and can be set by hand", async ({ page }) => {
  await useAccount(page, SON);
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

test("signing out in one tab signs out the other tab too, without leaving data on screen", async ({
  browser,
  baseURL,
}, info) => {
  const ctx = await browser.newContext({ baseURL: baseURL! });
  const a = await ctx.newPage();
  // Its own login: signing out must not end the saved session the other tests share.
  const login = await a.request.post("/api/auth/login", {
    data: { email: MOM.email, password: MOM.password },
    headers: csrf(baseURL!),
  });
  expect(login.ok()).toBe(true);
  const title = `탭 ${Date.now()}`;
  await newConversation(a.request, baseURL!, title);
  await a.goto("/settings");
  const b = await ctx.newPage();
  await b.goto("/settings");
  if (info.project.name === "mobile") await b.getByRole("button", { name: "메뉴 열기" }).click();
  await b.getByRole("button", { name: "로그아웃" }).click();
  await expect(a.getByRole("button", { name: "로그인" })).toBeVisible();
  await expect(a.getByText(title)).toHaveCount(0);
  await ctx.close();
});

test("going back to a conversation that is still streaming does not repeat the text", async ({
  page,
  baseURL,
}, info) => {
  await useAccount(page, SON);
  const other = await newConversation(page.request, baseURL!, `다른 ${Date.now()}`);
  await page.goto("/");
  await page.getByLabel("메시지 입력").fill("/long 60");
  await page.getByRole("button", { name: "보내기" }).click();
  await expect(page.getByTestId("assistant").last()).toContainText("단어3");
  const here = new URL(page.url()).pathname;
  // Move inside the app (no page reload): A → B → A through the sidebar.
  const nav = async (path: string, title?: string) => {
    if (info.project.name === "mobile") await page.getByRole("button", { name: "메뉴 열기" }).click();
    const sidebar = page.getByTestId("sidebar");
    if (title) await sidebar.getByRole("link", { name: title }).click();
    else await sidebar.locator(`a[href="${path}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
  };
  await nav(`/c/${other.id}`, other.title);
  await nav(here);
  await expect(page.getByTestId("assistant").last()).toContainText("단어60", { timeout: 10_000 });
  const text = (await page.getByTestId("assistant").last().textContent()) ?? "";
  expect(text.match(/단어1 /g)).toHaveLength(1);
});

test("drawer: focus moves in and back, and Back never reopens it", async ({ page, baseURL }, info) => {
  test.skip(info.project.name !== "mobile", "the drawer exists on narrow screens");
  await useAccount(page, MOM);
  const c = await newConversation(page.request, baseURL!, `포커스 ${Date.now()}`);
  await page.goto("/settings");
  const sidebar = page.getByTestId("sidebar");
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await expect(page.getByRole("dialog", { name: "사이드바" })).toBeVisible();
  expect(await sidebar.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(sidebar).toBeHidden();
  await expect(page.getByRole("button", { name: "메뉴 열기" })).toBeFocused();
  // Open, pick a conversation, then go back: the drawer stays closed.
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await sidebar.getByRole("link", { name: c.title }).click();
  await expect(sidebar).toBeHidden();
  await page.goBack();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(sidebar).toBeHidden();
});

test("widening the window with the drawer open leaves a usable page", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "starts on a narrow screen");
  await useAccount(page, MOM);
  await page.goto("/settings");
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await expect(page.getByRole("dialog", { name: "사이드바" })).toBeVisible();
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect(page.getByRole("dialog", { name: "사이드바" })).toHaveCount(0);
  expect(await page.locator("main").evaluate((m) => (m as HTMLElement).inert)).toBe(false);
  await page.getByText("어둡게").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("long lists load more: conversations and older messages", async ({ page, baseURL }) => {
  await useAccount(page, ADMIN);
  // Admin's own list grows with the other tests; add enough to need a second page either way.
  for (let i = 0; i < 55; i++) await newConversation(page.request, baseURL!, `목록 ${i}`);
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar.getByRole("button", { name: "더 보기" })).toBeVisible();
  const before = await sidebar.getByTestId("conv").count();
  await sidebar.getByRole("button", { name: "더 보기" }).click();
  await expect.poll(() => sidebar.getByTestId("conv").count()).toBeGreaterThan(before);
});
