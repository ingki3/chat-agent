import { expect, test } from "@playwright/test";
import { ADMIN, useAccount } from "./helpers.js";

/**
 * Cloudflare Access sync (#36, FR-15.4): the e2e server has no Cloudflare token, so the Access tab is in manual mode —
 * the list to enter in the dashboard, the steps, and "대시보드에 반영했어요". Adding a user previews the Access change
 * first. (Automatic mode runs against a mock of the Cloudflare API in apps/server/test/access-sync.test.ts.)
 */
test("manual mode: adding a user previews the Access change, and the Access tab lists the emails with the steps", async ({
  page,
}, info) => {
  await useAccount(page, ADMIN);
  await page.goto("/admin");
  const email = `access-${info.project.name}-${Date.now()}@example.com`;
  const users = page.getByRole("region", { name: "가족 계정" });
  await users.getByLabel("이름").last().fill("액세스");
  await users.getByLabel("새 가족 이메일").fill(email);
  await users.getByRole("button", { name: "계정 추가" }).click();
  const dialog = page.getByRole("dialog", { name: "Access 허용 목록 미리보기" });
  await expect(dialog.getByTestId("access-preview")).toContainText(`+ ${email}`);
  await expect(dialog).toContainText("수동 모드");
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(page.getByTestId("temp-password")).toContainText(email);
  await expect(page.getByTestId("access-result")).toContainText("대시보드에 반영했어요");

  await page.getByRole("tab", { name: "Access" }).click();
  await expect(page).toHaveURL(/tab=access/);
  const tab = page.getByRole("region", { name: "Cloudflare Access" });
  await expect(tab.getByTestId("access-registration")).toContainText("수동 모드");
  await expect(tab.getByTestId("access-app-emails")).toContainText(ADMIN.email);
  await expect(tab.getByTestId("access-app-emails")).toContainText(email);
  // Other tests add accounts meanwhile: a stale list is shown again, so confirm until it sticks.
  await expect(async () => {
    await tab.getByRole("button", { name: "비교하기" }).click();
    await expect(tab.getByTestId("access-manual-steps")).toContainText("Include → Emails");
    await expect(tab.getByTestId("access-manual-emails")).toContainText(email);
    await tab.getByRole("button", { name: "대시보드에 반영했어요" }).click();
    await expect(tab.getByTestId("access-sync-state")).toContainText("대시보드에 반영했다고 기록했어요", {
      timeout: 2_000,
    });
  }).toPass({ timeout: 20_000 });
});

test("manual mode: the admin email change shows its steps and can be cancelled", async ({ page }, info) => {
  // One server-wide change at a time: desktop only, so the two projects never race for it.
  test.skip(info.project.name !== "desktop", "one admin email change at a time");
  await useAccount(page, ADMIN);
  await page.goto("/admin?tab=access");
  const section = page.getByRole("region", { name: "관리자 이메일 변경" });
  await section.getByLabel("새 관리자 이메일").fill(`dad-${Date.now()}@example.com`);
  await section.getByRole("button", { name: "변경 요청" }).click();
  const steps = section.getByTestId("admin-email-change");
  await expect(steps).toContainText(ADMIN.email);
  await expect(steps).toContainText("새 이메일로 Access 로그인");
  await expect(steps).toContainText("전환 전까지는 이전 이메일로 그대로 로그인해요");
  await section.getByRole("button", { name: "변경 취소" }).click();
  await expect(section.getByLabel("새 관리자 이메일")).toBeVisible();
});
