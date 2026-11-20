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

/**
 * Opens a fresh conversation; `hold()` makes every later `active-run` read wait until `release()`; `fail(true)` makes
 * them answer 500 (counted in `failures`) until `fail(false)`.
 */
async function openHeld(page: Page, baseURL: string, title: string) {
  await useAccount(page, SON);
  const c = await newConversation(page.request, baseURL, `${title} ${Date.now()}`);
  let holding = false;
  let failing = false;
  let failures = 0;
  const held: Route[] = [];
  await page.route(`**/api/conversations/${c.id}/active-run`, (route) => {
    if (failing) {
      failures++;
      void route.fulfill({ status: 500, json: { error: "internal", message: "시험용 실패" } });
    } else if (holding) held.push(route);
    else void route.continue();
  });
  const sends: string[] = [];
  /** The file ids each send carried. */
  const sentFiles: string[][] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith(`/api/conversations/${c.id}/messages`)) {
      const body = r.postDataJSON() as { text?: string; fileIds?: string[] };
      sends.push(String(body.text));
      sentFiles.push(body.fileIds ?? []);
    }
  });
  const first = page.waitForResponse((r) => r.url().endsWith(`/api/conversations/${c.id}/active-run`));
  await page.goto(`/c/${c.id}`);
  await first; // the page's own first read: not held
  await expect(page.locator(".topbar .title")).toHaveText(c.title);
  return {
    sends,
    sentFiles,
    held,
    failures: () => failures,
    fail: (on: boolean) => (failing = on),
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

const chips = (page: Page) => page.getByTestId("attachment");
const pick = (page: Page, name: string) =>
  page
    .getByTestId("file-input")
    .setInputFiles([{ name, mimeType: "text/plain", buffer: Buffer.from(`시험 내용 ${name}`) }]);

test("adding a file while an Enter is queued drops it: nothing goes, during or after the upload (#141)", async ({
  page,
  baseURL,
}) => {
  const h = await openHeld(page, baseURL!, "대기 중 파일 추가");
  await answeredButHeld(page, h, "첫 질문");

  await box(page).fill("파일 없이 보낼 글");
  await box(page).press("Enter");
  await expect(queued(page)).toBeVisible();
  await pick(page, "추가.txt");
  await expect(queued(page)).toHaveCount(0);
  await expect(chips(page).first()).toHaveAttribute("data-status", "done"); // after the upload, too
  await h.release();
  await expect(page.getByRole("button", { name: "보내기" })).toBeEnabled();
  await expect(box(page)).toHaveValue("파일 없이 보낼 글");
  expect(h.sends).toEqual(["첫 질문"]);

  // Sent on purpose now: with the file.
  await box(page).press("Enter");
  await expect(box(page)).toHaveValue("");
  await expect.poll(() => h.sentFiles.length).toBe(2);
  expect(h.sentFiles[1]).toHaveLength(1);
});

test("removing a file while an Enter is queued drops it (#141)", async ({ page, baseURL }) => {
  const h = await openHeld(page, baseURL!, "대기 중 파일 빼기");
  await answeredButHeld(page, h, "첫 질문");

  await pick(page, "뺄.txt");
  await expect(chips(page).first()).toHaveAttribute("data-status", "done");
  await box(page).fill("파일과 보낼 글");
  await box(page).press("Enter");
  await expect(queued(page)).toBeVisible();
  await page.getByRole("button", { name: "뺄.txt 빼기" }).click();
  await expect(queued(page)).toHaveCount(0);
  await h.release();
  await expect(page.getByRole("button", { name: "보내기" })).toBeEnabled();
  await expect(box(page)).toHaveValue("파일과 보낼 글");
  expect(h.sends).toEqual(["첫 질문"]);
});

test("Enter while a file is still uploading says so, in the window too, and sends nothing later (#141)", async ({
  page,
  baseURL,
}) => {
  const h = await openHeld(page, baseURL!, "올리는 중 Enter");
  await answeredButHeld(page, h, "첫 질문");
  // The upload is held: it stays "올리는 중" for as long as the test needs.
  const uploads: Route[] = [];
  await page.route("**/api/conversations/*/files", (route) =>
    route.request().method() === "POST" ? void uploads.push(route) : void route.continue(),
  );
  await pick(page, "느린.txt");
  await expect.poll(() => uploads.length).toBe(1);
  await expect(chips(page).first()).toHaveAttribute("data-status", "uploading");

  await box(page).fill("올린 뒤 보낼 글");
  await box(page).press("Enter");
  await expect(page.getByTestId("upload-hint")).toHaveText("파일을 다 올린 뒤에 보낼 수 있어요.");
  await expect(page.getByTestId("upload-hint")).toHaveAttribute("role", "status");
  await expect(queued(page)).toHaveCount(0);

  await page.unroute("**/api/conversations/*/files");
  await uploads[0]!.continue();
  await expect(chips(page).first()).toHaveAttribute("data-status", "done");
  await expect(page.getByTestId("upload-hint")).toHaveCount(0);
  await h.release();
  await expect(page.getByRole("button", { name: "보내기" })).toBeEnabled();
  await expect(box(page)).toHaveValue("올린 뒤 보낼 글");
  expect(h.sends).toEqual(["첫 질문"]);
});

test("a failing end-of-run read is tried again while finishing: the queued Enter goes once one succeeds (#141)", async ({
  page,
  baseURL,
}) => {
  const h = await openHeld(page, baseURL!, "종료 확인 실패");
  h.fail(true);
  await box(page).fill("첫 질문");
  await box(page).press("Enter");
  await expect(box(page)).toHaveValue("");
  await expect(reply(page)).toHaveAttribute("data-status", "complete");
  // The read after `done` and its one retry fail; only the check kept up while finishing asks a third time.
  await expect.poll(() => h.failures(), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  await expect(page.getByRole("button", { name: "■ 중지" })).toBeVisible(); // still busy: never cleared on a guess

  await box(page).fill("실패 뒤 보낼 글");
  await box(page).press("Enter");
  await expect(queued(page)).toBeVisible();
  expect(h.sends).toEqual(["첫 질문"]);

  h.fail(false);
  await expect(box(page)).toHaveValue("", { timeout: 10_000 });
  await expect(queued(page)).toHaveCount(0);
  await expect(reply(page)).toContainText("실패 뒤 보낼 글");
  expect(h.sends).toEqual(["첫 질문", "실패 뒤 보낼 글"]);
});

test("one end-of-run check at a time, and a stale `null` never wipes the next run: its stream and ■ 중지 stay (#141, #103)", async ({
  page,
  baseURL,
}) => {
  const h = await openHeld(page, baseURL!, "늦은 종료 확인");
  // After `done`: the check of the run's end is held — busy all along, and no second check alongside it.
  h.hold();
  await box(page).fill("첫 질문");
  await box(page).press("Enter");
  await expect(reply(page)).toHaveAttribute("data-status", "complete");
  await expect.poll(() => h.held.length).toBe(1);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 4500))); // two of the 2 s ticks
  expect(h.held).toHaveLength(1);
  await expect(page.getByRole("button", { name: "■ 중지" })).toBeVisible();
  await h.release();
  await expect(page.getByRole("button", { name: "보내기" })).toBeVisible();

  // The next run keeps going (it waits at a gate) and its stream is held.
  const gate = crypto.randomUUID();
  const streams: Route[] = [];
  await page.route("**/api/runs/*/events*", (route) => void streams.push(route));
  await box(page).fill(`/gate ${gate}`);
  await box(page).press("Enter");
  await expect(box(page)).toHaveValue("");
  await expect.poll(() => streams.length).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "■ 중지" })).toBeVisible();

  // A stale `null` (as a read sent before the send would answer): the next read of the run (on reconnecting, once
  // its data is stale) gets it. The run in progress is not let go on it — its end is settled, and it has none.
  let stale = 0;
  await page.route(`**/api/conversations/*/active-run`, (route) =>
    stale++ === 0 ? route.fulfill({ json: { run: null } }) : route.fallback(),
  );
  // Never freed, not even for a moment (a let-go and a later pick-up would flash 보내기).
  await page.evaluate(() => {
    const w = window as unknown as { freed?: boolean };
    w.freed = false;
    const check = () => {
      if ([...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "보내기"))
        w.freed = true;
    };
    new MutationObserver(check).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 5500));
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
  });
  await expect.poll(() => stale, { timeout: 10_000 }).toBeGreaterThan(1); // the stale one, then the settle's own read
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300))); // its handling has run
  await expect(page.getByRole("button", { name: "■ 중지" })).toBeVisible();
  await expect(page.getByRole("button", { name: "보내기" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { freed?: boolean }).freed)).toBe(false);
  await expect(reply(page)).not.toHaveAttribute("data-status", "complete");

  // Let it end: the stream carries on, the reply completes.
  const other = await newConversation(page.request, baseURL!, `gate ${gate}`);
  const released = await page.request.post(`/api/conversations/${other.id}/messages`, {
    data: { text: `/release ${gate}` },
    headers: { origin: baseURL!, "x-agent-lee": "1", "Idempotency-Key": crypto.randomUUID() },
  });
  expect(released.ok()).toBe(true);
  await page.unroute("**/api/runs/*/events*");
  for (const r of streams.splice(0)) await r.continue();
  await expect(reply(page)).toContainText("끝났어요");
  await expect(reply(page)).toHaveAttribute("data-status", "complete");
  expect(h.sends).toEqual(["첫 질문", `/gate ${gate}`]);
});
