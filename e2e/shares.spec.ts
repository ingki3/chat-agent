import crypto from "node:crypto";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { csrf, newConversation, newMember, signIn } from "./helpers.js";

/**
 * Family sharing (#29, PRD FR-14, 수용 기준 6): the owner shares a conversation with one family account from the
 * minimal `/shared` screen, the viewer opens it read-only, the owner turns it off — the viewer's open screen closes
 * at once (its share stream ends) and every URL is 403. Fresh accounts per test (and so per project): desktop and
 * mobile never share an owner, a viewer or a share.
 */

async function sayAndWait(request: APIRequestContext, baseURL: string, conversationId: string, text: string) {
  const r = await request.post(`/api/conversations/${conversationId}/messages`, {
    data: { text },
    headers: csrf(baseURL),
  });
  expect(r.status()).toBe(201);
  const { run, assistant } = (await r.json()) as { run: { id: string }; assistant: { id: string } };
  await expect
    .poll(
      async () => ((await (await request.get(`/api/runs/${run.id}`)).json()) as { endedAt: unknown }).endedAt,
      {
        timeout: 15_000,
      },
    )
    .not.toBeNull();
  return assistant.id;
}

test("share from /shared, view read-only, revoke closes the viewer's screen at once", async ({
  page,
  browser,
  baseURL,
}) => {
  const owner = await newMember(browser, baseURL!, "share-owner");
  const viewer = await newMember(browser, baseURL!, "share-viewer");
  await signIn(page, baseURL!, owner);
  const title = `공유 ${crypto.randomUUID().slice(0, 6)}`;
  const conv = await newConversation(page.request, baseURL!, title);
  await sayAndWait(page.request, baseURL!, conv.id, "공유할 첫 질문");

  // Owner: share it live with the viewer only.
  await page.goto("/shared");
  const form = page.getByRole("form", { name: "가족에게 공유" });
  await form.getByLabel("공유할 대화").selectOption({ label: title });
  await form.getByTestId("share-targets").getByLabel(viewer.name).check();
  await form.getByRole("button", { name: "공유하기" }).click();
  await expect(form.getByText("공유했어요.")).toBeVisible();
  const mine = page.getByTestId("my-share");
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText(viewer.name);
  await expect(mine).toContainText("이미 내려받은 파일");

  // Viewer: in a separate browser context.
  const ctx = await browser.newContext({ baseURL: baseURL! });
  const vpage = await ctx.newPage();
  await signIn(vpage, baseURL!, viewer);
  await vpage.goto("/shared");
  await vpage.getByTestId("incoming-share").getByRole("link", { name: title }).click();
  const view = vpage.getByTestId("shared-view");
  await expect(view).toBeVisible();
  await expect(view.getByTestId("shared-message").first()).toContainText("공유할 첫 질문");
  await expect(view).toContainText("읽기 전용");
  // Read-only: the viewer's write is refused by the server.
  const write = await vpage.request.post(`/api/conversations/${conv.id}/messages`, {
    data: { text: "끼어들기" },
    headers: csrf(baseURL!),
  });
  expect(write.status()).toBe(403);
  expect((await vpage.request.get(`/api/conversations/${conv.id}/messages`)).status()).toBe(200);

  // Owner turns it off: the viewer's open screen closes without a reload, and the URLs are 403.
  await mine.getByRole("button", { name: "공유 끄기" }).click();
  await expect(page.getByTestId("share-revoked-notice")).toBeVisible();
  await expect(vpage.getByTestId("share-closed")).toBeVisible({ timeout: 10_000 });
  expect((await vpage.request.get(`/api/conversations/${conv.id}/messages`)).status()).toBe(403);
  expect((await vpage.request.get(`/api/conversations/${conv.id}`)).status()).toBe(403);
  await ctx.close();
});

test("a snapshot share shows the messages up to the boundary only", async ({ page, browser, baseURL }) => {
  const owner = await newMember(browser, baseURL!, "snap-owner");
  const viewer = await newMember(browser, baseURL!, "snap-viewer");
  await signIn(page, baseURL!, owner);
  const conv = await newConversation(page.request, baseURL!, `스냅샷 ${crypto.randomUUID().slice(0, 6)}`);
  const boundary = await sayAndWait(page.request, baseURL!, conv.id, "경계 안 질문");
  await sayAndWait(page.request, baseURL!, conv.id, "경계 뒤 질문");
  const r = await page.request.post(`/api/conversations/${conv.id}/shares`, {
    data: {
      target: { audience: "users", userIds: [viewer.id] },
      mode: "snapshot",
      boundaryMessageId: boundary,
    },
    headers: csrf(baseURL!),
  });
  expect(r.status()).toBe(201);
  const { id } = (await r.json()) as { id: string };
  // An email is never a target.
  const email = await page.request.post(`/api/conversations/${conv.id}/shares`, {
    data: { target: { audience: "users", userIds: [viewer.email] }, mode: "live" },
    headers: csrf(baseURL!),
  });
  expect(email.status()).toBe(400);

  const ctx = await browser.newContext({ baseURL: baseURL! });
  const vpage = await ctx.newPage();
  await signIn(vpage, baseURL!, viewer);
  await vpage.goto(`/shared/${id}`);
  const view = vpage.getByTestId("shared-view");
  await expect(view.getByTestId("shared-message")).toHaveCount(2);
  await expect(view).toContainText("경계 안 질문");
  await expect(view).not.toContainText("경계 뒤 질문");
  await ctx.close();
});

/** An owner, a viewer (fresh accounts), and a conversation of the owner with one HTML artifact made by a reply. */
async function withArtifact(page: Page, browser: Browser, baseURL: string, label: string) {
  const owner = await newMember(browser, baseURL, `${label}-owner`);
  const viewer = await newMember(browser, baseURL, `${label}-viewer`);
  await signIn(page, baseURL, owner);
  const conv = await newConversation(page.request, baseURL, `${label} ${crypto.randomUUID().slice(0, 6)}`);
  await sayAndWait(page.request, baseURL, conv.id, "/artifact html 공유 표\n<p>공유된 내용</p>");
  const list = (await (await page.request.get(`/api/conversations/${conv.id}/artifacts`)).json()) as {
    items: { id: string }[];
  };
  const artifactId = list.items[0]!.id;
  const r = await page.request.post(`/api/conversations/${conv.id}/shares`, {
    data: { target: { audience: "users", userIds: [viewer.id] }, mode: "live" },
    headers: csrf(baseURL),
  });
  expect(r.status()).toBe(201);
  const shareId = ((await r.json()) as { id: string }).id;
  const ctx = await browser.newContext({ baseURL });
  const vpage = await ctx.newPage();
  await signIn(vpage, baseURL, viewer);
  const revoke = async () =>
    expect((await page.request.delete(`/api/shares/${shareId}`, { headers: csrf(baseURL) })).status()).toBe(
      200,
    );
  return { conv, artifactId, shareId, ctx, vpage, revoke, viewer };
}

test("a shared artifact opened from /shared closes on /a/:id when the share is turned off", async ({
  page,
  browser,
  baseURL,
}) => {
  const w = await withArtifact(page, browser, baseURL!, "art-open");
  await w.vpage.goto(`/shared/${w.shareId}`);
  // The artifact card in the shared message opens the artifact's own page (there is no panel here).
  await w.vpage.getByTestId("shared-view").getByTestId("artifact-card").first().click();
  await expect(w.vpage).toHaveURL(new RegExp(`/a/${w.artifactId}$`));
  await expect(w.vpage.getByTestId("artifact-frame")).toBeVisible();
  await w.revoke();
  await expect(w.vpage.getByTestId("artifact-revoked")).toBeVisible({ timeout: 10_000 });
  await expect(w.vpage.getByTestId("artifact-revoked")).toContainText("이미 내려받은 파일");
  await expect(w.vpage.getByTestId("artifact-frame")).toHaveCount(0);
  await w.ctx.close();
});

test("a shared artifact opened straight in a new tab closes when the share is turned off", async ({
  page,
  browser,
  baseURL,
}) => {
  const w = await withArtifact(page, browser, baseURL!, "art-tab");
  const tab = await w.ctx.newPage();
  await tab.goto(`/a/${w.artifactId}`);
  await expect(tab.getByTestId("artifact-frame")).toBeVisible();
  await w.revoke();
  await expect(tab.getByTestId("artifact-revoked")).toBeVisible({ timeout: 10_000 });
  await expect(tab.getByTestId("artifact-frame")).toHaveCount(0);
  expect((await tab.request.get(`/a/${w.artifactId}/v/1/raw`)).status()).toBe(403);
  await w.ctx.close();
});

test("unticking the last person never widens a share to the whole family", async ({
  page,
  browser,
  baseURL,
}) => {
  const w = await withArtifact(page, browser, baseURL!, "narrow");
  await page.goto("/shared");
  const mine = page.getByTestId("my-share");
  await expect(mine).toHaveCount(1);
  const picker = mine.getByTestId("share-targets");
  await picker.getByLabel(w.viewer.name, { exact: true }).uncheck(); // the only chosen person
  await expect(picker.getByLabel("가족 전체")).not.toBeChecked();
  await expect(mine.getByTestId("share-no-target")).toBeVisible();
  await expect(mine.getByRole("button", { name: "대상 바꾸기" })).toBeDisabled();
  // The new-share form starts with no one, too: "가족 전체" only when picked.
  const form = page.getByRole("form", { name: "가족에게 공유" });
  await expect(form.getByLabel("가족 전체")).not.toBeChecked();
  await expect(form.getByRole("button", { name: "공유하기" })).toBeDisabled();
  // And the server refuses an empty list whatever a client sends.
  const r = await page.request.patch(`/api/shares/${w.shareId}`, {
    data: { target: { audience: "users", userIds: [] } },
    headers: csrf(baseURL!),
  });
  expect(r.status()).toBe(400);
  const s = (await (await page.request.get(`/api/shares/${w.shareId}`)).json()) as { audience: string };
  expect(s.audience).toBe("users");
  await w.ctx.close();
});

test("one of several shares turned off: the open artifact drops the version it no longer shows", async ({
  page,
  browser,
  baseURL,
}) => {
  const owner = await newMember(browser, baseURL!, "narrow-owner");
  const viewer = await newMember(browser, baseURL!, "narrow-viewer");
  await signIn(page, baseURL!, owner);
  const conv = await newConversation(page.request, baseURL!, `좁힘 ${crypto.randomUUID().slice(0, 6)}`);
  await sayAndWait(page.request, baseURL!, conv.id, "/artifact html 표\n<p>첫 버전</p>");
  const list = (await (await page.request.get(`/api/conversations/${conv.id}/artifacts`)).json()) as {
    items: { id: string }[];
  };
  const id = list.items[0]!.id;
  const share = async (mode: string) => {
    const r = await page.request.post(`/api/artifacts/${id}/shares`, {
      data: { target: { audience: "users", userIds: [viewer.id] }, mode },
      headers: csrf(baseURL!),
    });
    expect(r.status()).toBe(201);
    return ((await r.json()) as { id: string }).id;
  };
  await share("snapshot"); // v1 only
  await sayAndWait(page.request, baseURL!, conv.id, `/artifact-update ${id} content\n<p>둘째 버전</p>`);
  const live = await share("live"); // v1 and v2

  const ctx = await browser.newContext({ baseURL: baseURL! });
  const vpage = await ctx.newPage();
  await signIn(vpage, baseURL!, viewer);
  await vpage.goto(`/a/${id}`);
  const frame = vpage.getByTestId("artifact-frame");
  await expect(frame).toHaveAttribute("data-version", "2");
  // The live share goes; the snapshot still shows v1: the screen drops v2 and shows v1, not a revoke.
  expect((await page.request.delete(`/api/shares/${live}`, { headers: csrf(baseURL!) })).status()).toBe(200);
  await expect(frame).toHaveAttribute("data-version", "1", { timeout: 10_000 });
  await expect(vpage.getByTestId("artifact-revoked")).toHaveCount(0);
  expect((await vpage.request.get(`/a/${id}/v/2/raw`)).status()).toBe(403);
  await ctx.close();
});
