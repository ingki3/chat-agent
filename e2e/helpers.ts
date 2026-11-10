import type { APIRequestContext, Page } from "@playwright/test";

export const ADMIN = { email: "ingki3@gmail.com", password: "e2e-admin-password", name: "관리자" };
export const MOM = { email: "mom@example.com", password: "e2e-mom-password", name: "엄마" };
export const SON = { email: "son@example.com", password: "e2e-son-password", name: "아들" };

export const csrf = (baseURL: string) => ({ origin: baseURL, "x-agent-lee": "1" });

/** Signs in through the API (the login screen itself is covered by smoke.spec.ts). */
export async function signIn(page: Page, who: { email: string; password: string }, baseURL: string) {
  const r = await page.request.post("/api/auth/login", {
    data: { email: who.email, password: who.password },
    headers: csrf(baseURL),
  });
  if (!r.ok()) throw new Error(`login ${who.email}: ${r.status()}`);
}

export async function newConversation(request: APIRequestContext, baseURL: string, title: string) {
  const r = await request.post("/api/conversations", { data: { title }, headers: csrf(baseURL) });
  return (await r.json()) as { id: string; title: string };
}
