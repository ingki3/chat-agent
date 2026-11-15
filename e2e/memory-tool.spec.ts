import { expect, test, type Page } from "@playwright/test";
import { csrf, newMember, signIn } from "./helpers.js";

/**
 * 대화 중 기억해줘·잊어줘 (#145, PRD FR-16.4·16.7): "기억해줘: …" → the card under the reply → 반영 (MEMORY.md has it) or
 * 거절 (it never does); a manual edit before 반영 expires the card ("다시 요청해 주세요"); 자동 반영 (설정 → 내 지침)
 * applies at once and 되돌리기 takes it back. Desktop and mobile; each test has its own account.
 */

/** Sends `text` and waits for its own reply (not the previous one) and its card. */
async function ask(page: Page, text: string) {
  const replies = page.getByTestId("assistant");
  const cards = page.getByTestId("memory-card");
  const n = await replies.count();
  const k = await cards.count();
  const box = page.getByRole("textbox", { name: /메시지/ });
  await box.fill(text);
  await box.press("Enter");
  await expect(replies).toHaveCount(n + 1);
  await expect(replies.nth(n)).toHaveAttribute("data-status", "complete");
  await expect(cards).toHaveCount(k + 1);
  return cards.nth(k);
}

async function memoryItems(page: Page): Promise<string[]> {
  const r = await page.request.get("/api/instructions");
  const docs = ((await r.json()) as { docs: { kind: string; items: { text: string }[] | null }[] }).docs;
  return (docs.find((d) => d.kind === "memory")!.items ?? []).map((i) => i.text);
}

test("기억해줘 → 카드 → 반영 / 거절, 그리고 수동 편집 뒤 만료", async ({ page, browser, baseURL }) => {
  const me = await newMember(browser, baseURL!, "memcard");
  await signIn(page, baseURL!, me);
  await page.goto("/");

  // 반영: the card shows the change as a diff; nothing is saved before the click.
  const card = await ask(page, "기억해줘: 아침엔 블랙커피를 마신다");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("memory-decision")).toContainText("MEMORY.md · 추가");
  await expect(card.getByTestId("memory-decision")).toContainText("아침엔 블랙커피를 마신다");
  expect(await memoryItems(page)).toEqual([]);
  await card.getByRole("button", { name: "반영", exact: true }).click();
  await expect(card.getByTestId("memory-decision")).toHaveAttribute("data-status", "accepted");
  await expect(card.getByText("반영됨", { exact: true })).toBeVisible();
  await expect(card.getByTestId("memory-card-status")).toHaveText("반영했어요.");
  expect(await memoryItems(page)).toEqual(["아침엔 블랙커피를 마신다"]);

  // 거절: never applied.
  const rej = await ask(page, "기억해줘: 거절할 기억");
  await rej.getByRole("button", { name: "거절", exact: true }).click();
  await expect(rej.getByText("거절됨", { exact: true })).toBeVisible();
  await expect(rej.getByRole("button", { name: "반영", exact: true })).toHaveCount(0);
  expect(await memoryItems(page)).toEqual(["아침엔 블랙커피를 마신다"]);

  // 만료: the document changes (a manual edit) before 반영.
  const exp = await ask(page, "기억해줘: 만료될 기억");
  const put = await page.request.put("/api/instructions/memory", {
    data: { content: "- 아침엔 블랙커피를 마신다\n- 직접 적은 줄" },
    headers: csrf(baseURL!),
  });
  expect(put.status()).toBe(200);
  await exp.getByRole("button", { name: "반영", exact: true }).click();
  await expect(exp.getByTestId("memory-card-summary")).toHaveText(
    "문서가 바뀌어 반영하지 않았어요. 다시 요청해 주세요.",
  );
  await expect(exp.getByText("만료됨", { exact: true })).toBeVisible();
  expect(await memoryItems(page)).toEqual(["아침엔 블랙커피를 마신다", "직접 적은 줄"]);
});

test("자동 반영 + 되돌리기 (설정 → 내 지침 → 기억 반영 방식)", async ({ page, browser, baseURL }) => {
  const me = await newMember(browser, baseURL!, "memauto");
  await signIn(page, baseURL!, me);
  await page.goto("/settings/instructions");
  const setting = page.getByTestId("memory-mode");
  await expect(setting.getByRole("radio", { name: /검토 후 반영/ })).toBeChecked();
  await setting.getByRole("radio", { name: /자동 반영/ }).check();
  await expect(setting.getByRole("radio", { name: /자동 반영/ })).toBeChecked();
  await page.reload();
  await expect(page.getByTestId("memory-mode").getByRole("radio", { name: /자동 반영/ })).toBeChecked();

  await page.goto("/");
  const card = await ask(page, "기억해줘: 피아노를 배운다");
  await expect(card.getByText("기억했어요", { exact: true }).first()).toBeVisible();
  await expect(card.getByTestId("memory-decision")).toHaveAttribute("data-status", "applied");
  expect(await memoryItems(page)).toEqual(["피아노를 배운다"]);
  await card.getByRole("button", { name: "되돌리기" }).click();
  await expect(card.getByTestId("memory-decision")).toHaveAttribute("data-status", "undone");
  await expect(card.getByTestId("memory-card-status")).toHaveText("되돌렸어요.");
  await expect(card.getByRole("button", { name: "되돌리기" })).toHaveCount(0);
  expect(await memoryItems(page)).toEqual([]);

  // A sensitive category still asks, even in 자동 반영.
  const sens = await ask(page, "기억해줘: 고혈압 약을 매일 복용한다");
  await expect(sens.getByTestId("memory-card-summary")).toContainText("민감한 내용");
  await expect(sens.getByRole("button", { name: "반영", exact: true })).toBeVisible();
  expect(await memoryItems(page)).toEqual([]);
});

test("출처 대화를 지우면 열린 카드도 글과 버튼을 감춘다 (spec §10.3)", async ({ page, browser, baseURL }) => {
  const me = await newMember(browser, baseURL!, "memgone");
  await signIn(page, baseURL!, me);
  await page.goto("/");
  const first = await ask(page, "기억해줘: 지워질 대화의 사실");
  await first.getByRole("button", { name: "반영", exact: true }).click();
  await expect(first.getByTestId("memory-decision")).toHaveAttribute("data-status", "accepted");
  const sourceConversation = new URL(page.url()).pathname.split("/").at(-1)!;
  // Another conversation: a card that would change that item (its old line came from the first conversation).
  await page.goto("/");
  const card = await ask(page, "기억 1번 고쳐줘: 고친 사실");
  await expect(card.getByTestId("memory-decision")).toContainText("지워질 대화의 사실");
  const del = await page.request.delete(`/api/conversations/${sourceConversation}`, {
    headers: csrf(baseURL!),
  });
  expect(del.status()).toBe(200);
  await card.getByRole("button", { name: "반영", exact: true }).click();
  await expect(card).toHaveAttribute("data-gone", "true");
  await expect(card).toHaveText("출처 메시지가 지워져 이 기억 제안도 지웠어요.");
  await expect(card.getByRole("button")).toHaveCount(0);
  expect(await memoryItems(page)).toEqual([]);
});
