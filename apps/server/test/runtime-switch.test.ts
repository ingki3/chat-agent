import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  CSRF_HEADER,
  type CitationNotePart,
  type MessagePart,
  type Run,
  type RuntimeId,
  type UploadedFile,
} from "@agentlee/shared";
import { SELFTEST_SKILL } from "@agentlee/mcp-tools/skills";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { inProcessExtractor, ocrCapability } from "../src/files/extract.js";
import { RuntimeRegistry, type RuntimeAdapter } from "../src/runtime/adapter.js";
import { ClaudeAdapter } from "../src/runtime/claude.js";
import { CODEX_MODELS, CodexAdapter } from "../src/runtime/codex.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import {
  CITATION_SCENARIOS,
  FIXTURE_PAGES,
  fixtureWebWorker,
  resolveRefs,
} from "../src/runtime/fake-citations.js";
import { ASSIGNMENT_TABLE3_ROW2, FILE_SCENARIOS, REPORT_PAGE12 } from "../src/runtime/fake-files.js";
import { readReferences, switchScenario, type ReadReferences } from "../src/runtime/fake-switch.js";
import type { RunRow } from "../src/runtime/runs.js";
import { replayQuery, sdk, type ReplayLog } from "./helpers/claude-replay.js";
import { cx, newLog, replaySpawn, type ReplayLog as CodexLog } from "./helpers/codex-replay.js";
import { liveCall } from "./helpers/live-mcp.js";
import { createFamily } from "./helpers/permission-matrix.js";

/**
 * #53 completion criterion (FR-3.5, 수용 기준 8·11) with both real runtimes' recorded protocols — the Claude Agent SDK
 * replay and the codex app-server replay, with real calls of our MCP server: after a runtime switch the new runtime
 * goes on with the conversation's uploaded files, cited sources and artifacts **by the ids its start context named**
 * (read back from the prompt the adapter really sent — never handed to it otherwise), in both directions:
 * - PDF·HWP uploaded, switch → the same files cited (12쪽, 3번째 표 · 2행 · 2열), verified
 * - a web source cited, switch → the same source cited again, verified against its stored text
 * - artifact v1, switch → read it, v2 saved on the same artifact
 * - a shared conversation forked (#52), switch → the copies (files, artifact), and the copied source (no stored text)
 *   re-fetched before it is cited
 * And both runtimes are told the same references for the same conversation.
 */

const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "runtime-switch-"));
  closers.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const FIX = path.resolve(import.meta.dirname, "../../../fixtures/extract");
const LOCAL = { host: "localhost:3000" };
const WRITE = { ...LOCAL, origin: "http://localhost:3000", [CSRF_HEADER]: "1" };
const stubProxy = {
  endpoint: async () => ({ port: 9, url: "http://127.0.0.1:9", close: async () => {} }),
  close: async () => {},
};

const PAGE_A = FIXTURE_PAGES[0]!;
const PAGE_A_SNIPPET = "메모리 가격 회복이 증가를 이끌었다";
const V1 = "# 회의 메모 v1\n- 관심 종목: 삼성전자";
const V2 = "# 회의 메모 v2\n- 관심 종목: 삼성전자\n- 목표가: 25만원";

/** The calls and answer of a prompt, whichever runtime gets it; `$refs.*` from the session's start context. */
function scriptFor(
  prompt: string,
  refs: ReadReferences,
): { calls: { tool: string; input: unknown }[]; answer: string } {
  if (prompt === "/file-compare") return FILE_SCENARIOS.compare;
  if (prompt === "/cite partial") return CITATION_SCENARIOS.partial;
  const art = /^\/artifact markdown (.+)\n([\s\S]+)$/.exec(prompt);
  if (art)
    return {
      calls: [{ tool: "artifact_create", input: { kind: "markdown", title: art[1]!, content: art[2]! } }],
      answer: "만들었어요.",
    };
  const sw = switchScenario(prompt);
  if (sw)
    return {
      // Only `$refs.…` here; `$0.…` (an earlier call of this turn) is the replay's own (live-mcp.ts).
      calls: sw.calls.map((c) => ({
        tool: c.tool,
        input: resolveRefs(c.input, (id) => (id === "refs" ? refs : undefined)),
      })),
      answer: sw.answer,
    };
  return { calls: [], answer: `알겠어요: ${prompt}` };
}

/** A recording that answers every prompt (computed when the prompt arrives). */
const anyPrompt = <T>(turn: (prompt: string) => T) =>
  new Proxy({} as Record<string, T>, {
    get: (_t, k) => (typeof k === "string" ? turn(k) : undefined),
    has: () => true,
  });

/** What a fresh Claude session was told (its system prompt), the latest one. */
const claudePrior = (log: ReplayLog) =>
  String(log.options.findLast((o: Options) => o.sessionId !== undefined)?.systemPrompt ?? "");
/** What a fresh Codex thread was told (its developer instructions), the latest one. */
const codexPrior = (log: CodexLog) =>
  String(log.requests.findLast((r) => r.method === "thread/start")?.params.developerInstructions ?? "");
const refsBlock = (prior: string) =>
  /<conversation_references>[\s\S]*?<\/conversation_references>/.exec(prior)?.[0] ?? null;

const unwired = (a: RuntimeAdapter): RuntimeAdapter => ({
  id: a.id,
  capabilities: () => ({ ...a.capabilities(), needsConnection: false }),
  start: (c) => a.start(c),
  resume: (id, c) => a.resume(id, c),
});

async function start() {
  const root = tmp();
  const claudeLog: ReplayLog = { options: [], prompts: [], interrupts: 0, closes: 0 };
  const codexLog = newLog();
  const runtimes = new RuntimeRegistry();
  runtimes.register(
    unwired(
      new ClaudeAdapter({
        connection: () => ({
          id: "c1",
          dir: path.join(root, "claude"),
          auth: { kind: "api_key", apiKey: "sk-ant-api03-TESTKEY-" + "s".repeat(20) },
        }),
        query: replayQuery(
          anyPrompt((p): SDKMessage[] => {
            const sc = scriptFor(p, readReferences(claudePrior(claudeLog)));
            return [
              sdk.init({ session: crypto.randomUUID() }),
              ...sc.calls.map((c, i) => liveCall(String(i), c.tool, c.input) as unknown as SDKMessage),
              sdk.delta(sc.answer),
              sdk.result(),
            ];
          }),
          claudeLog,
          1,
        ),
        spawn: () => {
          throw new Error("not spawned in replay");
        },
      }),
    ),
  );
  runtimes.register(
    unwired(
      new CodexAdapter({
        connection: () => ({
          id: "c2",
          dir: path.join(root, "codex"),
          auth: { kind: "api_key", apiKey: "sk-proj-TESTKEY" + "s".repeat(30) },
        }),
        spawn: replaySpawn(
          anyPrompt((p) => {
            const sc = scriptFor(p, readReferences(codexPrior(codexLog)));
            return {
              threadId: cx.threadId,
              turnId: cx.turnId,
              messages: [
                ...sc.calls.map(
                  (c, i) => liveCall(String(i), c.tool, c.input) as unknown as Record<string, unknown>,
                ),
                cx.delta(sc.answer),
                cx.usage(cx.tokens(10, 0, 2), cx.tokens(10, 0, 2)),
                cx.completed("completed"),
              ],
            };
          }),
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
    ),
  );
  const db = createTestDb();
  const app = await buildApp(loadConfig({ NODE_ENV: "test", DATA_DIR: path.join(root, "data") }), {
    db,
    logger: false,
    runtimes,
    runs: { flushMs: 0 },
    extract: {
      runner: inProcessExtractor(() => ocrCapability(path.join(os.tmpdir(), "agentlee-test-ocr-lang"))),
    },
    web: { worker: fixtureWebWorker(), fetchProxy: stubProxy as never, providers: ["duckduckgo"] },
    mcp: { skills: [SELFTEST_SKILL], egress: () => stubProxy },
  });
  closers.push(() => app.close());
  const f = await createFamily(app);
  const api = (cookie: string, method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: { ...(method === "GET" ? LOCAL : WRITE), cookie },
      ...(method === "GET" ? {} : { payload: payload ?? {} }),
    });
  const upload = async (cookie: string, conversationId: string, name: string) => {
    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/files`,
      headers: {
        ...WRITE,
        cookie,
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(name),
        "x-upload-id": crypto.randomUUID(),
      },
      payload: fs.readFileSync(path.join(FIX, name)),
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as UploadedFile;
  };
  const settle = async (runId: string) => {
    for (let i = 0; i < 3000; i++) {
      const r = app.runs!.get(runId)!;
      if (r.endedAt !== null) {
        const parts = app.conversations!.messageById(r.assistantMessageId)!.parts as MessagePart[];
        const results = parts.flatMap((p) => (p.type === "tool_result" ? [p] : []));
        return {
          run: r as RunRow,
          parts,
          outputs: results.map((p) => (p as { output?: unknown }).output as Record<string, unknown>),
          errors: results.map((p) => (p as { isError?: boolean }).isError ?? false),
          note: parts.find((p): p is CitationNotePart => p.type === "citation_note"),
        };
      }
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error("run did not end");
  };
  const send = async (cookie: string, cid: string, text: string, fileIds?: string[]) => {
    const res = await api(cookie, "POST", `/api/conversations/${cid}/messages`, {
      text,
      ...(fileIds ? { fileIds } : {}),
    });
    expect(res.statusCode, res.body).toBe(201);
    const r = await settle((res.json() as { run: Run }).run.id);
    expect(r.run.status, r.run.errorCode ?? "").toBe("done");
    return r;
  };
  /** The chip (#19): this conversation's runtime from the next message on. */
  const chip = async (cookie: string, cid: string, runtime: RuntimeId) => {
    const r = await api(cookie, "PUT", `/api/conversations/${cid}/settings`, { runtime });
    expect(r.statusCode, r.body).toBe(200);
  };
  /** What the runtime of the last run was told at its session's start (the prompt the adapter really sent). */
  const priorOf = (runtime: string) => (runtime === "codex" ? codexPrior(codexLog) : claudePrior(claudeLog));
  /** Whether the runtime's last turn was the first of a fresh session. */
  const lastFresh = (runtime: string) =>
    runtime === "codex"
      ? codexLog.requests.filter((r) => r.method === "thread/start" || r.method === "turn/start").at(-2)
          ?.method === "thread/start"
      : claudeLog.options.at(-1)!.sessionId !== undefined;
  return { app, db, f, api, upload, send, chip, priorOf, lastFresh };
}
type T = Awaited<ReturnType<typeof start>>;

/**
 * Where a file is in the references (they are listed in the file store's order — uploads, and a fork's copies, can
 * share a millisecond, so not necessarily the upload order).
 */
const fileIndex = (t: T, cid: string, name: string) => {
  const i = t.app.files!.list(cid).findIndex((x) => x.name === name);
  expect(i).toBeGreaterThanOrEqual(0);
  return i;
};

/** The cites of a run's note: [status, title, site]. */
const cites = (r: { note?: CitationNotePart | undefined }) =>
  r.note?.citations.map((c) => [c.status, c.title, c.site]) ?? [];

/**
 * The first runtime's part: PDF + HWP compared (two verified file citations), a web page cited, artifact v1.
 * Returns the ids the server stored.
 */
async function firstPart(t: T, cookie: string, cid: string) {
  const pdf = await t.upload(cookie, cid, "report.pdf");
  const hwp = await t.upload(cookie, cid, "assignment.hwp");
  const compared = await t.send(cookie, cid, "/file-compare", [pdf.id, hwp.id]);
  expect(cites(compared)).toEqual([
    ["verified", "report.pdf", "12쪽"],
    ["verified", "assignment.hwp", "3번째 표 · 2행 · 2열"],
  ]);
  const web = await t.send(cookie, cid, "/cite partial");
  const sourceId = web.note!.citations[0]!.sourceId!;
  expect(cites(web)).toEqual([["verified", PAGE_A.title, PAGE_A.site]]);
  const made = await t.send(cookie, cid, `/artifact markdown 회의 메모\n${V1}`);
  const artifactId = String(made.outputs[0]!.artifactId);
  expect(t.app.artifacts!.get(artifactId)!.latestVersion).toBe(1);
  return { pdf, hwp, sourceId, artifactId };
}

const DIRECTIONS: [RuntimeId, RuntimeId][] = [
  ["claude-code", "codex"],
  ["codex", "claude-code"],
];

describe("runtime switch with files, sources and artifacts (#53, both runtimes' recorded protocols)", () => {
  for (const [from, to] of DIRECTIONS) {
    it(`${from} → ${to}: the same files and source cited again, artifact v1 → v2 — by the ids the context named`, async () => {
      const t = await start();
      const owner = t.f.cookies.owner;
      const cid = t.app.conversations!.create(t.f.users.owner.id).id;
      await t.chip(owner, cid, from);
      const ids = await firstPart(t, owner, cid);

      await t.chip(owner, cid, to);
      // The HWP: the first turn of the new runtime's fresh session, its id read from what the runtime was told.
      const hwp = await t.send(
        owner,
        cid,
        `/ref-file-cite ${fileIndex(t, cid, "assignment.hwp")} ${ASSIGNMENT_TABLE3_ROW2}`,
      );
      expect(hwp.run.runtime).toBe(to);
      expect(t.lastFresh(to)).toBe(true);
      const prior = t.priorOf(to);
      expect(readReferences(prior)).toEqual({
        file: t.app.files!.list(cid).map((x) => x.id),
        artifact: [ids.artifactId],
        source: [ids.sourceId],
        sourceUrl: [PAGE_A.url],
      });
      // Every reference's name inside the data block, the server's hint outside it, naming this session's tools.
      expect(prior).toContain("- assignment.hwp (file:");
      expect(prior).toContain("artifact_read로 지금 내용을 읽는다");
      expect(prior).not.toContain("본문이 저장되지 않은 출처");
      expect(cites(hwp)).toEqual([["verified", "assignment.hwp", "3번째 표 · 2행 · 2열"]]);
      expect(hwp.note!.citations[0]!.locator!.fileId).toBe(ids.hwp.id);
      expect(new Set(readReferences(prior).file)).toEqual(new Set([ids.pdf.id, ids.hwp.id]));
      // The PDF, in the same (resumed) session: it keeps what it was told.
      const pdf = await t.send(
        owner,
        cid,
        `/ref-file-cite ${fileIndex(t, cid, "report.pdf")} ${REPORT_PAGE12.summary}`,
      );
      expect(t.lastFresh(to)).toBe(false);
      expect(cites(pdf)).toEqual([["verified", "report.pdf", "12쪽"]]);
      expect(pdf.note!.citations[0]!.locator).toMatchObject({ fileId: ids.pdf.id, page: 12 });

      // The web source: cited again against its stored text, the same source.
      const again = await t.send(owner, cid, `/ref-cite 0 ${PAGE_A_SNIPPET}`);
      expect(cites(again)).toEqual([["verified", PAGE_A.title, PAGE_A.site]]);
      expect(again.note!.citations[0]!.sourceId).toBe(ids.sourceId);

      // The artifact: read (v1, which this runtime never saw), then v2 on the same artifact by this run.
      const edited = await t.send(owner, cid, `/ref-artifact-update 0\n${V2}`);
      expect(edited.errors).toEqual([false, false]);
      expect(edited.outputs[0]).toMatchObject({ artifactId: ids.artifactId, version: 1, latestVersion: 1 });
      expect(String(edited.outputs[0]!.content)).toContain(V1);
      expect(edited.outputs[1]).toMatchObject({ artifactId: ids.artifactId, version: 2 });
      expect(t.app.artifacts!.version(ids.artifactId, 2)).toMatchObject({
        content: V2,
        runId: edited.run.id,
      });
      expect(edited.parts).toContainEqual({ type: "artifact_ref", artifactId: ids.artifactId, version: 2 });

      // Back to the first runtime: a fresh session told v2 — and exactly what the other runtime is told for the
      // same conversation (the same rendering, whichever runtime).
      await t.chip(owner, cid, from);
      await t.send(
        owner,
        cid,
        `/ref-file-cite ${fileIndex(t, cid, "report.pdf")} ${REPORT_PAGE12.volunteers}`,
      );
      expect(t.lastFresh(from)).toBe(true);
      const fromBlock = refsBlock(t.priorOf(from));
      expect(fromBlock).toContain(`회의 메모 — markdown v2 (artifact:${ids.artifactId})`);
      await t.chip(owner, cid, to);
      await t.send(owner, cid, "다시 정리해 줘");
      expect(t.lastFresh(to)).toBe(true);
      expect(refsBlock(t.priorOf(to))).toBe(fromBlock);
    }, 60_000);
  }

  for (const [from, to] of DIRECTIONS) {
    it(`a forked shared conversation, ${from} → ${to}: the copies are cited and changed, the copied source re-fetched`, async () => {
      const t = await start();
      const owner = t.f.cookies.owner;
      const cid = t.app.conversations!.create(t.f.users.owner.id).id;
      await t.chip(owner, cid, from);
      const orig = await firstPart(t, owner, cid);
      const share = await t.api(owner, "POST", `/api/conversations/${cid}/shares`, {
        target: { audience: "family" },
        mode: "live",
      });
      expect(share.statusCode, share.body).toBe(201);
      const viewer = t.f.cookies.shared;
      const forked = await t.api(viewer, "POST", `/api/shares/${share.json<{ id: string }>().id}/fork`);
      expect(forked.statusCode, forked.body).toBe(201);
      const fid = forked.json<{ conversation: { id: string } }>().conversation.id;

      // The fork's first message, on `to`: a fresh session told the copies' ids — none of the original's.
      await t.chip(viewer, fid, to);
      const hwpAt = fileIndex(t, fid, "assignment.hwp");
      const hwp = await t.send(viewer, fid, `/ref-file-cite ${hwpAt} ${ASSIGNMENT_TABLE3_ROW2}`);
      expect(hwp.run.runtime).toBe(to);
      const prior = t.priorOf(to);
      const refs = readReferences(prior);
      const files = t.app.files!.list(fid);
      const copies = t.app.artifacts!.list(fid);
      const sources = t.db.$client
        .prepare("select id, body from sources where conversation_id = ? order by rowid")
        .all(fid) as { id: string; body: string | null }[];
      expect(sources.map((x) => x.body)).toEqual([null]);
      expect(refs.file).toEqual(files.map((x) => x.id));
      expect(refs.artifact).toEqual(copies.map((x) => x.id));
      expect(refs.source).toEqual(sources.map((x) => x.id));
      for (const id of [orig.pdf.id, orig.hwp.id, orig.artifactId, orig.sourceId])
        expect(prior).not.toContain(id);
      // The copied source has no page text (#52): the context says so, outside the data block.
      expect(prior).toContain(`본문이 저장되지 않은 출처(source:${refs.source[0]})`);
      expect(cites(hwp)).toEqual([["verified", "assignment.hwp", "3번째 표 · 2행 · 2열"]]);
      expect(hwp.note!.citations[0]!.locator!.fileId).toBe(refs.file[hwpAt]);

      // Citing the copied source as it is would not be verified — and is not shown as verified.
      const asIs = await t.send(viewer, fid, `/ref-cite 0 ${PAGE_A_SNIPPET}`);
      expect(asIs.note!.citations[0]!.status).not.toBe("verified");
      // Fetched again by its URL, then cited: verified, a new source of the fork.
      const refetched = await t.send(viewer, fid, `/ref-refetch-cite 0 ${PAGE_A_SNIPPET}`);
      expect(cites(refetched)).toEqual([["verified", PAGE_A.title, PAGE_A.site]]);
      expect(refetched.note!.citations[0]!.sourceId).not.toBe(refs.source[0]);

      // The artifact copy: read and changed; the original stays as it was.
      const edited = await t.send(viewer, fid, `/ref-artifact-update 0\n${V2}`);
      expect(edited.errors).toEqual([false, false]);
      expect(String(edited.outputs[0]!.content)).toContain(V1);
      const copy = t.app.artifacts!.get(refs.artifact[0]!)!;
      expect(copy.userId).toBe(t.f.users.shared.id);
      expect(t.app.artifacts!.version(copy.id, copy.latestVersion)).toMatchObject({ content: V2 });
      expect(t.app.artifacts!.get(orig.artifactId)!.latestVersion).toBe(1);

      // Switched back in the fork: the fresh session gets the new source (with its text) and the new version.
      await t.chip(viewer, fid, from);
      const back = await t.send(viewer, fid, `/ref-cite 1 ${PAGE_A_SNIPPET}`);
      expect(t.lastFresh(from)).toBe(true);
      expect(readReferences(t.priorOf(from)).source).toEqual([
        refs.source[0],
        refetched.note!.citations[0]!.sourceId,
      ]);
      expect(refsBlock(t.priorOf(from))).toContain(`markdown v${copy.latestVersion} (artifact:${copy.id})`);
      expect(cites(back)).toEqual([["verified", PAGE_A.title, PAGE_A.site]]);
    }, 60_000);
  }
});

describe("the FakeRuntime's switch commands (#53: the e2e run's runtimes)", () => {
  it("reads the ids from the rendered start context and uses them: source cited again, artifact v2", async () => {
    const runtimes = new RuntimeRegistry();
    const claude = new FakeRuntime({ runTools: true });
    const codex = new FakeRuntime({ id: "codex", runTools: true });
    runtimes.register(claude);
    runtimes.register(codex);
    const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
      db: createTestDb(),
      logger: false,
      runtimes,
      runs: { flushMs: 0 },
      web: { worker: fixtureWebWorker(), fetchProxy: stubProxy as never, providers: ["duckduckgo"] },
      mcp: { skills: [SELFTEST_SKILL], egress: () => stubProxy },
    });
    closers.push(() => app.close());
    const f = await createFamily(app);
    const cid = app.conversations!.create(f.users.owner.id).id;
    const send = async (text: string, runtime: RuntimeId) => {
      const res = await app.inject({
        method: "POST",
        url: `/api/conversations/${cid}/messages`,
        headers: { ...WRITE, cookie: f.cookies.owner },
        payload: { text, runtime },
      });
      expect(res.statusCode, res.body).toBe(201);
      const id = (res.json() as { run: Run }).run.id;
      for (let i = 0; i < 1000 && app.runs!.get(id)!.endedAt === null; i++)
        await new Promise((r) => setTimeout(r, 5));
      const run = app.runs!.get(id)!;
      expect(run.status).toBe("done");
      return app.conversations!.messageById(run.assistantMessageId)!.parts as MessagePart[];
    };
    const noteOf = (parts: MessagePart[]) =>
      parts.find((p): p is CitationNotePart => p.type === "citation_note")!;
    const web = await send("/cite partial", "claude-code");
    const sourceId = noteOf(web).citations[0]!.sourceId;
    await send(`/artifact markdown 회의 메모\n${V1}`, "claude-code");
    const again = await send(`/ref-cite 0 ${PAGE_A_SNIPPET}`, "codex");
    expect(noteOf(again).citations.map((c) => [c.status, c.sourceId])).toEqual([["verified", sourceId]]);
    const edited = await send(`/ref-artifact-update 0\n${V2}`, "codex");
    const [read, updated] = edited.flatMap((p) =>
      p.type === "tool_result" ? [(p as { output?: Record<string, unknown> }).output!] : [],
    );
    expect(String(read!.content)).toContain(V1);
    expect(updated).toMatchObject({ version: 2 });
    const a = app.artifacts!.list(cid)[0]!;
    expect(app.artifacts!.version(a.id, 2)!.content).toBe(V2);
    // Unknown references stay as written: never an id of something else.
    expect(readReferences("no references")).toEqual({ file: [], artifact: [], source: [], sourceUrl: [] });
    const missing = await send(`/ref-cite 5 ${PAGE_A_SNIPPET}`, "codex");
    expect(noteOf(missing).citations[0]!.status).not.toBe("verified");
  });
});
