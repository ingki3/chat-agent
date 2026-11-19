import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  csrf,
  MOM,
  newConversation,
  newMember,
  openSources,
  signIn,
  SON,
  sourceStatuses,
  useAccount,
} from "./helpers.js";

/**
 * Citations (#25, PRD FR-5.1–5.5, 수용 기준 3): `[n]` markers (side by side ones one chip, #150), the source list
 * under the answer — folded behind its summary, failures always listed — with each citation's server-checked
 * status, the preview (hover on desktop, tap on mobile), the missing-citation warning, numbers carried over to a
 * follow-up (#150) and the research-mode toggle. The FakeRuntime `/cite <scenario>` command makes real `web_fetch` / `cite` calls
 * on the citation fixture pages (served in-process — no network); the check and the screen are the real ones.
 */

const PAGE_A = "https://fixture.agentlee.test/news/chips-a.html";
const SNIPPET =
  "산업통상자원부는 10일 10월 반도체 수출이 전년 같은 달보다 32% 늘어난 142억 달러로 집계됐다고 밝혔다.";
const OK = "원문 구절 확인";

async function ask(page: Page, text: string, timeout = 15_000) {
  const before = await page.getByTestId("source-note").count();
  const replies = await page.getByTestId("assistant").count();
  await page.getByLabel("메시지 입력").fill(text);
  await page.getByRole("button", { name: "보내기" }).click();
  // The reply runs to its end (allow for a busy machine: all specs run in parallel), then the note is there.
  await expect(page.getByTestId("assistant")).toHaveCount(replies + 1, { timeout });
  const reply = page.getByTestId("assistant").last();
  await expect(reply).toHaveAttribute("data-status", "complete", { timeout });
  await expect(page.getByTestId("source-note")).toHaveCount(before + 1);
  return reply;
}

async function newChat(page: Page, text: string, timeout?: number) {
  await page.goto("/");
  const reply = await ask(page, text, timeout);
  await page.waitForURL(/\/c\/[^/]+$/);
  return { reply, id: page.url().split("/c/")[1]! };
}

test("verified citations: markers, the source list and the preview with 원문 열기", async ({
  page,
  isMobile,
}) => {
  await useAccount(page, MOM);
  const { reply } = await newChat(page, "/cite conflict");
  const markers = reply.getByTestId("citation-marker");
  await expect(markers).toHaveText(["1", "2", "3"]);
  for (const m of await markers.all()) await expect(m).toHaveAttribute("data-status", "verified");
  // Folded: the summary only (#150).
  await expect(reply.getByTestId("citation-summary")).toHaveText("출처 3개 · 모두 확인됨");
  const rows = reply.getByTestId("citation-source");
  await expect(rows).toHaveCount(0);
  await openSources(reply);
  await expect(rows).toHaveCount(3);
  // Title (the link to the original), site and date — no URL text, no "원문 구절 확인" in the list.
  const title = rows.nth(0).getByTestId("citation-link");
  await expect(title).toHaveText("10월 반도체 수출 32% 증가");
  await expect(title).toHaveAttribute("href", PAGE_A);
  await expect(rows.nth(0)).toContainText("가나다 신문 · 2026-11-10");
  await expect(rows.nth(0)).not.toContainText(PAGE_A);
  await expect(reply.getByTestId("source-note")).not.toContainText(OK);
  await expect(reply.getByTestId("citation-status")).toHaveCount(0);
  await expect(reply.getByTestId("citation-missing-warning")).toHaveCount(0);

  // Preview: hover on desktop, tap on mobile.
  const first = markers.nth(0);
  if (isMobile) await first.tap();
  else await first.hover();
  const preview = reply.getByTestId("citation-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText(OK);
  await expect(preview).toContainText(SNIPPET);
  const open = preview.getByRole("link", { name: /원문 열기/ });
  await expect(open).toHaveAttribute("href", PAGE_A);
  await expect(open).toHaveAttribute("target", "_blank");
  await expect(open).toHaveAttribute("rel", /noopener/);
  if (isMobile) {
    await first.tap();
    await expect(preview).toHaveCount(0);
  } else {
    await page.mouse.move(0, 0);
    await expect(preview).toHaveCount(0);
    // A click pins it; Esc closes.
    await first.click();
    await page.mouse.move(0, 0);
    await expect(reply.getByTestId("citation-preview")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(reply.getByTestId("citation-preview")).toHaveCount(0);
  }
});

test("failed citations are never shown as normal: ⚠️ in the marker, the list and the preview", async ({
  page,
  isMobile,
}) => {
  await useAccount(page, MOM);
  const { reply } = await newChat(page, "/cite insufficient");
  await expect(reply.getByTestId("citation-marker")).toHaveText(["1", "2⚠️", "3⚠️"]);
  // Folded, the failures still show: in the summary and as rows (#150, FR-5.2).
  await expect(reply.getByTestId("citation-summary")).toHaveText("출처 3개 · ⚠️ 확인 안 된 출처 2개");
  await expect(reply.getByTestId("citation-status")).toHaveText([
    "⚠️ 출처에서 이 내용을 찾지 못했어요",
    "⚠️ 출처를 가져오지 못했어요",
  ]);
  await expect(reply.locator('[data-testid="citation-source"][data-status="verified"]')).toHaveCount(0);
  await openSources(reply);
  await expect(reply.locator('[data-testid="citation-source"][data-status="verified"]')).toHaveCount(1);
  const failed = reply.getByTestId("citation-marker").nth(1);
  if (isMobile) await failed.tap();
  else await failed.hover();
  const preview = reply.getByTestId("citation-preview");
  await expect(preview).toContainText("⚠️ 출처에서 이 내용을 찾지 못했어요");
  await expect(preview).not.toContainText(OK);
  await expect(preview).toContainText("인용하려던 구절");
  // "출처가 충분하지 않아요." is not a claim: no missing-citation warning here.
  await expect(reply.getByTestId("citation-missing-warning")).toHaveCount(0);
});

test("paragraphs without a citation are marked in the answer, counted in one line (#202)", async ({
  page,
}) => {
  await useAccount(page, MOM);
  const { reply } = await newChat(page, "/cite partial");
  await expect(reply.getByTestId("citation-missing-warning")).toHaveText(/^⚠️ 출처 표시 없는 문단 2개/);
  // Marked where they are (a paragraph, a list item) — the note does not repeat them.
  await expect(reply.getByTestId("citation-missing")).toHaveText([
    "업계는 내년에도 두 자릿수 증가를 예상해요.⚠️",
    "미국 수출 비중이 가장 컸어요⚠️",
  ]);
  await expect(reply.getByTestId("source-note")).not.toContainText("두 자릿수");
});

/** The marked paragraphs of a reply and the summary line that moves to them (#202). */
async function jumpThrough(reply: Locator, isMobile: boolean) {
  const marks = reply.getByTestId("citation-missing");
  const jump = reply.getByTestId("citation-missing-warning");
  // A button once the marks are drawn (plain text before: nowhere to move to yet).
  await expect(jump).toHaveJSProperty("tagName", "BUTTON");
  const n = await marks.count();
  for (let i = 0; i <= n; i++) {
    if (isMobile) await jump.tap();
    else await jump.click();
    // From the first, round again after the last; each one brought into view.
    await expect(marks.nth(i % n)).toBeFocused();
    await expect(marks.nth(i % n)).toBeInViewport();
  }
}

test("#202 production shape: progress notes, a cited table, an opinion said so and the closing offer are not flagged", async ({
  page,
  isMobile,
}) => {
  await useAccount(page, MOM);
  const { reply } = await newChat(page, "/cite advice");
  await expect(reply.getByTestId("citation-marker")).toHaveText(["1", "2", "3", "1"]);
  const marks = reply.getByTestId("citation-missing");
  await expect(marks).toHaveText([
    "전망: 업계는 내년에도 두 자릿수 증가를 예상해요⚠️",
    "미국 수출 비중이 가장 컸어요.⚠️",
  ]);
  await expect(marks.nth(0)).toHaveJSProperty("tagName", "LI");
  await expect(marks.nth(1)).toHaveJSProperty("tagName", "P");
  await expect(reply.getByTestId("citation-missing-warning")).toHaveText(/^⚠️ 출처 표시 없는 문단 2개/);
  // Nothing of the answer is repeated in the note; the table is drawn as a table, never as markdown rows.
  const note = reply.getByTestId("source-note");
  await expect(note).not.toContainText("미국 수출");
  await expect(reply).not.toContainText("|---|");
  await expect(reply.locator("table")).toHaveCount(1);
  // Not flagged: the progress notes, the table, the opinion, the offer.
  for (const t of [
    "자료를 찾아 볼게요.",
    "이제 다음 자료를 확인하고 있어요.",
    "제 판단으로는",
    "원하시면 품목별로",
  ])
    await expect(reply.locator('[data-testid="citation-missing"]', { hasText: t })).toHaveCount(0);
  await expect(reply.getByText("원하시면 품목별로 더 자세히 정리해 드릴게요.")).toBeVisible();
  // The bar is the theme's warning colour, light and dark.
  const bar = () => marks.nth(1).evaluate((el) => getComputedStyle(el).boxShadow);
  await page.emulateMedia({ colorScheme: "light" });
  const light = await bar();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(bar).not.toBe(light);
  expect(light).toMatch(/inset/);
  await page.emulateMedia({ colorScheme: "light" });
  await jumpThrough(reply, isMobile);
});

test("#202: a shared view marks the same paragraphs and its summary line moves to them", async ({
  page,
  browser,
  baseURL,
  isMobile,
}) => {
  const owner = await newMember(browser, baseURL!, "cite202-owner");
  const viewer = await newMember(browser, baseURL!, "cite202-viewer");
  await signIn(page, baseURL!, owner);
  const conv = await newConversation(page.request, baseURL!, `출처 표시 공유 ${Date.now()}`);
  const sent = await page.request.post(`/api/conversations/${conv.id}/messages`, {
    data: { text: "/cite partial" },
    headers: csrf(baseURL!),
  });
  expect(sent.status()).toBe(201);
  const { run } = (await sent.json()) as { run: { id: string } };
  await expect
    .poll(
      async () =>
        ((await (await page.request.get(`/api/runs/${run.id}`)).json()) as { endedAt: unknown }).endedAt,
      {
        timeout: 15_000,
      },
    )
    .not.toBeNull();
  const share = await page.request.post(`/api/conversations/${conv.id}/shares`, {
    data: { target: { audience: "users", userIds: [viewer.id] }, mode: "live" },
    headers: csrf(baseURL!),
  });
  expect(share.status()).toBe(201);
  const { id } = (await share.json()) as { id: string };
  // The viewer on the same device as the project (desktop, or the phone).
  const use = test.info().project.use;
  const ctx = await browser.newContext({
    baseURL: baseURL!,
    ...(use.viewport ? { viewport: use.viewport } : {}),
    ...(use.userAgent ? { userAgent: use.userAgent } : {}),
    isMobile: use.isMobile ?? false,
    hasTouch: use.hasTouch ?? false,
  });
  const vpage = await ctx.newPage();
  await signIn(vpage, baseURL!, viewer);
  await vpage.goto(`/shared/${id}`);
  const view = vpage.getByTestId("shared-view");
  await expect(view.getByTestId("citation-missing")).toHaveText([
    "업계는 내년에도 두 자릿수 증가를 예상해요.⚠️",
    "미국 수출 비중이 가장 컸어요⚠️",
  ]);
  await expect(view.getByTestId("citation-missing-warning")).toHaveText(/^⚠️ 출처 표시 없는 문단 2개/);
  await jumpThrough(view, isMobile);
  await ctx.close();
});

test("existing sources are reused in the same conversation; another conversation's or user's id is unknown", async ({
  page,
  browser,
  baseURL,
}) => {
  await useAccount(page, MOM);
  const { id } = await newChat(page, "/cite conflict");
  const reuse = await ask(page, "/cite reuse");
  await expect(reuse.getByTestId("citation-marker")).toHaveText(["1", "2", "3⚠️"]);
  await expect.poll(() => sourceStatuses(reuse)).toEqual(["verified", "verified", "unknown_source"]);
  await expect(reuse.getByTestId("citation-status")).toHaveText(["⚠️ 출처를 가져오지 못했어요"]);

  const list = await page.request.get(`/api/conversations/${id}/sources`);
  const sourceId = ((await list.json()) as { items: { id: string }[] }).items[0]!.id;
  // Same user, another conversation.
  const other = await newChat(page, `/cite-id ${sourceId} ${SNIPPET}`);
  await expect(other.reply.getByTestId("citation-marker")).toHaveText(["1⚠️"]);
  await expect(other.reply.getByTestId("citation-status")).toHaveText(["⚠️ 출처를 가져오지 못했어요"]);
  await expect(other.reply.getByTestId("citation-source")).not.toContainText(PAGE_A);

  // Another user.
  const ctx = await browser.newContext({ baseURL: baseURL! });
  const son = await ctx.newPage();
  await useAccount(son, SON);
  const theirs = await newChat(son, `/cite-id ${sourceId} ${SNIPPET}`);
  await expect(theirs.reply.getByTestId("citation-status")).toHaveText(["⚠️ 출처를 가져오지 못했어요"]);
  await ctx.close();
});

test(
  "thirty sources (#150): one chip per marker group, the list folded, the failing source shown while folded",
  { tag: "@heavy" },
  async ({ page, isMobile }, testInfo) => {
    test.setTimeout(90_000);
    await useAccount(page, MOM);
    // The thirty pages first, then the answer citing them (two light runs instead of one with sixty tool calls).
    // Each step waits for its run to finish, whatever the machine (the test budget is 90 s).
    await newChat(page, "/cite fetchmany", 40_000);
    const reply = await ask(page, "/cite many", 40_000);
    // Ten paragraphs of `[a][b][c]`: ten chips of three numbers, each its own button.
    const chips = reply.getByTestId("citation-chip");
    await expect(chips).toHaveCount(10);
    await expect(chips.nth(0).getByTestId("citation-marker")).toHaveText(["1", "2", "3"]);
    await expect(chips.nth(0)).toHaveAttribute("aria-label", "출처 1, 2, 3");
    await expect(chips.nth(0).getByTestId("citation-marker").nth(1)).toHaveAttribute(
      "aria-label",
      `출처 2: ${OK}`,
    );
    await expect(chips.nth(2).getByTestId("citation-marker")).toHaveText(["7⚠️", "8", "9"]);
    await expect(reply.getByTestId("citation-marker")).toHaveCount(30);

    // Folded: the summary and the one failing row — never hidden.
    const toggle = reply.getByTestId("citation-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(reply.getByTestId("citation-summary")).toHaveText("출처 30개 · ⚠️ 확인 안 된 출처 1개");
    const rows = reply.getByTestId("citation-source");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-status", "snippet_not_found");
    await expect(rows.first()).toContainText("지표 7번 동향");
    await expect(rows.first().getByTestId("citation-status")).toHaveText(
      "⚠️ 출처에서 이 내용을 찾지 못했어요",
    );
    await reply.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("citations-folded.png"), fullPage: true });

    // A number in a chip opens its own preview and link while the list is folded.
    const second = chips.nth(1).getByTestId("citation-marker").nth(2);
    if (isMobile) await second.tap();
    else await second.click();
    const preview = reply.getByTestId("citation-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("지표 6번 동향");
    await expect(preview.getByRole("link", { name: /원문 열기/ })).toHaveAttribute(
      "href",
      "https://fixture.agentlee.test/news/many-6.html",
    );
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);

    // Unfolded: all thirty, in order, title·site·date only.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(rows).toHaveCount(30);
    await expect(rows.nth(5).getByTestId("citation-link")).toHaveText("지표 6번 동향");
    await expect(rows.nth(5)).toContainText("뉴스6 일보 · 2026-11-07");
    await expect(rows.nth(5)).not.toContainText("https://");
    await expect(reply.getByTestId("citation-status")).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("citations-open.png"), fullPage: true });
    // Folded again: the failure is still there.
    await toggle.click();
    await expect(rows).toHaveCount(1);
  },
);

test("a follow-up that reuses the previous answer's numbers shows them verified, not ⚠️ (#150)", async ({
  page,
}) => {
  await useAccount(page, MOM);
  await newChat(page, "/cite conflict");
  const recap = await ask(page, "/cite recap");
  // [1][3] one chip; [9] was never a number of the previous answer.
  await expect(recap.getByTestId("citation-marker")).toHaveText(["1", "3", "2", "9⚠️"]);
  await expect(recap.getByTestId("citation-chip").first().getByTestId("citation-marker")).toHaveText([
    "1",
    "3",
  ]);
  await expect(recap.getByTestId("citation-summary")).toHaveText("출처 4개 · ⚠️ 확인 안 된 출처 1개");
  await expect
    .poll(() => sourceStatuses(recap))
    .toEqual(["verified", "verified", "verified", "unknown_source"]);
  await expect(recap.getByTestId("citation-source").nth(0).getByTestId("citation-link")).toHaveAttribute(
    "href",
    PAGE_A,
  );
});

test("research mode is a per-conversation toggle kept by the server", async ({ page, baseURL }) => {
  await useAccount(page, MOM);
  const { id } = await newChat(page, "/cite partial");
  const toggle = page.getByTestId("research-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const conv = await page.request.get(`/api/conversations/${id}`, { headers: csrf(baseURL!) });
  expect(((await conv.json()) as { researchMode: boolean }).researchMode).toBe(true);
  await page.reload();
  await expect(page.getByTestId("research-toggle")).toHaveAttribute("aria-pressed", "true");
  // Another conversation is not affected.
  await newChat(page, "/cite partial");
  await expect(page.getByTestId("research-toggle")).toHaveAttribute("aria-pressed", "false");
});

test("an answer that used no source: no source box, its made-up [n] flagged ⚠️ with a notice (#185, review #190)", async ({
  page,
}) => {
  await useAccount(page, MOM);
  await page.goto("/");
  // The fake echoes the message: no tool, a sentence-end [1] and an array index.
  await page.getByLabel("메시지 입력").fill("최신 수출은 32% 증가했다[1]. 배열 a[2] 은 그대로예요");
  await page.getByRole("button", { name: "보내기" }).click();
  const reply = page.getByTestId("assistant").last();
  await expect(reply).toHaveAttribute("data-status", "complete", { timeout: 15_000 });
  await expect(reply).toContainText("최신 수출은 32% 증가했다");
  await expect(reply.getByTestId("source-note")).toHaveCount(0);
  await expect(reply.getByTestId("citation-unbacked")).toContainText("근거에 연결되지 않은 출처 표시");
  await expect(reply.getByTestId("citation-marker")).toHaveText(["1⚠️"]);
  await expect(reply).toContainText("a[2]");
  await expect(reply).not.toContainText(OK);
});
