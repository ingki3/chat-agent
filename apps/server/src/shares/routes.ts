import type { FastifyInstance, FastifyReply } from "fastify";
import {
  CreateArtifactShareRequest,
  CreateConversationShareRequest,
  IncomingSharesQuery,
  UpdateShareRequest,
  type IncomingSharesResponse,
  type Share,
  type ShareAudience,
  type SharedView,
  type SharesResponse,
  type ShareTargetsResponse,
} from "@agentlee/shared";
import type { z } from "zod";
import { watchAccess } from "../authz/resources.js";
import { deny } from "../auth/plugin.js";
import type { UserStore } from "../auth/users.js";
import { openSse } from "../sse.js";
import { scrubKnown } from "../secrets/known.js";
import type { SharePolicy } from "./projection.js";
import { ShareError, type ShareRow } from "./store.js";

/** Resource kind of one share: its owner manages it (`share`), the accounts it reaches read it (`read`). */
export const SHARE_KIND = "share";

const STATUS: Record<ShareError["code"], number> = {
  invalid_share_target: 400,
  share_boundary_not_found: 400,
  share_run_in_progress: 409,
  share_revoked: 409,
};

function parse<T extends z.ZodType>(schema: T, value: unknown, reply: FastifyReply): z.infer<T> | undefined {
  const r = schema.safeParse(value);
  if (!r.success) {
    void deny(reply, 400, "invalid_request");
    return undefined;
  }
  return r.data;
}

/**
 * Family sharing API (#29). Only the minimum the policy needs to be used and tested end to end — the share screens,
 * read receipts and forking are #52:
 * - `POST /api/conversations/:id/shares` · `POST /api/artifacts/:id/shares` — share (owner only, `share` action)
 * - `GET  /api/conversations/:id/shares` · `GET /api/artifacts/:id/shares` — the item's shares (owner only)
 * - `GET /api/shares/:id` (owner) · `PATCH` (change who, owner) · `DELETE` (revoke, owner)
 * - `GET /api/shares/:id/view` — the shared item through the projection (owner: the preview; viewer: read-only)
 * - `GET /api/shares/:id/events` — SSE kept open while the share reaches the caller; closed the moment it stops
 * - `GET /api/shared-with-me?q=` — what is shared with the caller (search: titles and projected text only)
 * - `GET /api/share-targets` — family accounts to share with (ids and names: there is no email anywhere here)
 */
export function registerShareRoutes(
  app: FastifyInstance,
  sharing: SharePolicy,
  users: UserStore,
  opts: { heartbeatMs?: number } = {},
): void {
  const store = sharing.store;
  app.resources.register(SHARE_KIND, (id) => {
    const s = store.get(id);
    return s
      ? {
          kind: SHARE_KIND,
          id: s.id,
          ownerId: s.ownerId,
          sharedWith: sharing.targets(s),
          scope: s.conversationId,
        }
      : undefined;
  });

  /** Every stream on this conversation re-checks its access now (watchAccess), so a revoke closes them. */
  const changed = (s: ShareRow) =>
    app.appEvents.emit("resource-access-changed", { kind: SHARE_KIND, id: s.id, scope: s.conversationId });

  /** "가족이 공유했어요" (FR-14.5, #34) to the accounts newly reached — who and what only, never content. */
  const notify = (s: ShareRow, before: readonly string[] = []) => {
    const from = users.byId(s.ownerId)?.name ?? "";
    const itemTitle = sharing.incoming(s).title;
    for (const id of sharing.targets(s))
      if (!before.includes(id))
        app.notifications?.publish(id, {
          kind: "share_received",
          fromName: from,
          itemTitle,
          url: `/shared/${s.id}`,
          ref: { kind: SHARE_KIND, id: s.id },
        });
  };

  const toShare = (s: ShareRow): Share => ({
    id: s.id,
    itemKind: s.itemKind,
    itemId: s.itemId,
    mode: s.mode,
    audience: s.audience,
    targets: (s.revokedAt !== null && s.audience === "users"
      ? store.chosen(s.id)
      : sharing.targets(s)
    ).flatMap((id) => {
      const u = users.byId(id);
      return u ? [{ id: u.id, name: scrubKnown(u.name) }] : [];
    }),
    boundaryMessageId: s.boundaryMessageId,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    revokedAt: s.revokedAt,
  });

  /** Family accounts only (FR-14.7): active accounts of this server, never the owner. */
  const checkTarget = (ownerId: string, t: ShareAudience) => {
    if (t.audience === "family") return;
    for (const id of t.userIds) {
      const u = users.byId(id);
      if (!u || !u.active || u.id === ownerId) throw new ShareError("invalid_share_target");
    }
  };
  const refused = (reply: FastifyReply, e: unknown) => {
    if (!(e instanceof ShareError)) throw e;
    return reply.code(STATUS[e.code]).header("Cache-Control", "no-store").send({ error: e.code });
  };

  app.post<{ Params: { id: string } }>(
    "/api/conversations/:id/shares",
    { config: { resource: { kind: "conversation", action: "share" } } },
    async (req, reply) => {
      const body = parse(CreateConversationShareRequest, req.body, reply);
      if (!body) return reply;
      const owner = req.ctx.user!.id;
      try {
        checkTarget(owner, body.target);
        let snapshot: ReturnType<SharePolicy["compute"]> = [];
        // Computed and stored in one immediate transaction: nothing can be added between the list and its rows.
        const row = store.atomically(() => {
          if (body.mode === "snapshot") {
            const b = app.conversations!.message(req.params.id, body.boundaryMessageId!);
            if (!b || !b.active) throw new ShareError("share_boundary_not_found");
            snapshot = sharing.compute(req.params.id, { live: false, boundarySeq: b.seq });
            // A reply still being written would change after the list is frozen: share once it is done.
            const busy = snapshot.some((i) => {
              if (i.itemType !== "message") return false;
              const m = app.conversations!.message(req.params.id, i.itemId);
              return m?.status === "pending" || m?.status === "streaming";
            });
            if (busy) throw new ShareError("share_run_in_progress");
          }
          return store.create({
            ownerId: owner,
            itemKind: "conversation",
            itemId: req.params.id,
            conversationId: req.params.id,
            target: body.target,
            mode: body.mode,
            boundaryMessageId: body.boundaryMessageId ?? null,
            snapshot,
          });
        });
        changed(row);
        notify(row);
        return reply.code(201).header("Cache-Control", "no-store").send(toShare(row));
      } catch (e) {
        return refused(reply, e);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/artifacts/:id/shares",
    { config: { resource: { kind: "artifact", action: "share" } } },
    async (req, reply) => {
      const body = parse(CreateArtifactShareRequest, req.body, reply);
      if (!body) return reply;
      const owner = req.ctx.user!.id;
      const a = app.artifacts!.get(req.params.id)!;
      try {
        checkTarget(owner, body.target);
        const row = store.atomically(() =>
          store.create({
            ownerId: owner,
            itemKind: "artifact",
            itemId: a.id,
            conversationId: a.conversationId,
            target: body.target,
            mode: body.mode,
            boundaryMessageId: null,
            snapshot: body.mode === "snapshot" ? sharing.artifactSnapshot(a.id, a.conversationId) : [],
          }),
        );
        changed(row);
        notify(row);
        return reply.code(201).header("Cache-Control", "no-store").send(toShare(row));
      } catch (e) {
        return refused(reply, e);
      }
    },
  );

  for (const kind of ["conversation", "artifact"] as const)
    app.get<{ Params: { id: string } }>(
      `/api/${kind}s/:id/shares`,
      { config: { resource: { kind, action: "share" } } },
      async (req, reply) =>
        reply
          .header("Cache-Control", "no-store")
          .send({ items: store.ofItem(kind, req.params.id).map(toShare) } satisfies SharesResponse),
    );

  const own = { resource: { kind: SHARE_KIND, action: "share" as const } };
  app.get<{ Params: { id: string } }>("/api/shares/:id", { config: own }, async (req, reply) =>
    reply.header("Cache-Control", "no-store").send(toShare(store.get(req.params.id)!)),
  );

  app.patch<{ Params: { id: string } }>("/api/shares/:id", { config: own }, async (req, reply) => {
    const body = parse(UpdateShareRequest, req.body, reply);
    if (!body) return reply;
    try {
      checkTarget(req.ctx.user!.id, body.target);
      const before = sharing.targets(store.get(req.params.id)!);
      const row = store.setTarget(req.params.id, body.target);
      changed(row);
      notify(row, before);
      return reply.header("Cache-Control", "no-store").send(toShare(row));
    } catch (e) {
      return refused(reply, e);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/shares/:id", { config: own }, async (req, reply) => {
    const row = store.revoke(req.params.id);
    changed(row);
    return reply.header("Cache-Control", "no-store").send(toShare(row));
  });

  const read = { resource: { kind: SHARE_KIND, action: "read" as const } };
  app.get<{ Params: { id: string } }>("/api/shares/:id/view", { config: { ...read } }, async (req, reply) => {
    const s = store.get(req.params.id)!;
    const user = req.ctx.user!;
    // The owner previews what the share shows; anyone else gets exactly their projection.
    const p =
      s.ownerId === user.id
        ? s.revokedAt === null
          ? sharing.contents(s)
          : null
        : sharing.project(s, user.id);
    if (!p) return deny(reply, 403, "forbidden");
    return reply
      .header("Cache-Control", "no-store")
      .send({ share: sharing.incoming(s), ...sharing.bundle(s, p) } satisfies SharedView);
  });

  // Open while the share reaches the caller; closed (after a `revoked` event) the moment it no longer does —
  // revoke, a change of who it is for, the item deleted, the account deactivated or logged out.
  app.get<{ Params: { id: string } }>("/api/shares/:id/events", { config: read }, async (req, reply) => {
    const stream = openSse(reply, opts.heartbeatMs === undefined ? {} : { heartbeatMs: opts.heartbeatMs });
    const end = () => {
      if (stream.closed) return;
      stream.send("revoked", {});
      stream.close();
    };
    // Viewers: closed when access goes (watchAccess). Everyone, the owner too: closed when the share is off.
    const stop = watchAccess(app, req, end);
    const off = (e: { kind: string; id: string }) => {
      if (e.kind === SHARE_KIND && e.id === req.params.id && store.get(req.params.id)?.revokedAt !== null)
        end();
    };
    app.appEvents.on("resource-access-changed", off);
    stream.onClose(() => {
      stop();
      app.appEvents.off("resource-access-changed", off);
    });
    if (store.get(req.params.id)?.revokedAt !== null) end();
    if (!stream.closed) stream.send("ready", {});
  });

  // Any screen showing an artifact (the `/a/:id` page, the panel) follows this: for the owner it ends at once (`owner`
  // — nothing to lose); for a shared viewer it stays open and sends `revoked` the moment the projection no longer
  // holds the artifact (revoke, change of who, owner deactivated, item gone), so the open screen closes (#29).
  //
  // `?version=n`: the version on screen. It is re-checked on every access change in the conversation: when the
  // projection still shows the artifact but no longer that version (one of several shares went, review #117), the
  // stream sends `scope` with the versions still allowed and ends — the screen drops that version and reloads.
  app.get<{ Params: { id: string }; Querystring: { version?: string } }>(
    "/api/artifacts/:id/access",
    { config: { resource: { kind: "artifact", action: "read" } } },
    async (req, reply) => {
      const stream = openSse(reply, opts.heartbeatMs === undefined ? {} : { heartbeatMs: opts.heartbeatMs });
      const user = req.ctx.user!;
      if (req.resource?.ownerId === user.id) {
        stream.send("owner", {});
        stream.close();
        return;
      }
      const end = (event: string, data: unknown) => {
        if (stream.closed) return;
        stream.send(event, data);
        stream.close();
      };
      // The whole artifact: closed by the common check (watchAccess) when the projection no longer holds it.
      const stop = watchAccess(app, req, () => end("revoked", {}));
      const shown = /^[1-9][0-9]{0,5}$/.test(req.query.version ?? "") ? Number(req.query.version) : undefined;
      const scope = req.resource?.scope;
      const checkVersion = () => {
        if (shown === undefined || stream.closed) return;
        const a = app.artifacts?.get(req.params.id);
        const p = a && sharing.artifactView(a, user.id);
        if (!p) return end("revoked", {});
        const allowed = [...(p.versions.get(req.params.id) ?? [])].sort((x, y) => x - y);
        if (!allowed.includes(shown)) end("scope", { versions: allowed });
      };
      const onChange = (e: { scope?: string }) => {
        if (scope && e.scope === scope) checkVersion();
      };
      app.appEvents.on("resource-access-changed", onChange);
      stream.onClose(() => {
        stop();
        app.appEvents.off("resource-access-changed", onChange);
      });
      // A version that went between the request and now.
      checkVersion();
      if (!stream.closed) stream.send("ready", {});
    },
  );

  app.get(
    "/api/shared-with-me",
    { config: { noResource: "lists the shares that reach the caller (through the projection)" } },
    async (req, reply) => {
      const q = parse(IncomingSharesQuery, req.query, reply);
      if (!q) return reply;
      const items = sharing.search(req.ctx.user!.id, q.q || undefined).map((s) => sharing.incoming(s));
      return reply.header("Cache-Control", "no-store").send({ items } satisfies IncomingSharesResponse);
    },
  );

  app.get(
    "/api/share-targets",
    { config: { noResource: "the family accounts (ids and names only) the caller can share with" } },
    async (req, reply) =>
      reply.header("Cache-Control", "no-store").send({
        items: users
          .list()
          .filter((u) => u.active && u.id !== req.ctx.user!.id)
          .map((u) => ({ id: u.id, name: scrubKnown(u.name) })),
      } satisfies ShareTargetsResponse),
  );
}
