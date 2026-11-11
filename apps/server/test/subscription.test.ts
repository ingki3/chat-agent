import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  Connection,
  CSRF_HEADER,
  RuntimeOption,
  SubscriptionLogin,
  type Run,
  type StreamEvent,
} from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { connections, usageRecords } from "../src/db/schema.js";
import {
  ChatgptTokenService,
  CHATGPT_TOKEN_URL,
  CODEX_OAUTH_CLIENT_ID,
  credentialFromAuthJson,
  parseCredential,
  refreshChatgptTokens,
  type TokenPost,
} from "../src/connections/chatgpt.js";
import {
  SUBSCRIPTION_EXPIRED_CODE,
  SUBSCRIPTION_LIMIT_CODE,
  SUBSCRIPTION_LIMIT_MESSAGE,
} from "../src/connections/service.js";
import { RuntimeRegistry } from "../src/runtime/adapter.js";
import { CODEX_MODELS, CodexAdapter } from "../src/runtime/codex.js";
import { codexConnectionFor } from "../src/runtime/codex-config.js";
import { CodexDeviceLogin, LoginEnded } from "../src/runtime/codex-login.js";
import type { DeviceLoginProvider } from "../src/connections/login.js";
import { spawn } from "node:child_process";
import { FakeRuntime } from "../src/runtime/fake.js";
import { CODEX_CHATGPT_EGRESS_HOSTS, CODEX_LOGIN_EGRESS_HOSTS } from "../src/isolation/egress.js";
import { cx, newLog, replaySpawn, type DeviceLoginScript, type Recording } from "./helpers/codex-replay.js";
import { createFamily } from "./helpers/permission-matrix.js";
import http from "node:http";
import { BlockedRequestError, safeFetch } from "../src/isolation/net.js";
import { UsageStore } from "../src/usage/store.js";

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** A JWT-shaped fake token whose signature part is a marker the greps below look for. */
const jwt = (claims: object, marker: string) =>
  `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.${marker}${"z".repeat(24)}`;
const hour = () => Math.floor(Date.now() / 1000) + 3600;
const auth = (plan = "plus") => ({
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-fam-1", chatgpt_plan_type: plan },
});

/** Known fake tokens: none may ever appear in clear in a response, a log line, the database or a folder. */
const T = {
  access1: jwt({ exp: hour(), ...auth() }, "FAKEACCESSONE"),
  refresh1: `rt_FAKEREFRESHONE${"r".repeat(30)}`,
  id1: jwt({ email: "mom@family.test", ...auth() }, "FAKEIDONE"),
  access2: jwt({ exp: hour(), ...auth() }, "FAKEACCESSTWO"),
  refresh2: `rt_FAKEREFRESHTWO${"r".repeat(30)}`,
  access3: jwt({ exp: hour(), ...auth() }, "FAKEACCESSTHREE"),
  refresh3: `rt_FAKEREFRESHTHREE${"r".repeat(30)}`,
  code: "QWER-98765",
};
const MARKERS = [
  "FAKEACCESSONE",
  "FAKEACCESSTWO",
  "FAKEACCESSTHREE",
  "FAKEREFRESHONE",
  "FAKEREFRESHTWO",
  "FAKEREFRESHTHREE",
  "FAKEIDONE",
];
const EMAIL = "mom@family.test";

const authJson = (access = T.access1, refresh = T.refresh1) => ({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: { id_token: T.id1, access_token: access, refresh_token: refresh, account_id: "acct-fam-1" },
  last_refresh: "2026-11-11T00:00:00Z",
});
const ACCOUNT = { type: "chatgpt", email: EMAIL, planType: "plus" };
const success = (access = T.access1, refresh = T.refresh1): DeviceLoginScript => ({
  userCode: T.code,
  outcome: { success: true, authJson: authJson(access, refresh), delayMs: 20 },
  account: ACCOUNT,
});

const CATALOG = {
  models: CODEX_MODELS.map((m) => ({ slug: m.id, tool_mode: "direct", base_instructions: "You are Codex." })),
};

function capture() {
  const lines: string[] = [];
  const stream = new Writable({ write: (c, _e, cb) => (lines.push(String(c)), cb()) });
  return { stream, text: () => lines.join("") };
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let names: string[];
    try {
      names = fs.readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(p);
    }
  };
  walk(root);
  return out;
}

async function start(
  o: {
    timeoutMs?: number;
    recording?: Recording;
    tokenPost?: TokenPost;
    dataDir?: string;
    wrapDevice?: (d: DeviceLoginProvider) => DeviceLoginProvider;
    maxActiveLogins?: number;
    isLoginProcess?: (pid: number) => boolean;
  } = {},
) {
  const db = createTestDb();
  const log = capture();
  const dataDir = o.dataDir ?? fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "agentlee-sub-"));
  closers.push(async () => fs.rmSync(dataDir, { recursive: true, force: true }));
  /** What the next device login does (tests change it between logins). */
  const device: { script: DeviceLoginScript } = { script: success() };
  const loginLog = newLog();
  const runLog = newLog();
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  let tokenAnswer: { status: number; body: string } = {
    status: 200,
    body: JSON.stringify({ access_token: T.access2, refresh_token: T.refresh2, id_token: T.id1 }),
  };
  const tokenPost: TokenPost =
    o.tokenPost ??
    (async (url, body) => {
      posts.push({ url, body: JSON.parse(body) as Record<string, unknown> });
      return tokenAnswer;
    });
  // eslint-disable-next-line prefer-const
  let app: Awaited<ReturnType<typeof buildApp>>;
  let tokens: ChatgptTokenService | undefined;
  const codex = new CodexAdapter({
    connection: (ctx) => {
      tokens ??= new ChatgptTokenService(app.connections!.store, { post: tokenPost, log: app.log });
      return codexConnectionFor(app.connections!.store, app.users!, ctx, tokens);
    },
    spawn: (s) => replaySpawn(o.recording ?? { hi: cx.answer("안녕하세요") }, runLog)(s),
    bundledCatalog: async () => CATALOG,
    executable: "/nonexistent/codex",
  });
  const runtimes = new RuntimeRegistry();
  runtimes.register(new FakeRuntime({ id: "claude-code", needsConnection: false }));
  runtimes.register(codex);
  app = await buildApp(loadConfig({ NODE_ENV: "test", DATA_DIR: dataDir }), {
    db,
    logStream: log.stream,
    runtimes,
    runs: { flushMs: 0 },
    notifications: { sender: async () => {} },
    subscription: {
      tokenPost,
      device: (o.wrapDevice ?? ((d) => d))(
        new CodexDeviceLogin({
          executable: "/nonexistent/codex",
          timeoutMs: o.timeoutMs ?? 5000,
          spawn: (s) => replaySpawn({}, loginLog, { deviceLogin: device.script })(s),
        }),
      ),
      ...(o.maxActiveLogins ? { maxActiveLogins: o.maxActiveLogins } : {}),
      ...(o.isLoginProcess ? { isLoginProcess: o.isLoginProcess } : {}),
    },
  });
  closers.push(() => app.close());
  const f = await createFamily(app);
  const bodies: string[] = [];
  const req = async (cookie: string, method: "GET" | "POST" | "DELETE", url: string, payload?: object) => {
    const r = await app.inject({
      method,
      url,
      headers: {
        host: "localhost:3000",
        cookie,
        ...(method === "GET"
          ? {}
          : { origin: "http://localhost:3000", [CSRF_HEADER]: "1", "content-type": "application/json" }),
      },
      ...(method === "GET" ? {} : { payload: payload ?? {} }),
    });
    bodies.push(r.body);
    return r;
  };
  const as = (who: "owner" | "admin" | "stranger") => ({
    get: (url: string) => req(f.cookies[who], "GET", url),
    post: (url: string, body?: object) => req(f.cookies[who], "POST", url, body),
    del: (url: string) => req(f.cookies[who], "DELETE", url),
  });
  const owner = as("owner");
  const admin = as("admin");
  const stranger = as("stranger");
  const login = async (who = owner, body: object = { runtime: "codex" }) => {
    const r = await who.post("/api/connections/logins", body);
    expect(r.statusCode).toBe(201);
    return SubscriptionLogin.parse(r.json<{ login: unknown }>().login);
  };
  /** Polls like the page does, until the login has ended. */
  const until = async (id: string, who = owner) => {
    for (let i = 0; i < 400; i++) {
      const r = await who.get(`/api/connections/logins/${id}`);
      const j = r.json<{ login: unknown; connection: unknown }>();
      const l = SubscriptionLogin.parse(j.login);
      if (l.status !== "pending")
        return { login: l, connection: j.connection ? Connection.parse(j.connection) : null };
      await new Promise((res) => setTimeout(res, 5));
    }
    throw new Error("login did not end");
  };
  const pass = (id: string) => {
    const c = app.connections!.store.get(id)!;
    app.connections!.store.setTestResult(id, "passed", "ok", c.credentialVersion);
  };
  const waitRun = async (id: string) => {
    for (let i = 0; i < 1000; i++) {
      const r = app.runs!.get(id)!;
      if (r.endedAt !== null) return r;
      await new Promise((res) => setTimeout(res, 5));
    }
    throw new Error("run did not end");
  };
  const events = (runId: string) => app.runs!.eventsAfter(runId, 0).map((e) => e.data as StreamEvent);
  const send = async (who: ReturnType<typeof as>, text: string, extra: object = {}) => {
    const userId = who === owner ? f.users.owner.id : who === admin ? f.users.admin.id : f.users.stranger.id;
    const conv = app.conversations!.create(userId);
    const r = await who.post(`/api/conversations/${conv.id}/messages`, { text, runtime: "codex", ...extra });
    return r;
  };
  /** No known token in clear anywhere: responses, log, every database value, every file under the data folder. */
  const noPlaintext = () => {
    const dump = JSON.stringify(db.$client.prepare("SELECT * FROM connections").all());
    const files = walkFiles(dataDir).map((p) => fs.readFileSync(p).toString("latin1"));
    const where = { bodies: bodies.join("\n"), log: log.text(), db: dump, files: files.join("\n") };
    for (const m of [...MARKERS, T.code.replace("-", "")])
      for (const [k, v] of Object.entries(where)) expect(v.includes(m), `${m} in ${k}`).toBe(false);
    // The one-time code is only in the start and poll responses while pending — never in the log.
    expect(log.text().includes(T.code)).toBe(false);
    expect(log.text().includes(EMAIL)).toBe(false);
  };
  return {
    app,
    db,
    f,
    log,
    bodies,
    owner,
    admin,
    stranger,
    login,
    until,
    pass,
    send,
    waitRun,
    events,
    device,
    loginLog,
    runLog,
    posts,
    setTokenAnswer: (a: { status: number; body: string }) => (tokenAnswer = a),
    dataDir,
    noPlaintext,
  };
}

describe("Codex ChatGPT device-code login (#18, PRD D2 / FR-11.2)", () => {
  it("shows the code and OpenAI's link, waits, then stores the tokens encrypted — only the email is shown", async () => {
    const t = await start();
    const l = await t.login();
    expect(l).toMatchObject({
      runtime: "codex",
      status: "pending",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: T.code,
      connectionId: null,
    });
    expect(l.expiresAt).toBeGreaterThan(Date.now());
    const { login, connection } = await t.until(l.id);
    expect(login).toMatchObject({ status: "completed", userCode: null, verificationUrl: null, code: null });
    expect(connection).toMatchObject({
      id: login.connectionId,
      runtime: "codex",
      authType: "subscription",
      scope: "personal",
      ownerId: t.f.users.owner.id,
      accountEmail: EMAIL,
      hint: null,
      status: "untested",
      registeredByAdmin: false,
    });
    // The login process: sandboxed in its own folder, the internet only through the proxy, a file store for the
    // tokens (read and removed at once). The folder is gone afterwards; nothing of it is left anywhere.
    const s = t.loginLog.spawns[0]!;
    expect(s.args).toEqual(["app-server", "--strict-config", "--listen", "stdio://"]);
    expect(s.network).toEqual({ loopbackPorts: [] });
    const loginDir = path.dirname(s.env.CODEX_HOME!);
    expect(loginDir.startsWith(path.join(t.dataDir, "runtimes", "logins"))).toBe(true);
    expect(s.write.every((w) => w.startsWith(loginDir))).toBe(true);
    expect(fs.existsSync(loginDir)).toBe(false);
    expect(t.loginLog.requests.map((r) => r.method)).toEqual([
      "initialize",
      "account/login/start",
      "account/read",
    ]);
    expect(t.loginLog.requests[1]!.params).toEqual({ type: "chatgptDeviceCode" });
    // The tokens file was gone before the server asked anything else of the process.
    expect(t.loginLog.authJsonAtRead).toBe(false);
    expect(walkFiles(t.dataDir).filter((p) => p.endsWith("auth.json"))).toEqual([]);
    // Stored encrypted: the row holds neither token nor email-bearing id token in clear.
    const row = t.db.select().from(connections).where(eq(connections.id, connection!.id)).get()!;
    expect(row.secret).toMatch(/^v1:/);
    const cred = t.app.connections!.store.subscriptionCredential(connection!.id)!;
    expect(parseCredential(cred.secret)).toMatchObject({
      accessToken: T.access1,
      refreshToken: T.refresh1,
      accountId: "acct-fam-1",
      planType: "plus",
    });
    t.noPlaintext();
  });

  it("is the caller's own: others get 404 for it, and the connection never reaches their picker (403 by id)", async () => {
    const t = await start();
    const l = await t.login();
    expect((await t.stranger.get(`/api/connections/logins/${l.id}`)).statusCode).toBe(404);
    expect((await t.admin.del(`/api/connections/logins/${l.id}`)).statusCode).toBe(404);
    const { connection } = await t.until(l.id);
    t.pass(connection!.id);
    const picker = async (who: typeof t.owner) =>
      RuntimeOption.array()
        .parse((await who.get("/api/runtimes")).json<{ items: unknown[] }>().items)
        .find((x) => x.runtime === "codex")!;
    expect((await picker(t.owner)).connections.map((c) => c.id)).toEqual([connection!.id]);
    expect((await picker(t.stranger)).connections).toEqual([]);
    expect((await picker(t.admin)).connections).toEqual([]);
    // Used by id over the API: 403, for a member and for the admin alike.
    for (const who of [t.stranger, t.admin]) {
      const r = await t.send(who, "hi", { connectionId: connection!.id });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual({ error: "connection_not_allowed" });
    }
    for (const r of [
      await t.stranger.get(`/api/connections/${connection!.id}`),
      await t.stranger.post(`/api/connections/${connection!.id}/test`),
      await t.stranger.del(`/api/connections/${connection!.id}`),
    ])
      expect(r.statusCode).toBe(403);
    // Logging in again on someone else's connection: not there for them.
    expect(
      (await t.stranger.post("/api/connections/logins", { runtime: "codex", connectionId: connection!.id }))
        .statusCode,
    ).toBe(404);
  });

  it("a timeout, a cancel and an expired code store nothing and leave no folder", async () => {
    const t = await start({ timeoutMs: 60 });
    t.device.script = { userCode: T.code, outcome: "never" };
    const timedOut = await t.until((await t.login()).id);
    expect(timedOut.login).toMatchObject({
      status: "timeout",
      code: "timeout",
      userCode: null,
      connectionId: null,
    });
    expect(t.loginLog.requests.map((r) => r.method)).toContain("account/login/cancel");

    const t2 = await start({ timeoutMs: 5000 });
    t2.device.script = { userCode: T.code, outcome: "never" };
    const l = await t2.login();
    const cancelled = await t2.owner.del(`/api/connections/logins/${l.id}`);
    expect(cancelled.statusCode).toBe(200);
    expect(SubscriptionLogin.parse(cancelled.json<{ login: unknown }>().login)).toMatchObject({
      status: "cancelled",
      code: "cancelled",
    });
    expect(t2.loginLog.requests.at(-1)).toEqual({
      method: "account/login/cancel",
      params: { loginId: expect.any(String) },
    });

    t2.device.script = { userCode: T.code, outcome: { success: false, error: "device code expired" } };
    expect((await t2.until((await t2.login()).id)).login).toMatchObject({
      status: "failed",
      code: "login_expired",
    });
    t2.device.script = { userCode: T.code, outcome: { success: false, error: "access denied" } };
    expect((await t2.until((await t2.login()).id)).login).toMatchObject({
      status: "failed",
      code: "login_failed",
    });
    // A "success" without tokens on disk is not a login.
    t2.device.script = { userCode: T.code, outcome: { success: true, authJson: { tokens: null } } };
    expect((await t2.until((await t2.login()).id)).login).toMatchObject({
      status: "failed",
      code: "login_error",
    });

    for (const x of [t, t2]) {
      expect(x.app.connections!.store.personal(x.f.users.owner.id)).toEqual([]);
      expect(walkFiles(path.join(x.dataDir, "runtimes"))).toEqual([]);
      x.noPlaintext();
    }
    // The log has the outcome codes, never the code or the link.
    expect(t2.log.text()).toMatch(/"loginCode":"cancelled"/);
    expect(t2.log.text()).toMatch(/"loginCode":"login_expired"/);
  });

  it("only OpenAI's own sign-in page and a plain code are ever shown (anything else: 409, nothing left)", async () => {
    const t = await start();
    t.device.script = { ...success(), verificationUrl: "https://evil.example/codex/device" };
    const r = await t.owner.post("/api/connections/logins", { runtime: "codex" });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: "login_unavailable" });
    // Exactly the pinned page and code shape: no other path, query or fragment; no other code shape.
    for (const verificationUrl of [
      "https://auth.openai.com/authorize?redirect_uri=https://evil.example",
      "https://auth.openai.com/codex/device?x=1",
      "https://auth.openai.com/codex/device#x",
      "https://auth.openai.com/codex/device/",
      "https://auth.openai.com/codex/devicex",
      "http://auth.openai.com/codex/device",
      "https://auth.openai.com.evil.example/codex/device",
    ]) {
      t.device.script = { ...success(), verificationUrl };
      expect(
        (await t.owner.post("/api/connections/logins", { runtime: "codex" })).statusCode,
        verificationUrl,
      ).toBe(409);
    }
    for (const userCode of [
      "<script>",
      "----",
      "ABCD-1234",
      "ABCD-123456",
      "abcd-12345",
      "ABCD12345",
      " ABCD-12345",
    ]) {
      t.device.script = { ...success(), userCode };
      expect((await t.owner.post("/api/connections/logins", { runtime: "codex" })).statusCode, userCode).toBe(
        409,
      );
    }

    expect(walkFiles(path.join(t.dataDir, "runtimes"))).toEqual([]);
    expect(r.body.includes("evil.example")).toBe(false);
    t.device.script = { ...success(), userCode: "AB1C-2D3E4" };
    expect((await t.owner.post("/api/connections/logins", { runtime: "codex" })).statusCode).toBe(201);
  });

  it("one login per user at a time: a new one cancels the one still waiting", async () => {
    const t = await start();
    t.device.script = { userCode: T.code, outcome: "never" };
    const first = await t.login();
    const second = await t.login();
    expect((await t.until(first.id)).login.status).toBe("cancelled");
    expect((await t.owner.get(`/api/connections/logins/${second.id}`)).json()).toMatchObject({
      login: { status: "pending" },
    });
    await t.owner.del(`/api/connections/logins/${second.id}`);
  });

  it("the policy decides: a member without Codex or without personal connections cannot start one", async () => {
    const t = await start();
    t.app.connections!.store.setPolicy(t.f.users.owner.id, {
      runtime: "codex",
      allowed: true,
      models: "all",
      efforts: "all",
      allowPersonal: false,
      allowShared: true,
    });
    const r = await t.owner.post("/api/connections/logins", { runtime: "codex" });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: "connection_not_allowed" });
    expect(t.loginLog.spawns).toEqual([]);
    // Claude has no device login; pasting a ChatGPT login is refused.
    expect((await t.owner.post("/api/connections/logins", { runtime: "claude-code" })).statusCode).toBe(400);
  });

  it("logging in again replaces the credential (new base version, tested again); disconnecting wipes it", async () => {
    const t = await start();
    const first = await t.until((await t.login()).id);
    const id = first.connection!.id;
    t.pass(id);
    t.device.script = success(T.access3, T.refresh3);
    const again = await t.until((await t.login(t.owner, { runtime: "codex", connectionId: id })).id);
    expect(again.login).toMatchObject({ status: "completed", connectionId: id });
    expect(again.connection).toMatchObject({ id, status: "untested", accountEmail: EMAIL });
    const row = t.app.connections!.store.get(id)!;
    expect(row).toMatchObject({ credentialVersion: 2, credentialBaseVersion: 2 });
    expect(parseCredential(t.app.connections!.store.subscriptionCredential(id)!.secret)).toMatchObject({
      accessToken: T.access3,
      refreshToken: T.refresh3,
    });
    // The re-login ran inside the connection's own folder, which it left clean.
    const dir = path.dirname(t.loginLog.spawns[1]!.env.CODEX_HOME!);
    expect(dir.startsWith(path.join(t.dataDir, "runtimes", id))).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect((await t.owner.del(`/api/connections/${id}`)).statusCode).toBe(200);
    expect(t.app.connections!.store.get(id)).toMatchObject({ secret: null });
    expect(fs.existsSync(path.join(t.dataDir, "runtimes", id))).toBe(false);
    t.noPlaintext();
  });
});

describe("runs on a ChatGPT login (#18)", () => {
  it("the access token goes over stdin as chatgptAuthTokens (memory only); the refresh token never reaches the process", async () => {
    const t = await start();
    const { connection } = await t.until((await t.login()).id);
    t.pass(connection!.id);
    const r = await t.send(t.owner, "hi");
    expect(r.statusCode).toBe(201);
    const run = r.json<{ run: Run }>().run;
    expect((await t.waitRun(run.id)).status).toBe("done");
    const init = t.runLog.requests.find((x) => x.method === "initialize")!;
    expect(init.params.capabilities).toEqual({ experimentalApi: true, requestAttestation: false });
    expect(t.runLog.requests.find((x) => x.method === "account/login/start")!.params).toEqual({
      type: "chatgptAuthTokens",
      accessToken: T.access1,
      chatgptAccountId: "acct-fam-1",
      chatgptPlanType: "plus",
    });
    const s = t.runLog.spawns[0]!;
    const everything = JSON.stringify({ env: s.env, args: s.args });
    for (const m of MARKERS) expect(everything.includes(m)).toBe(false);
    const toml = fs.readFileSync(path.join(s.env.CODEX_HOME!, "config.toml"), "utf8");
    expect(toml).toContain('cli_auth_credentials_store = "ephemeral"');
    // Subscription usage: tokens, no cost (PRD FR-9.2).
    expect(t.db.select().from(usageRecords).all()).toEqual([
      expect.objectContaining({
        runId: run.id,
        runtime: "codex",
        connectionId: connection!.id,
        inputTokens: 100,
        outputTokens: 7,
        costUsd: null,
      }),
    ]);
    t.noPlaintext();
  });

  it("app-server asks for new tokens: the server refreshes them, stores them encrypted under a new version, the run goes on", async () => {
    const t = await start({
      recording: {
        hi: [
          cx.error({ responseStreamDisconnected: { httpStatusCode: 401 } }, true),
          { $refresh: true },
          ...cx.answer("ok").messages,
        ],
      },
    });
    const { connection } = await t.until((await t.login()).id);
    const id = connection!.id;
    t.pass(id);
    const run = (await t.send(t.owner, "hi")).json<{ run: Run }>().run;
    expect((await t.waitRun(run.id)).status).toBe("done");
    // One POST to OpenAI's token endpoint with Codex's client id and the stored refresh token.
    expect(t.posts).toEqual([
      {
        url: CHATGPT_TOKEN_URL,
        body: {
          client_id: CODEX_OAUTH_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: T.refresh1,
          scope: "openid profile email",
        },
      },
    ]);
    // app-server got the new access token — never a refresh token.
    expect(t.runLog.answers).toEqual([
      {
        id: expect.any(String),
        result: { accessToken: T.access2, chatgptAccountId: "acct-fam-1", chatgptPlanType: "plus" },
      },
    ]);
    const row = t.app.connections!.store.get(id)!;
    expect(row).toMatchObject({ credentialVersion: 2, credentialBaseVersion: 1, status: "passed" });
    expect(parseCredential(t.app.connections!.store.subscriptionCredential(id)!.secret)).toMatchObject({
      accessToken: T.access2,
      refreshToken: T.refresh2,
    });
    // A run accepted before the refresh (bound to version 1) still uses this login.
    expect(
      t.app.connections!.store.resolve(id, t.app.users!.byId(t.f.users.owner.id), "codex", { version: 1 }),
    ).toMatchObject({ id, version: 2 });
    expect(t.log.text()).toMatch(/"msg":"connection.refreshed"/);
    t.noPlaintext();
  });

  it("a refused refresh ends the turn as runtime_auth: expired, with the re-login guidance and a switch hint", async () => {
    const t = await start({
      recording: {
        hi: [
          cx.error({ responseStreamDisconnected: { httpStatusCode: 401 } }, true),
          { $refresh: true },
          cx.delta("never"),
        ],
      },
    });
    t.setTokenAnswer({ status: 401, body: JSON.stringify({ error: { code: "refresh_token_expired" } }) });
    const { connection } = await t.until((await t.login()).id);
    t.pass(connection!.id);
    const run = (await t.send(t.owner, "hi")).json<{ run: Run }>().run;
    expect(await t.waitRun(run.id)).toMatchObject({ status: "failed", errorCode: "runtime_auth" });
    expect(t.app.connections!.store.get(connection!.id)).toMatchObject({ status: "expired" });
    const notice = t.events(run.id).find((e) => e.type === "notice" && e.code === SUBSCRIPTION_EXPIRED_CODE);
    expect(notice).toMatchObject({
      level: "warn",
      message: expect.stringContaining("ChatGPT 로그인이 만료됐어요"),
      switchTo: ["claude-code"],
    });
    expect(t.runLog.answers).toEqual([{ id: expect.any(String), error: expect.any(Object) }]);
    // Expired: not in the picker any more; logging in again brings it back (after its test).
    const items = RuntimeOption.array().parse(
      (await t.owner.get("/api/runtimes")).json<{ items: unknown[] }>().items,
    );
    expect(items.find((x) => x.runtime === "codex")!.connections).toEqual([]);
    expect(t.log.text()).toMatch(/"errorCode":"runtime_auth","msg":"connection.refresh_failed"/);
    t.noPlaintext();
  });

  it("a session that keeps asking for new tokens is cut off after a few refreshes (runtime_auth)", async () => {
    const t = await start({
      recording: {
        hi: [{ $refresh: true }, { $refresh: true }, { $refresh: true }, { $refresh: true }, cx.delta("x")],
      },
    });
    const { connection } = await t.until((await t.login()).id);
    t.pass(connection!.id);
    const run = (await t.send(t.owner, "hi")).json<{ run: Run }>().run;
    expect(await t.waitRun(run.id)).toMatchObject({ status: "failed", errorCode: "runtime_auth" });
    expect(t.posts).toHaveLength(3);
    expect(t.runLog.answers.map((a) => (a.result ? "ok" : "refused"))).toEqual(["ok", "ok", "ok", "refused"]);
  });

  it("a subscription limit: the notice says this runtime is at its limit and offers another runtime", async () => {
    const t = await start({
      recording: { hi: [cx.error("usageLimitExceeded"), cx.completed("failed", "usageLimitExceeded")] },
    });
    const { connection } = await t.until((await t.login()).id);
    t.pass(connection!.id);
    const run = (await t.send(t.owner, "hi")).json<{ run: Run }>().run;
    expect(await t.waitRun(run.id)).toMatchObject({ status: "failed", errorCode: "usage_limit" });
    const notice = t.events(run.id).find((e) => e.type === "notice" && e.code === SUBSCRIPTION_LIMIT_CODE);
    expect(notice).toMatchObject({
      level: "warn",
      message: expect.stringContaining(SUBSCRIPTION_LIMIT_MESSAGE),
      switchTo: ["claude-code"],
    });
    expect(SUBSCRIPTION_LIMIT_MESSAGE).toBe("지금 이 런타임은 한도에 걸렸어요");
    // A limit is not an expiry: the connection stays usable.
    expect(t.app.connections!.store.get(connection!.id)!.status).toBe("passed");
  });
});

describe("Claude subscription (#18: admin only, CLAUDE_CODE_OAUTH_TOKEN)", () => {
  it("a member — or the admin on a member's behalf — gets 403; the admin's own token is stored masked", async () => {
    const t = await start();
    const token = `sk-ant-oat01-FAKECLAUDESUB${"q".repeat(30)}`;
    const body = { runtime: "claude-code", authType: "subscription", secret: token };
    for (const r of [
      await t.owner.post("/api/connections", body),
      await t.admin.post(`/api/admin/users/${t.f.users.owner.id}/connections`, body),
    ]) {
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual({ error: "subscription_not_allowed" });
    }
    // An API key pasted as a subscription is not a subscription.
    const apiKey = await t.admin.post("/api/connections", {
      ...body,
      secret: `sk-ant-api03-FAKEAPIKEY${"k".repeat(30)}`,
    });
    expect(apiKey.json()).toEqual({ error: "invalid_secret" });
    const own = await t.admin.post("/api/connections", body);
    expect(own.statusCode).toBe(201);
    expect(Connection.parse(own.json<{ connection: unknown }>().connection)).toMatchObject({
      authType: "subscription",
      ownerId: t.f.users.admin.id,
      hint: `••••${token.slice(-4)}`,
      accountEmail: null,
    });
    expect(t.bodies.join("").includes("FAKECLAUDESUB")).toBe(false);
    expect(t.log.text().includes("FAKECLAUDESUB")).toBe(false);
  });
});

describe("ChatGPT credentials (#18)", () => {
  it("reads the file store's auth.json; incomplete ones are not a login", () => {
    expect(credentialFromAuthJson(JSON.stringify(authJson()))).toEqual({
      v: 1,
      accessToken: T.access1,
      refreshToken: T.refresh1,
      idToken: T.id1,
      accountId: "acct-fam-1",
      planType: "plus",
    });
    expect(credentialFromAuthJson(JSON.stringify({ tokens: { access_token: T.access1 } }))).toBeUndefined();
    expect(credentialFromAuthJson("not json")).toBeUndefined();
    // The account id comes from the token's claims when the file has none.
    const noId = authJson();
    delete (noId.tokens as Partial<typeof noId.tokens>).account_id;
    expect(credentialFromAuthJson(JSON.stringify(noId))?.accountId).toBe("acct-fam-1");
  });

  it("refreshes once for sessions asking together, and never after the login was replaced", async () => {
    const t = await start();
    const { connection } = await t.until((await t.login()).id);
    const id = connection!.id;
    const svc = new ChatgptTokenService(t.app.connections!.store, {
      post: async () => ({
        status: 200,
        body: JSON.stringify({ access_token: T.access2, refresh_token: T.refresh2 }),
      }),
    });
    const [a, b] = await Promise.all([svc.refresh(id, 1), svc.refresh(id, 1)]);
    expect(a).toMatchObject({ accessToken: T.access2, version: 2 });
    expect(b).toMatchObject({ accessToken: T.access2, version: 2 });
    expect(t.app.connections!.store.get(id)!.credentialVersion).toBe(2);
    // A new login (base 3): a session of the old login cannot refresh any more.
    t.app.connections!.store.replaceLogin(
      id,
      t.app.connections!.store.subscriptionCredential(id)!.secret,
      EMAIL,
    );
    await expect(svc.refresh(id, 2)).rejects.toMatchObject({ code: "runtime_auth" });
    // A transient failure is not an expiry.
    const flaky = new ChatgptTokenService(t.app.connections!.store, {
      post: async () => ({ status: 503, body: "" }),
    });
    await expect(flaky.refresh(id, 3)).rejects.toMatchObject({ code: "runtime_error" });
  });

  it("the egress lists: runs reach chatgpt.com only, the login process auth.openai.com and chatgpt.com", () => {
    expect([...CODEX_CHATGPT_EGRESS_HOSTS]).toEqual(["chatgpt.com"]);
    expect([...CODEX_LOGIN_EGRESS_HOSTS]).toEqual(["auth.openai.com", "chatgpt.com"]);
  });

  it("the refresh POST goes through safeFetch: the address policy applies, the body is sent, no redirect is followed", async () => {
    // A name that resolves to a private address is refused before anything is sent.
    await expect(
      safeFetch(CHATGPT_TOKEN_URL, { body: "{}", resolve: async () => ["10.0.0.5"] }),
    ).rejects.toBeInstanceOf(BlockedRequestError);
    await expect(safeFetch("http://127.0.0.1:9/oauth/token", { body: "{}" })).rejects.toBeInstanceOf(
      BlockedRequestError,
    );
    // Allowed (test override): a POST with the JSON body; a redirect answer is returned, not followed.
    const seen: { method?: string; body: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        seen.push({ method: req.method, body });
        res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" }).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port;
      const r = await safeFetch(`http://127.0.0.1:${port}/oauth/token`, {
        body: '{"grant_type":"refresh_token"}',
        allow: () => true,
      });
      expect(r.status).toBe(302);
      expect(seen).toEqual([{ method: "POST", body: '{"grant_type":"refresh_token"}' }]);
    } finally {
      server.close();
    }
  });

  it("subscription usage follows the usage store's rule: one row per attempt, the last report wins, no cost", () => {
    const db = createTestDb();
    const usage = new UsageStore(db);
    db.$client.exec(
      "INSERT INTO users (id, email, name, role, password_hash, created_at, updated_at) VALUES ('u1','u1@x','u','member','h',0,0)",
    );
    const a = {
      userId: "u1",
      conversationId: "c1",
      runId: "r1",
      attempt: 1,
      runtime: "codex",
      model: "gpt-6.1-sol",
      connectionId: "conn",
      purpose: "chat" as const,
    };
    usage.record(a, { inputTokens: 10, outputTokens: 1 });
    usage.record(a, { inputTokens: 100, outputTokens: 7 });
    expect(usage.forRun("r1")).toEqual([
      expect.objectContaining({ attempt: 1, inputTokens: 100, outputTokens: 7, costUsd: null }),
    ]);
  });
});

describe("subscription login — review #91 round 1", () => {
  it("a server that died mid-login: the next start removes every left-over login folder and kills its process", async () => {
    const dataDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "agentlee-sub-"));
    // Left behind: a new-login folder with the tokens file and a still running "login process", a re-login
    // folder inside a connection folder, and things that must stay (a session folder, a symbolic link).
    const orphan = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    const bystander = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    closers.push(async () => {
      for (const c of [orphan, bystander])
        try {
          process.kill(c.pid!, "SIGKILL");
        } catch {
          // gone
        }
    });
    const left = (dir: string, pid: number) => {
      fs.mkdirSync(path.join(dir, "codex-home"), { recursive: true });
      fs.writeFileSync(path.join(dir, "codex-home", "auth.json"), JSON.stringify(authJson()));
      fs.writeFileSync(path.join(dir, "login.pid"), String(pid));
    };
    const fresh = path.join(dataDir, "runtimes", "logins", "login-0199aaaa-1111");
    const again = path.join(dataDir, "runtimes", "conn-1", "login-0199aaaa-2222");
    left(fresh, orphan.pid!);
    left(again, bystander.pid!);
    const session = path.join(dataDir, "runtimes", "conn-1", "user-1", "codex-home");
    fs.mkdirSync(session, { recursive: true });
    fs.writeFileSync(path.join(session, "state"), "keep");
    const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "agentlee-outside-"));
    closers.push(async () => fs.rmSync(outside, { recursive: true, force: true }));
    fs.writeFileSync(path.join(outside, "keep"), "keep");
    fs.symlinkSync(outside, path.join(dataDir, "runtimes", "conn-1", "login-0199aaaa-3333"));
    const exited = new Promise<void>((r) => orphan.once("exit", () => r()));

    const t = await start({ dataDir, isLoginProcess: (pid) => pid === orphan.pid });
    await exited; // the left-over login process was killed
    expect(fs.existsSync(fresh)).toBe(false);
    expect(fs.existsSync(again)).toBe(false);
    expect(walkFiles(path.join(dataDir, "runtimes")).filter((p) => p.endsWith("auth.json"))).toEqual([]);
    expect(fs.readFileSync(path.join(session, "state"), "utf8")).toBe("keep");
    expect(fs.readFileSync(path.join(outside, "keep"), "utf8")).toBe("keep"); // a link is never followed
    expect(() => process.kill(bystander.pid!, 0)).not.toThrow(); // not a login process: left alone
    t.noPlaintext();

    // A new login's folders are the owner's only.
    t.device.script = { userCode: T.code, outcome: "never" };
    const l = await t.login();
    const s = t.loginLog.spawns[0]!;
    const loginDir = path.dirname(s.env.CODEX_HOME!);
    for (const d of [path.join(dataDir, "runtimes", "logins"), loginDir, s.env.CODEX_HOME!])
      expect(fs.statSync(d).mode & 0o077, d).toBe(0);
    expect(fs.statSync(path.join(s.env.CODEX_HOME!, "config.toml")).mode & 0o077).toBe(0);
    await t.owner.del(`/api/connections/logins/${l.id}`);
  });

  it("concurrent starts cannot get past the limits: one per user, the global limit, slots given back on failure", async () => {
    let running = 0;
    let most = 0;
    let fail = false;
    const slow = (d: DeviceLoginProvider): DeviceLoginProvider => ({
      start: async (dir) => {
        running++;
        most = Math.max(most, running);
        try {
          await new Promise((r) => setTimeout(r, 30));
          if (fail) throw new LoginEnded("login_error");
          return await d.start(dir);
        } finally {
          running--;
        }
      },
    });
    const t = await start({ wrapDevice: slow, maxActiveLogins: 2 });
    t.device.script = { userCode: T.code, outcome: "never" };
    // Six at once from one user: started one after another, and only the last one is still waiting.
    const six = await Promise.all(
      Array.from({ length: 6 }, () => t.owner.post("/api/connections/logins", { runtime: "codex" })),
    );
    expect(six.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201, 201]);
    expect(most).toBe(1);
    const ids = six.map((r) => SubscriptionLogin.parse(r.json<{ login: unknown }>().login).id);
    const states = await Promise.all(
      ids.map(
        async (id) =>
          SubscriptionLogin.parse(
            (await t.owner.get(`/api/connections/logins/${id}`)).json<{ login: unknown }>().login,
          ).status,
      ),
    );
    for (let i = 0; i < 20 && states.filter((x) => x === "pending").length > 1; i++)
      await new Promise((r) => setTimeout(r, 20));
    const final = await Promise.all(
      ids.map(
        async (id) =>
          SubscriptionLogin.parse(
            (await t.owner.get(`/api/connections/logins/${id}`)).json<{ login: unknown }>().login,
          ).status,
      ),
    );
    expect(final.filter((x) => x === "pending")).toHaveLength(1);
    expect(final.at(-1)).toBe("pending");
    // Three users at once against a global limit of 2 (the owner's one is still waiting): one more gets in.
    const others = await Promise.all([
      t.stranger.post("/api/connections/logins", { runtime: "codex" }),
      t.admin.post("/api/connections/logins", { runtime: "codex" }),
    ]);
    expect(others.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(others.find((r) => r.statusCode === 409)!.json()).toEqual({ error: "login_busy" });
    // A start that fails gives its slot back: after the owner's failed start, the user who was turned away gets in.
    await t.owner.del(`/api/connections/logins/${ids.at(-1)}`);
    fail = true;
    const failed = await t.owner.post("/api/connections/logins", { runtime: "codex" });
    expect(failed.statusCode).toBe(409);
    expect(failed.json()).toEqual({ error: "login_unavailable" });
    fail = false;
    const turnedAway = others[0]!.statusCode === 409 ? t.stranger : t.admin;
    expect((await turnedAway.post("/api/connections/logins", { runtime: "codex" })).statusCode).toBe(201);
  });

  it("a cancel while the account is being read wins: nothing is handed out, nothing stored", async () => {
    // The login process itself: the result is "cancelled", not a credential.
    const log = newLog();
    const dir = path.join(
      fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "agentlee-sub-")),
      "login-x",
    );
    closers.push(async () => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
    let cancel: () => void = () => {};
    const device = new CodexDeviceLogin({
      executable: "/nonexistent/codex",
      spawn: (s) =>
        replaySpawn({}, log, {
          deviceLogin: { ...success(), onAccountRead: () => cancel(), readDelayMs: 30 },
        })(s),
    });
    const login = await device.start(dir);
    cancel = login.cancel;
    await expect(login.result).rejects.toMatchObject({ code: "cancelled" });
    expect(fs.existsSync(dir)).toBe(false);

    // Through the service and API: the user's cancel at that stage leaves no connection.
    const t = await start();
    let loginId = "";
    t.device.script = {
      ...success(),
      onAccountRead: () => void t.owner.del(`/api/connections/logins/${loginId}`),
      readDelayMs: 30,
    };
    loginId = (await t.login()).id;
    expect((await t.until(loginId)).login).toMatchObject({ status: "cancelled", connectionId: null });
    expect(t.app.connections!.store.personal(t.f.users.owner.id)).toEqual([]);

    // And when the process hands a credential out regardless, the service still does not store it.
    const t2 = await start({
      wrapDevice: (d) => ({
        start: async (dir2) => {
          const l = await d.start(dir2);
          return { ...l, cancel: () => {} }; // a process that ignores the cancel
        },
      }),
    });
    let id2 = "";
    t2.device.script = {
      ...success(),
      onAccountRead: () => void t2.owner.del(`/api/connections/logins/${id2}`),
      readDelayMs: 30,
    };
    id2 = (await t2.login()).id;
    expect((await t2.until(id2)).login).toMatchObject({ status: "cancelled" });
    expect(t2.app.connections!.store.personal(t2.f.users.owner.id)).toEqual([]);
  });

  it("a malformed refresh answer is a passing failure: runtime_error, the login stays as it was", async () => {
    const recording: Recording = {
      hi: [
        cx.error({ responseStreamDisconnected: { httpStatusCode: 401 } }, true),
        { $refresh: true },
        cx.completed("failed", { responseStreamDisconnected: { httpStatusCode: 401 } }),
      ],
    };
    for (const body of [
      "null",
      "[]",
      '"x"',
      JSON.stringify({ access_token: 5 }),
      JSON.stringify({ access_token: T.access2, refresh_token: 123 }),
      JSON.stringify({ access_token: T.access2, refresh_token: "" }),
      JSON.stringify({ access_token: T.access2, id_token: {} }),
      "{not json",
    ]) {
      const t = await start({ recording });
      t.setTokenAnswer({ status: 200, body });
      const { connection } = await t.until((await t.login()).id);
      t.pass(connection!.id);
      const run = (await t.send(t.owner, "hi")).json<{ run: Run }>().run;
      expect(await t.waitRun(run.id), body).toMatchObject({ status: "failed", errorCode: "runtime_error" });
      expect(t.app.connections!.store.get(connection!.id), body).toMatchObject({
        status: "passed",
        credentialVersion: 1,
      });
      expect(
        parseCredential(t.app.connections!.store.subscriptionCredential(connection!.id)!.secret),
      ).toMatchObject({ accessToken: T.access1, refreshToken: T.refresh1 });
    }
  });

  it("refresh answers: a left-out (or null) refresh token keeps the stored one; a present but invalid one is refused", async () => {
    const post =
      (body: string): TokenPost =>
      async () => ({ status: 200, body });
    await expect(
      refreshChatgptTokens(T.refresh1, post(JSON.stringify({ access_token: T.access2 }))),
    ).resolves.toEqual({
      accessToken: T.access2,
      refreshToken: null,
      idToken: null,
    });
    await expect(
      refreshChatgptTokens(
        T.refresh1,
        post(JSON.stringify({ access_token: T.access2, refresh_token: null })),
      ),
    ).resolves.toMatchObject({ refreshToken: null });
    await expect(
      refreshChatgptTokens(
        T.refresh1,
        post(JSON.stringify({ access_token: T.access2, refresh_token: T.refresh2 })),
      ),
    ).resolves.toMatchObject({ refreshToken: T.refresh2 });
    for (const body of [
      "null",
      JSON.stringify({ access_token: T.access2, refresh_token: 123 }),
      JSON.stringify({}),
    ])
      await expect(refreshChatgptTokens(T.refresh1, post(body)), body).rejects.toMatchObject({
        code: "runtime_error",
      });
    await expect(
      refreshChatgptTokens(T.refresh1, async () => ({ status: 401, body: "{}" })),
    ).rejects.toMatchObject({
      code: "runtime_auth",
    });
  });
});
