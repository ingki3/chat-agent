import type { FastifyInstance } from "fastify";
import type { SourcesResponse } from "@agentlee/shared";
import type { ConversationStore } from "../conversations/store.js";
import { toSource, type SourceStore } from "./sources.js";
import { sharedWith, viewOf } from "../shares/projection.js";

/**
 * Resource kind of a conversation's source list (#50). The owner gets the full list; a shared viewer (#29) only the
 * sources the shared messages cite (frozen with a snapshot) — never the full list.
 */
export const SOURCES_KIND = "conversation-sources";

/** `GET /api/conversations/:id/sources` — the sources of one conversation, oldest first (for #25's UI). */
export function registerSourceRoutes(
  app: FastifyInstance,
  conversations: ConversationStore,
  sources: SourceStore,
): void {
  app.resources.register(SOURCES_KIND, (id) => {
    const c = conversations.get(id);
    return c
      ? { kind: SOURCES_KIND, id: c.id, ownerId: c.ownerId, sharedWith: sharedWith(app, c.id), scope: c.id }
      : undefined;
  });
  app.get<{ Params: { id: string } }>(
    "/api/conversations/:id/sources",
    { config: { resource: { kind: SOURCES_KIND, action: "read" } } },
    async (req, reply) => {
      const p = viewOf(app, req, { conversationId: req.params.id });
      if (p === null) return reply.code(403).header("Cache-Control", "no-store").send({ error: "forbidden" });
      const rows = sources.list(req.params.id).filter((s) => !p || p.sources.has(s.id));
      return reply
        .header("Cache-Control", "no-store")
        .send({ items: rows.map(toSource) } satisfies SourcesResponse);
    },
  );
}
