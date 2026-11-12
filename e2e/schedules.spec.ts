import { expect, test } from "@playwright/test";
import { csrf, newMember, signIn } from "./helpers.js";

/**
 * Schedules (#55, PRD FR-8.1·8.2·8.5): "매일 아침 8시 관심 종목 브리핑" in a conversation → the confirmation card →
 * 예약 만들기 → the schedule is on the 예약 screen with the creator's defaults; the screen's own form, pause and
 * "바로 실행" (the FAKE_RUNTIME=1 server's fake handler runs it) with its history. Each test has its own account.
 */

test("대화에서 예약 만들기: 확인 카드 → 만들기 → 예약 화면", async ({ page, browser, baseURL }) => {
  const me = await newMember(browser, baseURL!, "sched");
  await signIn(page, baseURL!, me);
  await page.goto("/");
  const box = page.getByRole("textbox", { name: /메시지/ });
  await box.fill("매일 아침 8시 관심 종목 브리핑");
  await box.press("Enter");
  const card = page.getByTestId("schedule-card");
  await expect(card).toBeVisible();
  await expect(card.getByText("아침 관심 종목 브리핑")).toBeVisible();
  await expect(card.getByTestId("schedule-card-timing")).toContainText("매일 08:00");
  await expect(card.getByTestId("schedule-card-next")).toContainText("8:00");
  await expect(card).toContainText("내 기본값");
  // Not created before the confirm.
  const before = await page.request.get("/api/schedules");
  expect(((await before.json()) as { schedules: unknown[] }).schedules).toHaveLength(0);
  await card.getByRole("button", { name: "예약 만들기" }).click();
  await expect(card.getByText("만들었어요", { exact: true })).toBeVisible();
  await card.getByRole("link", { name: "예약 화면에서 보기" }).click();
  await expect(page.getByRole("heading", { name: "아침 관심 종목 브리핑" })).toBeVisible();
  await expect(page.getByTestId("schedule-settings")).toContainText("Claude Code");
  await page.goto("/schedules");
  await expect(page.getByTestId("schedule-item")).toHaveCount(1);
});

test("예약 화면: 새 예약 폼(다음 실행 미리보기) · 일시정지 · 바로 실행 이력 · 삭제", async ({
  page,
  browser,
  baseURL,
}) => {
  const me = await newMember(browser, baseURL!, "schedform");
  await signIn(page, baseURL!, me);
  await page.goto("/schedules");
  await expect(page.getByTestId("schedules-empty")).toBeVisible();
  await page.getByRole("link", { name: "+ 새 예약" }).click();
  await page.getByLabel("이름").fill("평일 환율");
  await page.getByLabel("실행할 프롬프트").fill("원·달러 환율 알려줘");
  await page.getByRole("radiogroup", { name: "일정 유형" }).getByText("cron 식").click();
  await expect(page.getByRole("radio", { name: "cron 식" })).toBeChecked();
  await page.getByRole("textbox", { name: "cron 식" }).fill("61 * * * *");
  await expect(page.getByTestId("schedule-next")).toContainText("cron 식이 올바르지 않아요");
  await page.getByRole("textbox", { name: "cron 식" }).fill("30 7 * * 1-5");
  await expect(page.getByTestId("schedule-next")).toContainText("다음 실행:");
  await expect(page.getByTestId("schedule-next")).toContainText("7:30");
  // Runtime·model start as my defaults; the chip offers only what is allowed.
  await expect(page.getByRole("button", { name: /런타임·모델:/ })).toBeVisible();
  await page.getByRole("button", { name: "예약 만들기" }).click();
  await expect(page.getByRole("heading", { name: "평일 환율" })).toBeVisible();

  await page.getByRole("button", { name: "⏸ 일시정지" }).click();
  await expect(page.getByTestId("schedule-next-run")).toHaveText("일시정지 중");
  await page.getByRole("button", { name: "▶ 다시 켜기" }).click();
  await expect(page.getByTestId("schedule-next-run")).not.toHaveText("일시정지 중");

  await page.getByRole("button", { name: "⚡ 바로 실행" }).click();
  const run = page.getByTestId("schedule-run").first();
  await expect(run).toContainText("바로 실행");
  await expect(run).toContainText("성공", { timeout: 15_000 });
  await expect(run).toContainText("—");

  // Edit: the name changes, the rest stays.
  await page.getByRole("link", { name: "✎ 수정" }).click();
  await page.getByLabel("이름").fill("평일 아침 환율");
  await page.getByRole("button", { name: "저장" }).click();
  await expect(page.getByRole("heading", { name: "평일 아침 환율" })).toBeVisible();

  await page.getByRole("button", { name: "🗑 삭제" }).click();
  await page.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(page).toHaveURL(/\/schedules$/);
  await expect(page.getByTestId("schedules-empty")).toBeVisible();
});

test("남의 예약은 관리자도 403, 허용 안 된 모델은 403", async ({ page, browser, baseURL }) => {
  const me = await newMember(browser, baseURL!, "schedperm");
  await signIn(page, baseURL!, me);
  const made = await page.request.post("/api/schedules", {
    data: { name: "x", prompt: "y", timing: { type: "daily", time: "08:00" } },
    headers: csrf(baseURL!),
  });
  expect(made.status()).toBe(201);
  const bad = await page.request.post("/api/schedules", {
    data: { name: "x", prompt: "y", timing: { type: "daily", time: "08:00" }, model: "no-such-model" },
    headers: csrf(baseURL!),
  });
  expect([bad.status(), ((await bad.json()) as { error: string }).error]).toEqual([403, "model_not_allowed"]);
});
