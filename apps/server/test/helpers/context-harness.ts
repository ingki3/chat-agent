import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { CSRF_HEADER, Message, StartRunResponse, type MessagePart, type RuntimeId } from "@agentlee/shared";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createTestDb } from "../../src/db/client.js";
import type { MessageRow } from "../../src/conversations/store.js";
import type { RuntimeRegistry } from "../../src/runtime/adapter.js";
import type { ContextOptions } from "../../src/runtime/context.js";
import type { RunRow } from "../../src/runtime/runs.js";
import { createFamily, type Family } from "./permission-matrix.js";

/**
 * The #45 contract harness: the whole server (routes, run access, connections) with the given runtimes, and the
 * server's original of a run's context, computed from the stored rows on their own — never through the context
 * builder — so a test can compare it with what the runtime really got.
 */
export type Entry = { role: string; text: string };

export const CLAUDE_KEY = `sk-ant-CONTEXTTESTFAKE${"c".repeat(24)}`;
export const CODEX_KEY = `sk-CONTEXTTESTFAKE${"x".repeat(24)}`;

/** A message's text as a runtime must get it: its text parts, nothing else (no reasoning, no tool data). */
export const textOf = (m: Pick<MessageRow, "parts">) =>
  (m.parts as MessagePart[])
    .flatMap((p) => (p.type === "text" ? [p.text] : []))
    .join("\n")
    .trim();

export async function startContextApp(
  runtimes: RuntimeRegistry,
  o: { context?: Partial<ContextOptions>; closers: (() => Promise<unknown> | unknown)[] },
) {
  const dataDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "agentlee-context-"));
  o.closers.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const db = createTestDb();
  const app = await buildApp(loadConfig({ NODE_ENV: "test", DATA_DIR: dataDir }), {
    db,
    logger: false,
    runtimes,
    runs: { flushMs: 0, ...(o.context ? { context: o.context } : {}) },
  });
  o.closers.push(() => app.close());
  const f = await createFamily(app);
  const req = (method: "GET" | "POST" | "PUT", url: string, body?: object) =>
    app.inject({
      method,
      url,
      headers: {
        host: "localhost:3000",
        cookie: f.cookies.owner,
        ...(method === "GET" ? {} : { origin: "http://localhost:3000", [CSRF_HEADER]: "1" }),
      },
      ...(method === "GET" ? {} : { payload: body ?? {} }),
    });
  const store = app.connections!.store;
  /** A `passed` API key connection of `runtime`: the owner's own, or the family's shared one. */
  const connect = (runtime: RuntimeId, scope: "personal" | "shared" = "personal") => {
    const c = store.create({
      runtime,
      authType: "api_key",
      scope,
      owner: scope === "personal" ? f.users.owner : null,
      createdBy: f.users.admin.id,
      secret: runtime === "codex" ? CODEX_KEY : CLAUDE_KEY,
    });
    store.setTestResult(c.id, "passed", "ok", 1);
    return c;
  };
  const settle = async (runId: string): Promise<RunRow> => {
    for (let i = 0; i < 1000; i++) {
      const r = app.runs!.get(runId);
      if (r?.endedAt) return r;
      await new Promise((res) => setTimeout(res, 5));
    }
    throw new Error("run did not end");
  };
  const started = async (res: Awaited<ReturnType<typeof req>>) => {
    expect([200, 201], res.body).toContain(res.statusCode);
    const run = await settle(StartRunResponse.parse(res.json()).run.id);
    expect(run.status, run.errorCode ?? "").toBe("done");
    return run;
  };
  const newConversation = async () => {
    const r = await req("POST", "/api/conversations", {});
    expect(r.statusCode).toBe(201);
    return (r.json() as { id: string }).id;
  };
  const send = (cid: string, text: string, extra: object = {}) =>
    req("POST", `/api/conversations/${cid}/messages`, { text, ...extra }).then(started);
  const edit = (cid: string, messageId: string, text: string) =>
    req("POST", `/api/conversations/${cid}/messages/${messageId}/edit`, { text }).then(started);
  const regenerate = (cid: string, messageId: string) =>
    req("POST", `/api/conversations/${cid}/messages/${messageId}/regenerate`, {}).then(started);
  /** The chip (#19): from the next message on. */
  const chip = async (cid: string, body: object) => {
    const r = await req("PUT", `/api/conversations/${cid}/settings`, body);
    expect(r.statusCode, r.body).toBe(200);
  };
  const messages = async (cid: string) =>
    Message.array().parse(
      (await req("GET", `/api/conversations/${cid}/messages`)).json<{ items: unknown }>().items,
    );

  /**
   * The run's context as the server's own records say it must be: the active messages before the reply minus the
   * turn's input (the last user message), each message's text only — the newest stored summary whose last message
   * is still in that history (an edit or regenerate before it cuts that message) standing in for what it covers.
   */
  const original = (run: RunRow): { entries: Entry[]; input: string; summaryId: string | null } => {
    const rows = app.conversations!.messages(run.conversationId, { limit: 10_000 });
    const before = rows.filter((m) => m.id !== run.assistantMessageId);
    const lastUser = before.findLast((m) => m.role === "user")!;
    const history = before.filter((m) => m !== lastUser);
    const summary = summaries(run.conversationId)
      .reverse()
      .find((s) => history.some((m) => m.id === s.throughMessageId));
    const entries: Entry[] = [
      ...(summary ? [{ role: "summary", text: summary.summary.trim() }] : []),
      ...history
        .filter((m) => !summary || m.seq > summary.throughSeq)
        .map((m) => ({ role: m.role, text: textOf(m) }))
        .filter((e) => e.text !== ""),
    ];
    return { entries, input: textOf(lastUser), summaryId: summary?.id ?? null };
  };
  const sessions = (cid: string) =>
    db.$client
      .prepare(
        "select id, runtime, connection_id as connectionId, external_session_id as ext, model, summary_id as summaryId, trimmed, invalidated from runtime_sessions where conversation_id = ? order by created_at, rowid",
      )
      .all(cid) as {
      id: string;
      runtime: string;
      connectionId: string | null;
      ext: string;
      model: string | null;
      summaryId: string | null;
      trimmed: number;
      invalidated: number;
    }[];
  const summaries = (cid: string) =>
    db.$client
      .prepare(
        "select id, through_message_id as throughMessageId, through_seq as throughSeq, summary, runtime, model, run_id as runId from conversation_summaries where conversation_id = ? order by created_at, rowid",
      )
      .all(cid) as {
      id: string;
      throughMessageId: string;
      throughSeq: number;
      summary: string;
      runtime: string;
      model: string;
      runId: string;
    }[];
  const usage = (runId: string) =>
    db.$client
      .prepare("select attempt, purpose, model from usage_records where run_id = ? order by attempt")
      .all(runId) as { attempt: number; purpose: string; model: string }[];
  return {
    app,
    db,
    f: f as Family,
    connect,
    newConversation,
    send,
    edit,
    regenerate,
    chip,
    messages,
    original,
    sessions,
    summaries,
    usage,
  };
}

export const randomFact = () => `종목-${crypto.randomBytes(3).toString("hex")}`;
