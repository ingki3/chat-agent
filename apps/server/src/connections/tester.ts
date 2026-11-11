import crypto from "node:crypto";
import type { ConnectionTestResult, RuntimeId } from "@agentlee/shared";
import type { McpTokens } from "../isolation/tokens.js";
import {
  RuntimeFailure,
  type RuntimeRegistry,
  type RuntimeSession,
  type RuntimeTurn,
  type StartContext,
  type UsageReport,
  usageReport,
} from "../runtime/adapter.js";
import type { UsageAttempt } from "../usage/store.js";
import { OUR_TOOL_PREFIX } from "../runtime/lockdown.js";

/** The verification skill's tool (#43). */
export const TEST_SKILL_TOOL = "skill_selftest";
export const TEST_TOOL = "echo_time";
/** The test prompt carries this marker and a nonce; the development FakeRuntime recognises it (fake.ts). */
export const TEST_MARKER = "[agentlee-connection-test]";

export function testPrompt(nonce: string): string {
  return [
    TEST_MARKER,
    "This is an automatic connection test of the Agent Lee server. Do exactly this, nothing else:",
    `1. Call the tool ${TEST_TOOL}.`,
    `2. Call the tool ${TEST_SKILL_TOOL} with text "${nonce}".`,
    "3. Then answer with the single word OK.",
  ].join("\n");
}

export const TEST_SYSTEM_PROMPT =
  "You are being tested by the Agent Lee server. Follow the user's instructions literally and briefly.";

export type TestMcp = {
  endpoint(): Promise<{ url: string }>;
  /** The tools this user's run gets (#21); echo_time and the verification skill are always among them. */
  toolNamesFor(userId: string): string[];
  watch(runId: string): { seen: ReadonlySet<string>; stop(): void };
};

export type TestOutcome = Omit<ConnectionTestResult, "status"> & { passed: boolean };

const sha256 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

/** A tool output as JSON: adapters pass parsed JSON, MCP text content, or a JSON string. */
function jsonOf(v: unknown): Record<string, unknown> | undefined {
  if (typeof v === "string") {
    try {
      return jsonOf(JSON.parse(v) as unknown);
    } catch {
      return undefined;
    }
  }
  if (!v || typeof v !== "object") return undefined;
  const content = (v as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const t = (content as { type?: unknown; text?: unknown }[]).find((c) => c.type === "text");
    return typeof t?.text === "string" ? jsonOf(t.text) : undefined;
  }
  return v as Record<string, unknown>;
}

const bare = (name: string) => (name.startsWith(OUR_TOOL_PREFIX) ? name.slice(OUR_TOOL_PREFIX.length) : name);

/**
 * Connection test (#17, FR-11.5): a real session on the connection, the same way a run opens one, with a short
 * prompt that must (1) stream a reply, (2) call our common MCP tool `echo_time` and (3) run the verification skill
 * on a random text — its SHA-256 proves the skill really ran. With a runtime that uses tools, our MCP server must
 * also have answered both calls for this test (`watch`), so a runtime cannot pass by only reporting tool calls.
 * In CI the runtime is a fake (no credentials); with a real key the same code runs against the provider.
 */
export class ConnectionTester {
  constructor(
    private readonly registry: RuntimeRegistry,
    private readonly mcp: TestMcp | undefined,
    private readonly tokens: McpTokens,
    private readonly opts: {
      timeoutMs?: number;
      /** Usage storage (#44): a test's usage is kept with purpose `connection_test`, on its connection. */
      usage?: { record(a: UsageAttempt, u: UsageReport): void } | undefined;
    } = {},
  ) {}

  /**
   * Runs one test. `model` and `effort` are chosen by the caller from what the user's policy allows. `version` is
   * the credential version under test (the adapter refuses another one). Aborting `signal` (disconnect, new key)
   * revokes the MCP token at once, interrupts the turn and closes the session; the outcome is `cancelled`.
   */
  async run(input: {
    connectionId: string;
    runtime: RuntimeId;
    userId: string;
    model: string;
    effort: string | undefined;
    version: number;
    signal?: AbortSignal;
  }): Promise<TestOutcome> {
    const checks = { reply: false, streaming: false, tool: false, skill: false };
    const fail = (code: string): TestOutcome => ({ passed: false, code, checks });
    const adapter = this.registry.get(input.runtime);
    if (!adapter) return fail("no_runtime");
    if (input.signal?.aborted) return fail("cancelled");
    const caps = adapter.capabilities();
    const model = input.model;
    const effort = input.effort;
    const nonce = crypto.randomBytes(9).toString("base64url");
    const runId = crypto.randomUUID();
    const mcp = caps.usesTools ? this.mcp : undefined;
    const watch = mcp?.watch(runId);
    let session: RuntimeSession | undefined;
    let turn: RuntimeTurn | undefined;
    let timer: NodeJS.Timeout | undefined;
    let stopped: "timeout" | "cancelled" | undefined;
    /** Given to the adapter: a stop (time limit or cancel) kills whatever it has started for this test. */
    const inner = new AbortController();
    let text = "";
    let deltas = 0;
    const calls = new Map<string, string>();
    const results: { name: string; output: unknown }[] = [];
    try {
      const ctx: StartContext = {
        // Not a real conversation: the MCP token is scoped to this test only, and nothing is stored.
        conversationId: crypto.randomUUID(),
        userId: input.userId,
        connectionId: input.connectionId,
        connectionVersion: input.version,
        connectionTest: true,
        signal: inner.signal,
        history: [],
        systemPrompt: TEST_SYSTEM_PROMPT,
        model,
        effort,
        tools: mcp ? mcp.toolNamesFor(input.userId) : [],
      };
      if (mcp) {
        const { url } = await mcp.endpoint();
        const ttlMs = (this.opts.timeoutMs ?? 120_000) + 10_000;
        ctx.mcp = {
          url,
          token: this.tokens.issue(
            { userId: input.userId, conversationId: ctx.conversationId, runId },
            ttlMs,
          ),
        };
      }
      // Ends the test early: the time limit, or a cancel (disconnect, new key). Either way the runtime must not
      // reach our tools any more, so the token goes first.
      const deadline = new Promise<"timeout" | "cancelled">((resolve) => {
        const stop = (why: "timeout" | "cancelled") => {
          if (stopped) return;
          stopped = why;
          this.tokens.revokeRun(runId);
          inner.abort();
          void turn?.interrupt().catch(() => {});
          resolve(why);
        };
        timer = setTimeout(() => stop("timeout"), this.opts.timeoutMs ?? 120_000);
        timer.unref();
        if (input.signal?.aborted) stop("cancelled");
        input.signal?.addEventListener("abort", () => stop("cancelled"), { once: true });
      });
      if (stopped) return fail(stopped);
      const starting = adapter.start(ctx);
      const opened = await Promise.race([starting, deadline]);
      if (opened === "timeout" || opened === "cancelled") {
        // The adapter got the abort and kills its process; the test is over only once that has happened (a
        // session that opened after all is closed and waited for). Bounded: the process was SIGKILLed.
        await Promise.race([
          starting.then(
            (s) => s.close().catch(() => {}),
            () => {},
          ),
          sleep(5000),
        ]);
        return fail(opened);
      }
      session = opened;
      if (stopped) return fail(stopped);
      turn = session.turn({ text: testPrompt(nonce), model, effort });
      const iterator = turn.events[Symbol.asyncIterator]();
      for (;;) {
        const next = await Promise.race([iterator.next(), deadline]);
        if (next === "timeout" || next === "cancelled") {
          void turn.interrupt().catch(() => {});
          return fail(next);
        }
        if (next.done) break;
        const ev = next.value;
        if (ev.type === "text_delta") {
          deltas++;
          text += ev.text;
        } else if (ev.type === "tool_start") calls.set(ev.callId, bare(ev.name));
        else if (ev.type === "tool_end" && !ev.isError)
          results.push({ name: calls.get(ev.callId) ?? "", output: ev.output });
        else if (ev.type === "usage") {
          // One session open + one turn: the test is a single attempt, keyed on its own id (no run row).
          const report = usageReport(ev);
          try {
            this.opts.usage?.record(
              {
                userId: input.userId,
                conversationId: null,
                runId,
                attempt: 1,
                runtime: input.runtime,
                model,
                connectionId: input.connectionId,
                purpose: "connection_test",
              },
              report,
            );
          } catch {
            // Losing a test's usage row must not change the test's outcome.
          }
        } else if (ev.type === "limit") return fail("usage_limit");
      }
    } catch (e) {
      if (stopped) return fail(stopped);
      return fail(e instanceof RuntimeFailure ? e.code : "runtime_error");
    } finally {
      clearTimeout(timer);
      this.tokens.revokeRun(runId);
      watch?.stop();
      if (session) await Promise.race([session.close().catch(() => {}), sleep(2000)]);
    }
    checks.reply = text.trim().length > 0;
    checks.streaming = deltas > 0;
    const served = (tool: string) => !watch || watch.seen.has(tool);
    checks.tool =
      served(TEST_TOOL) &&
      results.some((r) => r.name === TEST_TOOL && typeof jsonOf(r.output)?.now === "string");
    checks.skill =
      served(TEST_SKILL_TOOL) &&
      results.some((r) => r.name === TEST_SKILL_TOOL && jsonOf(r.output)?.sha256 === sha256(nonce));
    const code = !checks.reply
      ? "test_no_reply"
      : !checks.streaming
        ? "test_no_stream"
        : !checks.tool
          ? "test_no_tool"
          : !checks.skill
            ? "test_no_skill"
            : "ok";
    return { passed: code === "ok", code, checks };
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());
