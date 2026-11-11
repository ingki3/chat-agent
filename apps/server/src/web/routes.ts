import type { FastifyInstance } from "fastify";
import type { SourcesResponse } from "@agentlee/shared";
import type { ConversationStore } from "../conversations/store.js";
import { toSource, type SourceStore } from "./sources.js";

/**
 * Resource kind of a conversation's source list (#50). Owner only, whatever the conversation's sharing says:
 * a shared view (#29) shows the frozen sources of its shared messages, never this full list.
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
    return c ? { kind: SOURCES_KIND, id: c.id, ownerId: c.ownerId, sharedWith: [] } : undefined;
  });
  app.get<{ Params: { id: string } }>(
    "/api/conversations/:id/sources",
    { config: { resource: { kind: SOURCES_KIND, action: "read" } } },
    async (req, reply) =>
      reply
        .header("Cache-Control", "no-store")
        .send({ items: sources.list(req.params.id).map(toSource) } satisfies SourcesResponse),
  );
}
