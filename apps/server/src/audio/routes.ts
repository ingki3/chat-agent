import type { FastifyInstance, FastifyRequest } from "fastify";
import { SetAudioAdminRequest, type AudioAdmin } from "@agentlee/shared";
import type { UserStore } from "../auth/users.js";
import type { AudioTranscriber } from "./service.js";

/**
 * 관리자 → 스킬 → 음성 전사 (#173): the OpenRouter fallback switch. Off by default; on, it is used only when the local
 * Whisper fails and `OPENROUTER_API_KEY` is set. The key itself is never sent to the screen (`keyConfigured` only).
 */
export function registerAudioRoutes(
  app: FastifyInstance,
  audio: AudioTranscriber,
  users: Pick<UserStore, "sessionUser">,
): void {
  const admin = { auth: "admin" as const, noResource: "admin-only server setting" };
  const view = (): AudioAdmin => {
    const f = audio.fallback();
    return { fallback: f.enabled, keyConfigured: f.keyConfigured };
  };
  // Right before the change: still the same session of an active admin (as the other admin writes).
  const stillAdmin = (req: FastifyRequest) => {
    const token = req.ctx.sessionToken;
    const u = token ? users.sessionUser(token) : undefined;
    return !!u && u.id === req.ctx.user?.id && u.role === "admin" && !u.mustChangePassword;
  };
  app.get("/api/admin/audio", { config: admin }, async (_req, reply) =>
    reply.header("Cache-Control", "no-store").send(view()),
  );
  app.put("/api/admin/audio", { config: admin }, async (req, reply) => {
    const r = SetAudioAdminRequest.safeParse(req.body);
    if (!r.success)
      return reply.code(400).header("Cache-Control", "no-store").send({ error: "invalid_request" });
    if (!stillAdmin(req))
      return reply.code(403).header("Cache-Control", "no-store").send({ error: "forbidden" });
    audio.setFallback(r.data.fallback);
    return reply.header("Cache-Control", "no-store").send(view());
  });
}
