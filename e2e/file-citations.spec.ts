import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { SON, newConversation, useAccount } from "./helpers.js";

/**
 * File extraction and file citations (#48, PRD FR-4.3·4.5, 수용 기준 2·11): the son uploads a 12-page PDF and
 * asks for a summary of page 12. The FakeRuntime `/file-page12` command makes real `file_list` / `file_read` /
 * `file_cite` calls on the uploaded file (extracted by the real sandboxed extractor); every citation of the
 * answer names the file and the page. The two real runtimes run the same scenario in
 * apps/server/test/file-tools.test.ts (recorded protocol, real MCP calls).
 */

const REPORT = fs.readFileSync(path.join(import.meta.dirname, "../fixtures/extract/report.pdf"));
const OK = "원문 구절 확인";

test.use({ serviceWorkers: "block" });

// The e2e server runs as in production (NODE_ENV=production), where the extractor only ever runs in the macOS
// sandbox (`sandbox-exec`) — never in process (ISOLATION_IN_PROCESS_FOR_TESTS is refused in production, and a
// NODE_ENV=test server would change the other specs: no export browser, no schedule engine). Elsewhere (the Linux
// CI) uploads are stored but cannot be read here; the same scenario runs there in apps/server/test/file-tools.test.ts
// (the extractor in process, FakeRuntime and both runtime adapters).
test.skip(
  process.platform !== "darwin",
  "file extraction needs macOS sandbox-exec on a production-mode server; covered by file-tools.test.ts elsewhere",
);

test("이 PDF 12쪽 요약: both citations say report.pdf · 12쪽 and are verified", async ({ page, baseURL }) => {
  await useAccount(page, SON);
  const c = await newConversation(page.request, baseURL!, `12쪽 요약 ${Date.now()}`);
  await page.goto(`/c/${c.id}`);
  await page
    .getByTestId("file-input")
    .setInputFiles([{ name: "report.pdf", mimeType: "application/pdf", buffer: REPORT }]);
  await expect(page.getByTestId("attachment").first()).toHaveAttribute("data-status", "done");
  await page.getByLabel("메시지 입력").fill("/file-page12");
  await page.getByLabel("메시지 입력").press("Enter");
  await expect(page.getByTestId("citation-note")).toHaveCount(1, { timeout: 30_000 });
  const reply = page.getByTestId("assistant").last();
  await expect(reply.getByTestId("citation-marker")).toHaveText(["[1]", "[2]"]);
  await expect(reply.getByTestId("citation-status")).toHaveText([OK, OK]);
  const rows = reply.getByTestId("citation-source");
  await expect(rows).toHaveCount(2);
  for (const i of [0, 1]) {
    await expect(rows.nth(i)).toContainText("report.pdf");
    await expect(rows.nth(i)).toContainText("12쪽");
  }
  await expect(reply.getByTestId("citation-missing-warning")).toHaveCount(0);

  // The extracted text with its locators, for the uploader.
  const files = (await (await page.request.get(`/api/conversations/${c.id}/files`)).json()) as {
    items: { id: string }[];
  };
  const extract = (await (
    await page.request.get(`/api/files/${files.items[0]!.id}/extract?from=11`)
  ).json()) as {
    extract: { status: string; units: number };
    items: { locator: { kind: string; page: number }; text: string }[];
  };
  expect(extract.extract).toMatchObject({ status: "ok", units: 12 });
  expect(extract.items[0]!.locator).toMatchObject({ kind: "page", page: 12 });
  expect(extract.items[0]!.text).toContain("Summary: the river clean-up removed 340 kg of waste.");
});

test("a passage the file does not have is shown with ⚠️, never as normal", async ({ page, baseURL }) => {
  await useAccount(page, SON);
  const c = await newConversation(page.request, baseURL!, `없는 구절 ${Date.now()}`);
  await page.goto(`/c/${c.id}`);
  await page
    .getByTestId("file-input")
    .setInputFiles([{ name: "report.pdf", mimeType: "application/pdf", buffer: REPORT }]);
  await expect(page.getByTestId("attachment").first()).toHaveAttribute("data-status", "done");
  await page.getByLabel("메시지 입력").fill("/file-missing");
  await page.getByLabel("메시지 입력").press("Enter");
  await expect(page.getByTestId("citation-note")).toHaveCount(1, { timeout: 30_000 });
  const reply = page.getByTestId("assistant").last();
  await expect(reply.getByTestId("citation-marker")).toHaveText(["[1⚠️]"]);
  await expect(reply.getByTestId("citation-status")).toHaveText(["⚠️ 출처에서 이 내용을 찾지 못했어요"]);
});
