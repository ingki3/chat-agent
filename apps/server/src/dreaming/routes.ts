import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  DreamingPreviewRequest,
  SaveDreamingConfigRequest,
  SaveDreamingPromptRequest,
  SaveDreamingSettingsRequest,
  type DreamingAdmin,
  type DreamingCandidate,
  type DreamingConnectionChoice,
  type DreamingPreview,
  type DreamingPromptView,
  type DreamingSettings,
  type DreamingUserStatus,
  type MyDreaming,
} from "@agentlee/shared";
import type { UserRow, UserStore } from "../auth/users.js";
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
 * 기억 정리 routes (#146, #188, PRD FR-16.5·16.6·16.8).
 *
 * The user's own (`/api/dreaming…`, the caller only — never anyone else's): whether it runs for them, their settings
 * (switch, time, connection·model among the pairs the admin allowed), their cleanup prompt (기본값으로 되돌리기) and
 * 미리 실행 on their own data, `DREAMS.md` (counts, times, results) and their bundles — decided with the card routes
 * (`/api/memory-proposals/:id`, owner only). A youth account reads its settings but cannot change them (403
 * `dreaming_youth_locked`): the admin does, here. The admin's (`/api/admin/dreaming…`): the server-wide switch, the
 * token cap, the allowed connections·models, a youth account's settings, and a status table of settings, ran /
 * skipped / failed with counts — never an item, a message, a proposal or a prompt of anyone (FR-1.5).
 */

const OWN = { noResource: "the caller's own 기억 정리 (settings, prompt, DREAMS.md, bundles)" };
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

  const promptView = (userId: string): DreamingPromptView => {
    const p = store.promptOf(userId);
    return {
      content: p.content,
      custom: p.custom,
      defaultContent: store.prompt().content,
      fixedRules: DREAMING_FIXED_RULES,
      updatedAt: p.updatedAt,
    };
  };

  /** Shared API key connections that passed, of a registered runtime, with their models of ≥ 200,000 tokens. */
  const candidates = (): DreamingCandidate[] => {
    const out: DreamingCandidate[] = [];
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

  /** The allowed pairs a user may pick now: allowed by the admin and still a candidate (its connection usable). */
  const choices = (): DreamingConnectionChoice[] => {
    const cands = candidates();
    return store.config().allowed.flatMap((a) => {
      const c = cands.find((x) => x.runtime === a.runtime && x.id === a.connectionId);
      const m = c?.models.find((x) => x.id === a.model);
      return c && m ? [{ ...a, label: `${c.label} · ${m.label}` }] : [];
    });
  };

  /**
   * Settings as sent: on needs a choice, one of the pairs the user may pick now (D2). Turned off, the stored choice
   * may stay as it is even if it is no longer usable (to be chosen again before turning it back on).
   */
  const checkSettings = (userId: string, s: DreamingSettings): string | null => {
    const same = (c: { runtime: string | null; connectionId: string | null; model: string | null }) =>
      c.runtime === s.runtime && c.connectionId === s.connectionId && c.model === s.model;
    if (choices().some(same)) return null;
    const none = s.runtime === null && s.connectionId === null && s.model === null;
    if (!s.enabled && (none || same(store.settingsOf(userId)))) return null;
    return "dreaming_choice_not_allowed";
  };

  const problemOf = (userId: string, settings: DreamingSettings) =>
    settings.enabled ? runner.problemOf(userId) : null;

  // ---- the user's own ----

  const mine = (user: UserRow): MyDreaming => {
    const settings = store.settingsOf(user.id);
    const on = store.switchedOn(user.id) && runner.problemOf(user.id) === null;
    return {
      enabled: on,
      time: on ? engine.status(user.id).time : null,
      settings,
      canEdit: !user.youth,
      problem: problemOf(user.id, settings),
      choices: choices(),
      prompt: promptView(user.id),
      runs: store.runsOf(user.id),
      proposals: proposals.listDreaming(user.id),
    };
  };

  app.get("/api/dreaming", { config: OWN }, async (req, reply) => send(reply, mine(req.ctx.user!)));

  app.put("/api/dreaming/settings", { config: OWN }, async (req, reply) => {
    const user = req.ctx.user!;
    if (user.youth) return send(reply, { error: "dreaming_youth_locked" }, 403);
    const r = SaveDreamingSettingsRequest.safeParse(req.body);
    if (!r.success) return send(reply, { error: "invalid_request" }, 400);
    const bad = checkSettings(user.id, r.data);
    if (bad) return send(reply, { error: bad }, 400);
    store.setSettings(user.id, r.data);
    engine.kick();
    return send(reply, mine(user));
  });

  app.put("/api/dreaming/prompt", { config: OWN }, async (req, reply) => {
    const user = req.ctx.user!;
    if (user.youth) return send(reply, { error: "dreaming_youth_locked" }, 403);
    const r = SaveDreamingPromptRequest.safeParse(req.body);
    if (!r.success) return send(reply, { error: "invalid_request" }, 400);
    if (r.data.content !== null && holdsSecret(r.data.content))
      return send(reply, { error: "dreaming_secret" }, 400);
    store.setPrompt(user.id, r.data.content);
    return send(reply, mine(user));
  });

  /** 미리 실행: a run on the caller's **own** data only — nothing is applied, queued or moved. */
  app.post("/api/dreaming/preview", { config: OWN }, async (req, reply) => {
    const user = req.ctx.user!;
    if (user.youth) return send(reply, { error: "dreaming_youth_locked" }, 403);
    const r = DreamingPreviewRequest.safeParse(req.body ?? {});
    if (!r.success) return send(reply, { error: "invalid_request" }, 400);
    if (r.data.content !== undefined && holdsSecret(r.data.content))
      return send(reply, { error: "dreaming_secret" }, 400);
    const out = await runner.run({
      userId: user.id,
      date: dreamingDate(now()),
      attempt: 0,
      trigger: "preview",
      idemKey: `dreaming-preview:${user.id}:${crypto.randomUUID()}`,
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

  // ---- the admin's ----

  const statusOf = (u: UserRow): DreamingUserStatus => {
    const last = store.lastRun(u.id);
    const st = engine.status(u.id);
    const settings = store.settingsOf(u.id);
    return {
      userId: u.id,
      name: scrubKnown(u.name),
      active: u.active,
      youth: u.youth,
      enabled: settings.enabled,
      settings,
      customPrompt: store.promptOf(u.id).custom,
      problem: problemOf(u.id, settings),
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

  const adminView = (): DreamingAdmin => {
    const config = store.config();
    return {
      config,
      unavailable: config.allowed.filter((a) => runner.choiceProblem(a) !== null),
      candidates: candidates(),
      users: users.list().map(statusOf),
      manualRuns: deps.manualRuns,
    };
  };

  app.get("/api/admin/dreaming", { config: ADMIN }, async (_req, reply) => send(reply, adminView()));

  app.put("/api/admin/dreaming", { config: ADMIN }, async (req, reply) => {
    const r = SaveDreamingConfigRequest.safeParse(req.body);
    if (!r.success) return send(reply, { error: "invalid_request" }, 400);
    const c = r.data;
    // Only shared API key connections and their models (spec §7, D2) — or the FakeRuntime without one. A pair already
    // allowed whose connection went away may stay (its users are paused; the admin sees it as unavailable).
    const cands = candidates();
    const before = store.config().allowed;
    for (const a of c.allowed) {
      const ok = cands.some(
        (x) => x.runtime === a.runtime && x.id === a.connectionId && x.models.some((m) => m.id === a.model),
      );
      const kept = before.some(
        (b) => b.runtime === a.runtime && b.connectionId === a.connectionId && b.model === a.model,
      );
      if (!ok && !kept) return send(reply, { error: "dreaming_connection_not_allowed" }, 400);
    }
    const seen = new Set<string>();
    store.setConfig({
      ...c,
      allowed: c.allowed.filter((a) => {
        const k = `${a.runtime}|${a.connectionId ?? ""}|${a.model}`;
        return seen.has(k) ? false : (seen.add(k), true);
      }),
    });
    engine.kick();
    return send(reply, adminView());
  });

  /** A youth account's settings — the admin's to set (#188); everyone else sets their own. */
  app.put<{ Params: { id: string } }>(
    "/api/admin/dreaming/users/:id",
    { config: ADMIN },
    async (req, reply) => {
      const r = SaveDreamingSettingsRequest.safeParse(req.body);
      if (!r.success) return send(reply, { error: "invalid_request" }, 400);
      const u = users.byId(req.params.id);
      if (!u) return send(reply, { error: "not_found" }, 404);
      if (!u.youth) return send(reply, { error: "dreaming_not_youth" }, 403);
      const bad = checkSettings(u.id, r.data);
      if (bad) return send(reply, { error: bad }, 400);
      store.setSettings(u.id, r.data);
      engine.kick();
      return send(reply, statusOf(u));
    },
  );

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
