import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfirmScheduleProposalResponse,
  CSRF_HEADER,
  Schedule,
  ScheduleProposal,
  ScheduleRun,
  SchedulePreviewResponse,
  type MessagePart,
} from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { RuntimeRegistry } from "../src/runtime/adapter.js";
import { FakeRuntime, scheduleSteps } from "../src/runtime/fake.js";
import { FakeScheduleHandler } from "../src/schedules/fake.js";
import { nextOccurrence } from "../src/schedules/time.js";
import { knownSecrets } from "../src/secrets/known.js";
import { createFamily, type Family } from "./helpers/permission-matrix.js";

/**
 * #55: the schedule screen's API (edit, preview, options, history with cost) and `schedule_create` → the
 * confirmation card → a schedule made only by the owner's confirm (PRD FR-8.1·8.2·8.5, FR-12.2).
 */
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const SEOUL = "Asia/Seoul";
const create = { name: "아침 브리핑", prompt: "관심 종목", timing: { type: "daily", time: "08:00" } };
type Who = keyof Family["cookies"];

async function start() {
  const runtimes = new RuntimeRegistry();
  // Runs get our MCP server (as the FAKE_RUNTIME=1 server): `schedule_create` is really called.
  runtimes.register(new FakeRuntime({ runTools: true }));
  const db = createTestDb();
  const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
    db,
    logger: false,
    runtimes,
    runs: { flushMs: 0 },
    schedules: { handler: new FakeScheduleHandler() },
  });
  closers.push(() => app.close());
  await app.ready();
  const f = await createFamily(app);
  const req = (who: Who, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: object) =>
    app.inject({
      method,
      url,
      headers: {
        host: "localhost:3000",
        cookie: f.cookies[who],
        ...(method === "GET" ? {} : { origin: "http://localhost:3000", [CSRF_HEADER]: "1" }),
      },
      ...(method === "GET" ? {} : { payload: body ?? {} }),
    });
  const policy = (p: { models?: "all" | string[]; efforts?: "all" | string[] }) =>
    app.connections!.store.setPolicy(f.users.owner.id, {
      runtime: "claude-code",
      allowed: true,
      models: p.models ?? "all",
      efforts: p.efforts ?? "all",
      allowPersonal: true,
      allowShared: true,
    });
  /** Sends `text` in a new conversation of the owner; the reply's parts once the run has ended. */
  const chat = async (text: string) => {
    const c = (await req("owner", "POST", "/api/conversations", {})).json<{ id: string }>();
    const r = await req("owner", "POST", `/api/conversations/${c.id}/messages`, { text });
    expect(r.statusCode).toBe(201);
    const runId = r.json<{ run: { id: string } }>().run.id;
    for (let i = 0; i < 400; i++) {
      if (app.runs!.get(runId)?.endedAt) break;
      await new Promise((res) => setTimeout(res, 5));
    }
    const items = (await req("owner", "GET", `/api/conversations/${c.id}/messages`)).json<{
      items: { parts: MessagePart[] }[];
    }>().items;
    return { conversationId: c.id, parts: items.at(-1)!.parts };
  };
  const proposalOf = (parts: MessagePart[]) => {
    const r = parts.find((p) => p.type === "tool_result");
    if (r?.type !== "tool_result") throw new Error("no tool result");
    return { output: r.output as { proposalId?: string; error?: string }, isError: !!r.isError };
  };
  return { app, db, f, req, policy, chat, proposalOf };
}

describe("schedule screen API (#55)", () => {
  it("a new schedule takes the creator's defaults; a model that is not allowed is 403 on create and edit", async () => {
    const t = await start();
    const made = await t.req("owner", "POST", "/api/schedules", create);
    expect(made.statusCode).toBe(201);
    const s = Schedule.parse(made.json());
    expect(s.settings).toMatchObject({ runtime: "claude-code", model: "fake-large" });
    // The admin narrows the owner's models: fake-small is not allowed any more.
    t.policy({ models: ["fake-large"] });
    const bad = await t.req("owner", "POST", "/api/schedules", { ...create, model: "fake-small" });
    expect([bad.statusCode, bad.json()]).toEqual([403, { error: "model_not_allowed" }]);
    const edit = await t.req("owner", "PATCH", `/api/schedules/${s.id}`, { model: "fake-small", name: "x" });
    expect([edit.statusCode, edit.json()]).toEqual([403, { error: "model_not_allowed" }]);
    // Nothing changed — not even the name sent along.
    const same = Schedule.parse((await t.req("owner", "GET", `/api/schedules/${s.id}`)).json());
    expect([same.name, same.settings.model]).toEqual(["아침 브리핑", "fake-large"]);
    // Allowed again: the change goes through, its default effort with it (the chip's rules).
    t.policy({});
    const ok = Schedule.parse(
      (await t.req("owner", "PATCH", `/api/schedules/${s.id}`, { model: "fake-small" })).json(),
    );
    expect(ok.settings).toMatchObject({ model: "fake-small", effort: null });
    const effort = await t.req("owner", "PATCH", `/api/schedules/${s.id}`, { effort: "high" });
    expect([effort.statusCode, effort.json()]).toEqual([403, { error: "effort_not_allowed" }]);
  });

  it("edit: every field, the next run moves with the timing, skills and timing are checked, text is scrubbed", async () => {
    const t = await start();
    const s = Schedule.parse((await t.req("owner", "POST", "/api/schedules", create)).json());
    const secret = `sk-edit-${crypto.randomBytes(12).toString("base64url")}`;
    knownSecrets.add(secret);
    const r = await t.req("owner", "PATCH", `/api/schedules/${s.id}`, {
      name: "저녁 정리",
      prompt: `오늘 정리 ${secret}`,
      timing: { type: "weekly", time: "19:30", weekdays: [5, 1, 1] },
      timeZone: "America/New_York",
      notify: false,
    });
    expect(r.statusCode).toBe(200);
    const e = Schedule.parse(r.json());
    expect(e).toMatchObject({
      name: "저녁 정리",
      timing: { type: "weekly", time: "19:30", weekdays: [1, 5] },
      timeZone: "America/New_York",
      notify: false,
    });
    expect(e.prompt).not.toContain(secret);
    expect(e.nextRunAt).toBe(
      nextOccurrence({ type: "weekly", time: "19:30", weekdays: [1, 5] }, "America/New_York", Date.now()),
    );
    for (const [body, status, code] of [
      [{ timing: { type: "once", date: "2020-01-01", time: "08:00" } }, 400, "schedule_in_past"],
      [{ timing: { type: "cron", cron: "99 * * * *" } }, 400, "cron_invalid"],
      [{ timeZone: "Mars/Base" }, 400, "invalid_time_zone"],
      [{ skills: ["nope"] }, 403, "skill_not_allowed"],
      [{}, 400, "invalid_request"],
    ] as const) {
      const x = await t.req("owner", "PATCH", `/api/schedules/${s.id}`, body);
      expect([x.statusCode, x.json().error]).toEqual([status, code]);
    }
    // Paused, then a new timing: still paused (no next run); resumed: from now.
    await t.req("owner", "PATCH", `/api/schedules/${s.id}`, { paused: true });
    const p = Schedule.parse(
      (
        await t.req("owner", "PATCH", `/api/schedules/${s.id}`, { timing: { type: "daily", time: "06:00" } })
      ).json(),
    );
    expect([p.paused, p.nextRunAt]).toEqual([true, null]);
    const on = Schedule.parse(
      (await t.req("owner", "PATCH", `/api/schedules/${s.id}`, { paused: false })).json(),
    );
    expect(on.nextRunAt).toBe(
      nextOccurrence({ type: "daily", time: "06:00" }, "America/New_York", Date.now()),
    );
  });

  it("preview: the server's next three runs, or create's 400 code; options: the skills the caller may use", async () => {
    const t = await start();
    const r = await t.req("owner", "POST", "/api/schedules/preview", {
      timing: { type: "cron", cron: "0 8 * * 1-5" },
    });
    expect(r.statusCode).toBe(200);
    const { next } = SchedulePreviewResponse.parse(r.json());
    expect(next).toHaveLength(3);
    let at = Date.now();
    for (const n of next) {
      at = nextOccurrence({ type: "cron", cron: "0 8 * * 1-5" }, SEOUL, at)!;
      expect(n).toBe(at);
    }
    for (const [timing, code] of [
      [{ type: "cron", cron: "0 0 31 2 *" }, "schedule_never"],
      [{ type: "once", date: "2020-01-01", time: "08:00" }, "schedule_in_past"],
    ] as const) {
      const x = await t.req("owner", "POST", "/api/schedules/preview", { timing });
      expect([x.statusCode, x.json().error]).toEqual([400, code]);
    }
    const once = SchedulePreviewResponse.parse(
      (
        await t.req("owner", "POST", "/api/schedules/preview", {
          timing: { type: "once", date: "2099-01-01", time: "08:00" },
        })
      ).json(),
    );
    expect(once.next).toHaveLength(1);
    const opts = await t.req("owner", "GET", "/api/schedules/options");
    expect(opts.statusCode).toBe(200);
    const names = (opts.json() as { skills: { name: string }[] }).skills.map((s) => s.name);
    // Every offered skill passes create's check.
    for (const name of names)
      expect((await t.req("owner", "POST", "/api/schedules", { ...create, skills: [name] })).statusCode).toBe(
        201,
      );
  });

  it("the run history shows each run's priced cost, null when nothing priced was recorded", async () => {
    const t = await start();
    const s = Schedule.parse((await t.req("owner", "POST", "/api/schedules", create)).json());
    const first = ScheduleRun.parse((await t.req("owner", "POST", `/api/schedules/${s.id}/run`)).json().run);
    expect(first.costUsd).toBeNull();
    const usage = (runId: string, attempt: number, micros: number | null, authType: string) =>
      t.db.$client
        .prepare(
          `insert into usage_records (user_id, run_id, attempt, runtime, model, purpose, created_at, updated_at,
             auth_type, priced_cost_micros) values (?, ?, ?, 'claude-code', 'fake-large', 'schedule', 1, 1, ?, ?)`,
        )
        .run(t.f.users.owner.id, runId, attempt, authType, micros);
    usage(first.id, 1, 12_345, "api_key");
    usage(first.id, 2, 5, "api_key");
    usage(first.id, 3, null, "subscription");
    const runs = (await t.req("owner", "GET", `/api/schedules/${s.id}/runs`)).json().runs as unknown[];
    expect(ScheduleRun.parse(runs[0]).costUsd).toBeCloseTo(0.01235, 8);
    // Someone else's run id does not leak into it, and only the owner reads the history.
    expect((await t.req("admin", "GET", `/api/schedules/${s.id}/runs`)).statusCode).toBe(403);
  });
});

describe("schedule_create → confirmation card → created only on the owner's confirm (#55, FR-8.1)", () => {
  it("the fake runtime understands the e2e request", () => {
    const steps = scheduleSteps("매일 아침 8시 관심 종목 브리핑")!;
    expect(steps.find((s) => "call" in s)).toEqual({
      call: "schedule_create",
      input: {
        name: "아침 관심 종목 브리핑",
        prompt: "관심 종목 브리핑해줘",
        timing: { type: "daily", time: "08:00" },
        timeZone: SEOUL,
      },
    });
    expect(scheduleSteps("평일 저녁 7시 30분에 환율 알려줘")!.find((s) => "call" in s)).toMatchObject({
      input: { timing: { type: "weekdays", time: "19:30" } },
    });
    expect(scheduleSteps("안녕")).toBeUndefined();
    expect(scheduleSteps("매일 아침 8시 운동")).toBeUndefined();
  });

  it("proposes without creating; only the owner sees and confirms the card; confirm makes one schedule, once", async () => {
    const t = await start();
    const { parts } = await t.chat("매일 아침 8시 관심 종목 브리핑");
    const call = parts.find((p) => p.type === "tool_call");
    expect(call).toMatchObject({ name: "mcp__agentlee__schedule_create" });
    const { output, isError } = t.proposalOf(parts);
    expect(isError).toBe(false);
    const id = output.proposalId!;
    // Nothing is scheduled by the tool itself.
    expect((await t.req("owner", "GET", "/api/schedules")).json().schedules).toEqual([]);
    expect(t.app.schedules!.store.listFor(t.f.users.owner.id)).toEqual([]);

    const card = ScheduleProposal.parse(
      (await t.req("owner", "GET", `/api/schedule-proposals/${id}`)).json(),
    );
    expect(card).toMatchObject({
      status: "proposed",
      name: "아침 관심 종목 브리핑",
      timing: { type: "daily", time: "08:00" },
      timeZone: SEOUL,
      notify: true,
      settings: { runtime: "claude-code", model: "fake-large" },
      scheduleId: null,
    });
    expect(card.next[0]).toBe(nextOccurrence({ type: "daily", time: "08:00" }, SEOUL, Date.now()));

    // Owner only — the admin and anyone else are refused, and their confirm makes nothing.
    for (const who of ["admin", "stranger", "shared"] as const) {
      expect((await t.req(who, "GET", `/api/schedule-proposals/${id}`)).statusCode).toBe(403);
      expect(
        (await t.req(who, "POST", `/api/schedule-proposals/${id}/confirm`, { version: card.version }))
          .statusCode,
      ).toBe(403);
      expect((await t.req(who, "POST", `/api/schedule-proposals/${id}/dismiss`)).statusCode).toBe(403);
    }
    expect(t.app.schedules!.store.listFor(t.f.users.owner.id)).toEqual([]);
    expect(t.app.schedules!.store.listFor(t.f.users.admin.id)).toEqual([]);

    // Without the card's version nothing is made.
    const bare = await t.req("owner", "POST", `/api/schedule-proposals/${id}/confirm`);
    expect([bare.statusCode, bare.json().error]).toEqual([400, "invalid_request"]);
    const ok = await t.req("owner", "POST", `/api/schedule-proposals/${id}/confirm`, {
      version: card.version,
    });
    expect(ok.statusCode).toBe(201);
    const made = ConfirmScheduleProposalResponse.parse(ok.json());
    expect(made.schedule).toMatchObject({
      name: "아침 관심 종목 브리핑",
      prompt: "관심 종목 브리핑해줘",
      settings: { runtime: "claude-code", model: "fake-large" },
      notify: true,
    });
    expect(made.proposal).toMatchObject({ status: "confirmed", scheduleId: made.schedule.id });
    // Confirming again (another tab, a reload) gives the same schedule, never a second one.
    const again = await t.req("owner", "POST", `/api/schedule-proposals/${id}/confirm`, {
      version: card.version,
    });
    expect([again.statusCode, again.json().schedule.id]).toEqual([200, made.schedule.id]);
    expect((await t.req("owner", "GET", "/api/schedules")).json().schedules).toHaveLength(1);
    const dismiss = await t.req("owner", "POST", `/api/schedule-proposals/${id}/dismiss`);
    expect([dismiss.statusCode, dismiss.json().error]).toEqual([409, "proposal_confirmed"]);
  });

  it("a dismissed proposal is never created; confirm uses the defaults checked at that moment", async () => {
    const t = await start();
    const a = t.proposalOf((await t.chat("매일 아침 8시 관심 종목 브리핑")).parts).output.proposalId!;
    const d = await t.req("owner", "POST", `/api/schedule-proposals/${a}/dismiss`);
    expect(ScheduleProposal.parse(d.json()).status).toBe("dismissed");
    const c = await t.req("owner", "POST", `/api/schedule-proposals/${a}/confirm`, { version: "any" });
    expect([c.statusCode, c.json().error]).toEqual([409, "proposal_dismissed"]);
    expect(t.app.schedules!.store.listFor(t.f.users.owner.id)).toEqual([]);
    // Defaults that are not usable at confirm time: no schedule (409), and the proposal stays open.
    const b = t.proposalOf((await t.chat("매일 아침 8시 관심 종목 브리핑")).parts).output.proposalId!;
    t.app.connections!.store.setPolicy(t.f.users.owner.id, {
      runtime: "claude-code",
      allowed: false,
      models: "all",
      efforts: "all",
      allowPersonal: true,
      allowShared: true,
    });
    const refused = await t.req("owner", "POST", `/api/schedule-proposals/${b}/confirm`, { version: "any" });
    expect([refused.statusCode, refused.json().error]).toEqual([409, "no_usable_runtime"]);
    expect(
      ScheduleProposal.parse((await t.req("owner", "GET", `/api/schedule-proposals/${b}`)).json()).status,
    ).toBe("proposed");
    expect(t.app.schedules!.store.listFor(t.f.users.owner.id)).toEqual([]);
  });

  it("confirm makes what the card showed: defaults changed since → 409 with the card as it is now (review #108)", async () => {
    const t = await start();
    const id = t.proposalOf((await t.chat("매일 아침 8시 관심 종목 브리핑")).parts).output.proposalId!;
    const shown = ScheduleProposal.parse(
      (await t.req("owner", "GET", `/api/schedule-proposals/${id}`)).json(),
    );
    expect(shown.settings).toMatchObject({ model: "fake-large", effort: "medium" });
    // The owner changes their defaults in another tab.
    const set = await t.req("owner", "PUT", "/api/settings/defaults", {
      defaults: { runtime: "claude-code", models: { "claude-code": { model: "fake-small", effort: null } } },
    });
    expect(set.statusCode).toBe(200);
    const stale = await t.req("owner", "POST", `/api/schedule-proposals/${id}/confirm`, {
      version: shown.version,
    });
    expect([stale.statusCode, stale.json().error]).toEqual([409, "proposal_changed"]);
    const fresh = ScheduleProposal.parse(stale.json().proposal);
    expect(fresh.settings).toMatchObject({ model: "fake-small", effort: null });
    expect(fresh.version).not.toBe(shown.version);
    expect(t.app.schedules!.store.listFor(t.f.users.owner.id)).toEqual([]);
    // Pressed again on the refreshed card: made with exactly that.
    const ok = await t.req("owner", "POST", `/api/schedule-proposals/${id}/confirm`, {
      version: fresh.version,
    });
    expect(ok.statusCode).toBe(201);
    expect(ConfirmScheduleProposalResponse.parse(ok.json()).schedule.settings).toEqual(fresh.settings);
  });

  it("confirm makes what the card showed: a policy narrowed since (fallback) → 409, nothing made", async () => {
    const t = await start();
    const id = t.proposalOf((await t.chat("매일 아침 8시 관심 종목 브리핑")).parts).output.proposalId!;
    const shown = ScheduleProposal.parse(
      (await t.req("owner", "GET", `/api/schedule-proposals/${id}`)).json(),
    );
    expect(shown.settings).toMatchObject({ model: "fake-large" });
    t.policy({ models: ["fake-small"] });
    const stale = await t.req("owner", "POST", `/api/schedule-proposals/${id}/confirm`, {
      version: shown.version,
    });
    expect([stale.statusCode, stale.json().error]).toEqual([409, "proposal_changed"]);
    expect(ScheduleProposal.parse(stale.json().proposal).settings).toMatchObject({ model: "fake-small" });
    expect(t.app.schedules!.store.listFor(t.f.users.owner.id)).toEqual([]);
    // Unchanged card (same defaults, same policy) still confirms with its version.
    const now = ScheduleProposal.parse((await t.req("owner", "GET", `/api/schedule-proposals/${id}`)).json());
    expect(
      (await t.req("owner", "POST", `/api/schedule-proposals/${id}/confirm`, { version: now.version }))
        .statusCode,
    ).toBe(201);
  });

  it("edit: a skill whose permission was revoked can be removed, and the save then goes through with an allowed one", async () => {
    const t = await start();
    const names = (
      (await t.req("owner", "GET", "/api/schedules/options")).json() as { skills: { name: string }[] }
    ).skills.map((s) => s.name);
    expect(names.length).toBeGreaterThanOrEqual(2);
    const [revoked, kept] = [names[0]!, names[1]!];
    const s = Schedule.parse(
      (await t.req("owner", "POST", "/api/schedules", { ...create, skills: [revoked] })).json(),
    );
    const off = await t.req("admin", "PUT", `/api/admin/users/${t.f.users.owner.id}/skills/${revoked}`, {
      enabled: false,
    });
    expect(off.statusCode).toBe(200);
    const after = (
      (await t.req("owner", "GET", "/api/schedules/options")).json() as { skills: { name: string }[] }
    ).skills.map((x) => x.name);
    expect(after).not.toContain(revoked);
    // Keeping it is refused; a change that leaves the skills alone is not.
    const keep = await t.req("owner", "PATCH", `/api/schedules/${s.id}`, { skills: [revoked, kept] });
    expect([keep.statusCode, keep.json().error]).toEqual([403, "skill_not_allowed"]);
    expect((await t.req("owner", "PATCH", `/api/schedules/${s.id}`, { name: "새 이름" })).statusCode).toBe(
      200,
    );
    const removed = await t.req("owner", "PATCH", `/api/schedules/${s.id}`, { skills: [kept] });
    expect(removed.statusCode).toBe(200);
    expect(Schedule.parse(removed.json()).skills).toEqual([kept]);
  });

  it("the tool refuses what create would refuse, and proposes only into the run's own conversation", async () => {
    const t = await start();
    const scope = { userId: t.f.users.owner.id, conversationId: "", runId: "r" };
    const convo = t.app.conversations!.create(t.f.users.owner.id);
    scope.conversationId = convo.id;
    const mcp = t.app.mcp! as unknown as {
      callScheduleTool: (i: Record<string, unknown>, s: typeof scope) => { ok: boolean; code?: string };
    };
    const call = (input: Record<string, unknown>, s = scope) => mcp.callScheduleTool(input, s);
    const base = { name: "n", prompt: "p", timing: { type: "daily", time: "08:00" } };
    expect(call(base)).toMatchObject({ ok: true });
    expect(call({ ...base, skills: ["nope"] })).toEqual({ ok: false, code: "skill_not_allowed" });
    expect(call({ ...base, timing: { type: "once", date: "2020-01-01", time: "08:00" } })).toEqual({
      ok: false,
      code: "schedule_in_past",
    });
    expect(call({ ...base, runtime: "codex" })).toEqual({ ok: false, code: "schedule_bad_input" });
    expect(call(base, { ...scope, userId: t.f.users.stranger.id })).toEqual({
      ok: false,
      code: "schedule_not_allowed",
    });
    // The tool is offered to every runtime's run (our MCP server's tool list).
    expect(t.app.mcp!.toolNamesFor(t.f.users.owner.id)).toContain("schedule_create");
  });
});
