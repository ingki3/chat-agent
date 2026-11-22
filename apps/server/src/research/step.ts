import type { ResearchErrorCode } from "@agentlee/shared";
import type { McpTokens } from "../isolation/tokens.js";
import { logEvent, type EventLogger } from "../logging.js";
import {
  RuntimeFailure,
  usageReport,
  type RuntimeAdapter,
  type RuntimeSession,
  type RuntimeTurn,
  type UsageReport,
} from "../runtime/adapter.js";
import type { SessionRef } from "../runtime/runs.js";
import type { UsageAttempt } from "../usage/store.js";
import type { Clock } from "./clock.js";

/**
 * One step of a 깊이 조사 job (#211): a one-off session of the owner's runtime — the lead's plan or reflection, one
 * sub-researcher, the writer — with a turn, a time limit and (for sub-researchers) a tool-call limit. Like the 기억
 * 정리 runs (#146) the session is never resumed: it is closed and its runtime state forgotten right after, however it
 * ended. Its MCP token is scoped to the owner, the conversation and the step's own id (the citations and sources it
 * makes are the conversation's; `cite` numbers per step), and dies with the step — once a limit is hit, at once, so a
 * call still running stops (#173's rule).
 */
export type StepSpec = {
  /** `research:<job>:<step>` — the MCP scope's run id, the citations' run, the usage record's run. */
  stepId: string;
  userId: string;
  conversationId: string;
  adapter: RuntimeAdapter;
  connectionId: string | null;
  connectionVersion: number | null;
  model: string;
  effort: string | null;
  systemPrompt: string;
  text: string;
  /** Our MCP tools for the step (without prefix); empty: no MCP server. */
  tools: string[];
  /** Time limit of the step. */
  ms: number;
  /** Tool calls allowed (sub-researchers). */
  toolCalls?: number | undefined;
  /** The job's own stop (the owner's stop, the stage's deadline, the conversation deleted, shutdown). */
  signal: AbortSignal;
  /** Called on every tool start (progress). */
  onTool?: (() => void) | undefined;
};

export type StepEnd = "done" | "timeout" | "capped" | "aborted" | "failed";
export type StepResult = {
  /** The step's text so far — also of a step that was stopped (its notes, the report up to there). */
  text: string;
  ended: StepEnd;
  toolCalls: number;
  error?: ResearchErrorCode | undefined;
};

export type StepDeps = {
  mcp?: { endpoint(): Promise<{ url: string }> } | undefined;
  mcpTokens: McpTokens;
  clock: Clock;
  usage?: { record(a: UsageAttempt, u: UsageReport): void } | undefined;
  forgetSession?: ((ref: SessionRef) => void) | undefined;
  log?: EventLogger | undefined;
  /** Background work of a step after its result (closing a session that is slow to stop): shutdown waits for it. */
  track?: ((p: Promise<void>) => void) | undefined;
};

/** Output beyond this is not read (a runaway step): it is stopped. */
const OUTPUT_MAX = 200_000;

export async function runStep(spec: StepSpec, deps: StepDeps): Promise<StepResult> {
  const abort = new AbortController();
  let ended: StepEnd | undefined;
  let session: RuntimeSession | undefined;
  let turn: RuntimeTurn | undefined;
  let startedId: string | undefined;
  let text = "";
  let toolCalls = 0;
  let limited = false;
  // Settles the moment the step is stopped (its deadline, the job's stop, a limit): the result is what came until
  // then. A runtime that is slow to stop, or never does, is not waited for — its session is closed in the background
  // (`deps.track`) and whatever it sends later goes nowhere (#211 review 1).
  let stopped!: () => void;
  const stoppedNow = new Promise<"stopped">((r) => (stopped = () => r("stopped")));
  // Closed once, by whoever comes first: the stop itself (a runtime whose events wait for the close), or the end of the
  // work. A session that opens after the stop is closed as soon as it exists.
  let closing: Promise<void> | undefined;
  const closeSession = () => {
    if (!session) return Promise.resolve();
    closing ??= Promise.resolve()
      .then(() => session!.close())
      .catch(() => {});
    return closing;
  };
  const stop = (why: StepEnd) => {
    if (ended) return;
    ended = why;
    // No more of our tools from this moment (a long call in progress sees its token gone).
    deps.mcpTokens.revokeRun(spec.stepId);
    abort.abort();
    try {
      void turn?.interrupt().catch(() => {});
    } catch {
      // the adapter threw synchronously: the step has ended anyway
    }
    void closeSession();
    stopped();
  };
  const cancelTimer = deps.clock.timer(spec.ms, () => stop("timeout"));
  const onJobAbort = () => stop("aborted");
  if (spec.signal.aborted) onJobAbort();
  else spec.signal.addEventListener("abort", onJobAbort);
  const snapshot = (): StepResult => ({ text, ended: ended ?? "done", toolCalls });
  const work = (async (): Promise<StepResult> => {
    try {
      if (ended) return snapshot();
      const mcp =
        spec.tools.length && deps.mcp
          ? {
              url: (await deps.mcp.endpoint()).url,
              token: deps.mcpTokens.issue(
                { userId: spec.userId, conversationId: spec.conversationId, runId: spec.stepId },
                spec.ms + 5 * 60_000,
                // Enforced by our MCP server itself, call by call: only these tools, at most this many calls.
                { tools: spec.tools, ...(spec.toolCalls !== undefined ? { maxCalls: spec.toolCalls } : {}) },
              ),
            }
          : undefined;
      if (ended) return snapshot();
      session = await spec.adapter.start({
        conversationId: spec.conversationId,
        userId: spec.userId,
        ...(spec.connectionId ? { connectionId: spec.connectionId } : {}),
        ...(spec.connectionVersion !== null ? { connectionVersion: spec.connectionVersion } : {}),
        signal: abort.signal,
        history: [],
        systemPrompt: spec.systemPrompt,
        model: spec.model,
        effort: spec.effort ?? undefined,
        tools: mcp ? spec.tools : [],
        ...(mcp ? { mcp } : {}),
        sessionStarted: (id) => {
          startedId = id;
        },
      });
      startedId = session.externalSessionId;
      if (ended) {
        void closeSession();
        return snapshot();
      }
      turn = session.turn({ text: spec.text, model: spec.model, effort: spec.effort ?? undefined });
      for await (const ev of turn.events) {
        if (ended) break;
        if (ev.type === "text_delta") {
          text += ev.text;
          if (text.length > OUTPUT_MAX) stop("capped");
        } else if (ev.type === "tool_start") {
          toolCalls++;
          spec.onTool?.();
          if (spec.toolCalls !== undefined && toolCalls > spec.toolCalls) stop("capped");
        } else if (ev.type === "usage") record(spec, deps, usageReport(ev));
        else if (ev.type === "limit") limited = true;
      }
      if (ended) return snapshot();
      if (limited) return { text, ended: "failed", toolCalls, error: "usage_limit" };
      return { text, ended: "done", toolCalls };
    } catch (e) {
      if (ended) return snapshot();
      if (limited) return { text, ended: "failed", toolCalls, error: "usage_limit" };
      const error: ResearchErrorCode =
        e instanceof RuntimeFailure
          ? e.code === "runtime_auth"
            ? "runtime_auth"
            : e.code === "no_connection"
              ? "no_connection"
              : // The runtime's own refusal (a tool it was not offered) is kept: never a passing error (#234).
                e.code === "runtime_policy"
                ? "runtime_policy"
                : "runtime_error"
          : "runtime_error";
      return { text, ended: "failed", toolCalls, error };
    }
  })();
  // The session is closed and its state forgotten once the work is over — however long that takes after a stop.
  const cleanup = work
    .catch(() => undefined)
    .then(async () => {
      cancelTimer();
      spec.signal.removeEventListener("abort", onJobAbort);
      deps.mcpTokens.revokeRun(spec.stepId);
      await closeSession();
      if (startedId)
        deps.forgetSession?.({
          conversationId: "",
          runtime: spec.adapter.id,
          connectionId: spec.connectionId,
          userId: spec.userId,
          externalSessionId: startedId,
        });
    });
  deps.track?.(cleanup);
  const first = await Promise.race([work, stoppedNow]);
  // Stopped: the text so far, frozen now — a late event cannot change the result any more.
  if (first === "stopped") return { text, ended: ended!, toolCalls };
  // Ended by itself: the session is closed before the result goes on (as before; a hanging close is bounded).
  await Promise.race([cleanup, stoppedNow, new Promise<void>((r) => setTimeout(r, 3000).unref())]);
  return first;
}

function record(spec: StepSpec, deps: StepDeps, report: UsageReport): void {
  try {
    deps.usage?.record(
      {
        userId: spec.userId,
        conversationId: spec.conversationId,
        runId: spec.stepId,
        attempt: 1,
        runtime: spec.adapter.id,
        model: spec.model,
        connectionId: spec.connectionId,
        purpose: "research",
      },
      report,
    );
  } catch (e) {
    logEvent(deps.log, "warn", "usage.record_failed", {
      userId: spec.userId,
      runId: spec.stepId,
      runtime: spec.adapter.id,
      attempt: 1,
      purpose: "research",
      err: e,
    });
  }
}
