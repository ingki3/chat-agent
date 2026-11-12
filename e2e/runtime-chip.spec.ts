import { expect, test, type Page } from "@playwright/test";
import { ADMIN, csrf, newMember, signIn, useAccount } from "./helpers.js";

/**
 * #19, acceptance 7: a new conversation starts on the defaults with no picking step; the chip changes one
 * conversation from its next message on; the FR-12.6 fallback is announced once. The e2e server's FakeRuntime is
 * "Claude Code" with Fake Large, Fake Small and Opus 5.5 (the service default), no connection needed. Each test
 * makes its own account, so parallel runs never change each other's defaults.
 */

const box = (page: Page) => page.getByLabel("메시지 입력");
const reply = (page: Page) => page.getByTestId("assistant").last();
const chip = (page: Page) => page.locator("#runtime-chip");

async function sendFromNewChat(page: Page, text: string) {
  await page.goto("/");
  await box(page).fill(text);
  await box(page).press("Enter");
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/);
  await expect(reply(page)).toHaveAttribute("data-status", "complete");
}

/** What the server says answered the last reply (not only what the page shows). */
async function lastReply(page: Page) {
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  const r = await page.request.get(`/api/conversations/${id}/messages`);
  const items = ((await r.json()) as { items: { role: string; runtime: string; model: string }[] }).items;
  return items.findLast((m) => m.role === "assistant")!;
}

test("acceptance 7: nothing set → Opus 5.5; a saved default is used by the next new chat; older chats keep theirs", async ({
  page,
  browser,
  baseURL,
}) => {
  const me = await newMember(browser, baseURL!, "ac7");
  await signIn(page, baseURL!, me);

  // Nothing set: the new chat shows the service default and is answered by it — no picking step.
  await page.goto("/");
  await expect(chip(page)).toContainText("Claude Code · Opus 5.5");
  await sendFromNewChat(page, "첫 질문");
  expect(await lastReply(page)).toMatchObject({ runtime: "claude-code", model: "claude-opus-5-5" });
  const first = page.url();
  await expect(page.getByTestId("fallback-notice")).toHaveCount(0);

  // Settings → 기본 런타임·모델: Fake Small.
  await page.goto("/settings");
  await page.getByLabel("Claude Code 기본 모델").selectOption({ label: "Fake Small" });
  await page.getByRole("button", { name: "기본값 저장" }).click();
  await expect(page.getByRole("region", { name: "기본 런타임·모델" }).getByRole("status")).toContainText(
    "기본값을 저장했어요",
  );

  // 새 대화 → type → send: answered with the new default right away.
  await page.goto("/");
  await expect(chip(page)).toContainText("Claude Code · Fake Small");
  await sendFromNewChat(page, "둘째 질문");
  expect(await lastReply(page)).toMatchObject({ runtime: "claude-code", model: "fake-small" });
  await expect(reply(page)).toContainText("fake-small");

  // The first conversation did not change with the defaults (FR-12.5).
  await page.goto(first);
  await expect(chip(page)).toContainText("Claude Code · Opus 5.5");
  await box(page).fill("기본값 바꾼 뒤");
  await box(page).press("Enter");
  await expect(page.getByTestId("assistant")).toHaveCount(2);
  await expect(reply(page)).toHaveAttribute("data-status", "complete");
  expect(await lastReply(page)).toMatchObject({ model: "claude-opus-5-5" });
});

test("the chip changes this conversation from the next message, with a divider; a forbidden effort is 403", async ({
  page,
  browser,
  baseURL,
}) => {
  const me = await newMember(browser, baseURL!, "chip");
  await signIn(page, baseURL!, me);
  await sendFromNewChat(page, "안녕");
  await chip(page).click();
  const pop = page.getByRole("dialog", { name: "런타임·모델 선택" });
  await pop.getByLabel("모델").selectOption({ label: "Fake Large" });
  await expect(chip(page)).toContainText("Claude Code · Fake Large");
  await pop.getByLabel("추론 강도").selectOption("low");
  await expect(page.getByTestId("chip-pending")).toBeVisible();
  // Nothing written yet: the divider comes with the next reply.
  await expect(page.getByTestId("divider")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
  await box(page).fill("바꾼 뒤");
  await box(page).press("Enter");
  await expect(page.getByTestId("assistant")).toHaveCount(2);
  await expect(reply(page)).toHaveAttribute("data-status", "complete");
  await expect(page.getByTestId("divider")).toHaveText(/여기부터\s*Claude Code · Fake Large/);
  await expect(reply(page)).toContainText("fake-large");
  expect(await lastReply(page)).toMatchObject({ model: "fake-large" });
  await expect(page.getByTestId("chip-pending")).toHaveCount(0);

  // The same check through the API: an effort Fake Small does not take is refused.
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  const r = await page.request.put(`/api/conversations/${id}/settings`, {
    data: { model: "fake-small", effort: "high" },
    headers: csrf(baseURL!),
  });
  expect(r.status()).toBe(403);
  expect(await r.json()).toEqual({ error: "effort_not_allowed" });
});

test("a default that cannot be used: the fallback starts the chat and says so once; the settings say so too", async ({
  page,
  browser,
  baseURL,
}) => {
  const me = await newMember(browser, baseURL!, "fallback");
  // The admin allows him only Fake Large: his (service) default Opus 5.5 cannot be used.
  const adminCtx = await browser.newContext({ baseURL: baseURL! });
  const admin = await adminCtx.newPage();
  await useAccount(admin, ADMIN);
  const put = await admin.request.put(`/api/admin/users/${me.id}/runtime-policies`, {
    data: {
      items: [
        {
          runtime: "claude-code",
          allowed: true,
          models: ["fake-large"],
          efforts: "all",
          allowPersonal: true,
          allowShared: true,
        },
      ],
    },
    headers: csrf(baseURL!),
  });
  expect(put.status()).toBe(200);
  await adminCtx.close();

  await signIn(page, baseURL!, me);
  await sendFromNewChat(page, "대체");
  expect(await lastReply(page)).toMatchObject({ model: "fake-large" });
  await expect(page.getByTestId("fallback-notice")).toHaveText(
    "기본값을 쓸 수 없어 Claude Code · Fake Large로 시작했어요",
  );
  // Once: not after a reload.
  await page.reload();
  await expect(reply(page)).toHaveAttribute("data-status", "complete");
  await expect(chip(page)).toContainText("Claude Code · Fake Large");
  await expect(page.getByTestId("fallback-notice")).toHaveCount(0);

  await page.goto("/settings");
  await expect(page.getByTestId("defaults-start")).toContainText(
    "새 대화는 Claude Code · Fake Large로 시작해요",
  );
});
