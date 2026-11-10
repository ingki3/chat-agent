import { afterEach, describe, expect, it } from "vitest";
import {
  autoTitle,
  Conversation,
  CSRF_HEADER,
  Message,
  publicParts,
  StreamEvent,
  type MessagePart,
} from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { createFamily } from "./helpers/permission-matrix.js";

type App = Awaited<ReturnType<typeof buildApp>>;
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function start() {
  const db = createTestDb();
  const app = await buildApp(loadConfig({ NODE_ENV: "test" }), { db, logger: false });
  apps.push(app);
  const f = await createFamily(app);
  const as = (cookie: string) => {
    const h = { host: "localhost:3000", cookie };
    const w = { ...h, origin: "http://localhost:3000", [CSRF_HEADER]: "1" };
    return {
      get: (url: string) => app.inject({ url, headers: h }),
      post: (url: string, payload: object = {}) => app.inject({ method: "POST", url, headers: w, payload }),
      patch: (url: string, payload: object) => app.inject({ method: "PATCH", url, headers: w, payload }),
      del: (url: string) => app.inject({ method: "DELETE", url, headers: w }),
    };
  };
  return { app, db, f, store: app.conversations!, mom: as(f.cookies.owner), son: as(f.cookies.shared) };
}
const parseList = (body: unknown) =>
  (body as { items: unknown[]; nextCursor: string | null }).items.map((c) => Conversation.parse(c));

describe("conversations", () => {
  it("creates, lists only your own, names from the first message, renames, pins", async () => {
    const { mom, son } = await start();
    const c = Conversation.parse((await mom.post("/api/conversations")).json());
    expect(c.title).toBe("새 대화");
    await mom.post(`/api/conversations/${c.id}/messages`, { text: "광합성이 뭐야? 쉽게 알려줘." });
    expect(Conversation.parse((await mom.get(`/api/conversations/${c.id}`)).json()).title).toBe(
      "광합성이 뭐야?",
    );
    // A later message does not rename it.
    await mom.post(`/api/conversations/${c.id}/messages`, { text: "다른 질문" });
    expect(Conversation.parse((await mom.get(`/api/conversations/${c.id}`)).json()).title).toBe(
      "광합성이 뭐야?",
    );

    await son.post("/api/conversations", { title: "아들 대화" });
    expect(parseList((await mom.get("/api/conversations")).json()).map((x) => x.id)).toEqual([c.id]);
    expect(parseList((await son.get("/api/conversations")).json()).map((x) => x.title)).toEqual([
      "아들 대화",
    ]);

    await mom.patch(`/api/conversations/${c.id}`, { title: "숙제" });
    const renamed = Conversation.parse((await mom.get(`/api/conversations/${c.id}`)).json());
    expect(renamed.title).toBe("숙제");
    expect((await mom.patch(`/api/conversations/${c.id}`, {})).statusCode).toBe(400);
  });

  it("sorts pinned first then most recent, searches titles and message text, paginates", async () => {
    const { mom, store, f } = await start();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const c = store.create(f.users.owner.id, { title: `대화 ${i}` });
      store.append(c.id, {
        role: "user",
        parts: [{ type: "text", text: i === 2 ? "고양이 사료 추천" : "안녕" }],
      });
      ids.push(c.id);
      await new Promise((r) => setTimeout(r, 2));
    }
    await mom.patch(`/api/conversations/${ids[1]}`, { pinned: true });
    const all = parseList((await mom.get("/api/conversations")).json()).map((c) => c.id);
    expect(all).toEqual([ids[1], ids[4], ids[3], ids[2], ids[0]]);
    expect(parseList((await mom.get("/api/conversations?pinned=true")).json()).map((c) => c.id)).toEqual([
      ids[1],
    ]);
    expect(
      parseList((await mom.get(`/api/conversations?q=${encodeURIComponent("고양이")}`)).json()).map(
        (c) => c.id,
      ),
    ).toEqual([ids[2]]);
    expect(
      parseList((await mom.get(`/api/conversations?q=${encodeURIComponent("대화 3")}`)).json()).map(
        (c) => c.id,
      ),
    ).toEqual([ids[3]]);
    // LIKE wildcards are literal.
    expect(parseList((await mom.get("/api/conversations?q=%25")).json())).toEqual([]);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r = (await mom.get(`/api/conversations?limit=2${cursor ? `&cursor=${cursor}` : ""}`)).json();
      seen.push(...parseList(r).map((c) => c.id));
      cursor = (r as { nextCursor: string | null }).nextCursor;
    } while (cursor);
    expect(seen).toEqual(all);
  });

  it("keeps conversations apart: a message id from another conversation is not found", async () => {
    const { mom } = await start();
    const a = Conversation.parse((await mom.post("/api/conversations")).json());
    const b = Conversation.parse((await mom.post("/api/conversations")).json());
    const ma = Message.parse(
      (await mom.post(`/api/conversations/${a.id}/messages`, { text: "A의 질문" })).json(),
    );
    await mom.post(`/api/conversations/${b.id}/messages`, { text: "B의 질문" });
    const listB = (await mom.get(`/api/conversations/${b.id}/messages`)).json().items as Message[];
    expect(listB.map((m) => m.parts)).toEqual([[{ type: "text", text: "B의 질문" }]]);
    expect(
      (await mom.post(`/api/conversations/${b.id}/messages/${ma.id}/edit`, { text: "x" })).statusCode,
    ).toBe(404);
    expect((await mom.get(`/api/conversations/${b.id}/messages/${ma.id}/versions`)).statusCode).toBe(404);
  });

  it("pages messages oldest → newest with a `before` cursor", async () => {
    const { mom, store, f } = await start();
    const c = store.create(f.users.owner.id);
    for (let i = 1; i <= 7; i++)
      store.append(c.id, { role: "user", parts: [{ type: "text", text: `m${i}` }] });
    const p1 = (await mom.get(`/api/conversations/${c.id}/messages?limit=3`)).json();
    expect(p1.items.map((m: Message) => m.seq)).toEqual([5, 6, 7]);
    const p2 = (await mom.get(`/api/conversations/${c.id}/messages?limit=3&before=${p1.nextBefore}`)).json();
    expect(p2.items.map((m: Message) => m.seq)).toEqual([2, 3, 4]);
    const p3 = (await mom.get(`/api/conversations/${c.id}/messages?limit=3&before=${p2.nextBefore}`)).json();
    expect(p3.items.map((m: Message) => m.seq)).toEqual([1]);
    expect(p3.nextBefore).toBeNull();
  });
});

describe("edit and regenerate", () => {
  it("edit cuts off later messages, keeps them as versions, bumps the revision, invalidates runtime sessions", async () => {
    const { mom, store, f } = await start();
    const c = store.create(f.users.owner.id);
    const q1 = store.append(c.id, { role: "user", parts: [{ type: "text", text: "질문 1" }] });
    store.append(c.id, { role: "assistant", parts: [{ type: "text", text: "답 1" }], runtime: "codex" });
    store.append(c.id, { role: "user", parts: [{ type: "text", text: "질문 2" }] });
    store.saveSession({
      conversationId: c.id,
      runtime: "codex",
      externalSessionId: "thread-1",
      lastMessageId: q1.id,
      conversationRevision: 0,
    });
    expect(store.sessions(c.id)).toHaveLength(1);

    const r = await mom.post(`/api/conversations/${c.id}/messages/${q1.id}/edit`, { text: "고친 질문 1" });
    expect(r.statusCode).toBe(200);
    expect(r.json().revision).toBe(1);
    const edited = Message.parse(r.json().message);
    expect(edited).toMatchObject({ replaces: q1.id, revision: 1, seq: 4 });
    const list = (await mom.get(`/api/conversations/${c.id}/messages`)).json().items as Message[];
    expect(list.map((m) => m.parts[0])).toEqual([{ type: "text", text: "고친 질문 1" }]);
    expect(store.sessions(c.id)).toEqual([]);
    const versions = (await mom.get(`/api/conversations/${c.id}/messages/${edited.id}/versions`)).json()
      .items as Message[];
    expect(versions.map((m) => m.id)).toEqual([q1.id, edited.id]);
    // The old version is not editable any more; an assistant message is not editable at all.
    expect(
      (await mom.post(`/api/conversations/${c.id}/messages/${q1.id}/edit`, { text: "x" })).statusCode,
    ).toBe(404);
    expect(Conversation.parse((await mom.get(`/api/conversations/${c.id}`)).json()).revision).toBe(1);
  });

  it("regenerate replaces the assistant reply with a pending one for the runtime to fill", async () => {
    const { mom, store, f } = await start();
    const c = store.create(f.users.owner.id);
    const q = store.append(c.id, { role: "user", parts: [{ type: "text", text: "질문" }] });
    const a = store.append(c.id, {
      role: "assistant",
      parts: [{ type: "text", text: "답" }],
      runtime: "claude-code",
      model: "opus",
    });
    const r = await mom.post(`/api/conversations/${c.id}/messages/${a.id}/regenerate`);
    const m = Message.parse(r.json().message);
    expect(m).toMatchObject({
      role: "assistant",
      status: "pending",
      parts: [],
      replaces: a.id,
      runtime: "claude-code",
      model: "opus",
    });
    const list = (await mom.get(`/api/conversations/${c.id}/messages`)).json().items as Message[];
    expect(list.map((x) => x.id)).toEqual([q.id, m.id]);
    expect((await mom.post(`/api/conversations/${c.id}/messages/${q.id}/regenerate`)).statusCode).toBe(404);
  });
});

describe("runtime session checkpoints", () => {
  it("refuses a session that reflects an older revision or a message of another conversation", async () => {
    const { store, f } = await start();
    const a = store.create(f.users.owner.id);
    const b = store.create(f.users.owner.id);
    const qa = store.append(a.id, { role: "user", parts: [{ type: "text", text: "a" }] });
    const qb = store.append(b.id, { role: "user", parts: [{ type: "text", text: "b" }] });
    const save = (over: object) =>
      store.saveSession({
        conversationId: a.id,
        runtime: "codex",
        externalSessionId: "t",
        lastMessageId: qa.id,
        conversationRevision: 0,
        ...over,
      });
    expect(() => save({ lastMessageId: qb.id })).toThrow(/active message of this conversation/);
    expect(() => save({ lastMessageId: "nope" })).toThrow(/active message/);
    store.edit(a.id, qa.id, "a2"); // revision 1; qa is no longer active
    expect(() => save({ lastMessageId: null })).toThrow(/older revision/);
    expect(() => save({ lastMessageId: qa.id, conversationRevision: 1 })).toThrow(/active message/);
    expect(store.sessions(a.id)).toEqual([]);
    expect(save({ lastMessageId: null, conversationRevision: 1 }).conversationRevision).toBe(1);
  });

  it("regenerate keeps the connection of the reply it replaces", async () => {
    const { store, f } = await start();
    const c = store.create(f.users.owner.id);
    store.append(c.id, { role: "user", parts: [{ type: "text", text: "q" }] });
    const a = store.append(c.id, {
      role: "assistant",
      parts: [{ type: "text", text: "a" }],
      runtime: "codex",
      connectionId: "connection-1",
    });
    expect(store.regenerate(c.id, a.id)!.connectionId).toBe("connection-1");
  });

  it("returns no next cursor on the last page, even with gaps in seq", async () => {
    const { mom, store, f } = await start();
    const c = store.create(f.users.owner.id);
    for (let i = 1; i <= 3; i++)
      store.append(c.id, { role: "user", parts: [{ type: "text", text: `m${i}` }] });
    const exact = (await mom.get(`/api/conversations/${c.id}/messages?limit=3`)).json();
    expect(exact.items).toHaveLength(3);
    expect(exact.nextBefore).toBeNull();
    // Edit the 2nd message: seq 2 and 3 leave the history, the new one is seq 4 → active seq 1, 4.
    const m2 = store.messages(c.id, { limit: 10 })[1]!;
    store.edit(c.id, m2.id, "m2'");
    const p1 = (await mom.get(`/api/conversations/${c.id}/messages?limit=1`)).json();
    expect(p1.items.map((m: Message) => m.seq)).toEqual([4]);
    const p2 = (await mom.get(`/api/conversations/${c.id}/messages?limit=1&before=${p1.nextBefore}`)).json();
    expect(p2.items.map((m: Message) => m.seq)).toEqual([1]);
    expect(p2.nextBefore).toBeNull();
  });
});

describe("reasoning is internal", () => {
  const parts: MessagePart[] = [
    { type: "reasoning", text: "SECRET-THOUGHT 사용자를 어떻게 설득할까" },
    { type: "text", text: "공개 답변" },
  ];

  it("never appears in API responses or search", async () => {
    const { mom, store, f } = await start();
    const c = store.create(f.users.owner.id, { title: "t" });
    const m = store.append(c.id, { role: "assistant", parts });
    const list = await mom.get(`/api/conversations/${c.id}/messages`);
    expect(list.body).not.toContain("SECRET-THOUGHT");
    expect(list.json().items[0].parts).toEqual([{ type: "text", text: "공개 답변" }]);
    expect((await mom.get(`/api/conversations/${c.id}/messages/${m.id}/versions`)).body).not.toContain(
      "SECRET",
    );
    expect(parseList((await mom.get("/api/conversations?q=SECRET-THOUGHT")).json())).toEqual([]);
    expect(
      parseList((await mom.get(`/api/conversations?q=${encodeURIComponent("공개")}`)).json()),
    ).toHaveLength(1);
  });

  it("is dropped by publicParts and refused in stream part updates", () => {
    expect(publicParts(parts)).toEqual([{ type: "text", text: "공개 답변" }]);
    expect(
      StreamEvent.safeParse({ type: "part_update", messageId: "m", partIndex: 0, part: parts[0] }).success,
    ).toBe(false);
    expect(StreamEvent.parse({ type: "delta", messageId: "m", partIndex: 0, text: "가" }).type).toBe("delta");
  });
});

describe("delete", () => {
  it("removes messages and runtime sessions, running extension hooks in the same transaction", async () => {
    const { mom, db, store, f } = await start();
    const c = store.create(f.users.owner.id);
    store.append(c.id, { role: "user", parts: [{ type: "text", text: "x" }] });
    store.saveSession({
      conversationId: c.id,
      runtime: "codex",
      externalSessionId: "t",
      lastMessageId: null,
      conversationRevision: 0,
    });
    const called: string[] = [];
    store.onDelete((id) => called.push(id));
    expect((await mom.del(`/api/conversations/${c.id}`)).statusCode).toBe(200);
    expect(called).toEqual([c.id]);
    const count = (table: string) =>
      (
        db.$client.prepare(`select count(*) n from ${table} where conversation_id = ?`).get(c.id) as {
          n: number;
        }
      ).n;
    expect([count("messages"), count("runtime_sessions")]).toEqual([0, 0]);
    expect((await mom.get(`/api/conversations/${c.id}`)).statusCode).toBe(404);

    // A failing hook (e.g. a file that cannot be removed) leaves everything in place.
    const d = store.create(f.users.owner.id);
    store.onDelete(() => {
      throw new Error("hook failed");
    });
    expect(() => store.delete(d.id)).toThrow("hook failed");
    expect(store.get(d.id)).toBeDefined();
  });
});

describe("autoTitle", () => {
  it("takes the first sentence, trims long text by characters (not bytes)", () => {
    expect(autoTitle("  안녕?  반가워  ")).toBe("안녕?");
    expect(autoTitle("가".repeat(50))).toBe(`${"가".repeat(39)}…`);
    expect(autoTitle("   ")).toBe("새 대화");
  });
});
