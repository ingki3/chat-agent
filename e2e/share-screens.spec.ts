import crypto from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { csrf, newConversation, newMember, signIn } from "./helpers.js";

/**
 * The share screens (#52, PRD FR-2.4·14.3~14.6): the owner shares a conversation from its own menu ("가족에게 공유"),
 * the person it is shared with finds it in the sidebar's "가족 공유" bundle (who shared it, "새로"), opens it — the
 * owner sees it was opened — and continues it as their own ("이어서 대화하기"). The original then goes: the fork stays.
 * Fresh accounts per test (and so per project): no two specs or projects share an owner, a viewer or a share.
 */

async function sayAndWait(request: APIRequestContext, baseURL: string, conversationId: string, text: string) {
  const r = await request.post(`/api/conversations/${conversationId}/messages`, {
    data: { text },
    headers: csrf(baseURL),
  });
  expect(r.status()).toBe(201);
  const { run } = (await r.json()) as { run: { id: string } };
  await expect
    .poll(
      async () => ((await (await request.get(`/api/runs/${run.id}`)).json()) as { endedAt: unknown }).endedAt,
      { timeout: 15_000 },
    )
    .not.toBeNull();
}

/** The sidebar (on a narrow screen: the drawer, opened). */
async function sidebar(page: Page, isMobile: boolean) {
  if (isMobile) await page.getByRole("button", { name: "메뉴 열기" }).click();
  const side = page.getByTestId("sidebar");
  await expect(side).toBeVisible();
  return side;
}

test("share from the conversation menu → the sidebar's 가족 공유 → fork → the fork outlives the original", async ({
  page,
  browser,
  baseURL,
  isMobile,
}) => {
  const owner = await newMember(browser, baseURL!, "screens-owner");
  const viewer = await newMember(browser, baseURL!, "screens-viewer");
  await signIn(page, baseURL!, owner);
  const title = `공유화면 ${crypto.randomUUID().slice(0, 6)}`;
  const conv = await newConversation(page.request, baseURL!, title);
  await sayAndWait(page.request, baseURL!, conv.id, "포크할 첫 질문");

  // Owner: the conversation's own menu → "가족에게 공유": private so far; share it with the viewer.
  await page.goto(`/c/${conv.id}`);
  await page
    .locator(".topbar")
    .getByRole("button", { name: `${title} 메뉴` })
    .click();
  await page.getByRole("menuitem", { name: "가족에게 공유" }).click();
  const dialog = page.getByTestId("share-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(title);
  await expect(dialog.getByTestId("share-status")).toContainText("비공개");
  const form = dialog.getByRole("form", { name: "새로 공유하기" });
  await form.getByTestId("share-targets").getByLabel(viewer.name, { exact: true }).check();
  await form.getByRole("button", { name: "공유하기" }).click();
  await expect(dialog.getByTestId("share-status")).toContainText(`공유 중 — ${viewer.name}`);
  const receipt = dialog.getByTestId("share-receipt");
  await expect(receipt).toHaveAttribute("data-seen", "no");
  await expect(dialog).toContainText("이미 내려받은 파일");
  await dialog.getByRole("button", { name: "닫기" }).click();

  // Viewer: the sidebar's "가족 공유" bundle shows it — who shared it, and "새로" until opened.
  const ctx = await browser.newContext({ baseURL: baseURL! });
  const vpage = await ctx.newPage();
  await signIn(vpage, baseURL!, viewer);
  await vpage.goto("/");
  let side = await sidebar(vpage, isMobile);
  const item = side.getByTestId("shared-item").filter({ hasText: title });
  await expect(item).toBeVisible();
  await expect(item).toContainText(owner.name);
  await expect(item.getByTestId("shared-new")).toBeVisible();
  await item.click();
  const view = vpage.getByTestId("shared-view");
  await expect(view.getByTestId("shared-message").first()).toContainText("포크할 첫 질문");

  // Owner: the receipt says it was opened (the dialog reads it again when it opens).
  await page.reload();
  await page
    .locator(".topbar")
    .getByRole("button", { name: `${title} 메뉴` })
    .click();
  await page.getByRole("menuitem", { name: "가족에게 공유" }).click();
  await expect(page.getByTestId("share-receipt")).toHaveAttribute("data-seen", "yes");
  await expect(page.getByTestId("share-receipt")).toContainText("열어봄");
  await page.getByTestId("share-dialog").getByRole("button", { name: "닫기" }).click();

  // Viewer: "이어서 대화하기" → a conversation of their own, the shared messages in it.
  await view.getByTestId("fork").click();
  await expect(vpage).toHaveURL(/\/c\/[0-9a-f-]+$/);
  const forkId = new URL(vpage.url()).pathname.split("/").pop()!;
  expect(forkId).not.toBe(conv.id);
  await expect(vpage.getByTestId("fork-notice")).toBeVisible();
  await expect(vpage.getByTestId("thread")).toContainText("포크할 첫 질문");
  // It is theirs: they can write in it (the original stays read-only to them).
  const fork = (await (await vpage.request.get(`/api/conversations/${forkId}`)).json()) as { kind: string };
  expect(fork.kind).toBe("fork");
  expect(
    (
      await vpage.request.post(`/api/conversations/${conv.id}/messages`, {
        data: { text: "끼어들기" },
        headers: csrf(baseURL!),
      })
    ).status(),
  ).toBe(403);

  // The owner deletes the original: the fork stays, whole.
  expect(
    (await page.request.delete(`/api/conversations/${conv.id}`, { headers: csrf(baseURL!) })).status(),
  ).toBe(200);
  await vpage.reload();
  await expect(vpage.getByTestId("thread")).toContainText("포크할 첫 질문");
  expect((await vpage.request.get(`/api/conversations/${forkId}/messages`)).status()).toBe(200);
  // And the shared item has left the viewer's sidebar.
  await vpage.goto("/");
  side = await sidebar(vpage, isMobile);
  await expect(side.getByTestId("shared-item").filter({ hasText: title })).toHaveCount(0);
  await ctx.close();
});

test("an artifact shared from its own page is copied by the viewer to change it (FR-14.4)", async ({
  page,
  browser,
  baseURL,
}) => {
  const owner = await newMember(browser, baseURL!, "art-fork-owner");
  const viewer = await newMember(browser, baseURL!, "art-fork-viewer");
  await signIn(page, baseURL!, owner);
  const conv = await newConversation(
    page.request,
    baseURL!,
    `아티팩트 포크 ${crypto.randomUUID().slice(0, 6)}`,
  );
  await sayAndWait(page.request, baseURL!, conv.id, "/artifact html 포크 표\n<p>원래 내용</p>");
  const list = (await (await page.request.get(`/api/conversations/${conv.id}/artifacts`)).json()) as {
    items: { id: string }[];
  };
  const artifactId = list.items[0]!.id;

  // Owner: "가족에게 공유" on the artifact's page — live only (no message boundary for an artifact).
  await page.goto(`/a/${artifactId}`);
  await page.getByTestId("share-open").click();
  const dialog = page.getByTestId("share-dialog");
  await expect(dialog.getByRole("radiogroup", { name: "공유 범위" })).toHaveCount(0);
  await dialog.getByTestId("share-targets").getByLabel(viewer.name, { exact: true }).check();
  await dialog.getByRole("button", { name: "공유하기" }).click();
  await expect(dialog.getByTestId("share-status")).toContainText(viewer.name);

  const ctx = await browser.newContext({ baseURL: baseURL! });
  const vpage = await ctx.newPage();
  await signIn(vpage, baseURL!, viewer);
  // The viewer sees no share button on the artifact (only its owner shares it).
  await vpage.goto(`/a/${artifactId}`);
  await expect(vpage.getByTestId("artifact-frame")).toBeVisible();
  await expect(vpage.getByTestId("share-open")).toHaveCount(0);
  await vpage.goto("/shared");
  await vpage.getByTestId("incoming-share").getByRole("link").first().click();
  await vpage.getByTestId("fork").click();
  await expect(vpage).toHaveURL(/\/c\/[0-9a-f-]+$/);
  const forkId = new URL(vpage.url()).pathname.split("/").pop()!;
  const arts = (await (await vpage.request.get(`/api/conversations/${forkId}/artifacts`)).json()) as {
    items: { id: string }[];
  };
  expect(arts.items).toHaveLength(1);
  expect(arts.items[0]!.id).not.toBe(artifactId);
  expect((await vpage.request.get(`/a/${arts.items[0]!.id}/v/1/raw`)).status()).toBe(200);
  await ctx.close();
});
