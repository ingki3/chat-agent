import { afterEach, describe, expect, it } from "vitest";
import { CSRF_HEADER, type MessagePart, type Run } from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { RuntimeRegistry } from "../src/runtime/adapter.js";
import { FakeRuntime, type FakeStep } from "../src/runtime/fake.js";
import {
  KNOWN_PLACEHOLDER,
  KnownSecrets,
  PartsScrubCache,
  knownSecrets,
  scanStats,
  scrubParts,
} from "../src/secrets/known.js";
import { createFamily } from "./helpers/permission-matrix.js";

/**
 * #155: a run saves its reply at every tool event; each save scrubbed all of it again, so n tool calls cost n²
 * scans (60 calls: 11.5 s). Saves now scan only what changed since the last one (`PartsScrubCache`, keyed by
 * content and by the registry generation) — with exactly the result of a full scrub: a value registered mid-run is
 * masked in parts saved before it, a secret split across text parts is still found in the joined text.
 * Synthetic secrets only.
 */

type App = Awaited<ReturnType<typeof buildApp>>;
const apps: App[] = [];
const registered: string[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
  while (registered.length) knownSecrets.remove(registered.pop());
});
const register = (v: string) => {
  registered.push(v);
  knownSecrets.add(v);
};

function rng(seed: number) {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

describe("PartsScrubCache: the same result as a full scrub, save after save", () => {
  it("random runs (text appended in place, tool parts, replaced parts, values registered and removed mid-run)", () => {
    const secrets = ["SYNTH-KEY-155-alpha", "sk-synthetic-155-BETA", "토큰-합성-155-감마값"];
    // Raw, encoded and cut forms, so every branch of the matcher has something to find.
    const forms = (s: string) => [
      s,
      encodeURIComponent(s),
      Buffer.from(s).toString("base64"),
      JSON.stringify(JSON.stringify(s)),
      Buffer.from(s).toString("hex"),
      s.slice(0, 9),
      s.slice(9),
    ];
    const pool = [...secrets.flatMap(forms), "평범한 글 ", "ordinary text ", "\\n", "%", "출처 [1] "];
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed);
      const reg = new KnownSecrets();
      const cache = new PartsScrubCache();
      const parts: MessagePart[] = [];
      const word = () => pool[r(pool.length)]!;
      for (let step = 0; step < 40; step++) {
        const op = r(10);
        const last = parts.at(-1);
        if (op < 3) {
          if (last && last.type === "text")
            last.text += word(); // in place, like the run manager
          else parts.push({ type: "text", text: word() });
        } else if (op < 4) {
          if (last && last.type === "reasoning") last.text += word();
          else parts.push({ type: "reasoning", text: word() });
        } else if (op < 6) {
          const id = `call-${step}`;
          parts.push({ type: "tool_call", id, name: "sources_list", input: { q: word() } });
          parts.push({ type: "tool_result", callId: id, output: { items: [word(), { [word()]: word() }] } });
        } else if (op < 7 && parts.length) {
          const k = r(parts.length);
          parts[k] = { type: "tool_result", callId: `re-${step}`, output: word() };
        } else if (op < 8) reg.add(secrets[r(secrets.length)]);
        else if (op < 9 && r(4) === 0) reg.remove(secrets[r(secrets.length)]);
        const cached = scrubParts(parts, { registry: reg, cache });
        expect(cached, `seed ${seed} step ${step}`).toEqual(scrubParts(parts, { registry: reg }));
      }
    }
  });

  it("nothing handed out is shared with the next save (a caller may change what it got)", () => {
    const reg = new KnownSecrets();
    reg.add("SYNTH-SHARED-155-xyz");
    const cache = new PartsScrubCache();
    const parts: MessagePart[] = [
      { type: "tool_result", callId: "c", output: { a: "SYNTH-SHARED-155-xyz" } },
    ];
    const first = scrubParts(parts, { registry: reg, cache });
    (first[0] as { output: { a: string } }).output.a = "changed";
    expect(scrubParts(parts, { registry: reg, cache })).toEqual([
      { type: "tool_result", callId: "c", output: { a: KNOWN_PLACEHOLDER } },
    ]);
  });
});

async function start(steps: () => FakeStep[] = () => []) {
  const db = createTestDb();
  const runtimes = new RuntimeRegistry();
  runtimes.register(new FakeRuntime({ script: steps }));
  const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
    db,
    logger: false,
    runtimes,
    runs: { flushMs: 0 },
  });
  apps.push(app);
  const f = await createFamily(app);
  const headers = {
    host: "localhost:3000",
    cookie: f.cookies.owner,
    origin: "http://localhost:3000",
    [CSRF_HEADER]: "1",
    "content-type": "application/json",
  };
  const send = async (text: string) => {
    const conv = app.conversations!.create(f.users.owner.id);
    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conv.id}/messages`,
      headers,
      payload: { text },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ run: Run }>().run;
  };
  const waitRun = async (id: string) => {
    for (let i = 0; i < 3000; i++) {
      const r = app.runs!.get(id);
      if (r?.endedAt) return r;
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error("run did not finish");
  };
  const rawParts = (messageId: string) =>
    (db.$client.prepare("select parts from messages where id = ?").get(messageId) as { parts: string }).parts;
  return { app, db, f, send, waitRun, rawParts };
}

describe("ConversationStore.updateMessage: a message saved again and again", () => {
  it("a value registered between two saves is masked in the parts saved before it", async () => {
    const { app, f, rawParts } = await start();
    const store = app.conversations!;
    const conv = store.create(f.users.owner.id);
    const msg = store.append(conv.id, { role: "assistant", parts: [], status: "streaming" });
    const late = "SYNTH-LATE-155-registered-mid-run";
    const parts: MessagePart[] = [
      { type: "text", text: `앞 글 ${late} ` },
      { type: "tool_call", id: "c1", name: "sources_list", input: { q: late } },
      { type: "tool_result", callId: "c1", output: { items: [{ snippet: encodeURIComponent(late) }] } },
    ];
    store.updateMessage(msg.id, { parts });
    expect(rawParts(msg.id)).toContain(late); // not a known secret yet
    // Registered now; nothing in the earlier parts changed — the next save still masks them (generation).
    register(late);
    parts.push({ type: "text", text: "뒤 글" });
    store.updateMessage(msg.id, { parts });
    const stored = rawParts(msg.id);
    expect(stored).not.toContain(late);
    expect(stored).not.toContain(encodeURIComponent(late));
    expect(stored).not.toContain("SYNTH-LATE-155");
    expect(stored).toContain("뒤 글");
  });

  it("a secret split across two text parts (around a tool call) is masked once its second half is saved", async () => {
    const { app, f, rawParts } = await start();
    const store = app.conversations!;
    const conv = store.create(f.users.owner.id);
    const msg = store.append(conv.id, { role: "assistant", parts: [], status: "streaming" });
    const secret = "SYNTH-SPLIT-155-0123456789";
    register(secret);
    const parts: MessagePart[] = [
      { type: "text", text: "키는 SYNTH-" },
      { type: "tool_call", id: "c1", name: "sources_list", input: {} },
    ];
    store.updateMessage(msg.id, { parts });
    parts.push({ type: "tool_result", callId: "c1", output: { items: [] } });
    store.updateMessage(msg.id, { parts });
    parts.push({ type: "text", text: "SPLIT-155-0123456789 이에요" });
    store.updateMessage(msg.id, { parts });
    const stored = JSON.parse(rawParts(msg.id)) as MessagePart[];
    const texts = stored.flatMap((p) => (p.type === "text" ? [p.text] : []));
    expect(texts.join("")).not.toContain("SPLIT-155");
    expect(texts[0]).toBe(`키는 ${KNOWN_PLACEHOLDER}`);
    expect(texts[1]).toBe(" 이에요");
  });
});

describe("a run's saves scan in proportion to what it produced (#155 budget)", () => {
  const items = Array.from({ length: 30 }, (_, i) => ({
    sourceId: `src_${i}_abcdefghijklmnop`,
    title: `통계청 지표 ${i + 1}번 기사`,
    url: `https://example.test/news/${i}?q=%EC%A7%80%ED%91%9C`,
    snippet: `통계청은 지표 ${i + 1}번이 ${i + 1}% 늘었다고 밝혔다. \\n 추가 설명.`,
  }));
  const run = async (n: number) => {
    const steps = (): FakeStep[] => [
      ...Array.from({ length: n }, (_, k) => ({ text: `${k}번째 확인. ` })),
      ...Array.from({ length: n }, () => ({ tool: "sources_list", ms: 0, input: {}, output: { items } })),
      { text: "끝났어요." },
    ];
    const { send, waitRun, app } = await start(steps);
    const before = scanStats.chars;
    const r = await send("go");
    const done = await waitRun(r.id);
    const scanned = scanStats.chars - before;
    expect(done.status).toBe("done");
    const msg = app.conversations!.messageById(r.assistantMessageId)!;
    expect((msg.parts as MessagePart[]).filter((p) => p.type === "tool_result")).toHaveLength(n);
    return scanned;
  };

  it("200 tool calls scan about 4× what 50 do (it was about 16×: every save rescanned every part)", async () => {
    register("SYNTH-BUDGET-155-never-in-output");
    const small = await run(50);
    const large = await run(200);
    // Characters handed to the matcher, not wall time: the same on a loaded CI runner. Linear ≈ 4×, quadratic ≈ 16×.
    expect(small).toBeGreaterThan(0);
    expect(large / small, `${small} → ${large} characters scanned`).toBeLessThan(6);
  }, 120_000);

  it("a value registered mid-run is masked everywhere in the stored reply and in the replayed stream", async () => {
    const late = "SYNTH-MIDRUN-155-tool-output-value";
    const steps = (): FakeStep[] => [
      { tool: "sources_list", ms: 0, input: {}, output: { items: [{ snippet: `값 ${late}` }] } },
      { delayMs: 400 },
      { tool: "sources_list", ms: 0, input: {}, output: { items: [{ snippet: "다른 값" }] } },
      { text: "끝났어요." },
    ];
    const { send, waitRun, app, rawParts } = await start(steps);
    const r = await send("go");
    // Registered once the first tool result is saved (the run is in its delay).
    for (let i = 0; i < 300 && !rawParts(r.assistantMessageId).includes(late); i++)
      await new Promise((res) => setTimeout(res, 5));
    expect(rawParts(r.assistantMessageId)).toContain(late);
    register(late);
    await waitRun(r.id);
    const stored = rawParts(r.assistantMessageId);
    expect(stored).not.toContain(late);
    expect(stored).toContain("다른 값");
    expect(JSON.stringify(app.runs!.eventsAfter(r.id, 0))).not.toContain(late);
  });
});
