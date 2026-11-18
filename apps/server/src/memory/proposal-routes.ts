import type { FastifyInstance, FastifyReply } from "fastify";
import { MemoryDecisionsRequest, SaveMemoryPrefsRequest, type MemoryPrefs } from "@agentlee/shared";
import { ProposalError, type MemoryProposals } from "./proposals.js";

/**
 * 대화 중 기억해줘 (#145, PRD FR-16.4·16.7): the in-chat card and the setting "기억 반영 방식".
 *
 * - `GET /api/memory-prefs`, `PUT /api/memory-prefs` — the caller's own setting (검토 후 반영 / 자동 반영 + 알림).
 * - `GET /api/memory-proposals/:id` — the card; `POST …/accept` / `…/reject` (`{ indexes }`, per decision) and
 *   `POST …/undo` (자동 반영's 되돌리기). Owner only: anyone else — a shared viewer, the admin (FR-1.5, FR-16.8) — 403.
 *   An expired bundle answers 409 `proposal_expired` with the card as it is now ("다시 요청해 주세요").
 */
export const MEMORY_PROPOSAL_KIND = "memory_proposal";

const send = (reply: FastifyReply, body: unknown, status = 200) =>
  reply.code(status).header("Cache-Control", "no-store").send(body);

export function registerMemoryProposalRoutes(app: FastifyInstance, proposals: MemoryProposals): void {
  app.resources.register(MEMORY_PROPOSAL_KIND, (id) => {
    const o = proposals.ownerOf(id);
    return o ? { kind: MEMORY_PROPOSAL_KIND, id, ownerId: o, sharedWith: [] } : undefined;
  });
  const rule = (action: "read" | "write") => ({ resource: { kind: MEMORY_PROPOSAL_KIND, action } });
  const OWN = { noResource: "the caller's own 기억 반영 방식 setting" };

  // A youth account's 반영 방식 is the admin's to set (#188, with its 기억 정리 settings): read-only here.
  const prefs = (u: { id: string; youth: boolean }): MemoryPrefs => ({
    applyMode: proposals.mode(u.id),
    rev: proposals.modeRev(u.id),
    ...(u.youth ? { locked: true as const } : {}),
  });
  app.get("/api/memory-prefs", { config: OWN }, async (req, reply) => send(reply, prefs(req.ctx.user!)));
  app.put("/api/memory-prefs", { config: OWN }, async (req, reply) => {
    const user = req.ctx.user!;
    if (user.youth) return send(reply, { error: "dreaming_youth_locked" }, 403);
    const r = SaveMemoryPrefsRequest.safeParse(req.body);
    if (!r.success) return send(reply, { error: "invalid_request" }, 400);
    proposals.setMode(user.id, r.data.applyMode);
    return send(reply, prefs(user));
  });

  const acting = (reply: FastifyReply, id: string, userId: string, fn: () => unknown) => {
    try {
      return send(reply, fn());
    } catch (e) {
      if (!(e instanceof ProposalError)) throw e;
      const body: Record<string, unknown> = { error: e.code };
      if (e.status === 409) body.proposal = proposals.view(id, userId);
      return send(reply, body, e.status);
    }
  };

  app.get<{ Params: { id: string } }>(
    "/api/memory-proposals/:id",
    { config: rule("read") },
    async (req, reply) =>
      acting(reply, req.params.id, req.ctx.user!.id, () => proposals.view(req.params.id, req.ctx.user!.id)),
  );
  for (const action of ["accept", "reject"] as const)
    app.post<{ Params: { id: string } }>(
      `/api/memory-proposals/:id/${action}`,
      { config: rule("write") },
      async (req, reply) => {
        const r = MemoryDecisionsRequest.safeParse(req.body ?? {});
        if (!r.success) return send(reply, { error: "invalid_request" }, 400);
        const userId = req.ctx.user!.id;
        return acting(reply, req.params.id, userId, () =>
          proposals[action](req.params.id, userId, r.data.indexes),
        );
      },
    );
  app.post<{ Params: { id: string } }>(
    "/api/memory-proposals/:id/undo",
    { config: rule("write") },
    async (req, reply) =>
      acting(reply, req.params.id, req.ctx.user!.id, () => proposals.undo(req.params.id, req.ctx.user!.id)),
  );
}
