import { expect, test, type Page } from "@playwright/test";
import { ADMIN, MOM, SON, csrf, newConversation, useAccount } from "./helpers.js";

/**
 * Usage (#32): my month in the sidebar and settings, the admin's report with the price table and the daily
 * threshold, the budget switch shown disabled ("추후 제공"), and admin data refused to members.
 * The e2e server runs FakeRuntime without connections: its usage counts requests and tokens, with no cost.
 */

async function openSidebar(page: Page, project: string) {
  if (project === "mobile") await page.getByRole("button", { name: "메뉴 열기" }).click();
}

test("my usage this month shows in the sidebar and in settings, and grows after a reply", async ({
  page,
  baseURL,
}, info) => {
  await useAccount(page, MOM);
  const requests = async () =>
    ((await (await page.request.get("/api/usage/me")).json()) as { total: { requests: number } }).total
      .requests;
  const before = await requests();
  const c = await newConversation(page.request, baseURL!, `사용량 ${info.project.name} ${Date.now()}`);
  const r = await page.request.post(`/api/conversations/${c.id}/messages`, {
    data: { text: "안녕" },
    headers: { ...csrf(baseURL!), "Idempotency-Key": `e2e-usage-${Date.now()}-${Math.random()}` },
  });
  expect(r.status()).toBe(201);
  const { run } = (await r.json()) as { run: { id: string } };
  await expect
    .poll(
      async () =>
        ((await (await page.request.get(`/api/runs/${run.id}`)).json()) as { status: string }).status,
    )
    .toBe("done");
  await expect.poll(requests).toBeGreaterThan(before);

  await page.goto("/");
  await openSidebar(page, info.project.name);
  await expect(page.getByTestId("my-usage")).toContainText(/이번 달 .*\d+회 · .* 토큰/);

  await page.goto("/settings");
  const panel = page.getByRole("region", { name: "내 사용량", exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("my-usage-total")).toContainText("요청");
  await expect(panel.getByRole("table", { name: "런타임" })).toContainText("Claude Code");
});

test("admin: report, breakdowns, price table versions, daily threshold, budget switch disabled", async ({
  page,
}) => {
  await useAccount(page, ADMIN);
  // The usage tab of the admin screen (#35).
  await page.goto("/admin");
  await page.getByRole("tab", { name: "사용량" }).click();
  const section = page.getByRole("region", { name: "사용량", exact: true });
  await expect(section.getByTestId("usage-summary")).toContainText("예상 (일평균 × 남은");
  // Every breakdown table can be shown.
  for (const view of ["런타임별", "모델별", "연결별", "목적별", "사용자별"]) {
    await section.getByText(view, { exact: true }).click();
    await expect(section.getByRole("table", { name: view })).toBeVisible();
  }

  // The budget switch: there, off, disabled, "추후 제공".
  const budget = section.getByTestId("budget-switch");
  await expect(budget.getByRole("checkbox")).toBeDisabled();
  await expect(budget.getByRole("checkbox")).not.toBeChecked();
  await expect(budget).toContainText("추후 제공");

  // A price row saved as a new version.
  const prices = section.getByTestId("price-table");
  await prices.getByRole("button", { name: "모델 추가" }).click();
  const row = prices.getByRole("group").last();
  await row.getByLabel("모델", { exact: true }).fill(`e2e-model-${Date.now()}`);
  await row.getByLabel("입력", { exact: true }).fill("3");
  await row.getByLabel("출력", { exact: true }).fill("15");
  await prices.getByRole("button", { name: "새 버전으로 저장" }).click();
  await expect(prices.getByRole("status")).toContainText(/가격표 v\d+을 저장했어요/);
  await expect(prices).toContainText(/현재 v\d+/);

  // The daily threshold.
  await section.getByLabel("일일 비용 알림 기준 (USD, 선택)").fill("50");
  await section.getByRole("button", { name: "저장", exact: true }).click();
  await expect(section.getByText("하루 비용이 $50.00를 넘으면 하루 한 번 알려 드려요.")).toBeVisible();
});

test("members (the son too) cannot see or change admin usage data", async ({ page, baseURL }) => {
  await useAccount(page, SON);
  for (const url of ["/api/admin/usage", "/api/admin/usage/prices", "/api/admin/usage/settings"])
    expect((await page.request.get(url)).status()).toBe(403);
  const put = await page.request.put("/api/admin/usage/settings", {
    data: { dailyCostThresholdUsd: 1 },
    headers: csrf(baseURL!),
  });
  expect(put.status()).toBe(403);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/$/);
  // Their own usage only.
  expect((await page.request.get("/api/usage/me")).status()).toBe(200);
});
