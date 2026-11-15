import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { csrf, newMember, signIn } from "./helpers.js";

/**
 * Runtime switch with files, sources and artifacts (#53, PRD FR-3.5, 수용 기준 8·11). The e2e server runs the
 * scripted runtime as "Claude Code" and as "Codex" (FAKE_RUNTIME_CODEX=1). After the chip switches the runtime, the
 * new runtime's `/ref-…` commands make real tool calls with the ids **it read from its start context** (the
 * conversation references) — the same files, the same source, the next version of the same artifact — in both
 * directions, and in a forked shared conversation. The two real runtimes run the same scenarios in
 * apps/server/test/runtime-switch.test.ts (recorded protocols, real MCP calls). Fresh accounts per test.
 */

test.use({ serviceWorkers: "block" });

const OK = "원문 구절 확인";
const SNIPPET = "메모리 가격 회복이 증가를 이끌었다";
const V1 = "# 회의 메모 v1\n- 관심 종목: 삼성전자";
const V2 = "# 회의 메모 v2\n- 관심 종목: 삼성전자\n- 목표가: 25만원";
const HWP_ROW = "학교 누리집 과제방에 PDF로 올립니다.";
const FIX = path.join(import.meta.dirname, "../fixtures/extract");

const LABEL = { "claude-code": "Claude Code", codex: "Codex" } as const;
type Rt = keyof typeof LABEL;
const DIRECTIONS: [Rt, Rt][] = [
  ["claude-code", "codex"],
  ["codex", "claude-code"],
];

/** Sends a message from the composer and waits for its reply to finish. */
async function ask(page: Page, text: string) {
  const replies = page.getByTestId("assistant");
  const before = await replies.count();
  await page.getByLabel("메시지 입력").fill(text);
  await page.getByRole("button", { name: "보내기" }).click();
  await expect(replies).toHaveCount(before + 1, { timeout: 15_000 });
  const reply = replies.last();
  await expect(reply).toHaveAttribute("data-status", "complete", { timeout: 30_000 });
  return reply;
}

/** The chip: this conversation's runtime from the next message on. */
async function switchTo(page: Page, rt: Rt) {
  // A new artifact opens in its panel — on a phone a dialog over the chat: close it first.
  const close = page.getByTestId("artifact-panel-close");
  if (await close.isVisible()) await close.click();
  await page.locator("#runtime-chip").click();
  const pop = page.getByRole("dialog", { name: "런타임·모델 선택" });
  await pop.getByRole("radio", { name: LABEL[rt] }).click();
  await expect(page.locator("#runtime-chip")).toContainText(LABEL[rt]);
  await page.keyboard.press("Escape");
}

const conversationId = (page: Page) => new URL(page.url()).pathname.split("/").at(-1)!;

type Msg = {
  role: string;
  runtime: string | null;
  parts: { type: string; citations?: { status: string; sourceId: string | null }[]; artifactId?: string }[];
};
async function messages(page: Page, id = conversationId(page)) {
  const r = await page.request.get(`/api/conversations/${id}/messages`);
  return ((await r.json()) as { items: Msg[] }).items;
}
const lastReply = async (page: Page) => (await messages(page)).findLast((m) => m.role === "assistant")!;
const noteOf = (m: Msg) => m.parts.find((p) => p.type === "citation_note")!.citations!;

/** On `from`: a web page cited and artifact v1. Returns the source and artifact ids. */
async function firstPart(page: Page, from: Rt) {
  await page.goto("/");
  await switchTo(page, from);
  await ask(page, "/cite partial");
  await page.waitForURL(/\/c\/[^/]+$/);
  const cited = await lastReply(page);
  expect(cited.runtime).toBe(from);
  const sourceId = noteOf(cited)[0]!.sourceId!;
  await ask(page, `/artifact markdown 회의 메모\n${V1}`);
  const made = await lastReply(page);
  const artifactId = made.parts.find((p) => p.type === "artifact_ref")!.artifactId!;
  return { sourceId, artifactId };
}

async function latestVersion(page: Page, artifactId: string) {
  const r = await page.request.get(`/api/artifacts/${artifactId}`);
  expect(r.status()).toBe(200);
  return ((await r.json()) as { latestVersion: number }).latestVersion;
}

for (const [from, to] of DIRECTIONS) {
  test(`${LABEL[from]} → ${LABEL[to]}: the cited source is cited again and artifact v1 becomes v2`, async ({
    page,
    browser,
    baseURL,
  }) => {
    const me = await newMember(browser, baseURL!, `switch-${from}`);
    await signIn(page, baseURL!, me);
    const first = await firstPart(page, from);

    await switchTo(page, to);
    const reply = await ask(page, `/ref-cite 0 ${SNIPPET}`);
    await expect(page.getByTestId("divider").last()).toHaveText(new RegExp(`여기부터\\s*${LABEL[to]}`));
    await expect(reply.getByTestId("citation-status")).toHaveText([OK]);
    const again = await lastReply(page);
    expect(again.runtime).toBe(to);
    expect(noteOf(again).map((c) => [c.status, c.sourceId])).toEqual([["verified", first.sourceId]]);

    await ask(page, `/ref-artifact-update 0\n${V2}`);
    const edited = await lastReply(page);
    expect(edited.runtime).toBe(to);
    expect(edited.parts).toContainEqual(
      expect.objectContaining({ type: "artifact_ref", artifactId: first.artifactId, version: 2 }),
    );
    expect(await latestVersion(page, first.artifactId)).toBe(2);
    const raw = await page.request.get(`/api/artifacts/${first.artifactId}/versions/2`);
    expect(raw.status()).toBe(200);
    expect(JSON.stringify(await raw.json())).toContain("목표가: 25만원");
  });
}

for (const [from, to] of DIRECTIONS) {
  test(`${LABEL[from]} → ${LABEL[to]}: PDF·HWP uploaded, then the same files cited after the switch`, async ({
    page,
    browser,
    baseURL,
  }) => {
    test.skip(
      process.platform !== "darwin",
      "file extraction needs macOS sandbox-exec on a production-mode server; covered by runtime-switch.test.ts",
    );
    const me = await newMember(browser, baseURL!, `switch-files-${from}`);
    await signIn(page, baseURL!, me);
    await page.goto("/");
    await switchTo(page, from);
    // One after the other: `/file-compare` takes the first upload as the PDF and the second as the HWP.
    for (const [name, mimeType] of [
      ["report.pdf", "application/pdf"],
      ["assignment.hwp", "application/x-hwp"],
    ] as const) {
      await page
        .getByTestId("file-input")
        .setInputFiles([{ name, mimeType, buffer: fs.readFileSync(path.join(FIX, name)) }]);
      for (const a of await page.getByTestId("attachment").all())
        await expect(a).toHaveAttribute("data-status", "done");
    }
    await expect(page.getByTestId("attachment")).toHaveCount(2);
    const compared = await ask(page, "/file-compare");
    await page.waitForURL(/\/c\/[^/]+$/);
    await expect(compared.getByTestId("citation-status")).toHaveText([OK, OK], { timeout: 30_000 });

    await switchTo(page, to);
    // Where each file is in the references: the conversation's file list order (the same store order).
    const files = (await (
      await page.request.get(`/api/conversations/${conversationId(page)}/files`)
    ).json()) as {
      items: { name: string }[];
    };
    const hwpAt = files.items.findIndex((f) => f.name === "assignment.hwp");
    const pdfAt = files.items.findIndex((f) => f.name === "report.pdf");
    const hwp = await ask(page, `/ref-file-cite ${hwpAt} ${HWP_ROW}`);
    await expect(hwp.getByTestId("citation-status")).toHaveText([OK]);
    await expect(hwp.getByTestId("citation-source")).toContainText("assignment.hwp");
    await expect(hwp.getByTestId("citation-source")).toContainText("3번째 표");
    const pdf = await ask(
      page,
      `/ref-file-cite ${pdfAt} Summary: the river clean-up removed 340 kg of waste.`,
    );
    await expect(pdf.getByTestId("citation-status")).toHaveText([OK]);
    await expect(pdf.getByTestId("citation-source")).toContainText("report.pdf");
    await expect(pdf.getByTestId("citation-source")).toContainText("12쪽");
    expect((await lastReply(page)).runtime).toBe(to);
  });
}

for (const [from, to] of DIRECTIONS) {
  test(`a forked shared conversation, ${LABEL[from]} → ${LABEL[to]}: the copied source is fetched again, the copy changed`, async ({
    page,
    browser,
    baseURL,
  }) => {
    const owner = await newMember(browser, baseURL!, `switch-owner-${from}`);
    const viewer = await newMember(browser, baseURL!, `switch-viewer-${from}`);
    await signIn(page, baseURL!, owner);
    const orig = await firstPart(page, from);
    const share = await page.request.post(`/api/conversations/${conversationId(page)}/shares`, {
      data: { target: { audience: "users", userIds: [viewer.id] }, mode: "live" },
      headers: csrf(baseURL!),
    });
    expect(share.status()).toBe(201);
    const shareId = ((await share.json()) as { id: string }).id;

    const ctx = await browser.newContext({ baseURL: baseURL! });
    const vpage = await ctx.newPage();
    await signIn(vpage, baseURL!, viewer);
    const forked = await vpage.request.post(`/api/shares/${shareId}/fork`, { headers: csrf(baseURL!) });
    expect(forked.status()).toBe(201);
    const fid = ((await forked.json()) as { conversation: { id: string } }).conversation.id;
    await vpage.goto(`/c/${fid}`);
    // The copied replies are on the page before anything is asked.
    const copied = (await messages(vpage, fid)).filter((m) => m.role === "assistant").length;
    await expect(vpage.getByTestId("assistant")).toHaveCount(copied);
    await switchTo(vpage, to);

    // The copied source has no page text: cited as it is, it is not shown as verified.
    const asIs = await ask(vpage, `/ref-cite 0 ${SNIPPET}`);
    await expect(asIs.getByTestId("citation-status")).not.toHaveText([OK]);
    expect((await lastReply(vpage)).runtime).toBe(to);
    // Fetched again by its URL, then cited: verified.
    const refetched = await ask(vpage, `/ref-refetch-cite 0 ${SNIPPET}`);
    await expect(refetched.getByTestId("citation-status")).toHaveText([OK]);
    const newSource = noteOf(await lastReply(vpage))[0]!.sourceId!;
    expect(newSource).not.toBe(orig.sourceId);

    // The artifact copy: read and changed; the original stays at v1.
    await ask(vpage, `/ref-artifact-update 0\n${V2}`);
    const edited = await lastReply(vpage);
    const copyId = edited.parts.find((p) => p.type === "artifact_ref")!.artifactId!;
    expect(copyId).not.toBe(orig.artifactId);
    expect(await latestVersion(vpage, copyId)).toBe(2);
    expect(await latestVersion(page, orig.artifactId)).toBe(1);

    // Switched back: the fresh session is told the new source too, and cites it verified.
    await switchTo(vpage, from);
    const back = await ask(vpage, `/ref-cite 1 ${SNIPPET}`);
    await expect(back.getByTestId("citation-status")).toHaveText([OK]);
    const last = await lastReply(vpage);
    expect(last.runtime).toBe(from);
    expect(noteOf(last)[0]!.sourceId).toBe(newSource);
    await ctx.close();
  });
}
