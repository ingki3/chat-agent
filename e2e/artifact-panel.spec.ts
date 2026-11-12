import crypto from "node:crypto";
import { expect, test, type Frame, type Page } from "@playwright/test";
import { MOM, SON, csrf, newConversation, useAccount } from "./helpers.js";

/**
 * The artifact panel next to the chat (#28, PRD FR-6.1·6.2·6.6): a card in the reply opens the panel; an edit
 * request makes v2; v1 can be viewed and restored (a copy as v3). On a phone the panel covers the screen. Runs on
 * the desktop and the mobile project. Artifacts are made through the real MCP tools (FakeRuntime commands).
 */

async function send(page: Page, text: string) {
  const box = page.getByLabel("메시지 입력");
  await box.fill(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
}

/** The panel's sandboxed frame showing `version`. */
async function panelFrame(page: Page, version: number): Promise<Frame> {
  const el = page.getByTestId("artifact-panel").getByTestId("artifact-frame");
  await expect(el).toHaveAttribute("data-version", String(version));
  await expect(el).toHaveAttribute("sandbox", "allow-scripts");
  const frame = await (await el.elementHandle())!.contentFrame();
  expect(frame).not.toBeNull();
  return frame!;
}

const lastAssistant = (page: Page) => page.getByTestId("assistant").last();

test("edit request → v2 → view v1 → revert, in the panel next to the chat (full screen on a phone)", async ({
  page,
  baseURL,
  isMobile,
}) => {
  await useAccount(page, MOM);
  const tag = crypto.randomUUID().slice(0, 8);
  const title = `패널 페이지 ${tag}`;
  const conv = await newConversation(page.request, baseURL!, `패널 ${tag}`);
  await page.goto(`/c/${conv.id}`);
  await expect(page.getByTestId("artifact-panel")).toHaveCount(0); // only while an artifact is open

  const entries = await page.evaluate(() => history.length);
  await send(page, `/artifact html ${title}\n<h1 id="t">첫 버전 ${tag}</h1>`);
  // Locators are lazy: pin each card to its own reply.
  const card1 = page.getByTestId("assistant").nth(0).getByTestId("artifact-card");
  await expect(card1).toHaveAttribute("data-version", "1");
  await expect(card1).toContainText(title);
  await expect(card1).toContainText("v1 만듦");
  await expect(lastAssistant(page)).toHaveAttribute("data-status", "complete");

  // Made in this reply: the panel opens by itself (FR-6.1 "바로 보인다"), no click.
  const panel = page.getByTestId("artifact-panel");
  await expect(panel).toBeVisible();
  const id = new URL(page.url()).searchParams.get("artifact")!;
  expect(id).toBeTruthy();
  await expect(page.getByTestId("artifact-panel-title")).toContainText(title);
  await expect((await panelFrame(page, 1)).locator("#t")).toHaveText(`첫 버전 ${tag}`);
  // The frame is the sandboxed original: no same-origin, so nothing of the app is reachable from it.
  await expect(panel.getByTestId("artifact-frame")).not.toHaveAttribute("sandbox", /allow-same-origin/);
  // Opened by the reply, the address was replaced (no extra history entry) and follows the newest version.
  expect(new URL(page.url()).searchParams.get("v")).toBeNull();
  expect(await page.evaluate(() => history.length)).toBe(entries);

  const vp = page.viewportSize()!;
  const box = (await panel.boundingBox())!;
  if (isMobile) {
    // A phone: the panel is the whole screen, and the chat under it is out of reach until it closes.
    await expect(panel).toHaveAttribute("data-full", "true");
    await expect(panel).toHaveAttribute("role", "dialog");
    expect(box).toEqual({ x: 0, y: 0, width: vp.width, height: vp.height });
    await expect(page.locator("main")).toHaveAttribute("inert", "");
    await expect(page.getByTestId("artifact-panel-title")).toBeFocused(); // a dialog takes focus
    await page.getByTestId("artifact-panel-close").click();
    await expect(panel).toHaveCount(0);
    await expect(page.locator("main")).not.toHaveAttribute("inert", "");
    expect(new URL(page.url()).searchParams.get("artifact")).toBeNull();
    await expect(page.getByLabel("메시지 입력")).toBeFocused(); // back to where the user was
  } else {
    // Beside the chat: the third column, the conversation stays usable.
    await expect(panel).toHaveAttribute("data-full", "false");
    expect(box.x).toBeGreaterThan(vp.width / 3);
    expect(box.x + box.width).toBeCloseTo(vp.width, 0);
    await expect(page.locator("main")).not.toHaveAttribute("inert", "");
    // Beside the chat, a panel the reply opened does not take the focus from the composer.
    await expect(page.getByLabel("메시지 입력")).toBeFocused();
    // Downloads are attachments: the HTML original as a file.
    const dl = page.waitForEvent("download");
    await panel.getByTestId("artifact-download").click();
    expect((await dl).suggestedFilename()).toMatch(/\.html$/);
  }

  // The edit request: the reply gets a v2 card.
  await send(page, `/artifact-update ${id} content\n<h1 id="t">둘째 버전 ${tag}</h1>`);
  const card2 = page.getByTestId("assistant").nth(1).getByTestId("artifact-card");
  await expect(card2).toHaveAttribute("data-version", "2");
  await expect(card2).toContainText("v2 새 버전");
  await expect(lastAssistant(page)).toHaveAttribute("data-status", "complete");
  // Desktop: the open panel followed the newest version. Phone (closed before): it opened again by itself.
  await expect(panel).toBeVisible();
  await expect((await panelFrame(page, 2)).locator("#t")).toHaveText(`둘째 버전 ${tag}`);
  await expect(panel.getByTestId("artifact-version")).toHaveValue("2");
  await expect(panel.getByTestId("artifact-revert")).toHaveCount(0); // nothing to restore on the newest

  // View v1: its own content, in a fresh sandboxed frame.
  await panel.getByTestId("artifact-version").selectOption("1");
  await expect((await panelFrame(page, 1)).locator("#t")).toHaveText(`첫 버전 ${tag}`);

  // Revert: a new version (v3) copying v1; v1 and v2 stay.
  await panel.getByTestId("artifact-revert").click();
  await expect(panel.getByTestId("artifact-version")).toHaveValue("3");
  await expect(panel.getByTestId("artifact-version").locator("option").first()).toHaveText(/v3 \(v1 복원\)/);
  await expect((await panelFrame(page, 3)).locator("#t")).toHaveText(`첫 버전 ${tag}`);
  const detail = (await (await page.request.get(`/api/artifacts/${id}`)).json()) as {
    latestVersion: number;
    versions: { version: number; revertedFrom: number | null }[];
  };
  expect(detail.latestVersion).toBe(3);
  expect(detail.versions.map((v) => [v.version, v.revertedFrom])).toEqual([
    [1, null],
    [2, null],
    [3, 1],
  ]);

  // The v1 card still opens v1 (the card's own version).
  if (isMobile) await page.getByTestId("artifact-panel-close").click();
  await card1.click();
  await expect((await panelFrame(page, 1)).locator("#t")).toHaveText(`첫 버전 ${tag}`);

  // Escape closes — also with the focus inside the sandboxed frame (its one message to the app), and the focus goes
  // back to the card that opened it.
  await (await panelFrame(page, 1)).locator("#t").click();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(card1).toBeFocused();
  // A link with the address opens it again (a reload keeps it).
  await page.goto(`/c/${conv.id}?artifact=${encodeURIComponent(id)}`);
  await expect((await panelFrame(page, 3)).locator("#t")).toHaveText(`첫 버전 ${tag}`);
});

test("the artifact list: mine across conversations, reopened in its conversation; shared is empty until #52", async ({
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

  // Opens in its conversation's panel.
  await items.nth(0).getByRole("link", { name: made[1]!.title }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${made[1]!.conv}\\?artifact=`));
  await expect(page.getByTestId("artifact-panel-title")).toContainText(made[1]!.title);
  const frame = page.getByTestId("artifact-panel").getByTestId("artifact-frame");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  // A table: its original (CSV) and its page as HTML, both attachments.
  await expect(page.getByTestId("artifact-download")).toHaveAttribute("href", /\/v\/1\/download$/);
  await expect(page.getByTestId("artifact-download-html")).toHaveAttribute(
    "href",
    /\/v\/1\/download\?format=html$/,
  );

  await page.goto("/artifacts");
  await page.getByRole("tab", { name: "공유받은 것" }).click();
  await expect(page.getByTestId("artifacts-shared-empty")).toBeVisible();

  // Another family member: none of these in the list, and the panel refuses the id.
  const ctx = await browser.newContext({ baseURL: baseURL! });
  const son = await ctx.newPage();
  await useAccount(son, SON);
  await son.goto("/artifacts");
  await expect(son.getByRole("tab", { name: "내가 만든 것" })).toHaveAttribute("aria-selected", "true");
  await expect(son.getByText(tag)).toHaveCount(0);
  const mine = await newConversation(son.request, baseURL!, `아들 ${tag}`);
  const momId = new URL(page.url()).searchParams.get("artifact");
  expect(momId).toBeNull(); // /artifacts has no panel parameter
  const list = (await (await page.request.get("/api/artifacts")).json()) as {
    items: { id: string; title: string }[];
  };
  const target = list.items.find((a) => a.title === made[0]!.title)!.id;
  await son.goto(`/c/${mine.id}?artifact=${encodeURIComponent(target)}`);
  await expect(son.getByTestId("artifact-panel").getByRole("alert")).toHaveText(
    "이 아티팩트를 볼 권한이 없어요.",
  );
  await expect(son.getByTestId("artifact-frame")).toHaveCount(0);
  await expect(son.getByText("메모")).toHaveCount(0);
  await ctx.close();
});

test("new artifacts open by themselves unless the user picked another; focus returns to the last card; not on reload", async ({
  page,
  baseURL,
  isMobile,
}) => {
  await useAccount(page, MOM);
  const tag = crypto.randomUUID().slice(0, 8);
  const conv = await newConversation(page.request, baseURL!, `자동 ${tag}`);
  await page.goto(`/c/${conv.id}`);
  const panel = page.getByTestId("artifact-panel");
  const title = page.getByTestId("artifact-panel-title");
  const card = (i: number) => page.getByTestId("assistant").nth(i).getByTestId("artifact-card");
  const make = async (name: string) => {
    if (isMobile && (await panel.count())) await page.getByTestId("artifact-panel-close").click();
    await send(page, `/artifact markdown ${name} ${tag}\n# ${name}`);
    await expect(lastAssistant(page)).toHaveAttribute("data-status", "complete");
  };

  await make("가");
  await expect(title).toContainText(`가 ${tag}`);
  // The next reply's new artifact replaces one a reply opened.
  await make("나");
  await expect(title).toContainText(`나 ${tag}`);
  // The user's own pick stays: a later new artifact does not take the panel over.
  if (isMobile) await page.getByTestId("artifact-panel-close").click();
  await card(0).click();
  await expect(title).toContainText(`가 ${tag}`);
  if (!isMobile) {
    await send(page, `/artifact markdown 다 ${tag}\n# 다`);
    await expect(lastAssistant(page)).toHaveAttribute("data-status", "complete");
    await expect(card(2)).toContainText(`다 ${tag}`);
    await expect(title).toContainText(`가 ${tag}`);
    // Switching between cards while open: closing returns the focus to the last one used.
    await card(1).click();
    await expect(title).toContainText(`나 ${tag}`);
    await card(0).click();
    await expect(title).toContainText(`가 ${tag}`);
    await page.getByTestId("artifact-panel-close").click();
    await expect(panel).toHaveCount(0);
    await expect(card(0)).toBeFocused();
  } else {
    await page.getByTestId("artifact-panel-close").click();
    await expect(card(0)).toBeFocused();
  }

  // Old replies never open the panel: a fresh load of the conversation shows none.
  await page.goto(`/c/${conv.id}`);
  await expect(card(0)).toBeVisible();
  await expect(panel).toHaveCount(0);
});

test("a run this page did not start (seen again on load) never opens the panel, even while it streams", async ({
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
  // Its parts are replayed from the stream while it still runs: the card is there, the panel is not.
  await expect(reply.getByTestId("artifact-card")).toContainText(`늦은 ${tag}`);
  await expect(reply).toHaveAttribute("data-status", "streaming");
  await expect(page.getByTestId("artifact-panel")).toHaveCount(0);
  await expect(reply).toHaveAttribute("data-status", "complete", { timeout: 15_000 });
  await expect(page.getByTestId("artifact-panel")).toHaveCount(0);
});

test("the frame's Escape message closes the panel only from the frame on screen and only in its exact shape", async ({
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
  const panel = page.getByTestId("artifact-panel");
  const frame = await panelFrame(page, 1);
  await frame.locator("#bad").click();
  await frame.locator("#other").click();
  // The same message from the app page itself (not the frame) is ignored too.
  await page.evaluate(() => window.postMessage({ type: "agentlee:escape" }, "*"));
  await page.waitForTimeout(300);
  await expect(panel).toBeVisible();
  await frame.locator("#ok").click();
  await expect(panel).toHaveCount(0);
});
