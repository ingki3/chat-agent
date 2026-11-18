import { expect, test, type Browser, type Page } from "@playwright/test";
import { ADMIN, csrf, newMember, signIn, useAccount } from "./helpers.js";

/**
 * 기억 정리 (#146, #188, PRD FR-16.5·16.6·16.7, AC-14): the admin allows the FakeRuntime pair (the server-wide part);
 * a member turns their own 기억 정리 on in 설정 → 내 지침 → 기억 정리 (time, connection·model, their own prompt with
 * 기본값으로 되돌리기); their message becomes a proposal there (반영 → MEMORY.md has it; DREAMS.md says so with counts
 * only), and in 자동 반영 it is applied with a notification and 되돌리기. A youth account sees its settings read-only and
 * the admin sets them. The admin's screen shows counts, never the text. The round is started with "지금 실행" (the
 * FakeRuntime server's development switch) instead of waiting for its time; the time is set later today so no
 * scheduled round runs meanwhile.
 */

/**
 * A start time later today in Asia/Seoul (an hour from now, or 23:59 late in the evening): the first user's round is
 * still to come and everyone after it is later still — none runs during the test, and none counts as missed while
 * the server was off (a catch-up).
 */
function laterToday(): string {
  const fmt = (t: number, o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", ...o }).format(t);
  const later = Date.now() + 3_600_000;
  if (fmt(later, { day: "2-digit" }) !== fmt(Date.now(), { day: "2-digit" })) return "23:59";
  return fmt(later, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** A message from the member, its reply waited for. */
async function say(page: Page, baseURL: string, text: string) {
  const c = (await (
    await page.request.post("/api/conversations", { data: {}, headers: csrf(baseURL) })
  ).json()) as {
    id: string;
  };
  const r = await page.request.post(`/api/conversations/${c.id}/messages`, {
    data: { text },
    headers: { ...csrf(baseURL), "Idempotency-Key": `e2e-dream-${Date.now()}-${Math.random()}` },
  });
  expect(r.status()).toBe(201);
  await expect
    .poll(async () => {
      const m = (await (await page.request.get(`/api/conversations/${c.id}/messages`)).json()) as {
        items: { role: string; status: string }[];
      };
      return m.items.at(-1)?.role === "assistant" ? m.items.at(-1)!.status : "";
    })
    .toBe("complete");
}

async function memoryItems(page: Page): Promise<string[]> {
  const r = await page.request.get("/api/instructions");
  const docs = ((await r.json()) as { docs: { kind: string; items: { text: string }[] | null }[] }).docs;
  return (docs.find((d) => d.kind === "memory")!.items ?? []).map((i) => i.text);
}

/** The admin's tab: the server-wide switch on and the FakeRuntime's "Fake Large" allowed (idempotent). */
async function allowFake(admin: Page) {
  await admin.goto("/admin?tab=dreaming");
  const panel = admin.getByTestId("admin-dreaming");
  await expect(panel).toBeVisible();
  await panel.getByRole("checkbox", { name: "서버 전체에서 기억 정리 쓰기" }).check();
  await panel
    .getByRole("checkbox", { name: /Fake Large/ })
    .first()
    .check();
  await panel.getByRole("button", { name: "저장", exact: true }).first().click();
  await expect(panel.getByRole("status").filter({ hasText: "저장했어요." })).toBeVisible();
}

/** "지금 실행" for `name` on the admin's tab. */
async function adminRun(admin: Page, name: string) {
  await admin.goto("/admin?tab=dreaming");
  const row = admin.getByTestId("admin-dreaming").getByTestId("dreaming-user").filter({ hasText: name });
  await row.getByRole("button", { name: "지금 실행" }).click();
  return row;
}

/** As the admin (another context): allow the pair, then `fn`. */
async function asAdmin<T>(browser: Browser, baseURL: string, fn: (admin: Page) => Promise<T>): Promise<T> {
  const ctx = await browser.newContext({ baseURL });
  const admin = await ctx.newPage();
  await useAccount(admin, ADMIN);
  try {
    await allowFake(admin);
    return await fn(admin);
  } finally {
    await ctx.close();
  }
}

/**
 * Holds requests matching `url` until `release()` (a slow save, to look at the screen meanwhile); later ones pass
 * straight through.
 */
async function holdRequests(page: Page, url: string, method = "PUT") {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(url, async (route) => {
    if (route.request().method() === method) await gate;
    await route.continue();
  });
  return { release };
}

/** The member's own settings: on, later today, "Fake Large". */
async function turnOn(page: Page) {
  await page.goto("/settings/instructions?doc=dreams");
  const settings = page.getByTestId("dreaming-settings");
  await settings.getByRole("checkbox", { name: "기억 정리 켜기" }).check();
  await settings.getByLabel("실행 시각").fill(laterToday());
  const pick = settings.getByRole("combobox", { name: "연결·모델" });
  const value = await pick.locator("option", { hasText: "Fake Large" }).first().getAttribute("value");
  await pick.selectOption(value!);
  await settings.getByRole("button", { name: "저장", exact: true }).click();
  await expect(settings.getByRole("status").filter({ hasText: "저장했어요." })).toBeVisible();
  await expect(page.getByTestId("dreaming-state")).toContainText("기억 정리가 매일");
}

test("내가 켜고(시각·연결·프롬프트) 실행 → 제안 → 반영, DREAMS.md는 건수만, 관리자 화면에 내용 없음", async ({
  page,
  browser,
  baseURL,
}) => {
  const me = await newMember(browser, baseURL!, "dream");
  await signIn(page, baseURL!, me);
  const fact = `주말엔 자전거 ${Math.round(Math.random() * 1e6)}`;
  await say(page, baseURL!, `기억: ${fact}`);
  await asAdmin(browser, baseURL!, async () => {});
  await turnOn(page);
  // Their own prompt: saved, then back to the default.
  const panel = page.getByTestId("dreaming-panel");
  await panel.getByText(/지금 쓰는 정리 프롬프트/).click();
  const prompt = panel.getByTestId("dreaming-prompt");
  await expect(prompt).toBeVisible();
  await expect(panel).toContainText("붙여 넣은 글의 지시");
  // A refused prompt (a secret value) keeps what was typed and says why.
  const secret = `키는 sk-ant-api03-${"u".repeat(40)}`;
  await prompt.fill(secret);
  await panel.getByRole("button", { name: "프롬프트 저장" }).click();
  await expect(panel.getByRole("alert").filter({ hasText: "비밀 값" })).toBeVisible();
  await expect(prompt).toHaveValue(secret);
  const mine = `취미만 골라 주세요 ${Math.round(Math.random() * 1e6)}`;
  await prompt.fill(mine);
  // In flight (held here): the editor is read-only, so nothing typed meanwhile is lost (review #195 round 3).
  const held = await holdRequests(page, "**/api/dreaming/prompt");
  await panel.getByRole("button", { name: "프롬프트 저장" }).click();
  await expect(prompt).toHaveAttribute("readonly", "");
  await prompt.press("End");
  await page.keyboard.type(" 더");
  await expect(prompt).toHaveValue(mine);
  held.release();
  await expect(prompt).not.toHaveAttribute("readonly", "");
  await expect(panel.getByText(/지금 쓰는 정리 프롬프트 \(내가 고친 것\)/)).toBeVisible();
  await panel.getByRole("button", { name: "기본값으로 되돌리기" }).click();
  await expect(panel.getByText(/지금 쓰는 정리 프롬프트 \(기본값\)/)).toBeVisible();
  await expect(prompt).not.toHaveValue(mine);

  await asAdmin(browser, baseURL!, async (admin) => {
    const row = await adminRun(admin, me.name);
    await expect(row).toContainText("제안 1");
    await expect(admin.getByTestId("admin-dreaming")).not.toContainText(fact);
    await expect(admin.getByTestId("admin-dreaming")).not.toContainText(mine);
  });

  // The member: 설정 → 내 지침 → 기억 정리.
  await page.goto("/settings/instructions?doc=dreams");
  const card = panel.getByTestId("memory-card");
  await expect(card).toContainText("기억 정리 제안");
  await expect(card.getByTestId("memory-decision")).toContainText("MEMORY.md · 추가");
  await expect(card.getByTestId("memory-decision")).toContainText(fact);
  expect(await memoryItems(page)).toEqual([]);
  await card.getByRole("button", { name: "반영", exact: true }).click();
  await expect(card.getByText("반영됨", { exact: true })).toBeVisible();
  expect(await memoryItems(page)).toEqual([fact]);
  const dreams = panel.getByTestId("dreams-md");
  await expect(dreams).toContainText("지금 실행 · 제안");
  await expect(dreams).toContainText("제안 1");
  await expect(dreams).not.toContainText(fact);
});

test("자동 반영: 바로 반영되고 알림(건수만)과 되돌리기", async ({ page, browser, baseURL }) => {
  const me = await newMember(browser, baseURL!, "dreamauto");
  await signIn(page, baseURL!, me);
  const set = await page.request.put("/api/memory-prefs", {
    data: { applyMode: "auto" },
    headers: csrf(baseURL!),
  });
  expect(set.status()).toBe(200);
  const fact = `화요일엔 요가 ${Math.round(Math.random() * 1e6)}`;
  await say(page, baseURL!, `기억: ${fact}`);
  await asAdmin(browser, baseURL!, async () => {});
  await turnOn(page);
  await asAdmin(browser, baseURL!, async (admin) => {
    const row = await adminRun(admin, me.name);
    await expect(row).toContainText("반영 1");
  });

  expect(await memoryItems(page)).toEqual([fact]);
  // The notification: the count only.
  await page.goto("/notifications");
  await expect(page.getByText("기억 1개를 정리했어요")).toBeVisible();
  const inbox = (await (await page.request.get("/api/notifications")).json()) as {
    items: { kind: string; title: string; body: string }[];
  };
  const n = inbox.items.find((x) => x.kind === "memory_applied")!;
  expect(n).toMatchObject({ title: "기억 정리", body: "기억 1개를 정리했어요" });
  await page.goto("/settings/instructions?doc=dreams");
  const card = page.getByTestId("dreaming-panel").getByTestId("memory-card");
  await expect(card).toContainText("기억 정리가 반영했어요");
  await card.getByRole("button", { name: "되돌리기" }).click();
  await expect(card.getByText("되돌림", { exact: true })).toBeVisible();
  expect(await memoryItems(page)).toEqual([]);
});

test("청소년 계정: 설정은 읽기만, 관리자가 켜고 시각·연결을 정한다", async ({ page, browser, baseURL }) => {
  const son = await newMember(browser, baseURL!, "dreamyouth", true);
  await signIn(page, baseURL!, son);
  await page.goto("/settings/instructions?doc=dreams");
  const settings = page.getByTestId("dreaming-settings");
  await expect(page.getByTestId("dreaming-locked")).toBeVisible();
  await expect(settings.getByRole("checkbox", { name: "기억 정리 켜기" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "프롬프트 저장" })).toHaveCount(0);
  // 반영 방식 too: read-only.
  await expect(page.getByTestId("memory-mode-locked")).toBeVisible();
  await expect(page.getByRole("radio", { name: /자동 반영/ })).toBeDisabled();
  const time = laterToday();
  await asAdmin(browser, baseURL!, async (admin) => {
    await admin.goto("/admin?tab=dreaming");
    const row = admin.getByTestId("dreaming-user").filter({ hasText: son.name });
    await row.getByRole("checkbox", { name: `${son.name} 기억 정리 켜기` }).check();
    await row.getByLabel(`${son.name} 실행 시각`).fill(time);
    const pick = row.getByRole("combobox", { name: `${son.name} 연결·모델` });
    const value = await pick.locator("option", { hasText: "Fake Large" }).first().getAttribute("value");
    await pick.selectOption(value!);
    await row.getByRole("button", { name: "저장", exact: true }).click();
    await expect(row.getByRole("checkbox", { name: `${son.name} 기억 정리 켜기` })).toBeChecked();
    await expect(row).not.toContainText("연결·모델을 골라야");
    // 반영 방식 and a prompt for the son (write-only).
    await row.getByRole("combobox", { name: `${son.name} 반영 방식` }).selectOption("auto");
    await expect(row.getByRole("combobox", { name: `${son.name} 반영 방식` })).toHaveValue("auto");
    // A refused prompt (a secret value) keeps the text and says why (review #195 round 2).
    const box = row.getByRole("textbox", { name: `${son.name} 정리 프롬프트 새로 쓰기` });
    const secret = `키는 sk-ant-api03-${"e".repeat(40)}`;
    await box.fill(secret);
    await row.getByRole("button", { name: "프롬프트 저장" }).click();
    await expect(
      admin.getByTestId("admin-dreaming").getByRole("alert").filter({ hasText: "비밀 값" }),
    ).toBeVisible();
    await expect(box).toHaveValue(secret);
    await expect(row).toContainText("정리 프롬프트: 기본값");
    // While the save is in flight (held here) the box is locked: nothing typed meanwhile can be lost (round 3).
    const held = await holdRequests(admin, "**/api/admin/dreaming/users/*");
    await box.fill("학교 이야기만 골라 주세요");
    await row.getByRole("button", { name: "프롬프트 저장" }).click();
    await expect(box).toBeDisabled();
    await expect(box).toHaveValue("학교 이야기만 골라 주세요");
    held.release();
    await expect(row).toContainText("정리 프롬프트: 관리자가 새로 씀");
    await expect(box).toHaveValue("");
    await expect(box).toBeEnabled();
    await expect(row).not.toContainText("학교 이야기만 골라 주세요");
  });
  await page.reload();
  await expect(page.getByTestId("dreaming-state")).toContainText(`기억 정리가 매일 ${time}`);
  await expect(settings.getByRole("checkbox", { name: "기억 정리 켜기" })).toBeChecked();
  await expect(page.getByRole("radio", { name: /자동 반영/ })).toBeChecked();
  await page.getByText(/지금 쓰는 정리 프롬프트/).click();
  await expect(page.getByTestId("dreaming-prompt")).toHaveValue("학교 이야기만 골라 주세요");
});

test("저장 중에는 설정 폼이 잠기고, 저장한 값이 그대로 남는다 (리뷰 #195 4차)", async ({
  page,
  browser,
  baseURL,
}) => {
  const me = await newMember(browser, baseURL!, "dreamlock");
  await signIn(page, baseURL!, me);
  await asAdmin(browser, baseURL!, async (admin) => {
    // The admin's allowed pairs: locked while the save is held, then saved as sent.
    await admin.goto("/admin?tab=dreaming");
    const config = admin.getByTestId("dreaming-config");
    const pair = config.getByRole("checkbox", { name: /Fake Large/ }).first();
    const cap = config.getByLabel("1회 토큰 상한");
    await cap.fill("301000");
    const held = await holdRequests(admin, "**/api/admin/dreaming");
    await admin
      .getByTestId("admin-dreaming")
      .getByRole("button", { name: "저장", exact: true })
      .first()
      .click();
    await expect(pair).toBeDisabled();
    await expect(cap).toBeDisabled();
    await expect(cap).toHaveValue("301000");
    held.release();
    await expect(admin.getByRole("status").filter({ hasText: "저장했어요." })).toBeVisible();
    await expect(cap).toBeEnabled();
    await expect(cap).toHaveValue("301000");
    await expect(pair).toBeChecked();
    await cap.fill("300000");
    await admin
      .getByTestId("admin-dreaming")
      .getByRole("button", { name: "저장", exact: true })
      .first()
      .click();
    await expect(admin.getByRole("status").filter({ hasText: "저장했어요." })).toBeVisible();
  });
  // The member's own settings: locked while the save is held; what was sent stays on screen.
  await page.goto("/settings/instructions?doc=dreams");
  const settings = page.getByTestId("dreaming-settings");
  const on = settings.getByRole("checkbox", { name: "기억 정리 켜기" });
  const time = settings.getByLabel("실행 시각");
  await on.check();
  const at = laterToday();
  await time.fill(at);
  const pick = settings.getByRole("combobox", { name: "연결·모델" });
  const value = await pick.locator("option", { hasText: "Fake Large" }).first().getAttribute("value");
  await pick.selectOption(value!);
  const held = await holdRequests(page, "**/api/dreaming/settings");
  await settings.getByRole("button", { name: "저장", exact: true }).click();
  await expect(on).toBeDisabled();
  await expect(time).toBeDisabled();
  await expect(time).toHaveValue(at);
  held.release();
  await expect(settings.getByRole("status").filter({ hasText: "저장했어요." })).toBeVisible();
  await expect(time).toBeEnabled();
  await expect(time).toHaveValue(at);
  await expect(page.getByTestId("dreaming-state")).toContainText(`기억 정리가 매일 ${at}`);
});

test("다른 곳에서 바꾼 값은 지키고, 새로 불러오기에 실패해도 폼과 초안이 남는다 (리뷰 #195 5차)", async ({
  page,
  browser,
  baseURL,
}) => {
  const me = await newMember(browser, baseURL!, "dreamwriters");
  await signIn(page, baseURL!, me);
  await asAdmin(browser, baseURL!, async () => {});
  await page.goto("/settings/instructions?doc=dreams");
  const settings = page.getByTestId("dreaming-settings");
  const time = settings.getByLabel("실행 시각");
  await expect(time).toHaveValue("03:00");
  // Another tab (the same account) moves the time while this page still shows 03:00.
  const other = laterToday();
  const put = await page.request.put("/api/dreaming/settings", {
    data: { time: other },
    headers: csrf(baseURL!),
  });
  expect(put.status()).toBe(200);
  // This page turns it on and picks the connection — the time it did not touch stays the other tab's.
  await settings.getByRole("checkbox", { name: "기억 정리 켜기" }).check();
  const pick = settings.getByRole("combobox", { name: "연결·모델" });
  const value = await pick.locator("option", { hasText: "Fake Large" }).first().getAttribute("value");
  await pick.selectOption(value!);
  await settings.getByRole("button", { name: "저장", exact: true }).click();
  await expect(settings.getByRole("status").filter({ hasText: "저장했어요." })).toBeVisible();
  await expect(time).toHaveValue(other);
  const mine = (await (await page.request.get("/api/dreaming")).json()) as {
    settings: { time: string; enabled: boolean };
  };
  expect(mine.settings).toMatchObject({ time: other, enabled: true });

  // Refetching fails (503): the form stays on what it has, with its unsaved draft, and says so.
  await time.fill("04:44");
  await page.route("**/api/dreaming", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' })
      : route.continue(),
  );
  const panel = page.getByTestId("dreaming-panel");
  await panel.getByText(/지금 쓰는 정리 프롬프트/).click();
  await panel.getByTestId("dreaming-prompt").fill("취미만 골라 주세요");
  await panel.getByRole("button", { name: "프롬프트 저장" }).click();
  await expect(page.getByTestId("dreaming-load-error")).toBeVisible();
  await expect(settings).toBeVisible();
  await expect(time).toHaveValue("04:44");
  await page.unroute("**/api/dreaming");
});

const STALE = "저장했지만 최신 상태를 불러오지 못했어요";

/** Makes GETs of `url` fail (503) — the save went through, the refetch after it does not. */
async function failReads(page: Page, url: string) {
  await page.route(url, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' })
      : route.fallback(),
  );
}

test("저장은 됐지만 다시 불러오기에 실패하면 보낸 값을 그대로 두고 알린다 (리뷰 #195 6차)", async ({
  page,
  browser,
  baseURL,
}) => {
  const me = await newMember(browser, baseURL!, "dreamstale");
  await signIn(page, baseURL!, me);
  const api = async <T>(url: string) => (await (await page.request.get(url)).json()) as T;

  // 내 지침 → 기억 정리: settings, prompt, 기억 반영 방식.
  await page.goto("/settings/instructions?doc=dreams");
  const settings = page.getByTestId("dreaming-settings");
  const panel = page.getByTestId("dreaming-panel");
  await expect(settings.getByLabel("실행 시각")).toHaveValue("03:00");
  await failReads(page, "**/api/dreaming");
  await failReads(page, "**/api/memory-prefs");
  await settings.getByLabel("실행 시각").fill("11:10");
  await settings.getByRole("button", { name: "저장", exact: true }).click();
  await expect(settings.getByRole("status")).toContainText(STALE);
  await expect(settings.getByLabel("실행 시각")).toHaveValue("11:10");
  expect((await api<{ settings: { time: string } }>("/api/dreaming")).settings.time).toBe("11:10");
  await panel.getByText(/지금 쓰는 정리 프롬프트/).click();
  const prompt = panel.getByTestId("dreaming-prompt");
  await prompt.fill("프롬프트 B");
  await panel.getByRole("button", { name: "프롬프트 저장" }).click();
  await expect(panel.getByRole("status").filter({ hasText: STALE }).last()).toBeVisible();
  await expect(prompt).toHaveValue("프롬프트 B");
  expect((await api<{ prompt: { content: string } }>("/api/dreaming")).prompt.content).toBe("프롬프트 B");
  await page.getByRole("radio", { name: /자동 반영/ }).check();
  await expect(page.getByTestId("memory-mode").getByRole("status")).toContainText(STALE);
  await expect(page.getByRole("radio", { name: /자동 반영/ })).toBeChecked();
  expect((await api<{ applyMode: string }>("/api/memory-prefs")).applyMode).toBe("auto");
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // 설정 → 알림: the 기억 정리 toggle and quiet hours (also: locked while a save is in flight).
  await page.goto("/settings");
  const failed = page.getByRole("checkbox", { name: "내 기억 정리가 실패했을 때" });
  await expect(failed).toBeChecked();
  const on = page.getByLabel("사용", { exact: true });
  await expect(on).toBeEnabled();
  const held = await holdRequests(page, "**/api/notifications/prefs");
  await on.check();
  await page.getByLabel("방해 금지 시작").fill("22:00");
  await page.getByLabel("방해 금지 끝").fill("06:00");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByLabel("방해 금지 시작")).toBeDisabled();
  await expect(page.getByLabel("방해 금지 시작")).toHaveValue("22:00");
  held.release();
  await expect(page.getByText("저장했어요.")).toBeVisible();
  await expect(page.getByLabel("방해 금지 시작")).toHaveValue("22:00");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await failReads(page, "**/api/notifications/prefs");
  await failed.uncheck();
  await expect(page.getByTestId("memory-notifications-stale")).toContainText(STALE);
  await expect(failed).not.toBeChecked();
  await page.getByLabel("방해 금지 시작").fill("21:00");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText(STALE).first()).toBeVisible();
  await expect(page.getByLabel("방해 금지 시작")).toHaveValue("21:00");
  expect(await api<{ quietStart: string; memoryFailed: boolean }>("/api/notifications/prefs")).toMatchObject({
    quietStart: "21:00",
    quietEnd: "06:00",
    memoryFailed: false,
  });
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // The admin: a youth account's 반영 방식 and the server settings' token cap.
  const son = await newMember(browser, baseURL!, "dreamstaleyouth", true);
  await asAdmin(browser, baseURL!, async (admin) => {
    await admin.goto("/admin?tab=dreaming");
    const row = admin.getByTestId("dreaming-user").filter({ hasText: son.name });
    const mode = row.getByRole("combobox", { name: `${son.name} 반영 방식` });
    await expect(mode).toHaveValue("review");
    await failReads(admin, "**/api/admin/dreaming");
    await mode.selectOption("auto");
    await expect(admin.getByTestId("dreaming-youth-stale")).toContainText(STALE);
    await expect(mode).toHaveValue("auto");
    const cap = admin.getByTestId("dreaming-config").getByLabel("1회 토큰 상한");
    const before = await cap.inputValue();
    await cap.fill("302000");
    await admin
      .getByTestId("admin-dreaming")
      .getByRole("button", { name: "저장", exact: true })
      .first()
      .click();
    await expect(admin.getByRole("status").filter({ hasText: STALE }).first()).toBeVisible();
    await expect(cap).toHaveValue("302000");
    await admin.unrouteAll({ behavior: "ignoreErrors" });
    // Back as it was (other tests share the server).
    await cap.fill(before);
    await admin
      .getByTestId("admin-dreaming")
      .getByRole("button", { name: "저장", exact: true })
      .first()
      .click();
    await expect(admin.getByRole("status").filter({ hasText: "저장했어요." })).toBeVisible();
  });
});

/** GETs of `url` fail (503); PUTs too once `putsFail.on` is set. */
async function failing(page: Page, url: string) {
  const putsFail = { on: false };
  const unavailable = { status: 503, contentType: "application/json", body: '{"error":"unavailable"}' };
  await page.route(url, (route) => {
    const m = route.request().method();
    if (m === "GET" || (m === "PUT" && putsFail.on)) return route.fulfill(unavailable);
    return route.fallback();
  });
  return putsFail;
}

test("저장 성공 + 불러오기 실패 뒤 다음 저장이 실패해도 저장된 값으로 돌아간다 (리뷰 #195 7차)", async ({
  page,
  browser,
  baseURL,
}) => {
  const me = await newMember(browser, baseURL!, "dreamseq");
  await signIn(page, baseURL!, me);
  const api = async <T>(url: string) => (await (await page.request.get(url)).json()) as T;

  // 기억 반영 방식: 자동 반영 saved (its refetch fails), then 검토 후 반영 refused → back to 자동 반영 (what is stored).
  await page.goto("/settings/instructions?doc=dreams");
  const auto = page.getByRole("radio", { name: /자동 반영/ });
  const review = page.getByRole("radio", { name: /검토 후 반영/ });
  await expect(review).toBeChecked();
  const modePuts = await failing(page, "**/api/memory-prefs");
  await auto.check();
  await expect(page.getByTestId("memory-mode").getByRole("status")).toContainText(STALE);
  modePuts.on = true;
  await review.check();
  await expect(page.getByTestId("memory-mode").getByRole("alert")).toBeVisible();
  await expect(auto).toBeChecked();
  await expect(page.getByTestId("memory-mode").getByRole("status")).toContainText(STALE);
  expect((await api<{ applyMode: string }>("/api/memory-prefs")).applyMode).toBe("auto");
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // A notification toggle: off saved (refetch fails), then on refused → stays off (what is stored).
  await page.goto("/settings");
  const failed = page.getByRole("checkbox", { name: "내 기억 정리가 실패했을 때" });
  await expect(failed).toBeChecked();
  const prefPuts = await failing(page, "**/api/notifications/prefs");
  await failed.uncheck();
  await expect(page.getByTestId("memory-notifications-stale")).toContainText(STALE);
  prefPuts.on = true;
  await failed.check();
  await expect(failed).not.toBeChecked();
  await expect(page.getByTestId("memory-notifications-stale")).toContainText(STALE);
  expect((await api<{ memoryFailed: boolean }>("/api/notifications/prefs")).memoryFailed).toBe(false);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
