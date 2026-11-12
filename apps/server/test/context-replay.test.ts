import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeRegistry, type ModelCapability } from "../src/runtime/adapter.js";
import { CLAUDE_MODELS, ClaudeAdapter } from "../src/runtime/claude.js";
import { CODEX_MODELS, CodexAdapter } from "../src/runtime/codex.js";
import { SUMMARY_DIVIDER, SUMMARY_MARKER, type ContextOptions } from "../src/runtime/context.js";
import type { RunRow } from "../src/runtime/runs.js";
import { replayQuery, sdk, type ReplayLog } from "./helpers/claude-replay.js";
import { cx, newLog, replaySpawn, type ReplayLog as CodexLog } from "./helpers/codex-replay.js";
import { CLAUDE_KEY, CODEX_KEY, startContextApp, textOf, type Entry } from "./helpers/context-harness.js";

/**
 * #45 completion criterion with both real runtimes' recorded protocols (the Claude Agent SDK replay, the codex
 * app-server replay): Claude → Codex → Claude, edit and resend, regenerate, a connection change, a model-only
 * change and resuming after a summary. For each run, what the runtime knew right before the turn is rebuilt from
 * what the adapter really sent — the system prompt / developer instructions of a fresh session (parsed back), and
 * for a resumed one the turns that session had before — and compared with the server's original (`original`).
 */

const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "context-replay-"));
  closers.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

const SUMMARY_TEXT = "요약: 사용자는 관심 종목을 삼성전자로, 목표가를 정했다.";
/** What the recorded runtime answers to a prompt (a summary request gets the summary). */
const answerFor = (prompt: string) =>
  prompt.startsWith(SUMMARY_MARKER) ? SUMMARY_TEXT : `알겠어요: ${prompt}`;

/** A recording that has an answer for every prompt (a recorded runtime that answers anything the same way). */
const anyPrompt = <T>(turn: (prompt: string) => T) =>
  new Proxy({} as Record<string, T>, {
    get: (_t, k) => (typeof k === "string" ? turn(k) : undefined),
    has: () => true,
  });

const ROLE: Record<string, string> = { 사용자: "user", assistant: "assistant", system: "system" };
/** `renderPriorContext` read back: the summary and each message, as the runtime got them. */
function parsePrior(text: string | null | undefined): Entry[] {
  const m = /<earlier_conversation>\n([\s\S]*?)\n<\/earlier_conversation>/.exec(text ?? "");
  if (!m) return [];
  let body = m[1]!;
  const out: Entry[] = [];
  const s = /^<summary>\n([\s\S]*?)\n<\/summary>\n?\n?/.exec(body);
  if (s) {
    out.push({ role: "summary", text: s[1]! });
    body = body.slice(s[0].length);
  }
  for (const block of body.split(/\n\n(?=\[(?:사용자|assistant|system)\]\n)/)) {
    const b = /^\[(사용자|assistant|system)\]\n([\s\S]*)$/.exec(block);
    if (b) out.push({ role: ROLE[b[1]!]!, text: b[2]! });
  }
  return out;
}

type Turn = { sessionId: string; fresh: boolean; model: string; input: string; before: Entry[] };

/** Turns of the Claude adapter, from the options and prompts it gave the SDK. */
function claudeTurns(log: ReplayLog): Turn[] {
  const known = new Map<string, Entry[]>();
  return log.options.map((o, i) => {
    const fresh = o.sessionId !== undefined;
    const sessionId = (o.sessionId ?? o.resume)!;
    const prompt = log.prompts[i]!;
    if (fresh) known.set(sessionId, parsePrior(o.systemPrompt as string));
    const k = known.get(sessionId) ?? [];
    const turn = { sessionId, fresh, model: o.model!, input: prompt, before: [...k] };
    k.push({ role: "user", text: prompt }, { role: "assistant", text: answerFor(prompt) });
    known.set(sessionId, k);
    return turn;
  });
}

/** Turns of the Codex adapter, from the JSON-RPC requests it sent the app-server. */
function codexTurns(log: CodexLog): Turn[] {
  const known = new Map<string, Entry[]>();
  const turns: Turn[] = [];
  let started: Entry[] | undefined;
  for (const r of log.requests) {
    if (r.method === "thread/start") started = parsePrior(r.params.developerInstructions as string | null);
    else if (r.method === "thread/resume") started = undefined;
    else if (r.method === "turn/start") {
      const sessionId = String(r.params.threadId);
      const prompt = String((r.params.input as { text: string }[])[0]!.text);
      const fresh = started !== undefined;
      if (started) known.set(sessionId, started);
      started = undefined;
      const k = known.get(sessionId) ?? [];
      turns.push({ sessionId, fresh, model: String(r.params.model), input: prompt, before: [...k] });
      k.push({ role: "user", text: prompt }, { role: "assistant", text: answerFor(prompt) });
      known.set(sessionId, k);
    }
  }
  return turns;
}

const windowed = (models: ModelCapability[], w?: number) =>
  w ? models.map((m) => ({ ...m, contextWindow: w })) : models;

async function start(o: { window?: number; context?: Partial<ContextOptions> } = {}) {
  const root = tmp();
  const claudeLog: ReplayLog = { options: [], prompts: [], interrupts: 0, closes: 0 };
  const codexLog = newLog();
  const runtimes = new RuntimeRegistry();
  // Each connection has its own folder, as in production (`DATA_DIR/runtimes/<id>/…`).
  runtimes.register(
    new ClaudeAdapter({
      connection: (req) => ({
        id: req.connectionId!,
        dir: path.join(root, "claude", req.connectionId!),
        auth: { kind: "api_key", apiKey: CLAUDE_KEY },
      }),
      models: windowed(CLAUDE_MODELS, o.window),
      query: replayQuery(
        anyPrompt((p) => sdk.answer(crypto.randomUUID(), answerFor(p))),
        claudeLog,
        1,
      ),
      spawn: () => {
        throw new Error("not spawned in replay");
      },
    }),
  );
  runtimes.register(
    new CodexAdapter({
      connection: (req) => ({
        id: req.connectionId!,
        dir: path.join(root, "codex", req.connectionId!),
        auth: { kind: "api_key", apiKey: CODEX_KEY },
      }),
      models: windowed(CODEX_MODELS, o.window),
      spawn: replaySpawn(
        anyPrompt((p) => cx.answer(answerFor(p))),
        codexLog,
        { delayMs: 1 },
      ),
      bundledCatalog: async () => ({
        models: CODEX_MODELS.map((m) => ({
          slug: m.id,
          tool_mode: "code_mode_only",
          base_instructions: "x",
        })),
      }),
      executable: "/nonexistent/codex",
    }),
  );
  const h = await startContextApp(runtimes, { closers, ...(o.context ? { context: o.context } : {}) });
  const turnsOf = (runtime: string) => (runtime === "codex" ? codexTurns(codexLog) : claudeTurns(claudeLog));
  /** The run's turn as the runtime saw it equals the server's original; returns the turn. */
  const check = (run: RunRow) => {
    const turn = turnsOf(run.runtime).at(-1)!;
    const want = h.original(run);
    expect(turn.before, `context of ${run.runtime}`).toEqual(want.entries);
    expect(turn.input).toBe(want.input);
    expect(turn.model).toBe(run.model);
    return turn;
  };
  return { ...h, check, turnsOf, claudeLog, codexLog };
}

const RUNTIMES = ["claude-code", "codex"] as const;

describe("context hand-over with both real runtimes' recorded protocols (#45)", () => {
  it("Claude → Codex → Claude: the fact set earlier reaches each new runtime; the old Claude session is not resumed", async () => {
    const t = await start();
    t.connect("claude-code");
    t.connect("codex");
    const c = await t.newConversation();
    const t1 = t.check(await t.send(c, "관심 종목은 삼성전자로 정했어"));
    const t2 = t.check(await t.send(c, "목표가는 25만원"));
    expect([t1.fresh, t2.fresh, t2.sessionId]).toEqual([true, false, t1.sessionId]);
    await t.chip(c, { runtime: "codex" });
    const t3 = t.check(await t.send(c, "그 종목 이름이 뭐였지?"));
    expect(t3.fresh).toBe(true);
    // AC-8: the new runtime is told the stock without the user repeating it.
    expect(t3.before[0]).toEqual({ role: "user", text: "관심 종목은 삼성전자로 정했어" });
    const t4 = t.check(await t.send(c, "좋아"));
    expect([t4.fresh, t4.sessionId]).toEqual([false, t3.sessionId]);
    await t.chip(c, { runtime: "claude-code" });
    const t5 = t.check(await t.send(c, "다시 Claude야, 목표가는?"));
    expect(t5.fresh).toBe(true);
    expect(t5.sessionId).not.toBe(t1.sessionId);
    expect(t5.before.map((e) => e.text)).toContain("목표가는 25만원");
    expect(t5.before).toHaveLength(8);
  });

  for (const rt of RUNTIMES) {
    it(`${rt}: edit then resend, and regenerate — a fresh session with the cut history`, async () => {
      const t = await start();
      t.connect(rt);
      const c = await t.newConversation();
      if (rt === "codex") await t.chip(c, { runtime: "codex" });
      await t.send(c, "첫 질문");
      const r2 = await t.send(c, "두번째 질문");
      const e = t.check(await t.edit(c, r2.userMessageId!, "고친 두번째 질문"));
      expect(e.fresh).toBe(true);
      expect(e.before.map((x) => x.role)).toEqual(["user", "assistant"]);
      const r4 = await t.send(c, "이어서");
      expect(t.check(r4)).toMatchObject({ fresh: false, sessionId: e.sessionId });
      const g = t.check(await t.regenerate(c, r4.assistantMessageId));
      expect(g.fresh).toBe(true);
      expect(g.input).toBe("이어서");
      expect(g.before).toHaveLength(4);
    });

    it(`${rt}: a connection change starts a fresh session in that connection's folder`, async () => {
      const t = await start();
      const personal = t.connect(rt);
      const shared = t.connect(rt, "shared");
      const c = await t.newConversation();
      if (rt === "codex") await t.chip(c, { runtime: "codex" });
      const a = t.check(await t.send(c, "개인 연결"));
      const r2 = await t.send(c, "공용 연결로", { useShared: true });
      expect([r2.connectionId, personal.id]).not.toContain(undefined);
      expect(r2.connectionId).toBe(shared.id);
      const b = t.check(r2);
      expect(b.fresh).toBe(true);
      expect(b.sessionId).not.toBe(a.sessionId);
      expect(t.check(await t.send(c, "공용으로 계속", { useShared: true }))).toMatchObject({
        fresh: false,
        sessionId: b.sessionId,
      });
      expect(t.check(await t.send(c, "다시 개인"))).toMatchObject({ fresh: true });
    });

    it(`${rt}: a model-only change goes on in the same session with the new model (setModel)`, async () => {
      const t = await start();
      t.connect(rt);
      const c = await t.newConversation();
      if (rt === "codex") await t.chip(c, { runtime: "codex" });
      const a = t.check(await t.send(c, "앞에서 정한 종목은 카카오"));
      const other = rt === "codex" ? "gpt-6-astra" : "claude-sonnet-5-5";
      await t.chip(c, { model: other });
      const r = await t.send(c, "그 종목 뭐였지?");
      expect(r.model).toBe(other);
      expect(t.check(r)).toMatchObject({ fresh: false, sessionId: a.sessionId, model: other });
    });

    it(`${rt}: resume after a summary — written with the cheap model, then the same session goes on`, async () => {
      const opts = { summaryRatio: 0.7, recentMessages: 2, reserveTokens: 0 };
      const t = await start({ window: 600, context: opts });
      t.connect(rt);
      const c = await t.newConversation();
      if (rt === "codex") await t.chip(c, { runtime: "codex" });
      let made: RunRow | undefined;
      for (let i = 1; i <= 12 && !made; i++) {
        const r = await t.send(c, `메시지 ${i}: 관심 종목 삼성전자, 목표가 ${i}0만원으로 정했어요.`);
        if (t.summaries(c).length) made = r;
        else t.check(r);
      }
      expect(made).toBeDefined();
      const [s] = t.summaries(c);
      expect(s).toMatchObject({
        summary: SUMMARY_TEXT,
        model: rt === "codex" ? "gpt-6-luna" : "claude-haiku-5-5",
      });
      expect(t.usage(made!.id).map((u) => u.purpose)).toEqual(["summary", "chat"]);
      // The summary session got exactly the messages it covers.
      const sumTurn = t.turnsOf(rt).find((x) => x.input.startsWith(SUMMARY_MARKER))!;
      const covered = t.app
        .conversations!.messages(c, { limit: 10_000 })
        .filter((m) => m.seq <= s!.throughSeq && textOf(m))
        .map((m): Entry => ({ role: m.role, text: textOf(m) }));
      expect(sumTurn.before).toEqual(covered);
      // The reply's fresh session: the summary, then the recent messages.
      const first = t.check(made!);
      expect(first.fresh).toBe(true);
      expect(first.before[0]).toEqual({ role: "summary", text: SUMMARY_TEXT });
      expect((await t.messages(c)).flatMap((m) => m.parts.filter((p) => p.type === "divider"))).toEqual([
        { type: "divider", kind: "summary", label: SUMMARY_DIVIDER },
      ]);
      // Resumed after the summary.
      const next = t.check(await t.send(c, "짧게"));
      expect(next).toMatchObject({ fresh: false, sessionId: first.sessionId });
      expect(t.summaries(c)).toHaveLength(1);
    });
  }
});
