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
const pushDevice = (f: Family) =>
  f.app.notifications!.subscribe(f.users.owner.id, f.app.users!.createSession(f.users.owner.id), {
    endpoint: `https://fcm.googleapis.com/fcm/send/matrix-${Math.random().toString(36).slice(2)}`,
    keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
    label: "matrix",
  });

export const APP_MATRIX: MatrixRow[] = [
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
  { route: "GET /api/conversations/:id/messages", expect: NOT_SHARED(READ), fixture: conversation },
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

const LOCAL = { host: "localhost:3000" };
const PW = "matrix-password-1";

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
      const got = (await send(who, await row.fixture(f))).statusCode;
      if (got !== row.expect[who])
        failures.push(`${row.route} as ${who}: expected ${row.expect[who]}, got ${got}`);
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
