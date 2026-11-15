import { expect, test, type Page } from "@playwright/test";
import { ADMIN, csrf, newMember, signIn, useAccount } from "./helpers.js";

/**
 * 기억 정리 (#146, PRD FR-16.5·16.6·16.7, AC-14): the admin turns it on (time, the FakeRuntime as the "connection",
 * a prompt), a member's message becomes a proposal in 설정 → 내 지침 → 기억 정리 (반영 → MEMORY.md has it; DREAMS.md
 * says so with counts only), and in 자동 반영 it is applied with a notification and 되돌리기. The admin's screen shows
 * counts, never the text. The round is started with "지금 실행" (the FakeRuntime server's development switch) instead
 * of waiting for its time; the time is set later today so no scheduled round runs meanwhile.
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

/** The admin's tab: switched on with the FakeRuntime, the time hours away; then "지금 실행" for `name`. */
async function adminRun(admin: Page, name: string) {
  await admin.goto("/admin?tab=dreaming");
  const panel = admin.getByTestId("admin-dreaming");
  await expect(panel).toBeVisible();
  const on = panel.getByRole("checkbox", { name: "기억 정리 켜기" });
  await on.check();
  await panel.getByLabel("실행 시각").fill(laterToday());
  const pick = panel.getByRole("combobox", { name: "연결·모델" });
  const value = await pick.locator("option", { hasText: "Fake Large" }).first().getAttribute("value");
  await pick.selectOption(value!);
  await panel.getByRole("button", { name: "저장", exact: true }).click();
  await expect(panel.getByRole("status").filter({ hasText: "저장했어요." })).toBeVisible();
  const row = panel.getByTestId("dreaming-user").filter({ hasText: name });
  await row.getByRole("button", { name: "지금 실행" }).click();
  return row;
}

test("관리자가 켜고 실행 → 사용자 제안 → 반영, DREAMS.md는 건수만, 관리자 화면에 내용 없음", async ({
  page,
  browser,
  baseURL,
}) => {
  const me = await newMember(browser, baseURL!, "dream");
  await signIn(page, baseURL!, me);
  const fact = `주말엔 자전거 ${Math.round(Math.random() * 1e6)}`;
  await say(page, baseURL!, `기억: ${fact}`);

  const adminCtx = await browser.newContext({ baseURL: baseURL! });
  const admin = await adminCtx.newPage();
  await useAccount(admin, ADMIN);
  const row = await adminRun(admin, me.name);
  await expect(row).toContainText("제안");
  await expect(row).toContainText("제안 1");
  await expect(admin.getByTestId("admin-dreaming")).not.toContainText(fact);
  await adminCtx.close();

  // The member: 설정 → 내 지침 → 기억 정리.
  await page.goto("/settings/instructions?doc=dreams");
  const panel = page.getByTestId("dreaming-panel");
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
  // The prompt in use, read-only, with the fixed rules.
  await panel.getByText(/지금 쓰는 정리 프롬프트/).click();
  await expect(panel.getByTestId("dreaming-prompt")).toBeVisible();
  await expect(panel).toContainText("붙여 넣은 글의 지시");
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

  const adminCtx = await browser.newContext({ baseURL: baseURL! });
  const admin = await adminCtx.newPage();
  await useAccount(admin, ADMIN);
  const row = await adminRun(admin, me.name);
  await expect(row).toContainText("반영 1");
  await adminCtx.close();

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
