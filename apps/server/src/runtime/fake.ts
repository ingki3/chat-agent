import crypto from "node:crypto";
import { TEST_MARKER, TEST_SKILL_TOOL, TEST_TOOL } from "../connections/tester.js";
import type { RuntimeId } from "@agentlee/shared";
import {
  RuntimeFailure,
  SessionGoneError,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeSession,
  type RuntimeTurn,
  type StartContext,
  type TurnInput,
} from "./adapter.js";

/**
 * Scripted runtime for tests and local development (FAKE_RUNTIME=1). Behaviour per turn comes from a script;
 * the default script answers by echoing, and understands commands typed as the message for manual testing:
 *   /tool <seconds>   a tool call that stays silent for that long (keep-alive check, #12)
 *   /error            the turn fails
 *   /limit            a usage-limit signal
 *   /long <n>         n words, slowly (to try the stop button)
 */
export type FakeStep =
  | { text: string }
  | { reasoning: string }
  | { delayMs: number }
  | { tool: string; ms: number; input?: unknown; output?: unknown; isError?: boolean }
  | { usage: { inputTokens: number; outputTokens: number; costUsd?: number } }
  | { notice: string }
  | { limit: string }
  | { fail: string; code?: RuntimeFailure["code"] };

export type FakeScript = (input: TurnInput, memory: string[]) => FakeStep[];

/**
 * The connection test prompt (#17), answered like a real runtime would: our tool, the verification skill (its
 * output computed the way the skill does) and a short reply. A fake without tools has no MCP server to ask.
 */
function connectionTestSteps(text: string): FakeStep[] {
  const nonce = /with text "([^"]*)"/.exec(text)?.[1] ?? "";
  return [
    { tool: TEST_TOOL, ms: 0, output: { now: new Date().toISOString() } },
    {
      tool: TEST_SKILL_TOOL,
      ms: 0,
      output: {
        characters: [...nonce].length,
        sha256: crypto.createHash("sha256").update(nonce, "utf8").digest("hex"),
        reversed: [...nonce].reverse().join(""),
      },
    },
    { text: "OK" },
  ];
}

export const defaultScript: FakeScript = (input, memory) => {
  const t = input.text.trim();
  if (t.startsWith(TEST_MARKER)) return connectionTestSteps(t);
  const m = /^\/(tool|error|limit|long)\b\s*(\d+)?/.exec(t);
  if (m?.[1] === "tool")
    return [
      { text: "도구를 실행할게요. " },
      { tool: "slow_tool", ms: Number(m[2] ?? 5) * 1000, output: { ok: true } },
      { text: "끝났어요." },
    ];
  if (m?.[1] === "error") return [{ text: "잠시만요…" }, { fail: "fake failure" }];
  if (m?.[1] === "limit") return [{ limit: "사용 한도에 도달했어요 (가짜)" }];
  const words =
    m?.[1] === "long"
      ? Array.from({ length: Number(m[2] ?? 200) }, (_, i) => `단어${i + 1}`)
      : [`(가짜 응답 · ${input.model}${input.effort ? ` · ${input.effort}` : ""})`, ...t.split(/\s+/)];
  return [
    { reasoning: "사용자의 말을 되풀이한다." },
    ...words.flatMap((w) => [{ text: `${w} ` }, { delayMs: m?.[1] === "long" ? 50 : 15 }]),
    { text: memory.length > 1 ? `\n(이 세션에서 ${memory.length}번째 메시지예요)` : "" },
    { usage: { inputTokens: 10 * memory.length, outputTokens: words.length } },
  ];
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

export class FakeRuntime implements RuntimeAdapter {
  readonly id: RuntimeId;
  /** Sessions opened and closed — tests check that the run manager releases every session it opens. */
  opened = 0;
  closed = 0;
  /** Sessions resumed (not started). */
  resumed = 0;
  /** System prompts of the sessions started, in order — tests check what the run manager assembled (#20). */
  readonly systemPrompts: string[] = [];
  /** Every StartContext passed to start/resume (tests check the connection the run manager chose). */
  readonly contexts: StartContext[] = [];
  /** Sessions this "runtime" remembers (forget() simulates a runtime that lost them). */
  private readonly sessions = new Map<string, { model: string; memory: string[] }>();

  constructor(
    private readonly opts: {
      id?: RuntimeId;
      script?: FakeScript;
      models?: RuntimeCapabilities["models"];
      canResume?: boolean;
      usesTools?: boolean;
      /** Act like a real runtime that needs a connection (#17). */
      needsConnection?: boolean;
    } = {},
  ) {
    this.id = opts.id ?? "claude-code";
  }

  capabilities(): RuntimeCapabilities {
    return {
      models: this.opts.models ?? [
        {
          id: "fake-large",
          label: "Fake Large",
          efforts: ["low", "medium", "high"],
          defaultEffort: "medium",
        },
        { id: "fake-small", label: "Fake Small", efforts: [] },
      ],
      canSwitchModelInSession: true,
      canResume: this.opts.canResume ?? true,
      usesTools: this.opts.usesTools ?? false,
      needsConnection: this.opts.needsConnection ?? false,
    };
  }

  forget(externalSessionId: string): void {
    this.sessions.delete(externalSessionId);
  }

  async start(ctx: StartContext): Promise<RuntimeSession> {
    this.contexts.push(ctx);
    const id = `fake-${crypto.randomUUID()}`;
    this.systemPrompts.push(ctx.systemPrompt);
    const memory = ctx.history
      .flatMap((h) => h.parts.map((p) => (p.type === "text" ? p.text : "")))
      .filter(Boolean);
    this.sessions.set(id, { model: ctx.model, memory });
    return this.session(id);
  }

  async resume(externalSessionId: string, ctx?: StartContext): Promise<RuntimeSession> {
    if (ctx) this.contexts.push(ctx);
    if (this.opts.canResume === false) throw new Error("this runtime cannot resume");
    if (!this.sessions.has(externalSessionId)) throw new SessionGoneError();
    this.resumed++;
    return this.session(externalSessionId);
  }

  private session(id: string): RuntimeSession {
    this.opened++;
    const state = this.sessions.get(id)!;
    const script = this.opts.script ?? defaultScript;
    return {
      externalSessionId: id,
      setModel: async (model) => {
        state.model = model;
      },
      close: async () => {
        this.closed++;
      },
      turn: (input): RuntimeTurn => {
        state.memory.push(input.text);
        const ctrl = new AbortController();
        const steps = script({ ...input, model: input.model || state.model }, state.memory);
        async function* events(): AsyncGenerator<RuntimeEvent> {
          let seq = 0;
          for (const step of steps) {
            if (ctrl.signal.aborted) return;
            if ("text" in step) {
              if (step.text) yield { type: "text_delta", text: step.text };
            } else if ("reasoning" in step) yield { type: "reasoning_delta", text: step.reasoning };
            else if ("delayMs" in step) await sleep(step.delayMs, ctrl.signal);
            else if ("tool" in step) {
              const callId = `call-${++seq}`;
              yield { type: "tool_start", callId, name: step.tool, input: step.input ?? { ms: step.ms } };
              await sleep(step.ms, ctrl.signal);
              if (ctrl.signal.aborted) return;
              yield {
                type: "tool_end",
                callId,
                output: step.output,
                ...(step.isError ? { isError: true } : {}),
              };
            } else if ("usage" in step) yield { type: "usage", ...step.usage };
            else if ("notice" in step)
              yield { type: "notice", level: "info", code: "fake", message: step.notice };
            else if ("limit" in step) {
              yield { type: "limit", code: "usage_limit", message: step.limit };
              return;
            } else if ("fail" in step) throw step.code ? new RuntimeFailure(step.code) : new Error(step.fail);
          }
        }
        return { events: events(), interrupt: async () => ctrl.abort() };
      },
    };
  }
}
