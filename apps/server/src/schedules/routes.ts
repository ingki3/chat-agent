import type { FastifyInstance, FastifyReply } from "fastify";
import crypto from "node:crypto";
import {
  ConfirmScheduleProposalRequest,
  CreateScheduleRequest,
  SCHEDULE_PREVIEW_COUNT,
  SchedulePreviewRequest,
  UpdateScheduleRequest,
  type ChangeSettingsRequest,
  type ChatSettings,
  type ConfirmScheduleProposalResponse,
  type RunScheduleNowResponse,
  type Schedule,
  type ScheduleOptionsResponse,
  type SchedulePreviewResponse,
  type ScheduleProposal,
  type ScheduleRunsResponse,
  type SchedulesResponse,
} from "@agentlee/shared";
import type { z } from "zod";
import { deny } from "../auth/plugin.js";
import type { UserRow, UserStore } from "../auth/users.js";
import { RunAccessDenied } from "../connections/access.js";
import type { McpService } from "../mcp/service.js";
import type { DefaultsService } from "../users/defaults.js";
import type { ScheduleEngine } from "./engine.js";
import { proposalTiming, type ProposalRow, type ScheduleProposalStore } from "./proposals.js";
import {
  ScheduleInputError,
  toRun,
  toSchedule,
  upcoming,
  type NewSchedule,
  type SchedulePatch,
  type ScheduleStore,
} from "./store.js";

export const SCHEDULE_KIND = "schedule";
export const SCHEDULE_PROPOSAL_KIND = "schedule_proposal";

function parse<T extends z.ZodType>(schema: T, value: unknown, reply: FastifyReply): z.infer<T> | undefined {
  const r = schema.safeParse(value);
  if (!r.success) {
    void deny(reply, 400, "invalid_request");
    return undefined;
  }
  return r.data;
}

const noStore = (reply: FastifyReply) => reply.header("Cache-Control", "no-store");

/** Why a schedule cannot be made or changed as asked: the status and the fixed code. */
class Refused extends Error {
  constructor(
    readonly status: 400 | 403 | 409,
    readonly code: string,
    /** More of the answer (e.g. the card as it is now). */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

type SettingsFields = Pick<ChangeSettingsRequest, "runtime" | "model" | "effort" | "useShared">;
const settingsPatch = (b: SettingsFields): ChangeSettingsRequest => {
  const patch: ChangeSettingsRequest = {};
  if (b.runtime !== undefined) patch.runtime = b.runtime;
  if (b.model !== undefined) patch.model = b.model;
  if (b.effort !== undefined) patch.effort = b.effort;
  if (b.useShared !== undefined) patch.useShared = b.useShared;
  return patch;
};

/**
 * The schedule API (#33 engine, #55 screen). Owner only: a schedule's prompt is the owner's content, so the admin is
 * refused like anyone else (FR-1.5). Previews of the next occurrences and of the runtime·model come from the server
 * (`/api/schedules/preview`, `/api/settings/preview`) — the screen computes neither.
 */
export function registerScheduleRoutes(
  app: FastifyInstance,
  deps: {
    store: ScheduleStore;
    proposals: ScheduleProposalStore;
    engine: ScheduleEngine | undefined;
    defaults: DefaultsService;
    users: UserStore;
    mcp: McpService;
    now: () => number;
  },
): void {
  const { store, proposals } = deps;
  app.resources.register(SCHEDULE_KIND, (id) => {
    const s = store.byId(id);
    return s ? { kind: SCHEDULE_KIND, id: s.id, ownerId: s.owner_id, sharedWith: [] } : undefined;
  });
  // A proposal is the owner's too (it carries the prompt): only they see the card's details or confirm it.
  app.resources.register(SCHEDULE_PROPOSAL_KIND, (id) => {
    const p = proposals.byId(id);
    return p ? { kind: SCHEDULE_PROPOSAL_KIND, id: p.id, ownerId: p.owner_id, sharedWith: [] } : undefined;
  });
  const rule = (action: "read" | "write" | "delete") => ({ resource: { kind: SCHEDULE_KIND, action } });
  const proposalRule = (action: "read" | "write") => ({
    resource: { kind: SCHEDULE_PROPOSAL_KIND, action },
  });

  /** Skills from the catalogue that this user may use (#21) — the same check for create, edit and the options. */
  const skillAllowed = (user: UserRow) => {
    const catalogue = new Set(deps.mcp.overview().map((s) => s.name));
    return (s: string) => catalogue.has(s) && deps.mcp.allows(user.id, s);
  };
  const checkSkills = (user: UserRow, skills: readonly string[]) => {
    const ok = skillAllowed(user);
    if (skills.some((s) => !ok(s))) throw new Refused(403, "skill_not_allowed");
  };
  /**
   * Runtime·model·effort (FR-8.2): `patch` on `base` checked exactly like the chip's change (#19) — the same allowed
   * list as a run (403 + its code) — or, with nothing asked, `base` itself (a new schedule: the creator's defaults
   * with the FR-12.6 fallback).
   */
  const settingsFor = (user: UserRow, base: ChatSettings | null, patch: ChangeSettingsRequest) => {
    try {
      const s = Object.keys(patch).length
        ? deps.defaults.change(user, base, patch)
        : (base ?? deps.defaults.start(user)?.settings ?? null);
      if (!s) throw new Refused(409, "no_usable_runtime");
      return s;
    } catch (e) {
      if (e instanceof RunAccessDenied) throw new Refused(403, e.code);
      throw e;
    }
  };
  /** `fixed`: settings already resolved and shown to the user (a confirmed card) — used as they are. */
  const create = (
    user: UserRow,
    s: Omit<NewSchedule, "settings">,
    patch: ChangeSettingsRequest,
    fixed?: ChatSettings,
  ) => {
    checkSkills(user, s.skills);
    const settings = fixed ?? settingsFor(user, null, patch);
    try {
      const row = store.create(user.id, { ...s, skills: [...new Set(s.skills)], settings }, deps.now());
      deps.engine?.kick();
      return row;
    } catch (e) {
      if (e instanceof ScheduleInputError) throw new Refused(400, e.code);
      throw e;
    }
  };
  const caller = (userId: string) => {
    const user = deps.users.byId(userId);
    if (!user) throw new Refused(403, "forbidden");
    return user;
  };
  /** Runs `fn`; a `Refused` becomes its status and code. */
  const answer = (reply: FastifyReply, fn: () => unknown) => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof Refused)
        return noStore(reply)
          .code(e.status)
          .send({ error: e.code, ...e.extra });
      throw e;
    }
  };

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
      return answer(reply, () => {
        const row = create(
          caller(req.ctx.user!.id),
          {
            name: body.name,
            prompt: body.prompt,
            timing: body.timing,
            timeZone: body.timeZone,
            skills: body.skills,
            notify: body.notify,
          },
          settingsPatch(body),
        );
        const out: Schedule = toSchedule(row);
        return noStore(reply).code(201).send(out);
      });
    },
  );

  /** The form's "다음 실행" (#55): the next occurrences, or the 400 code create would answer. Saves nothing. */
  app.post(
    "/api/schedules/preview",
    { config: { noResource: "computes occurrences of the posted timing; reads no stored data" } },
    async (req, reply) => {
      const body = parse(SchedulePreviewRequest, req.body ?? {}, reply);
      if (!body) return reply;
      try {
        const out: SchedulePreviewResponse = {
          next: upcoming(body.timing, body.timeZone, deps.now(), SCHEDULE_PREVIEW_COUNT),
        };
        return noStore(reply).send(out);
      } catch (e) {
        if (e instanceof ScheduleInputError) return noStore(reply).code(400).send({ error: e.code });
        throw e;
      }
    },
  );

  /** What the form may offer (#55): the caller's usable skills. Runtimes come from `/api/runtimes/usable`. */
  app.get(
    "/api/schedules/options",
    { config: { noResource: "the caller's own skill permissions" } },
    async (req, reply) =>
      answer(reply, () => {
        const ok = skillAllowed(caller(req.ctx.user!.id));
        const body: ScheduleOptionsResponse = {
          skills: deps.mcp
            .overview()
            .filter((s) => s.status === "available" && ok(s.name))
            .map((s) => ({ name: s.name })),
        };
        return noStore(reply).send(body);
      }),
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
      return answer(reply, () => {
        const user = caller(req.ctx.user!.id);
        const current = toSchedule(store.byId(req.params.id)!);
        const patch: SchedulePatch = {};
        if (body.name !== undefined) patch.name = body.name;
        if (body.prompt !== undefined) patch.prompt = body.prompt;
        if (body.timing !== undefined) patch.timing = body.timing;
        if (body.timeZone !== undefined) patch.timeZone = body.timeZone;
        if (body.notify !== undefined) patch.notify = body.notify;
        if (body.paused !== undefined) patch.paused = body.paused;
        if (body.skills !== undefined) {
          checkSkills(user, body.skills);
          patch.skills = [...new Set(body.skills)];
        }
        const change = settingsPatch(body);
        if (Object.keys(change).length) patch.settings = settingsFor(user, current.settings, change);
        try {
          const row = store.update(req.params.id, patch, deps.now());
          deps.engine?.kick();
          return noStore(reply).send(toSchedule(row!));
        } catch (e) {
          if (e instanceof ScheduleInputError) throw new Refused(400, e.code);
          throw e;
        }
      });
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
      const body: ScheduleRunsResponse = { runs: store.runsWithCost(req.params.id).map(toRun) };
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

  // ---- proposals from a conversation (#55, FR-8.1): the `schedule_create` tool's confirmation card ----

  const toProposal = (p: ProposalRow, user: UserRow): ScheduleProposal => {
    const timing = proposalTiming(p) ?? { type: "once" as const, date: "1970-01-01", time: "00:00" };
    let next: number[] = [];
    try {
      next = upcoming(timing, p.time_zone, deps.now(), SCHEDULE_PREVIEW_COUNT);
    } catch (e) {
      if (!(e instanceof ScheduleInputError)) throw e;
    }
    const skills = JSON.parse(p.skills) as string[];
    const settings = p.status === "proposed" ? (deps.defaults.start(user)?.settings ?? null) : null;
    // What the card shows and confirm would make (the next runs move with the clock and are left out).
    const version = crypto
      .createHash("sha256")
      .update(
        JSON.stringify([p.id, p.status, p.name, p.prompt, timing, p.time_zone, skills, !!p.notify, settings]),
      )
      .digest("base64url");
    return {
      id: p.id,
      status: p.status,
      name: p.name,
      prompt: p.prompt,
      timing,
      timeZone: p.time_zone,
      skills,
      notify: !!p.notify,
      settings,
      next,
      scheduleId: p.schedule_id,
      createdAt: p.created_at,
      version,
    };
  };

  app.get<{ Params: { id: string } }>(
    "/api/schedule-proposals/:id",
    { config: proposalRule("read") },
    async (req, reply) =>
      answer(reply, () =>
        noStore(reply).send(toProposal(proposals.byId(req.params.id)!, caller(req.ctx.user!.id))),
      ),
  );

  /**
   * The card's "만들기": the schedule is made here — by its owner's own request, with the same checks as
   * `POST /api/schedules` (skills, the creator's defaults) — once. Again: 200 with the same schedule. It makes exactly
   * what the pressed card showed (`version`, review #108): when the defaults or what is allowed changed since, the
   * runtime·model would differ → 409 `proposal_changed` with the card as it is now, nothing made.
   */
  app.post<{ Params: { id: string } }>(
    "/api/schedule-proposals/:id/confirm",
    { config: proposalRule("write") },
    async (req, reply) =>
      answer(reply, () => {
        const asked = parse(ConfirmScheduleProposalRequest, req.body ?? {}, reply);
        if (!asked) return reply;
        const user = caller(req.ctx.user!.id);
        const at = deps.now();
        const r = proposals.confirm(
          req.params.id,
          (p) => {
            const timing = proposalTiming(p);
            if (!timing) throw new Refused(400, "invalid_request");
            const now = toProposal(p, user);
            if (!now.settings) throw new Refused(409, "no_usable_runtime");
            if (now.version !== asked.version) throw new Refused(409, "proposal_changed", { proposal: now });
            return create(
              user,
              {
                name: p.name,
                prompt: p.prompt,
                timing,
                timeZone: p.time_zone,
                skills: JSON.parse(p.skills) as string[],
                notify: !!p.notify,
              },
              {},
              now.settings,
            ).id;
          },
          at,
        );
        const p = proposals.byId(req.params.id)!;
        const row = r.scheduleId ? store.byId(r.scheduleId) : undefined;
        if (!row) throw new Refused(409, p.status === "dismissed" ? "proposal_dismissed" : "proposal_gone");
        const body: ConfirmScheduleProposalResponse = {
          proposal: toProposal(p, user),
          schedule: toSchedule(row),
        };
        return noStore(reply)
          .code(r.made ? 201 : 200)
          .send(body);
      }),
  );

  /** The card's "취소": nothing is made; a confirmed proposal stays confirmed (409). */
  app.post<{ Params: { id: string } }>(
    "/api/schedule-proposals/:id/dismiss",
    { config: proposalRule("write") },
    async (req, reply) =>
      answer(reply, () => {
        const user = caller(req.ctx.user!.id);
        const p0 = proposals.byId(req.params.id)!;
        if (p0.status === "confirmed") throw new Refused(409, "proposal_confirmed");
        proposals.dismiss(req.params.id, deps.now());
        return noStore(reply).send(toProposal(proposals.byId(req.params.id)!, user));
      }),
  );
}
