import crypto from "node:crypto";
import { expect, test, type Frame, type Page } from "@playwright/test";
import { MOM, backToChat, newConversation, sendMessage as send, useAccount } from "./helpers.js";

/**
 * Finance table and chart artifacts (#31, PRD FR-7.5, 수용 기준 4, M4 completion criterion); 관심 종목 (FR-7.7) was removed
 * in #187.
 * "AAPL, 005930 6개월 비교 차트" goes through the FakeRuntime to our real `finance_chart` (FAKE_RUNTIME=1 answers the
 * finance URLs with synthetic histories — no network); the table part, the two artifacts, the chart page's basis
 * and zoom switches and the note are the real ones. Desktop and mobile.
 */

async function frameOf(page: Page): Promise<Frame> {
  const el = page.getByTestId("artifact-page").getByTestId("artifact-frame");
  await expect(el).toHaveAttribute("sandbox", "allow-scripts");
  const frame = await (await el.elementHandle())!.contentFrame();
  expect(frame).not.toBeNull();
  return frame!;
}

test('"AAPL, 005930 6개월 비교 차트": table part, table and chart artifacts with sources and as-of', async ({
  page,
  baseURL,
}) => {
  await useAccount(page, MOM);
  const conv = await newConversation(page.request, baseURL!, `금융 차트 ${crypto.randomUUID().slice(0, 6)}`);
  await page.goto(`/c/${conv.id}`);
  await send(page, "AAPL, 005930 6개월 비교 차트");
  // The reply's artifact is shown on its page by itself (#28, #172): back to the conversation to read the reply.
  await expect(page.getByTestId("artifact-page")).toBeVisible({ timeout: 20_000 });
  await backToChat(page);
  const reply = page.getByTestId("assistant").last();
  await expect(reply).toHaveAttribute("data-status", "complete", { timeout: 20_000 });

  // Two artifact cards: the table and the chart.
  const cards = reply.getByTestId("artifact-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.filter({ hasText: "가격 표" })).toHaveCount(1);
  await expect(cards.filter({ hasText: "수익률 비교" })).toHaveCount(1);

  // The table part: source and as-of columns on every row, sortable.
  const table = reply.getByTestId("table-part");
  await expect(table.getByRole("columnheader", { name: "출처", exact: true })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "기준 시각", exact: true })).toBeVisible();
  await expect(table.locator("tbody tr").first()).toContainText(/(Yahoo Finance|네이버 증권)/);
  const ret = table.getByRole("columnheader", { name: /^수익률 원화 기준/ });
  await expect(ret).toHaveAttribute("aria-sort", "none");
  await ret.getByRole("button").click();
  await expect(ret).toHaveAttribute("aria-sort", "ascending");
  await ret.getByRole("button").click();
  await expect(ret).toHaveAttribute("aria-sort", "descending");

  // The source note (#185): each source with its as-of time next to it, the disclaimer.
  const note = reply.getByTestId("source-note");
  // A source row whose as-of time (next to its name) reads `at` — the chart may list one source more than once.
  const row = (source: string, at: RegExp) =>
    note
      .getByTestId("source-data")
      .filter({ hasText: source })
      .filter({ has: page.getByTestId("source-as-of").filter({ hasText: at }) });
  await expect(row("Yahoo Finance", /^\d{4}-\d{2}-\d{2} 16:00 ET 종가$/).first()).toBeVisible();
  await expect(row("네이버 증권", /^\d{4}-\d{2}-\d{2} 15:30 KST 종가$/).first()).toBeVisible();
  await expect(note.getByTestId("source-disclaimer")).toContainText("투자 권유가 아닙니다");

  // The chart on its page: basis and zoom switches (no script), sources and the exchange rate under it.
  await cards.filter({ hasText: "수익률 비교" }).click();
  const frame = await frameOf(page);
  await expect(frame.locator(".src li")).toHaveCount(2);
  await expect(frame.locator(".src")).toContainText("AAPL: Yahoo Finance");
  await expect(frame.locator(".note").first()).toContainText("환율: Yahoo Finance USD/KRW");
  await expect(frame.locator(".v0.z0")).toBeVisible();
  await expect(frame.locator(".v1.z0")).toBeHidden();
  await frame.locator("label[for=cv1]").click(); // 달러 기준
  await expect(frame.locator(".v1.z0")).toBeVisible();
  await expect(frame.locator(".v0.z0")).toBeHidden();
  await frame.locator("label[for=cz2]").click(); // 1개월
  await expect(frame.locator(".v1.z2")).toBeVisible();
  // Tooltips: a hover band per date naming both symbols.
  await expect(frame.locator(".v1.z2 rect.hit title").first()).toHaveText(/AAPL: .* %\n005930: .* %/);
});

test("관심 종목 is gone (#187): no sidebar shortcut, and the old address goes home", async ({ page }) => {
  await useAccount(page, MOM);
  await page.goto("/");
  // The sidebar's links (in the DOM on desktop and, closed, on mobile): the shortcuts are there, 관심 종목 is not.
  await expect(page.locator('a[href="/schedules"]')).toHaveCount(1);
  await expect(page.locator('a[href="/watchlist"]')).toHaveCount(0);
  await expect(page.getByText("관심 종목")).toHaveCount(0);
  await page.goto("/watchlist");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("찾을 수 없는 페이지")).toHaveCount(0);
  const api = await page.request.get("/api/watchlist");
  expect(api.status()).toBe(404);
});
