import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import "./auth/context.js";
import { readCookie } from "./auth/plugin.js";
import { isApiRequest, routerPath } from "./paths.js";
import { knownSecrets } from "./secrets/known.js";

/**
 * Temporary access-code gate (until Cloudflare Access is configured, docs/ops.md §7).
 * With TEMP_GATE_CODE set, every tunnel request (Host = PUBLIC_HOST) except the code page needs a signed cookie obtained by entering
 * the code. The code is compared in constant time, failures are rate-limited per client and globally,
 * and neither the code nor the cookie is ever logged (request bodies and headers are not logged at all).
 */

export const GATE_COOKIE = "al_gate";
export const GATE_PATH = "/gate";
export const isGatePath = (url: string | undefined) => routerPath(url) === GATE_PATH;

export type GateOptions = {
  code: string;
  /** Cookie lifetime. */
  ttlMs?: number;
  /** Failed attempts allowed per client within `windowMs`. */
  perClientFailures?: number;
  /** Failed attempts allowed from everyone together within `windowMs` (blocks distributed guessing). */
  globalFailures?: number;
  windowMs?: number;
  now?: () => number;
};

const sha256 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest();

export function codeMatches(input: string, code: string): boolean {
  return crypto.timingSafeEqual(sha256(input), sha256(code));
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Where to go after the code: a same-site path only (never `//host` or a backslash trick), else "/". */
export function safeNext(v: unknown): string {
  if (typeof v !== "string" || v.length > 2000) return "/";
  return /^\/(?![/\\])[^\s]*$/.test(v) ? v : "/";
}

function page(message?: string, next = "/"): string {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Agent Lee</title>
<style>
:root{color-scheme:light dark;--bg:#f6f6f4;--fg:#1d1d1b;--card:#fff;--line:#d9d9d4;--accent:#2f5bd3;--err:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecece8;--card:#222220;--line:#3a3a37;--accent:#8aa8ff;--err:#ff8a80}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Apple SD Gothic Neo",sans-serif;padding:16px}
form{width:100%;max-width:340px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px 24px;display:grid;gap:14px}
h1{margin:0;font-size:20px}p{margin:0;font-size:14px;opacity:.8}
input{font:inherit;font-size:22px;letter-spacing:.2em;text-align:center;padding:10px;border:1px solid var(--line);border-radius:10px;background:transparent;color:inherit}
button{font:inherit;padding:11px;border:0;border-radius:10px;background:var(--accent);color:#fff;font-weight:600;cursor:pointer}
.err{color:var(--err);opacity:1}
</style></head><body>
<form method="post" action="${GATE_PATH}">
<input type="hidden" name="next" value="${esc(next)}">
<h1>Agent Lee</h1><p>테스트 기간 접속 코드를 입력하세요.</p>
<input name="code" type="password" inputmode="numeric" autocomplete="one-time-code" maxlength="64" required autofocus aria-label="접속 코드">
${message ? `<p class="err" role="alert">${esc(message)}</p>` : ""}
<button type="submit">들어가기</button>
</form></body></html>`;
}

export function registerGate(app: FastifyInstance, opts: GateOptions): void {
  const ttlMs = opts.ttlMs ?? 7 * 24 * 3600_000;
  const windowMs = opts.windowMs ?? 15 * 60_000;
  const perClient = opts.perClientFailures ?? 5;
  const globalMax = opts.globalFailures ?? 30;
  const now = opts.now ?? Date.now;
  // Per-process signing key: a restart (or a new code) signs everyone out, which is fine for a temporary gate.
  const key = crypto.createHash("sha256").update(crypto.randomBytes(32)).update(opts.code).digest();
  const sign = (exp: number) => crypto.createHmac("sha256", key).update(`gate.v1.${exp}`).digest("base64url");

  const failures = new Map<string, number[]>();
  let globalFails: number[] = [];
  const recent = (list: number[]) => list.filter((t) => now() - t < windowMs);

  function valid(req: FastifyRequest): boolean {
    const v = readCookie(req.headers.cookie, GATE_COOKIE);
    const m = /^(\d{1,15})\.([A-Za-z0-9_-]{43})$/.exec(v ?? "");
    if (!m) return false;
    const exp = Number(m[1]);
    if (exp <= now()) return false;
    const a = Buffer.from(m[2]!);
    const b = Buffer.from(sign(exp));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  const send = (reply: FastifyReply, status: number, message?: string, next = "/") =>
    reply
      .code(status)
      .header("Cache-Control", "no-store")
      .type("text/html; charset=utf-8")
      .send(page(message, next));

  app.addHook("onRequest", async (req, reply) => {
    // Only tunnel requests are gated; local requests already passed the trust boundary (Host + no Cf-* headers).
    if (req.ctx.origin !== "edge" || isGatePath(req.url)) return;
    if (valid(req)) return;
    if (isApiRequest(req))
      return reply.code(401).header("Cache-Control", "no-store").send({ error: "gate_required" });
    if (req.method === "GET" || req.method === "HEAD")
      // Remember where they were going, so the code page sends them back there.
      return reply
        .code(302)
        .header("Cache-Control", "no-store")
        .redirect(req.url === "/" ? GATE_PATH : `${GATE_PATH}?next=${encodeURIComponent(req.url)}`);
    return reply.code(401).header("Cache-Control", "no-store").send({ error: "gate_required" });
  });

  app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string", bodyLimit: 1024 },
      (_req, body, done) => done(null, new URLSearchParams(body as string)),
    );
    scope.get(GATE_PATH, async (req, reply) => {
      const next = safeNext((req.query as { next?: unknown }).next);
      return valid(req) ? reply.redirect(next, 303) : send(reply, 200, undefined, next);
    });
    scope.post(GATE_PATH, async (req, reply) => {
      const next = safeNext(req.body instanceof URLSearchParams ? req.body.get("next") : null);
      const client = req.ctx.clientIp;
      const mine = recent(failures.get(client) ?? []);
      globalFails = recent(globalFails);
      if (mine.length >= perClient || globalFails.length >= globalMax)
        return send(reply, 429, "시도가 너무 많아요. 잠시 후 다시 시도하세요.", next);
      const input = req.body instanceof URLSearchParams ? (req.body.get("code") ?? "") : "";
      if (!codeMatches(input.trim(), opts.code)) {
        mine.push(now());
        failures.set(client, mine);
        globalFails.push(now());
        if (failures.size > 10_000) failures.clear();
        return send(reply, 401, "코드가 맞지 않아요.", next);
      }
      failures.delete(client);
      const exp = now() + ttlMs;
      const signature = sign(exp);
      knownSecrets.add(signature); // the cookie is a bearer pass: never in a reply
      const cookie = [
        `${GATE_COOKIE}=${exp}.${signature}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        `Max-Age=${Math.floor(ttlMs / 1000)}`,
        ...(req.ctx.origin === "edge" ? ["Secure"] : []),
      ].join("; ");
      return reply.header("Set-Cookie", cookie).header("Cache-Control", "no-store").redirect(next, 303);
    });
  });
}
