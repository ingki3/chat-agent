import crypto from "node:crypto";
import { expect, test, type Frame, type Page } from "@playwright/test";
import { MOM, newConversation, newMember, signIn, useAccount } from "./helpers.js";

/**
 * Finance table and chart artifacts and 관심 종목 (#31, PRD FR-7.5·7.7, 수용 기준 4, M4 completion criterion).
 * "AAPL, 005930 6개월 비교 차트" goes through the FakeRuntime to our real `finance_chart` (FAKE_RUNTIME=1 answers the
 * finance URLs with synthetic histories — no network); the table part, the two artifacts, the chart page's basis
 * and zoom switches and the note are the real ones. Desktop and mobile.
 */

async function send(page: Page, text: string) {
  const box = page.getByLabel("메시지 입력");
  await box.fill(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
}

async function frameOf(page: Page): Promise<Frame> {
  const el = page.getByTestId("artifact-panel").getByTestId("artifact-frame");
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
  const reply = page.getByTestId("assistant").last();
  await expect(reply).toHaveAttribute("data-status", "complete", { timeout: 20_000 });
  // The reply's artifact opens the panel by itself (#28); on a phone it covers the chat — close it to read the reply.
  const panel = page.getByTestId("artifact-panel");
  await expect(panel).toBeVisible();
  await page.getByTestId("artifact-panel-close").click();
  await expect(panel).toHaveCount(0);

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

  // The finance note: sources and as-of, the disclaimer.
  const note = reply.getByTestId("finance-note");
  await expect(note).toContainText(/Yahoo Finance · \d{4}-\d{2}-\d{2} 16:00 ET 종가/);
  await expect(note).toContainText(/네이버 증권 · \d{4}-\d{2}-\d{2} 15:30 KST 종가/);
  await expect(note).toContainText("투자 권유가 아닙니다");

  // The chart in the panel: basis and zoom switches (no script), sources and the exchange rate under it.
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

test("관심 종목: search, add, remove — and an account without finance sees why it cannot", async ({
  page,
  browser,
  baseURL,
}) => {
  const me = await newMember(browser, baseURL!, "watch");
  await signIn(page, baseURL!, me);
  await page.goto("/watchlist");
  await expect(page.getByTestId("watchlist-page")).toBeVisible();
  await page.getByLabel("종목 검색").fill("삼성전자");
  await page.getByRole("button", { name: "검색" }).click();
  const results = page.getByTestId("watch-results");
  await expect(results).toContainText("005930");
  await results.getByRole("button", { name: "삼성전자 추가", exact: true }).click();
  const items = page.getByTestId("watch-item");
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("삼성전자");
  await expect(results.getByRole("button", { name: "삼성전자 추가", exact: true })).toHaveText("담김");
  // A US ticker as typed.
  await page.getByLabel("종목 검색").fill("aapl");
  await page.getByRole("button", { name: "검색" }).click();
  await results.getByRole("button", { name: "AAPL 추가" }).click();
  await expect(items).toHaveCount(2);
  await page.reload();
  await expect(items).toHaveCount(2);
  await items.first().getByRole("button", { name: /제거/ }).click();
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("AAPL");

  // A youth account (finance hidden by default, #30): no markets, nothing to search.
  const ctx = await browser.newContext({ baseURL: baseURL! });
  const sonPage = await ctx.newPage();
  const son = await newMember(browser, baseURL!, "teen", true);
  await signIn(sonPage, baseURL!, son);
  await sonPage.goto("/watchlist");
  await expect(sonPage.getByTestId("watchlist-no-finance")).toBeVisible();
  await expect(sonPage.getByLabel("종목 검색")).toHaveCount(0);
  await ctx.close();
});
