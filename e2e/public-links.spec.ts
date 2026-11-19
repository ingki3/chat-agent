import crypto from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { MOM, csrf, newConversation, useAccount } from "./helpers.js";

/**
 * Public artifact links (#204, PRD FR-14.7 v0.7): the owner makes a link from the artifact page ("공개 링크 만들기":
 * warning, days, the link once); anyone opens `/artifact/<token>` without logging in; the artifact's scripts — on the
 * app's own origin — still reach no cookie, no storage, no API and not the page around them; turning the link off
 * closes it at once. The e2e server runs with PUBLIC_LINKS_ENABLED=1 (playwright.config.ts). Synthetic content only.
 */

/** Probes of what the sandbox must refuse, written into the page for the test to read. */
const PROBE = (tag: string) => `<h1 id="t">공개 ${tag}</h1><pre id="out"></pre>
<script>
  const r = {};
  r.origin = String(self.origin);
  try { r.cookie = "value:" + document.cookie; } catch (e) { r.cookie = "threw:" + e.name; }
  try { r.storage = "value:" + localStorage.length; } catch (e) { r.storage = "threw:" + e.name; }
  try { r.parent = "value:" + typeof parent.document.body; } catch (e) { r.parent = "threw:" + e.name; }
  const show = () => { document.getElementById("out").textContent = JSON.stringify(r); };
  show();
  fetch("/api/public-links", { credentials: "include" })
    .then((x) => { r.fetch = "status:" + x.status; }, (e) => { r.fetch = "rejected:" + e.name; })
    .finally(() => { show(); document.body.dataset.done = "1"; });
</script>`;

async function runCommand(request: APIRequestContext, baseURL: string, conversationId: string, text: string) {
  const r = await request.post(`/api/conversations/${conversationId}/messages`, {
    data: { text },
    headers: { ...csrf(baseURL), "Idempotency-Key": `e2e-${Date.now()}-${Math.random()}` },
  });
  expect(r.status()).toBe(201);
  const { run } = (await r.json()) as { run: { id: string } };
  await expect
    .poll(
      async () => ((await (await request.get(`/api/runs/${run.id}`)).json()) as { status: string }).status,
    )
    .toBe("done");
}

test("owner makes a link in the dialog; a logged-out visitor opens it; its scripts reach nothing; off closes it", async ({
  page,
  baseURL,
  browser,
}) => {
  await useAccount(page, MOM);
  // A readable (non-HttpOnly) cookie of the app's origin: the artifact must not see it even so.
  await page.context().addCookies([{ name: "al_probe", value: "visible", url: baseURL! }]);
  const tag = crypto.randomUUID().slice(0, 8);
  const conv = await newConversation(page.request, baseURL!, `공개 ${tag}`);
  await runCommand(page.request, baseURL!, conv.id, `/artifact html 공개 페이지 ${tag}\n${PROBE(tag)}`);
  const list = (await (await page.request.get(`/api/conversations/${conv.id}/artifacts`)).json()) as {
    items: { id: string }[];
  };
  const id = list.items[0]!.id;

  // The dialog: the warning, 7 days by default, the link once.
  await page.goto(`/a/${id}`);
  await page.getByTestId("public-link-open").click();
  const dialog = page.getByTestId("public-link-dialog");
  await expect(dialog.getByTestId("public-link-warning")).toContainText("누구나 로그인 없이");
  await expect(dialog.getByTestId("public-link-days")).toHaveValue("7");
  await dialog.getByTestId("public-link-create").click();
  const shown = new URL(await dialog.getByTestId("public-link-url").inputValue());
  // The address to share is the public host over https (PUBLIC_HOST), even though it was made on 127.0.0.1.
  expect(shown.origin).toBe("https://chat.2prostream.com");
  expect(shown.pathname).toMatch(/^\/artifact\/[A-Za-z0-9_-]{43}$/);
  // This test server is reached on its loopback address: the same path here.
  const url = shown.pathname;
  await expect(dialog.getByTestId("public-link")).toHaveCount(1);
  await dialog.getByRole("button", { name: "닫기" }).click();

  // Opened with the owner's cookies in the browser: the page is not the app, and the artifact reaches nothing.
  const res = await page.goto(url);
  expect(res!.status()).toBe(200);
  expect(res!.headers()["set-cookie"]).toBeUndefined();
  expect(res!.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect(res!.headers()["referrer-policy"]).toBe("no-referrer");
  await expect(page.getByTestId("public-title")).toHaveText(`공개 페이지 ${tag}`);
  await expect(page.locator("script")).toHaveCount(0);
  const frameEl = page.getByTestId("public-frame");
  await expect(frameEl).toHaveAttribute("sandbox", "allow-scripts");
  const frame = page.frameLocator("[data-testid=public-frame]");
  await expect(frame.locator("#t")).toHaveText(`공개 ${tag}`);
  await expect(frame.locator("body[data-done='1']")).toBeAttached();
  const r = JSON.parse((await frame.locator("#out").textContent())!) as Record<string, string>;
  expect(r.origin).toBe("null");
  expect(r.cookie).toMatch(/^threw:SecurityError$|^value:$/);
  expect(r.cookie).not.toContain("al_probe");
  expect(r.storage).toBe("threw:SecurityError");
  expect(r.parent).toBe("threw:SecurityError");
  // connect-src 'none': the request never leaves the frame.
  expect(r.fetch).toMatch(/^rejected:/);

  // A visitor with no account at all.
  const stranger = await browser.newContext({ baseURL: baseURL! });
  const visitor = await stranger.newPage();
  const v = await visitor.goto(url);
  expect(v!.status()).toBe(200);
  await expect(visitor.getByTestId("public-title")).toHaveText(`공개 페이지 ${tag}`);
  await expect(visitor.frameLocator("[data-testid=public-frame]").locator("#t")).toHaveText(`공개 ${tag}`);
  // The original downloads without an account; the app's API does not answer them.
  const dl = await visitor.request.get(`${url}/download`);
  expect(dl.status()).toBe(200);
  expect(dl.headers()["content-disposition"]).toMatch(/^attachment; /);
  expect((await visitor.request.get("/api/public-links")).status()).toBe(401);
  expect((await visitor.request.get(`/api/artifacts/${id}`)).status()).toBe(401);

  // The owner's list: views counted, then off — the visitor gets 404 at once.
  await page.goto("/shared");
  // The desktop and mobile projects run this at once as the same account: this run's link, by its title.
  const mine = page.getByTestId("my-public-links").getByTestId("public-link").filter({ hasText: tag });
  await expect(mine).toHaveAttribute("data-status", "active");
  await expect(mine.getByTestId("public-link-views")).toContainText(/조회 [2-9]회/);
  await mine.getByTestId("public-link-disable").click();
  await expect(mine).toHaveAttribute("data-status", "disabled");
  expect((await visitor.goto(url))!.status()).toBe(404);
  await expect(visitor.getByRole("alert")).toContainText("링크를 열 수 없어요");
  await stranger.close();
});
