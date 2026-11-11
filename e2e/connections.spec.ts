import crypto from "node:crypto";
import { expect, test } from "@playwright/test";
import { ADMIN, SON, useAccount } from "./helpers.js";

/**
 * 설정 → 내 런타임 연결 (#17): add, test, disconnect. The e2e server runs the scripted FakeRuntime, which answers
 * the connection test's prompt (tool, skill, reply) like a working runtime.
 */
test("a member adds an API key, tests it and disconnects it; the key never comes back", async ({ page }) => {
  await useAccount(page, SON);
  await page.goto("/settings");
  const section = page.locator("#connections");
  await expect(section.getByRole("heading", { name: "내 런타임 연결" })).toBeVisible();
  // Members do not see the Claude subscription option (PRD D2) — but they can sign in with their own ChatGPT.
  await expect(section.getByRole("option", { name: /Claude Code · .*구독/ })).toHaveCount(0);
  await expect(section.getByRole("option", { name: "Codex · 내 ChatGPT 계정으로 로그인" })).toHaveCount(1);
  const last4 = String(crypto.randomInt(1000, 10000));
  const key = `sk-ant-e2e${crypto.randomBytes(12).toString("hex")}${last4}`;
  await section.getByLabel("API 키", { exact: true }).fill(key);
  await section.getByRole("button", { name: "연결 추가" }).click();
  await expect(section.getByRole("status")).toContainText("연결을 추가했어요");
  await expect(section.getByLabel("API 키", { exact: true })).toHaveValue("");
  const row = section.getByTestId("connection").filter({ hasText: `••••${last4}` });
  await expect(row.getByTestId("connection-status")).toHaveText("테스트 필요");
  await expect(page.locator("body")).not.toContainText(key);
  await row.getByRole("button", { name: "테스트" }).click();
  await expect(row.getByTestId("connection-status")).toHaveText("사용 가능");
  await expect(row.getByTestId("test-result")).toContainText("통과");
  page.once("dialog", (d) => void d.accept());
  await row.getByRole("button", { name: /연결 해제/ }).click();
  await expect(row).toHaveCount(0);
});

test("the admin sees the Claude subscription option with the one-person warning", async ({ page }) => {
  await useAccount(page, ADMIN);
  await page.goto("/settings");
  const section = page.locator("#connections");
  await section
    .getByLabel("연결 방식")
    .selectOption({ label: "Claude Code · 관리자 본인 구독 (claude setup-token)" });
  await expect(section.getByRole("note")).toContainText("본인 구독만 연결하세요");
  await expect(section.getByRole("note")).toContainText("claude setup-token");
});

test("a member's ChatGPT login: the device-code option with the one-person warning, no token field", async ({
  page,
}) => {
  await useAccount(page, SON);
  await page.goto("/settings");
  const section = page.locator("#connections");
  await section.getByLabel("연결 방식").selectOption({ label: "Codex · 내 ChatGPT 계정으로 로그인" });
  await expect(section.getByRole("note")).toContainText("본인 구독만 연결하세요");
  await expect(section.getByRole("note")).toContainText("코드");
  await expect(section.getByLabel("토큰", { exact: true })).toHaveCount(0);
  await expect(section.getByRole("button", { name: "ChatGPT로 로그인" })).toBeVisible();
});

test("a ChatGPT login the server no longer knows (restart: 404) stops waiting and asks to start again", async ({
  page,
}) => {
  await useAccount(page, SON);
  const login = {
    id: crypto.randomUUID(),
    runtime: "codex",
    status: "pending",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "AB1C-2D3E4",
    expiresAt: Date.now() + 15 * 60_000,
    connectionId: null,
    code: null,
  };
  let polls = 0;
  await page.route("**/api/connections/logins", (route) =>
    route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ login }) }),
  );
  await page.route(`**/api/connections/logins/${login.id}`, (route) => {
    polls++;
    return route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not_found"}' });
  });
  await page.goto("/settings");
  const section = page.locator("#connections");
  await section.getByLabel("연결 방식").selectOption({ label: "Codex · 내 ChatGPT 계정으로 로그인" });
  await section.getByRole("button", { name: "ChatGPT로 로그인" }).click();
  await expect(section.getByTestId("device-code")).toHaveText("AB1C-2D3E4");
  await expect(section.getByRole("status")).toContainText("더 이상 진행 중이 아니에요", { timeout: 8000 });
  await expect(section.getByTestId("device-login")).toHaveCount(0);
  const after = polls;
  await page.waitForTimeout(4500);
  expect(polls).toBe(after); // no more polling
});

test("a poll that hangs does not keep the login screen waiting past its expiry", async ({ page }) => {
  await useAccount(page, SON);
  const login = {
    id: crypto.randomUUID(),
    runtime: "codex",
    status: "pending",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "AB1C-2D3E4",
    // Already past its expiry and the grace: the page's own clock must end it although no poll ever answers.
    expiresAt: Date.now() - 60_000,
    connectionId: null,
    code: null,
  };
  await page.route("**/api/connections/logins", (route) =>
    route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ login }) }),
  );
  await page.route(`**/api/connections/logins/${login.id}`, () => {
    // never answered
  });
  await page.goto("/settings");
  const section = page.locator("#connections");
  await section.getByLabel("연결 방식").selectOption({ label: "Codex · 내 ChatGPT 계정으로 로그인" });
  await section.getByRole("button", { name: "ChatGPT로 로그인" }).click();
  await expect(section.getByRole("status")).toContainText("시간 안에 코드를 입력하지 않아", {
    timeout: 8000,
  });
  await expect(section.getByTestId("device-login")).toHaveCount(0);
});
