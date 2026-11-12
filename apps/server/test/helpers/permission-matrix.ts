import crypto from "node:crypto";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { CSRF_HEADER } from "@agentlee/shared";
import { hashPassword } from "../../src/auth/passwords.js";
import type { UserRow } from "../../src/auth/users.js";

/**
 * Permission matrix (#10): resource kind × user × action → expected status.
 * Every route declared with `config.resource` in the real app must have a row in `APP_MATRIX`, and every row is
 * executed against the real app (permissions.test.ts), so a resource route cannot ship without its 403/404 table.
 */
export type Who = "owner" | "shared" | "admin" | "stranger" | "anon";
type Member = Exclude<Who, "anon">;

/** Four accounts: owner and shared are members, admin is the admin, stranger is an unrelated member. */
export type Family = {
  app: FastifyInstance;
  users: Record<Member, UserRow>;
  cookies: Record<Member, string>;
};

export type Fixture = string | { id: string; params?: Record<string, string> };

export type MatrixRow = {
  /** `${METHOD} ${route pattern}` exactly as registered, e.g. "GET /api/conversations/:id". */
  route: string;
  /** Status per caller for a resource owned by `owner` and shared (read) with `shared`. */
  expect: Record<Who, number>;
  /**
   * Creates a fresh resource owned by `f.users.owner` and shared with `f.users.shared`; returns its id
   * (and values for other path params, e.g. `{ id, params: { messageId } }`).
   * Called before every single request, so one caller's delete or change never affects the next caller.
   */
  fixture: (f: Family) => Fixture | Promise<Fixture>;
  /** Request body for non-GET routes. */
  body?: unknown;
  /**
   * Error codes to check as well, where the status alone could come from a later check (e.g. a policy 403 after the
   * resource check): a missing ownership check must still fail the row.
   */
  errors?: Partial<Record<Who, string>>;
};

/** Standard expectations. */
export const READ: MatrixRow["expect"] = { owner: 200, shared: 200, admin: 403, stranger: 403, anon: 401 };
export const OWNER_ONLY: MatrixRow["expect"] = {
  owner: 200,
  shared: 403,
  admin: 403,
  stranger: 403,
  anon: 401,
};
export const USAGE: MatrixRow["expect"] = { owner: 200, shared: 403, admin: 200, stranger: 403, anon: 401 };

/** A conversation of `owner` (sharing comes with #29) with one user and one assistant message. */
function conversation(f: Family) {
  const store = f.app.conversations!;
  const c = store.create(f.users.owner.id);
  const user = store.append(c.id, { role: "user", parts: [{ type: "text", text: "질문" }] });
  const reply = store.append(c.id, { role: "assistant", parts: [{ type: "text", text: "답" }] });
  return { id: c.id, params: { userMessageId: user.id, assistantMessageId: reply.id } };
}
const withMessage = (key: "userMessageId" | "assistantMessageId") => (f: Family) => {
  const fx = conversation(f);
  return { id: fx.id, params: { messageId: fx.params[key] } };
};

/**
 * Rows for the real app's resource routes. Add one with each new resource route (#22, #27, ...).
 * Until sharing (#29) exists nothing is shared, so the "shared" caller is refused like a stranger.
 */
const NOT_SHARED = (e: MatrixRow["expect"]): MatrixRow["expect"] => ({ ...e, shared: 403 });
/** A finished run of `owner` (the real app has no runtime in tests, so it fails at once — events stay). */
function run(f: Family) {
  const c = f.app.conversations!.create(f.users.owner.id);
  const r = f.app.runs!.begin({
    conversationId: c.id,
    userId: f.users.owner.id,
    prepare: () => ({
      user: f.app.conversations!.append(c.id, { role: "user", parts: [{ type: "text", text: "q" }] }),
      assistant: f.app.conversations!.append(c.id, { role: "assistant", parts: [], status: "pending" }),
    }),
  });
  return r.run.id;
}

/** An inbox entry of `owner` (#34). */
const notification = (f: Family) => f.app.notifications!.publish(f.users.owner.id, { kind: "test" })!;
/** A push device of `owner`, registered from one of owner's sessions (#34). */
const pushDevice = (f: Family) => {
  const token = f.app.users!.createSession(f.users.owner.id);
  return f.app.notifications!.subscribe(f.users.owner.id, token, {
    endpoint: `https://fcm.googleapis.com/fcm/send/matrix-${Math.random().toString(36).slice(2)}`,
    keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
    label: "matrix",
    sessionTag: f.app.notifications!.sessionTag(token),
  });
};

/** A personal Claude API key connection of `owner` (#17). */
const connection = (f: Family) =>
  f.app.connections!.store.create({
    runtime: "claude-code",
    authType: "api_key",
    scope: "personal",
    owner: f.users.owner,
    createdBy: f.users.owner.id,
    secret: `sk-ant-matrix${"x".repeat(24)}`,
  }).id;

/** An HTML artifact (two versions) in a conversation of `owner`, made as a run of that conversation would. */
function artifact(f: Family) {
  const c = f.app.conversations!.create(f.users.owner.id);
  const scope = { userId: f.users.owner.id, conversationId: c.id, runId: crypto.randomUUID() };
  const store = f.app.artifacts!;
  const { artifact: a } = store.create(scope, { kind: "html", title: "표", content: "<p>v1</p>" });
  store.update(scope, a.id, { content: "<p>v2</p>" });
  return { id: a.id, params: { version: "1" } };
}

/** An uploaded (unsent) text file in a conversation of `owner` (#22), stored the way an upload stores it. */
async function uploaded(f: Family) {
  const c = f.app.conversations!.create(f.users.owner.id);
  const tmp = f.app.files!.tempFile();
  fs.writeFileSync(tmp, "matrix file");
  const row = await f.app.files!.add({
    userId: f.users.owner.id,
    conversationId: c.id,
    uploadId: crypto.randomUUID(),
    name: "메모.txt",
    kind: "txt",
    bytes: 11,
    sha256: crypto.createHash("sha256").update("matrix file").digest("hex"),
    tmp,
  });
  return row.id;
}

export const APP_MATRIX: MatrixRow[] = [
  // Uploads (#22): the uploader only. The matrix sends a JSON body, so the owner's upload reaches the handler and
  // is refused there (400: not `application/octet-stream`); real uploads are in files.test.ts.
  {
    route: "POST /api/conversations/:id/files",
    expect: { ...OWNER_ONLY, owner: 400 },
    fixture: conversation,
  },
  { route: "GET /api/conversations/:id/files", expect: OWNER_ONLY, fixture: conversation },
  { route: "GET /api/files/:id", expect: NOT_SHARED(READ), fixture: uploaded },
  { route: "GET /api/files/:id/content", expect: NOT_SHARED(READ), fixture: uploaded },
  { route: "DELETE /api/files/:id", expect: OWNER_ONLY, fixture: uploaded },
  // Artifacts (#27): owner only until sharing (#29); the page and the originals check the same way.
  { route: "GET /api/conversations/:id/artifacts", expect: OWNER_ONLY, fixture: conversation },
  { route: "GET /api/artifacts/:id", expect: NOT_SHARED(READ), fixture: artifact },
  { route: "GET /api/artifacts/:id/versions/:version", expect: NOT_SHARED(READ), fixture: artifact },
  { route: "POST /api/artifacts/:id/revert", expect: OWNER_ONLY, fixture: artifact, body: { version: 1 } },
  { route: "GET /a/:id", expect: NOT_SHARED(READ), fixture: artifact },
  { route: "GET /a/:id/v/:version/raw", expect: NOT_SHARED(READ), fixture: artifact },
  { route: "GET /a/:id/v/:version/download", expect: NOT_SHARED(READ), fixture: artifact },
  // PNG/PDF export (#51): the same check before anything is rendered (the matrix app has a stand-in renderer).
  { route: "GET /a/:id/v/:version/png", expect: NOT_SHARED(READ), fixture: artifact },
  { route: "GET /a/:id/v/:version/pdf", expect: NOT_SHARED(READ), fixture: artifact },
  { route: "GET /api/connections/:id", expect: OWNER_ONLY, fixture: connection },
  {
    route: "PATCH /api/connections/:id",
    expect: OWNER_ONLY,
    fixture: connection,
    body: { label: "새 이름" },
  },
  { route: "DELETE /api/connections/:id", expect: OWNER_ONLY, fixture: connection },
  // No runtime in the matrix app: the test answers 200 with a failed result.
  { route: "POST /api/connections/:id/test", expect: OWNER_ONLY, fixture: connection },
  { route: "POST /api/notifications/:id/read", expect: OWNER_ONLY, fixture: notification },
  { route: "DELETE /api/push/devices/:id", expect: OWNER_ONLY, fixture: pushDevice },
  { route: "GET /api/runs/:id", expect: NOT_SHARED(READ), fixture: run },
  { route: "GET /api/runs/:id/events", expect: NOT_SHARED(READ), fixture: run },
  { route: "POST /api/runs/:id/interrupt", expect: OWNER_ONLY, fixture: run },
  { route: "GET /api/conversations/:id/active-run", expect: NOT_SHARED(READ), fixture: conversation },
  { route: "GET /api/conversations/:id", expect: NOT_SHARED(READ), fixture: conversation },
  {
    route: "PATCH /api/conversations/:id",
    expect: OWNER_ONLY,
    fixture: conversation,
    body: { title: "새 이름" },
  },
  { route: "DELETE /api/conversations/:id", expect: OWNER_ONLY, fixture: conversation },
  // The chip (#19). No runtime in the matrix app: past the resource check the owner gets the policy's 403
  // (runtime_not_allowed) — everyone else must be stopped before it, by the resource check (`forbidden`). With a
  // usable runtime the same is tested in chat-settings.test.ts ("someone else's conversation").
  {
    route: "PUT /api/conversations/:id/settings",
    expect: { ...OWNER_ONLY, owner: 403 },
    errors: { owner: "runtime_not_allowed", shared: "forbidden", admin: "forbidden", stranger: "forbidden" },
    fixture: conversation,
    body: { runtime: "codex" },
  },
  // The fallback notice (#19): only the owner takes it.
  { route: "POST /api/conversations/:id/fallback-notice/consume", expect: OWNER_ONLY, fixture: conversation },
  { route: "GET /api/conversations/:id/messages", expect: NOT_SHARED(READ), fixture: conversation },
  // Owner only even once sharing exists (#50): a shared view gets its frozen sources, not this list (#29).
  { route: "GET /api/conversations/:id/sources", expect: OWNER_ONLY, fixture: conversation },
  {
    route: "POST /api/conversations/:id/messages",
    expect: { ...OWNER_ONLY, owner: 201 },
    fixture: conversation,
    body: { text: "안녕" },
  },
  {
    route: "POST /api/conversations/:id/messages/:messageId/edit",
    expect: OWNER_ONLY,
    fixture: withMessage("userMessageId"),
    body: { text: "고친 질문" },
  },
  {
    route: "POST /api/conversations/:id/messages/:messageId/regenerate",
    expect: OWNER_ONLY,
    fixture: withMessage("assistantMessageId"),
  },
  {
    route: "GET /api/conversations/:id/messages/:messageId/versions",
    expect: NOT_SHARED(READ),
    fixture: withMessage("userMessageId"),
  },
];

/** A daily schedule of `owner` (#33): the store directly (the matrix app has no runtime to pick defaults from). */
function schedule(f: Family) {
  return f.app.schedules!.store.create(
    f.users.owner.id,
    {
      name: "아침 브리핑",
      prompt: "관심 종목 정리",
      timing: { type: "daily", time: "08:00" },
      timeZone: "Asia/Seoul",
      skills: [],
      notify: true,
      settings: { runtime: "claude-code", model: "claude-opus-5-5", effort: null, useShared: false },
    },
    Date.now(),
  ).id;
}

/** Schedules (#33): the prompt is the owner's content — owner only, the admin refused like anyone else. */
APP_MATRIX.push(
  { route: "GET /api/schedules/:id", expect: OWNER_ONLY, fixture: schedule },
  { route: "GET /api/schedules/:id/runs", expect: OWNER_ONLY, fixture: schedule },
  { route: "PATCH /api/schedules/:id", expect: OWNER_ONLY, fixture: schedule, body: { paused: true } },
  { route: "DELETE /api/schedules/:id", expect: { ...OWNER_ONLY, owner: 204 }, fixture: schedule },
  { route: "POST /api/schedules/:id/run", expect: { ...OWNER_ONLY, owner: 201 }, fixture: schedule },
);

/** A schedule proposed by `schedule_create` in a conversation of `owner` (#55): the store directly. */
function proposal(f: Family) {
  const c = f.app.conversations!.create(f.users.owner.id);
  return f.app.scheduleProposals!.create(
    { userId: f.users.owner.id, conversationId: c.id, runId: "run-1" },
    {
      name: "아침 브리핑",
      prompt: "관심 종목 정리",
      timing: { type: "daily", time: "08:00" },
      timeZone: "Asia/Seoul",
      skills: [],
      notify: true,
    },
    Date.now(),
  ).id;
}

/**
 * Schedule proposals (#55): the card carries the owner's prompt and its confirm makes the owner's schedule — owner
 * only, the admin refused like anyone else. (The matrix app has no runtime: the owner's confirm is 409
 * `no_usable_runtime` there — the error code proves it passed the ownership check; schedule-ui.test.ts makes one.)
 */
APP_MATRIX.push(
  { route: "GET /api/schedule-proposals/:id", expect: OWNER_ONLY, fixture: proposal },
  {
    route: "POST /api/schedule-proposals/:id/confirm",
    expect: { ...OWNER_ONLY, owner: 409 },
    fixture: proposal,
    errors: { owner: "no_usable_runtime", admin: "forbidden", shared: "forbidden", stranger: "forbidden" },
  },
  {
    route: "POST /api/schedule-proposals/:id/dismiss",
    expect: OWNER_ONLY,
    fixture: proposal,
    errors: { admin: "forbidden", shared: "forbidden", stranger: "forbidden" },
  },
);

/** Admin-only data: every member — the son's account included — 403, the admin 200, before login 401. */
export const ADMIN_ONLY: Record<Who, number> = {
  owner: 403,
  shared: 403,
  admin: 200,
  stranger: 403,
  anon: 401,
};

/**
 * Admin-only routes (`config.auth: "admin"`) of the real app. Every admin route is swept for 403/401 without a row
 * (permissions.test.ts); a route listed here is also run as the admin and must succeed. Routes under a prefix in
 * `ADMIN_MATRIX_PREFIXES` must all have a row (#32: usage).
 */
export type AdminRow = { route: string; expect: Record<Who, number>; body?: unknown };
export const ADMIN_MATRIX_PREFIXES = [
  "/api/admin/usage",
  // #35: the admin screen's runtimes, system status and skill allow-list.
  "/api/admin/runtimes",
  "/api/admin/system",
  "/api/admin/skills",
  "/api/admin/errors",
  "/api/admin/connections",
  // #37: backups (list, "지금 백업").
  "/api/admin/backups",
];
/** A route the admin reaches with the matrix's placeholder id: the handler answers 404 (not 403). */
const ADMIN_BY_ID: Record<Who, number> = { ...ADMIN_ONLY, admin: 404 };
export const ADMIN_MATRIX: AdminRow[] = [
  { route: "GET /api/admin/usage", expect: ADMIN_ONLY },
  { route: "GET /api/admin/usage/prices", expect: ADMIN_ONLY },
  {
    route: "PUT /api/admin/usage/prices",
    expect: ADMIN_ONLY,
    body: {
      prices: [
        { runtime: "claude-code", model: "m", input: "1", output: "2", cacheRead: null, cacheWrite: null },
      ],
    },
  },
  { route: "GET /api/admin/usage/settings", expect: ADMIN_ONLY },
  { route: "PUT /api/admin/usage/settings", expect: ADMIN_ONLY, body: { dailyCostThresholdUsd: 5 } },
  // #35
  { route: "GET /api/admin/runtimes", expect: ADMIN_ONLY },
  { route: "GET /api/admin/system", expect: ADMIN_ONLY },
  { route: "GET /api/admin/skills", expect: ADMIN_ONLY },
  { route: "PUT /api/admin/skills/:name", expect: ADMIN_BY_ID, body: { enabled: true } },
  { route: "GET /api/admin/errors", expect: ADMIN_ONLY },
  { route: "GET /api/admin/connections", expect: ADMIN_ONLY },
  {
    route: "POST /api/admin/connections",
    expect: { ...ADMIN_ONLY, admin: 201 },
    body: { runtime: "claude-code", authType: "api_key", secret: `sk-ant-matrixshared${"x".repeat(24)}` },
  },
  { route: "PATCH /api/admin/connections/:id", expect: ADMIN_BY_ID, body: { label: "x" } },
  { route: "DELETE /api/admin/connections/:id", expect: ADMIN_BY_ID },
  { route: "POST /api/admin/connections/:id/test", expect: ADMIN_BY_ID },
  // #37: the matrix app has an in-memory database, so it makes no backups — the admin reaches the handler (409
  // `backup_unavailable`); a real backup as the admin is in backup.test.ts.
  { route: "GET /api/admin/backups", expect: ADMIN_ONLY },
  { route: "POST /api/admin/backups", expect: { ...ADMIN_ONLY, admin: 409 } },
];

/**
 * Admin routes on one user (`/api/admin/users/:id…`, #41/#17/#21/#35): run against a real member as the target —
 * a fresh account for each row, none of the callers — so the admin's call reaches the handler and succeeds.
 * Every admin route must have a row here or in `ADMIN_MATRIX` (permissions.test).
 */
export type AdminUserRow = {
  route: string;
  expect: Record<Who, number>;
  body?: unknown;
  /** Other path params (e.g. a connection of the target). */
  params?: (f: Family, target: UserRow) => Record<string, string>;
};
const targetConnection = (f: Family, target: UserRow) =>
  f.app.connections!.store.create({
    runtime: "claude-code",
    authType: "api_key",
    scope: "personal",
    owner: target,
    createdBy: target.id,
    secret: `sk-ant-matrixtarget${"x".repeat(24)}`,
  }).id;
export const ADMIN_USER_MATRIX: AdminUserRow[] = [
  { route: "GET /api/admin/users", expect: ADMIN_ONLY },
  {
    route: "POST /api/admin/users",
    expect: { ...ADMIN_ONLY, admin: 201 },
    body: { name: "새 가족", email: "matrix-new@matrix.test" },
  },
  { route: "PATCH /api/admin/users/:id", expect: ADMIN_ONLY, body: { name: "새 이름" } },
  { route: "PUT /api/admin/users/:id/youth", expect: ADMIN_ONLY, body: { youth: false } },
  { route: "PUT /api/admin/users/:id/skills", expect: ADMIN_ONLY, body: { skills: "all" } },
  { route: "GET /api/admin/users/:id/skills", expect: ADMIN_ONLY },
  {
    route: "PUT /api/admin/users/:id/skills/:name",
    expect: ADMIN_ONLY,
    body: { enabled: true },
    params: () => ({ name: "google-news-search-skill" }),
  },
  { route: "PUT /api/admin/users/:id/defaults", expect: ADMIN_ONLY, body: { defaults: null } },
  { route: "GET /api/admin/users/:id/runtime-policies", expect: ADMIN_ONLY },
  {
    route: "PUT /api/admin/users/:id/runtime-policies",
    expect: ADMIN_ONLY,
    body: {
      items: [
        {
          runtime: "claude-code",
          allowed: true,
          models: "all",
          efforts: "all",
          allowPersonal: true,
          allowShared: true,
        },
      ],
    },
  },
  { route: "GET /api/admin/users/:id/connections", expect: ADMIN_ONLY },
  {
    route: "POST /api/admin/users/:id/connections",
    expect: { ...ADMIN_ONLY, admin: 201 },
    body: { runtime: "claude-code", authType: "api_key", secret: `sk-ant-matrixbehalf${"x".repeat(24)}` },
  },
  {
    route: "DELETE /api/admin/users/:id/connections/:connectionId",
    expect: ADMIN_ONLY,
    params: (f, target) => ({ connectionId: targetConnection(f, target) }),
  },
  {
    route: "POST /api/admin/users/:id/connections/:connectionId/test",
    expect: ADMIN_ONLY,
    params: (f, target) => ({ connectionId: targetConnection(f, target) }),
  },
  { route: "POST /api/admin/users/:id/reset-password", expect: ADMIN_ONLY },
  { route: "POST /api/admin/users/:id/deactivate", expect: ADMIN_ONLY },
];

let targets = 0;
/** Runs every per-user admin row for every caller against a fresh target account. Returns the mismatches. */
export async function runAdminUserMatrix(f: Family, rows: AdminUserRow[]): Promise<string[]> {
  const failures: string[] = [];
  for (const row of rows) {
    const target = f.app.users!.create({
      email: `target-${++targets}@matrix.test`,
      name: "target",
      role: "member",
      passwordHash: "x",
    });
    // The admin last, so a member's refused call is checked against the same, unchanged target.
    for (const who of (Object.keys(row.expect) as Who[]).sort(
      (a, b) => +(a === "admin") - +(b === "admin"),
    )) {
      const [method, pattern] = row.route.split(" ") as [string, string];
      let url = pattern.replace(":id", encodeURIComponent(target.id));
      for (const [k, v] of Object.entries(row.params?.(f, target) ?? {}))
        url = url.replace(`:${k}`, encodeURIComponent(v));
      const got = (await sendAs(f, who, `${method} ${url}`, row.body)).statusCode;
      if (got !== row.expect[who])
        failures.push(`${row.route} as ${who}: expected ${row.expect[who]}, got ${got}`);
    }
  }
  return failures;
}

/**
 * Every route Fastify itself has registered (`METHOD /path`, HEAD included — its automatic mirrors of GET and
 * explicit HEAD routes alike), read from its route tree — independent of our route config and registry, so a route
 * that declares nothing is listed too.
 */
export function fastifyRoutes(app: FastifyInstance): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
    const m = /^(.*?)[└├]── (\S+)(?: \(([^)]*)\))?$/.exec(line);
    if (!m) continue;
    stack.length = m[1]!.length / 4;
    const full = stack.join("") + m[2]!;
    stack.push(m[2]!);
    for (const method of (m[3] ?? "").split(", ").filter(Boolean)) out.push(`${method} ${full}`);
  }
  return out;
}

/** Sends `METHOD /path` (path params filled with a placeholder) as `who`. */
export function sendAs(f: Family, who: Who, route: string, body?: unknown) {
  const [method, pattern] = route.split(" ") as [string, string];
  const safe = method === "GET" || method === "HEAD";
  const url = pattern.replace(/:[A-Za-z]+/g, "matrix-id").replace("*", "matrix-id");
  return f.app.inject({
    method: method as "GET",
    url,
    headers: {
      ...LOCAL,
      ...(who === "anon" ? {} : { cookie: f.cookies[who] }),
      ...(safe ? {} : { origin: "http://localhost:3000", [CSRF_HEADER]: "1" }),
    },
    ...(safe ? {} : { payload: (body ?? {}) as object }),
  });
}

/** Runs every admin row for every caller. Returns the mismatches. */
export async function runAdminMatrix(f: Family, rows: AdminRow[]): Promise<string[]> {
  const failures: string[] = [];
  for (const row of rows)
    for (const who of Object.keys(row.expect) as Who[]) {
      const got = (await sendAs(f, who, row.route, row.body)).statusCode;
      if (got !== row.expect[who])
        failures.push(`${row.route} as ${who}: expected ${row.expect[who]}, got ${got}`);
    }
  return failures;
}

const LOCAL = { host: "localhost:3000" };
export const PW = "matrix-password-1";

export async function createFamily(app: FastifyInstance): Promise<Family> {
  const store = app.users!;
  const hash = await hashPassword(PW);
  const make = (key: Member, role: "admin" | "member") =>
    store.create({ email: `${key}@matrix.test`, name: key, role, passwordHash: hash });
  const users = {
    owner: make("owner", "member"),
    shared: make("shared", "member"),
    admin: make("admin", "admin"),
    stranger: make("stranger", "member"),
  };
  const cookies = {} as Record<Member, string>;
  for (const key of Object.keys(users) as Member[]) {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { ...LOCAL, origin: "http://localhost:3000", [CSRF_HEADER]: "1" },
      payload: { email: users[key].email, password: PW },
    });
    if (r.statusCode !== 200) throw new Error(`matrix login failed for ${key}: ${r.statusCode}`);
    cookies[key] = String(r.headers["set-cookie"]).split(";")[0]!;
  }
  return { app, users, cookies };
}

/** Runs every row for every caller (fresh fixture each time) plus missing-id checks. Returns the mismatches. */
export async function runMatrix(f: Family, rows: MatrixRow[]): Promise<string[]> {
  const failures: string[] = [];
  for (const row of rows) {
    const [method, pattern] = row.route.split(" ") as [string, string];
    const safe = method === "GET" || method === "HEAD";
    // Put the id where the route's declaration says it is read from.
    const rule = f.app.resources.routes.find((r) => `${r.method} ${r.url}` === row.route)?.rule;
    if (!rule) {
      failures.push(`${row.route}: no route declared with config.resource`);
      continue;
    }
    const param = rule.param ?? "id";
    const send = (who: Who, fx: Fixture) => {
      const id = typeof fx === "string" ? fx : fx.id;
      // Other path params (e.g. :messageId) come from the fixture.
      let path = pattern;
      for (const [k, v] of Object.entries(typeof fx === "string" ? {} : (fx.params ?? {})))
        path = path.replace(`:${k}`, encodeURIComponent(v));
      const from = rule.from ?? "params";
      const url =
        from === "params"
          ? path.replace(param === "*" ? "*" : `:${param}`, param === "*" ? id : encodeURIComponent(id))
          : from === "query"
            ? `${path}${path.includes("?") ? "&" : "?"}${encodeURIComponent(param)}=${encodeURIComponent(id)}`
            : path;
      const body = from === "body" ? { ...((row.body as object) ?? {}), [param]: id } : (row.body ?? {});
      return f.app.inject({
        method: method as "GET",
        url,
        headers: {
          ...LOCAL,
          ...(who === "anon" ? {} : { cookie: f.cookies[who] }),
          ...(safe ? {} : { origin: "http://localhost:3000", [CSRF_HEADER]: "1" }),
        },
        ...(safe ? {} : { payload: body as object }),
      });
    };
    for (const who of Object.keys(row.expect) as Who[]) {
      const res = await send(who, await row.fixture(f));
      const got = res.statusCode;
      if (got !== row.expect[who])
        failures.push(`${row.route} as ${who}: expected ${row.expect[who]}, got ${got}`);
      const code = row.errors?.[who];
      if (code !== undefined) {
        let error: unknown;
        try {
          error = (JSON.parse(res.body) as { error?: unknown }).error;
        } catch {
          error = undefined;
        }
        if (error !== code)
          failures.push(`${row.route} as ${who}: expected error ${code}, got ${String(error)}`);
      }
    }
    // A missing id is 404 for any signed-in user, and 401 before login (existence is not revealed).
    for (const [who, want] of [
      ["owner", 404],
      ["stranger", 404],
      ["anon", 401],
    ] as const) {
      // Keep the fixture's other params real, so only the resource id is missing.
      const fx = await row.fixture(f);
      const got = (await send(who, typeof fx === "string" ? "missing-id" : { ...fx, id: "missing-id" }))
        .statusCode;
      if (got !== want) failures.push(`${row.route} missing id as ${who}: expected ${want}, got ${got}`);
    }
  }
  return failures;
}
