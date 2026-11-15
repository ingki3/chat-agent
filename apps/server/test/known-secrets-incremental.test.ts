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
  knownMasks,
  knownMasksFrom,
  knownSecrets,
  scanStats,
  scrubParts,
  type ScanState,
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

  it("values JSON cannot tell apart are never cached: Infinity, then null (#159 round 1)", () => {
    const reg = new KnownSecrets();
    reg.add("Infinity"); // a number is compared by its text: Infinity is masked, null is not
    const cache = new PartsScrubCache();
    const parts: MessagePart[] = [{ type: "tool_result", callId: "c", output: Infinity }];
    expect(scrubParts(parts, { registry: reg, cache })).toEqual(scrubParts(parts, { registry: reg }));
    parts[0] = { type: "tool_result", callId: "c", output: null }; // JSON.stringify: `null` both times
    expect(scrubParts(parts, { registry: reg, cache })).toEqual([
      { type: "tool_result", callId: "c", output: null },
    ]);
    // And the other way round, and the other values JSON loses (NaN, -0, undefined, a Date, a sparse array).
    const sparse: unknown[] = [1];
    sparse[2] = 2;
    const odd: unknown[] = [
      null,
      Infinity,
      -Infinity,
      NaN,
      -0,
      0,
      undefined,
      new Date(0),
      sparse,
      { a: undefined },
    ];
    for (const a of odd)
      for (const b of odd) {
        const c = new PartsScrubCache();
        const ps: MessagePart[] = [{ type: "tool_result", callId: "c", output: { v: a } }];
        expect(scrubParts(ps, { registry: reg, cache: c })).toEqual(scrubParts(ps, { registry: reg }));
        ps[0] = { type: "tool_result", callId: "c", output: { v: b } };
        expect(scrubParts(ps, { registry: reg, cache: c }), `${String(a)} → ${String(b)}`).toEqual(
          scrubParts(ps, { registry: reg }),
        );
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

describe("knownMasksFrom: a text grown at its end, scanned from just before where it grew", () => {
  const secrets = [
    "SYNTH-KEY-155-alpha",
    "sk-synthetic-155-BETA",
    "토큰-합성-155-감마값",
    "SYNTH KEY 155 with spaces",
    "a\\b%c-SYNTH-155-zz",
    "😀-SYNTH-155-astral",
  ];
  const forms = (v: string) => [
    v,
    encodeURIComponent(v),
    encodeURIComponent(v).replace(/%20/g, "+"),
    encodeURIComponent(encodeURIComponent(v)),
    Buffer.from(v).toString("base64"),
    Buffer.from(v)
      .toString("base64")
      .replace(/(.{8})/g, "$1\n"), // wrapped
    Buffer.from(v)
      .toString("base64")
      .replace(/(.{6})/g, "$1\\n"), // a stringified PEM
    Buffer.from(v).toString("base64url"),
    Buffer.from(v).toString("hex").toUpperCase(),
    JSON.stringify(v),
    JSON.stringify(JSON.stringify(v)),
    [...v].map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join(""),
    [...v].map((c) => "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0")).join(""),
    [...Buffer.from(v)].map((b) => "\\" + b.toString(8)).join(""),
  ];
  const filler = [
    " ",
    "  ",
    "\n",
    "\t",
    "평범한 글 ",
    "ordinary ",
    "\\",
    "\\\\",
    "%",
    "%2",
    "+",
    "=",
    "abc",
    "QUJD",
    "0a1b",
  ];

  it("the same masks as a full scan, at every growth, tail or not (random, cut anywhere)", () => {
    // Growths that took the short way (scanned less than the whole text), so the check is not of full scans only.
    let short = 0;
    let calls = 0;
    let incremental = 0;
    let full = 0;
    for (let seed = 1; seed <= 160; seed++) {
      const r = rng(seed * 7919);
      const reg = new KnownSecrets();
      for (const v of secrets) if (r(3)) reg.add(v);
      // The text is built from pieces cut at random places, so encodings straddle the growth points; sparse or
      // dense in secrets (a text with something found is scanned whole after that).
      const density = seed % 2 ? 3 : 12;
      let source = "";
      for (let k = 0; k < 60; k++) {
        if (r(density) === 0) {
          const f = forms(secrets[r(secrets.length)]!);
          source += f[r(f.length)]!;
        } else source += filler[r(filler.length)]!;
      }
      for (const tail of [true, false]) {
        let text = "";
        let state: ScanState | undefined;
        while (text.length < source.length) {
          text = source.slice(0, text.length + 1 + r(40));
          const before = scanStats.chars;
          const got = knownMasksFrom(text, state, reg, tail);
          const inc = scanStats.chars - before;
          const b2 = scanStats.chars;
          const want = knownMasks(text, { registry: reg, tail });
          const fl = scanStats.chars - b2;
          expect(got.masks, `seed ${seed} tail ${tail} at ${text.length}: ${JSON.stringify(text)}`).toEqual(
            want,
          );
          calls++;
          if (inc < fl) short++;
          incremental += inc;
          full += fl;
          state = got.state;
        }
      }
    }
    // Once something is found the text is scanned whole (by design): the short way is taken up to the first
    // secret, and the growth into it — the case this checks — is one of those; so is an end with a backslash or a
    // percent sequence near it (#159 review 2). About 240 of 10 500 here, with backslashes and "%" everywhere.
    expect(short, `${short} of ${calls} growths scanned short`).toBeGreaterThan(150);
    expect(incremental).toBeLessThan(full);
  }, 60_000);

  it("a clean text that keeps growing is scanned in proportion to its growth", () => {
    const reg = new KnownSecrets();
    for (const v of secrets) reg.add(v);
    const r = rng(155);
    // Prose ("%" after a figure is decided: it stays a "%"); a backslash or a percent sequence near the end would
    // make that growth a full scan.
    const prose = [
      " ",
      "  ",
      "\n",
      "\t",
      "평범한 글 ",
      "ordinary ",
      "3.2% ",
      "+",
      "=",
      "abc",
      "QUJD",
      "0a1b",
      '"',
    ];
    let source = "";
    while (source.length < 200_000) source += prose[r(prose.length)]!;
    let text = "";
    let state: ScanState | undefined;
    const before = scanStats.chars;
    while (text.length < source.length) {
      text = source.slice(0, text.length + 500);
      state = knownMasksFrom(text, state, reg, true).state;
    }
    const scanned = scanStats.chars - before;
    // 400 growths of 500 characters: a full scan each time would be ~40 M characters (200 × the text). A growth
    // that ends right after a "%" (it may still become `%5C`) scans the whole text: a few of the 400.
    expect(scanned, `${scanned} characters for a 200 kB text grown 400 times`).toBeLessThan(
      10 * source.length,
    );
    expect(knownMasksFrom(text, undefined, reg, true).masks).toEqual(knownMasks(text, { registry: reg }));
  });

  it("#159 review 2: a backslash run at the end that the next character turns into a `\\n` strip", () => {
    // The base64 view takes `\n` escapes out: "\\" + "n" is one, so the end of the first text read differently
    // once it grew — a match starting before the held point (none was held: the backslashes stopped it).
    const reg = new KnownSecrets();
    reg.add("abcdefghijklmno");
    const first = "YWJj ZGVm" + "\\".repeat(2);
    const next = first + "nZ2hpamtsbW5v";
    const prev = knownMasksFrom(first, undefined, reg, true);
    expect(knownMasks(next, { registry: reg })).toEqual([[0, 24]]);
    expect(knownMasksFrom(next, prev.state, reg, true).masks).toEqual([[0, 24]]);
  });

  it("boundary fuzz: transform-sensitive characters at the end of a text and at the start of what follows", () => {
    // Every encoding of two secrets, cut in the middle; between the halves, the last 4 characters of the first text
    // and the first 4 of what is appended — exhaustive over the characters that change how a view reads (escapes,
    // percent, hex digits, the `\n` strip, whitespace kinds, quotes), on one side at a time, then random on both.
    const reg = new KnownSecrets();
    const a = "abcdefghijklmno";
    const b = 'a/b+c d%e\\f"155';
    reg.add(a);
    reg.add(b);
    const encodings = [
      Buffer.from(a).toString("base64"),
      Buffer.from(a).toString("hex"),
      encodeURIComponent(b),
      JSON.stringify(JSON.stringify(b)).slice(1, -1),
      [...b].map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join(""),
    ];
    const sensitive = ["\\", "%", "5", "C", "u", "x", "0", "n", "r", "t", " ", "\t", "\r", "\n", '"', "a"];
    const core = ["\\", "%", "5", "C", "u", "n", " ", "\r", '"', "a"];
    const fixedTails = ["", "\\", "\\\\", "%5", "%5C", "\\u00", "\\x5", " \\", "% ", "3%", "%2 ", "%E3%8"];
    const fixedHeads = ["", "n", "\\n", "5C", "C", "u005c", "x5c", " "];
    const words = (alphabet: string[], k: number): string[] =>
      k === 0 ? [""] : words(alphabet, k - 1).flatMap((w) => alphabet.map((c) => w + c));
    let cases = 0;
    let short = 0;
    const check = (e: string, tail: string, head: string, mode: boolean) => {
      const c = e.length >> 1;
      const first = "x " + e.slice(0, c) + tail;
      const next = first + head + e.slice(c) + " y";
      const prev = knownMasksFrom(first, undefined, reg, mode);
      const before = scanStats.chars;
      const got = knownMasksFrom(next, prev.state, reg, mode).masks;
      if (scanStats.chars - before < next.length) short++;
      cases++;
      const want = knownMasks(next, { registry: reg, tail: mode });
      if (JSON.stringify(got) !== JSON.stringify(want))
        expect(got, JSON.stringify({ first, next, mode })).toEqual(want);
    };
    const four = words(core, 4);
    let k = 0;
    for (const e of encodings) {
      for (const t of four) for (const h of fixedHeads) check(e, t, h, k++ % 2 === 0);
      for (const h of four) for (const t of fixedTails) check(e, t, h, k++ % 2 === 0);
    }
    const r = rng(1592);
    const pick = () => Array.from({ length: 4 }, () => sensitive[r(sensitive.length)]).join("");
    for (let j = 0; j < 40_000; j++) check(encodings[r(encodings.length)]!, pick(), pick(), j % 2 === 0);
    // Not only full scans: the short way was taken where the end was stable.
    expect(short, `${short} of ${cases} took the short way`).toBeGreaterThan(cases / 10);
  }, 300_000);

  it("a scan that ran out of work is never continued: the whole text again (an adversarial repeated prefix)", () => {
    const reg = new KnownSecrets();
    reg.add("a".repeat(16_384));
    const source = ("a".repeat(500) + "\\x").repeat(40) + " ordinary prose " + "a".repeat(3000);
    let text = "";
    let state: ScanState | undefined;
    while (text.length < source.length) {
      text = source.slice(0, text.length + 997);
      const got = knownMasksFrom(text, state, reg, true);
      expect(got.masks).toEqual(knownMasks(text, { registry: reg }));
      state = got.state;
    }
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

  it("an output that changes from Infinity to null is stored as null (JSON cannot tell them apart: #159 round 1)", async () => {
    const { app, f, rawParts } = await start();
    const store = app.conversations!;
    const conv = store.create(f.users.owner.id);
    const msg = store.append(conv.id, { role: "assistant", parts: [], status: "streaming" });
    register("Infinity");
    const parts: MessagePart[] = [{ type: "tool_result", callId: "c1", output: Infinity }];
    store.updateMessage(msg.id, { parts });
    expect(JSON.parse(rawParts(msg.id))).toEqual([
      { type: "tool_result", callId: "c1", output: KNOWN_PLACEHOLDER },
    ]);
    parts[0] = { type: "tool_result", callId: "c1", output: null };
    store.updateMessage(msg.id, { parts });
    expect(JSON.parse(rawParts(msg.id))).toEqual([{ type: "tool_result", callId: "c1", output: null }]);
  });

  it("#159 review 2: a base64 secret completed by a `\\n` strip is masked in the stored row (text, reasoning; one part or split)", async () => {
    const { app, f, rawParts } = await start();
    const store = app.conversations!;
    register("abcdefghijklmno");
    const first = "YWJj ZGVm" + "\\".repeat(2);
    const second = "nZ2hpamtsbW5v";
    for (const type of ["text", "reasoning"] as const)
      for (const split of [false, true]) {
        const conv = store.create(f.users.owner.id);
        const msg = store.append(conv.id, { role: "assistant", parts: [], status: "streaming" });
        const parts: MessagePart[] = [{ type, text: first }];
        store.updateMessage(msg.id, { parts });
        if (split)
          parts.push(
            { type: "tool_call", id: "c", name: "sources_list", input: {} },
            { type: "tool_result", callId: "c", output: {} },
            { type, text: second },
          );
        else (parts[0] as { text: string }).text += second;
        store.updateMessage(msg.id, { parts });
        expect(JSON.parse(rawParts(msg.id)), `${type} split ${split}`).toEqual(scrubParts(parts));
        expect(rawParts(msg.id)).not.toContain("ZGVm");
      }
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
  // Closed before the next run: a live app's background rescrub would pass over its rows when the next app's
  // logins register their session tokens — work of its own, counted in the next run otherwise.
  const close = async (app: App) => {
    apps.splice(apps.indexOf(app), 1);
    await app.close();
  };
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
    // The startup rescrub of stored rows (its own matcher) is not a save: done before counting.
    await app.storedRescrub!.idle();
    const before = scanStats.chars;
    const r = await send("go");
    const done = await waitRun(r.id);
    const scanned = scanStats.chars - before;
    expect(done.status).toBe("done");
    const msg = app.conversations!.messageById(r.assistantMessageId)!;
    expect((msg.parts as MessagePart[]).filter((p) => p.type === "tool_result")).toHaveLength(n);
    await close(app);
    return scanned;
  };

  const alternating = async (n: number) => {
    // Text between every two tool calls (#159 round 1: 840 characters each), so the joined text grows at every save.
    const para = (k: number) =>
      `${k}번째 확인: ` + "검색 결과를 정리하면 지표가 늘었어요. ".repeat(40).slice(0, 820) + "\n\n";
    const steps = (): FakeStep[] => [
      ...Array.from({ length: n }, (_, k): FakeStep[] => [
        { text: para(k) },
        { tool: "sources_list", ms: 0, input: {}, output: { items } },
      ]).flat(),
      { text: "끝났어요." },
    ];
    const { send, waitRun, app } = await start(steps);
    // The startup rescrub of stored rows (its own matcher) is not a save: done before counting.
    await app.storedRescrub!.idle();
    const before = scanStats.chars;
    const r = await send("go");
    const done = await waitRun(r.id);
    const scanned = scanStats.chars - before;
    expect(done.status).toBe("done");
    const msg = app.conversations!.messageById(r.assistantMessageId)!;
    expect((msg.parts as MessagePart[]).filter((p) => p.type === "tool_result")).toHaveLength(n);
    expect((msg.parts as MessagePart[]).filter((p) => p.type === "text")).toHaveLength(n + 1);
    await close(app);
    return scanned;
  };

  it("text between every tool call: still about 4× for 4× the calls (the joined text is scanned where it grew)", async () => {
    register("SYNTH-BUDGET-155-never-in-output");
    const small = await alternating(50);
    const large = await alternating(200);
    expect(small).toBeGreaterThan(0);
    expect(large / small, `${small} → ${large} characters scanned`).toBeLessThan(5);
  }, 120_000);

  it("200 tool calls scan about 4× what 50 do (it was about 16×: every save rescanned every part)", async () => {
    register("SYNTH-BUDGET-155-never-in-output");
    const small = await run(50);
    const large = await run(200);
    // Characters handed to the matcher, not wall time: the same on a loaded CI runner. Linear ≈ 4×, quadratic ≈ 16×.
    expect(small).toBeGreaterThan(0);
    expect(large / small, `${small} → ${large} characters scanned`).toBeLessThan(5);
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
