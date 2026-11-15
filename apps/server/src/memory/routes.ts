import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  RestoreDocRequest,
  SaveDocRequest,
  SystemDocRef,
  UserDocKind,
  type AdminInstructionsResponse,
  type DocVersionDetail,
  type DocVersionSummary,
  type InstructionsResponse,
} from "@agentlee/shared";
import type { UserStore } from "../auth/users.js";
import { scrubKnown } from "../secrets/known.js";
import { DocRejected, type DocTarget, type MemoryDocs } from "./service.js";
import type { VersionRow } from "./store.js";

/**
 * 내 지침 routes (#144, PRD FR-16.1·16.3·16.8).
 *
 * The user's own: `GET /api/instructions` (all four — AGENT composed, read-only), `PUT /api/instructions/:kind`
 * (soul, user, memory; agent → 403 `doc_read_only`), versions, one version, restore. The admin: the family-wide AGENT
 * and the default SOUL (`/api/admin/instructions/:ref`), each account's AGENT
 * (`/api/admin/users/:id/instructions/agent`). Another user's SOUL / USER / MEMORY (and DREAMS / proposals, #146) are
 * never served to the admin — `/api/admin/users/:id/instructions/<anything else>` is 403 (FR-1.5, AC-14 step 5).
 * Answers are scrubbed of known secrets on the way out (a secret registered after a save).
 */

const OWN = { noResource: "the caller's own 내 지침 documents" };
const ADMIN = { auth: "admin" as const, noResource: "admin-only 내 지침 documents (AGENT, default SOUL)" };

const send = (reply: FastifyReply, body: unknown, status = 200) =>
  reply.code(status).header("Cache-Control", "no-store").send(body);
const fail = (reply: FastifyReply, status: number, error: string) => send(reply, { error }, status);

const summaryOf = (v: VersionRow): DocVersionSummary => ({
  version: v.version,
  author: v.author,
  prevVersion: v.prevVersion ?? null,
  restoredFrom: v.restoredFrom ?? null,
  createdAt: v.createdAt,
  chars: [...v.content].length,
});
const detailOf = (v: VersionRow): DocVersionDetail => ({ ...summaryOf(v), content: scrubKnown(v.content) });
const scrubDoc = <T extends { content: string; items: { text: string }[] | null }>(d: T): T => ({
  ...d,
  content: scrubKnown(d.content),
  items: d.items?.map((i) => ({ ...i, text: scrubKnown(i.text) })) ?? null,
});

export function registerMemoryRoutes(app: FastifyInstance, memory: MemoryDocs, users: UserStore): void {
  const me = (req: FastifyRequest) => users.byId(req.ctx.user!.id)!;

  /** A save or restore: the document as it is now, or the refusal. */
  const saving = (reply: FastifyReply, fn: () => unknown, view: () => unknown) => {
    try {
      const r = fn();
      if (r === undefined) return fail(reply, 404, "not_found");
      return send(reply, view());
    } catch (e) {
      if (e instanceof DocRejected) return fail(reply, e.status, e.code);
      throw e;
    }
  };

  // ---- the user's own ----

  app.get("/api/instructions", { config: OWN }, async (req, reply) =>
    send(reply, { docs: memory.userView(me(req)).map(scrubDoc) } satisfies InstructionsResponse),
  );

  const ownTarget = (req: FastifyRequest<{ Params: { kind: string } }>, reply: FastifyReply) => {
    if (req.params.kind === "agent") {
      void fail(reply, 403, "doc_read_only");
      return undefined;
    }
    const k = UserDocKind.safeParse(req.params.kind);
    if (!k.success) {
      void fail(reply, 404, "not_found");
      return undefined;
    }
    return { kind: "own", user: me(req), doc: k.data } satisfies DocTarget;
  };
  const ownView = (req: FastifyRequest, kind: string) =>
    scrubDoc(memory.userView(me(req)).find((d) => d.kind === kind)!);

  app.put<{ Params: { kind: string } }>("/api/instructions/:kind", { config: OWN }, async (req, reply) => {
    const t = ownTarget(req, reply);
    if (!t) return reply;
    const r = SaveDocRequest.safeParse(req.body);
    if (!r.success) return fail(reply, 400, "invalid_request");
    return saving(
      reply,
      () => memory.save(t, r.data.content, { actorId: t.user.id, base: r.data.baseVersion }),
      () => ownView(req, t.doc),
    );
  });

  app.get<{ Params: { kind: string } }>(
    "/api/instructions/:kind/versions",
    { config: OWN },
    async (req, reply) => {
      const t = ownTarget(req, reply);
      if (!t) return reply;
      return send(reply, { versions: memory.versions(t).map(summaryOf) });
    },
  );

  app.get<{ Params: { kind: string; version: string } }>(
    "/api/instructions/:kind/versions/:version",
    { config: OWN },
    async (req, reply) => {
      const t = ownTarget(req, reply);
      if (!t) return reply;
      const v = memory.version(t, Number(req.params.version));
      return v ? send(reply, detailOf(v)) : fail(reply, 404, "not_found");
    },
  );

  app.post<{ Params: { kind: string; version: string } }>(
    "/api/instructions/:kind/versions/:version/restore",
    { config: OWN },
    async (req, reply) => {
      const t = ownTarget(req, reply);
      if (!t) return reply;
      const r = RestoreDocRequest.safeParse(req.body ?? {});
      if (!r.success) return fail(reply, 400, "invalid_request");
      return saving(
        reply,
        () => memory.restore(t, Number(req.params.version), { actorId: t.user.id, base: r.data.baseVersion }),
        () => ownView(req, t.doc),
      );
    },
  );

  // ---- the admin's ----

  app.get("/api/admin/instructions", { config: ADMIN }, async (_req, reply) =>
    send(reply, {
      commonAgent: scrubDoc(memory.systemView("common-agent")),
      defaultSoul: scrubDoc(memory.systemView("default-soul")),
      accounts: users
        .list()
        .filter((u) => u.active)
        .map((u) => ({
          userId: u.id,
          name: scrubKnown(u.name),
          youth: u.youth,
          agent: scrubDoc(memory.accountAgentView(u.id)),
        })),
    } satisfies AdminInstructionsResponse),
  );

  /** `common-agent`, `default-soul`, or `account-agent:<user id>`. */
  const adminTarget = (ref: string): DocTarget | undefined => {
    const sys = SystemDocRef.safeParse(ref);
    if (sys.success) return { kind: "system", ref: sys.data };
    const m = /^account-agent:(.+)$/.exec(ref);
    return m && users.byId(m[1]!) ? { kind: "account-agent", userId: m[1]! } : undefined;
  };
  const adminView = (t: DocTarget) =>
    scrubDoc(
      t.kind === "system"
        ? memory.systemView(t.ref)
        : memory.accountAgentView((t as { userId: string }).userId),
    );

  app.put<{ Params: { ref: string } }>(
    "/api/admin/instructions/:ref",
    { config: ADMIN },
    async (req, reply) => {
      const t = adminTarget(req.params.ref);
      if (!t) return fail(reply, 404, "not_found");
      const r = SaveDocRequest.safeParse(req.body);
      if (!r.success) return fail(reply, 400, "invalid_request");
      return saving(
        reply,
        () => memory.save(t, r.data.content, { actorId: req.ctx.user!.id, base: r.data.baseVersion }),
        () => adminView(t),
      );
    },
  );

  app.get<{ Params: { ref: string } }>(
    "/api/admin/instructions/:ref/versions",
    { config: ADMIN },
    async (req, reply) => {
      const t = adminTarget(req.params.ref);
      if (!t) return fail(reply, 404, "not_found");
      return send(reply, { versions: memory.versions(t).map(summaryOf) });
    },
  );

  app.get<{ Params: { ref: string; version: string } }>(
    "/api/admin/instructions/:ref/versions/:version",
    { config: ADMIN },
    async (req, reply) => {
      const t = adminTarget(req.params.ref);
      const v = t && memory.version(t, Number(req.params.version));
      return v ? send(reply, detailOf(v)) : fail(reply, 404, "not_found");
    },
  );

  app.post<{ Params: { ref: string; version: string } }>(
    "/api/admin/instructions/:ref/versions/:version/restore",
    { config: ADMIN },
    async (req, reply) => {
      const t = adminTarget(req.params.ref);
      if (!t) return fail(reply, 404, "not_found");
      const r = RestoreDocRequest.safeParse(req.body ?? {});
      if (!r.success) return fail(reply, 400, "invalid_request");
      return saving(
        reply,
        () =>
          memory.restore(t, Number(req.params.version), {
            actorId: req.ctx.user!.id,
            base: r.data.baseVersion,
          }),
        () => adminView(t),
      );
    },
  );

  // An account's AGENT, by user (the admin screen's per-account editor goes through `:ref` above too). Anything else
  // of another user — SOUL, USER, MEMORY, DREAMS, proposals — is not the admin's to read (FR-1.5, FR-16.8): 403.
  app.get<{ Params: { id: string; kind: string } }>(
    "/api/admin/users/:id/instructions/:kind",
    { config: ADMIN },
    async (req, reply) => {
      if (req.params.kind !== "agent") return fail(reply, 403, "forbidden");
      if (!users.byId(req.params.id)) return fail(reply, 404, "not_found");
      return send(reply, scrubDoc(memory.accountAgentView(req.params.id)));
    },
  );
  app.get<{ Params: { id: string; kind: string } }>(
    "/api/admin/users/:id/instructions/:kind/versions",
    { config: ADMIN },
    async (req, reply) => {
      if (req.params.kind !== "agent") return fail(reply, 403, "forbidden");
      if (!users.byId(req.params.id)) return fail(reply, 404, "not_found");
      return send(reply, {
        versions: memory.versions({ kind: "account-agent", userId: req.params.id }).map(summaryOf),
      });
    },
  );
}
