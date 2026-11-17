import crypto from "node:crypto";
import { expect, test, type Frame, type Page } from "@playwright/test";
import { MOM, SON, backToChat, csrf, newConversation, sendMessage as send, useAccount } from "./helpers.js";

/**
 * Artifacts from the chat (#28, #172, PRD FR-6.1·6.2·6.6): a reply that makes an artifact moves to the artifact page
 * (`/a/:id`, the artifact menu) — the chat is never split — with a way back to the conversation; a card in the reply
 * opens the same page; an edit request makes v2; v1 can be viewed and restored (a copy as v3). Markdown is rendered
 * by the app with the chat's safe renderer. Runs on the desktop and the mobile project. Artifacts are made through
 * the real MCP tools (FakeRuntime commands).
 */

/** The artifact page's sandboxed frame showing `version`. */
async function pageFrame(page: Page, version: number): Promise<Frame> {
  const el = page.getByTestId("artifact-page").getByTestId("artifact-frame");
  await expect(el).toHaveAttribute("data-version", String(version));
  await expect(el).toHaveAttribute("sandbox", "allow-scripts");
  const frame = await (await el.elementHandle())!.contentFrame();
  expect(frame).not.toBeNull();
  return frame!;
}

const lastAssistant = (page: Page) => page.getByTestId("assistant").last();
const artifactUrl = (id: string, v?: number) => new RegExp(`/a/${id}${v ? `\\?v=${v}` : ""}$`);

test("made in a reply → the artifact page (no split); back, edit → v2, view v1, revert; cards and Escape lead back", async ({
  page,
  baseURL,
  isMobile,
}) => {
  await useAccount(page, MOM);
  const tag = crypto.randomUUID().slice(0, 8);
  const title = `페이지 ${tag}`;
  const conv = await newConversation(page.request, baseURL!, `페이지 ${tag}`);
  await page.goto(`/c/${conv.id}`);
  const entries = await page.evaluate(() => history.length);

  await send(page, `/artifact html ${title}\n<h1 id="t">첫 버전 ${tag}</h1>`);
  // Made in this reply: the app moves to the artifact page by itself (FR-6.1 "바로 보인다"), no click, no split.
  await expect(page).toHaveURL(/\/a\/[^/?]+$/);
  const id = new URL(page.url()).pathname.split("/").pop()!;
  await expect(page.getByTestId("artifact-title")).toContainText(title);
  await expect((await pageFrame(page, 1)).locator("#t")).toHaveText(`첫 버전 ${tag}`);
  await expect(page.getByTestId("artifact-panel")).toHaveCount(0);
  await expect(page.getByLabel("메시지 입력")).toHaveCount(0);
  // The frame is the sandboxed original: no same-origin, so nothing of the app is reachable from it.
  await expect(page.getByTestId("artifact-frame")).not.toHaveAttribute("sandbox", /allow-same-origin/);
  // A history entry of its own: "back" is the conversation.
  expect(await page.evaluate(() => history.length)).toBe(entries + 1);
  await expect(page.getByTestId("artifact-back")).toHaveText("← 대화로 돌아가기");
  const dl = page.waitForEvent("download");
  await page.getByTestId("artifact-download").click();
  expect((await dl).suggestedFilename()).toMatch(/\.html$/);

  await backToChat(page);
  expect(new URL(page.url()).pathname).toBe(`/c/${conv.id}`);
  const card1 = page.getByTestId("assistant").nth(0).getByTestId("artifact-card");
  await expect(card1).toHaveAttribute("data-version", "1");
  await expect(card1).toContainText("v1 만듦");
  await expect(lastAssistant(page)).toHaveAttribute("data-status", "complete");
  // Back where the user left: the card of the artifact is focused.
  await expect(card1).toBeFocused();

  // The edit request: its page again, now v2; the reply gets a v2 card.
  await send(page, `/artifact-update ${id} content\n<h1 id="t">둘째 버전 ${tag}</h1>`);
  await expect(page).toHaveURL(artifactUrl(id));
  await expect((await pageFrame(page, 2)).locator("#t")).toHaveText(`둘째 버전 ${tag}`);
  await expect(page.getByTestId("artifact-version")).toHaveValue("2");
  await expect(page.getByTestId("artifact-revert")).toHaveCount(0); // nothing to restore on the newest

  // View v1: its own content in a fresh frame, the version in the address.
  await page.getByTestId("artifact-version").selectOption("1");
  await expect(page).toHaveURL(artifactUrl(id, 1));
  await expect((await pageFrame(page, 1)).locator("#t")).toHaveText(`첫 버전 ${tag}`);
  // Revert: a new version (v3) copying v1; v1 and v2 stay.
  await page.getByTestId("artifact-revert").click();
  await expect(page.getByTestId("artifact-version")).toHaveValue("3");
  await expect(page.getByTestId("artifact-version").locator("option").first()).toHaveText(/v3 \(v1 복원\)/);
  await expect((await pageFrame(page, 3)).locator("#t")).toHaveText(`첫 버전 ${tag}`);
  await expect(page).toHaveURL(artifactUrl(id));

  // Back (the link keeps working after the version changes), the v2 card is there.
  await backToChat(page);
  const card2 = page.getByTestId("assistant").nth(1).getByTestId("artifact-card");
  await expect(card2).toContainText("v2 새 버전");

  // Cards are links (review #175 5·6차): their own version as an intent, resolved by the page — old: pinned.
  await expect(card1).toHaveAttribute("href", `/a/${id}?cv=1`);
  await expect(card2).toHaveAttribute("href", `/a/${id}?cv=2`);
  if (!isMobile) {
    // A modifier click opens it in a new tab; this tab stays on the conversation.
    const opened = page.context().waitForEvent("page");
    await card1.click({ modifiers: ["ControlOrMeta"] });
    const tab = await opened;
    await expect(tab).toHaveURL(artifactUrl(id, 1));
    await tab.close();
    expect(new URL(page.url()).pathname).toBe(`/c/${conv.id}`);
  }
  // The v1 card opens v1 (the card's own version) on the artifact page — not beside the chat.
  await card1.click();
  await expect(page).toHaveURL(artifactUrl(id, 1));
  await expect(page.getByTestId("artifact-panel")).toHaveCount(0);
  // Escape with the focus inside the sandboxed frame (its one message to the app) goes back, to the card.
  await (await pageFrame(page, 1)).locator("#t").click();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(new RegExp(`/c/${conv.id}$`));
  await expect(card1).toBeFocused();

  // Escape on the page itself too.
  await card2.click();
  await expect(page).toHaveURL(artifactUrl(id, 2));
  await expect((await pageFrame(page, 2)).locator("#t")).toHaveText(`둘째 버전 ${tag}`);
  await page.getByTestId("artifact-title").click();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(new RegExp(`/c/${conv.id}$`));
  await expect(card2).toBeFocused();

  // An old link to the split panel opens the artifact page, which leads back to that conversation.
  await page.goto(`/c/${conv.id}?artifact=${encodeURIComponent(id)}&v=2`);
  await expect(page).toHaveURL(artifactUrl(id, 2));
  await expect((await pageFrame(page, 2)).locator("#t")).toHaveText(`둘째 버전 ${tag}`);
  await backToChat(page);
  expect(new URL(page.url()).pathname).toBe(`/c/${conv.id}`);
  // Opened straight (no history to go back to): the owner still gets the way to the conversation.
  await page.goto(`/a/${id}`);
  await page.getByTestId("artifact-back").click();
  await expect(page).toHaveURL(new RegExp(`/c/${conv.id}$`));
});

test("markdown is rendered by the app: table, lists, code, math — raw HTML, onerror and javascript: stay inert", async ({
  page,
  baseURL,
}) => {
  await useAccount(page, MOM);
  const tag = crypto.randomUUID().slice(0, 8);
  const conv = await newConversation(page.request, baseURL!, `마크다운 ${tag}`);
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await page.goto(`/c/${conv.id}`);
  const md = [
    `# 보고서 ${tag}`,
    "",
    "- 하나",
    "- 둘",
    "",
    "1. 첫째",
    "2. 둘째",
    "",
    "| 이름 | 값 |",
    "|---|---:|",
    "| 사과 | 3 |",
    "",
    "```python",
    "print('안녕')",
    "```",
    "",
    "수식 $E = mc^2$ 입니다.",
    "",
    "<script>window.__pwned = 1; alert('script')</script>",
    "",
    "<img src=x onerror=\"window.__pwned = 2; alert('img')\">",
    "",
    "[나쁜 링크](javascript:window.__pwned=3) [좋은 링크](https://example.com/)",
    "",
    "![그림](https://example.com/x.png)",
  ].join("\n");
  await send(page, `/artifact markdown 보고서 ${tag}\n${md}`);
  await expect(page).toHaveURL(/\/a\/[^/?]+$/);
  const doc = page.getByTestId("artifact-text");
  await expect(doc).toHaveAttribute("data-kind", "markdown");
  await expect(doc.getByRole("heading", { level: 1 })).toHaveText(`보고서 ${tag}`);
  await expect(doc.locator("ul > li")).toHaveText(["하나", "둘"]);
  await expect(doc.locator("ol > li")).toHaveText(["첫째", "둘째"]);
  await expect(doc.getByRole("columnheader", { name: "이름" })).toBeVisible();
  await expect(doc.getByRole("cell", { name: "사과" })).toBeVisible();
  await expect(doc.locator(".codeblk")).toContainText("python");
  await expect(doc.locator("pre code")).toContainText("print('안녕')");
  await expect(doc.locator(".katex").first()).toBeVisible();
  // Not a frame: no sandboxed original is loaded for markdown.
  await expect(page.getByTestId("artifact-frame")).toHaveCount(0);
  // Hostile markup is shown as text and never runs; images are links (nothing is requested).
  await expect(doc).toContainText("<script>window.__pwned = 1;");
  await expect(doc).toContainText("<img src=x onerror=");
  await expect(doc.locator("script, img, iframe")).toHaveCount(0);
  await expect(doc.locator("a", { hasText: "나쁜 링크" })).toHaveCount(0);
  await expect(doc.getByText("나쁜 링크")).toBeVisible();
  const good = doc.getByRole("link", { name: "좋은 링크" });
  await expect(good).toHaveAttribute("href", "https://example.com/");
  await expect(good).toHaveAttribute("target", "_blank");
  await expect(good).toHaveAttribute("rel", /noopener/);
  await expect(doc.getByRole("link", { name: /그림/ })).toHaveAttribute("href", "https://example.com/x.png");
  await doc.getByText("나쁜 링크").click();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(dialogs).toEqual([]);
  // Readable in dark mode too (the blank screen of #172: light text on a white frame).
  await page.emulateMedia({ colorScheme: "dark" });
  const [color, bg] = await doc.evaluate((el) => {
    const h = el.querySelector("h1")!;
    return [getComputedStyle(h).color, getComputedStyle(el).backgroundColor];
  });
  expect(color).not.toBe(bg);
  // The original download is still the .md file.
  const dl = page.waitForEvent("download");
  await page.getByTestId("artifact-download").click();
  expect((await dl).suggestedFilename()).toMatch(/\.md$/);
});

test("the artifact list: mine across conversations, each opens on its page; another member is refused", async ({
  page,
  browser,
  baseURL,
}) => {
  await useAccount(page, MOM);
  const tag = crypto.randomUUID().slice(0, 8);
  const made: { title: string; conv: string }[] = [];
  for (const [i, kind, body] of [
    [1, "markdown", "# 메모"],
    [2, "table", JSON.stringify({ columns: ["이름"], rows: [["값"]] })],
  ] as const) {
    const conv = await newConversation(page.request, baseURL!, `목록 대화 ${i} ${tag}`);
    await page.goto(`/c/${conv.id}`);
    const title = `목록 ${i} ${tag}`;
    await send(page, `/artifact ${kind} ${title}\n${body}`);
    await backToChat(page);
    await expect(lastAssistant(page).getByTestId("artifact-card")).toHaveAttribute("data-version", "1");
    made.push({ title, conv: conv.id });
  }

  await page.goto("/artifacts");
  const items = page.getByTestId("artifact-item").filter({ hasText: tag });
  await expect(items).toHaveCount(2);
  // Newest change first, each with its conversation.
  await expect(items.nth(0)).toContainText(made[1]!.title);
  await expect(items.nth(0)).toContainText(`목록 대화 2 ${tag}`);
  await expect(items.nth(0)).toContainText("표 · v1");
  await expect(items.nth(1)).toContainText(made[0]!.title);

  // Opens on its own page.
  await items.nth(0).getByRole("link", { name: made[1]!.title }).click();
  await expect(page).toHaveURL(/\/a\/[^/?]+$/);
  await expect(page.getByTestId("artifact-title")).toContainText(made[1]!.title);
  const frame = page.getByTestId("artifact-frame");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  // A table: its original (CSV) and its page as HTML, both attachments.
  await expect(page.getByTestId("artifact-download")).toHaveAttribute("href", /\/v\/1\/download$/);
  await expect(page.getByTestId("artifact-download-html")).toHaveAttribute(
    "href",
    /\/v\/1\/download\?format=html$/,
  );
  // The server-drawn table page carries the Escape bridge too: Esc after clicking into it goes to the conversation.
  await frame.contentFrame().locator("table").click();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(new RegExp(`/c/${made[1]!.conv}$`));
  // The conversation is one link away from the list, too.
  await page.goto("/artifacts");
  await items
    .nth(1)
    .getByRole("link", { name: `💬 목록 대화 1 ${tag}` })
    .click();
  await expect(page).toHaveURL(new RegExp(`/c/${made[0]!.conv}$`));

  await page.goto("/artifacts");
  await page.getByRole("tab", { name: "공유받은 것" }).click();
  await expect(page.getByTestId("artifacts-shared-empty")).toBeVisible();

  // Another family member: none of these in the list; an old panel link to it shows the page's refusal.
  const ctx = await browser.newContext({ baseURL: baseURL! });
  const son = await ctx.newPage();
  await useAccount(son, SON);
  await son.goto("/artifacts");
  await expect(son.getByRole("tab", { name: "내가 만든 것" })).toHaveAttribute("aria-selected", "true");
  await expect(son.getByText(tag)).toHaveCount(0);
  const mine = await newConversation(son.request, baseURL!, `아들 ${tag}`);
  const list = (await (await page.request.get("/api/artifacts")).json()) as {
    items: { id: string; title: string }[];
  };
  const target = list.items.find((a) => a.title === made[0]!.title)!.id;
  await son.goto(`/c/${mine.id}?artifact=${encodeURIComponent(target)}`);
  await expect(son).toHaveURL(artifactUrl(target));
  await expect(son.getByRole("alert")).toHaveText("이 아티팩트를 볼 권한이 없어요.");
  await expect(son.getByTestId("artifact-frame")).toHaveCount(0);
  await expect(son.getByTestId("artifact-text")).toHaveCount(0);
  await expect(son.getByText("메모")).toHaveCount(0);
  await ctx.close();
});

test("a run this page did not start (seen again on load) never leaves the chat, even while it streams", async ({
  page,
  baseURL,
}) => {
  await useAccount(page, MOM);
  const tag = crypto.randomUUID().slice(0, 8);
  const conv = await newConversation(page.request, baseURL!, `다시 보기 ${tag}`);
  const r = await page.request.post(`/api/conversations/${conv.id}/messages`, {
    data: { text: `/artifact-slow markdown 늦은 ${tag}\n# 늦은` },
    headers: { ...csrf(baseURL!), "Idempotency-Key": `e2e-${tag}` },
  });
  expect(r.status()).toBe(201);
  await page.goto(`/c/${conv.id}`);
  const reply = page.getByTestId("assistant").last();
  // Its parts are replayed from the stream while it still runs: the card is there, the page stays.
  await expect(reply.getByTestId("artifact-card")).toContainText(`늦은 ${tag}`);
  await expect(reply).toHaveAttribute("data-status", "streaming");
  await expect(reply).toHaveAttribute("data-status", "complete", { timeout: 15_000 });
  await expect(page).toHaveURL(new RegExp(`/c/${conv.id}$`));
  await expect(page.getByTestId("artifact-page")).toHaveCount(0);
});

test("back in the conversation while the run still streams: it does not move to the artifact again", async ({
  page,
  baseURL,
}) => {
  await useAccount(page, MOM);
  const tag = crypto.randomUUID().slice(0, 8);
  const conv = await newConversation(page.request, baseURL!, `돌아옴 ${tag}`);
  await page.goto(`/c/${conv.id}`);
  await send(page, `/artifact-slow markdown 돌아옴 ${tag}\n# 돌아옴`);
  await expect(page.getByTestId("artifact-text").getByRole("heading", { level: 1 })).toHaveText("돌아옴");
  await backToChat(page);
  const reply = page.getByTestId("assistant").last();
  await expect(reply.getByTestId("artifact-card")).toContainText(`돌아옴 ${tag}`);
  await expect(reply).toHaveAttribute("data-status", "streaming");
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(new RegExp(`/c/${conv.id}$`));
  await expect(reply).toHaveAttribute("data-status", "complete", { timeout: 15_000 });
  await expect(page).toHaveURL(new RegExp(`/c/${conv.id}$`));
});

test("the run goes on after moving to the page: a later v2 shows there, and the chat is up to date on return", async ({
  page,
  baseURL,
}) => {
  await useAccount(page, MOM);
  const tag = crypto.randomUUID().slice(0, 8);
  const conv = await newConversation(page.request, baseURL!, `이어짐 ${tag}`);
  await page.goto(`/c/${conv.id}`);
  await send(page, `/artifact-twice markdown 이어짐 ${tag}\n# 첫 버전 ${tag}\n===\n# 둘째 버전 ${tag}`);
  await expect(page).toHaveURL(/\/a\/[^/?]+$/);
  const heading = page.getByTestId("artifact-text").getByRole("heading", { level: 1 });
  await expect(heading).toHaveText(`첫 버전 ${tag}`);
  // The same run stores v2 2.5 s later: this page follows it (the chat's stream is gone).
  await expect(heading).toHaveText(`둘째 버전 ${tag}`, { timeout: 10_000 });
  await expect(page.getByTestId("artifact-version")).toHaveValue("2");
  // The run ends while the user is still here.
  await expect
    .poll(
      async () =>
        (
          (await (await page.request.get(`/api/conversations/${conv.id}/active-run`)).json()) as {
            run: unknown;
          }
        ).run,
      { timeout: 10_000 },
    )
    .toBeNull();
  await page.waitForTimeout(500);
  await backToChat(page);
  // The chat shows the finished reply with its v2 card, and is not left busy: the next message goes out.
  const reply = lastAssistant(page);
  await expect(reply).toHaveAttribute("data-status", "complete");
  await expect(reply).toContainText("다 고쳤어요.");
  // One card per artifact a run touched, at the version it stored last.
  await expect(reply.getByTestId("artifact-card")).toHaveAttribute("data-version", "2");
  await send(page, "안녕");
  await expect(page.getByTestId("assistant")).toHaveCount(2);
  await expect(lastAssistant(page)).toHaveAttribute("data-status", "complete");
  await expect(page).toHaveURL(new RegExp(`/c/${conv.id}$`));
});

test("a page whose run stream gave up while the run goes on recovers and shows the later v2", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(60_000);
  await useAccount(page, MOM);
  const tag = crypto.randomUUID().slice(0, 8);
  const conv = await newConversation(page.request, baseURL!, `복구 ${tag}`);
  const r = await page.request.post(`/api/conversations/${conv.id}/messages`, {
    data: { text: `/artifact-twice-slow markdown 복구 ${tag}\n# 첫 버전 ${tag}\n===\n# 둘째 버전 ${tag}` },
    headers: { ...csrf(baseURL!), "Idempotency-Key": `e2e-${tag}` },
  });
  expect(r.status()).toBe(201);
  let id = "";
  await expect
    .poll(async () => {
      const list = (await (await page.request.get(`/api/conversations/${conv.id}/artifacts`)).json()) as {
        items: { id: string }[];
      };
      id = list.items[0]?.id ?? "";
      return id;
    })
    .not.toBe("");
  // The run's event stream fails for a while: the page's subscription spends its retries and gives up (lost).
  await page.route("**/api/runs/*/events*", (route) => route.fulfill({ status: 503, body: "" }));
  await page.goto(`/a/${id}`);
  const heading = page.getByTestId("artifact-text").getByRole("heading", { level: 1 });
  await expect(heading).toHaveText(`첫 버전 ${tag}`);
  await page.waitForTimeout(11_000);
  await page.unroute("**/api/runs/*/events*");
  // Back: the page reads the run again, subscribes again while it runs, and v2 (stored at 14 s) shows.
  await expect(heading).toHaveText(`둘째 버전 ${tag}`, { timeout: 20_000 });
  await expect(page.getByTestId("artifact-version")).toHaveValue("2");
});

test("card links while their details load: an old card opens its version in a new tab, the newest follows the newest (review #175)", async ({
  page,
  baseURL,
  isMobile,
}) => {
  await useAccount(page, MOM);
  const tag = crypto.randomUUID().slice(0, 8);
  const conv = await newConversation(page.request, baseURL!, `카드 링크 ${tag}`);
  /** A message as an API run (not started by this page: no move), waited for until its run ends. */
  let n = 0;
  const say = async (text: string) => {
    const r = await page.request.post(`/api/conversations/${conv.id}/messages`, {
      data: { text },
      headers: { ...csrf(baseURL!), "Idempotency-Key": `e2e-${tag}-${++n}` },
    });
    expect(r.status()).toBe(201);
    await expect
      .poll(
        async () =>
          (
            (await (await page.request.get(`/api/conversations/${conv.id}/active-run`)).json()) as {
              run: unknown;
            }
          ).run,
      )
      .toBeNull();
  };
  await say(`/artifact markdown 링크 ${tag}\n# 첫 버전 ${tag}`);
  const list = (await (await page.request.get(`/api/conversations/${conv.id}/artifacts`)).json()) as {
    items: { id: string }[];
  };
  const id = list.items[0]!.id;
  await say(`/artifact-update ${id} content\n# 둘째 버전 ${tag}`);
  // The cards' details come late: they are used before they know which version is the newest.
  const detail = `**/api/artifacts/${id}`;
  await page.route(detail, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue().catch(() => undefined);
  });
  await page.goto(`/c/${conv.id}`);
  const v1 = page.getByTestId("assistant").nth(0).getByTestId("artifact-card");
  const v2 = page.getByTestId("assistant").nth(1).getByTestId("artifact-card");
  await expect(v1).not.toContainText("마크다운 아티팩트");
  // The same address whether the details are known or not.
  await expect(v1).toHaveAttribute("href", `/a/${id}?cv=1`);
  await expect(v2).toHaveAttribute("href", `/a/${id}?cv=2`);
  const heading = (p: Page) => p.getByTestId("artifact-text").getByRole("heading", { level: 1 });
  if (!isMobile) {
    // ⌘/Ctrl-click on the v1 card while loading: a new tab with v1 (pinned there), not the newest.
    const opened = page.context().waitForEvent("page");
    await v1.click({ modifiers: ["ControlOrMeta"] });
    const tab = await opened;
    await expect(tab).toHaveURL(artifactUrl(id, 1));
    await expect(heading(tab)).toHaveText(`첫 버전 ${tag}`);
    await tab.close();
    expect(new URL(page.url()).pathname).toBe(`/c/${conv.id}`);
  }
  // A plain click on the newest card while loading opens at once (nothing deferred), following the newest.
  await v2.click();
  await expect(page).toHaveURL(artifactUrl(id));
  await expect(heading(page)).toHaveText(`둘째 버전 ${tag}`);
  // Replaced, not stacked: back is the conversation, and the way back still works.
  await backToChat(page);
  expect(new URL(page.url()).pathname).toBe(`/c/${conv.id}`);
  await page.waitForTimeout(2000); // nothing deferred: it stays here
  expect(new URL(page.url()).pathname).toBe(`/c/${conv.id}`);
  await page.unroute(detail);
  // Opened from the newest card, the page follows the newest: a later v3 shows after a reload.
  await v2.click();
  await expect(page).toHaveURL(artifactUrl(id));
  await say(`/artifact-update ${id} content\n# 셋째 버전 ${tag}`);
  await page.reload();
  await expect(heading(page)).toHaveText(`셋째 버전 ${tag}`);
  await expect(page.getByTestId("artifact-version")).toHaveValue("3");
  // The v1 card (an older version): pinned to v1.
  await page.goto(`/a/${id}?cv=1`);
  await expect(page).toHaveURL(artifactUrl(id, 1));
  await expect(heading(page)).toHaveText(`첫 버전 ${tag}`);
  // A version that is not there: dropped, following the newest.
  await page.goto(`/a/${id}?cv=99`);
  await expect(page).toHaveURL(artifactUrl(id));
  await expect(heading(page)).toHaveText(`셋째 버전 ${tag}`);
});

test("the frame's Escape message goes back only from the frame on screen and only in its exact shape", async ({
  page,
  baseURL,
}) => {
  await useAccount(page, MOM);
  const tag = crypto.randomUUID().slice(0, 8);
  const conv = await newConversation(page.request, baseURL!, `브리지 ${tag}`);
  await page.goto(`/c/${conv.id}`);
  const html = `<button id="bad">bad</button><button id="other">other</button><button id="ok">ok</button>
<script>
const post = (m) => parent.postMessage(m, "*");
document.getElementById("bad").addEventListener("click", () => post({ type: "agentlee:escape", more: 1 }));
document.getElementById("other").addEventListener("click", () => post({ type: "agentlee:close" }));
document.getElementById("ok").addEventListener("click", () => post({ type: "agentlee:escape" }));
</script>`;
  await send(page, `/artifact html 브리지 ${tag}\n${html}`);
  const frame = await pageFrame(page, 1);
  const url = page.url();
  await frame.locator("#bad").click();
  await frame.locator("#other").click();
  // The same message from the app page itself (not the frame) is ignored too.
  await page.evaluate(() => window.postMessage({ type: "agentlee:escape" }, "*"));
  await page.waitForTimeout(300);
  expect(page.url()).toBe(url);
  await frame.locator("#ok").click();
  await expect(page).toHaveURL(new RegExp(`/c/${conv.id}$`));
});
