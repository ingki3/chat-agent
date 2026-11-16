import { expect, test, type Page, type Route } from "@playwright/test";
import { SON, newConversation, useAccount } from "./helpers.js";

/**
 * Enter right after a reply's `done` (#141): the composer stays busy until the run is read again as ended (the server
 * refuses a send while a run is active), and an Enter in that window is queued and sent then — never silently lost.
 * The window is held open deterministically: the `active-run` read that confirms the end is held by a route hook.
 */

const box = (page: Page) => page.getByLabel("메시지 입력");
const reply = (page: Page) => page.getByTestId("assistant").last();
const queued = (page: Page) => page.getByTestId("queued-send");

/** Opens a fresh conversation; `hold()` makes every later `active-run` read wait until `release()`. */
async function openHeld(page: Page, baseURL: string, title: string) {
  await useAccount(page, SON);
  const c = await newConversation(page.request, baseURL, `${title} ${Date.now()}`);
  let holding = false;
  const held: Route[] = [];
  await page.route(`**/api/conversations/${c.id}/active-run`, (route) => {
    if (holding) held.push(route);
    else void route.continue();
  });
  const sends: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith(`/api/conversations/${c.id}/messages`))
      sends.push(String((r.postDataJSON() as { text?: string }).text));
  });
  const first = page.waitForResponse((r) => r.url().endsWith(`/api/conversations/${c.id}/active-run`));
  await page.goto(`/c/${c.id}`);
  await first; // the page's own first read: not held
  await expect(page.locator(".topbar .title")).toHaveText(c.title);
  return {
    sends,
    held,
    hold: () => (holding = true),
    release: async () => {
      holding = false;
      for (const r of held.splice(0)) await r.continue();
    },
  };
}

/** First message answered (`done`, shown as complete) while the confirming `active-run` read is held. */
async function answeredButHeld(page: Page, h: Awaited<ReturnType<typeof openHeld>>, text: string) {
  h.hold();
  await box(page).fill(text);
  await box(page).press("Enter");
  await expect(box(page)).toHaveValue("");
  await expect(reply(page)).toHaveAttribute("data-status", "complete");
  await expect.poll(() => h.held.length).toBeGreaterThan(0);
  // Still busy: the run is not read as ended yet.
  await expect(page.getByRole("button", { name: "■ 중지" })).toBeVisible();
}

test("Enter right after `done` is queued and sent once the run is confirmed ended (#141)", async ({
  page,
  baseURL,
}) => {
  const h = await openHeld(page, baseURL!, "완료 직후 Enter");
  await answeredButHeld(page, h, "첫 질문 사과");

  await box(page).fill("두 번째 질문 배");
  await box(page).press("Enter");
  await expect(queued(page)).toBeVisible();
  await expect(queued(page)).toContainText("끝나면 바로 보낼게요");
  await expect(box(page)).toHaveValue("두 번째 질문 배");
  expect(h.sends).toEqual(["첫 질문 사과"]); // nothing reached the server while the run may be active

  await h.release();
  await expect(box(page)).toHaveValue("");
  await expect(queued(page)).toHaveCount(0);
  await expect(page.getByTestId("user-message")).toHaveCount(2);
  await expect(page.getByTestId("user-message").last()).toHaveText(/두 번째 질문 배/);
  await expect(reply(page)).toContainText("두 번째 질문 배");
  await expect(reply(page)).toHaveAttribute("data-status", "complete");
  expect(h.sends).toEqual(["첫 질문 사과", "두 번째 질문 배"]);
});

test("editing the text drops the queued send; Enter sends the edit once free (#141)", async ({
  page,
  baseURL,
}) => {
  const h = await openHeld(page, baseURL!, "대기 중 수정");
  await answeredButHeld(page, h, "첫 질문");

  await box(page).fill("보낼 뻔한 글");
  await box(page).press("Enter");
  await expect(queued(page)).toBeVisible();
  await box(page).fill("고친 글");
  await expect(queued(page)).toHaveCount(0);

  await h.release();
  await expect(page.getByRole("button", { name: "보내기" })).toBeEnabled();
  await expect(box(page)).toHaveValue("고친 글");
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  expect(h.sends).toEqual(["첫 질문"]);

  await box(page).press("Enter");
  await expect(box(page)).toHaveValue("");
  await expect(reply(page)).toContainText("고친 글");
  expect(h.sends).toEqual(["첫 질문", "고친 글"]);
});

test("stop or 취소 drops the queued send (#141)", async ({ page, baseURL }) => {
  const h = await openHeld(page, baseURL!, "대기 중 중지");
  await answeredButHeld(page, h, "첫 질문");

  await box(page).fill("취소할 글");
  await box(page).press("Enter");
  await expect(queued(page)).toBeVisible();
  await queued(page).getByRole("button", { name: "취소" }).click();
  await expect(queued(page)).toHaveCount(0);

  await box(page).press("Enter");
  await expect(queued(page)).toBeVisible();
  await page.getByRole("button", { name: "■ 중지" }).click();
  await expect(queued(page)).toHaveCount(0);

  await h.release();
  await expect(page.getByRole("button", { name: "보내기" })).toBeEnabled();
  await expect(box(page)).toHaveValue("취소할 글");
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  expect(h.sends).toEqual(["첫 질문"]);
});

test("Enter while the reply is still being written shows a hint and sends nothing later (#141)", async ({
  page,
  baseURL,
}) => {
  const h = await openHeld(page, baseURL!, "답변 중 Enter");
  // The reply's event stream is held: it stays streaming (no `done`) for as long as the test needs.
  const streams: Route[] = [];
  await page.route("**/api/runs/*/events*", (route) => void streams.push(route));
  await box(page).fill("첫 질문");
  await box(page).press("Enter");
  await expect(box(page)).toHaveValue("");
  await expect.poll(() => streams.length).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "■ 중지" })).toBeVisible();

  await box(page).fill("기다릴 수 없는 글");
  await box(page).press("Enter");
  await expect(page.getByTestId("busy-hint")).toHaveText("답변이 끝난 뒤에 보낼 수 있어요.");
  await expect(queued(page)).toHaveCount(0);

  await page.unroute("**/api/runs/*/events*");
  for (const r of streams.splice(0)) await r.continue();
  await h.release();
  await expect(reply(page)).toHaveAttribute("data-status", "complete");
  await expect(page.getByRole("button", { name: "보내기" })).toBeEnabled();
  await expect(page.getByTestId("busy-hint")).toHaveCount(0);
  await expect(box(page)).toHaveValue("기다릴 수 없는 글");
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  expect(h.sends).toEqual(["첫 질문"]);
});
