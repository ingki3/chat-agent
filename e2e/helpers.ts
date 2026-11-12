import fs from "node:fs";
import path from "node:path";
import { expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";

export const ADMIN = { email: "ingki3@gmail.com", password: "e2e-admin-password", name: "관리자" };
export const MOM = { email: "mom@example.com", password: "e2e-mom-password", name: "엄마" };
export const SON = { email: "son@example.com", password: "e2e-son-password", name: "아들" };

export const csrf = (baseURL: string) => ({ origin: baseURL, "x-agent-lee": "1" });

export async function newConversation(request: APIRequestContext, baseURL: string, title: string) {
  const r = await request.post("/api/conversations", { data: { title }, headers: csrf(baseURL) });
  return (await r.json()) as { id: string; title: string };
}

/** Saved sessions (written by first-run.setup.ts) — tests reuse them instead of logging in again and again. */
export const AUTH_DIR = path.join(".e2e", "auth");
export const authFile = (who: { email: string }) => path.join(AUTH_DIR, `${who.email}.json`);

/** Puts a saved session of `who` into this page's browser context. */
export async function useAccount(page: Page, who: { email: string }) {
  const state = JSON.parse(fs.readFileSync(authFile(who), "utf8")) as {
    cookies: Parameters<ReturnType<Page["context"]>["addCookies"]>[0];
  };
  await page.context().addCookies(state.cookies);
}

/** A fresh family account made by the admin (its own permissions and defaults, so parallel runs never collide). */
export async function newMember(browser: Browser, baseURL: string, label: string, youth = false) {
  const ctx = await browser.newContext({ baseURL });
  const adminPage = await ctx.newPage();
  await useAccount(adminPage, ADMIN);
  const email = `${label}-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.com`;
  const name = `${label}${Math.round(Math.random() * 1e4)}`;
  const created = await adminPage.request.post("/api/admin/users", {
    data: { name, email, youth },
    headers: csrf(baseURL),
  });
  expect(created.status()).toBe(201);
  const { user, temporaryPassword } = (await created.json()) as {
    user: { id: string };
    temporaryPassword: string;
  };
  await ctx.close();
  return { id: user.id, name, email, temporaryPassword };
}

export async function signIn(page: Page, baseURL: string, who: { email: string; temporaryPassword: string }) {
  await page.request.post("/api/auth/login", {
    data: { email: who.email, password: who.temporaryPassword },
    headers: csrf(baseURL),
  });
  await page.request.post("/api/auth/password", {
    data: { currentPassword: who.temporaryPassword, newPassword: "admin-e2e-password-1" },
    headers: csrf(baseURL),
  });
}
