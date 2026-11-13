import crypto from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CreateConversationShareRequest,
  CSRF_HEADER,
  SharedView,
  UpdateShareRequest,
  type Message,
  type Run,
  type Share,
} from "@agentlee/shared";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { messages } from "../src/db/schema.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { RuntimeRegistry } from "../src/runtime/adapter.js";
import { FakeRuntime, type FakeScript } from "../src/runtime/fake.js";
import { NotConversationOwnerError } from "../src/runtime/runs.js";
import { McpTokens } from "../src/isolation/tokens.js";
import { SourceStore } from "../src/web/sources.js";
import { CitationStore } from "../src/citations/store.js";
import { projectEvent, projectPart } from "../src/shares/projection.js";
import { createFamily } from "./helpers/permission-matrix.js";

type App = Awaited<ReturnType<typeof buildApp>>;
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

const REASONING = "비밀스러운 추론 과정";
const RAW = "도구 원본 결과 9f3a";
/** Every reply thinks, calls a tool whose raw output must never reach a viewer, then answers with the input. */
const script: FakeScript = (input) => [
  { reasoning: REASONING },
  { tool: "web_fetch", ms: 1, input: { url: "https://example.com" }, output: { raw: RAW } },
  ...(input.text.includes("천천히") ? [{ delayMs: 400 }] : []),
  { text: `답: ${input.text}` },
];

async function start() {
  const db = createTestDb();
  const runtimes = new RuntimeRegistry();
  runtimes.register(new FakeRuntime({ script }));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-share-"));
  const app = await buildApp(loadConfig({ NODE_ENV: "test", DATA_DIR: dataDir }), {
    db,
    logger: false,
    runtimes,
    runs: { flushMs: 0 },
    sse: { heartbeatMs: 1000 },
    renderer: { render: async () => ({ ok: true, body: Buffer.from("png"), type: "image/png" }) },
  });
  apps.push(app);
  app.addHook("onClose", async () => fs.rmSync(dataDir, { recursive: true, force: true }));
  const f = await createFamily(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const as = (cookie: string) => {
    const h = { host: "localhost:3000", cookie, origin: "http://localhost:3000", [CSRF_HEADER]: "1" };
    return {
      get: (url: string) => app.inject({ url, headers: { host: "localhost:3000", cookie } }),
      send: (method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload: object = {}) =>
        app.inject({ method, url, headers: h, payload }),
    };
  };
  const owner = as(f.cookies.owner);
  const viewer = as(f.cookies.shared);
  const stranger = as(f.cookies.stranger);
  const waitRun = async (id: string) => {
    for (let i = 0; i < 500; i++) {
      const r = (await owner.get(`/api/runs/${id}`)).json<Run>();
      if (r.endedAt !== null) return r;
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error("run did not finish");
  };
  /** Sends a message as the owner and waits for the reply: the user message, the reply and the run. */
  const say = async (conversationId: string, text: string, fileIds?: string[]) => {
    const r = await owner.send("POST", `/api/conversations/${conversationId}/messages`, {
      text,
      ...(fileIds ? { fileIds } : {}),
    });
    expect(r.statusCode).toBe(201);
    const body = r.json<{ message: Message; assistant: Message; run: Run }>();
    await waitRun(body.run.id);
    return { user: body.message, assistant: body.assistant, run: body.run };
  };
  const upload = async (conversationId: string, name: string, text: string) => {
    const tmp = app.files!.tempFile();
    fs.writeFileSync(tmp, text);
    return (
      await app.files!.add({
        userId: f.users.owner.id,
        conversationId,
        uploadId: crypto.randomUUID(),
        name,
        kind: "txt",
        bytes: Buffer.byteLength(text),
        sha256: crypto.createHash("sha256").update(text).digest("hex"),
        tmp,
      })
    ).id;
  };
  const sources = new SourceStore(db);
  const citations = new CitationStore(db);
  /** A page fetched and cited by the run (as its MCP tools would store them). */
  const cite = (conversationId: string, runId: string, url: string, body: string) => {
    const scope = { userId: f.users.owner.id, conversationId, runId };
    const src = sources.addPage(scope, {
      url,
      finalUrl: url,
      title: url,
      site: "example.com",
      contentType: "text/html",
      body,
      truncated: false,
    })!;
    citations.cite(scope, { sourceId: src.id, snippet: body.slice(0, 40) });
    return src.id;
  };
  const artifactScope = (conversationId: string, runId: string) => ({
    userId: f.users.owner.id,
    conversationId,
    runId,
  });
  const share = async (conversationId: string, body: unknown) => {
    const r = await owner.send("POST", `/api/conversations/${conversationId}/shares`, body as object);
    expect(r.statusCode).toBe(201);
    return r.json<Share>();
  };
  /** Opens an SSE stream (real HTTP) and reads it. */
  const stream = async (url: string, cookie: string) => {
    const res = await fetch(`${base}${url}`, { headers: { host: "localhost:3000", cookie } });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = async (re: RegExp) => {
      while (!re.test(text)) {
        const { value, done } = await reader.read();
        if (done) return { text, ended: true };
        text += decoder.decode(value);
      }
      return { text, ended: false };
    };
    const rest = async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return { text, ended: true };
        text += decoder.decode(value);
      }
    };
    return { status: res.status, until, rest };
  };
  return { app, db, f, owner, viewer, stranger, say, upload, cite, artifactScope, share, stream, waitRun };
}

/**
 * The #3 world: two turns before the share. Turn 1 (the boundary) sends file F1, makes artifact A v1 and cites S1;
 * turn 2 — after the boundary, but before the share — sends F2, makes A v2 and cites S2; the owner then reverts A to
 * v1 (v3, a copy no message made).
 */
async function snapshotWorld() {
  const w = await start();
  const c = w.app.conversations!.create(w.f.users.owner.id, { title: "과학 보고서" });
  const f1 = await w.upload(c.id, "첫째.txt", "첫째 파일");
  const t1 = await w.say(c.id, "첫 질문 사과", [f1]);
  const { artifact } = w.app.artifacts!.create(w.artifactScope(c.id, t1.run.id), {
    kind: "html",
    title: "표 v1",
    content: "<p>v1</p>",
  });
  const s1 = w.cite(
    c.id,
    t1.run.id,
    "https://a.example/1",
    "사과는 빨갛고 둥근 과일이며 여름에 많이 난다고 한다.",
  );
  const f2 = await w.upload(c.id, "둘째.txt", "둘째 파일");
  const t2 = await w.say(c.id, "둘째 질문 바나나", [f2]);
  w.app.artifacts!.update(w.artifactScope(c.id, t2.run.id), artifact.id, { content: "<p>v2</p>" });
  const s2 = w.cite(
    c.id,
    t2.run.id,
    "https://b.example/2",
    "바나나는 노랗고 길쭉한 과일이며 열대에서 자란다고 한다.",
  );
  // The owner restores v1 as v3 before sharing: made by no message, so not in a snapshot either.
  w.app.artifacts!.revert(artifact.id, 1);
  const share = await w.share(c.id, {
    target: { audience: "users", userIds: [w.f.users.shared.id] },
    mode: "snapshot",
    boundaryMessageId: t1.assistant.id,
  });
  return { ...w, c, f1, f2, t1, t2, a: artifact.id, s1, s2, share };
}

const ids = (xs: { id: string }[]) => xs.map((x) => x.id).sort();

describe("family sharing — snapshot scope (#29, decision #3)", () => {
  it("shows the boundary's messages and only what they brought; everything else is 403", async () => {
    const w = await snapshotWorld();
    const { viewer, c } = w;
    const msgs = (await viewer.get(`/api/conversations/${c.id}/messages`)).json<{ items: Message[] }>().items;
    expect(msgs.map((m) => m.id)).toEqual([w.t1.user.id, w.t1.assistant.id]);
    const raw = JSON.stringify(msgs);
    expect(raw).not.toContain(REASONING);
    expect(raw).not.toContain(RAW);
    expect(raw).toContain("tool_call"); // what was called stays visible (FR-3.4)

    // Messages after the boundary.
    for (const m of [w.t2.user, w.t2.assistant])
      expect((await viewer.get(`/api/conversations/${c.id}/messages/${m.id}/versions`)).statusCode).toBe(403);
    // Files: F1 (sent with the boundary's turn) only; F2 existed before the share but came after the boundary.
    expect(ids((await viewer.get(`/api/conversations/${c.id}/files`)).json().items)).toEqual([w.f1]);
    expect((await viewer.get(`/api/files/${w.f1}/content`)).statusCode).toBe(200);
    for (const url of [`/api/files/${w.f2}`, `/api/files/${w.f2}/content`])
      expect((await viewer.get(url)).statusCode).toBe(403);
    // Artifact: v1 only — v2 was made by turn 2 before the share.
    const detail = (await viewer.get(`/api/artifacts/${w.a}`)).json<{
      latestVersion: number;
      versions: { version: number }[];
    }>();
    expect(detail.latestVersion).toBe(1);
    expect(detail.versions.map((v) => v.version)).toEqual([1]);
    for (const tail of ["raw", "download", "png", "pdf"]) {
      expect((await viewer.get(`/a/${w.a}/v/1/${tail}`)).statusCode).toBe(200);
      expect((await viewer.get(`/a/${w.a}/v/2/${tail}`)).statusCode).toBe(403);
      expect((await viewer.get(`/a/${w.a}/v/3/${tail}`)).statusCode).toBe(403);
    }
    expect((await viewer.get(`/api/artifacts/${w.a}/versions/2`)).statusCode).toBe(403);
    // Sources: the ones the boundary's turn cited; S2 (turn 2) is not there.
    expect(ids((await viewer.get(`/api/conversations/${c.id}/sources`)).json().items)).toEqual([w.s1]);
    // The run of turn 2 is not followed either.
    expect((await viewer.get(`/api/runs/${w.t2.run.id}`)).statusCode).toBe(403);
    expect((await viewer.get(`/api/runs/${w.t1.run.id}`)).statusCode).toBe(200);
  });

  it("stays frozen: later uploads, versions and edits are 403, and the edited message keeps its shared text", async () => {
    const w = await snapshotWorld();
    const { viewer, owner, c } = w;
    const f3 = await w.upload(c.id, "셋째.txt", "셋째 파일");
    const t3 = await w.say(c.id, "셋째 질문", [f3]);
    w.app.artifacts!.update(w.artifactScope(c.id, t3.run.id), w.a, { content: "<p>v3</p>" });
    for (const url of [`/api/files/${f3}`, `/api/files/${f3}/content`, `/a/${w.a}/v/4/raw`])
      expect((await viewer.get(url)).statusCode).toBe(403);
    // An edit of a message inside the boundary: a new revision, not in the snapshot.
    const edited = await owner.send("POST", `/api/conversations/${c.id}/messages/${w.t1.user.id}/edit`, {
      text: "고친 질문",
    });
    expect(edited.statusCode).toBe(200);
    const newId = edited.json<{ message: Message; run: Run }>().message.id;
    await w.waitRun(edited.json<{ run: Run }>().run.id);
    expect((await viewer.get(`/api/conversations/${c.id}/messages/${newId}/versions`)).statusCode).toBe(403);
    const msgs = (await viewer.get(`/api/conversations/${c.id}/messages`)).json<{ items: Message[] }>().items;
    expect(msgs.map((m) => m.id)).toEqual([w.t1.user.id, w.t1.assistant.id]);
    expect(JSON.stringify(msgs)).toContain("첫 질문 사과");
    expect(JSON.stringify(msgs)).not.toContain("고친 질문");
    // The file sent with the edited message moved to the new revision; the snapshot still holds it.
    expect((await viewer.get(`/api/files/${w.f1}/content`)).statusCode).toBe(200);
    // The frozen list cannot be changed, even by SQL.
    expect(() => w.db.$client.prepare("update share_snapshots set revision = 99").run()).toThrow(/immutable/);
  });

  it("every read path matches the projection list (view, raw, download, search, fork/export bundle)", async () => {
    const w = await snapshotWorld();
    const { viewer, app, c } = w;
    const s = app.sharing!.store.get(w.share.id)!;
    const p = app.sharing!.project(s, w.f.users.shared.id)!;
    expect(p).not.toBeNull();
    const msgs = (await viewer.get(`/api/conversations/${c.id}/messages`)).json<{ items: Message[] }>().items;
    expect(msgs.map((m) => m.id).sort()).toEqual([...p.messages].sort());
    const files = (await viewer.get(`/api/conversations/${c.id}/files`)).json<{ items: { id: string }[] }>()
      .items;
    expect(ids(files)).toEqual([...p.files].sort());
    const arts = (await viewer.get(`/api/conversations/${c.id}/artifacts`)).json<{
      items: { id: string }[];
    }>().items;
    expect(ids(arts)).toEqual([...p.versions.keys()].sort());
    const srcs = (await viewer.get(`/api/conversations/${c.id}/sources`)).json<{ items: { id: string }[] }>()
      .items;
    expect(ids(srcs)).toEqual([...p.sources].sort());
    // Every file / version of the conversation: 200 exactly when it is in the projection.
    for (const fileId of [w.f1, w.f2])
      for (const url of [`/api/files/${fileId}`, `/api/files/${fileId}/content`])
        expect((await viewer.get(url)).statusCode).toBe(p.files.has(fileId) ? 200 : 403);
    for (const v of [1, 2, 3])
      for (const tail of ["raw", "download", "png"])
        expect((await viewer.get(`/a/${w.a}/v/${v}/${tail}`)).statusCode).toBe(
          p.versions.get(w.a)?.has(v) ? 200 : 403,
        );
    // The shared view, and the bundle that forks (#52), exports and references (#26) must use: the same list.
    const view = SharedView.parse((await viewer.get(`/api/shares/${w.share.id}/view`)).json());
    const bundle = app.sharing!.bundle(s, p);
    expect(view.messages).toEqual(bundle.messages);
    expect(ids(view.messages)).toEqual([...p.messages].sort());
    expect(ids(view.files)).toEqual([...p.files].sort());
    expect(view.artifacts.map((a) => [a.id, a.versions])).toEqual([[w.a, [1]]]);
    expect(ids(view.sources)).toEqual([...p.sources].sort());
    expect(JSON.stringify(view)).not.toContain(REASONING);
    expect(JSON.stringify(view)).not.toContain(RAW);
    // Search: what the shared messages say finds it; what only later messages say does not.
    const search = async (q: string) =>
      (await viewer.get(`/api/shared-with-me?q=${encodeURIComponent(q)}`)).json<{ items: { id: string }[] }>()
        .items;
    expect(ids(await search("사과"))).toEqual([w.share.id]);
    expect(await search("바나나")).toEqual([]);
    expect(await search(REASONING)).toEqual([]);
    // The stranger (not a target) sees none of it.
    expect((await w.stranger.get(`/api/conversations/${c.id}/messages`)).statusCode).toBe(403);
    expect((await w.stranger.get(`/api/shared-with-me`)).json().items).toEqual([]);
  });

  it("the reference export (#26) of a shared viewer lists what their projection cites only", async () => {
    const w = await snapshotWorld();
    const { viewer, owner, c } = w;
    // Each turn's answer cites its page (the note the run's end would write).
    const note = (n: number, sourceId: string, url: string) => ({
      type: "citation_note",
      missing: [],
      markers: [],
      citations: [
        {
          n,
          status: "verified",
          sourceId,
          title: url,
          site: "example.com",
          url,
          publishedAt: null,
          quote: "인용",
        },
      ],
    });
    for (const [m, src, url] of [
      [w.t1.assistant, w.s1, "https://a.example/1"],
      [w.t2.assistant, w.s2, "https://b.example/2"],
    ] as const)
      w.db
        .update(messages)
        .set({ parts: [...(m.parts as object[]), note(1, src, url)] as Message["parts"] })
        .where(eq(messages.id, m.id))
        .run();
    const list = async (who: typeof viewer) => {
      const r = await who.get(`/api/conversations/${c.id}/references?style=apa`);
      return { status: r.statusCode, text: r.statusCode === 200 ? r.json<{ text: string }>().text : "" };
    };
    const mine = await list(owner);
    expect(mine.text).toContain("https://a.example/1");
    expect(mine.text).toContain("https://b.example/2");
    // The snapshot ends at turn 1: turn 2's source is not the viewer's, in the list or the file.
    const theirs = await list(viewer);
    expect(theirs.status).toBe(200);
    expect(theirs.text).toContain("https://a.example/1");
    expect(theirs.text).not.toContain("b.example");
    const txt = await viewer.get(`/api/conversations/${c.id}/references/download?style=apa&format=txt`);
    expect(txt.statusCode).toBe(200);
    expect(txt.body).toContain("https://a.example/1");
    expect(txt.body).not.toContain("b.example");
    expect((await list(w.stranger)).status).toBe(403);
    // Revoked: nothing at once.
    expect((await owner.send("DELETE", `/api/shares/${w.share.id}`)).statusCode).toBe(200);
    expect((await list(viewer)).status).toBe(403);
  });

  it("a snapshot needs a finished boundary message of the conversation", async () => {
    const w = await start();
    const c = w.app.conversations!.create(w.f.users.owner.id);
    const other = w.app.conversations!.create(w.f.users.owner.id);
    const t = await w.say(other.id, "다른 대화");
    const target = { audience: "family" };
    const r = await w.owner.send("POST", `/api/conversations/${c.id}/shares`, {
      target,
      mode: "snapshot",
      boundaryMessageId: t.assistant.id,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("share_boundary_not_found");
    for (const body of [
      { target, mode: "snapshot" },
      { target, mode: "live", boundaryMessageId: t.assistant.id },
    ])
      expect((await w.owner.send("POST", `/api/conversations/${c.id}/shares`, body)).statusCode).toBe(400);
  });
});

describe("family sharing — live share, projection of parts and events (#29)", () => {
  it("includes new messages but never reasoning or raw tool results, in the API and the stream", async () => {
    const w = await start();
    const c = w.app.conversations!.create(w.f.users.owner.id);
    await w.say(c.id, "첫 질문");
    await w.share(c.id, { target: { audience: "family" }, mode: "live" });
    const r = await w.owner.send("POST", `/api/conversations/${c.id}/messages`, { text: "천천히 둘째" });
    const run = r.json<{ run: Run; assistant: Message }>();
    const s = await w.stream(`/api/runs/${run.run.id}/events`, w.f.cookies.shared);
    expect(s.status).toBe(200);
    const end = await s.rest();
    expect(end.text).toContain("event: done");
    expect(end.text).toContain("tool_end");
    expect(end.text).not.toContain(RAW);
    expect(end.text).not.toContain(REASONING);
    const msgs = (await w.viewer.get(`/api/conversations/${c.id}/messages`)).json<{ items: Message[] }>()
      .items;
    expect(msgs).toHaveLength(4);
    expect(JSON.stringify(msgs)).toContain("답: 천천히 둘째");
    expect(JSON.stringify(msgs)).not.toContain(RAW);
    // The owner still gets the tool output (only viewers are cut).
    const own = (await w.owner.get(`/api/conversations/${c.id}/messages`)).json<{ items: Message[] }>().items;
    expect(JSON.stringify(own)).toContain(RAW);
  });

  it("projectPart / projectEvent drop reasoning and raw tool output", () => {
    expect(projectPart({ type: "reasoning", text: "x" })).toBeNull();
    expect(projectPart({ type: "tool_result", callId: "c", output: { raw: 1 }, isError: true })).toEqual({
      type: "tool_result",
      callId: "c",
      output: null,
    });
    expect(projectEvent({ type: "tool_end", messageId: "m", callId: "c", output: "raw" })).toEqual({
      type: "tool_end",
      messageId: "m",
      callId: "c",
    });
    expect(
      projectEvent({
        type: "part_update",
        messageId: "m",
        partIndex: 1,
        part: { type: "tool_result", callId: "c", output: "raw" },
      }),
    ).toMatchObject({ part: { output: null } });
  });
});

describe("family sharing — revoke and change of target take effect at once (#29)", () => {
  async function liveWorld() {
    const w = await start();
    const c = w.app.conversations!.create(w.f.users.owner.id);
    const f1 = await w.upload(c.id, "자료.txt", "자료");
    const t1 = await w.say(c.id, "질문", [f1]);
    const { artifact } = w.app.artifacts!.create(w.artifactScope(c.id, t1.run.id), {
      kind: "html",
      title: "결과",
      content: "<p>x</p>",
    });
    const share = await w.share(c.id, {
      target: { audience: "users", userIds: [w.f.users.shared.id] },
      mode: "live",
    });
    const urls = [
      `/api/conversations/${c.id}`,
      `/api/conversations/${c.id}/messages`,
      `/api/conversations/${c.id}/files`,
      `/api/conversations/${c.id}/artifacts`,
      `/api/conversations/${c.id}/sources`,
      `/api/conversations/${c.id}/active-run`,
      `/api/files/${f1}`,
      `/api/files/${f1}/content`,
      `/api/artifacts/${artifact.id}`,
      `/api/artifacts/${artifact.id}/versions/1`,
      `/a/${artifact.id}`,
      `/a/${artifact.id}/v/1/raw`,
      `/a/${artifact.id}/v/1/download`,
      `/a/${artifact.id}/v/1/png`,
      `/api/runs/${t1.run.id}`,
      `/api/shares/${share.id}/view`,
    ];
    return { ...w, c, share, urls };
  }

  it("revoke: every URL is 403 right after, and open streams close", async () => {
    const w = await liveWorld();
    for (const u of w.urls) expect([u, (await w.viewer.get(u)).statusCode]).toEqual([u, 200]);
    const shareStream = await w.stream(`/api/shares/${w.share.id}/events`, w.f.cookies.shared);
    await shareStream.until(/event: ready/);
    // A run being written while the share is revoked: its stream to the viewer closes too.
    const r = await w.owner.send("POST", `/api/conversations/${w.c.id}/messages`, { text: "천천히 길게" });
    const runStream = await w.stream(`/api/runs/${r.json<{ run: Run }>().run.id}/events`, w.f.cookies.shared);
    await runStream.until(/event: (delta|tool_start)/);
    const del = await w.owner.send("DELETE", `/api/shares/${w.share.id}`);
    expect(del.statusCode).toBe(200);
    expect(del.json<Share>().revokedAt).not.toBeNull();
    const ended = await shareStream.rest();
    expect(ended.text).toMatch(/event: revoked/);
    expect(ended.ended).toBe(true);
    const runEnded = await runStream.rest();
    expect(runEnded.ended).toBe(true);
    expect(runEnded.text).not.toContain("event: done");
    for (const u of w.urls) expect([u, (await w.viewer.get(u)).statusCode]).toEqual([u, 403]);
    expect((await w.viewer.get(`/api/shared-with-me`)).json().items).toEqual([]);
    // The owner keeps everything.
    for (const u of w.urls.filter((x) => !x.includes("/shares/")))
      expect((await w.owner.get(u)).statusCode).toBe(200);
  });

  it("changing who it is for closes the old viewer's stream and opens it for the new one", async () => {
    const w = await liveWorld();
    const s = await w.stream(`/api/shares/${w.share.id}/events`, w.f.cookies.shared);
    await s.until(/event: ready/);
    expect((await w.stranger.get(`/api/conversations/${w.c.id}`)).statusCode).toBe(403);
    const r = await w.owner.send("PATCH", `/api/shares/${w.share.id}`, {
      target: { audience: "users", userIds: [w.f.users.stranger.id] },
    });
    expect(r.statusCode).toBe(200);
    expect((await s.rest()).text).toMatch(/event: revoked/);
    // Each account is told once, when the share first reaches it (FR-14.5): who and what, no content.
    const inbox = (id: string) =>
      w.db.$client.prepare("select kind, url, body from notifications where user_id = ?").all(id) as {
        kind: string;
        url: string;
        body: string;
      }[];
    expect(inbox(w.f.users.shared.id)).toEqual([
      expect.objectContaining({ kind: "share_received", url: `/shared/${w.share.id}` }),
    ]);
    expect(inbox(w.f.users.stranger.id)).toEqual([expect.objectContaining({ kind: "share_received" })]);
    expect(inbox(w.f.users.owner.id)).toEqual([]);
    for (const u of w.urls) {
      expect([u, (await w.viewer.get(u)).statusCode]).toEqual([u, 403]);
      expect([u, (await w.stranger.get(u)).statusCode]).toEqual([u, 200]);
    }
  });

  it("the owner's notice says downloads and forks are not taken back", async () => {
    const { SHARE_REVOKE_NOTICE } = await import("@agentlee/shared");
    expect(SHARE_REVOKE_NOTICE).toMatch(/내려받은 파일/);
    expect(SHARE_REVOKE_NOTICE).toMatch(/사본/);
  });
});

describe("family sharing — the owner must be active (#29)", () => {
  it("a deactivated owner's shares reach no one (streams close); reactivating restores them", async () => {
    const w = await start();
    const c = w.app.conversations!.create(w.f.users.owner.id);
    const t1 = await w.say(c.id, "질문");
    const share = await w.share(c.id, { target: { audience: "family" }, mode: "live" });
    const { artifact } = w.app.artifacts!.create(w.artifactScope(c.id, t1.run.id), {
      kind: "html",
      title: "결과",
      content: "<p>x</p>",
    });
    const shareStream = await w.stream(`/api/shares/${share.id}/events`, w.f.cookies.shared);
    await shareStream.until(/event: ready/);
    const artStream = await w.stream(`/api/artifacts/${artifact.id}/access`, w.f.cookies.shared);
    await artStream.until(/event: ready/);
    w.app.users!.deactivate(w.f.users.owner.id);
    expect((await shareStream.rest()).text).toMatch(/event: revoked/);
    expect((await artStream.rest()).text).toMatch(/event: revoked/);
    for (const u of [
      `/api/conversations/${c.id}`,
      `/api/conversations/${c.id}/messages`,
      `/a/${artifact.id}/v/1/raw`,
    ])
      expect([u, (await w.viewer.get(u)).statusCode]).toEqual([u, 403]);
    expect((await w.viewer.get("/api/shared-with-me")).json().items).toEqual([]);
    // Inactive, not revoked: reactivating the account (by the admin, directly in the database for now) restores it.
    w.db.$client.prepare("update users set active = 1 where id = ?").run(w.f.users.owner.id);
    expect((await w.viewer.get(`/api/conversations/${c.id}`)).statusCode).toBe(200);
    expect((await w.viewer.get(`/a/${artifact.id}/v/1/raw`)).statusCode).toBe(200);
  });
});

describe("family sharing — artifact access stream (#29)", () => {
  it("ends at once for the owner and closes for a viewer the moment the share goes", async () => {
    const w = await start();
    const c = w.app.conversations!.create(w.f.users.owner.id);
    const t1 = await w.say(c.id, "질문");
    const { artifact } = w.app.artifacts!.create(w.artifactScope(c.id, t1.run.id), {
      kind: "html",
      title: "결과",
      content: "<p>x</p>",
    });
    const own = await w.stream(`/api/artifacts/${artifact.id}/access`, w.f.cookies.owner);
    const ownEnd = await own.rest();
    expect(ownEnd.text).toMatch(/event: owner/);
    expect(ownEnd.ended).toBe(true);
    const r = await w.owner.send("POST", `/api/artifacts/${artifact.id}/shares`, {
      target: { audience: "users", userIds: [w.f.users.shared.id] },
      mode: "live",
    });
    const s = await w.stream(`/api/artifacts/${artifact.id}/access`, w.f.cookies.shared);
    await s.until(/event: ready/);
    await w.owner.send("DELETE", `/api/shares/${r.json<Share>().id}`);
    const end = await s.rest();
    expect(end.text).toMatch(/event: revoked/);
    expect(end.ended).toBe(true);
  });
});

describe("family sharing — targets are family accounts only (#29, FR-14.7)", () => {
  it("refuses an email address anywhere, and unknown, inactive or own accounts", async () => {
    const w = await start();
    const c = w.app.conversations!.create(w.f.users.owner.id);
    const post = (body: object) => w.owner.send("POST", `/api/conversations/${c.id}/shares`, body);
    const emails = [
      { target: { audience: "users", userIds: ["mom@example.com"] }, mode: "live" },
      { target: { audience: "users", userIds: [w.f.users.shared.id], email: "x@example.com" }, mode: "live" },
      { target: { audience: "users", emails: ["x@example.com"] }, mode: "live" },
      { target: { audience: "family" }, mode: "live", email: "x@example.com" },
      { target: { audience: "email", email: "x@example.com" }, mode: "live" },
      { target: "x@example.com", mode: "live" },
    ];
    for (const body of emails) {
      const r = await post(body);
      expect([JSON.stringify(body), r.statusCode]).toEqual([JSON.stringify(body), 400]);
    }
    // The request schemas themselves take no email at all.
    expect(CreateConversationShareRequest.safeParse(emails[0]).success).toBe(false);
    expect(UpdateShareRequest.safeParse({ target: { audience: "users", userIds: ["a@b.c"] } }).success).toBe(
      false,
    );
    const deactivated = w.app.users!.create({
      email: "gone@matrix.test",
      name: "gone",
      role: "member",
      passwordHash: "x",
    });
    w.app.users!.deactivate(deactivated.id);
    for (const id of [crypto.randomUUID(), deactivated.id, w.f.users.owner.id]) {
      const r = await post({ target: { audience: "users", userIds: [id] }, mode: "live" });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("invalid_share_target");
    }
    const ok = await post({ target: { audience: "users", userIds: [w.f.users.shared.id] }, mode: "live" });
    expect(ok.statusCode).toBe(201);
    const patched = await w.owner.send("PATCH", `/api/shares/${ok.json<Share>().id}`, {
      target: { audience: "users", userIds: ["mom@example.com"] },
    });
    expect(patched.statusCode).toBe(400);
    // No one chosen is never "the whole family": an empty list is refused, on create and on change.
    expect((await post({ target: { audience: "users", userIds: [] }, mode: "live" })).statusCode).toBe(400);
    const emptied = await w.owner.send("PATCH", `/api/shares/${ok.json<Share>().id}`, {
      target: { audience: "users", userIds: [] },
    });
    expect(emptied.statusCode).toBe(400);
    const still = (await w.owner.get(`/api/shares/${ok.json<Share>().id}`)).json<Share>();
    expect(still.audience).toBe("users");
    expect(still.targets.map((t) => t.id)).toEqual([w.f.users.shared.id]);
    // The picker lists names, never emails.
    const targets = await w.owner.get("/api/share-targets");
    expect(targets.body).not.toContain("@");
    expect(targets.json().items.map((t: { id: string }) => t.id)).not.toContain(w.f.users.owner.id);
  });

  it("a family share reaches every active account but the owner — the admin too, never a deactivated one", async () => {
    const w = await start();
    const c = w.app.conversations!.create(w.f.users.owner.id);
    await w.say(c.id, "가족 모두에게");
    await w.share(c.id, { target: { audience: "family" }, mode: "live" });
    for (const cookie of [w.f.cookies.shared, w.f.cookies.stranger, w.f.cookies.admin])
      expect(
        (
          await w.app.inject({
            url: `/api/conversations/${c.id}`,
            headers: { host: "localhost:3000", cookie },
          })
        ).statusCode,
      ).toBe(200);
    w.app.users!.deactivate(w.f.users.stranger.id);
    const s = w.app.sharing!.store.ofItem("conversation", c.id)[0]!;
    expect(w.app.sharing!.targets(s).sort()).toEqual([w.f.users.shared.id, w.f.users.admin.id].sort());
  });
});

describe("family sharing — a viewer is read-only (#29)", () => {
  it("refuses every write API, a run and the MCP scope to the viewer", async () => {
    const w = await start();
    const c = w.app.conversations!.create(w.f.users.owner.id);
    const f1 = await w.upload(c.id, "자료.txt", "자료");
    const t1 = await w.say(c.id, "질문", [f1]);
    const { artifact } = w.app.artifacts!.create(w.artifactScope(c.id, t1.run.id), {
      kind: "html",
      title: "결과",
      content: "<p>x</p>",
    });
    const share = await w.share(c.id, { target: { audience: "family" }, mode: "live" });
    const runsBefore = w.db.$client.prepare("select count(*) as n from runs").get() as { n: number };
    const writes: [Parameters<typeof w.viewer.send>[0], string, object][] = [
      ["POST", `/api/conversations/${c.id}/messages`, { text: "끼어들기" }],
      ["POST", `/api/conversations/${c.id}/messages/${t1.user.id}/edit`, { text: "바꾸기" }],
      ["POST", `/api/conversations/${c.id}/messages/${t1.assistant.id}/regenerate`, {}],
      ["PATCH", `/api/conversations/${c.id}`, { title: "내 것" }],
      ["PUT", `/api/conversations/${c.id}/settings`, { runtime: "codex" }],
      ["POST", `/api/conversations/${c.id}/fallback-notice/consume`, {}],
      ["DELETE", `/api/conversations/${c.id}`, {}],
      ["POST", `/api/runs/${t1.run.id}/interrupt`, {}],
      ["DELETE", `/api/files/${f1}`, {}],
      ["POST", `/api/artifacts/${artifact.id}/revert`, { version: 1 }],
      ["POST", `/api/conversations/${c.id}/shares`, { target: { audience: "family" }, mode: "live" }],
      ["POST", `/api/artifacts/${artifact.id}/shares`, { target: { audience: "family" }, mode: "live" }],
      ["PATCH", `/api/shares/${share.id}`, { target: { audience: "family" } }],
      ["DELETE", `/api/shares/${share.id}`, {}],
    ];
    for (const [method, url, body] of writes) {
      const r = await w.viewer.send(method, url, body);
      expect([method, url, r.statusCode]).toEqual([method, url, 403]);
    }
    const upload = await w.app.inject({
      method: "POST",
      url: `/api/conversations/${c.id}/files`,
      headers: {
        host: "localhost:3000",
        cookie: w.f.cookies.shared,
        origin: "http://localhost:3000",
        [CSRF_HEADER]: "1",
        "content-type": "application/octet-stream",
        "x-file-name": "a.txt",
      },
      payload: Buffer.from("x"),
    });
    expect(upload.statusCode).toBe(403);
    expect((w.db.$client.prepare("select count(*) as n from runs").get() as { n: number }).n).toBe(
      runsBefore.n,
    );
    // Past every route: the run manager itself refuses a run by someone who does not own the conversation, so no
    // run — and no MCP token, which only runs get — ever exists for the viewer.
    expect(() =>
      w.app.runs!.begin({
        conversationId: c.id,
        userId: w.f.users.shared.id,
        prepare: () => ({
          user: null,
          assistant: w.app.conversations!.append(c.id, { role: "assistant", parts: [] }),
        }),
      }),
    ).toThrow(NotConversationOwnerError);
    const tokens = new McpTokens();
    const scope = {
      userId: w.f.users.owner.id,
      conversationId: c.id,
      runId: t1.run.id,
      expiresAt: Date.now() + 1000,
    };
    expect(tokens.allows(scope, { userId: w.f.users.shared.id, conversationId: c.id })).toBe(false);
    // Still shared and readable after all those refusals.
    expect((await w.viewer.get(`/api/conversations/${c.id}`)).statusCode).toBe(200);
    const conv = (await w.viewer.get(`/api/conversations/${c.id}`)).json();
    expect(conv.settings).toBeNull();
  });
});

describe("family sharing — artifact shares (#29, FR-14.4)", () => {
  it("opens the artifact only, never its conversation; a snapshot freezes its versions", async () => {
    const w = await start();
    const c = w.app.conversations!.create(w.f.users.owner.id);
    const t1 = await w.say(c.id, "차트");
    const scope = w.artifactScope(c.id, t1.run.id);
    const { artifact } = w.app.artifacts!.create(scope, { kind: "html", title: "차트", content: "<p>1</p>" });
    const r = await w.owner.send("POST", `/api/artifacts/${artifact.id}/shares`, {
      target: { audience: "users", userIds: [w.f.users.shared.id] },
      mode: "snapshot",
    });
    expect(r.statusCode).toBe(201);
    w.app.artifacts!.update(scope, artifact.id, { content: "<p>2</p>" });
    expect((await w.viewer.get(`/a/${artifact.id}/v/1/raw`)).statusCode).toBe(200);
    expect((await w.viewer.get(`/a/${artifact.id}/v/2/raw`)).statusCode).toBe(403);
    expect((await w.viewer.get(`/api/artifacts/${artifact.id}`)).json().latestVersion).toBe(1);
    for (const u of [
      `/api/conversations/${c.id}`,
      `/api/conversations/${c.id}/messages`,
      `/api/runs/${t1.run.id}`,
    ])
      expect((await w.viewer.get(u)).statusCode).toBe(403);
    const view = SharedView.parse((await w.viewer.get(`/api/shares/${r.json<Share>().id}/view`)).json());
    expect(view.conversation).toBeNull();
    expect(view.artifacts.map((a) => a.versions)).toEqual([[1]]);
  });

  it("a shared document artifact downloads its own file only — live and snapshot alike", async () => {
    const w = await start();
    const c = w.app.conversations!.create(w.f.users.owner.id);
    const other = await w.upload(c.id, "다른.txt", "다른 파일");
    const t1 = await w.say(c.id, "보고서 만들어 줘", [other]);
    const doc1 = await w.upload(c.id, "보고서.pdf", "%PDF v1");
    const doc2 = await w.upload(c.id, "보고서2.pdf", "%PDF v2");
    const scope = w.artifactScope(c.id, t1.run.id);
    const ref = (fileId: string) => ({ fileId, name: "보고서.pdf", mimeType: "application/pdf" });
    const { artifact } = w.app.artifacts!.create(scope, {
      kind: "document",
      title: "보고서",
      document: ref(doc1),
    });
    // `shared` gets a snapshot (v1 only), `stranger` a live share (every version).
    const post = (userId: string, mode: string) =>
      w.owner.send("POST", `/api/artifacts/${artifact.id}/shares`, {
        target: { audience: "users", userIds: [userId] },
        mode,
      });
    expect((await post(w.f.users.shared.id, "snapshot")).statusCode).toBe(201);
    expect((await post(w.f.users.stranger.id, "live")).statusCode).toBe(201);
    w.app.artifacts!.update(scope, artifact.id, { document: ref(doc2) });
    const content = async (who: typeof w.viewer, id: string) =>
      (await who.get(`/api/files/${id}/content`)).statusCode;
    expect(await content(w.viewer, doc1)).toBe(200);
    expect(await content(w.viewer, doc2)).toBe(403); // the version after the snapshot
    expect(await content(w.viewer, other)).toBe(403); // another file of the conversation
    expect(await content(w.stranger, doc1)).toBe(200);
    expect(await content(w.stranger, doc2)).toBe(200);
    expect(await content(w.stranger, other)).toBe(403);
    // Neither opens the conversation's file list.
    expect((await w.viewer.get(`/api/conversations/${c.id}/files`)).statusCode).toBe(403);
  });

  it("a conversation share opens the file of the document versions it shows — a restored one too", async () => {
    const w = await start();
    const c = w.app.conversations!.create(w.f.users.owner.id);
    /** A PDF the reply `messageId` generated (#49), stored as file generation stores it. */
    const generated = async (messageId: string, text: string) => {
      const tmp = w.app.files!.tempFile();
      fs.writeFileSync(tmp, text);
      return (
        await w.app.files!.addGenerated({
          userId: w.f.users.owner.id,
          conversationId: c.id,
          messageId,
          name: "보고서.pdf",
          kind: "pdf",
          bytes: Buffer.byteLength(text),
          sha256: crypto.createHash("sha256").update(text).digest("hex"),
          tmp,
        })
      ).id;
    };
    const ref = (fileId: string) => ({ fileId, name: "보고서.pdf", mimeType: "application/pdf" });
    const t1 = await w.say(c.id, "보고서 v1");
    const d1 = await generated(t1.assistant.id, "%PDF 1");
    const { artifact } = w.app.artifacts!.create(w.artifactScope(c.id, t1.run.id), {
      kind: "document",
      title: "보고서",
      document: ref(d1),
    });
    // Snapshot to `shared` at turn 1; a later turn makes v2 with its own PDF.
    await w.share(c.id, {
      target: { audience: "users", userIds: [w.f.users.shared.id] },
      mode: "snapshot",
      boundaryMessageId: t1.assistant.id,
    });
    const t2 = await w.say(c.id, "보고서 v2");
    const d2 = await generated(t2.assistant.id, "%PDF 2");
    w.app.artifacts!.update(w.artifactScope(c.id, t2.run.id), artifact.id, { document: ref(d2) });
    const get = async (who: typeof w.viewer, id: string) =>
      (await who.get(`/api/files/${id}/content`)).statusCode;
    expect(await get(w.viewer, d1)).toBe(200);
    expect(await get(w.viewer, d2)).toBe(403); // a version after the boundary: its file stays out
    // Live to `stranger`, after turn 1's answer is regenerated (so the answer that made v1 and its PDF is cut) and
    // the owner restores v1 as v4: v4 is shown, and so is the PDF it names.
    const regen = await w.owner.send(
      "POST",
      `/api/conversations/${c.id}/messages/${t1.assistant.id}/regenerate`,
      {},
    );
    expect(regen.statusCode).toBe(200);
    const r1 = regen.json<{ run: Run }>().run;
    await w.waitRun(r1.id);
    const d3 = await generated(regen.json<{ assistant: Message }>().assistant.id, "%PDF 3");
    w.app.artifacts!.update(w.artifactScope(c.id, r1.id), artifact.id, { document: ref(d3) });
    w.app.artifacts!.revert(artifact.id, 1);
    await w.share(c.id, { target: { audience: "users", userIds: [w.f.users.stranger.id] }, mode: "live" });
    const detail = (await w.stranger.get(`/api/artifacts/${artifact.id}`)).json<{
      versions: { version: number }[];
    }>();
    expect(detail.versions.map((v) => v.version)).toEqual([3, 4]);
    expect(await get(w.stranger, d1)).toBe(200); // v4 = restored v1
    expect(await get(w.stranger, d3)).toBe(200); // v3, made by the active answer
    expect(await get(w.stranger, d2)).toBe(403); // v2 is not shown (its answer was cut), nor is its file
  });

  it("the access stream follows the version on screen: one of several shares going narrows it", async () => {
    const w = await start();
    const c = w.app.conversations!.create(w.f.users.owner.id);
    const t1 = await w.say(c.id, "차트");
    const scope = w.artifactScope(c.id, t1.run.id);
    const { artifact } = w.app.artifacts!.create(scope, { kind: "html", title: "차트", content: "<p>1</p>" });
    const to = (userIds: string[], mode: string) =>
      w.owner.send("POST", `/api/artifacts/${artifact.id}/shares`, {
        target: { audience: "users", userIds },
        mode,
      });
    expect((await to([w.f.users.shared.id], "snapshot")).statusCode).toBe(201); // v1 only
    w.app.artifacts!.update(scope, artifact.id, { content: "<p>2</p>" });
    for (const change of ["revoke", "retarget"] as const) {
      const live = (await to([w.f.users.shared.id], "live")).json<Share>(); // v1 and v2
      const on2 = await w.stream(`/api/artifacts/${artifact.id}/access?version=2`, w.f.cookies.shared);
      await on2.until(/event: ready/);
      if (change === "revoke") await w.owner.send("DELETE", `/api/shares/${live.id}`);
      else
        await w.owner.send("PATCH", `/api/shares/${live.id}`, {
          target: { audience: "users", userIds: [w.f.users.stranger.id] },
        });
      const end = await on2.rest();
      expect([change, end.ended]).toEqual([change, true]);
      expect(end.text).toMatch(/event: scope\ndata: \{"versions":\[1\]\}/);
      expect(end.text).not.toMatch(/event: revoked/);
      expect((await w.viewer.get(`/a/${artifact.id}/v/2/raw`)).statusCode).toBe(403);
      expect((await w.viewer.get(`/a/${artifact.id}/v/1/raw`)).statusCode).toBe(200);
    }
    // A version that is no longer allowed when the stream opens: told at once.
    const late = await w.stream(`/api/artifacts/${artifact.id}/access?version=2`, w.f.cookies.shared);
    expect((await late.rest()).text).toMatch(/event: scope/);
  });

  it("goes with its conversation", async () => {
    const w = await start();
    const c = w.app.conversations!.create(w.f.users.owner.id);
    const share = await w.share(c.id, { target: { audience: "family" }, mode: "live" });
    const s = await w.stream(`/api/shares/${share.id}/events`, w.f.cookies.shared);
    await s.until(/event: ready/);
    expect((await w.owner.send("DELETE", `/api/conversations/${c.id}`)).statusCode).toBe(200);
    expect((await s.rest()).ended).toBe(true);
    expect(w.app.sharing!.store.get(share.id)).toBeUndefined();
  });
});
