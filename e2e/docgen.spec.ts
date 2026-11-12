import crypto from "node:crypto";
import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { readDocx, readPdf } from "../apps/server/test/helpers/doc-parse.js";
import { SON, newConversation, useAccount } from "./helpers.js";

/**
 * Document generation (#49, PRD FR-4.4·4.7): "이 내용을 DOCX 보고서로" in the chat — the FakeRuntime calls our real
 * `doc_create` and `artifact_create` tools (fake.ts `/doc`), the reply shows the file's download chip and the
 * document artifact, and the downloaded file opens with the report's title, table and paragraph. HWP is refused
 * with a guidance message. Desktop and mobile projects.
 */

async function send(page: Page, text: string) {
  const box = page.getByLabel("메시지 입력");
  await box.fill(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
}

const lastAssistant = (page: Page) => page.getByTestId("assistant").last();
const TITLE = "제주 가족 여행 보고서";

async function openChat(page: Page, baseURL: string) {
  await useAccount(page, SON);
  const conv = await newConversation(page.request, baseURL, `문서 ${crypto.randomUUID().slice(0, 8)}`);
  await page.goto(`/c/${conv.id}`);
  return conv;
}

test("'이 내용을 DOCX 보고서로' → the reply's download chip → the file opens; the document artifact links it", async ({
  page,
  baseURL,
}) => {
  await openChat(page, baseURL!);
  await send(page, "/doc docx");
  const reply = lastAssistant(page);
  await expect(reply).toHaveAttribute("data-status", "complete");
  const chip = reply.getByTestId("file-ref");
  await expect(chip).toHaveText(new RegExp(`${TITLE}\\.docx`));

  // The document artifact made in the same reply opens in the panel with a download of the same file.
  const panel = page.getByTestId("artifact-panel");
  await expect(panel).toBeVisible();
  const link = panel.getByTestId("document-download");
  await expect(link).toContainText(`${TITLE}.docx`);
  expect(await link.getAttribute("href")).toBe(await chip.getAttribute("href"));
  // On a phone the panel covers the chat: closed to reach the reply's chip.
  await page.getByTestId("artifact-panel-close").click();
  await expect(panel).toHaveCount(0);

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
  baseURL,
}) => {
  const conv = await openChat(page, baseURL!);
  await send(page, "/doc pdf");
  const reply = lastAssistant(page);
  await expect(reply).toHaveAttribute("data-status", "complete");
  const href = await reply.getByTestId("file-ref").getAttribute("href");
  const r = await page.request.get(href!);
  expect(r.status()).toBe(200);
  expect(r.headers()["content-type"]).toContain("application/pdf");
  expect(r.headers()["content-disposition"]).toMatch(/^attachment; /);
  const pdf = await readPdf(Buffer.from(await r.body()));
  expect(pdf.text.replace(/\s+/g, "")).toContain(TITLE.replace(/\s+/g, ""));
  // The document artifact's panel opened with the reply (full screen on a phone): closed to type again.
  await page.getByTestId("artifact-panel-close").click();

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
