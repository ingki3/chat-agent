import type { FastifyInstance } from "fastify";
import { CSRF_HEADER } from "@agentlee/shared";

/**
 * Permission matrix (#10): resource kind × user × action → expected status.
 * Every route declared with `config.resource` in the real app must have a row in `APP_MATRIX`
 * (permissions.test.ts fails otherwise), so a new resource route cannot ship without its 403/404 table.
 */
export type Who = "owner" | "shared" | "admin" | "stranger" | "anon";
export type MatrixRow = {
  /** `${METHOD} ${route pattern}` exactly as registered, e.g. "GET /api/conversations/:id". */
  route: string;
  /** Status per caller for a resource owned by `owner` and shared (read) with `shared`. */
  expect: Record<Who, number>;
};

/** Rows for the real app's resource routes. Add one with each new resource route (#11, #22, #27, ...). */
export const APP_MATRIX: MatrixRow[] = [];

/** Standard expectations, so most rows are one word. */
export const READ: MatrixRow["expect"] = { owner: 200, shared: 200, admin: 403, stranger: 403, anon: 401 };
export const OWNER_ONLY: MatrixRow["expect"] = {
  owner: 200,
  shared: 403,
  admin: 403,
  stranger: 403,
  anon: 401,
};
export const USAGE: MatrixRow["expect"] = { owner: 200, shared: 403, admin: 200, stranger: 403, anon: 401 };

export async function runMatrix(
  app: FastifyInstance,
  rows: MatrixRow[],
  opts: { cookies: Record<Exclude<Who, "anon">, string>; id: string; missingId: string; body?: unknown },
): Promise<string[]> {
  const failures: string[] = [];
  const headers = (who: Who, method: string) => ({
    host: "localhost:3000",
    ...(who === "anon" ? {} : { cookie: opts.cookies[who] }),
    ...(method === "GET" || method === "HEAD" ? {} : { origin: "http://localhost:3000", [CSRF_HEADER]: "1" }),
  });
  for (const row of rows) {
    const [method, pattern] = row.route.split(" ") as [string, string];
    const send = (who: Who, id: string) =>
      app.inject({
        method: method as "GET",
        url: pattern.replace(":id", encodeURIComponent(id)),
        headers: headers(who, method),
        ...(method === "GET" || method === "HEAD" ? {} : { payload: (opts.body ?? {}) as object }),
      });
    for (const who of Object.keys(row.expect) as Who[]) {
      const got = (await send(who, opts.id)).statusCode;
      if (got !== row.expect[who])
        failures.push(`${row.route} as ${who}: expected ${row.expect[who]}, got ${got}`);
    }
    // A missing id is 404 for any signed-in user (and 401 before login: existence is not revealed).
    for (const who of ["owner", "stranger"] as const) {
      const got = (await send(who, opts.missingId)).statusCode;
      if (got !== 404) failures.push(`${row.route} missing id as ${who}: expected 404, got ${got}`);
    }
    const anonMissing = (await send("anon", opts.missingId)).statusCode;
    if (anonMissing !== 401)
      failures.push(`${row.route} missing id as anon: expected 401, got ${anonMissing}`);
  }
  return failures;
}
