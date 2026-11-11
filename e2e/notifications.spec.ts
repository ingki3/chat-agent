import { devices, expect, test, type Browser, type Page } from "@playwright/test";
import { ADMIN, MOM, SON, csrf, useAccount } from "./helpers.js";

/**
 * Notifications (#34). A real push service cannot be reached from the test browser, so the browser's push
 * subscription is stubbed (a fake push-service endpoint); everything else — permission handling, the device
 * registration on the server, the inbox and the badge — is the real thing.
 */

/** Stubs the Notification permission and PushManager; `answer` is what the permission prompt returns. */
async function stubPush(page: Page, answer: "granted" | "denied") {
  await page.addInitScript((answer) => {
    const w = window as unknown as { __asks: number };
    w.__asks = 0;
    let permission: NotificationPermission = "default";
    Object.defineProperty(Notification, "permission", { get: () => permission, configurable: true });
    Notification.requestPermission = async () => {
      w.__asks++;
      permission = answer;
      return permission;
    };
    let sub: PushSubscription | null = null;
    PushManager.prototype.subscribe = async function (o?: PushSubscriptionOptionsInit) {
      const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-${Math.random().toString(36).slice(2)}`;
      const key = o?.applicationServerKey as Uint8Array;
      sub = {
        endpoint,
        options: { applicationServerKey: key.buffer, userVisibleOnly: true },
        toJSON: () => ({
          endpoint,
          expirationTime: null,
          keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
        }),
        unsubscribe: async () => {
          sub = null;
          return true;
        },
      } as unknown as PushSubscription;
      return sub;
    };
    PushManager.prototype.getSubscription = async () => sub;
  }, answer);
}

/** A separate browser (no saved session) that looks like this project's device. */
function freshContext(browser: Browser, baseURL: string, project: string) {
  const d = devices[project === "mobile" ? "Pixel 7" : "Desktop Chrome"];
  return browser.newContext({
    baseURL,
    userAgent: d.userAgent,
    viewport: d.viewport,
    deviceScaleFactor: d.deviceScaleFactor,
    isMobile: d.isMobile,
    hasTouch: d.hasTouch,
  });
}

async function login(page: Page, who: { email: string; password: string }) {
  await page.getByLabel("이메일", { exact: true }).fill(who.email);
  await page.getByLabel("비밀번호", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
}

const asks = (page: Page) => page.evaluate(() => (window as unknown as { __asks: number }).__asks);

async function openSidebar(page: Page, mobile: boolean) {
  if (mobile) await page.getByRole("button", { name: "메뉴 열기" }).click();
}

test("inbox: badge, list, open → its address, read state", async ({ page, baseURL }, info) => {
  const mobile = info.project.name === "mobile";
  // One account per project: the two projects run at the same time.
  const who = mobile ? SON : MOM;
  await useAccount(page, who);
  await page.request.post("/api/notifications/read-all", { headers: csrf(baseURL!) });
  for (let i = 0; i < 2; i++)
    expect((await page.request.post("/api/notifications/test", { headers: csrf(baseURL!) })).status()).toBe(
      201,
    );

  await page.goto("/");
  await openSidebar(page, mobile);
  await expect(page.getByTestId("unread-badge")).toHaveText("2");
  await page.getByRole("link", { name: "알림함, 안 읽은 알림 2개" }).click();
  await expect(page).toHaveURL(/\/notifications$/);
  const items = page.getByTestId("notification");
  await expect(items.first()).toContainText("테스트 알림");
  await expect(items.first()).toContainText("안 읽음");
  await items.first().click();
  await expect(page).toHaveURL(/\/settings$/);

  await page.goto("/notifications");
  await expect(page.getByTestId("notification").filter({ hasText: "안 읽음" })).toHaveCount(1);
  await page.getByRole("button", { name: "모두 읽음" }).click();
  await expect(page.getByTestId("notification").filter({ hasText: "안 읽음" })).toHaveCount(0);
  await openSidebar(page, mobile);
  await expect(page.getByTestId("unread-badge")).toHaveCount(0);
});

test("the permission prompt opens only from the button; a refusal shows the blocked state", async ({
  page,
}) => {
  await stubPush(page, "denied");
  await useAccount(page, ADMIN);
  await page.goto("/settings");
  await expect(page.getByTestId("device-state")).toHaveText("꺼짐");
  expect(await asks(page)).toBe(0);
  await page.getByRole("button", { name: "이 기기에서 알림 켜기" }).click();
  await expect(page.getByTestId("device-state")).toHaveText("브라우저가 차단");
  await expect(page.getByRole("note")).toContainText("차단");
  expect(await asks(page)).toBe(1);
});

test("turning on registers this device for the session; logging out removes it", async ({
  browser,
  baseURL,
}, info) => {
  const ctx = await freshContext(browser, baseURL!, info.project.name);
  const page = await ctx.newPage();
  await stubPush(page, "granted");
  // A fresh login (its own session), so logging out does not end the saved sessions other tests use.
  await page.goto("/settings");
  await login(page, ADMIN);
  await expect(page.getByTestId("device-state")).toHaveText("꺼짐");

  await page.getByRole("button", { name: "이 기기에서 알림 켜기" }).click();
  await expect(page.getByTestId("device-state")).toHaveText("켜짐");
  await expect(page.getByTestId("this-device")).toContainText(
    info.project.name === "mobile" ? "Android" : "Chrome",
  );
  const devices = await page.request.get("/api/push/devices");
  expect(
    ((await devices.json()) as { devices: { current: boolean }[] }).devices.filter((d) => d.current),
  ).toHaveLength(1);

  await page.getByTestId("this-device").getByRole("button", { name: "끄기", exact: true }).click();
  await expect(page.getByTestId("device-state")).toHaveText("꺼짐");
  await page.getByRole("button", { name: "이 기기에서 알림 켜기" }).click();
  await expect(page.getByTestId("device-state")).toHaveText("켜짐");

  if (info.project.name === "mobile") await page.getByRole("button", { name: "메뉴 열기" }).click();
  await page.getByRole("button", { name: "로그아웃" }).click();
  await login(page, ADMIN);
  // The device belonged to the ended session: this login starts without it.
  await expect(page.getByTestId("device-state")).toHaveText("꺼짐");
  const after = await page.request.get("/api/push/devices");
  expect(
    ((await after.json()) as { devices: { current: boolean }[] }).devices.filter((d) => d.current),
  ).toHaveLength(0);
  await ctx.close();
});

test("quiet hours are saved", async ({ page }) => {
  await useAccount(page, ADMIN);
  await page.goto("/settings");
  await page.getByLabel("사용", { exact: true }).check();
  await page.getByLabel("방해 금지 시작").fill("22:30");
  await page.getByLabel("방해 금지 끝").fill("06:45");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText("저장했어요.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("방해 금지 시작")).toHaveValue("22:30");
  await expect(page.getByLabel("방해 금지 끝")).toHaveValue("06:45");
  await expect(page.getByLabel("사용", { exact: true })).toBeChecked();
});

test("a tapped notification opens its in-app address only; an expired session lands there after login", async ({
  browser,
  page,
  baseURL,
}, info) => {
  await useAccount(page, MOM);
  await page.goto("/");
  await expect(page.locator(".topbar")).toBeVisible();
  // What the service worker posts to an open window when a notification is tapped.
  const tap = (url: string) =>
    page.evaluate(
      (url) =>
        navigator.serviceWorker.dispatchEvent(
          new MessageEvent("message", { data: { type: "agentlee:open", url } }),
        ),
      url,
    );
  await tap("/settings");
  await expect(page).toHaveURL(/\/settings$/);
  await tap("https://evil.example/phish");
  await expect(page).toHaveURL(new RegExp(`^${baseURL}/$`));

  // No session (expired or logged out): the address opened from the notification shows the login screen, and
  // signing in shows that same page.
  const ctx = await freshContext(browser, baseURL!, info.project.name);
  const fresh = await ctx.newPage();
  await fresh.goto("/notifications");
  await login(fresh, MOM);
  await expect(fresh).toHaveURL(/\/notifications$/);
  await expect(fresh.locator(".topbar .title")).toHaveText("🔔 알림함");
  await ctx.close();
});
