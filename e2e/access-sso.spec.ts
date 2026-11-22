import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { AdminEmailConfirmState, AuthState } from "../packages/shared/src/index.js";
import { ADMIN, MOM, csrf } from "./helpers.js";

/**
 * Single sign-on through Cloudflare Access, the browser side (#178, FR-15.8). The e2e server has no Access in front of
 * it (and a browser cannot send the public Host or keep its Secure cookie over plain http), so the Access layer is
 * simulated by route mocks: `/api/auth/state` says "signed out, passed Access as <email>" and
 * `/api/auth/access-login` answers as the server would. A successful sign-in is backed by a real session of its own
 * (a password login made by the mock), so the app behind it is the real one — and every auth answer still carries
 * the Access email, as the public host's would. Mock answers are parsed with the shared schemas, so they cannot
 * drift from the real types. The server side of the same flow
 * (JWT checks, refusals, fixation, CSRF) is `apps/server/test/access-login.test.ts`.
 */

type LoginAnswer = "ok" | "hang" | "access_no_account" | "access_email_mismatch";

async function simulateAccess(
  ctx: BrowserContext,
  baseURL: string,
  o: {
    email?: string;
    answers?: LoginAnswer[];
    confirm?: { oldEmail: string; newEmail: string };
    /** Never answer the sign-in's own state read (the one after the confirm check), once. */
    hangStateRead?: boolean;
  } = {},
) {
  const email = o.email ?? MOM.email;
  const answers = [...(o.answers ?? ["ok"])];
  const seen = { accessLogins: 0, signedIn: false, confirmChecked: false, hungStateRead: false };
  let hangState = !!o.hangStateRead;
  /** The public host's answer: whatever the server says, plus the email that passed Access. */
  const throughAccess = (body: unknown) => AuthState.parse({ ...(body as object), accessEmail: email });
  // Records whether a password field ever appeared, on any screen, in any page of this context.
  await ctx.addInitScript(() => {
    const w = window as unknown as { __sawPassword?: boolean };
    new MutationObserver(() => {
      if (document.querySelector('input[type="password"]')) w.__sawPassword = true;
    }).observe(document, { subtree: true, childList: true });
  });
  await ctx.route("**/api/auth/state", async (route) => {
    if (hangState && seen.confirmChecked) {
      hangState = false;
      seen.hungStateRead = true;
      return; // never answered: the page has to give up on it
    }
    if (seen.signedIn) return route.fulfill({ json: throughAccess(await (await route.fetch()).json()) });
    return route.fulfill({
      json: throughAccess({ setupRequired: false, user: null, adminEmail: ADMIN.email }),
    });
  });
  await ctx.route("**/api/access/admin-email/confirm", (route) => {
    seen.confirmChecked = true;
    return route.fulfill({
      json: AdminEmailConfirmState.parse(
        o.confirm ? { ready: true, ...o.confirm } : { ready: false, oldEmail: null, newEmail: null },
      ),
    });
  });
  await ctx.route("**/api/auth/access-login", async (route) => {
    seen.accessLogins++;
    const answer = answers.shift() ?? "ok";
    if (answer === "hang") return; // never answered
    if (answer !== "ok") return route.fulfill({ status: 403, json: { error: answer } });
    // A real session for the account (its own: the saved ones other tests share stay untouched).
    const login = await ctx.request.post("/api/auth/login", {
      data: { email: MOM.email, password: MOM.password },
      headers: csrf(baseURL),
    });
    seen.signedIn = true;
    return route.fulfill({ json: throughAccess(await login.json()) });
  });
  await ctx.route("**/api/auth/logout", async (route) => {
    // The real logout runs (ends the session); the answer is the public host's, which carries the Access email.
    const res = await route.fetch();
    seen.signedIn = false;
    return route.fulfill({ response: res, json: throughAccess(await res.json()) });
  });
  await ctx.route("**/cdn-cgi/access/logout", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Cloudflare</title><p>Logged out</p>",
    }),
  );
  return seen;
}

const sawPassword = (page: Page) =>
  page.evaluate(() => !!(window as unknown as { __sawPassword?: boolean }).__sawPassword);

test("passing Access signs in without a password: one access-login call, straight to the app", async ({
  browser,
  baseURL,
}) => {
  const ctx = await browser.newContext({ baseURL: baseURL! });
  const seen = await simulateAccess(ctx, baseURL!);
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.getByTestId("sidebar")).toBeAttached();
  expect(seen.accessLogins).toBe(1);
  expect(await sawPassword(page)).toBe(false);
  // A reload with the session in place starts none.
  await page.reload();
  await expect(page.getByTestId("sidebar")).toBeAttached();
  expect(seen.accessLogins).toBe(1);
  // Settings has no password to change through Access (#229); the other panels are there.
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "내 지침" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "비밀번호 변경" })).toHaveCount(0);
  await expect(
    page.locator('input[autocomplete="current-password"], input[autocomplete="new-password"]'),
  ).toHaveCount(0);
  await ctx.close();
});

test("tabs booting together start one session between them", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL: baseURL! });
  const seen = await simulateAccess(ctx, baseURL!);
  const [a, b] = [await ctx.newPage(), await ctx.newPage()];
  await Promise.all([a.goto("/"), b.goto("/")]);
  await expect(a.getByTestId("sidebar")).toBeAttached();
  await expect(b.getByTestId("sidebar")).toBeAttached();
  expect(seen.accessLogins).toBe(1);
  await ctx.close();
});

test("no account for the Access email: the blocked screen, no password form", async ({
  browser,
  baseURL,
}) => {
  const ctx = await browser.newContext({ baseURL: baseURL! });
  const seen = await simulateAccess(ctx, baseURL!, {
    email: "stranger@example.com",
    answers: ["access_no_account"],
  });
  const page = await ctx.newPage();
  await page.goto("/");
  const blocked = page.getByTestId("access-no-account");
  await expect(blocked).toContainText("stranger@example.com");
  await expect(blocked).toContainText("쓸 수 있는 계정이 없어요");
  await expect(page.getByTestId("access-logout")).toHaveAttribute("href", "/cdn-cgi/access/logout");
  await expect(page.getByRole("button", { name: "로그인" })).toHaveCount(0);
  expect(seen.accessLogins).toBe(1);
  expect(await sawPassword(page)).toBe(false);
  await ctx.close();
});

test("another account's session: the mismatch screen; clearing the app login lets the Access email in", async ({
  browser,
  baseURL,
}) => {
  const ctx = await browser.newContext({ baseURL: baseURL! });
  const seen = await simulateAccess(ctx, baseURL!, { answers: ["access_email_mismatch", "ok"] });
  const page = await ctx.newPage();
  await page.goto("/");
  const mismatch = page.getByTestId("access-mismatch");
  await expect(mismatch).toContainText(MOM.email);
  await expect(mismatch.getByTestId("access-logout")).toBeVisible();
  expect(await sawPassword(page)).toBe(false);
  await mismatch.getByRole("button", { name: "앱 로그인 지우고 다시 들어가기" }).click();
  await expect(page.getByTestId("sidebar")).toBeAttached();
  expect(seen.accessLogins).toBe(2);
  expect(await sawPassword(page)).toBe(false);
  await ctx.close();
});

test("the admin email switch (#36) still comes first: no access-login while it is ready", async ({
  browser,
  baseURL,
}) => {
  const ctx = await browser.newContext({ baseURL: baseURL! });
  const seen = await simulateAccess(ctx, baseURL!, {
    email: "dad-new@example.com",
    confirm: { oldEmail: ADMIN.email, newEmail: "dad-new@example.com" },
  });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.getByTestId("admin-email-confirm")).toContainText("dad-new@example.com");
  await page.waitForTimeout(300);
  expect(seen.accessLogins).toBe(0);
  expect(await sawPassword(page)).toBe(false);
  await ctx.close();
});

test("logout on the public host ends the app session, then Cloudflare's logout — no sign-in again on the way", async ({
  browser,
  baseURL,
}, info) => {
  const ctx = await browser.newContext({ baseURL: baseURL! });
  const seen = await simulateAccess(ctx, baseURL!);
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.getByTestId("sidebar")).toBeAttached();
  if (info.project.name === "mobile") await page.getByRole("button", { name: "메뉴 열기" }).click();
  await page.getByRole("button", { name: "로그아웃" }).click();
  await expect(page).toHaveURL(/\/cdn-cgi\/access\/logout$/);
  await expect(page.getByText("Logged out")).toBeVisible();
  expect(seen.signedIn).toBe(false);
  expect(seen.accessLogins).toBe(1);
  // The app session really ended: the server answers signed out for this browser.
  const state = (await (await ctx.request.get("/api/auth/state")).json()) as { user: unknown };
  expect(state.user).toBeNull();
  await ctx.close();
});

test("a sign-in request that never answers times out to the retry screen; retrying signs in", async ({
  browser,
  baseURL,
}) => {
  const ctx = await browser.newContext({ baseURL: baseURL! });
  const seen = await simulateAccess(ctx, baseURL!, { answers: ["hang", "ok"] });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("로그인 응답이 늦어요", { timeout: 15_000 });
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByTestId("sidebar")).toBeAttached();
  expect(seen.accessLogins).toBe(2);
  expect(await sawPassword(page)).toBe(false);
  await ctx.close();
});

test("a state read under the lock that never answers times out, releases the lock, and retry works", async ({
  browser,
  baseURL,
}) => {
  const ctx = await browser.newContext({ baseURL: baseURL! });
  const seen = await simulateAccess(ctx, baseURL!, { hangStateRead: true });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("로그인 응답이 늦어요", { timeout: 15_000 });
  expect(seen.hungStateRead).toBe(true);
  expect(seen.accessLogins).toBe(0);
  // The lock is free again: the retry gets it at once and signs in.
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByTestId("sidebar")).toBeAttached();
  expect(seen.accessLogins).toBe(1);
  await ctx.close();
});

test("a tab stuck holding the sign-in lock does not block another for good", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL: baseURL! });
  const seen = await simulateAccess(ctx, baseURL!);
  // Another tab of the same origin holds the lock and never lets go.
  const holder = await ctx.newPage();
  await holder.goto("/cdn-cgi/access/logout");
  await holder.evaluate(
    () =>
      new Promise<void>((held) => {
        void navigator.locks.request("agentlee-access-login", () => {
          held();
          return new Promise(() => {});
        });
      }),
  );
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("로그인 응답이 늦어요", { timeout: 15_000 });
  expect(seen.accessLogins).toBe(0);
  await holder.close(); // its lock goes with it
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByTestId("sidebar")).toBeAttached();
  expect(seen.accessLogins).toBe(1);
  await ctx.close();
});

/**
 * The answer's headers arrive, then its body never finishes (#178 round 3). A route mock cannot hold a body open,
 * so `fetch` itself is wrapped for that one request: JSON headers at once, a body stream that never closes and
 * errors with an AbortError when the request's signal fires — what a browser does with a stalled body.
 */
for (const which of ["state", "access-login"] as const)
  test(`a ${which} answer whose body stalls after the headers times out to the retry screen; retry signs in`, async ({
    browser,
    baseURL,
  }) => {
    const ctx = await browser.newContext({ baseURL: baseURL! });
    const seen = await simulateAccess(ctx, baseURL!);
    await ctx.addInitScript((target) => {
      const real = window.fetch.bind(window);
      let confirmSeen = false;
      let stalled = false;
      window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/api/access/admin-email/confirm")) confirmSeen = true;
        const hit =
          target === "state"
            ? url.includes("/api/auth/state") && confirmSeen // the sign-in's own read, under the lock
            : url.includes("/api/auth/access-login");
        if (!hit || stalled) return real(input, init);
        stalled = true;
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"setupRequired":'));
            signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
          },
        });
        (window as unknown as { __stalled?: string }).__stalled = target;
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      };
    }, which);
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(page.getByRole("alert")).toContainText("로그인 응답이 늦어요", { timeout: 15_000 });
    expect(await page.evaluate(() => (window as unknown as { __stalled?: string }).__stalled)).toBe(which);
    expect(seen.accessLogins).toBe(0);
    await page.getByRole("button", { name: "다시 시도" }).click();
    await expect(page.getByTestId("sidebar")).toBeAttached();
    expect(seen.accessLogins).toBe(1);
    await ctx.close();
  });
