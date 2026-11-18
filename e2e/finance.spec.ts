import { expect, test, type Page } from "@playwright/test";
import { MOM, useAccount } from "./helpers.js";

/**
 * Finance answers (#30, #185, PRD FR-7.6·7.8): an answer that called finance tools ends with the server's source
 * note — its sources, each with its as-of time next to it, a warning when the answer itself left them out, and the
 * disclaimer. An answer that called none gets no note, whatever came before it in the conversation (#185). The
 * FakeRuntime `/finance` command returns fixed finance tool results (no network); the run manager's check and the
 * chat screen are the real ones.
 */

async function send(page: Page, text: string) {
  const replies = await page.getByTestId("assistant").count();
  await page.getByLabel("메시지 입력").fill(text);
  await page.getByRole("button", { name: "보내기" }).click();
  await expect(page.getByTestId("assistant")).toHaveCount(replies + 1, { timeout: 15_000 });
  const reply = page.getByTestId("assistant").last();
  await expect(reply).toHaveAttribute("data-status", "complete", { timeout: 15_000 });
  return reply;
}

const asOf = (note: ReturnType<Page["getByTestId"]>, source: string) =>
  note.getByTestId("source-data").filter({ hasText: source }).getByTestId("source-as-of");

test("an answer without sources gets the note: sources with their as-of, a warning and the disclaimer", async ({
  page,
}) => {
  await useAccount(page, MOM);
  await page.goto("/");
  const reply = await send(page, "/finance");
  await expect(reply).toContainText("AAPL은 348.51달러");
  const note = reply.getByTestId("source-note");
  await expect(note).toHaveCount(1);
  await expect(note).toBeVisible();
  await expect(asOf(note, "Yahoo Finance")).toHaveText("2026-11-13 16:00 ET 종가");
  await expect(asOf(note, "네이버 증권")).toHaveText("2026-11-13 15:30 KST 종가");
  await expect(note.getByTestId("finance-missing")).toContainText("출처·기준 시각이 빠진");
  await expect(note.getByTestId("source-disclaimer")).toContainText("투자 권유가 아닙니다");
});

test("an answer that cites its numbers gets the note without a warning", async ({ page }) => {
  await useAccount(page, MOM);
  await page.goto("/");
  const note = (await send(page, "/finance cited")).getByTestId("source-note");
  await expect(note.getByTestId("source-disclaimer")).toContainText("투자 권유가 아닙니다");
  await expect(note.getByTestId("finance-missing")).toHaveCount(0);
});

test("#185: a follow-up without tools gets no note; querying again brings sources, as-of and the disclaimer back", async ({
  page,
}) => {
  await useAccount(page, MOM);
  await page.goto("/");
  await send(page, "/finance");
  // The fake echoes the message: the production case — a general answer with figures, no tool.
  const plain = await send(page, "음성 전사는 최대 2시간까지 돼요. 진행자 1명, 게스트 2명이에요.");
  await expect(plain).toContainText("최대 2시간");
  await expect(plain.getByTestId("source-note")).toHaveCount(0);
  await expect(plain).not.toContainText("투자 권유가 아닙니다");
  const again = await send(page, "/finance cited");
  const note = again.getByTestId("source-note");
  await expect(asOf(note, "Yahoo Finance")).toHaveText("2026-11-13 16:00 ET 종가");
  await expect(note.getByTestId("source-disclaimer")).toContainText("투자 권유가 아닙니다");
  await expect(page.getByTestId("source-note")).toHaveCount(2);
});
