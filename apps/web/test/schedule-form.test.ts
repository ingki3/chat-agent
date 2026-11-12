import { describe, expect, it } from "vitest";
import type { ChatSettings, Schedule } from "@agentlee/shared";
import { ChipChoice } from "../src/chat/chip.js";
import { saveSchedule, skillRows, type FormValues } from "../src/schedules/form.js";
import { cardNotice, changedProposal, type CardEvent, type CardNotice } from "../src/schedules/format.js";

/** Review #108: a save waits for the chip's choice; the skill rows keep a revoked skill visible to remove it. */

const LARGE: ChatSettings = {
  runtime: "claude-code",
  model: "fake-large",
  effort: "medium",
  useShared: false,
};
const SMALL: ChatSettings = { runtime: "claude-code", model: "fake-small", effort: null, useShared: false };
const values: FormValues = {
  name: "아침 브리핑",
  prompt: "관심 종목",
  timing: { type: "daily", time: "08:00" },
  timeZone: "Asia/Seoul",
  skills: [],
  notify: true,
};
const schedule: Schedule = {
  id: "s1",
  ...values,
  settings: LARGE,
  paused: false,
  nextRunAt: 1,
  conversationId: null,
  createdAt: 1,
  updatedAt: 1,
};

/** A preview the test answers by hand, and an API that records what was sent. */
function setup() {
  const previews: { resolve: (s: ChatSettings) => void; reject: (e: Error) => void }[] = [];
  const choice = new ChipChoice<ChatSettings>(
    () => new Promise<ChatSettings>((resolve, reject) => previews.push({ resolve, reject })),
  );
  const sent: { kind: "create" | "update"; body: object }[] = [];
  const api = {
    create: async (body: object) => (sent.push({ kind: "create", body }), schedule),
    update: async (_id: string, body: object) => (sent.push({ kind: "update", body }), schedule),
  };
  return { previews, choice, sent, api };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("saveSchedule waits for the chip's choice (review #108)", () => {
  it("create: the first change's preview is still on its way → nothing is sent until it arrives, then with it", async () => {
    const t = setup();
    void t.choice.change(LARGE, { model: "fake-small" }).catch(() => {});
    const saving = saveSchedule(values, undefined, t.choice, t.api);
    await tick();
    await tick();
    expect(t.sent).toEqual([]);
    t.previews[0]!.resolve(SMALL);
    await saving;
    expect(t.sent).toEqual([
      {
        kind: "create",
        body: { ...values, runtime: "claude-code", model: "fake-small", useShared: false },
      },
    ]);
  });

  it("create and edit: the first preview fails → the save fails and no request is sent", async () => {
    for (const editing of [undefined, schedule]) {
      const t = setup();
      void t.choice.change(LARGE, { model: "fake-small" }).catch(() => {});
      const saving = saveSchedule({ ...values, name: "바뀐 이름" }, editing, t.choice, t.api);
      await tick();
      expect(t.sent).toEqual([]);
      t.previews[0]!.reject(new Error("model_not_allowed"));
      await expect(saving).rejects.toThrow("model_not_allowed");
      expect(t.sent).toEqual([]);
    }
  });

  it("edit: a delayed preview is waited for; only changed fields go out", async () => {
    const t = setup();
    void t.choice.change(LARGE, { model: "fake-small" }).catch(() => {});
    const saving = saveSchedule({ ...values, name: "새 이름" }, schedule, t.choice, t.api);
    await tick();
    expect(t.sent).toEqual([]);
    t.previews[0]!.resolve(SMALL);
    await saving;
    expect(t.sent).toEqual([
      {
        kind: "update",
        body: { runtime: "claude-code", model: "fake-small", useShared: false, name: "새 이름" },
      },
    ]);
  });

  it("the chip not touched: no runtime·model is sent (the server's defaults)", async () => {
    const t = setup();
    await saveSchedule(values, undefined, t.choice, t.api);
    expect(t.sent).toEqual([{ kind: "create", body: values }]);
  });
});

describe("skill rows (review #108)", () => {
  it("lists a revoked skill of the schedule as unavailable: checked to remove, not selectable once removed", () => {
    const allowed = ["kr-stock-skill", "us-stock-skill"];
    const own = ["old-skill", "kr-stock-skill"];
    expect(skillRows(allowed, own, own)).toEqual([
      { name: "kr-stock-skill", available: true, checked: true, disabled: false },
      { name: "us-stock-skill", available: true, checked: false, disabled: false },
      { name: "old-skill", available: false, checked: true, disabled: false },
    ]);
    // Removed, another allowed one picked: the revoked one stays visible but cannot be picked again.
    expect(skillRows(allowed, ["kr-stock-skill", "us-stock-skill"], own)).toEqual([
      { name: "kr-stock-skill", available: true, checked: true, disabled: false },
      { name: "us-stock-skill", available: true, checked: true, disabled: false },
      { name: "old-skill", available: false, checked: false, disabled: true },
    ]);
    expect(skillRows(allowed, [], [])).toHaveLength(2);
  });
});

describe("a confirm refused because the card changed (review #108)", () => {
  it("gives the card as it is now, only for proposal_changed", () => {
    const proposal = {
      id: "p",
      status: "proposed",
      name: "n",
      prompt: "p",
      timing: { type: "daily", time: "08:00" },
      timeZone: "Asia/Seoul",
      skills: [],
      notify: true,
      settings: SMALL,
      next: [1],
      scheduleId: null,
      createdAt: 1,
      version: "v2",
    };
    expect(changedProposal({ error: "proposal_changed", proposal })).toEqual(proposal);
    expect(changedProposal({ error: "no_usable_runtime" })).toBeUndefined();
    expect(changedProposal(undefined)).toBeUndefined();
  });
});

describe("the card's message (review #108 2차)", () => {
  const run = (events: CardEvent[]) => events.reduce<CardNotice>(cardNotice, null);
  it("a dismiss after a 409 clears “다시 눌러 주세요”; a failed dismiss shows its own error", () => {
    expect(run([{ type: "start" }, { type: "changed" }])).toEqual({ kind: "changed" });
    // 409, then 취소 succeeds: no stale "press again".
    expect(run([{ type: "start" }, { type: "changed" }, { type: "start" }, { type: "ok" }])).toBeNull();
    // 409, then 취소 fails: its error is shown (not hidden behind the old notice).
    const err = new Error("dismiss failed");
    expect(
      run([{ type: "start" }, { type: "changed" }, { type: "start" }, { type: "error", error: err }]),
    ).toEqual({
      kind: "error",
      error: err,
    });
    // A confirm error, then a new press: cleared while it is on its way.
    expect(run([{ type: "error", error: err }, { type: "start" }])).toBeNull();
  });
});
