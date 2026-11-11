import crypto from "node:crypto";
import type { RuntimeId } from "@agentlee/shared";
import {
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
  | { tool: string; ms: number; output?: unknown; isError?: boolean }
  | { usage: { inputTokens: number; outputTokens: number; costUsd?: number } }
  | { notice: string }
  | { limit: string }
  | { fail: string };

export type FakeScript = (input: TurnInput, memory: string[]) => FakeStep[];

export const defaultScript: FakeScript = (input, memory) => {
  const t = input.text.trim();
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
  /** Sessions this "runtime" remembers (forget() simulates a runtime that lost them). */
  private readonly sessions = new Map<string, { model: string; memory: string[] }>();

  constructor(
    private readonly opts: {
      id?: RuntimeId;
      script?: FakeScript;
      models?: RuntimeCapabilities["models"];
      canResume?: boolean;
      usesTools?: boolean;
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
    };
  }

  forget(externalSessionId: string): void {
    this.sessions.delete(externalSessionId);
  }

  async start(ctx: StartContext): Promise<RuntimeSession> {
    const id = `fake-${crypto.randomUUID()}`;
    const memory = ctx.history
      .flatMap((h) => h.parts.map((p) => (p.type === "text" ? p.text : "")))
      .filter(Boolean);
    this.sessions.set(id, { model: ctx.model, memory });
    return this.session(id);
  }

  async resume(externalSessionId: string): Promise<RuntimeSession> {
    if (this.opts.canResume === false) throw new Error("this runtime cannot resume");
    if (!this.sessions.has(externalSessionId)) throw new SessionGoneError();
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
              yield { type: "tool_start", callId, name: step.tool, input: { ms: step.ms } };
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
            } else if ("fail" in step) throw new Error(step.fail);
          }
        }
        return { events: events(), interrupt: async () => ctrl.abort() };
      },
    };
  }
}
