import { expect, test, type Page } from "@playwright/test";
import { csrf, MOM, SON, useAccount } from "./helpers.js";

/**
 * Citations (#25, PRD FR-5.1–5.5, 수용 기준 3): `[n]` markers, the source list under the answer with each
 * citation's server-checked status, the preview (hover on desktop, tap on mobile), the missing-citation warning
 * and the research-mode toggle. The FakeRuntime `/cite <scenario>` command makes real `web_fetch` / `cite` calls
 * on the citation fixture pages (served in-process — no network); the check and the screen are the real ones.
 */

const PAGE_A = "https://fixture.agentlee.test/news/chips-a.html";
const SNIPPET = "10월 반도체 수출이 전년 같은 달보다 32% 늘어난 142억 달러로 집계됐다";
const OK = "원문 구절 확인";

async function ask(page: Page, text: string) {
  const before = await page.getByTestId("citation-note").count();
  await page.getByLabel("메시지 입력").fill(text);
  await page.getByRole("button", { name: "보내기" }).click();
  // The reply runs and the note is added at its end: allow for a busy machine (all specs run in parallel).
  await expect(page.getByTestId("citation-note")).toHaveCount(before + 1, { timeout: 15_000 });
  return page.getByTestId("assistant").last();
}

async function newChat(page: Page, text: string) {
  await page.goto("/");
  const reply = await ask(page, text);
  await page.waitForURL(/\/c\/[^/]+$/);
  return { reply, id: page.url().split("/c/")[1]! };
}

test("verified citations: markers, the source list and the preview with 원문 열기", async ({
  page,
  isMobile,
}) => {
  await useAccount(page, MOM);
  const { reply } = await newChat(page, "/cite conflict");
  const markers = reply.getByTestId("citation-marker");
  await expect(markers).toHaveText(["[1]", "[2]", "[3]"]);
  for (const m of await markers.all()) await expect(m).toHaveAttribute("data-status", "verified");
  const rows = reply.getByTestId("citation-source");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("10월 반도체 수출 32% 증가");
  await expect(rows.nth(0)).toContainText("가나다 신문 · 2026-11-10");
  await expect(rows.nth(0)).toContainText(PAGE_A);
  await expect(reply.getByTestId("citation-status")).toHaveText([OK, OK, OK]);
  await expect(reply.getByTestId("citation-missing-warning")).toHaveCount(0);

  // Preview: hover on desktop, tap on mobile.
  const first = markers.nth(0);
  if (isMobile) await first.tap();
  else await first.hover();
  const preview = reply.getByTestId("citation-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText(OK);
  await expect(preview).toContainText(SNIPPET);
  const open = preview.getByRole("link", { name: /원문 열기/ });
  await expect(open).toHaveAttribute("href", PAGE_A);
  await expect(open).toHaveAttribute("target", "_blank");
  await expect(open).toHaveAttribute("rel", /noopener/);
  if (isMobile) {
    await first.tap();
    await expect(preview).toHaveCount(0);
  } else {
    await page.mouse.move(0, 0);
    await expect(preview).toHaveCount(0);
    // A click pins it; Esc closes.
    await first.click();
    await page.mouse.move(0, 0);
    await expect(reply.getByTestId("citation-preview")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(reply.getByTestId("citation-preview")).toHaveCount(0);
  }
});

test("failed citations are never shown as normal: ⚠️ in the marker, the list and the preview", async ({
  page,
  isMobile,
}) => {
  await useAccount(page, MOM);
  const { reply } = await newChat(page, "/cite insufficient");
  await expect(reply.getByTestId("citation-marker")).toHaveText(["[1]", "[2⚠️]", "[3⚠️]"]);
  await expect(reply.getByTestId("citation-status")).toHaveText([
    OK,
    "⚠️ 출처에서 이 내용을 찾지 못했어요",
    "⚠️ 출처를 가져오지 못했어요",
  ]);
  await expect(reply.locator('[data-testid="citation-source"][data-status="verified"]')).toHaveCount(1);
  const failed = reply.getByTestId("citation-marker").nth(1);
  if (isMobile) await failed.tap();
  else await failed.hover();
  const preview = reply.getByTestId("citation-preview");
  await expect(preview).toContainText("⚠️ 출처에서 이 내용을 찾지 못했어요");
  await expect(preview).not.toContainText(OK);
  await expect(preview).toContainText("인용하려던 구절");
  // "출처가 충분하지 않아요." is not a claim: no missing-citation warning here.
  await expect(reply.getByTestId("citation-missing-warning")).toHaveCount(0);
});

test("paragraphs without a citation are marked: 일부 내용에 출처 표시 없음", async ({ page }) => {
  await useAccount(page, MOM);
  const { reply } = await newChat(page, "/cite partial");
  await expect(reply.getByTestId("citation-missing-warning")).toHaveText("⚠️ 일부 내용에 출처 표시 없음");
  await expect(reply.getByTestId("citation-missing")).toHaveText([
    "업계는 내년에도 두 자릿수 증가를 예상해요.⚠️",
    "- 미국 수출 비중이 가장 컸어요⚠️",
  ]);
});

test("existing sources are reused in the same conversation; another conversation's or user's id is unknown", async ({
  page,
  browser,
  baseURL,
}) => {
  await useAccount(page, MOM);
  const { id } = await newChat(page, "/cite conflict");
  const reuse = await ask(page, "/cite reuse");
  await expect(reuse.getByTestId("citation-marker")).toHaveText(["[1]", "[2]", "[3⚠️]"]);
  await expect(reuse.getByTestId("citation-status")).toHaveText([OK, OK, "⚠️ 출처를 가져오지 못했어요"]);

  const list = await page.request.get(`/api/conversations/${id}/sources`);
  const sourceId = ((await list.json()) as { items: { id: string }[] }).items[0]!.id;
  // Same user, another conversation.
  const other = await newChat(page, `/cite-id ${sourceId} ${SNIPPET}`);
  await expect(other.reply.getByTestId("citation-marker")).toHaveText(["[1⚠️]"]);
  await expect(other.reply.getByTestId("citation-status")).toHaveText(["⚠️ 출처를 가져오지 못했어요"]);
  await expect(other.reply.getByTestId("citation-source")).not.toContainText(PAGE_A);

  // Another user.
  const ctx = await browser.newContext({ baseURL: baseURL! });
  const son = await ctx.newPage();
  await useAccount(son, SON);
  const theirs = await newChat(son, `/cite-id ${sourceId} ${SNIPPET}`);
  await expect(theirs.reply.getByTestId("citation-status")).toHaveText(["⚠️ 출처를 가져오지 못했어요"]);
  await ctx.close();
});

test("research mode is a per-conversation toggle kept by the server", async ({ page, baseURL }) => {
  await useAccount(page, MOM);
  const { id } = await newChat(page, "/cite partial");
  const toggle = page.getByTestId("research-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const conv = await page.request.get(`/api/conversations/${id}`, { headers: csrf(baseURL!) });
  expect(((await conv.json()) as { researchMode: boolean }).researchMode).toBe(true);
  await page.reload();
  await expect(page.getByTestId("research-toggle")).toHaveAttribute("aria-pressed", "true");
  // Another conversation is not affected.
  await newChat(page, "/cite partial");
  await expect(page.getByTestId("research-toggle")).toHaveAttribute("aria-pressed", "false");
});
