import crypto from "node:crypto";
import fs from "node:fs";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { readDocx, readPdf } from "../apps/server/test/helpers/doc-parse.js";
import { backToChat, newConversation, newMember, sendMessage as send, signIn } from "./helpers.js";

/**
 * Document generation (#49, PRD FR-4.4·4.7): "이 내용을 DOCX 보고서로" in the chat — the FakeRuntime calls our real
 * `doc_create` and `artifact_create` tools (fake.ts `/doc`), the reply shows the file's download chip and the
 * document artifact, and the downloaded file opens with the report's title, table and paragraph. HWP is refused
 * with a guidance message. Desktop and mobile projects.
 *
 * The e2e server is a production build, and production always makes documents in the macOS sandbox (the in-process
 * test switch is refused there, docs/ops.md §29.6) — so this spec runs where that sandbox exists. Elsewhere (Linux
 * CI) generation answers `doc_unavailable` and the spec is skipped; the same scenario runs on every platform in
 * `apps/server/test/docgen.test.ts` (FakeRuntime and both runtimes' recorded protocols).
 */
test.skip(
  process.platform !== "darwin",
  "document generation needs the macOS sandbox in a production server",
);

const lastAssistant = (page: Page) => page.getByTestId("assistant").last();
const TITLE = "제주 가족 여행 보고서";

/**
 * A youth account of its own for each test: the document worker takes one run per user at a time (`DOC_SLOTS`,
 * shared with the reference export, #26), and the tests of both projects run at once.
 */
async function openChat(page: Page, browser: Browser, baseURL: string) {
  await signIn(page, baseURL, await newMember(browser, baseURL, "doc-son", true));
  const conv = await newConversation(page.request, baseURL, `문서 ${crypto.randomUUID().slice(0, 8)}`);
  await page.goto(`/c/${conv.id}`);
  return conv;
}

test("'이 내용을 DOCX 보고서로' → the reply's download chip → the file opens; the document artifact links it", async ({
  page,
  browser,
  baseURL,
}) => {
  await openChat(page, browser, baseURL!);
  await send(page, "/doc docx");
  // The document artifact made in the reply is shown on its page (#172) with a download of the file.
  const link = page.getByTestId("artifact-page").getByTestId("document-download");
  await expect(link).toContainText(`${TITLE}.docx`);
  const href = await link.getAttribute("href");
  await backToChat(page);
  const reply = lastAssistant(page);
  await expect(reply).toHaveAttribute("data-status", "complete");
  const chip = reply.getByTestId("file-ref");
  await expect(chip).toHaveText(new RegExp(`${TITLE}\\.docx`));
  expect(await chip.getAttribute("href")).toBe(href);

  // A real download through the browser (#22's original-file route).
  const [download] = await Promise.all([page.waitForEvent("download"), chip.click()]);
  expect(download.suggestedFilename()).toBe(`${TITLE}.docx`);
  const doc = await readDocx(fs.readFileSync((await download.path())!));
  expect(doc.paragraphs[0]).toBe(TITLE);
  expect(doc.text).toContain("가족 네 명이 제주도 동쪽을 중심으로 여행했다.");
  expect(doc.tables[0]![1]).toEqual(["숙박", "480000", "3박"]);
});

test("PDF: Korean text is in the file (embedded font) and HWP is refused with a guidance message", async ({
  page,
  browser,
  baseURL,
}) => {
  const conv = await openChat(page, browser, baseURL!);
  await send(page, "/doc pdf");
  // Its document artifact is shown on its page (#172): back to the conversation.
  await backToChat(page);
  const reply = lastAssistant(page);
  await expect(reply).toHaveAttribute("data-status", "complete");
  const href = await reply.getByTestId("file-ref").getAttribute("href");
  const r = await page.request.get(href!);
  expect(r.status()).toBe(200);
  expect(r.headers()["content-type"]).toContain("application/pdf");
  expect(r.headers()["content-disposition"]).toMatch(/^attachment; /);
  const pdf = await readPdf(Buffer.from(await r.body()));
  expect(pdf.text.replace(/\s+/g, "")).toContain(TITLE.replace(/\s+/g, ""));
  await send(page, "/doc hwp");
  const refused = lastAssistant(page);
  await expect(refused).toHaveAttribute("data-status", "complete");
  await expect(refused).toContainText("한글 파일은 만들 수 없어요");
  await expect(refused.getByTestId("file-ref")).toHaveCount(0);
  const list = (await (await page.request.get(`/api/conversations/${conv.id}/files`)).json()) as {
    items: { name: string }[];
  };
  expect(list.items.map((f) => f.name)).toEqual([`${TITLE}.pdf`]);
});
