import fs from "node:fs";
import path from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";

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
