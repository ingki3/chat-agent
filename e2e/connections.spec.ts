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
  // Members do not see the Claude subscription option (PRD D2).
  await expect(section.getByRole("option", { name: /구독/ })).toHaveCount(0);
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
});
