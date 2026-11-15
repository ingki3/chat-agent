import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { csrf, newConversation, newMember, signIn } from "./helpers.js";

/**
 * Deleting a conversation (#54, PRD NFR 개인정보 · FR-2.1): the owner deletes a conversation that has a file, a
 * reply and a live share the viewer has open. The viewer's screen closes at once, every URL is gone, the viewer's
 * "가족이 공유했어요" notification goes too — and nothing of it is left in any file under the server's data folder
 * (`.e2e/data`: the database file and its WAL, uploads). Fresh accounts per test (and so per project).
 */

const DATA_DIR = path.join(".e2e", "data");

/** Files under the data folder whose bytes contain `marker` (links not followed). */
function filesWith(marker: string): string[] {
  const out: string[] = [];
  const needle = Buffer.from(marker, "utf8");
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return; // gone meanwhile (an upload's temp file, a folder pruned)
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile())
        try {
          if (fs.readFileSync(p).includes(needle)) out.push(path.relative(DATA_DIR, p));
        } catch {
          // gone meanwhile
        }
    }
  };
  walk(DATA_DIR);
  return out;
}

async function sidebar(page: Page, isMobile: boolean) {
  if (isMobile) await page.getByRole("button", { name: "메뉴 열기" }).click();
  const side = page.getByTestId("sidebar");
  await expect(side).toBeVisible();
  return side;
}

test("delete from the sidebar: the viewer's open share closes, the notification goes, nothing is left on disk", async ({
  page,
  browser,
  baseURL,
  isMobile,
}) => {
  const owner = await newMember(browser, baseURL!, "del-owner");
  const viewer = await newMember(browser, baseURL!, "del-viewer");
  await signIn(page, baseURL!, owner);
  const marker = `DELCASCADE${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const title = `지울 대화 ${marker}`;
  const conv = await newConversation(page.request, baseURL!, title);

  // A file sent with the question, and the reply.
  const up = await page.request.post(`/api/conversations/${conv.id}/files`, {
    headers: {
      ...csrf(baseURL!),
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent("메모.txt"),
      "x-upload-id": crypto.randomUUID(),
    },
    data: Buffer.from(`파일 내용 ${marker}`),
  });
  expect(up.status()).toBe(201);
  const file = (await up.json()) as { id: string };
  const sent = await page.request.post(`/api/conversations/${conv.id}/messages`, {
    data: { text: `질문 ${marker}`, fileIds: [file.id] },
    headers: csrf(baseURL!),
  });
  expect(sent.status()).toBe(201);
  const { run } = (await sent.json()) as { run: { id: string } };
  await expect
    .poll(
      async () =>
        ((await (await page.request.get(`/api/runs/${run.id}`)).json()) as { endedAt: unknown }).endedAt,
      { timeout: 15_000 },
    )
    .not.toBeNull();

  // Shared live with the viewer, who is told and opens it.
  const sr = await page.request.post(`/api/conversations/${conv.id}/shares`, {
    data: { target: { audience: "users", userIds: [viewer.id] }, mode: "live" },
    headers: csrf(baseURL!),
  });
  expect(sr.status()).toBe(201);
  const share = (await sr.json()) as { id: string };
  const ctx = await browser.newContext({ baseURL: baseURL! });
  const vpage = await ctx.newPage();
  await signIn(vpage, baseURL!, viewer);
  const inbox = async () => JSON.stringify(await (await vpage.request.get("/api/notifications")).json());
  await expect.poll(inbox).toContain(marker);
  await vpage.goto(`/shared/${share.id}`);
  const view = vpage.getByTestId("shared-view");
  await expect(view.getByTestId("shared-message").first()).toContainText(`질문 ${marker}`);
  expect(filesWith(marker).length).toBeGreaterThan(0);

  // The owner deletes it from the sidebar; the question says what goes and that a fork stays.
  await page.goto(`/c/${conv.id}`);
  const side = await sidebar(page, isMobile);
  let question = "";
  page.once("dialog", (d) => {
    question = d.message();
    void d.accept();
  });
  await side.getByRole("button", { name: `${title} 메뉴` }).click();
  const deleted = page.waitForResponse(
    (r) => r.request().method() === "DELETE" && new URL(r.url()).pathname === `/api/conversations/${conv.id}`,
  );
  await page.getByRole("menuitem", { name: "삭제" }).click();
  expect((await deleted).status()).toBe(200);
  expect(question).toContain("파일·아티팩트·공유");
  expect(question).toContain("그 사람 것으로 남아요");
  expect(question).toContain("백업에는 최대 7일");

  // The viewer's open screen closes without a reload; nothing answers any more.
  await expect(vpage.getByTestId("share-closed")).toBeVisible({ timeout: 10_000 });
  expect((await vpage.request.get(`/api/shares/${share.id}/view`)).status()).toBeGreaterThanOrEqual(403);
  expect((await vpage.request.get(`/api/conversations/${conv.id}`)).status()).toBeGreaterThanOrEqual(403);
  expect((await page.request.get(`/api/conversations/${conv.id}`)).status()).toBe(404);
  expect((await page.request.get(`/api/files/${file.id}/content`)).status()).toBe(404);
  expect(await inbox()).not.toContain(marker);
  // And on disk: no file under the data folder holds any of it (the WAL is checkpointed in the background).
  await expect.poll(() => filesWith(marker), { timeout: 20_000 }).toEqual([]);
  await ctx.close();
});
