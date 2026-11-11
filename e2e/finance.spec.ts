import { expect, test } from "@playwright/test";
import { MOM, useAccount } from "./helpers.js";

/**
 * Finance answers (#30, PRD FR-7.6·7.8): an answer that used finance tools ends with the server's note — the
 * sources and as-of times of its numbers, a warning when the answer itself left them out, and the disclaimer.
 * The FakeRuntime `/finance` command returns fixed finance tool results (no network); the run manager's check
 * and the chat screen are the real ones.
 */

test("an answer without sources gets the note: sources, as-of, a warning and the disclaimer", async ({
  page,
}) => {
  await useAccount(page, MOM);
  await page.goto("/");
  await page.getByLabel("메시지 입력").fill("/finance");
  await page.getByRole("button", { name: "보내기" }).click();
  const reply = page.getByTestId("assistant").last();
  await expect(reply).toContainText("AAPL은 348.51달러");
  const note = reply.getByTestId("finance-note");
  await expect(note).toBeVisible();
  await expect(note).toContainText("Yahoo Finance · 2026-11-13 16:00 ET 종가");
  await expect(note).toContainText("네이버 증권 · 2026-11-13 15:30 KST 종가");
  await expect(note.getByTestId("finance-missing")).toContainText("출처·기준 시각이 빠진");
  await expect(note).toContainText("투자 권유가 아닙니다");
});

test("an answer that cites its numbers gets the note without a warning", async ({ page }) => {
  await useAccount(page, MOM);
  await page.goto("/");
  await page.getByLabel("메시지 입력").fill("/finance cited");
  await page.getByRole("button", { name: "보내기" }).click();
  const note = page.getByTestId("assistant").last().getByTestId("finance-note");
  await expect(note).toContainText("투자 권유가 아닙니다");
  await expect(note.getByTestId("finance-missing")).toHaveCount(0);
});
