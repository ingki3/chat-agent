import { expect, test, type Page } from "@playwright/test";
import { SON, newConversation, useAccount } from "./helpers.js";

/** Chat screen (#14) against FakeRuntime: see apps/server/src/runtime/fake.ts for the `/…` commands. */

async function openChat(page: Page, baseURL: string, title: string) {
  await useAccount(page, SON);
  const c = await newConversation(page.request, baseURL, `${title} ${Date.now()}`);
  await page.goto(`/c/${c.id}`);
  await expect(page.locator(".topbar .title")).toHaveText(c.title);
  return c;
}

async function send(page: Page, text: string) {
  await page.getByLabel("메시지 입력").fill(text);
  await page.getByLabel("메시지 입력").press("Enter");
}

const reply = (page: Page) => page.getByTestId("assistant").last();

test("send → streaming → stop → regenerate → edit and send again", async ({ page, baseURL }) => {
  await openChat(page, baseURL!, "흐름");
  await send(page, "/long 40");
  await expect(reply(page)).toHaveAttribute("data-status", "streaming");
  await expect(reply(page)).toContainText("단어3");
  await expect(page.getByRole("status").filter({ hasText: "응답 생성 중" })).toBeVisible();
  // While a reply is being written there is nothing to regenerate or edit.
  await expect(page.getByRole("button", { name: "✎ 수정" })).toHaveCount(0);
  await page.getByRole("button", { name: "■ 중지" }).click();
  await expect(reply(page)).toHaveAttribute("data-status", "stopped");
  await expect(reply(page).getByText("중지됨")).toBeVisible();
  await expect(reply(page)).not.toContainText("단어40");

  await reply(page).getByRole("button", { name: "↻ 다시 생성" }).click();
  await expect(reply(page)).toHaveAttribute("data-status", "streaming");
  await expect(reply(page)).toContainText("단어40", { timeout: 15_000 });
  await expect(reply(page)).toHaveAttribute("data-status", "complete");
  await expect(page.getByTestId("assistant")).toHaveCount(1); // replaced, not added

  await page.getByTestId("user-message").getByRole("button", { name: "✎ 수정" }).click();
  await page.getByLabel("메시지 수정").fill("고친 질문 포도");
  await page.getByRole("button", { name: "다시 보내기" }).click();
  await expect(reply(page)).toContainText("고친 질문 포도");
  await expect(reply(page)).toHaveAttribute("data-status", "complete");
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  await expect(page.getByTestId("user-message")).toHaveText(/고친 질문 포도/);
  await expect(page.getByTestId("thread")).not.toContainText("/long 40");
  // Still the same after a reload (it is the server's history, not just the screen).
  await page.reload();
  await expect(page.getByTestId("user-message")).toHaveText(/고친 질문 포도/);
  await expect(page.getByTestId("assistant")).toHaveCount(1);
});

test("Enter sends, Shift+Enter starts a new line", async ({ page, baseURL }) => {
  await openChat(page, baseURL!, "엔터");
  const box = page.getByLabel("메시지 입력");
  await box.fill("첫 줄");
  await box.press("Shift+Enter");
  await box.pressSequentially("둘째 줄");
  await expect(box).toHaveValue("첫 줄\n둘째 줄");
  await expect(page.getByTestId("user-message")).toHaveCount(0);
  await box.press("Enter");
  await expect(page.getByTestId("user-message")).toHaveText(/첫 줄\s+둘째 줄/);
  await expect(box).toHaveValue("");
  // File upload comes with #22; the chip shows the defaults (nothing set: Opus 5.5, #19).
  await expect(page.getByRole("button", { name: "파일 첨부" })).toBeDisabled();
  await expect(page.locator("#runtime-chip")).toContainText("Claude Code · Opus 5.5");
});

test("markdown: table, highlighted code with copy, KaTeX, safe links; whole reply copy", async ({
  page,
  baseURL,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openChat(page, baseURL!, "마크다운");
  await send(page, "/md");
  const r = reply(page);
  await expect(r).toHaveAttribute("data-status", "complete");
  await expect(r.getByRole("heading", { name: "단진자 정리" })).toBeVisible();
  await expect(r.locator("table")).toContainText("주기 (s)");
  await expect(r.locator("td").filter({ hasText: "2.01" })).toHaveCSS("text-align", "right");
  await expect(r.locator(".katex").first()).toBeVisible();
  await expect(r.locator(".katex-display")).toHaveCount(1);
  await expect(r.locator("del")).toHaveText("취소선");
  const code = r.locator(".codeblk");
  await expect(code.locator(".ch")).toContainText("python");
  await expect(code.locator(".hljs-keyword").first()).toHaveText("import");
  await code.getByRole("button", { name: "코드 복사" }).click();
  await expect(code.getByRole("button", { name: "코드 복사" })).toHaveText("✓ 복사됨");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "import math\nprint(2 * math.pi * math.sqrt(1.0 / 9.8))",
  );
  const link = r.getByRole("link", { name: "참고 링크" });
  await expect(link).toHaveAttribute("href", "https://example.com/pendulum");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await r.getByRole("button", { name: "답변 복사" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("## 단진자 정리");
});

test("XSS payloads in a reply are shown as text and never run", async ({ page, baseURL }) => {
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await openChat(page, baseURL!, "XSS");
  await send(page, "/xss");
  const r = reply(page);
  await expect(r).toHaveAttribute("data-status", "complete");
  await expect(r).toContainText("끝");
  // The markup is visible as text …
  await expect(r).toContainText('<img src="x" onerror="window.__xss=1">');
  await expect(r).toContainText("<script>window.__xss=1</script>");
  // … and none of it became elements or live URLs.
  await expect(r.locator("script, img, iframe, [onerror], [onload]")).toHaveCount(0);
  expect(await r.locator("[href^='javascript' i], [src^='javascript' i]").count()).toBe(0);
  // The markdown link with a javascript: URL is not a link at all; clicking it does nothing.
  const bad = r.getByText("눌러 보세요");
  await expect(bad).toBeVisible();
  expect(await bad.evaluate((el) => el.closest("a"))).toBeNull();
  await bad.click();
  await r.getByText("수식 링크").click();
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(dialogs).toEqual([]);
});

test("tool progress line, then details with input and result; secret fields are hidden", async ({
  page,
  baseURL,
}) => {
  await openChat(page, baseURL!, "도구");
  await send(page, "/tool 2");
  const tools = reply(page).getByTestId("tools");
  await expect(tools.locator("summary")).toHaveText("⏳ slow_tool 실행 중…");
  await expect(reply(page)).toHaveAttribute("data-status", "complete", { timeout: 10_000 });
  await expect(tools.locator("summary")).toHaveText("도구 사용 1개 · slow_tool");
  await tools.locator("summary").click();
  await expect(tools.locator(".t")).toContainText('slow_tool{"ms":2000}');
  await expect(tools.locator(".t")).toContainText('→ {"ok":true}');
  await expect(reply(page)).toContainText("끝났어요.");

  await send(page, "/secrettool");
  await expect(reply(page)).toHaveAttribute("data-status", "complete");
  const t2 = reply(page).getByTestId("tools");
  await t2.locator("summary").click();
  await expect(t2).toContainText("단진자 주기");
  await expect(t2).toContainText("[숨김]");
  await expect(page.getByTestId("thread")).not.toContainText(/sk-fake-secret-123|hunter2|tok-fake-456/);
});

test("usage limit: notice, error, and an offer to carry on with another runtime", async ({
  page,
  baseURL,
}) => {
  await openChat(page, baseURL!, "한도");
  await send(page, "/limit");
  const r = reply(page);
  await expect(r).toHaveAttribute("data-status", "error");
  await expect(r.getByTestId("notice")).toHaveText("사용 한도에 도달했어요 (가짜)");
  await expect(r.getByRole("alert")).toContainText("사용 한도에 도달했어요.");
  await r.getByRole("button", { name: "다른 런타임으로 이어가기" }).click();
  await expect(page.getByRole("dialog", { name: "런타임·모델 선택" })).toBeVisible();
  await page.keyboard.press("Escape");

  await send(page, "/error");
  await expect(reply(page)).toHaveAttribute("data-status", "error");
  await expect(reply(page).getByRole("alert")).toContainText("응답 중 오류가 났어요");
  await expect(reply(page).getByRole("button", { name: "↻ 다시 생성" })).toBeVisible();
  // After a reload the stream's text is gone, but the reply still says it failed.
  await page.reload();
  await expect(reply(page).getByRole("alert")).toContainText("응답이 끝나지 못했어요");
});

test("a dropped event stream shows that it is reconnecting, then carries on", async ({ page, baseURL }) => {
  await openChat(page, baseURL!, "재연결");
  let attempts = 0;
  await page.route("**/api/runs/*/events", (route) => (attempts++ === 0 ? route.abort() : route.continue()));
  await send(page, "/long 80");
  await expect(page.getByText("연결이 끊겼어요 — 다시 연결하는 중…")).toBeVisible();
  await expect(reply(page)).toContainText("단어80", { timeout: 15_000 });
  await expect(reply(page)).toHaveAttribute("data-status", "complete");
  await expect(page.getByText("연결이 끊겼어요 — 다시 연결하는 중…")).toHaveCount(0);
  expect(attempts).toBeGreaterThanOrEqual(2);
});

/** Reads the real event stream up to `count` events and returns them as text: a response cut mid-reply. */
async function partialStream(url: string, headers: Record<string, string>, count: number) {
  const ctrl = new AbortController();
  const res = await fetch(url, {
    headers: {
      cookie: headers.cookie ?? "",
      ...(headers["last-event-id"] ? { "last-event-id": headers["last-event-id"] } : {}),
    },
    signal: ctrl.signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while ((text.match(/^id: /gm) ?? []).length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  ctrl.abort();
  return text.slice(0, text.lastIndexOf("\n\n") + 2); // whole frames only
}

test("a stream cut mid-reply is resumed; a refused retry is resubscribed from the last event seen", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(60_000);
  await openChat(page, baseURL!, "중간 단절");
  const requests: string[] = [];
  let lastServed = 0; // highest event id the page has been given
  await page.route("**/api/runs/*/events*", async (route) => {
    const req = route.request();
    requests.push(req.url());
    const n = requests.length;
    // 1st and 2nd connection: cut after 20 events; EventSource reconnects by itself (it sends Last-Event-ID,
    // which Playwright does not show us — the page skips anything replayed, see the next test).
    if (n <= 2) {
      const body = await partialStream(req.url(), await req.allHeaders(), 20);
      for (const m of body.matchAll(/^id: (\d+)$/gm)) lastServed = Math.max(lastServed, Number(m[1]));
      return route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
        body,
      });
    }
    // 3rd: the server refuses — an HTTP error closes the EventSource for good; the page must resubscribe.
    if (n === 3)
      return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"x"}' });
    return route.continue();
  });
  await send(page, "/long 120");
  await expect(page.getByText("연결이 끊겼어요 — 다시 연결하는 중…")).toBeVisible({ timeout: 10_000 });
  await expect(reply(page)).toHaveAttribute("data-status", "complete", { timeout: 30_000 });

  expect(requests.length).toBeGreaterThanOrEqual(4);
  expect(lastServed).toBeGreaterThan(0);
  // Our resubscribe asks for what comes after the last event the page saw.
  expect(new URL(requests[3]!).searchParams.get("lastEventId")).toBe(String(lastServed));
  await expect(reply(page)).toContainText("단어120");
  await expect(page.getByText("연결이 끊겼어요 — 다시 연결하는 중…")).toHaveCount(0);
});

test("the live reply has every word exactly once after a cut and a resubscribe", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(60_000);
  await openChat(page, baseURL!, "중복 없음");
  let n = 0;
  await page.route("**/api/runs/*/events*", async (route) => {
    const req = route.request();
    n++;
    if (n === 1)
      return route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: await partialStream(req.url(), await req.allHeaders(), 30),
      });
    // 2nd: a replay that overlaps what the page already has (events 1–40 again): must not show twice.
    if (n === 2) {
      const { cookie = "" } = await req.allHeaders();
      return route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: await partialStream(req.url().split("?")[0]!, { cookie }, 40),
      });
    }
    if (n === 3) return route.fulfill({ status: 503, body: "" });
    return route.continue();
  });
  await send(page, "/long 300");
  // Read while it is still streaming: this is the live state, rebuilt from the events (not the saved reply).
  await expect(reply(page)).toContainText("단어120", { timeout: 30_000 });
  await expect(reply(page)).toHaveAttribute("data-status", "streaming");
  const text = (await reply(page).locator(".md").first().textContent()) ?? "";
  const words = [...text.matchAll(/단어(\d+)/g)].map((m) => Number(m[1]));
  expect(words.length).toBeGreaterThanOrEqual(120);
  expect(words).toEqual(words.map((_, i) => i + 1));
  expect(n).toBeGreaterThanOrEqual(4);
  await page.getByRole("button", { name: "■ 중지" }).click();
  await expect(reply(page)).toHaveAttribute("data-status", "stopped");
});

/** Every subscription opens and then ends at once with nothing in it (and asks to retry quickly). */
const EMPTY_STREAM = {
  status: 200,
  headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  body: "retry: 100\n\n",
};

test("a stream that keeps failing gives up (open without events does not reset the budget); 다시 연결 resumes", async ({
  page,
  baseURL,
}) => {
  await openChat(page, baseURL!, "연결 포기");
  let subscriptions = 0;
  await page.route("**/api/runs/*/events*", (route) => {
    subscriptions++;
    return route.fulfill(EMPTY_STREAM);
  });
  await send(page, "/long 120");
  const lostNotice = reply(page).getByText("연결이 끊겨 응답을 더 받아오지 못했어요", { exact: false });
  await expect(lostNotice).toBeVisible({ timeout: 15_000 });
  await expect(reply(page)).toHaveAttribute("data-status", "lost");
  const tried = subscriptions;
  expect(tried).toBeLessThanOrEqual(8); // the budget holds: no endless resubscribing
  await page.waitForTimeout(1500);
  expect(subscriptions).toBe(tried); // and nothing more after giving up
  // Not busy any more: the conversation can be edited, and the composer sends again.
  await expect(page.getByRole("button", { name: "✎ 수정" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "응답 생성 중" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "보내기" })).toBeVisible();

  await page.unroute("**/api/runs/*/events*");
  await reply(page).getByRole("button", { name: "다시 연결" }).click();
  await expect(lostNotice).toHaveCount(0);
  await expect(reply(page)).toContainText("단어120", { timeout: 15_000 });
  await expect(reply(page)).toHaveAttribute("data-status", "complete");
  const words = [...((await reply(page).locator(".md").first().textContent()) ?? "").matchAll(/단어(\d+)/g)];
  expect(words.map((m) => Number(m[1]))).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
});

test("after giving up, the reply is shown once the run has ended — without 다시 연결", async ({
  page,
  baseURL,
}) => {
  await openChat(page, baseURL!, "포기 후 끝남");
  await page.route("**/api/runs/*/events*", (route) => route.fulfill(EMPTY_STREAM));
  await send(page, "/long 30");
  await expect(reply(page)).toHaveAttribute("data-status", "lost", { timeout: 15_000 });
  await expect(reply(page)).toHaveAttribute("data-status", "complete", { timeout: 15_000 });
  await expect(reply(page)).toContainText("단어30");
  await expect(reply(page).getByText("연결이 끊겨", { exact: false })).toHaveCount(0);
});

test.describe("markdown chunk", () => {
  // The service worker serves cached assets itself; block it so the failed request is really the network's.
  test.use({ serviceWorkers: "block" });
  test("if the markdown renderer cannot be loaded, the reply stays readable and can retry", async ({
    page,
    baseURL,
  }) => {
    let block = true;
    await page.route(/\/assets\/Markdown-[^/]+\.(js|css)$/, (route) =>
      block ? route.abort() : route.continue(),
    );
    await openChat(page, baseURL!, "청크 실패");
    await send(page, "/md");
    await expect(reply(page)).toHaveAttribute("data-status", "complete");
    await expect(reply(page)).toContainText("주기는 진폭이 작을 때"); // plain text, still there
    await expect(reply(page).getByText("서식을 불러오지 못해 글자만 보여드려요.")).toBeVisible();
    await expect(page.getByTestId("user-message")).toHaveCount(1); // the page itself did not crash
    block = false;
    await reply(page).getByRole("button", { name: "다시 시도" }).click();
    await expect(reply(page).locator(".katex").first()).toBeVisible();
    await expect(reply(page).locator("table")).toBeVisible();
    await expect(reply(page).getByText("서식을 불러오지 못해 글자만 보여드려요.")).toHaveCount(0);
  });
});

test("editing with the keyboard: Escape returns focus to ✎ 수정, sending moves it to the composer", async ({
  page,
  baseURL,
}) => {
  await openChat(page, baseURL!, "포커스");
  await send(page, "처음 질문");
  await expect(reply(page)).toHaveAttribute("data-status", "complete");
  const edit = page.getByTestId("user-message").getByRole("button", { name: "✎ 수정" });
  await edit.focus();
  await page.keyboard.press("Enter");
  const box = page.getByLabel("메시지 수정");
  await expect(box).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
  await expect(edit).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(box).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("고친 질문");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("메시지 입력")).toBeFocused();
  await expect(reply(page)).toContainText("고친 질문");
});

test("follows the reply at the bottom, stops when scrolled up, ↓ brings it back", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 420 });
  await openChat(page, baseURL!, "스크롤");
  const thread = page.getByTestId("thread");
  const gap = () => thread.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  await send(page, "/long 400");
  await expect(reply(page)).toContainText("단어150", { timeout: 15_000 });
  expect(await thread.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  expect(await gap()).toBeLessThan(80);
  await thread.evaluate((el) => el.scrollTo({ top: 0 }));
  await expect(page.getByRole("button", { name: "↓ 맨 아래로" })).toBeVisible();
  await expect(reply(page)).toContainText("단어220", { timeout: 15_000 });
  expect(await thread.evaluate((el) => el.scrollTop)).toBeLessThan(50); // left where the user put it
  await page.getByRole("button", { name: "↓ 맨 아래로" }).click();
  await expect(reply(page)).toContainText("단어260", { timeout: 15_000 });
  expect(await gap()).toBeLessThan(80);
  await page.getByRole("button", { name: "■ 중지" }).click();
  await expect(reply(page)).toHaveAttribute("data-status", "stopped");
});

test("a 10,000-token reply streams without long main-thread tasks", async ({ page, baseURL }, info) => {
  test.skip(info.project.name !== "desktop", "measured once, on desktop Chrome");
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    const w = window as unknown as { __long: { start: number; duration: number }[] };
    w.__long = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__long.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: "longtask", buffered: true });
    // DOM updates come in one MutationObserver callback per React commit: counts renders of the stream.
    const m = window as unknown as { __commits: number };
    m.__commits = 0;
    new MutationObserver(() => m.__commits++).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  await openChat(page, baseURL!, "성능");
  // Load the markdown chunk first, so the measurement is about streaming, not about fetching code.
  await send(page, "/md");
  await expect(reply(page)).toHaveAttribute("data-status", "complete");
  await expect(reply(page).locator(".katex").first()).toBeVisible();
  const t0 = await page.evaluate(() => performance.now());
  const c0 = await page.evaluate(() => (window as unknown as { __commits: number }).__commits);
  await send(page, "/burst 10000");
  await expect(reply(page)).toContainText("단어10000", { timeout: 90_000 });
  await expect(reply(page)).toHaveAttribute("data-status", "complete");
  const t1 = await page.evaluate(() => performance.now());
  const commits = (await page.evaluate(() => (window as unknown as { __commits: number }).__commits)) - c0;
  const long = await page.evaluate(
    ({ t0, t1 }) =>
      (window as unknown as { __long: { start: number; duration: number }[] }).__long.filter(
        (e) => e.start >= t0 && e.start <= t1,
      ),
    { t0, t1 },
  );
  const over50 = long.filter((e) => e.duration > 50);
  const result = {
    streamMs: Math.round(t1 - t0),
    longTasks: long.length,
    over50ms: over50.length,
    maxMs: Math.round(Math.max(0, ...long.map((e) => e.duration))),
    domUpdates: commits,
  };
  info.annotations.push({ type: "perf", description: JSON.stringify(result) });
  console.log(`[perf] 10k-token stream: ${JSON.stringify(result)}`);
  // At most one render per animation frame (~60 a second), not one per token; slack for the final updates.
  expect(commits).toBeLessThanOrEqual(Math.ceil((result.streamMs / 1000) * 60 * 1.5) + 20);
  // Target: no task over 50 ms. A slow CI machine gets a little slack; the recorded numbers are the evidence.
  expect(over50.length).toBeLessThanOrEqual(process.env.CI ? 3 : 0);
});
