import type { FastifyInstance, FastifyReply } from "fastify";
import {
  CreateScheduleRequest,
  UpdateScheduleRequest,
  type ChangeSettingsRequest,
  type RunScheduleNowResponse,
  type Schedule,
  type ScheduleRunsResponse,
  type SchedulesResponse,
} from "@agentlee/shared";
import type { z } from "zod";
import { deny } from "../auth/plugin.js";
import type { UserStore } from "../auth/users.js";
import { RunAccessDenied } from "../connections/access.js";
import type { McpService } from "../mcp/service.js";
import type { DefaultsService } from "../users/defaults.js";
import type { ScheduleEngine } from "./engine.js";
import { ScheduleInputError, toRun, toSchedule, type ScheduleStore } from "./store.js";

export const SCHEDULE_KIND = "schedule";

function parse<T extends z.ZodType>(schema: T, value: unknown, reply: FastifyReply): z.infer<T> | undefined {
  const r = schema.safeParse(value);
  if (!r.success) {
    void deny(reply, 400, "invalid_request");
    return undefined;
  }
  return r.data;
}

const noStore = (reply: FastifyReply) => reply.header("Cache-Control", "no-store");

/**
 * Minimal schedule API (#33) — enough to create, list, pause, run now and read the history; the screen is #55.
 * Owner only: a schedule's prompt is the owner's content, so the admin is refused like anyone else (FR-1.5).
 */
export function registerScheduleRoutes(
  app: FastifyInstance,
  deps: {
    store: ScheduleStore;
    engine: ScheduleEngine | undefined;
    defaults: DefaultsService;
    users: UserStore;
    mcp: McpService;
    now: () => number;
  },
): void {
  const { store } = deps;
  app.resources.register(SCHEDULE_KIND, (id) => {
    const s = store.byId(id);
    return s ? { kind: SCHEDULE_KIND, id: s.id, ownerId: s.owner_id, sharedWith: [] } : undefined;
  });
  const rule = (action: "read" | "write" | "delete") => ({ resource: { kind: SCHEDULE_KIND, action } });

  app.get(
    "/api/schedules",
    { config: { noResource: "lists only the caller's own schedules" } },
    async (req, reply) => {
      const body: SchedulesResponse = { schedules: store.listFor(req.ctx.user!.id).map(toSchedule) };
      return noStore(reply).send(body);
    },
  );

  app.post(
    "/api/schedules",
    { config: { noResource: "creates a schedule owned by the caller" } },
    async (req, reply) => {
      const body = parse(CreateScheduleRequest, req.body ?? {}, reply);
      if (!body) return reply;
      const user = deps.users.byId(req.ctx.user!.id);
      if (!user) return deny(reply, 401, "unauthenticated");
      // Skills: from the catalogue, and ones this user may use (#21).
      const catalogue = new Set(deps.mcp.overview().map((s) => s.name));
      if (body.skills.some((s) => !catalogue.has(s) || !deps.mcp.allows(user.id, s)))
        return noStore(reply).code(403).send({ error: "skill_not_allowed" });
      // Runtime·model·effort (FR-8.2): the creator's defaults with the FR-12.6 fallback, or the given ones checked
      // exactly like the chip's change (#19) — the same allowed list as a run.
      const patch: ChangeSettingsRequest = {};
      if (body.runtime !== undefined) patch.runtime = body.runtime;
      if (body.model !== undefined) patch.model = body.model;
      if (body.effort !== undefined) patch.effort = body.effort;
      if (body.useShared !== undefined) patch.useShared = body.useShared;
      let settings;
      try {
        settings = Object.keys(patch).length
          ? deps.defaults.change(user, null, patch)
          : (deps.defaults.start(user)?.settings ?? null);
      } catch (e) {
        if (e instanceof RunAccessDenied) return noStore(reply).code(403).send({ error: e.code });
        throw e;
      }
      if (!settings) return noStore(reply).code(409).send({ error: "no_usable_runtime" });
      try {
        const row = store.create(
          user.id,
          {
            name: body.name,
            prompt: body.prompt,
            timing: body.timing,
            timeZone: body.timeZone,
            skills: [...new Set(body.skills)],
            notify: body.notify,
            settings,
          },
          deps.now(),
        );
        deps.engine?.kick();
        const out: Schedule = toSchedule(row);
        return noStore(reply).code(201).send(out);
      } catch (e) {
        if (e instanceof ScheduleInputError) return noStore(reply).code(400).send({ error: e.code });
        throw e;
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/schedules/:id", { config: rule("read") }, async (req, reply) =>
    noStore(reply).send(toSchedule(store.byId(req.params.id)!)),
  );

  app.patch<{ Params: { id: string } }>(
    "/api/schedules/:id",
    { config: rule("write") },
    async (req, reply) => {
      const body = parse(UpdateScheduleRequest, req.body ?? {}, reply);
      if (!body) return reply;
      const patch: { paused?: boolean; notify?: boolean } = {};
      if (body.paused !== undefined) patch.paused = body.paused;
      if (body.notify !== undefined) patch.notify = body.notify;
      const row = store.update(req.params.id, patch, deps.now());
      deps.engine?.kick();
      return noStore(reply).send(toSchedule(row!));
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/schedules/:id",
    { config: rule("delete") },
    async (req, reply) => {
      store.delete(req.params.id);
      return noStore(reply).code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/schedules/:id/runs",
    { config: rule("read") },
    async (req, reply) => {
      const body: ScheduleRunsResponse = { runs: store.runs(req.params.id).map(toRun) };
      return noStore(reply).send(body);
    },
  );

  /** "바로 실행" (FR-8.5): a run of its own key; 409 while the schedule's previous run is not finished. */
  app.post<{ Params: { id: string } }>(
    "/api/schedules/:id/run",
    { config: rule("write") },
    async (req, reply) => {
      const run = store.manual(req.params.id, deps.now());
      if (!run) return noStore(reply).code(409).send({ error: "schedule_busy" });
      deps.engine?.kick();
      const body: RunScheduleNowResponse = { run: toRun(run) };
      return noStore(reply).code(201).send(body);
    },
  );
}
