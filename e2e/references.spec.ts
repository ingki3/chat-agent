import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { readDocx } from "../apps/server/test/helpers/doc-parse.js";
import { MOM, newMember, signIn, useAccount } from "./helpers.js";

/**
 * 참고문헌 내보내기 (#26, PRD FR-5.6): the son asks two research questions (the FakeRuntime `/cite` scenarios make
 * real `web_fetch` / `cite` calls on the citation fixture pages), opens 📚 참고문헌, and takes the cited sources as a
 * reference list — APA 7 by default, MLA 9 and the school format on choice; failed sources listed with ⚠️ and left
 * out until "검증 실패 출처 포함"; copy, `.txt` and `.docx` (the #49 worker — macOS sandbox only, as docgen.spec.ts).
 * Another family member cannot export it. Desktop and mobile projects.
 */

async function ask(page: Page, text: string) {
  const before = await page.getByTestId("citation-note").count();
  await page.getByLabel("메시지 입력").fill(text);
  await page.getByRole("button", { name: "보내기" }).click();
  await expect(page.getByTestId("citation-note")).toHaveCount(before + 1, { timeout: 15_000 });
}

test("the son exports the conversation's sources: styles, the failed-source toggle, copy, .txt and .docx", async ({
  page,
  browser,
  baseURL,
  isMobile,
  browserName,
}) => {
  // A youth account of its own per project (desktop and mobile run at once): one `.docx` at a time per user is the
  // product rule, so the two runs never share an account.
  const son = await newMember(browser, baseURL!, "refs-son", true);
  await signIn(page, baseURL!, son);
  await page.goto("/");
  await ask(page, "/cite conflict");
  await page.waitForURL(/\/c\/[^/]+$/);
  const id = page.url().split("/c/")[1]!;
  await ask(page, "/cite insufficient");

  await page.getByTestId("references-open").click();
  const dialog = page.getByRole("dialog", { name: "참고문헌 내보내기" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /APA 7/ })).toBeChecked();
  const toggle = dialog.getByRole("checkbox", { name: /검증 실패 출처 포함/ });
  await expect(toggle).not.toBeChecked();

  // A (once), B (cited twice) and the blog C (one verified citation, one not): three sources, all verified. The
  // search result whose citation failed is shown, marked, and left out.
  const entries = dialog.getByTestId("references-entry");
  await expect(entries).toHaveCount(3);
  await expect(entries.first()).toContainText("10월 반도체 수출 32% 증가. (2026, November 10). 가나다 신문.");
  const excluded = dialog.getByTestId("references-excluded-entry");
  await expect(excluded).toHaveCount(1);
  await expect(excluded).toContainText("⚠️ 출처를 가져오지 못했어요");
  await expect(excluded).toContainText("전고체 배터리 양산 계획 발표");

  // Copy: the included entries only.
  const api = await page.request.get(`/api/conversations/${id}/references`);
  const listed = (await api.json()) as { text: string };
  expect(listed.text.split("\n")).toHaveLength(3);
  expect(listed.text).not.toContain("전고체 배터리 양산 계획 발표");
  if (!isMobile && browserName === "chromium")
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await dialog.getByTestId("references-copy").click();
  await expect(dialog.getByTestId("references-status")).toHaveText("3개 항목을 복사했어요.");
  if (!isMobile && browserName === "chromium")
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(listed.text);

  // The toggle puts the failed source in (marked ⚠️).
  await toggle.check();
  await expect(entries).toHaveCount(4);
  await expect(dialog.getByTestId("references-excluded-entry")).toHaveCount(0);
  await expect(dialog.locator('[data-testid="references-entry"][data-verified="false"]')).toHaveCount(1);

  // MLA 9, then the school format (numbered, 저자·제목·사이트·날짜·URL·접속일).
  // Changing the style while the new list is slow: copy and the downloads wait for the list of the new choice.
  let releaseMla: () => void = () => {};
  const mlaHeld = new Promise<void>((res) => (releaseMla = res));
  await page.route(/\/references\?style=mla/, async (route) => {
    await mlaHeld;
    await route.continue();
  });
  await dialog.getByText("MLA 9").click();
  for (const id of ["references-copy", "references-txt", "references-docx"])
    await expect(dialog.getByTestId(id)).toBeDisabled();
  // The previous (APA) list is still on screen, not copyable.
  await expect(entries.first()).toContainText("(2026, November 10)");
  releaseMla();
  await expect(dialog.getByTestId("references-copy")).toBeEnabled();
  await page.unroute(/\/references\?style=mla/);
  await expect(entries.first()).toContainText('"10월 반도체 수출 32% 증가." 가나다 신문, 10 Nov. 2026');
  await expect(entries.first()).toContainText("Accessed");
  await dialog.getByText("학교용 간단 형식").click();
  await expect(entries.first()).toContainText(
    "1. 저자 미상, 「10월 반도체 수출 32% 증가」, 가나다 신문, 2026. 11. 10.",
  );
  await expect(entries.first()).toContainText("(접속일: ");

  // .txt: what is listed, as a file.
  const school = (await (
    await page.request.get(`/api/conversations/${id}/references?style=school&includeUnverified=1`)
  ).json()) as { text: string };
  const [txt] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByTestId("references-txt").click(),
  ]);
  // The server's fixed name — never the conversation title (review #115 round 6).
  expect(txt.suggestedFilename()).toMatch(/^참고문헌-학교용-\d{4}-\d{2}-\d{2}\.txt$/);
  expect(fs.readFileSync((await txt.path())!, "utf8")).toBe(`${school.text}\n`);

  // .docx: the same entries, made by the sandboxed document worker (macOS only, like docgen.spec.ts).
  if (process.platform === "darwin") {
    const [docx] = await Promise.all([
      page.waitForEvent("download"),
      dialog.getByTestId("references-docx").click(),
    ]);
    expect(docx.suggestedFilename()).toMatch(/^참고문헌-학교용-\d{4}-\d{2}-\d{2}\.docx$/);
    const d = await readDocx(fs.readFileSync((await docx.path())!));
    expect(d.paragraphs[0]).toBe("참고문헌");
    expect(d.paragraphs.filter((p) => /^\d+\. /.test(p))).toEqual(school.text.split("\n"));
    await expect(dialog.getByTestId("references-status")).toContainText("내려받았어요");
  }

  // Esc closes the dialog and gives the focus back to the button.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("references-open")).toBeFocused();

  // Another family member: refused, nothing of the list.
  const ctx = await browser.newContext({ baseURL: baseURL! });
  const mom = await ctx.newPage();
  await useAccount(mom, MOM);
  for (const url of [`/api/conversations/${id}/references`, `/api/conversations/${id}/references/download`]) {
    const r = await mom.request.get(url);
    expect(r.status()).toBe(403);
    expect(await r.text()).not.toContain("반도체");
  }
  await ctx.close();
});
