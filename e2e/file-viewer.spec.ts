import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { csrf, newConversation, newMember, signIn } from "./helpers.js";

/**
 * The file viewer (#24, PRD FR-4.5, 수용 기준 2): a file citation opens the file at its place and highlights it —
 * "report.pdf · 12쪽" → page 12 with the sentence marked, "과제안내.hwp · 3번째 표 · 2행" → that table row, a scanned
 * PDF → the passage's box on the page. The FakeRuntime commands (`/file-compare`, `/file-scan`) make real file tool
 * calls on the real sandboxed extraction. A family member the conversation is shared with opens the same place
 * from the shared screen; someone else gets nothing. Fresh accounts per test (and so per project).
 */

const FIX = path.join(import.meta.dirname, "../fixtures/extract");
const REPORT = fs.readFileSync(path.join(FIX, "report.pdf"));
const ASSIGNMENT = fs.readFileSync(path.join(FIX, "assignment.hwp"));
const SCANNED = fs.readFileSync(path.join(FIX, "scanned.pdf"));
const SUMMARY = "Summary: the river clean-up removed 340 kg of waste.";
const ROW2 = "학교 누리집 과제방에 PDF로 올립니다.";

test.use({ serviceWorkers: "block" });

// As file-citations.spec.ts: the e2e server runs in production mode, where the extractor only runs in the macOS
// sandbox. Elsewhere the same resolution runs in apps/server/test/file-viewer.test.ts (extractor in process).
test.skip(
  process.platform !== "darwin",
  "file extraction needs macOS sandbox-exec on a production-mode server; covered by file-viewer.test.ts elsewhere",
);

async function uploadAndAsk(
  page: Page,
  files: { name: string; mimeType: string; buffer: Buffer }[],
  command: string,
) {
  await page.getByTestId("file-input").setInputFiles(files);
  const chips = page.getByTestId("attachment");
  await expect(chips).toHaveCount(files.length);
  for (let i = 0; i < files.length; i++) await expect(chips.nth(i)).toHaveAttribute("data-status", "done");
  await page.getByLabel("메시지 입력").fill(command);
  await page.getByLabel("메시지 입력").press("Enter");
  await expect(page.getByTestId("citation-note")).toHaveCount(1, { timeout: 60_000 });
  return page.getByTestId("assistant").last();
}

test("PDF + HWP 비교: 12쪽 인용 → 12쪽의 그 문장, HWP 인용 → 3번째 표 2행 (shared viewer too, nobody else)", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const owner = await newMember(browser, baseURL!, "viewer-owner");
  const family = await newMember(browser, baseURL!, "viewer-family");
  const stranger = await newMember(browser, baseURL!, "viewer-stranger");
  await signIn(page, baseURL!, owner);
  const c = await newConversation(page.request, baseURL!, `두 문서 비교 ${Date.now()}`);
  await page.goto(`/c/${c.id}`);
  const reply = await uploadAndAsk(
    page,
    [
      { name: "report.pdf", mimeType: "application/pdf", buffer: REPORT },
      { name: "과제안내.hwp", mimeType: "application/x-hwp", buffer: ASSIGNMENT },
    ],
    "/file-compare",
  );
  await expect(reply.getByTestId("citation-status")).toHaveText(["원문 구절 확인", "원문 구절 확인"]);
  const links = reply.getByTestId("citation-file-link");
  await expect(links).toHaveText(["report.pdf · 12쪽", "과제안내.hwp · 3번째 표 · 2행 · 2열"]);

  // [1] from the preview (a tap or click on the marker, then the link — no hover needed).
  await reply.getByTestId("citation-marker").first().click();
  await reply.getByTestId("citation-open-file").click();
  await expect(page).toHaveURL(new RegExp(`/c/${c.id}/files/[^/?]+\\?loc=`));
  const status = page.getByTestId("file-view-status");
  await expect(status).toHaveAttribute("data-status", "exact");
  await expect(status).toContainText("12쪽");
  const unit = page.getByTestId("file-view-unit");
  await expect(unit).toHaveCount(1);
  await expect(unit).toHaveAttribute("data-page", "12");
  await expect(unit).toBeInViewport();
  await expect(page.getByTestId("file-view-hit")).toHaveText(SUMMARY);
  await expect(unit.getByTestId("file-view-box-hit")).toBeVisible();
  const pdfUrl = page.url();

  // [2] from the source list: the HWP row.
  await page.getByTestId("file-view-back").click();
  await expect(page).toHaveURL(new RegExp(`/c/${c.id}$`));
  await page.getByTestId("assistant").last().getByTestId("citation-file-link").nth(1).click();
  await expect(page.getByTestId("file-view-status")).toHaveAttribute("data-status", "exact");
  const row = page.getByTestId("file-view-unit");
  await expect(row).toHaveAttribute("data-row", "2");
  await expect(row.locator("xpath=ancestor::div[@data-table][1]")).toHaveAttribute("data-table", "3");
  await expect(row).toContainText("제출 방법");
  await expect(row).toBeInViewport();
  await expect(page.getByTestId("file-view-hit")).toHaveText(ROW2);
  const hwpUrl = page.url();

  // Shared live with one family member: the shared screen's citations open the same places.
  const share = await page.request.post(`/api/conversations/${c.id}/shares`, {
    data: { target: { audience: "users", userIds: [family.id] }, mode: "live" },
    headers: csrf(baseURL!),
  });
  expect(share.status()).toBe(201);
  const shareId = ((await share.json()) as { id: string }).id;
  const fctx = await browser.newContext({ baseURL: baseURL! });
  const fpage = await fctx.newPage();
  await signIn(fpage, baseURL!, family);
  await fpage.goto(`/shared/${shareId}`);
  await fpage.getByTestId("citation-file-link").nth(1).click();
  await expect(fpage.getByTestId("file-view-status")).toHaveAttribute("data-status", "exact");
  await expect(fpage.getByTestId("file-view-hit")).toHaveText(ROW2);
  await fctx.close();

  // Someone it is not shared with: the same addresses open nothing.
  const sctx = await browser.newContext({ baseURL: baseURL! });
  const spage = await sctx.newPage();
  await signIn(spage, baseURL!, stranger);
  for (const url of [pdfUrl, hwpUrl]) {
    await spage.goto(url);
    await expect(spage.getByTestId("file-view-refused")).toBeVisible();
    await expect(spage.getByTestId("file-view-hit")).toHaveCount(0);
  }
  await sctx.close();

  // A locator of other bytes highlights nothing, and says so.
  const stale = new URL(hwpUrl);
  const loc = JSON.parse(stale.searchParams.get("loc")!) as Record<string, unknown>;
  stale.searchParams.set("loc", JSON.stringify({ ...loc, fileRevision: "0".repeat(64) }));
  await page.goto(stale.pathname + stale.search);
  await expect(page.getByTestId("file-view-status")).toHaveAttribute("data-status", "stale");
  await expect(page.getByTestId("file-view-unit")).toHaveCount(0);
  await expect(page.getByTestId("file-view-hit")).toHaveCount(0);
});

test("스캔 PDF 인용 → 그 쪽의 글자 상자 강조", async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const owner = await newMember(browser, baseURL!, "viewer-scan");
  await signIn(page, baseURL!, owner);
  const c = await newConversation(page.request, baseURL!, `스캔 ${Date.now()}`);
  await page.goto(`/c/${c.id}`);
  const reply = await uploadAndAsk(
    page,
    [{ name: "scanned.pdf", mimeType: "application/pdf", buffer: SCANNED }],
    "/file-scan",
  );
  await expect(reply.getByTestId("citation-status")).toHaveText(["원문 구절 확인"]);
  await reply.getByTestId("citation-file-link").click();
  await expect(page.getByTestId("file-view-status")).toHaveAttribute("data-status", "exact");
  const unit = page.getByTestId("file-view-unit");
  await expect(unit).toHaveAttribute("data-page", "1");
  await expect(page.getByTestId("file-view-hit")).toHaveText("가족 과제 안내문 확인");
  const box = unit.getByTestId("file-view-box-hit");
  await expect(box).toBeVisible();
  // The box is on the second line of the scan: below the top of the page map.
  const map = await unit.locator(".fv-map").boundingBox();
  const b = await box.boundingBox();
  expect(b!.y).toBeGreaterThan(map!.y + 2);
  expect(b!.width).toBeGreaterThan(0);
});
