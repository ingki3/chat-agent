import { expect, test, type Page } from "@playwright/test";
import { ADMIN, SON, csrf, newConversation, newMember, signIn, useAccount } from "./helpers.js";

/**
 * Admin screen (#35): tabs for users, per-user permissions, runtimes, skills, system status and usage. The e2e
 * server runs the scripted FakeRuntime as "Claude Code" (models Fake Large, Fake Small and Opus 5.5), without connections.
 * Each test makes its own account, so the desktop and mobile runs never change each other's (or the shared
 * family accounts') permissions.
 */

const modelOptions = (page: Page) =>
  page.getByLabel("Claude Code 기본 모델").locator("option").allTextContents();

test("taking a model away from a youth account removes it from his selector, and the API refuses it", async ({
  page,
  browser,
  baseURL,
}) => {
  const son = await newMember(browser, baseURL!, "son", true);
  await signIn(page, baseURL!, son);
  // Before: Fake Small is in his settings selector.
  await page.goto("/settings");
  await expect.poll(() => modelOptions(page)).toContain("Fake Small");

  // The admin takes it away in 관리자 → 권한.
  const adminCtx = await browser.newContext({ baseURL: baseURL! });
  const admin = await adminCtx.newPage();
  await useAccount(admin, ADMIN);
  await admin.goto("/admin");
  await admin.getByRole("tab", { name: "권한" }).click();
  const perms = admin.getByRole("region", { name: "사용자별 권한" });
  await perms.getByLabel("가족 선택").selectOption({ label: `${son.name} (${son.email})` });
  const claude = perms.getByRole("group", { name: "Claude Code 권한" });
  await claude.getByLabel("모든 모델 (새 모델 포함)").uncheck();
  await claude.getByLabel("Fake Small").uncheck();
  await perms.getByRole("button", { name: "권한 저장" }).click();
  await expect(perms.getByRole("status")).toContainText("권한을 저장했어요");
  // His skills: a youth account's finance skills stay hidden.
  await expect(perms.getByRole("group", { name: `${son.name} 스킬` })).toContainText("청소년 기본 숨김");
  await adminCtx.close();

  // Gone from his selector…
  await page.reload();
  await expect.poll(() => modelOptions(page)).toEqual(["허용된 첫 모델", "Fake Large", "Opus 5.5"]);
  // …and refused by the API: starting a run with it, and saving it as a default.
  const c = await newConversation(page.request, baseURL!, `권한 ${Date.now()}`);
  const run = await page.request.post(`/api/conversations/${c.id}/messages`, {
    data: { text: "안녕", model: "fake-small" },
    headers: { ...csrf(baseURL!), "Idempotency-Key": `e2e-admin-${Date.now()}-${Math.random()}` },
  });
  expect(run.status()).toBe(403);
  expect(await run.json()).toEqual({ error: "model_not_allowed" });
  const def = await page.request.put("/api/settings/defaults", {
    data: {
      defaults: { runtime: "claude-code", models: { "claude-code": { model: "fake-small", effort: null } } },
    },
    headers: csrf(baseURL!),
  });
  expect(def.status()).toBe(403);
  // What is allowed saves from the screen.
  await page.getByLabel("Claude Code 기본 모델").selectOption({ label: "Fake Large" });
  await page.getByRole("button", { name: "기본값 저장" }).click();
  await expect(page.getByRole("region", { name: "기본 런타임·모델" }).getByRole("status")).toContainText(
    "기본값을 저장했어요",
  );
  await expect(page.getByTestId("defaults-source")).toContainText("내가 정한 값");
});

test("admin tabs: edit a user, runtimes with the on-behalf notice, skills allow-list, system status", async ({
  page,
  browser,
  baseURL,
}, info) => {
  const member = await newMember(browser, baseURL!, "edit");
  await useAccount(page, ADMIN);
  await page.goto("/admin");
  await expect(page.getByRole("tab", { name: "사용자", selected: true })).toBeVisible();

  // Users: rename.
  const row = page.getByTestId("user-row").filter({ hasText: member.email });
  await row.getByRole("button", { name: "수정" }).click();
  const form = row.getByRole("form", { name: `${member.name} 계정 수정` });
  await form.getByLabel("이름", { exact: true }).fill(`${member.name}바뀜`);
  await form.getByRole("button", { name: "저장" }).click();
  await expect(page.getByTestId("user-row").filter({ hasText: member.email })).toContainText(
    `${member.name}바뀜`,
  );

  // Runtimes: the model list and capabilities, shared connections, the on-behalf notice (FR-11.4).
  await page.getByRole("tab", { name: "런타임" }).click();
  await expect(page).toHaveURL(/tab=runtimes/);
  const runtimes = page.getByRole("region", { name: "런타임" });
  await expect(runtimes.getByRole("table", { name: "Claude Code 모델" })).toContainText("fake-small");
  await expect(runtimes.getByTestId("behalf-notice")).toContainText("본인 구독만 연결하세요");
  await expect(runtimes.getByTestId("behalf-notice")).toContainText("그 사람이 직접");

  // Skills: the server allow-list switch (a planned skill, so no other test notices; desktop only, so the two
  // projects never flip the same server-wide switch at once).
  await page.getByRole("tab", { name: "스킬" }).click();
  const skills = page.getByRole("region", { name: "스킬" });
  const summarize = skills.getByLabel("summarize 서버에서 허용");
  await expect(summarize).toBeChecked();
  if (info.project.name === "desktop") {
    await summarize.click();
    await expect(summarize).not.toBeChecked();
    await summarize.click();
    await expect(summarize).toBeChecked();
  }

  // System status: uptime, tunnel 미설정 (no CLOUDFLARED_METRICS in e2e), connections, errors, disk.
  await page.getByRole("tab", { name: "시스템 상태" }).click();
  const system = page.getByRole("region", { name: "시스템 상태" });
  await expect(system.getByTestId("system-uptime")).not.toBeEmpty();
  await expect(system.getByTestId("tunnel-state")).toHaveText("미설정");
  await expect(system.getByRole("table", { name: "런타임 연결 상태" })).toContainText("Claude Code");
  await expect(system.getByTestId("disk-free")).toContainText("남음");
  // The sandboxed workers (#122): no WORKER_RUN_USER in e2e — each says plainly it is not isolated by account.
  for (const kind of ["extract", "docgen", "render"])
    await expect(system.getByTestId(`worker-${kind}`)).toContainText("계정 격리 안 됨");
  await expect(system.getByTestId("worker-warning")).toContainText("41절");

  // A deep link opens its tab.
  await page.goto("/admin?tab=usage");
  await expect(page.getByRole("region", { name: "사용량", exact: true })).toBeVisible();
});

test("members (the son too) get 403 from every admin screen API and never see the screen", async ({
  page,
  baseURL,
}) => {
  await useAccount(page, SON);
  for (const url of [
    "/api/admin/system",
    "/api/admin/runtimes",
    "/api/admin/skills",
    "/api/admin/users",
    "/api/admin/backups",
  ])
    expect((await page.request.get(url)).status()).toBe(403);
  const me = (await (await page.request.get("/api/auth/state")).json()) as { user: { id: string } };
  for (const [method, url, data] of [
    ["PATCH", `/api/admin/users/${me.user.id}`, { role: "admin" }],
    ["PUT", `/api/admin/users/${me.user.id}/skills/kr-stock-skill`, { enabled: true }],
    ["PUT", "/api/admin/skills/kr-stock-skill", { enabled: false }],
    ["PUT", `/api/admin/users/${me.user.id}/defaults`, { defaults: null }],
    ["POST", "/api/admin/backups", {}],
  ] as const)
    expect((await page.request.fetch(url, { method, data, headers: csrf(baseURL!) })).status()).toBe(403);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/$/);
});

test("backup tab: schedule, 지금 백업 adds a backup to the list, restore is instructions only (#37)", async ({
  page,
}) => {
  await useAccount(page, ADMIN);
  await page.goto("/admin?tab=backup");
  const backup = page.getByRole("region", { name: "백업" });
  await expect(backup.getByTestId("backup-schedule")).toContainText("매일 03:30 (서울) 자동 백업 · 7일 보관");
  await expect(backup).toContainText("마스터 키는 백업에 들어가지 않아요");
  // Restore: steps with the CLI, no button that would restore from the screen.
  await expect(backup.getByTestId("restore-steps")).toContainText("pnpm -s restore check");
  await expect(backup.getByTestId("restore-steps")).toContainText("pnpm -s restore apply");
  await expect(backup.getByRole("button", { name: /복원/ })).toHaveCount(0);
  const table = backup.getByRole("table", { name: "최근 백업" });
  const before = (await table.isVisible()) ? await table.locator("tbody tr").count() : 0;
  // Desktop and mobile run at once: one of them may find the other's backup in progress — try again then.
  await expect(async () => {
    await backup.getByRole("button", { name: "지금 백업" }).click();
    await expect(backup.getByRole("status")).toContainText("백업했어요", { timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  await expect(table.locator("tbody tr")).not.toHaveCount(before);
  await expect(table).toContainText("(현재)");
});
