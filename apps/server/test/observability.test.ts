import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { CSRF_HEADER, RecentErrorsResponse, type Run, type StartRunResponse } from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { rotatingFile, sanitizeRecord } from "../src/logging.js";
import { classifyError, ErrorLog } from "../src/observability/errors.js";
import {
  RuntimeRegistry,
  type RuntimeAdapter,
  type RuntimeEvent,
  type RuntimeSession,
} from "../src/runtime/adapter.js";
import { createFamily } from "./helpers/permission-matrix.js";

type App = Awaited<ReturnType<typeof buildApp>>;
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

/**
 * Leak fixtures (#46): every one of these is pushed through requests, errors, runs and tools below, and none may
 * ever appear in the captured log output or the admin error list.
 */
const SECRETS = {
  prompt: "우리 아들 성적표 비밀 문장 PROMPT-LEAK-7f3a",
  output: "모델 답변 원문 OUTPUT-LEAK-91c2",
  reasoning: "속생각 REASONING-LEAK-55e1",
  toolInput: "TOOLINPUT-LEAK-3b8d",
  toolOutput: "TOOLOUTPUT-LEAK-c40f",
  sdkError: "SDK raw error with prompt SDKERR-LEAK-e912",
  stderr: "stderr: Traceback STDERR-LEAK-0aa1",
  apiKey: "sk-ant-api03-KEYLEAK0123456789abcdefghijklmnopqrstuvwxyz",
  openaiKey: "sk-proj-OPENAILEAK0123456789abcdefghij",
  password: "Wrong-Password-LEAK-77",
  cookie: "COOKIE-LEAK-5d2c",
  bearer: "BEARER-LEAK-a1b2",
  jwt: "eyJhbGciOiJSUzI1NiJ9.JWTLEAK.c2lnbmF0dXJl",
  idempotency: "IDEMPOTENCY-LEAK-8e8e",
  query: "QUERY-LEAK-1234",
  gateCode: "GATECODELEAK99",
  email: "leak.person@example.org",
  routeError: "THROWN-ROUTE-LEAK-6c6c",
  title: "대화 제목 TITLE-LEAK-4f4f",
};
/** Generic patterns: API-key shapes, JWTs, e-mail addresses. */
const PATTERNS = [/sk-(ant|proj)-/, /eyJ[A-Za-z0-9_-]{5,}\./, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/];

function assertNoLeak(text: string) {
  for (const [name, secret] of Object.entries(SECRETS)) expect(text, `leaked ${name}`).not.toContain(secret);
  for (const re of PATTERNS) expect(text, `matches ${re}`).not.toMatch(re);
}

function capture() {
  const lines: string[] = [];
  const stream = new Writable({ write: (c, _e, cb) => (lines.push(String(c)), cb()) });
  const records = () =>
    lines
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { stream, text: () => lines.join(""), records };
}

/** A runtime whose every event carries a secret; "FAIL" in the prompt makes it throw an SDK-like error. */
class LeakyRuntime implements RuntimeAdapter {
  readonly id = "claude-code" as const;
  capabilities() {
    return {
      models: [{ id: "m1", label: "M1", efforts: [] }],
      canSwitchModelInSession: true,
      canResume: false,
    };
  }
  async resume(): Promise<RuntimeSession> {
    throw new Error("no resume");
  }
  async start(): Promise<RuntimeSession> {
    return {
      externalSessionId: "leaky-1",
      setModel: async () => {},
      close: async () => {},
      turn: (input) => {
        async function* events(): AsyncGenerator<RuntimeEvent> {
          yield { type: "reasoning_delta", text: SECRETS.reasoning };
          yield { type: "text_delta", text: SECRETS.output };
          yield { type: "tool_start", callId: "c1", name: "web_search", input: { q: SECRETS.toolInput } };
          await new Promise((r) => setTimeout(r, 5));
          yield { type: "tool_end", callId: "c1", output: { text: SECRETS.toolOutput } };
          yield { type: "tool_start", callId: "c2", name: "mcp__agentlee__stocks", input: SECRETS.apiKey };
          yield { type: "tool_end", callId: "c2", output: SECRETS.stderr, isError: true };
          yield { type: "usage", inputTokens: 120, outputTokens: 30, costUsd: 0.0125 };
          if (input.text.includes("FAIL")) {
            const err = new Error(`${SECRETS.sdkError} ${input.text} ${SECRETS.apiKey}`) as Error & {
              stderr?: string;
              code?: string;
            };
            err.stderr = SECRETS.stderr;
            throw err;
          }
        }
        return { events: events(), interrupt: async () => {} };
      },
    };
  }
}

async function start(env: Record<string, string> = {}) {
  const log = capture();
  const runtimes = new RuntimeRegistry();
  runtimes.register(new LeakyRuntime());
  const app = await buildApp(loadConfig({ NODE_ENV: "test", ...env }), {
    db: createTestDb(),
    logStream: log.stream,
    runtimes,
    runs: { flushMs: 0 },
  });
  app.get("/api/test/boom", { config: { auth: "public", noResource: "test" } }, async () => {
    throw new Error(`${SECRETS.routeError} ${SECRETS.prompt}`);
  });
  apps.push(app);
  const f = await createFamily(app);
  const headers = (cookie: string, extra: Record<string, string> = {}) => ({
    host: "localhost:3000",
    cookie,
    origin: "http://localhost:3000",
    [CSRF_HEADER]: "1",
    ...extra,
  });
  const waitRun = async (id: string) => {
    for (let i = 0; i < 400; i++) {
      const r = (await app.inject({ url: `/api/runs/${id}`, headers: headers(f.cookies.owner) })).json<Run>();
      if (r.endedAt !== null) return r;
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error("run did not finish");
  };
  return { app, f, log, headers, waitRun };
}

describe("log record policy", () => {
  it("drops fields that are not allow-listed and values that fail their check", () => {
    const out = sanitizeRecord({
      level: 30,
      time: 1,
      msg: "run.finished",
      runId: "1f0e-uuid",
      userId: SECRETS.email,
      conversationId: SECRETS.prompt,
      status: SECRETS.prompt,
      tool: `web_search ${SECRETS.toolInput}`,
      errorCode: "runtime_error",
      costUsd: "0.1",
      durationMs: 12,
      prompt: SECRETS.prompt,
      headers: { cookie: SECRETS.cookie },
      err: {
        type: "Error",
        message: SECRETS.sdkError,
        stack: SECRETS.stderr,
        code: "E1",
        cause: SECRETS.prompt,
      },
      req: {
        method: "GET",
        url: `/api/x?token=${SECRETS.query}`,
        headers: { authorization: SECRETS.bearer },
      },
    });
    expect(out).toEqual({
      level: 30,
      time: 1,
      msg: "run.finished",
      runId: "1f0e-uuid",
      errorCode: "runtime_error",
      durationMs: 12,
      err: { type: "Error", code: "E1" },
      req: { method: "GET" },
    });
  });

  it("keeps only known messages", () => {
    expect(sanitizeRecord({ msg: SECRETS.prompt }).msg).toBe("redacted");
    expect(sanitizeRecord({ msg: SECRETS.sdkError, err: {} }).msg).toBe("error");
    expect(sanitizeRecord({ msg: "request completed" }).msg).toBe("request completed");
    expect(sanitizeRecord({ msg: "Server listening at http://127.0.0.1:3000" }).msg).toBe(
      "Server listening at http://127.0.0.1:3000",
    );
    expect(sanitizeRecord({ msg: "Server listening at http://evil.example:80/?x=1" }).msg).toBe("redacted");
    expect(sanitizeRecord({ msg: `Route GET:/x?token=${SECRETS.query} not found` }).msg).toBe(
      "route not found",
    );
  });

  it("classifies errors by class name and code only", () => {
    expect(classifyError(new Error(SECRETS.sdkError))).toEqual({ code: "internal_error", category: "app" });
    expect(classifyError(Object.assign(new Error("x"), { code: "SQLITE_BUSY" })).code).toBe("db_busy");
    expect(classifyError(Object.assign(new Error("x"), { code: "ECONNRESET" })).code).toBe("network_error");
    expect(classifyError(new DOMException("x", "TimeoutError")).code).toBe("timeout");
    expect(classifyError("a string").code).toBe("internal_error");
  });
});

describe("leak fixtures end to end", () => {
  it("never writes secrets from requests, headers, errors, runs or tools to the log", async () => {
    const { app, f, log, headers, waitRun } = await start();
    const conv = app.conversations!.create(f.users.owner.id, { title: SECRETS.title });

    // A run that succeeds (text, reasoning, tool input/output, a failing tool, usage)…
    const ok = await app.inject({
      method: "POST",
      url: `/api/conversations/${conv.id}/messages?token=${SECRETS.query}`,
      headers: headers(f.cookies.owner, {
        "idempotency-key": SECRETS.idempotency,
        authorization: `Bearer ${SECRETS.bearer}`,
        "content-type": "application/json",
      }),
      payload: { text: SECRETS.prompt },
    });
    expect(ok.statusCode).toBe(201);
    const okRun = await waitRun(ok.json<StartRunResponse>().run.id);
    expect(okRun.status).toBe("done");

    // …and one that fails with an SDK error carrying the prompt, a key and stderr.
    const conv2 = app.conversations!.create(f.users.owner.id);
    const bad = await app.inject({
      method: "POST",
      url: `/api/conversations/${conv2.id}/messages`,
      headers: headers(f.cookies.owner, { "content-type": "application/json" }),
      payload: { text: `FAIL ${SECRETS.prompt}` },
    });
    const badRun = await waitRun(bad.json<StartRunResponse>().run.id);
    expect(badRun.status).toBe("failed");
    expect(badRun.errorCode).toBe("runtime_error");

    // Failed login (password + e-mail), forged Cloudflare header on a local host, a throwing route, a 404 with a query.
    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host: "localhost:3000", origin: "http://localhost:3000", [CSRF_HEADER]: "1" },
      payload: { email: SECRETS.email, password: SECRETS.password },
    });
    await app.inject({
      url: "/api/auth/me",
      headers: {
        host: "localhost:3000",
        "cf-access-jwt-assertion": SECRETS.jwt,
        cookie: `al_session=${SECRETS.cookie}`,
      },
    });
    const boom = await app.inject({ url: "/api/test/boom", headers: { host: "localhost:3000" } });
    expect(boom.statusCode).toBe(500);
    expect(boom.json()).toEqual({ error: "internal_error" });
    assertNoLeak(boom.body);
    await app.inject({
      url: `/api/nope/${SECRETS.query}?k=${SECRETS.apiKey}`,
      headers: { host: "localhost:3000" },
    });
    await app.inject({
      method: "POST",
      url: "/api/conversations",
      headers: headers(f.cookies.owner, { "content-type": "application/json" }),
      payload: `{"title": "${SECRETS.title}"`, // malformed JSON → 400 from Fastify
    });

    const text = log.text();
    assertNoLeak(text);

    // What *is* logged: IDs, durations, codes and cost.
    const recs = log.records();
    const runRecs = recs.filter((r) => r.msg === "run.finished");
    expect(runRecs).toHaveLength(2);
    expect(runRecs.find((r) => r.runId === okRun.id)).toMatchObject({
      userId: f.users.owner.id,
      conversationId: conv.id,
      runtime: "claude-code",
      status: "done",
      costUsd: 0.0125,
      inputTokens: 120,
      outputTokens: 30,
    });
    expect(runRecs.find((r) => r.runId === badRun.id)).toMatchObject({
      status: "failed",
      errorCode: "runtime_error",
      category: "runtime",
      err: { type: "Error" },
    });
    const tools = recs.filter((r) => r.msg === "tool.finished" && r.runId === okRun.id);
    expect(tools.map((t) => [t.tool, t.status])).toEqual([
      ["web_search", "ok"],
      ["mcp__agentlee__stocks", "error"],
    ]);
    expect(typeof tools[0]!.durationMs).toBe("number");
    expect(
      recs.some((r) => r.msg === "request.error" && (r.err as { type?: string })?.type === "Error"),
    ).toBe(true);
    // Requests appear by route pattern, never by raw URL.
    const urls = recs.flatMap((r) =>
      (r.req as { url?: string })?.url ? [(r.req as { url: string }).url] : [],
    );
    expect(urls).toContain("/api/conversations/:id/messages");
    expect(urls.every((u) => !u.includes("?"))).toBe(true);
    // Every key that reaches the destination is allow-listed.
    const { LOG_ALLOWED_FIELDS } = await import("../src/logging.js");
    for (const r of recs) for (const k of Object.keys(r)) expect(LOG_ALLOWED_FIELDS.has(k), k).toBe(true);

    // The admin "최근 오류" list: same policy, admin only.
    const list = await app.inject({ url: "/api/admin/errors", headers: headers(f.cookies.admin) });
    expect(list.statusCode).toBe(200);
    assertNoLeak(list.body);
    const { errors } = RecentErrorsResponse.parse(list.json());
    expect(errors.map((e) => [e.source, e.code])).toEqual(
      expect.arrayContaining([
        ["run", "runtime_error"],
        ["tool", "tool_error"],
        ["http", "internal_error"],
      ]),
    );
    expect(errors.find((e) => e.source === "http")).toMatchObject({
      route: "GET /api/test/boom",
      statusCode: 500,
    });
    expect(errors.find((e) => e.source === "tool")).toMatchObject({ tool: "mcp__agentlee__stocks" });
    const onlyRuns = await app.inject({
      url: "/api/admin/errors?source=run&limit=5",
      headers: headers(f.cookies.admin),
    });
    expect(RecentErrorsResponse.parse(onlyRuns.json()).errors.every((e) => e.source === "run")).toBe(true);
    expect(
      (await app.inject({ url: "/api/admin/errors?limit=0", headers: headers(f.cookies.admin) })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: "/api/admin/errors", headers: headers(f.cookies.owner) })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: "/api/admin/errors", headers: { host: "localhost:3000" } })).statusCode,
    ).toBe(401);
  });

  it("never logs the temporary gate code or edge headers", async () => {
    const { app, log } = await start({ TEMP_GATE_CODE: SECRETS.gateCode });
    const edge = { host: "chat.2prostream.com", "cf-connecting-ip": "203.0.113.9" };
    for (const code of [SECRETS.gateCode, `${SECRETS.gateCode}x`])
      await app.inject({
        method: "POST",
        url: "/gate",
        headers: { ...edge, "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ code, next: `/c/1?t=${SECRETS.query}` }).toString(),
      });
    await app.inject({
      url: `/?code=${SECRETS.gateCode}`,
      headers: { ...edge, cookie: `al_gate=${SECRETS.cookie}`, "cf-access-jwt-assertion": SECRETS.jwt },
    });
    expect(log.records().length).toBeGreaterThan(0);
    assertNoLeak(log.text());
  });
});

describe("recent error store", () => {
  it("re-checks fields on the way in and keeps only the newest rows", () => {
    let t = 1000;
    const store = new ErrorLog(createTestDb(), { now: () => t, maxRows: 3 });
    store.record({
      source: "run",
      code: SECRETS.sdkError,
      category: "runtime",
      userId: SECRETS.email,
      tool: `x ${SECRETS.toolInput}`,
      route: `GET /x?${SECRETS.query}`,
    });
    const [first] = store.recent();
    expect(first).toMatchObject({ code: "unknown", userId: null, tool: null, route: null });
    for (let i = 0; i < 5; i++) {
      t += 1;
      store.record({ source: "http", code: "internal_error", category: "app", statusCode: 500 });
    }
    expect(store.recent()).toHaveLength(3);
    expect(store.recent({ limit: 1 })[0]!.at).toBe(t);
  });
});

describe("rotating log file", () => {
  it("rotates by size and keeps the configured number of files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-log-"));
    const file = path.join(dir, "server.log");
    const s = rotatingFile(file, { maxBytes: 100, keep: 2 });
    const line = JSON.stringify({ level: 30, msg: "x".repeat(40) }) + "\n";
    for (let i = 0; i < 10; i++) await new Promise<void>((r) => s.write(line, () => r()));
    await new Promise<void>((r) => s.end(r));
    expect(fs.readdirSync(dir).sort()).toEqual(["server.log", "server.log.1", "server.log.2"]);
    for (const f of fs.readdirSync(dir)) expect(fs.statSync(path.join(dir, f)).size).toBeLessThanOrEqual(100);
  });
});

describe("Access service token (uptime check)", () => {
  it("reaches /api/health and nothing else", async () => {
    const TEAM = "family.cloudflareaccess.com";
    const AUD = "b".repeat(64);
    const kp = await generateKeyPair("RS256");
    const jwk: JWK = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256" };
    const app = await buildApp(
      loadConfig({ NODE_ENV: "test", CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD }),
      {
        db: createTestDb(),
        accessKeys: createLocalJWKSet({ keys: [jwk] }),
        logger: false,
      },
    );
    apps.push(app);
    const token = await new SignJWT({ common_name: "abc123.access" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(`https://${TEAM}`)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(kp.privateKey);
    const h = { host: "chat.2prostream.com", "cf-access-jwt-assertion": token };
    expect((await app.inject({ url: "/api/health", headers: h })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/health?x=1", headers: h })).statusCode).toBe(200);
    for (const url of ["/", "/api/auth/me", "/api/admin/errors", "/api/%68ealth/../conversations"])
      expect((await app.inject({ url, headers: h })).statusCode, url).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/health", headers: h })).statusCode).toBe(403);
  });
});
