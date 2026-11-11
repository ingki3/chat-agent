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
  scrubKnown,
  scrubKnownDeep,
  StreamScrubber,
} from "../src/secrets/known.js";
import { createFamily } from "./helpers/permission-matrix.js";

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
};

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

    const CASES = 24;
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
      const where = r.pick(["text", "reasoning", "tool_input", "tool_output", "notice", "end"] as const);
      rt.script(({ token }) => {
        const secret = kind === "mcp" ? token! : fixed;
        const enc = encFor(secret);
        const body = `설명 앞부분 ${enc} 그리고 뒷부분`;
        const evs: RuntimeEvent[] = [{ type: "text_delta", text: "시작. " }];
        if (where === "text") for (const c of chunks(body, r)) evs.push({ type: "text_delta", text: c });
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
        .map((e) => (e.type === "delta" ? e.text : "\n"))
        .join("");
      for (const [what, hay] of [
        ["subscription", sse],
        ["subscription text", joined],
        ["replay", replay],
        ["messages API", api.body + strings(api.json())],
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
