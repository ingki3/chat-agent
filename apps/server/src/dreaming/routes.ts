import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  DreamingPreviewRequest,
  DreamingUserSwitchRequest,
  SaveDreamingConfigRequest,
  SaveDreamingPromptRequest,
  type DreamingAdmin,
  type DreamingConnectionChoice,
  type DreamingPreview,
  type DreamingPromptVersions,
  type DreamingUserStatus,
  type MyDreaming,
} from "@agentlee/shared";
import type { UserStore } from "../auth/users.js";
import { systemUsable, type ConnectionStore } from "../connections/store.js";
import type { MemoryProposals } from "../memory/proposals.js";
import { holdsSecret } from "../memory/rules.js";
import type { RuntimeRegistry } from "../runtime/adapter.js";
import { scrubKnown } from "../secrets/known.js";
import { dreamingDate, type DreamingEngine } from "./engine.js";
import { DREAMING_FIXED_RULES } from "./prompt.js";
import type { DreamingRunner } from "./runner.js";
import { recordOf, type DreamingStore } from "./store.js";

/**
 * 기억 정리 routes (#146, PRD FR-16.5·16.6·16.8).
 *
 * The user's own (`GET /api/dreaming`): whether it runs for them, the prompt in use (read-only, with the fixed rules),
 * `DREAMS.md` (counts, times, results) and their bundles — decided with the card routes (`/api/memory-proposals/:id`,
 * owner only). The admin's (`/api/admin/dreaming…`): the switches, the time, the shared API key connection and model,
 * the token cap, the prompt and its versions, 미리 실행 on the admin's own data, and a status table of ran / skipped /
 * failed with counts — never an item, a message or a proposal of anyone (FR-1.5: those routes are the owner's, 403
 * for the admin).
 */

const OWN = { noResource: "the caller's own 기억 정리 (prompt, DREAMS.md, bundles)" };
const ADMIN = { auth: "admin" as const, noResource: "admin-only 기억 정리 settings and counts (no content)" };

const send = (reply: FastifyReply, body: unknown, status = 200) =>
  reply.code(status).header("Cache-Control", "no-store").send(body);

export type DreamingRouteDeps = {
  store: DreamingStore;
  engine: DreamingEngine;
  runner: DreamingRunner;
  proposals: MemoryProposals;
  users: UserStore;
  registry: RuntimeRegistry;
  connections: ConnectionStore | undefined;
  /** "지금 실행" for one user — the FakeRuntime server only (development, e2e); production has the schedule. */
  manualRuns: boolean;
  now?: () => number;
};

export function registerDreamingRoutes(app: FastifyInstance, deps: DreamingRouteDeps): void {
  const { store, engine, runner, proposals, users } = deps;
  const now = deps.now ?? Date.now;

  const promptView = () => {
    const p = store.prompt();
    return {
      version: p.version,
      content: p.content,
      fixedRules: DREAMING_FIXED_RULES,
      updatedAt: p.createdAt,
    };
  };

  /** Whether the rounds run for this user now (the admin's switches, the account, a usable connection). */
  const runsFor = (userId: string) => {
    const cfg = store.config();
    const u = users.byId(userId);
    return (
      cfg.enabled && !!u?.active && store.state(userId).enabled === 1 && runner.connectionProblem() === null
    );
  };

  // ---- the user's own ----

  app.get("/api/dreaming", { config: OWN }, async (req, reply) => {
    const userId = req.ctx.user!.id;
    const on = runsFor(userId);
    return send(reply, {
      enabled: on,
      time: on ? engine.status(userId).time : null,
      prompt: promptView(),
      runs: store.runsOf(userId),
      proposals: proposals.listDreaming(userId),
    } satisfies MyDreaming);
  });

  // ---- the admin's ----

  /** Shared API key connections that passed, of a registered runtime, with their models of ≥ 200,000 tokens. */
  const choices = (): DreamingConnectionChoice[] => {
    const out: DreamingConnectionChoice[] = [];
    for (const runtime of deps.registry.ids()) {
      const caps = deps.registry.get(runtime)!.capabilities();
      const models = caps.models
        .filter((m) => (m.contextWindow ?? 200_000) >= 200_000)
        .map((m) => ({ id: m.id, label: m.label }));
      if (!caps.needsConnection) {
        // The FakeRuntime (development, e2e): no connection to choose.
        out.push({ id: null, label: `${runtime} (연결 없음 · 개발용)`, runtime, models });
        continue;
      }
      for (const c of deps.connections?.shared() ?? [])
        if (systemUsable(c, runtime)) out.push({ id: c.id, label: scrubKnown(c.label), runtime, models });
    }
    return out;
  };

  const statusOf = (u: { id: string; name: string; active: boolean }): DreamingUserStatus => {
    const last = store.lastRun(u.id);
    const st = engine.status(u.id);
    return {
      userId: u.id,
      name: scrubKnown(u.name),
      active: u.active,
      enabled: store.state(u.id).enabled === 1,
      time: st.time,
      today: st.today,
      last: last
        ? {
            status: last.status,
            code: last.code,
            trigger: last.trigger,
            startedAt: last.started_at,
            counts: recordOf(last).counts,
          }
        : null,
    };
  };

  const adminView = (): DreamingAdmin => ({
    config: store.config(),
    connectionProblem: runner.connectionProblem(),
    connections: choices(),
    prompt: promptView(),
    users: users.list().map(statusOf),
    manualRuns: deps.manualRuns,
  });

  app.get("/api/admin/dreaming", { config: ADMIN }, async (_req, reply) => send(reply, adminView()));

  app.put("/api/admin/dreaming", { config: ADMIN }, async (req, reply) => {
    const r = SaveDreamingConfigRequest.safeParse(req.body);
    if (!r.success) return send(reply, { error: "invalid_request" }, 400);
    const c = r.data;
    // Only a shared API key connection and one of its models (spec §7, D2) — or the FakeRuntime without one.
    if (c.runtime !== null || c.connectionId !== null || c.model !== null) {
      const ok = choices().some(
        (x) => x.runtime === c.runtime && x.id === c.connectionId && x.models.some((m) => m.id === c.model),
      );
      if (!ok) return send(reply, { error: "dreaming_connection_not_allowed" }, 400);
    }
    store.setConfig(c);
    engine.kick();
    return send(reply, adminView());
  });

  app.put<{ Params: { id: string } }>(
    "/api/admin/dreaming/users/:id",
    { config: ADMIN },
    async (req, reply) => {
      const r = DreamingUserSwitchRequest.safeParse(req.body);
      if (!r.success) return send(reply, { error: "invalid_request" }, 400);
      const u = users.byId(req.params.id);
      if (!u) return send(reply, { error: "not_found" }, 404);
      store.setEnabled(u.id, r.data.enabled);
      engine.kick();
      return send(reply, statusOf(u));
    },
  );

  app.put("/api/admin/dreaming/prompt", { config: ADMIN }, async (req, reply) => {
    const r = SaveDreamingPromptRequest.safeParse(req.body);
    if (!r.success) return send(reply, { error: "invalid_request" }, 400);
    if (holdsSecret(r.data.content)) return send(reply, { error: "dreaming_secret" }, 400);
    if (!store.savePrompt(r.data.content.trim(), r.data.baseVersion, req.ctx.user!.id))
      return send(reply, { error: "dreaming_prompt_changed" }, 409);
    return send(reply, promptView());
  });

  app.get("/api/admin/dreaming/prompt/versions", { config: ADMIN }, async (_req, reply) =>
    send(reply, { versions: store.promptVersions() } satisfies DreamingPromptVersions),
  );

  app.post<{ Params: { version: string } }>(
    "/api/admin/dreaming/prompt/versions/:version/restore",
    { config: ADMIN },
    async (req, reply) => {
      const v = store.promptVersions().find((x) => String(x.version) === req.params.version);
      if (!v) return send(reply, { error: "not_found" }, 404);
      const base = (req.body as { baseVersion?: unknown } | undefined)?.baseVersion;
      const at = typeof base === "number" ? base : store.prompt().version;
      if (!store.savePrompt(v.content, at, req.ctx.user!.id, v.version))
        return send(reply, { error: "dreaming_prompt_changed" }, 409);
      return send(reply, promptView());
    },
  );

  /** 미리 실행: a run on the admin's **own** data only — nothing is applied, queued or moved. */
  app.post("/api/admin/dreaming/preview", { config: ADMIN }, async (req, reply) => {
    const r = DreamingPreviewRequest.safeParse(req.body ?? {});
    if (!r.success) return send(reply, { error: "invalid_request" }, 400);
    if (r.data.content !== undefined && holdsSecret(r.data.content))
      return send(reply, { error: "dreaming_secret" }, 400);
    const self = req.ctx.user!.id;
    const out = await runner.run({
      userId: self,
      date: dreamingDate(now()),
      attempt: 0,
      trigger: "preview",
      idemKey: `dreaming-preview:${self}:${crypto.randomUUID()}`,
      preview: { content: r.data.content },
    });
    if (!out) return send(reply, { error: "dreaming_busy" }, 409);
    return send(reply, {
      status: out.status,
      code: out.code,
      counts: out.counts,
      decisions: (out.decisions ?? []).map((d) => ({
        doc: d.doc,
        action: d.action,
        text: d.text === null ? null : scrubKnown(d.text),
        before: d.before === null ? null : scrubKnown(d.before),
      })),
    } satisfies DreamingPreview);
  });

  if (deps.manualRuns)
    app.post<{ Params: { id: string } }>(
      "/api/admin/dreaming/users/:id/run",
      { config: ADMIN },
      async (req, reply) => {
        const u = users.byId(req.params.id);
        if (!u) return send(reply, { error: "not_found" }, 404);
        const date = dreamingDate(now());
        const n = store.manualCount(u.id, date) + 1;
        const out = await runner.run({
          userId: u.id,
          date,
          attempt: n,
          trigger: "manual",
          idemKey: `dreaming:${u.id}:${date}:manual-${n}`,
        });
        if (!out) return send(reply, { error: "dreaming_busy" }, 409);
        // Counts only — what the run decided is the user's own (FR-16.8).
        return send(reply, statusOf(u));
      },
    );
}
