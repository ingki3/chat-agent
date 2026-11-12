import type { FastifyInstance, FastifyReply } from "fastify";
import {
  AddWatchlistRequest,
  WatchlistSearchQuery,
  type WatchlistItem,
  type WatchlistResponse,
  type WatchlistSearchResponse,
} from "@agentlee/shared";
import { deny } from "../auth/plugin.js";
import type { McpService } from "../mcp/service.js";
import { toWatchlistItem, WatchlistError, type WatchlistStore } from "./store.js";

export const WATCHLIST_KIND = "watchlist_item";

const noStore = (reply: FastifyReply) => reply.header("Cache-Control", "no-store");

/**
 * 관심 종목 API (#31, FR-7.7). Owner only, like schedules: a person's list says what they invest in, so the admin is
 * refused like anyone else (FR-1.5). Adding a symbol and the search need the finance skill of its market
 * (KR → kr-stock-skill, US → us-stock-skill): an account whose finance skills are hidden (the son, #30) gets none.
 */
export function registerWatchlistRoutes(
  app: FastifyInstance,
  deps: { store: WatchlistStore; mcp: McpService },
): void {
  const { store, mcp } = deps;
  app.resources.register(WATCHLIST_KIND, (id) => {
    const r = store.byId(id);
    return r ? { kind: WATCHLIST_KIND, id: r.id, ownerId: r.userId, sharedWith: [] } : undefined;
  });
  const rule = (action: "read" | "delete") => ({ resource: { kind: WATCHLIST_KIND, action } });

  app.get(
    "/api/watchlist",
    { config: { noResource: "lists only the caller's own watchlist" } },
    async (req, reply) => {
      const userId = req.ctx.user!.id;
      const body: WatchlistResponse = {
        items: store.list(userId).map(toWatchlistItem),
        markets: mcp.watchMarkets(userId),
      };
      return noStore(reply).send(body);
    },
  );

  app.post(
    "/api/watchlist",
    { config: { noResource: "adds to the caller's own watchlist" } },
    async (req, reply) => {
      const parsed = AddWatchlistRequest.safeParse(req.body ?? {});
      if (!parsed.success) return deny(reply, 400, "invalid_request");
      const userId = req.ctx.user!.id;
      if (!mcp.watchMarkets(userId).includes(parsed.data.market))
        return noStore(reply).code(403).send({ error: "finance_not_allowed" });
      try {
        const out: WatchlistItem = toWatchlistItem(store.add(userId, parsed.data));
        return noStore(reply).code(201).send(out);
      } catch (e) {
        if (e instanceof WatchlistError) return noStore(reply).code(e.status).send({ error: e.code });
        throw e;
      }
    },
  );

  app.get(
    "/api/watchlist/search",
    { config: { noResource: "searches the public symbol list (Naver 증권); reads no stored data" } },
    async (req, reply) => {
      const q = WatchlistSearchQuery.safeParse(req.query ?? {});
      if (!q.success) return deny(reply, 400, "invalid_request");
      const r = await mcp.searchSymbols(req.ctx.user!.id, q.data.q);
      if (!r.ok)
        return noStore(reply)
          .code(r.code === "finance_not_allowed" ? 403 : r.code === "finance_busy" ? 429 : 502)
          .send({ error: r.code });
      const body: WatchlistSearchResponse = { items: r.items };
      return noStore(reply).send(body);
    },
  );

  app.get<{ Params: { id: string } }>("/api/watchlist/:id", { config: rule("read") }, async (req, reply) =>
    noStore(reply).send(toWatchlistItem(store.byId(req.params.id)!)),
  );

  app.delete<{ Params: { id: string } }>(
    "/api/watchlist/:id",
    { config: rule("delete") },
    async (req, reply) => {
      store.remove(req.params.id);
      return noStore(reply).code(204).send();
    },
  );
}
