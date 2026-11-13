import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { MOM, SON, csrf, newConversation, useAccount } from "./helpers.js";

/** File uploads (#22, FR-4.1·4.6): attach button, drag and drop, paste; checks before upload; chips; serving. */

const PDF = Buffer.from("%PDF-1.7\n1 0 obj <<>> endobj\n%%EOF\n");
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

async function openChat(page: Page, baseURL: string, who: { email: string }, title: string) {
  await useAccount(page, who);
  const c = await newConversation(page.request, baseURL, `${title} ${Date.now()}`);
  await page.goto(`/c/${c.id}`);
  await expect(page.locator(".topbar .title")).toHaveText(c.title);
  return c;
}

const chips = (page: Page) => page.getByTestId("attachment");

// Several tests hold requests with page.route. Once the app's service worker controls the page, Chromium sends the
// page's requests through it and page.route no longer sees them (flaky). No test here needs the worker.
test.use({ serviceWorkers: "block" });

/** Drops (or pastes) files on the composer the way a browser does: a DataTransfer with File objects. */
async function dropFiles(page: Page, files: { name: string; text: string }[], how: "drop" | "paste") {
  await page.evaluate(
    ({ files, how }) => {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(new File([f.text], f.name, { type: "text/plain" }));
      if (how === "paste") {
        const target = document.querySelector("textarea[aria-label='메시지 입력']")!;
        target.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
        );
      } else {
        const target = document.querySelector("[data-testid='composer']")!;
        for (const type of ["dragover", "drop"])
          target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
      }
    },
    { files, how },
  );
}

test("attach, drop and paste files; the chips upload; the message carries them; the original downloads", async ({
  page,
  baseURL,
}) => {
  const c = await openChat(page, baseURL!, SON, "첨부");
  await page.getByTestId("file-input").setInputFiles([
    { name: "숙제.pdf", mimeType: "application/pdf", buffer: PDF },
    { name: "사진.png", mimeType: "image/png", buffer: PNG },
  ]);
  await dropFiles(page, [{ name: "드롭.txt", text: "끌어다 놓은 메모" }], "drop");
  await dropFiles(page, [{ name: "붙여넣기.md", text: "# 붙여 넣은 메모" }], "paste");
  await expect(chips(page)).toHaveCount(4);
  for (let i = 0; i < 4; i++) await expect(chips(page).nth(i)).toHaveAttribute("data-status", "done");

  await page.getByLabel("메시지 입력").fill("이 파일들 봐 줘");
  await page.getByLabel("메시지 입력").press("Enter");
  const sent = page.getByTestId("user-message").last();
  await expect(sent.getByTestId("file-ref")).toHaveCount(4);
  await expect(sent.getByTestId("file-ref").first()).toHaveText(/숙제\.pdf/);
  await expect(chips(page)).toHaveCount(0);

  const list = (await (await page.request.get(`/api/conversations/${c.id}/files`)).json()) as {
    items: { id: string; name: string; messageId: string | null }[];
  };
  expect(list.items.map((f) => f.name).sort()).toEqual(
    ["드롭.txt", "붙여넣기.md", "사진.png", "숙제.pdf"].sort(),
  );
  expect(list.items.every((f) => f.messageId)).toBe(true);
  const pdf = list.items.find((f) => f.name === "숙제.pdf")!;
  const href = await sent.getByTestId("file-ref").first().getAttribute("href");
  expect(href).toBe(`/api/files/${pdf.id}/content`);
  const r = await page.request.get(href!);
  expect(r.status()).toBe(200);
  expect(Buffer.from(await r.body()).equals(PDF)).toBe(true);
  expect(r.headers()["content-disposition"]).toMatch(/^attachment; /);
  expect(r.headers()["x-content-type-options"]).toBe("nosniff");
});

test("checked before upload: over 50MB, an unsupported type and the 21st file fail on the chip; ✕ removes", async ({
  page,
  baseURL,
}) => {
  await openChat(page, baseURL!, SON, "한도");
  let uploads = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/files$/.test(new URL(r.url()).pathname)) uploads++;
  });
  // Over Playwright's in-memory limit too: a sparse file on disk (51MB, no data written).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-e2e-big-"));
  const big = path.join(dir, "큰파일.pdf");
  fs.writeFileSync(big, "");
  fs.truncateSync(big, 51 * 1024 * 1024);
  try {
    await page.getByTestId("file-input").setInputFiles(big);
    await page
      .getByTestId("file-input")
      .setInputFiles([{ name: "그림.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).nth(0)).toHaveAttribute("data-status", "failed");
  await expect(chips(page).nth(0)).toContainText("50MB");
  await expect(chips(page).nth(1)).toHaveAttribute("data-status", "failed");
  await expect(chips(page).nth(1)).toContainText("지원하지 않는 형식");
  expect(uploads).toBe(0); // refused before anything was sent

  await chips(page).nth(0).getByRole("button", { name: /빼기/ }).click();
  await chips(page).nth(0).getByRole("button", { name: /빼기/ }).click();
  await expect(chips(page)).toHaveCount(0);

  // 21 at once: 20 go, the 21st is stopped on the chip.
  await page.getByTestId("file-input").setInputFiles(
    Array.from({ length: 21 }, (_, i) => ({
      name: `${i + 1}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from(`f${i}`),
    })),
  );
  await expect(chips(page)).toHaveCount(21);
  await expect(chips(page).nth(20)).toHaveAttribute("data-status", "failed");
  await expect(chips(page).nth(20)).toContainText("20개");
  for (let i = 0; i < 20; i++) await expect(chips(page).nth(i)).toHaveAttribute("data-status", "done");
  expect(uploads).toBe(20);
});

test("a disguised file fails on its chip with the server's reason", async ({ page, baseURL }) => {
  await openChat(page, baseURL!, SON, "위장");
  await page
    .getByTestId("file-input")
    .setInputFiles([{ name: "보고서.pdf", mimeType: "application/pdf", buffer: PNG }]);
  await expect(chips(page).first()).toHaveAttribute("data-status", "failed");
  await expect(chips(page).first()).toContainText("확장자와 달라요");
});

test("a file in a new chat: the conversation is made with the first file", async ({ page }) => {
  await useAccount(page, SON);
  await page.goto("/");
  await page
    .getByTestId("file-input")
    .setInputFiles([{ name: "새대화.txt", mimeType: "text/plain", buffer: Buffer.from("x") }]);
  await expect(chips(page).first()).toHaveAttribute("data-status", "done");
  await page.getByLabel("메시지 입력").fill("새 대화에 파일");
  await page.getByLabel("메시지 입력").press("Enter");
  await expect(page).toHaveURL(/\/c\//);
  await expect(page.getByTestId("user-message").getByTestId("file-ref")).toHaveText(/새대화\.txt/);
});

test("another family member's file URL is 403", async ({ page, browser, baseURL }) => {
  const c = await openChat(page, baseURL!, MOM, "엄마 파일");
  await page
    .getByTestId("file-input")
    .setInputFiles([{ name: "엄마.pdf", mimeType: "application/pdf", buffer: PDF }]);
  await expect(chips(page).first()).toHaveAttribute("data-status", "done");
  const list = (await (await page.request.get(`/api/conversations/${c.id}/files`)).json()) as {
    items: { id: string }[];
  };
  const id = list.items[0]!.id;
  const ctx = await browser.newContext({ baseURL: baseURL! });
  const son = await ctx.newPage();
  await useAccount(son, SON);
  for (const path of [`/api/files/${id}`, `/api/files/${id}/content`, `/api/conversations/${c.id}/files`])
    expect((await son.request.get(path)).status(), path).toBe(403);
  await ctx.close();
});

test("a chip removed while it uploads: the file is deleted as soon as the upload ends", async ({
  page,
  baseURL,
}) => {
  const c = await openChat(page, baseURL!, SON, "업로드 중 빼기");
  let deletes = 0;
  page.on("request", (r) => {
    if (r.method() === "DELETE" && /^\/api\/uploads\//.test(new URL(r.url()).pathname)) deletes++;
  });
  // The server stores the file at once; its answer reaches the page only later.
  let answered!: () => void;
  const late = new Promise<void>((r) => (answered = r));
  await page.route(/\/api\/conversations\/[^/]+\/files$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const response = await route.fetch();
    await late;
    await route.fulfill({ response });
  });
  await page
    .getByTestId("file-input")
    .setInputFiles([{ name: "느린.txt", mimeType: "text/plain", buffer: Buffer.from("slow") }]);
  await expect(chips(page).first()).toHaveAttribute("data-status", "uploading");
  await expect
    .poll(
      async () =>
        ((await (await page.request.get(`/api/conversations/${c.id}/files`)).json()) as { items: unknown[] })
          .items.length,
    )
    .toBe(1);
  await chips(page).first().getByRole("button", { name: /빼기/ }).click();
  await expect(chips(page)).toHaveCount(0);
  answered();
  await expect.poll(() => deletes).toBe(1);
  await expect
    .poll(
      async () =>
        ((await (await page.request.get(`/api/conversations/${c.id}/files`)).json()) as { items: unknown[] })
          .items.length,
    )
    .toBe(0);
  await expect(chips(page)).toHaveCount(0);
});

test("unsent files come back as chips after a reload: they can be removed or sent", async ({
  page,
  baseURL,
}) => {
  const c = await openChat(page, baseURL!, SON, "새로고침");
  await page.getByTestId("file-input").setInputFiles([
    { name: "남길.txt", mimeType: "text/plain", buffer: Buffer.from("keep") },
    { name: "뺄.txt", mimeType: "text/plain", buffer: Buffer.from("drop") },
  ]);
  for (let i = 0; i < 2; i++) await expect(chips(page).nth(i)).toHaveAttribute("data-status", "done");
  await page.reload();
  await expect(chips(page)).toHaveCount(2);
  await chips(page).filter({ hasText: "뺄.txt" }).getByRole("button", { name: /빼기/ }).click();
  await expect(chips(page)).toHaveCount(1);
  await expect
    .poll(async () =>
      (
        (await (await page.request.get(`/api/conversations/${c.id}/files`)).json()) as {
          items: { name: string }[];
        }
      ).items.map((f) => f.name),
    )
    .toEqual(["남길.txt"]);
  await page.reload();
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page).first()).toHaveAttribute("data-status", "done");
  await page.getByLabel("메시지 입력").fill("새로고침 뒤에 보냄");
  await page.getByLabel("메시지 입력").press("Enter");
  await expect(page.getByTestId("user-message").last().getByTestId("file-ref")).toHaveText(/남길\.txt/);
  await expect(chips(page)).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("user-message").last().getByTestId("file-ref")).toHaveCount(1);
  await expect(chips(page)).toHaveCount(0);
});

test("20 unsent files restored, one removed: its place is free for a new one", async ({ page, baseURL }) => {
  const c = await openChat(page, baseURL!, SON, "자리 비우기");
  for (let i = 0; i < 20; i++) {
    const r = await page.request.post(`/api/conversations/${c.id}/files`, {
      headers: {
        ...csrf(baseURL!),
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(`${i + 1}.txt`),
        "x-upload-id": crypto.randomUUID(),
      },
      data: Buffer.from(`file ${i}`),
    });
    expect(r.status()).toBe(201);
  }
  await page.reload();
  await expect(chips(page)).toHaveCount(20);
  const deleted = page.waitForResponse((r) => r.request().method() === "DELETE" && r.ok());
  await chips(page).filter({ hasText: "1.txt" }).first().getByRole("button", { name: /빼기/ }).click();
  await deleted;
  await expect(chips(page)).toHaveCount(19);
  await page
    .getByTestId("file-input")
    .setInputFiles([{ name: "새것.txt", mimeType: "text/plain", buffer: Buffer.from("new") }]);
  await expect(chips(page)).toHaveCount(20);
  await expect(chips(page).filter({ hasText: "새것.txt" })).toHaveAttribute("data-status", "done");
});

test("a file added while a send is under way stays as an unsent chip and goes with the next message", async ({
  page,
  baseURL,
}) => {
  await openChat(page, baseURL!, SON, "전송 중 첨부");
  await page
    .getByTestId("file-input")
    .setInputFiles([{ name: "A.txt", mimeType: "text/plain", buffer: Buffer.from("a") }]);
  await expect(chips(page).first()).toHaveAttribute("data-status", "done");
  // Hold the send's answer until B is uploaded.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let holding = true;
  await page.route(/\/api\/conversations\/[^/]+\/messages$/, async (route) => {
    if (route.request().method() !== "POST" || !holding) return route.fallback();
    holding = false;
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  await page.getByLabel("메시지 입력").fill("A만 보냄");
  await page.getByLabel("메시지 입력").press("Enter");
  await page
    .getByTestId("file-input")
    .setInputFiles([{ name: "B.txt", mimeType: "text/plain", buffer: Buffer.from("b") }]);
  await expect(chips(page).filter({ hasText: "B.txt" })).toHaveAttribute("data-status", "done");
  release();
  const first = page.getByTestId("user-message").filter({ hasText: "A만 보냄" });
  await expect(first.getByTestId("file-ref")).toHaveText([/A\.txt/]);
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page).first()).toContainText("B.txt");
  await expect(page.getByTestId("assistant").last()).toHaveAttribute("data-status", "complete");
  await page.getByLabel("메시지 입력").fill("B도 보냄");
  // Sent once the previous reply has let the composer go (the button says when).
  await expect(page.getByRole("button", { name: "보내기" })).toBeEnabled();
  await page.getByRole("button", { name: "보내기" }).click();
  await expect(
    page.getByTestId("user-message").filter({ hasText: "B도 보냄" }).getByTestId("file-ref"),
  ).toHaveText([/B\.txt/]);
  await expect(chips(page)).toHaveCount(0);
});

test("new chat: a file still uploading when the first send moves to the conversation shows up there", async ({
  page,
}) => {
  await useAccount(page, SON);
  await page.goto("/");
  await page
    .getByTestId("file-input")
    .setInputFiles([{ name: "A.txt", mimeType: "text/plain", buffer: Buffer.from("a") }]);
  await expect(chips(page).first()).toHaveAttribute("data-status", "done");
  const gate = () => {
    let open!: () => void;
    const p = new Promise<void>((r) => (open = r));
    return { p, open };
  };
  const sendHeld = gate();
  const bStored = gate();
  const bHeld = gate();
  // The send's answer waits until B's upload has started; B goes on only once the page has moved on.
  await page.route(/\/api\/conversations\/[^/]+\/messages$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const response = await route.fetch();
    await sendHeld.p;
    await route.fulfill({ response });
  });
  await page.route(/\/api\/conversations\/[^/]+\/files$/, async (route) => {
    if (route.request().method() !== "POST" || route.request().headers()["x-file-name"] !== "B.txt")
      return route.fallback();
    // B is still on its way: it reaches the server only after the conversation page has loaded its file list.
    bStored.open();
    await bHeld.p;
    await route.fulfill({ response: await route.fetch() });
  });
  await page.getByLabel("메시지 입력").fill("A와 함께");
  await page.getByLabel("메시지 입력").press("Enter");
  await page
    .getByTestId("file-input")
    .setInputFiles([{ name: "B.txt", mimeType: "text/plain", buffer: Buffer.from("b") }]);
  await bStored.p;
  const listed = page.waitForResponse(
    (r) =>
      r.request().method() === "GET" && /\/api\/conversations\/[^/]+\/files$/.test(new URL(r.url()).pathname),
  );
  sendHeld.open();
  await expect(page).toHaveURL(/\/c\//);
  await listed;
  await expect(page.getByTestId("user-message").first().getByTestId("file-ref")).toHaveText([/A\.txt/]);
  // The conversation page has its file list (A, sent) before B arrives.
  await expect(chips(page)).toHaveCount(0);
  bHeld.open();
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page).first()).toContainText("B.txt");
  await expect(chips(page).first()).toHaveAttribute("data-status", "done");
  await expect(page.getByTestId("assistant").last()).toHaveAttribute("data-status", "complete");
  await page.getByLabel("메시지 입력").fill("B도");
  // Sent once the previous reply has let the composer go (the button says when).
  await expect(page.getByRole("button", { name: "보내기" })).toBeEnabled();
  await page.getByRole("button", { name: "보내기" }).click();
  await expect(
    page.getByTestId("user-message").filter({ hasText: "B도" }).getByTestId("file-ref"),
  ).toHaveText([/B\.txt/]);
});

test("new chat: a failed conversation create is tried again on the next action", async ({ page }) => {
  await useAccount(page, SON);
  await page.goto("/");
  let creates = 0;
  await page.route(/\/api\/conversations$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    creates++;
    if (creates === 1)
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"shutting_down"}',
      });
    return route.fallback();
  });
  await page
    .getByTestId("file-input")
    .setInputFiles([{ name: "첫시도.txt", mimeType: "text/plain", buffer: Buffer.from("x") }]);
  await expect(chips(page).first()).toHaveAttribute("data-status", "failed");
  await page
    .getByTestId("file-input")
    .setInputFiles([{ name: "둘째.txt", mimeType: "text/plain", buffer: Buffer.from("y") }]);
  await expect(chips(page).nth(1)).toHaveAttribute("data-status", "done");
  expect(creates).toBe(2);
  await chips(page).first().getByRole("button", { name: /빼기/ }).click();
  await page.getByLabel("메시지 입력").fill("다시 됨");
  await page.getByLabel("메시지 입력").press("Enter");
  await expect(page).toHaveURL(/\/c\//);
  await expect(page.getByTestId("user-message").getByTestId("file-ref")).toHaveText([/둘째\.txt/]);
  expect(creates).toBe(2);
});

/** A promise and the function that settles it. */
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}
const isFiles = (url: string) => /\/api\/conversations\/[^/]+\/files$/.test(new URL(url).pathname);

/**
 * New chat: A sent while B uploads; B's chip is removed. `bFirst`: B's upload (and its DELETE, held) is done before
 * the page moves; otherwise the page moves first and B finishes there (the review's order).
 *
 * The cancel (`DELETE /api/uploads/:uploadId`) goes out the moment the chip is removed, not when B's upload ends: its
 * arrival says nothing about B being stored. Each step waits on the server's answer to B itself (`bStored`), so the
 * new page's list is read only once B is really on the server and its delete is still held (#103).
 */
async function cancelledDuringMove(page: Page, bFirst: boolean) {
  await useAccount(page, SON);
  await page.goto("/");
  await page
    .getByTestId("file-input")
    .setInputFiles([{ name: "A.txt", mimeType: "text/plain", buffer: Buffer.from("a") }]);
  await expect(chips(page).first()).toHaveAttribute("data-status", "done");
  const sendHeld = gate();
  const bSeen = gate();
  const bGo = gate();
  const bStored = gate();
  const delSeen = gate();
  const delGo = gate();
  let deletes = 0;
  const lists: number[] = [];
  await page.route(/\/api\/conversations\/[^/]+\/messages$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const response = await route.fetch();
    await sendHeld.p;
    await route.fulfill({ response });
  });
  await page.route(/\/api\/conversations\/[^/]+\/files$/, async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      const response = await route.fetch();
      const body = (await response.json()) as { items: { name: string }[] };
      lists.push(body.items.filter((f) => f.name === "B.txt").length);
      return route.fulfill({ response });
    }
    if (req.headers()["x-file-name"] !== "B.txt") return route.fallback();
    bSeen.open();
    await bGo.p;
    const response = await route.fetch();
    // The server has answered for B: it is stored (its cancel is still held below).
    expect(response.status()).toBe(201);
    bStored.open();
    await route.fulfill({ response });
  });
  await page.route(/\/api\/uploads\/[^/]+$/, async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    deletes++;
    delSeen.open();
    await delGo.p;
    await route.fulfill({ response: await route.fetch() });
  });
  await page.getByLabel("메시지 입력").fill("A만");
  await page.getByLabel("메시지 입력").press("Enter");
  await page
    .getByTestId("file-input")
    .setInputFiles([{ name: "B.txt", mimeType: "text/plain", buffer: Buffer.from("b") }]);
  await bSeen.p;
  await chips(page).filter({ hasText: "B.txt" }).getByRole("button", { name: /빼기/ }).click();
  if (bFirst) {
    // B is stored and its DELETE is on its way (held) before the page moves: the new page's first list has B.
    // Waiting on the DELETE alone is not enough: it was sent at the click, while B could still be in flight (#103).
    bGo.open();
    await delSeen.p;
    await bStored.p;
  }
  const listed = page.waitForResponse((r) => r.request().method() === "GET" && isFiles(r.url()));
  sendHeld.open();
  await expect(page).toHaveURL(/\/c\//);
  await listed;
  if (!bFirst) {
    // The review's order: B finishes on the new page, its DELETE is held; any list read now still has B.
    const bAnswered = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        isFiles(r.url()) &&
        r.request().headers()["x-file-name"] === "B.txt",
    );
    bGo.open();
    await delSeen.p;
    await bStored.p;
    await bAnswered;
    // A chip wrongly restored from B's answer would show up now: give it the time to.
    await page.waitForTimeout(500);
  }
  await expect(chips(page)).toHaveCount(0);
  delGo.open();
  await expect.poll(() => deletes).toBe(1);
  await expect(chips(page)).toHaveCount(0);
  await expect(page.getByTestId("assistant").last()).toHaveAttribute("data-status", "complete");
  await page.getByLabel("메시지 입력").fill("다음 메시지");
  await expect(page.getByRole("button", { name: "보내기" })).toBeEnabled();
  await page.getByRole("button", { name: "보내기" }).click();
  await expect(page.getByTestId("user-message").filter({ hasText: "다음 메시지" })).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  // List reads the page still makes (refetches) must not outlive the test.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  return lists;
}

test("a cancelled upload that finishes after the new chat moved on is not restored (review order)", async ({
  page,
}) => {
  await cancelledDuringMove(page, false);
});

test("a cancelled upload whose delete is still on its way is not restored from the new page's list", async ({
  page,
}) => {
  const lists = await cancelledDuringMove(page, true);
  // The new page's list really had B (the delete had not finished): the session's discarded set kept it out.
  expect(lists.some((n) => n === 1)).toBe(true);
});

test("a send refused for a file that is gone drops that chip; the next send goes through", async ({
  page,
  baseURL,
}) => {
  const c = await openChat(page, baseURL!, SON, "사라진 파일");
  await page
    .getByTestId("file-input")
    .setInputFiles([{ name: "곧사라짐.txt", mimeType: "text/plain", buffer: Buffer.from("x") }]);
  await expect(chips(page).first()).toHaveAttribute("data-status", "done");
  // Removed elsewhere (another tab, another device).
  const list = (await (await page.request.get(`/api/conversations/${c.id}/files`)).json()) as {
    items: { id: string }[];
  };
  expect(
    (await page.request.delete(`/api/files/${list.items[0]!.id}`, { headers: csrf(baseURL!) })).status(),
  ).toBe(200);
  await page.getByLabel("메시지 입력").fill("첫 시도");
  await page.getByRole("button", { name: "보내기" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "첨부 파일을 찾지 못했어요" })).toBeVisible();
  await expect(chips(page)).toHaveCount(0);
  await page.getByRole("button", { name: "보내기" }).click();
  await expect(page.getByTestId("user-message").filter({ hasText: "첫 시도" })).toHaveCount(1);
});

test("review order 6: B stored, its answer held, the new page lists it, the next send goes, then B answers", async ({
  page,
}) => {
  await useAccount(page, SON);
  await page.goto("/");
  await page
    .getByTestId("file-input")
    .setInputFiles([{ name: "A.txt", mimeType: "text/plain", buffer: Buffer.from("a") }]);
  await expect(chips(page).first()).toHaveAttribute("data-status", "done");
  const sendHeld = gate();
  const bStored = gate();
  const bAnswer = gate();
  const cancelSeen = gate();
  const cancelGo = gate();
  let first = true;
  const lists: number[] = [];
  await page.route(/\/api\/conversations\/[^/]+\/messages$/, async (route) => {
    if (route.request().method() !== "POST" || !first) return route.fallback();
    first = false;
    const response = await route.fetch();
    await sendHeld.p;
    await route.fulfill({ response });
  });
  await page.route(/\/api\/conversations\/[^/]+\/files$/, async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      const response = await route.fetch();
      const body = (await response.json()) as { items: { name: string }[] };
      lists.push(body.items.filter((f) => f.name === "B.txt").length);
      return route.fulfill({ response });
    }
    if (req.headers()["x-file-name"] !== "B.txt") return route.fallback();
    // B is stored on the server; the page hears about it only at the very end.
    const response = await route.fetch();
    bStored.open();
    await bAnswer.p;
    await route.fulfill({ response });
  });
  await page.route(/\/api\/uploads\/[^/]+$/, async (route) => {
    cancelSeen.open();
    await cancelGo.p;
    await route.fulfill({ response: await route.fetch() });
  });
  await page.getByLabel("메시지 입력").fill("A만");
  await page.getByLabel("메시지 입력").press("Enter");
  await page
    .getByTestId("file-input")
    .setInputFiles([{ name: "B.txt", mimeType: "text/plain", buffer: Buffer.from("b") }]);
  await bStored.p;
  await chips(page).filter({ hasText: "B.txt" }).getByRole("button", { name: /빼기/ }).click();
  await cancelSeen.p;
  const listed = page.waitForResponse((r) => r.request().method() === "GET" && isFiles(r.url()));
  sendHeld.open();
  await expect(page).toHaveURL(/\/c\//);
  await listed;
  // The new page's list has B (stored, cancel not through yet) — no chip for it.
  expect(lists.at(-1)).toBe(1);
  await expect(chips(page)).toHaveCount(0);
  await expect(page.getByTestId("assistant").last()).toHaveAttribute("data-status", "complete");
  await page.getByLabel("메시지 입력").fill("다음");
  await expect(page.getByRole("button", { name: "보내기" })).toBeEnabled();
  await page.getByRole("button", { name: "보내기" }).click();
  const next = page.getByTestId("user-message").filter({ hasText: "다음" });
  await expect(next).toHaveCount(1);
  await expect(next.getByTestId("file-ref")).toHaveCount(0);
  cancelGo.open();
  bAnswer.open();
  // B is gone from the server: never attached, deleted by its upload id.
  const id = new URL(page.url()).pathname.split("/").pop()!;
  await expect
    .poll(async () => {
      const r = (await (await page.request.get(`/api/conversations/${id}/files`)).json()) as {
        items: { name: string }[];
      };
      return r.items.map((f) => f.name);
    })
    .toEqual(["A.txt"]);
  await expect(chips(page)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("a file removed while the new chat's conversation is being made is never uploaded", async ({ page }) => {
  await useAccount(page, SON);
  await page.goto("/");
  const createHeld = gate();
  const createSeen = gate();
  let uploads = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && isFiles(r.url())) uploads++;
  });
  await page.route(/\/api\/conversations$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    createSeen.open();
    await createHeld.p;
    await route.fulfill({ response: await route.fetch() });
  });
  await page
    .getByTestId("file-input")
    .setInputFiles([{ name: "취소.txt", mimeType: "text/plain", buffer: Buffer.from("x") }]);
  await createSeen.p;
  await chips(page).first().getByRole("button", { name: /빼기/ }).click();
  await expect(chips(page)).toHaveCount(0);
  createHeld.open();
  await page.getByLabel("메시지 입력").fill("파일 없이");
  await page.getByRole("button", { name: "보내기" }).click();
  await expect(page).toHaveURL(/\/c\//);
  await expect(page.getByTestId("user-message").filter({ hasText: "파일 없이" })).toHaveCount(1);
  await page.waitForTimeout(300);
  expect(uploads).toBe(0);
  await expect(chips(page)).toHaveCount(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
