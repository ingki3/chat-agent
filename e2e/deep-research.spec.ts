import { expect, test, type Page } from "@playwright/test";
import { csrf, newConversation, newMember, signIn } from "./helpers.js";

/**
 * 깊이 조사 (#211, PRD FR-17): the plan card (승인 / 고치기 / 취소) before any search, the live progress after
 * approval (each sub-question, sources found, time against the 30-minute cap, 중지), and the verified report as an
 * artifact card in the same message. The FakeRuntime answers each step (`fake-research.ts`) with real calls of our web
 * and citation tools on the fixture pages — the checks and the screen are the real ones. Each test has an account of
 * its own (one job at a time per account; desktop and mobile run in parallel).
 */

async function openResearch(page: Page, baseURL: string, label: string, text: string) {
  const who = await newMember(page.context().browser()!, baseURL, label);
  await signIn(page, baseURL, who);
  const conv = await newConversation(page.request, baseURL, "깊이 조사");
  await page.goto(`/c/${conv.id}`);
  await page.getByLabel("메시지 입력").fill(text);
  await page.getByTestId("research-start").click();
  const card = page.getByTestId("research-card");
  await expect(card).toHaveAttribute("data-status", "awaiting_approval", { timeout: 15_000 });
  return card;
}

test("plan card: edit and approve, live progress, then the verified report", async ({ page, baseURL }) => {
  const card = await openResearch(page, baseURL!, "research", "느린 조사: 10월 반도체 수출을 깊이 조사해 줘");
  // The question is the user's message; the card shows the plan — nothing searched yet.
  await expect(page.getByTestId("thread")).toContainText("느린 조사: 10월 반도체 수출을 깊이 조사해 줘");
  await expect(card.getByTestId("research-plan-title")).toHaveText("10월 반도체 수출 조사");
  await expect(card.getByTestId("research-plan-item")).toHaveCount(2);
  await expect(card).toContainText("승인하면 웹 검색을 시작해요");

  // 고치기: the first sub-question reworded, then approved with the edit.
  await card.getByTestId("research-edit").click();
  await card.getByRole("textbox", { name: "하위 질문 1" }).fill("2026년 10월 반도체 수출 증가율은 얼마인가");
  await card.getByTestId("research-approve").click();

  // Live progress: the stage, the time against the cap, each sub-question, and 중지.
  await expect(card).toHaveAttribute("data-status", /researching|writing/);
  await expect(card.getByTestId("research-stage")).toContainText("/ 30분");
  await expect(card.getByTestId("research-question")).toHaveCount(2);
  await expect(card.getByTestId("research-question").first()).toContainText("2026년 10월 반도체 수출 증가율");
  await expect(
    card.locator('[data-testid="research-question"][data-status="running"]').first(),
  ).toBeVisible();
  await expect(card.getByTestId("research-stop")).toBeVisible();
  // What it is doing now (#232): the phase, a running sub-question's latest call, the time since the last activity.
  await expect(card.getByTestId("research-phase")).toHaveText(/조사|보강|보고서|출처/);
  await expect(card.getByTestId("research-activity").first()).toHaveText("페이지 읽는 중 · 1번째 페이지");
  await expect(card.getByTestId("research-last-activity")).toContainText("마지막 활동");

  // Done: what did not verify was removed and counted; the report is an artifact card in the same message.
  await expect(card).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  await expect(card.getByTestId("research-result")).toContainText("확인하지 못해 뺀 문장 2개");
  // Each sub-question's notes, and the one its check could not verify.
  await expect(card.getByTestId("research-counts").first()).toContainText("노트 2개 · 확인 못 함 1개");
  const reply = page.getByTestId("assistant").last();
  await expect(reply.getByTestId("artifact-card")).toBeVisible();
  await expect(reply).toContainText("깊이 조사 보고서");
  // Three passages of two pages: two sources (#233) — the completion message's own wording (the card says "·").
  await expect(reply).toContainText("하위 질문 2개, 보고서에 인용한 출처 2개");
  await expect(card.getByTestId("research-stop")).toHaveCount(0);
});

test("plan card: cancel, and 중지 while it runs", async ({ page, baseURL }) => {
  const card = await openResearch(page, baseURL!, "research-stop", "느린 조사: 반도체 수출 증가율");
  await card.getByTestId("research-cancel").click();
  await expect(card).toHaveAttribute("data-status", "cancelled");
  await expect(card.getByTestId("research-ended")).toHaveText("취소했어요");

  // A second job in the same conversation: approved, then stopped.
  await page.getByLabel("메시지 입력").fill("느린 조사: 반도체 수출 증가율 다시");
  await page.getByTestId("research-start").click();
  const second = page.getByTestId("research-card").last();
  await expect(second).toHaveAttribute("data-status", "awaiting_approval", { timeout: 15_000 });
  await second.getByTestId("research-approve").click();
  await expect(second.getByTestId("research-stop")).toBeVisible();
  await second.getByTestId("research-stop").click();
  await expect(second).toHaveAttribute("data-status", "stopped");
  await expect(second.getByTestId("research-ended")).toHaveText("중지했어요");
});

test("a new chat can start with 깊이 조사: the conversation is made, the plan card waits", async ({
  page,
  baseURL,
}) => {
  const who = await newMember(page.context().browser()!, baseURL!, "research-new");
  await signIn(page, baseURL!, who);
  await page.goto("/");
  await page.getByLabel("메시지 입력").fill("10월 반도체 수출을 깊이 조사해 줘");
  await page.getByTestId("research-start").click();
  await page.waitForURL(/\/c\/[^/]+$/);
  const card = page.getByTestId("research-card");
  await expect(card).toHaveAttribute("data-status", "awaiting_approval", { timeout: 15_000 });
  await expect(card.getByTestId("research-plan-item")).toHaveCount(2);
  await card.getByTestId("research-cancel").click();
  await expect(card).toHaveAttribute("data-status", "cancelled");
});

test("Codex conversations: the button says why it cannot be used", async ({ page, baseURL }) => {
  const who = await newMember(page.context().browser()!, baseURL!, "research-codex");
  await signIn(page, baseURL!, who);
  const r = await page.request.post("/api/conversations", {
    data: { title: "코덱스", settings: { runtime: "codex" } },
    headers: csrf(baseURL!),
  });
  expect(r.status()).toBe(201);
  const conv = (await r.json()) as { id: string };
  await page.goto(`/c/${conv.id}`);
  await page.getByLabel("메시지 입력").fill("조사해 줘");
  const button = page.getByTestId("research-start");
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute("title", "깊이 조사는 Claude 대화에서만 쓸 수 있어요");
});
