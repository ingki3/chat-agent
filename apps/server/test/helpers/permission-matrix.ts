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

export type MatrixRow = {
  /** `${METHOD} ${route pattern}` exactly as registered, e.g. "GET /api/conversations/:id". */
  route: string;
  /** Status per caller for a resource owned by `owner` and shared (read) with `shared`. */
  expect: Record<Who, number>;
  /**
   * Creates a fresh resource owned by `f.users.owner` and shared with `f.users.shared`; returns its id.
   * Called before every single request, so one caller's delete or change never affects the next caller.
   */
  fixture: (f: Family) => string | Promise<string>;
  /** Request body for non-GET routes. */
  body?: unknown;
};

/** Rows for the real app's resource routes. Add one with each new resource route (#11, #22, #27, ...). */
export const APP_MATRIX: MatrixRow[] = [];

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
    const send = (who: Who, id: string) => {
      const from = rule.from ?? "params";
      const url =
        from === "params"
          ? pattern.replace(param === "*" ? "*" : `:${param}`, param === "*" ? id : encodeURIComponent(id))
          : from === "query"
            ? `${pattern}${pattern.includes("?") ? "&" : "?"}${encodeURIComponent(param)}=${encodeURIComponent(id)}`
            : pattern;
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
      const got = (await send(who, "missing-id")).statusCode;
      if (got !== want) failures.push(`${row.route} missing id as ${who}: expected ${want}, got ${got}`);
    }
  }
  return failures;
}
