import { expect, test, type Page } from "@playwright/test";
import { SON, newConversation, sendMessage, useAccount } from "./helpers.js";

/**
 * The document never scrolls under the app shell (#247): the whole app (sidebar and main column) once showed shifted
 * up by hundreds of pixels after a send — the document had become scrollable and something scrolled it. The shell
 * marks the page (`html.app-shell`) and body clips anything that would make it taller than the window, so only the
 * app's own scrollers move. Checked by trying to scroll the document directly at each step (a focus, a
 * scrollIntoView or the caret can do no more than that), and with a stray element appended after the app — what an
 * extension or a leftover does — which made the document scrollable before.
 */

/** Tries to scroll the document and checks it did not move: nothing to scroll, the app at the top of the window. */
async function expectDocumentFixed(page: Page, when: string) {
  const s = await page.evaluate(() => {
    const se = document.scrollingElement!;
    window.scrollTo(0, 10_000);
    se.scrollTop = 10_000;
    document.querySelector("[data-testid=stray]")?.scrollIntoView();
    const r = {
      shell: document.documentElement.classList.contains("app-shell"),
      scrollTop: se.scrollTop,
      scrollY: window.scrollY,
      overflow: se.scrollHeight - se.clientHeight,
      appTop: Math.round(document.querySelector(".app")!.getBoundingClientRect().top),
    };
    window.scrollTo(0, 0);
    return r;
  });
  expect(s, when).toEqual({ shell: true, scrollTop: 0, scrollY: 0, overflow: 0, appTop: 0 });
}

/** A tall block after the app, as an extension or a leftover element would add (it made the document scroll). */
const addStray = (page: Page) =>
  page.evaluate(() => {
    const d = document.createElement("div");
    d.dataset.testid = "stray";
    d.style.height = "800px";
    document.body.append(d);
  });

const VIEWPORTS = [
  { name: "default", size: null },
  // A desktop window narrowed by a browser side panel (the sidebar still shown), and short.
  { name: "narrow", size: { width: 960, height: 540 } },
] as const;

for (const vp of VIEWPORTS)
  for (const stray of [false, true])
    test(`chat (${vp.name}${stray ? ", stray element" : ""}): send → waiting → done → citation jump keep the document still`, async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile && vp.size !== null, "the phone keeps its own viewport");
      if (vp.size) await page.setViewportSize(vp.size);
      await useAccount(page, SON);
      await page.goto("/");
      const box = page.getByLabel("메시지 입력");
      await expect(box).toBeVisible();
      if (stray) await addStray(page);
      await expectDocumentFixed(page, "new chat");

      await box.fill("/long 30");
      await box.press("Enter");
      await page.waitForURL(/\/c\/[^/]+$/);
      const reply = page.getByTestId("assistant").last();
      await expect(reply).toHaveAttribute("data-status", "streaming");
      await expectDocumentFixed(page, "waiting for the reply");
      await expect(reply).toHaveAttribute("data-status", "complete", { timeout: 20_000 });
      await expectDocumentFixed(page, "reply complete");

      // Back in the composer (the caret, typing), then a reply whose uncited paragraphs are jumped to
      // (scrollIntoView, #202).
      await sendMessage(page, "/cite partial");
      await expect(page.getByTestId("assistant")).toHaveCount(2);
      const cited = page.getByTestId("assistant").last();
      await expect(cited).toHaveAttribute("data-status", "complete", { timeout: 20_000 });
      await expectDocumentFixed(page, "cited reply complete");
      const jump = cited.getByTestId("citation-missing-warning");
      await expect(jump).toHaveJSProperty("tagName", "BUTTON");
      const marks = cited.getByTestId("citation-missing");
      for (let i = 0; i < 2; i++) {
        if (isMobile) await jump.tap();
        else await jump.click();
        await expect(marks.nth(i)).toBeFocused();
        await expect(marks.nth(i)).toBeInViewport();
        await expectDocumentFixed(page, `citation jump ${i + 1}`);
      }
      await box.focus();
      await box.pressSequentially("가나다");
      await expectDocumentFixed(page, "typing in the composer");
    });

test("a screen with segmented choices in a short window: the document stays still, the page scrolls itself", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "one window size is enough");
  // Their visually hidden radios hung off .app, outside every scroller, and made the document taller (#247).
  await page.setViewportSize({ width: 1280, height: 380 });
  await useAccount(page, SON);
  await page.goto("/settings/instructions");
  const radios = page.locator(".segmented input");
  await expect(radios.first()).toBeAttached();
  await expectDocumentFixed(page, "instructions");
  await radios.last().focus();
  await expectDocumentFixed(page, "a radio focused");
  // The page itself still scrolls to its end.
  const scrolled = await page
    .locator(".page")
    .evaluate((el) => ((el.scrollTop = el.scrollHeight), el.scrollTop));
  expect(scrolled).toBeGreaterThan(0);
});

test("the artifact page in a short window: the frame below is reached by scrolling the main column", async ({
  page,
  baseURL,
  isMobile,
}) => {
  test.skip(isMobile, "one window size is enough");
  await page.setViewportSize({ width: 1280, height: 400 });
  await useAccount(page, SON);
  const c = await newConversation(page.request, baseURL!, `짧은 창 ${Date.now()}`);
  await page.goto(`/c/${c.id}`);
  await sendMessage(page, `/artifact html 짧은 창 ${Date.now()}\n<h1>짧은 창</h1>`);
  await expect(page).toHaveURL(/\/a\/[^/?]+$/);
  const frame = page.getByTestId("artifact-page").getByTestId("artifact-frame");
  await expect(frame).toBeVisible();
  await expectDocumentFixed(page, "artifact page");
  // The frame (420px at least) is taller than what is left of the window: the main column scrolls, not the document.
  const bottom = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>(".main")!;
    main.scrollTop = main.scrollHeight;
    return Math.round(document.querySelector("[data-testid=artifact-frame]")!.getBoundingClientRect().bottom);
  });
  expect(bottom).toBeLessThanOrEqual(400);
  await expectDocumentFixed(page, "main column scrolled");
});

test("the sign-in screen is an ordinary page: it still scrolls in a tiny window", async ({
  browser,
  baseURL,
  isMobile,
}) => {
  test.skip(isMobile, "one window size is enough");
  const ctx = await browser.newContext({ baseURL: baseURL!, viewport: { width: 360, height: 240 } });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.getByRole("button", { name: /로그인/ })).toBeAttached();
  const s = await page.evaluate(() => {
    window.scrollTo(0, 10_000);
    return {
      shell: document.documentElement.classList.contains("app-shell"),
      scrollY: window.scrollY,
    };
  });
  expect(s.shell).toBe(false);
  expect(s.scrollY).toBeGreaterThan(0);
  await ctx.close();
});
