import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CSRF_HEADER } from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { encrypt } from "../src/crypto/secrets.js";
import { createTestDb } from "../src/db/client.js";
import {
  RuntimeRegistry,
  type RuntimeAdapter,
  type RuntimeEvent,
  type StartContext,
} from "../src/runtime/adapter.js";
import {
  KnownSecrets,
  knownSecrets,
  MAX_KNOWN_LENGTH,
  scrubKnown,
  scrubEventSequence,
  scrubKnownDeep,
  StreamScrubber,
} from "../src/secrets/known.js";
import { createFamily, fastifyRoutes } from "./helpers/permission-matrix.js";
import { FinanceResultStore } from "../src/finance/results.js";
import type { AnswerEvidence } from "../src/finance/checker.js";

const sql_raw = (db: ReturnType<typeof createTestDb>, q: string, ...args: string[]) =>
  db.$client.prepare(q).run(...args);

/**
 * Review round 23: a secret value the server knows never reaches a stored row, the messages API, a live
 * subscription, the events log or `StartContext.history` — raw, JSON-escaped, percent-encoded, base64/hex, or split
 * by our own chunking.
 */

/** Small seeded PRNG (mulberry32): failures are reproducible from the seed in the test name. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  return { next, int, pick: <T>(xs: readonly T[]): T => xs[int(xs.length)]! };
}
type Rng = ReturnType<typeof rng>;

const pctAll = (s: string, lower: boolean) =>
  [...Buffer.from(s, "utf8")]
    .map((b) => "%" + b.toString(16).padStart(2, "0")[lower ? "toLowerCase" : "toUpperCase"]())
    .join("");
const uEsc = (s: string) =>
  [...s]
    .map((c) => {
      const cp = c.codePointAt(0)!;
      if (cp <= 0xffff) return "\\u" + cp.toString(16).padStart(4, "0");
      const hi = 0xd800 + ((cp - 0x10000) >> 10);
      const lo = 0xdc00 + ((cp - 0x10000) & 0x3ff);
      return "\\u" + hi.toString(16) + "\\u" + lo.toString(16);
    })
    .join("");

/** Every way a value can be written on its way out, one picked at random per case. */
const ENCODINGS: Record<string, (s: string, r: Rng) => string> = {
  raw: (s) => s,
  json: (s) => JSON.stringify(s).slice(1, -1),
  jsonInJson: (s) => JSON.stringify(JSON.stringify(s)).slice(1, -1),
  unicodeEscapes: (s) => uEsc(s),
  uri: (s) => encodeURIComponent(s),
  uriLower: (s) => encodeURIComponent(s).replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase()),
  form: (s) => encodeURIComponent(s).replace(/%20/g, "+"),
  percentEvery: (s, r) => pctAll(s, r.next() < 0.5),
  percentSome: (s, r) => [...s].map((c) => (r.next() < 0.5 ? pctAll(c, r.next() < 0.5) : c)).join(""),
  mixedEscapes: (s, r) =>
    [...s].map((c) => (r.next() < 0.3 ? uEsc(c) : r.next() < 0.3 ? pctAll(c, false) : c)).join(""),
  base64: (s, r) => Buffer.from("x".repeat(r.int(3)) + s + "y".repeat(r.int(3))).toString("base64"),
  base64url: (s, r) => Buffer.from("z".repeat(r.int(3)) + s).toString("base64url"),
  base64Unpadded: (s) => Buffer.from(s).toString("base64").replace(/=+$/, ""),
  hex: (s, r) => Buffer.from(s).toString("hex")[r.next() < 0.5 ? "toLowerCase" : "toUpperCase"](),
  // Round 24: Python/C octal byte escapes, hex in mixed case, base64 wrapped like MIME/PEM.
  octal: (s) => [...Buffer.from(s, "utf8")].map((b) => "\\" + b.toString(8).padStart(3, "0")).join(""),
  octalShort: (s) => [...Buffer.from(s, "utf8")].map((b) => "\\" + b.toString(8)).join("") + "x",
  hexMixedCase: (s, r) =>
    [...Buffer.from(s).toString("hex")].map((c) => (r.next() < 0.5 ? c.toUpperCase() : c)).join(""),
  base64Wrapped: (s, r) => wrap(Buffer.from("q".repeat(r.int(3)) + s).toString("base64"), r),
  base64WrappedJson: (s, r) => JSON.stringify(wrap(Buffer.from(s).toString("base64"), r)).slice(1, -1),
};

/** Base64 broken into lines (76 columns as MIME/PEM, or narrower), LF or CRLF, sometimes indented. */
function wrap(b64: string, r: Rng): string {
  const width = r.pick([76, 64, 16, 7]);
  const eol = r.pick(["\n", "\r\n"]);
  const indent = r.pick(["", "  ", "\t"]);
  const lines: string[] = [];
  for (let k = 0; k < b64.length; k += width) lines.push(indent + b64.slice(k, k + width));
  return lines.join(eol);
}

function randomSecret(r: Rng): string {
  const alphabet = [...'ABCxyz0189-_.~!"\\/%+ =:&@#한글😀'];
  const n = 8 + r.int(40);
  let s = "sk";
  for (let i = 2; i < n; i++) s += r.pick(alphabet);
  return s;
}

/** Splits into 1–8 random chunks (by UTF-16 unit, so a surrogate pair or an escape can be cut too). */
function chunks(s: string, r: Rng): string[] {
  const cuts = new Set<number>();
  const k = r.int(8);
  for (let i = 0; i < k; i++) cuts.add(1 + r.int(Math.max(1, s.length - 1)));
  const at = [0, ...[...cuts].sort((a, b) => a - b), s.length];
  const out: string[] = [];
  for (let i = 1; i < at.length; i++) if (at[i]! > at[i - 1]!) out.push(s.slice(at[i - 1], at[i]));
  return out;
}

/** True if `hay` holds the secret in any of the forms checked (raw, and the encoded form used). */
function leaks(hay: string, forms: readonly string[]): string | undefined {
  return forms.find((f) => f.length >= 8 && hay.includes(f));
}

describe("known-secret scrubber", () => {
  it("finds every encoding, split anywhere, and leaves ordinary text alone", () => {
    const reg = new KnownSecrets();
    const r = rng(23);
    for (let n = 0; n < 300; n++) {
      const secret = randomSecret(r);
      reg.add(secret);
      const name = r.pick(Object.keys(ENCODINGS));
      const enc = ENCODINGS[name]!(secret, r);
      const text = `앞 문장 ${enc} 뒤 문장`;
      const once = scrubKnown(text, { registry: reg });
      expect(once, `${name} ${JSON.stringify(secret)}`).not.toContain(enc);
      expect(once).toContain("[숨김]");
      const s = new StreamScrubber(reg);
      const streamed =
        chunks(text, r)
          .map((c) => s.push(c))
          .join("") + s.end();
      expect(streamed, `${name} streamed`).not.toContain(enc);
      expect(streamed).toContain("[숨김]");
    }
    const prose = '평범한 문장이에요. console.log("hello") %20 \\u0041 aGVsbG8= deadbeef 1234567890';
    expect(scrubKnown(prose, { registry: reg })).toBe(prose);
    const s = new StreamScrubber(reg);
    expect(
      chunks(prose, r)
        .map((c) => s.push(c))
        .join("") + s.end(),
    ).toBe(prose);
  });

  it("masks a secret cut off at the very end of a finished text", () => {
    const reg = new KnownSecrets();
    reg.add("sk-live-0123456789abcdef");
    expect(scrubKnown("키는 sk-live-0123456789", { registry: reg })).toBe("키는 [숨김]");
    // Too little of it to say: kept.
    expect(scrubKnown("키는 sk-l", { registry: reg })).toBe("키는 sk-l");
    // Mid-stream nothing is guessed: the prefix is only held back.
    const s = new StreamScrubber(reg);
    expect(s.push("키는 sk-live-01")).toBe("키는 ");
    expect(s.push("23456789abcdef 끝")).toBe("[숨김] 끝");
  });

  it("registers JSON credentials by their token fields and ignores short values", () => {
    const reg = new KnownSecrets();
    reg.addCredential(
      JSON.stringify({
        v: 1,
        accessToken: "access-AAAAAAAAAAAA",
        refreshToken: "refresh-BBBBBBBBBB",
        planType: "plus",
      }),
    );
    reg.add("short");
    expect(scrubKnown("a access-AAAAAAAAAAAA b refresh-BBBBBBBBBB plus short", { registry: reg })).toBe(
      "a [숨김] b [숨김] plus short",
    );
  });

  it("stays fast on a megabyte of escape-heavy text", () => {
    const reg = new KnownSecrets();
    for (let i = 0; i < 20; i++) reg.add(`sk-${crypto.randomBytes(16).toString("base64url")}`);
    reg.add('pass\\word"with%escapes');
    const big = "\\\\u00%2 \\x4 %4".repeat(70_000);
    const t = Date.now();
    scrubKnown(big, { registry: reg });
    const s = new StreamScrubber(reg);
    for (let i = 0; i < big.length; i += 4096) s.push(big.slice(i, i + 4096));
    s.end();
    expect(Date.now() - t).toBeLessThan(8000);
  });

  it("scrubs keys and values of nested data", () => {
    const reg = new KnownSecrets();
    reg.add("tok-1234567890");
    expect(scrubKnownDeep({ a: ["x tok-1234567890"], "tok-1234567890": 1 }, { registry: reg })).toEqual({
      a: ["x [숨김]"],
      "[숨김]": 1,
    });
  });
});

// ---- the whole server ----

type App = Awaited<ReturnType<typeof buildApp>>;
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

/** A runtime that plays the script the test sets for the next turn, and records what it was started with. */
function scriptedRuntime() {
  const seen: { history: StartContext["history"]; token?: string; input: string }[] = [];
  let next: (ctx: { token?: string }) => RuntimeEvent[] = () => [];
  const adapter: RuntimeAdapter = {
    id: "claude-code",
    capabilities: () => ({
      models: [{ id: "c", label: "C", efforts: [] }],
      canSwitchModelInSession: false,
      canResume: false,
      usesTools: true,
    }),
    resume: () => Promise.reject(new Error("no")),
    start: async (ctx) => {
      const rec: (typeof seen)[number] = {
        history: structuredClone(ctx.history),
        input: "",
        ...(ctx.mcp ? { token: ctx.mcp.token } : {}),
      };
      seen.push(rec);
      return {
        externalSessionId: crypto.randomUUID(),
        setModel: async () => {},
        close: async () => {},
        turn: (input) => {
          rec.input = input.text;
          const events = next(rec.token === undefined ? {} : { token: rec.token });
          return {
            events: (async function* () {
              for (const e of events) {
                await new Promise((r) => setImmediate(r));
                yield e;
              }
            })(),
            interrupt: async () => {},
          };
        },
      };
    },
  };
  return { adapter, seen, script: (f: typeof next) => (next = f) };
}

describe("known secrets never leave the server (property)", () => {
  it("random known secrets × encodings × chunk splits reach no row, API, subscription, event or history", async () => {
    const r = rng(2323);
    const gate = `gate-${crypto.randomBytes(9).toString("base64url")}`;
    const dart = `dart${crypto.randomBytes(12).toString("hex")}`;
    const db = createTestDb();
    const rt = scriptedRuntime();
    const runtimes = new RuntimeRegistry();
    runtimes.register(rt.adapter);
    const app = await buildApp(
      loadConfig({ NODE_ENV: "test", TEMP_GATE_CODE: gate, OPENDART_API_KEY: dart }),
      {
        db,
        logger: false,
        runtimes,
        runs: { flushMs: 0 },
      },
    );
    apps.push(app);
    const f = await createFamily(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const cookie = f.cookies.owner;
    const sessionToken = cookie.split("=")[1]!;
    // A stored credential (what a connection's key or login tokens go through) with awkward characters.
    const stored = randomSecret(r) + "Z9";
    encrypt(stored, crypto.randomBytes(32), "connection:test");
    const headers = {
      host: "localhost:3000",
      cookie,
      origin: "http://localhost:3000",
      [CSRF_HEADER]: "1",
      "content-type": "application/json",
    };
    const conv = app.conversations!.create(f.users.owner.id);

    /** Every string anywhere in the database, as stored. */
    const dump = () => {
      const tables = (
        db.$client.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]
      ).map((t) => t.name);
      return tables.map((t) => JSON.stringify(db.$client.prepare(`select * from "${t}"`).all())).join("\n");
    };
    const strings = (v: unknown): string => JSON.stringify(v, (_k, x) => x) + "\n" + collect(v).join("\n");
    const collect = (v: unknown, out: string[] = []): string[] => {
      if (typeof v === "string") out.push(v);
      else if (Array.isArray(v)) for (const x of v) collect(x, out);
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
          out.push(k);
          collect(x, out);
        }
      return out;
    };

    const CASES = 48;
    for (let n = 0; n < CASES; n++) {
      // Which known secret: the run's own MCP token is only known inside the script.
      const kind = r.pick(["gate", "skill", "session", "stored", "mcp"] as const);
      const encName = r.pick(Object.keys(ENCODINGS));
      let used: { secret: string; enc: string } | undefined;
      const encFor = (secret: string) => {
        const enc = ENCODINGS[encName]!(secret, r);
        used = { secret, enc };
        return enc;
      };
      const fixed = { gate, skill: dart, session: sessionToken, stored }[kind as "gate"];
      const where = r.pick([
        "text",
        "textAcrossTools",
        "reasoning",
        "tool_input",
        "tool_output",
        "notice",
        "end",
      ] as const);
      rt.script(({ token }) => {
        const secret = kind === "mcp" ? token! : fixed;
        const enc = encFor(secret);
        const body = `설명 앞부분 ${enc} 그리고 뒷부분`;
        const evs: RuntimeEvent[] = [{ type: "text_delta", text: "시작. " }];
        if (where === "text") for (const c of chunks(body, r)) evs.push({ type: "text_delta", text: c });
        if (where === "textAcrossTools")
          // Round 24: tool calls at random split points must not end the holdback.
          for (const [k, c] of chunks(body, r).entries()) {
            if (k > 0 || r.next() < 0.5) {
              evs.push({ type: "tool_start", callId: `t${n}-${k}`, name: "web_search", input: { q: "x" } });
              evs.push({ type: "tool_end", callId: `t${n}-${k}`, output: { ok: true } });
            }
            evs.push({ type: "text_delta", text: c });
          }
        if (where === "reasoning")
          for (const c of chunks(body, r)) evs.push({ type: "reasoning_delta", text: c });
        if (where === "tool_input" || where === "tool_output") {
          evs.push({
            type: "tool_start",
            callId: `c${n}`,
            name: "web_fetch",
            input: { url: `https://x.test/?q=${enc}`, note: body },
          });
          evs.push({
            type: "tool_end",
            callId: `c${n}`,
            output: where === "tool_output" ? { page: { body } } : { ok: true },
          });
        }
        if (where === "notice") evs.push({ type: "notice", level: "info", code: "x", message: body });
        if (where === "end")
          for (const c of chunks(`끝에 ${enc}`, r)) evs.push({ type: "text_delta", text: c });
        else evs.push({ type: "text_delta", text: " 끝." });
        return evs;
      });
      // Half the time the user pastes one of the fixed secrets too (it must not reach the next run's history).
      const pasted = kind !== "mcp" && r.next() < 0.5 ? ENCODINGS[encName]!(fixed, r) : "";
      const res = await app.inject({
        method: "POST",
        url: `/api/conversations/${conv.id}/messages`,
        headers,
        payload: { text: `질문 ${n} ${pasted}` },
      });
      expect(res.statusCode, res.body).toBe(201);
      const runId = res.json<{ run: { id: string } }>().run.id;
      const live = await fetch(`${base}/api/runs/${runId}/events`, {
        headers: { host: "localhost:3000", cookie },
      });
      const sse = await live.text();
      const replay = await fetch(`${base}/api/runs/${runId}/events`, {
        headers: { host: "localhost:3000", cookie, "last-event-id": "0" },
      }).then((x) => x.text());
      const api = await app.inject({
        url: `/api/conversations/${conv.id}/messages`,
        headers: { host: "localhost:3000", cookie },
      });
      const convs = await app.inject({
        url: `/api/conversations`,
        headers: { host: "localhost:3000", cookie },
      });
      const u = used!;
      const forms = [
        u.secret,
        u.enc,
        JSON.stringify(u.secret).slice(1, -1),
        ...(pasted ? [pasted, fixed] : []),
      ];
      const label = `case ${n}: ${kind} × ${encName} in ${where}`;
      // The secret did reach the runtime's own output (the test is not vacuous).
      if (where !== "reasoning") expect(sse, label).toContain("[숨김]");
      else expect(dump(), label).toContain("[숨김]");
      // The deltas joined: a secret split across frames counts as reaching the subscription.
      const joined = sse
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => JSON.parse(l.slice(6)) as { type: string; text?: string })
        .map((e) => (e.type === "delta" ? e.text : ""))
        .join("");
      for (const [what, hay] of [
        ["subscription", sse],
        ["subscription text", joined],
        ["replay", replay],
        ["messages API", api.body + strings(api.json())],
        [
          "message text joined",
          api
            .json<{ items: { parts: { type: string; text?: string }[] }[] }>()
            .items.map((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join(""))
            .join("\n"),
        ],
        ["conversations API", convs.body],
        ["database", dump()],
        ["history", strings(rt.seen.map((s) => [s.history, s.input]))],
      ] as const)
        expect(leaks(hay, forms), `${label}: ${what}`).toBeUndefined();
    }
    expect(rt.seen.length).toBe(CASES);
    // The registry knows them all (and the run tokens are forgotten once their runs ended).
    for (const v of [gate, dart, sessionToken, stored]) expect(knownSecrets.list()).toContain(v);
    for (const s of rt.seen) expect(knownSecrets.list()).not.toContain(s.token);
  });
});

describe("round 24", () => {
  it("one length cap: values at, just over and far over it are masked whole", () => {
    const reg = new KnownSecrets();
    const r = rng(24);
    const make = (n: number) => {
      let v = "";
      while (v.length < n) v += crypto.randomBytes(48).toString("base64url");
      return v.slice(0, n);
    };
    for (const n of [MAX_KNOWN_LENGTH - 1, MAX_KNOWN_LENGTH, MAX_KNOWN_LENGTH + 1, 5_341, 40_000]) {
      const v = make(n);
      reg.add(v);
      expect(scrubKnown(`a ${v} b`, { registry: reg }), `${n}`).toBe("a [숨김] b");
      const s = new StreamScrubber(reg);
      const out =
        chunks(`a ${v} b`, r)
          .map((c) => s.push(c))
          .join("") + s.end();
      expect(out, `${n} streamed`).toMatch(/^a (\[숨김\])+ b$/);
      expect(scrubKnown(`a ${JSON.stringify(v + '"')} b`, { registry: reg })).not.toContain(v.slice(0, 64));
    }
  });

  it("holds back whole words: the reader never sees half a word while the rest waits", () => {
    const reg = new KnownSecrets();
    reg.add("rld-secret-1234");
    const s = new StreamScrubber(reg);
    expect(s.push("hello wor")).toBe("hello ");
    expect(s.push("ld again ")).toBe("world again ");
    expect(s.push("wo")).toBe("wo");
    expect(s.push("r")).toBe("");
    expect(s.push("ld-secret-1234!")).toBe("[숨김]!");
  });

  it("finds octal escapes, mixed-case hex and wrapped base64", () => {
    const reg = new KnownSecrets();
    const v = "sk-ant-api03-한글/+=AbCdEf0123456789";
    reg.add(v);
    const r = rng(7);
    for (const name of ["octal", "octalShort", "hexMixedCase", "base64Wrapped", "base64WrappedJson"]) {
      for (let k = 0; k < 20; k++) {
        const enc = ENCODINGS[name]!(v, r);
        const out = scrubKnown(`앞 ${enc} 뒤`, { registry: reg });
        expect(out, `${name}: ${JSON.stringify(enc)}`).toContain("[숨김]");
        expect(out).not.toContain(enc);
      }
    }
    // A PEM-style block: 76 columns, CRLF.
    const pem = Buffer.from(v.repeat(4)).toString("base64").replace(/.{76}/g, "$&\r\n");
    const out = scrubKnown(`-----BEGIN X-----\r\n${pem}\r\n-----END X-----`, { registry: reg });
    expect(out.replace(/\s/g, "")).not.toMatch(/[A-Za-z0-9+/]{48,}/);
  });
});

describe("round 24: late registration, and secrets registered while a session opens", () => {
  it("every read path masks a secret registered after it was stored; the runtime gets nothing registered before hand-over", async () => {
    const late = `late-${crypto.randomBytes(12).toString("base64url")}`;
    const lateDuring = `during-${crypto.randomBytes(12).toString("base64url")}`;
    const db = createTestDb();
    const rt = scriptedRuntime();
    const runtimes = new RuntimeRegistry();
    runtimes.register(rt.adapter);
    let release: (() => void) | undefined;
    let gate: Promise<void> = Promise.resolve();
    const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
      db,
      logger: false,
      runtimes,
      runs: {
        flushMs: 0,
        // A run waits on the MCP endpoint before its runtime gets the history: the test holds it there.
        mcp: {
          endpoint: async () => {
            await gate;
            return { url: "http://127.0.0.1:9/mcp" };
          },
          toolNames: () => [],
          toolNamesFor: () => [],
        },
      },
    });
    apps.push(app);
    const f = await createFamily(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const cookie = f.cookies.owner;
    const headers = {
      host: "localhost:3000",
      cookie,
      origin: "http://localhost:3000",
      [CSRF_HEADER]: "1",
      "content-type": "application/json",
    };
    const conv = app.conversations!.create(f.users.owner.id, { title: `제목 ${late}` });
    const send = async (text: string) => {
      const res = await app.inject({
        method: "POST",
        url: `/api/conversations/${conv.id}/messages`,
        headers,
        payload: { text },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ run: { id: string } }>().run.id;
    };
    const waitDone = async (runId: string) => {
      for (let i = 0; i < 400; i++) {
        if (app.runs!.get(runId)?.endedAt) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("run did not end");
    };
    // 1. Stored while nobody knew it was a secret: the reply, its events, an artifact.
    rt.script(() => [{ type: "text_delta", text: `답 ${late} 끝` }]);
    const run1 = await send(`질문 ${late} ${lateDuring}`);
    await waitDone(run1);
    const art = app.artifacts!.create(
      { userId: f.users.owner.id, conversationId: conv.id, runId: run1 },
      { kind: "markdown", title: `문서 ${late}`, content: `# 본문\n\n${late}\n` },
    );
    expect(JSON.stringify(db.$client.prepare("select * from artifact_versions").all())).toContain(late);
    knownSecrets.add(late);
    const get = async (url: string) =>
      (await app.inject({ url, headers: { host: "localhost:3000", cookie } })).body;
    const id = art.artifact.id;
    const reads: [string, string][] = [
      ["messages API", await get(`/api/conversations/${conv.id}/messages`)],
      ["conversation API", await get(`/api/conversations/${conv.id}`)],
      ["conversations API", await get(`/api/conversations`)],
      ["artifact list", await get(`/api/conversations/${conv.id}/artifacts`)],
      ["artifact", await get(`/api/artifacts/${id}`)],
      ["artifact version", await get(`/api/artifacts/${id}/versions/1`)],
      ["artifact raw", await get(`/a/${id}/v/1/raw`)],
      ["artifact download", await get(`/a/${id}/v/1/download`)],
      ["sources", await get(`/api/conversations/${conv.id}/sources`)],
      [
        "event replay",
        await fetch(`${base}/api/runs/${run1}/events`, {
          headers: { host: "localhost:3000", cookie, "last-event-id": "0" },
        }).then((x) => x.text()),
      ],
      ["events after", JSON.stringify(app.runs!.eventsAfter(run1, 0))],
      ["artifact store", JSON.stringify([app.artifacts!.get(id), app.artifacts!.versions(id)])],
    ];
    for (const [what, body] of reads) expect(body, what).not.toContain(late);
    expect(reads.find(([w]) => w === "artifact raw")![1]).toContain("[숨김]");

    // 2. Registered while the next run waits for its session: the runtime gets neither secret.
    gate = new Promise<void>((r) => (release = r));
    rt.script(() => [{ type: "text_delta", text: "두 번째 답" }]);
    const run2 = await send(`다시 ${lateDuring}`);
    for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 30)); // waiting on the endpoint now
    knownSecrets.add(lateDuring);
    release!();
    await waitDone(run2);
    const handed = JSON.stringify(rt.seen.at(-1));
    expect(handed).not.toContain(lateDuring);
    expect(handed).not.toContain(late);
    expect(rt.seen.at(-1)!.input).toContain("[숨김]");
  });
});

describe("round 25: scrubber", () => {
  it("a replay is scrubbed as one stream: deltas joined cannot rebuild a secret registered after them", () => {
    const reg = new KnownSecrets();
    const v = "replay-0123456789abcdef";
    const ev = (data: object, seq: number) => ({ seq, data });
    const events = [
      ev({ type: "delta", text: "답 replay-01" }, 1),
      ev({ type: "tool_start", callId: "x", name: "t", input: {} }, 2),
      ev({ type: "delta", text: "23456" }, 3),
      ev({ type: "delta", text: "789abcdef 끝" }, 4),
      ev({ type: "done" }, 5),
    ];
    const joined = (es: { data: { type?: string; text?: string } }[]) =>
      es.map((e) => (e.data.type === "delta" ? e.data.text : "")).join("");
    expect(joined(scrubEventSequence(events, reg) as never)).toContain(v);
    reg.add(v);
    const out = scrubEventSequence(events, reg) as never as {
      seq: number;
      data: { type: string; text?: string };
    }[];
    expect(joined(out)).not.toContain(v);
    expect(joined(out)).toContain("[숨김]");
    expect(out.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    // Nothing across the deltas: every event exactly as stored (a replay matches the live stream).
    const plain = [ev({ type: "delta", text: "안녕 " }, 1), ev({ type: "delta", text: "하세요" }, 2)];
    expect(scrubEventSequence(plain, reg)).toEqual(plain);
  });

  it("numbers are compared by their canonical text", () => {
    const reg = new KnownSecrets();
    reg.add("84736251");
    expect(scrubKnownDeep({ value: 84736251, n: 7, list: [84736251] }, { registry: reg })).toEqual({
      value: "[숨김]",
      n: 7,
      list: ["[숨김]"],
    });
  });

  it("Python str octal escapes of the code points themselves (ä is \\344)", () => {
    const reg = new KnownSecrets();
    const v = "Pässwörd-2026-secret";
    reg.add(v);
    const pyStr = [...v].map((c) => "\\" + c.codePointAt(0)!.toString(8).padStart(3, "0")).join("");
    expect(scrubKnown(`code = "${pyStr}"`, { registry: reg })).toBe('code = "[숨김]"');
    const s = new StreamScrubber(reg);
    const r = rng(25);
    expect(
      chunks(`x ${pyStr} y`, r)
        .map((c) => s.push(c))
        .join("") + s.end(),
    ).toBe("x [숨김] y");
  });

  it("a value just over the cap has no short piece: ordinary words stay", () => {
    const reg = new KnownSecrets();
    const v = "x".repeat(MAX_KNOWN_LENGTH) + "a";
    reg.add(v);
    expect(reg.list().every((p) => p.length === MAX_KNOWN_LENGTH)).toBe(true);
    expect(scrubKnown("const data = banana;", { registry: reg })).toBe("const data = banana;");
    expect(scrubKnown(`a ${v} b`, { registry: reg })).toBe("a [숨김] b");
  });

  it("stays linear: a repeated prefix is not compared from every start", () => {
    const reg = new KnownSecrets();
    reg.add("a".repeat(16_384));
    let t = Date.now();
    expect(scrubKnown("a".repeat(16_384), { registry: reg })).toBe("[숨김]");
    expect(Date.now() - t).toBeLessThan(100);
    // Text that is only ever a prefix (every start a near-match): bounded work, and it fails safe (masked).
    t = Date.now();
    const out = scrubKnown("a".repeat(16_383) + "b", { registry: reg });
    expect(Date.now() - t).toBeLessThan(1000);
    expect(out).not.toMatch(/a{8192}/);
    const s = new StreamScrubber(reg);
    t = Date.now();
    for (let k = 0; k < 16; k++) s.push("a".repeat(1024));
    s.end();
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe("round 25: every egress and every stored row", () => {
  it("a numeric gate code returned as a JSON number is masked in rows, API, stream and replay", async () => {
    const gate = String(10_000_000 + crypto.randomInt(80_000_000));
    const db = createTestDb();
    const rt = scriptedRuntime();
    const runtimes = new RuntimeRegistry();
    runtimes.register(rt.adapter);
    const app = await buildApp(loadConfig({ NODE_ENV: "test", TEMP_GATE_CODE: gate }), {
      db,
      logger: false,
      runtimes,
      runs: { flushMs: 0 },
    });
    apps.push(app);
    const f = await createFamily(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const cookie = f.cookies.owner;
    const conv = app.conversations!.create(f.users.owner.id);
    rt.script(() => [
      { type: "tool_start", callId: "n1", name: "web_fetch", input: { n: Number(gate) } },
      { type: "tool_end", callId: "n1", output: { value: Number(gate) } },
      { type: "text_delta", text: "끝" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conv.id}/messages`,
      headers: {
        host: "localhost:3000",
        cookie,
        origin: "http://localhost:3000",
        [CSRF_HEADER]: "1",
        "content-type": "application/json",
      },
      payload: { text: "숫자" },
    });
    const runId = res.json<{ run: { id: string } }>().run.id;
    const sse = await fetch(`${base}/api/runs/${runId}/events`, {
      headers: { host: "localhost:3000", cookie },
    }).then((x) => x.text());
    const api = (
      await app.inject({
        url: `/api/conversations/${conv.id}/messages`,
        headers: { host: "localhost:3000", cookie },
      })
    ).body;
    const rows =
      JSON.stringify(db.$client.prepare("select parts from messages").all()) +
      JSON.stringify(db.$client.prepare("select data from run_events").all());
    for (const [what, hay] of [
      ["stream", sse],
      ["API", api],
      ["rows", rows],
      ["replay", JSON.stringify(app.runs!.eventsAfter(runId, 0))],
    ])
      expect(hay, what).not.toContain(gate);
    expect(sse).toContain("[숨김]");
  });

  it("a secret registered late is gone from stored rows after the rescrub, and replayed deltas cannot rebuild it", async () => {
    const late = `late25-${crypto.randomBytes(12).toString("base64url")}`;
    const db = createTestDb();
    const rt = scriptedRuntime();
    const runtimes = new RuntimeRegistry();
    runtimes.register(rt.adapter);
    const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
      db,
      logger: false,
      runtimes,
      runs: { flushMs: 0 },
    });
    apps.push(app);
    const f = await createFamily(app);
    const conv = app.conversations!.create(f.users.owner.id, { title: `제목 ${late}` });
    // Split across deltas (and a tool call), stored before anyone knows it is a secret.
    const pieces = [late.slice(0, 5), late.slice(5, 11), late.slice(11)];
    rt.script(() => [
      { type: "text_delta", text: `답 ${pieces[0]}` },
      { type: "text_delta", text: pieces[1]! },
      { type: "tool_start", callId: "x", name: "web_search", input: { q: "x" } },
      { type: "tool_end", callId: "x", output: { ok: true } },
      { type: "text_delta", text: `${pieces[2]} 끝` },
    ]);
    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conv.id}/messages`,
      headers: {
        host: "localhost:3000",
        cookie: f.cookies.owner,
        origin: "http://localhost:3000",
        [CSRF_HEADER]: "1",
        "content-type": "application/json",
      },
      payload: { text: `질문 ${late}` },
    });
    const runId = res.json<{ run: { id: string } }>().run.id;
    for (let i = 0; i < 400 && !app.runs!.get(runId)?.endedAt; i++)
      await new Promise((r) => setTimeout(r, 10));
    const art = app.artifacts!.create(
      { userId: f.users.owner.id, conversationId: conv.id, runId },
      { kind: "markdown", title: `문서 ${late}`, content: `본문 ${late}` },
    );
    app.notifications!.publish(f.users.owner.id, { kind: "connection_lost", runtimeLabel: `연결 ${late}` });
    const all = () =>
      [
        "conversations",
        "messages",
        "run_events",
        "artifacts",
        "artifact_versions",
        "notifications",
        "sources",
        "finance_results",
      ]
        .map((t) => JSON.stringify(db.$client.prepare(`select * from "${t}"`).all()))
        .join("\n");
    const joinedDeltas = (events: { data: { type: string; text?: string } }[]) =>
      events.map((e) => (e.data.type === "delta" ? e.data.text : "")).join("");
    // Split across stored deltas for sure, in a run of their own whose rows never hold the whole value (the live
    // holdback above may have joined pieces it was unsure about).
    const splitRun = crypto.randomUUID();
    const cols = (db.$client.prepare("pragma table_info(runs)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    db.$client
      .prepare(
        `insert into runs (${cols.join(", ")}) select ${cols
          .map((c) => (c === "id" ? "?" : c === "idempotency_key" ? "null" : c))
          .join(", ")} from runs where id = ?`,
      )
      .run(splitRun, runId);
    const msgOf = app.runs!.get(runId)!.assistantMessageId;
    pieces.forEach((p, k) =>
      db.$client
        .prepare("insert into run_events (run_id, seq, data, created_at) values (?, ?, ?, ?)")
        .run(
          splitRun,
          1 + k,
          JSON.stringify({ type: "delta", messageId: msgOf, partIndex: 0, text: p }),
          Date.now(),
        ),
    );
    expect(all()).toContain(late);
    expect(joinedDeltas(app.runs!.eventsAfter(splitRun, 0))).toContain(late);
    knownSecrets.add(late);
    // Replay: the deltas joined do not spell it, even before the rescrub has run.
    expect(joinedDeltas(app.runs!.eventsAfter(splitRun, 0))).not.toContain(late);
    await app.storedRescrub!.idle();
    const rows = all();
    expect(rows).not.toContain(late);
    expect(joinedDeltas(app.runs!.eventsAfter(splitRun, 0))).not.toContain(late);
    const stored = (
      db.$client.prepare("select data from run_events where run_id = ? order by seq").all(splitRun) as {
        data: string;
      }[]
    )
      .map((r) => JSON.parse(r.data) as { type: string; text?: string })
      .map((d) => (d.type === "delta" ? d.text : ""))
      .join("");
    expect(stored).not.toContain(late);
    expect(stored).toContain("[숨김]");
    // A finance result saved after registration (evidence taken from parts in memory) is stored scrubbed, and
    // `context()` returns it scrubbed.
    const msgId = app.runs!.get(runId)!.assistantMessageId;
    const fin = new FinanceResultStore(db);
    fin.save({ messageId: msgId, conversationId: conv.id, runId }, {
      sources: [{ name: late }],
      values: [],
      identifiers: [],
    } as unknown as AnswerEvidence);
    expect(JSON.stringify(db.$client.prepare("select evidence from finance_results").all())).not.toContain(
      late,
    );
    sql_raw(
      db,
      "update finance_results set evidence = ?",
      JSON.stringify({ sources: [{ name: late }], values: [], identifiers: [] }),
    );
    expect(JSON.stringify(fin.context(conv.id, Number.MAX_SAFE_INTEGER) ?? null)).not.toContain(late);
    // The artifact's hash follows its scrubbed content.
    const v = db.$client
      .prepare("select content, content_hash from artifact_versions where artifact_id = ?")
      .get(art.artifact.id) as {
      content: string;
      content_hash: string;
    };
    expect(v.content_hash).toBe(crypto.createHash("sha256").update(v.content, "utf8").digest("hex"));
  });

  it("push payloads and the inbox never carry a known secret", async () => {
    const key = `pushkey-${crypto.randomBytes(12).toString("base64url")}`;
    const sent: string[] = [];
    const db = createTestDb();
    const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
      db,
      logger: false,
      notifications: { sender: async (_t, payload) => void sent.push(payload) },
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
    const tag = (await app.inject({ url: "/api/push/devices", headers })).json<{ sessionTag: string }>()
      .sessionTag;
    const sub = await app.inject({
      method: "POST",
      url: "/api/push/devices",
      headers,
      payload: {
        endpoint: "https://fcm.googleapis.com/fcm/send/known25",
        keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
        label: "Android · Chrome",
        sessionTag: tag,
      },
    });
    expect(sub.statusCode, sub.body).toBeLessThan(300);
    knownSecrets.add(key);
    app.notifications!.publish(f.users.owner.id, { kind: "connection_lost", runtimeLabel: `공용 ${key}` });
    for (let i = 0; i < 100 && !sent.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(sent.length).toBeGreaterThan(0);
    const inbox = (await app.inject({ url: "/api/notifications", headers })).body;
    for (const [what, hay] of [
      ["push", sent.join("\n")],
      ["inbox", inbox],
      ["rows", JSON.stringify(db.$client.prepare("select * from notifications").all())],
    ])
      expect(hay, what).not.toContain(key);
  });

  it("every GET route answers without a known secret planted in the database (the response net)", async () => {
    const planted = `planted-${crypto.randomBytes(12).toString("base64url")}`;
    const db = createTestDb();
    const rt = scriptedRuntime();
    const runtimes = new RuntimeRegistry();
    runtimes.register(rt.adapter);
    const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
      db,
      logger: false,
      runtimes,
      runs: { flushMs: 0 },
    });
    apps.push(app);
    const f = await createFamily(app);
    // The rows are written raw (as if stored before anyone knew), and the rescrub is off: only reads and the
    // response net stand between them and a response.
    app.storedRescrub!.close();
    const conv = app.conversations!.create(f.users.owner.id);
    rt.script(() => [{ type: "text_delta", text: "답" }]);
    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conv.id}/messages`,
      headers: {
        host: "localhost:3000",
        cookie: f.cookies.owner,
        origin: "http://localhost:3000",
        [CSRF_HEADER]: "1",
        "content-type": "application/json",
      },
      payload: { text: "질문" },
    });
    const runId = res.json<{ run: { id: string } }>().run.id;
    for (let i = 0; i < 400 && !app.runs!.get(runId)?.endedAt; i++)
      await new Promise((r) => setTimeout(r, 10));
    const art = app.artifacts!.create(
      { userId: f.users.owner.id, conversationId: conv.id, runId },
      { kind: "markdown", title: "문서", content: "본문" },
    );
    app.notifications!.publish(f.users.owner.id, { kind: "connection_lost", runtimeLabel: "연결" });
    const sql = db.$client;
    sql.prepare("update conversations set title = ?").run(`제목 ${planted}`);
    sql
      .prepare("update messages set search_text = ?, parts = ?")
      .run(planted, JSON.stringify([{ type: "text", text: planted }]));
    sql.prepare("update run_events set data = json_set(data, '$.message', ?)").run(planted);
    sql.prepare("update artifacts set title = ?").run(`문서 ${planted}`);
    const trigger = (
      sql.prepare("select sql from sqlite_master where name = 'artifact_versions_immutable'").get() as {
        sql: string;
      }
    ).sql;
    sql.exec("drop trigger artifact_versions_immutable");
    sql
      .prepare("update artifact_versions set title = ?, content = ?")
      .run(`문서 ${planted}`, `본문 ${planted}`);
    sql.exec(trigger);
    sql.prepare("update notifications set title = ?, body = ?").run(`알림 ${planted}`, planted);
    sql.prepare("update users set name = ?").run(`이름 ${planted}`);
    knownSecrets.add(planted);
    const ids: Record<string, string> = {
      conversations: conv.id,
      artifacts: art.artifact.id,
      a: art.artifact.id,
      runs: runId,
    };
    const routes = fastifyRoutes(app).filter((r) => r.startsWith("GET "));
    expect(routes.length).toBeGreaterThan(30);
    const leaks: string[] = [];
    for (const route of routes) {
      const path = route.slice(4);
      // Path parameters: the planted rows' own ids where the route names them, a placeholder elsewhere.
      const url = path
        .split("/")
        .map((seg, k, all) =>
          seg.startsWith(":") ? (ids[all[k - 1] ?? ""] ?? (seg === ":version" ? "1" : "matrix-id")) : seg,
        )
        .join("/")
        .replace("*", "matrix-id");
      for (const who of ["owner", "admin"] as const) {
        const r = await app.inject({ url, headers: { host: "localhost:3000", cookie: f.cookies[who] } });
        if (r.body.includes(planted)) leaks.push(`${route} as ${who} (${r.statusCode})`);
      }
    }
    expect(leaks).toEqual([]);
  });
});
