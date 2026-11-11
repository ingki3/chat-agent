import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { SpawnIsolatedOptions } from "../../src/isolation/sandbox.js";
import type { CodexChild } from "../../src/runtime/codex.js";
import { callOurTool, isLiveCall } from "./live-mcp.js";

/**
 * Recorded `codex app-server` conversations, replayed in CI instead of the real binary (#16, like #15: CI replays,
 * one real recording made locally). A recording maps the turn's prompt text to the JSON-RPC messages the real
 * app-server sent for it, from `turn/start` until the turn ended (see `recordingSpawn`).
 */
type Json = Record<string, unknown>;
export type RecordedTurn = {
  /** Notifications (and requests) the app-server sent during the turn, in order. */
  messages: Json[];
  /** Index in `messages` at which turn/interrupt was sent (what follows is what came after it). */
  interruptAt?: number;
  /** The process exited after the last message instead of completing the turn. */
  exited?: boolean;
  /** Ids in the recording — replaced by the replay's own ids. */
  threadId?: string;
  turnId?: string;
};
/** Prompt text → the turn the runtime produced. A bare array is a turn without interrupt or exit. */
export type Recording = Record<string, RecordedTurn | Json[]>;
/** Ids the hand-made builders below use (`cx`). */
const T = "rec-thread";
const U = "rec-turn";
const turnOf = (t: RecordedTurn | Json[]): RecordedTurn => ({
  threadId: T,
  turnId: U,
  ...(Array.isArray(t) ? { messages: t } : t),
});

/** What the adapter asked of the app-server, so tests can check it. Secrets in params are kept for assertions. */
export type ReplayLog = {
  spawns: SpawnIsolatedOptions[];
  requests: { method: string; params: Json }[];
  /** Whether CODEX_HOME/auth.json still existed when `account/read` came (a device login reads it first). */
  authJsonAtRead?: boolean;
  /** Our answers to the app-server's requests (`$refresh` in a recording), in order. */
  answers: { id: unknown; result?: Json; error?: Json }[];
  errors: string[];
  kills: number;
  /** Processes that have exited (their `exit` event was emitted). */
  exits: number;
};
export const newLog = (): ReplayLog => ({
  spawns: [],
  requests: [],
  answers: [],
  errors: [],
  kills: 0,
  exits: 0,
});

/**
 * A scripted ChatGPT device-code login (#18), as app-server 0.165.0 runs it: `account/login/start
 * {type:"chatgptDeviceCode"}` answers with the code, then — after `delayMs` — `account/login/completed`. On success
 * the tokens are written to CODEX_HOME/auth.json first (the file store the login process uses), like the binary.
 * `"never"`: the user never enters the code (only a cancel or the timeout ends it).
 */
export type DeviceLoginScript = {
  verificationUrl?: string;
  userCode?: string;
  outcome:
    | "never"
    | { success: true; authJson: Json; delayMs?: number }
    | { success: false; error: string; delayMs?: number };
  /** What `account/read` answers once logged in. */
  account?: Json | null;
  /** Called when `account/read` arrives; the answer then waits `readDelayMs` (to cancel at that very stage). */
  onAccountRead?: () => void;
  readDelayMs?: number;
};

let seq = 0;
const uuid = () => {
  const n = (++seq).toString(16).padStart(12, "0");
  return `0199aaaa-0000-7000-8000-${n}`;
};

/**
 * A scripted app-server: answers the protocol requests and plays the recorded turn for the prompt it gets. An
 * interrupt jumps to what the real runtime sent after it (`interruptAt`); a turn recorded without an interrupt
 * cannot be interrupted in replay — that is logged in `errors` and the process exits, instead of inventing an
 * ending. `extra` lets a test add notifications at session start (e.g. a foreign MCP server).
 */
export function replaySpawn(
  rec: Recording,
  log: ReplayLog,
  o: {
    delayMs?: number;
    /** Sent right after `initialize` (before any thread exists). */
    atStart?: Json[];
    /** Sent right after the thread opened (`rec-thread` becomes the replay's thread id). */
    afterOpen?: Json[];
    /** Sent once a turn's recording has played out, before anything else (between turns). */
    afterTurn?: Json[];
    serverRequestAt?: { prompt: string; method: string };
    /** `initialize` is answered only once this settles (a slow start, e.g. to cancel while it opens). */
    initializeGate?: Promise<unknown>;
    /** The process takes this long to exit after it was killed (default: next tick). */
    exitDelayMs?: number;
    /** A device-code login (#18). */
    deviceLogin?: DeviceLoginScript;
    /** `account/login/start {type:"chatgptAuthTokens"}` is refused. */
    refuseTokens?: boolean;
  } = {},
): (s: SpawnIsolatedOptions) => CodexChild {
  return (s) => {
    log.spawns.push(s);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const ev = new EventEmitter();
    let exited = false;
    const exit = () => {
      if (exited) return;
      exited = true;
      const emitExit = () => {
        log.exits++;
        ev.emit("exit", 0, null);
      };
      if (o.exitDelayMs) setTimeout(emitExit, o.exitDelayMs);
      else setImmediate(emitExit);
    };
    const send = (m: Json) => {
      if (!exited) stdout.write(JSON.stringify(m) + "\n");
    };
    const codexHome = s.env.CODEX_HOME!;
    let threadId: string | undefined;
    let playing: { turn: RecordedTurn; i: number; interrupted: boolean; turnId: string } | undefined;
    const rewrite = (m: Json, turn: RecordedTurn, turnId: string): Json => {
      let t = JSON.stringify(m);
      if (turn.threadId) t = t.split(turn.threadId).join(threadId!);
      if (turn.turnId) t = t.split(turn.turnId).join(turnId);
      return JSON.parse(t) as Json;
    };
    const play = () => {
      const p = playing;
      if (!p || exited) return;
      if (p.i >= p.turn.messages.length) {
        playing = undefined;
        if (p.turn.exited) exit();
        else for (const n of o.afterTurn ?? []) send(ours(n));
        return;
      }
      const raw = p.turn.messages[p.i++]!;
      if (raw.$refresh) {
        // app-server asks for new ChatGPT tokens and waits for the answer before it goes on.
        const id = `refresh-${p.i}`;
        waitingAnswer = { id, resume: () => setTimeout(play, o.delayMs ?? 2) };
        send({
          id,
          method: "account/chatgptAuthTokens/refresh",
          params: { reason: "unauthorized", previousAccountId: "acct-replay" },
        });
        return;
      }
      if (isLiveCall(raw)) {
        void liveToolCall(raw.id, raw.tool, raw.args, p.turnId).then(() => setTimeout(play, o.delayMs ?? 2));
        return;
      }
      const m = rewrite(raw, p.turn, p.turnId);
      send(m);
      setTimeout(play, o.delayMs ?? 2);
    };
    /**
     * What app-server does for a tool call of the model (#21 contract test, `liveCall`): only a tool of the run's
     * `enabled_tools`, on the MCP server at the configured url, with the token from `bearer_token_env_var`.
     */
    const liveToolCall = async (id: string, tool: string, args: unknown, turnId: string) => {
      const cfg = s.args.find((a) => a.startsWith("mcp_servers.agentlee=")) ?? "";
      const url = /url = "([^"]+)"/.exec(cfg)?.[1];
      const enabled = (/enabled_tools = \[([^\]]*)\]/.exec(cfg)?.[1] ?? "")
        .split(",")
        .map((t) => t.trim().replace(/^"|"$/g, ""))
        .filter(Boolean);
      const token = s.env.AGENTLEE_MCP_TOKEN;
      const ids = { threadId, turnId };
      const item = { type: "mcpToolCall", id, server: "agentlee", tool, arguments: args };
      send({
        method: "item/started",
        params: { ...ids, item: { ...item, status: "inProgress", result: null, error: null } },
      });
      if (!url || !token || !enabled.includes(tool)) {
        send({
          method: "item/completed",
          params: {
            ...ids,
            item: { ...item, status: "failed", result: null, error: { message: "not enabled" } },
          },
        });
        return;
      }
      const r = await callOurTool(url, token, tool, args);
      send({
        method: "item/completed",
        params: {
          ...ids,
          item: {
            ...item,
            status: "completed",
            result: { content: r.content, structuredContent: null, ...(r.isError ? { isError: true } : {}) },
            error: null,
          },
        },
      });
    };
    /** A hand-made message with our placeholder thread id made the replay's own. */
    const ours = (m: Json): Json =>
      JSON.parse(
        JSON.stringify(m)
          .split(T)
          .join(threadId ?? T),
      ) as Json;
    let waitingAnswer: { id: string; resume: () => void } | undefined;
    let loginId: string | undefined;
    let loginDone = false;
    const completeLogin = (success: boolean, error: string | null) => {
      if (loginDone || !loginId) return;
      loginDone = true;
      send({
        method: "account/login/completed",
        params: { loginId, success, error, onboardingEntrypoint: null },
      });
    };
    let buf = "";
    const dec = new StringDecoder("utf8");
    stdin.on("data", (d: Buffer) => {
      buf += dec.write(d);
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const m = JSON.parse(line) as {
          id?: number;
          method?: string;
          params?: Json;
          result?: Json;
          error?: Json;
        };
        if (m.id !== undefined && !m.method) {
          // Our answer to a request of the app-server's.
          log.answers.push({
            id: m.id,
            ...(m.result ? { result: m.result } : {}),
            ...(m.error ? { error: m.error } : {}),
          });
          if (waitingAnswer && waitingAnswer.id === (m.id as unknown)) {
            const w = waitingAnswer;
            waitingAnswer = undefined;
            w.resume();
          }
          continue;
        }
        if (m.id === undefined || !m.method) continue; // notifications
        log.requests.push({ method: m.method, params: m.params ?? {} });
        const reply = (result: Json) => send({ id: m.id, result });
        const fail = () => send({ id: m.id, error: { code: -32600, message: "no" } });
        switch (m.method) {
          case "initialize":
            void Promise.resolve(o.initializeGate).then(() => {
              reply({ userAgent: "replay", codexHome, platformFamily: "unix", platformOs: "macos" });
              for (const n of o.atStart ?? []) send(n);
            });
            break;
          case "account/login/start": {
            const type = m.params?.type;
            if (type === "apiKey") reply({ type: "apiKey" });
            else if (type === "chatgptAuthTokens") {
              if (o.refuseTokens) fail();
              else reply({ type: "chatgptAuthTokens" });
            } else if (type === "chatgptDeviceCode" && o.deviceLogin) {
              const d = o.deviceLogin;
              loginId = uuid();
              reply({
                type: "chatgptDeviceCode",
                loginId,
                verificationUrl: d.verificationUrl ?? "https://auth.openai.com/codex/device",
                userCode: d.userCode ?? "ABCD-12345",
              });
              const out = d.outcome;
              if (out !== "never")
                setTimeout(() => {
                  if (loginDone || exited) return;
                  if (out.success) {
                    fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(out.authJson));
                    completeLogin(true, null);
                  } else completeLogin(false, out.error);
                }, out.delayMs ?? 5);
            } else fail();
            break;
          }
          case "account/login/cancel":
            // Like the real binary (checked on 0.165.0): "canceled", then the login ends unsuccessfully.
            reply({ status: loginId && !loginDone ? "canceled" : "notFound" });
            completeLogin(false, "Login was not completed");
            break;
          case "account/read":
            log.authJsonAtRead = fs.existsSync(path.join(codexHome, "auth.json"));
            o.deviceLogin?.onAccountRead?.();
            setTimeout(
              () =>
                reply({
                  account: loginDone ? (o.deviceLogin?.account ?? null) : null,
                  requiresOpenaiAuth: true,
                }),
              o.deviceLogin?.readDelayMs ?? 0,
            );
            break;
          case "thread/start": {
            threadId = uuid();
            // Like the real binary: the thread gets its rollout file in CODEX_HOME.
            const dir = path.join(codexHome, "sessions", "2026", "11", "11");
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, `rollout-2026-11-11T00-00-00-${threadId}.jsonl`), "{}\n");
            reply({ thread: { id: threadId }, model: m.params?.model });
            for (const n of o.afterOpen ?? []) send(ours(n));
            break;
          }
          case "thread/resume": {
            const id = String(m.params?.threadId);
            const dir = path.join(codexHome, "sessions", "2026", "11", "11");
            if (fs.existsSync(path.join(dir, `rollout-2026-11-11T00-00-00-${id}.jsonl`))) {
              threadId = id;
              reply({ thread: { id }, model: m.params?.model });
              for (const n of o.afterOpen ?? []) send(ours(n));
            } else fail();
            break;
          }
          case "turn/start": {
            const text = String((m.params?.input as { text?: string }[] | undefined)?.[0]?.text ?? "");
            const recorded = rec[text];
            if (!recorded) {
              log.errors.push(`no recording for prompt: ${text.slice(0, 40)}`);
              fail();
              break;
            }
            const turnId = uuid();
            reply({ turn: { id: turnId, status: "inProgress", items: [] } });
            playing = { turn: turnOf(recorded), i: 0, interrupted: false, turnId };
            if (o.serverRequestAt?.prompt === text)
              setTimeout(
                () => send({ id: 9999, method: o.serverRequestAt!.method, params: { threadId } }),
                1,
              );
            setTimeout(play, o.delayMs ?? 2);
            break;
          }
          case "turn/interrupt": {
            reply({});
            const p = playing;
            if (!p || p.interrupted) break;
            p.interrupted = true;
            if (p.turn.interruptAt === undefined) {
              log.errors.push("replay: this recording was not interrupted");
              exit();
              break;
            }
            p.i = Math.max(p.i, p.turn.interruptAt);
            break;
          }
          default:
            fail();
        }
      }
    });
    return Object.assign(ev, {
      stdin,
      stdout,
      pid: undefined,
      kill: () => {
        log.kills++;
        exit();
        return true;
      },
    }) as unknown as CodexChild;
  };
}

/**
 * Wraps the real spawn and stores what the app-server sent per turn (run with real credentials, once). Recording
 * taps the process's streams on its own — independent of how the adapter consumes them — so a turn is stored
 * however it ends (completed, interrupted, failed, or the process gone) even when the adapter stops reading early.
 * Await `pending` (one promise per process, settled when it exits) before saving.
 */
export function recordingSpawn(
  real: (s: SpawnIsolatedOptions) => CodexChild,
  into: Recording,
  pending: Promise<unknown>[] = [],
): (s: SpawnIsolatedOptions) => CodexChild {
  return (s) => {
    const child = real(s);
    let current: { key: string; turn: RecordedTurn } | undefined;
    let startId: number | undefined;
    const save = () => {
      if (current) into[current.key] = current.turn;
    };
    // Our side: which prompt a turn is for, and when we interrupted it.
    const stdin = new PassThrough();
    let inBuf = "";
    const inDec = new StringDecoder("utf8");
    stdin.on("data", (d: Buffer) => {
      inBuf += inDec.write(d);
      let i: number;
      while ((i = inBuf.indexOf("\n")) >= 0) {
        const m = JSON.parse(inBuf.slice(0, i)) as { id?: number; method?: string; params?: Json };
        inBuf = inBuf.slice(i + 1);
        if (m.method === "turn/start") {
          const key = String((m.params?.input as { text?: string }[] | undefined)?.[0]?.text ?? "");
          current = { key, turn: { messages: [], threadId: String(m.params?.threadId) } };
          startId = m.id;
          save();
        } else if (m.method === "turn/interrupt" && current) {
          current.turn.interruptAt ??= current.turn.messages.length;
          save();
        }
      }
    });
    stdin.pipe(child.stdin as NodeJS.WritableStream);
    // The app-server's side.
    let outBuf = "";
    const outDec = new StringDecoder("utf8");
    child.stdout.on("data", (d: Buffer | string) => {
      outBuf += typeof d === "string" ? d : outDec.write(d);
      let i: number;
      while ((i = outBuf.indexOf("\n")) >= 0) {
        const line = outBuf.slice(0, i);
        outBuf = outBuf.slice(i + 1);
        let m: Json;
        try {
          m = JSON.parse(line) as Json;
        } catch {
          continue;
        }
        if (!current) continue;
        if (m.id !== undefined && m.id === startId && !m.method) {
          current.turn.turnId = String((m.result as { turn?: { id?: string } } | undefined)?.turn?.id);
          save();
          continue;
        }
        if (!m.method) continue; // answers to our other requests
        current.turn.messages.push(m);
        save();
        if (m.method === "turn/completed") current = undefined;
      }
    });
    pending.push(
      new Promise<void>((resolve) =>
        child.once("exit", () => {
          if (current) {
            current.turn.exited = true;
            save();
          }
          resolve();
        }),
      ),
    );
    return Object.assign(Object.create(child) as object, {
      stdin,
      stdout: child.stdout,
      pid: child.pid,
      once: child.once.bind(child),
      kill: child.kill.bind(child),
    }) as CodexChild;
  };
}

/** Builders for hand-made recordings (shapes as app-server 0.165.0 sends them). */
export const cx = {
  threadId: T,
  turnId: U,
  delta: (text: string): Json => ({
    method: "item/agentMessage/delta",
    params: { threadId: T, turnId: U, itemId: "msg_1", delta: text },
  }),
  reasoning: (text: string): Json => ({
    method: "item/reasoning/summaryTextDelta",
    params: { threadId: T, turnId: U, itemId: "rs_1", delta: text, summaryIndex: 0 },
  }),
  item: (phase: "started" | "completed", item: Json): Json => ({
    method: `item/${phase}`,
    params: { item, threadId: T, turnId: U },
  }),
  mcp: (
    phase: "started" | "completed",
    o: { id: string; server?: string; tool: string; args?: unknown; result?: unknown; failed?: string },
  ): Json =>
    cx.item(phase, {
      type: "mcpToolCall",
      id: o.id,
      server: o.server ?? "agentlee",
      tool: o.tool,
      status: phase === "started" ? "inProgress" : o.failed ? "failed" : "completed",
      arguments: o.args ?? {},
      result:
        phase === "completed" && !o.failed
          ? { content: [{ type: "text", text: JSON.stringify(o.result ?? {}) }], structuredContent: null }
          : null,
      error: o.failed ? { message: o.failed } : null,
    }),
  usage: (total: Json, last: Json): Json => ({
    method: "thread/tokenUsage/updated",
    params: { threadId: T, turnId: U, tokenUsage: { total, last, modelContextWindow: 258400 } },
  }),
  tokens: (input: number, cached: number, output: number) => ({
    totalTokens: input + output,
    inputTokens: input,
    cachedInputTokens: cached,
    cacheWriteInputTokens: 0,
    outputTokens: output,
    reasoningOutputTokens: 0,
  }),
  error: (info: unknown, willRetry = false): Json => ({
    method: "error",
    params: {
      error: { message: "x", codexErrorInfo: info, additionalDetails: null },
      willRetry,
      threadId: T,
      turnId: U,
    },
  }),
  rateLimits: (reached: string | null): Json => ({
    method: "account/rateLimits/updated",
    params: { rateLimits: { limitId: "codex", primary: null, rateLimitReachedType: reached } },
  }),
  completed: (status: "completed" | "interrupted" | "failed", info: unknown = null): Json => ({
    method: "turn/completed",
    params: {
      threadId: T,
      turn: {
        id: U,
        items: [],
        status,
        error: status === "failed" ? { message: "x", codexErrorInfo: info } : null,
      },
    },
  }),
  /** A plain answer streamed word by word. */
  answer: (text: string): RecordedTurn => ({
    threadId: T,
    turnId: U,
    messages: [
      ...text.split(/(?<= )/).map((w) => cx.delta(w)),
      cx.usage(cx.tokens(100, 40, 7), cx.tokens(100, 40, 7)),
      cx.completed("completed"),
    ],
  }),
};
