import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { skillToolName } from "@agentlee/mcp-tools";
import {
  GOOGLE_NEWS_SKILL,
  KR_STOCK_SKILL,
  SAFE_TEXT,
  SELFTEST_SKILL,
  SKILL_CATALOGUE,
  SKILL_SECRET_NAMES,
  SKILL_SPECS,
  type BundledSkill,
  type SkillSpec,
} from "@agentlee/mcp-tools/skills";
import { AdminSkillsResponse, CSRF_HEADER, type Run } from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { isFinanceTool } from "../src/instructions/assemble.js";
import { sanitizeRecord } from "../src/logging.js";
import { EgressService } from "../src/isolation/egress.js";
import { McpTokens } from "../src/isolation/tokens.js";
import {
  checkInstalled,
  checkSpec,
  installSkill,
  loadInstalledSkills,
  MANIFEST,
  PINNED,
} from "../src/mcp/install.js";
import { mcpOptionsFromConfig } from "../src/mcp/routes.js";
import { pythonRuntime } from "../src/mcp/python.js";
import {
  McpService,
  redactOutput,
  sandboxedSkillRunner,
  skillPolicy,
  SkillRefused,
  SYSTEM_CA_BUNDLE,
  type SkillRunner,
} from "../src/mcp/service.js";
import {
  RuntimeRegistry,
  type RuntimeAdapter,
  type RuntimeEvent,
  type RuntimeSession,
  type StartContext,
} from "../src/runtime/adapter.js";
import { createFamily } from "./helpers/permission-matrix.js";

const isMac = process.platform === "darwin";
const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});
const tmp = (prefix = "skills-") => {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  closers.push(() => {
    // Pinned copies have read-only folders: make them writable before removing.
    const open = (x: string) => {
      const st = fs.lstatSync(x, { throwIfNoEntry: false });
      if (!st?.isDirectory()) return;
      fs.chmodSync(x, 0o755);
      for (const e of fs.readdirSync(x)) open(path.join(x, e));
    };
    open(d);
    fs.rmSync(d, { recursive: true, force: true });
  });
  return d;
};

async function connect(url: string, token: string) {
  const client = new Client({ name: "skills-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  closers.push(() => client.close());
  return client;
}
type ToolReply = { isError?: boolean; content: { type: string; text: string }[] };
const errorOf = (r: unknown) => {
  const t = r as ToolReply;
  if (!t.isError) return undefined;
  try {
    return (JSON.parse(t.content[0]!.text) as { error?: string }).error ?? t.content[0]!.text;
  } catch {
    return t.content[0]!.text;
  }
};

/** A wrapped skill pointed at a fixture folder (its runner is stubbed or the folder holds a fixture script). */
const at = (spec: SkillSpec, dir = "/nonexistent"): BundledSkill => ({
  ...spec,
  dir,
  entry: path.join(dir, spec.files[0]!),
});

type U = { id: string; name: string; active: boolean; permissions?: { skills: "all" | string[] } };
function service(o: { users: U[]; skills?: BundledSkill[]; runSkill?: SkillRunner; python?: boolean }) {
  const users = new Map(o.users.map((u) => [u.id, structuredClone(u)]));
  const tokens = new McpTokens();
  const svc = new McpService(
    tokens,
    { byId: (id: string) => users.get(id) as never },
    {
      skills: [SELFTEST_SKILL, ...(o.skills ?? [])],
      ...(o.python === false ? {} : { python: { exe: "/opt/py/bin/python3.12", root: "/opt/py" } }),
      ...(o.runSkill ? { runSkill: o.runSkill } : {}),
    },
  );
  closers.push(() => svc.close());
  const issue = (userId: string, runId = `run-${userId}`) =>
    tokens.issue({ userId, conversationId: "c1", runId });
  return { svc, users, tokens, issue };
}

const MOM: U = { id: "u-mom", name: "엄마", active: true, permissions: { skills: "all" } };
const SON: U = {
  id: "u-son",
  name: "아들",
  active: true,
  permissions: { skills: ["google-news-search-skill"] },
};

describe("skill catalogue (#21, PRD §7)", () => {
  it("lists every §7 skill once; wrapped skills are 'implemented'; finance flags agree with the instructions", () => {
    const names = SKILL_CATALOGUE.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        "kr-stock-skill",
        "us-stock-skill",
        "market-disclosure-monitor",
        "dart-investment-monitor",
        "news-search-skill",
        "google-news-search-skill",
        "realtime-lookup-skill",
        "summarize",
        "pdf",
        "docx",
        "xlsx",
        "pptx",
        "python-scratchpad",
      ]),
    );
    for (const e of SKILL_CATALOGUE) expect(isFinanceTool(skillToolName(e.name)), e.name).toBe(e.finance);
    for (const s of SKILL_SPECS) {
      expect(SKILL_CATALOGUE.find((e) => e.name === s.name)?.status, s.name).toBe("implemented");
      expect(SKILL_CATALOGUE.find((e) => e.name === s.name)?.finance, s.name).toBe(s.finance);
      checkSpec(s);
    }
    for (const d of ["pdf", "docx", "xlsx", "pptx"])
      expect(SKILL_CATALOGUE.find((e) => e.name === d)?.status).toBe("document");
    expect(SKILL_SECRET_NAMES).toEqual([
      "ALPHAVANTAGE_API_KEY",
      "GEMINI_API_KEY",
      "OPENDART_API_KEY",
      "SEC_USER_AGENT",
    ]);
    // The other finance skills are served as finance tools (#30).
    for (const n of ["us-stock-skill", "market-disclosure-monitor", "dart-investment-monitor"])
      expect(SKILL_CATALOGUE.find((e) => e.name === n)?.status, n).toBe("tools");
  });

  it("builds fixed argument lists: every value is one --flag=value element", () => {
    expect(GOOGLE_NEWS_SKILL.args({ query: "삼성전자 실적" })).toEqual([
      "--query=삼성전자 실적",
      "--lookback-days=1",
      "--locale=ko-KR",
      "--sort=published",
      "--max-results=10",
      "--timeout=15",
      "--format=json",
    ]);
    // Text that looks like more flags stays inside the one --query element.
    const a = GOOGLE_NEWS_SKILL.args({ query: "x --format markdown --timeout 999", site: "yna.co.kr" })!;
    expect(a[0]).toBe("--query=x --format markdown --timeout 999");
    expect(a.filter((x) => x.startsWith("--format"))).toEqual(["--format=json"]);
    expect(KR_STOCK_SKILL.args({ command: "stock", code: "005930" })).toEqual([
      "naver-stock",
      "--code=005930",
      "--json",
    ]);
    expect(KR_STOCK_SKILL.args({ command: "index", code: "KOSDAQ" })).toEqual([
      "naver-index",
      "--code=KOSDAQ",
      "--json",
    ]);
    // A code that does not fit the command is refused, not passed on.
    expect(KR_STOCK_SKILL.args({ command: "stock", code: "KOSPI" })).toBeUndefined();
    expect(KR_STOCK_SKILL.args({ command: "index", code: "005930" })).toBeUndefined();
    expect(KR_STOCK_SKILL.args({ command: "alpha-quote", code: "aapl" })).toBeUndefined();
  });

  it("SAFE_TEXT refuses shell metacharacters, control characters and flag-looking text", () => {
    for (const bad of [
      "a; rm -rf /",
      "$(id)",
      "`id`",
      "a | b",
      "a && b",
      "a > /tmp/x",
      "a < /etc/passwd",
      "a\\b",
      "line\nbreak",
      "nul\0",
      "--format=markdown",
      "-q",
      "--",
    ])
      expect(SAFE_TEXT.test(bad), JSON.stringify(bad)).toBe(false);
    for (const ok of ["삼성전자 실적", '"exact phrase" site:yna.co.kr', "AI (OpenAI OR Anthropic)", "a-b"])
      expect(SAFE_TEXT.test(ok), ok).toBe(true);
  });
});

describe("skill calls through the MCP server: allow-list and argument checks (#21)", () => {
  const recorder = () => {
    const calls: { name: string; input: unknown }[] = [];
    const runSkill: SkillRunner = async (s, input) => {
      calls.push({ name: s.name, input });
      return { ok: true, output: { ran: s.name } };
    };
    return { calls, runSkill };
  };

  it("offers only allow-listed, installed skills; anything else is unknown to the server", async () => {
    const { calls, runSkill } = recorder();
    const { svc, issue } = service({ users: [MOM], skills: [at(GOOGLE_NEWS_SKILL)], runSkill });
    const client = await connect((await svc.endpoint()).url, issue("u-mom"));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "echo_time",
      "skill_google-news-search-skill",
      "skill_selftest",
    ]);
    for (const name of [
      "skill_us-stock-skill", // in the catalogue, not wrapped
      "skill_gmail-skill", // PRD: excluded
      "skill_../selftest",
      "skill_selftest/../google-news-search-skill",
      "mcp__agentlee__skill_selftest",
      "skill_",
    ])
      expect(errorOf(await client.callTool({ name, arguments: {} })), name).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it("refuses argument injection before any process starts: metacharacters, extra flags, `--` tricks, extra keys", async () => {
    const { calls, runSkill } = recorder();
    const { svc, issue } = service({
      users: [MOM],
      skills: [at(GOOGLE_NEWS_SKILL), at(KR_STOCK_SKILL)],
      runSkill,
    });
    const client = await connect((await svc.endpoint()).url, issue("u-mom"));
    const news = "skill_google-news-search-skill";
    const kr = "skill_kr-stock-skill";
    const refused: [string, Record<string, unknown>][] = [
      [news, { query: "x; cat /etc/passwd" }],
      [news, { query: "$(curl evil.example)" }],
      [news, { query: "`id`" }],
      [news, { query: "a\n--format=markdown" }],
      [news, { query: "--format=markdown" }],
      [news, { query: "-- --timeout=999" }],
      [news, { query: "ok", extra: "--debug" }], // a flag the definition does not have
      [news, { query: "ok", format: "markdown" }],
      [news, { query: "ok", site: "--evil" }],
      [news, { query: "ok", site: "../../etc" }],
      [news, { query: "ok", maxResults: 1000 }],
      [news, { query: "ok", lookbackDays: "1 --timeout=999" }],
      [kr, { command: "stock", code: "005930; rm -rf /" }],
      [kr, { command: "stock", code: "--apikey=x" }],
      [kr, { command: "stock", code: "005930 --apikey x" }],
      [kr, { command: "listing", code: "KRX" }], // not a wrapped command
      [kr, { command: "stock", code: "KOSPI" }], // code does not fit the command
      [kr, { command: "alpha-quote", code: "AAPL", apikey: "x" }],
      [kr, { command: "stock", code: "../../../etc/passwd" }],
      [kr, { command: "stock", code: "/etc/passwd" }],
    ];
    for (const [name, args] of refused)
      expect(errorOf(await client.callTool({ name, arguments: args })), JSON.stringify(args)).toBeTruthy();
    expect(calls).toEqual([]);
    // The real runner refuses it again when it builds the process (defence in depth).
    expect(() =>
      skillPolicy(
        at(KR_STOCK_SKILL),
        { command: "stock", code: "KOSPI" },
        { node: "/n", python: { exe: "/p", root: "/r" } },
      ),
    ).toThrow(SkillRefused);
    // A good call goes through with exactly the validated input.
    expect(
      (await client.callTool({ name: kr, arguments: { command: "stock", code: "005930" } })).isError,
    ).toBeFalsy();
    expect(calls.at(-1)).toEqual({ name: "kr-stock-skill", input: { command: "stock", code: "005930" } });
  });

  it("python skills are not offered without a usable python", () => {
    const { svc } = service({ users: [MOM], skills: [at(GOOGLE_NEWS_SKILL)], python: false });
    expect(svc.toolNames()).toEqual(["echo_time", "skill_selftest"]);
  });
});

describe("skill call log (#46 policy)", () => {
  it("one skill.finished per call: registered tool name, outcome code, duration, IDs — never input or output", async () => {
    const recs: Record<string, unknown>[] = [];
    const log = {
      info: (f: object, msg: string) => recs.push({ ...f, msg }),
      warn: (f: object, msg: string) => recs.push({ ...f, msg }),
      error: (f: object, msg: string) => recs.push({ ...f, msg }),
    };
    const ids = { u: crypto.randomUUID(), c: crypto.randomUUID(), r: crypto.randomUUID() };
    const tokens = new McpTokens();
    const svc = new McpService(
      tokens,
      { byId: () => ({ ...MOM, id: ids.u }) as never },
      {
        skills: [SELFTEST_SKILL, at(KR_STOCK_SKILL)],
        python: { exe: "/opt/py/bin/python3.12", root: "/opt/py" },
        runSkill: async () => ({ ok: true, output: { price: "SECRET-OUTPUT" } }),
        log: log as never,
      },
    );
    closers.push(() => svc.close());
    const client = await connect(
      (await svc.endpoint()).url,
      tokens.issue({ userId: ids.u, conversationId: ids.c, runId: ids.r }),
    );
    await client.callTool({ name: "skill_kr-stock-skill", arguments: { command: "stock", code: "005930" } });
    await client.callTool({ name: "skill_kr-stock-skill", arguments: { command: "stock", code: "KOSPI" } });
    const written = recs.map((r) => sanitizeRecord(r));
    expect(written.map(({ durationMs, ...r }) => (expect(typeof durationMs).toBe("number"), r))).toEqual([
      {
        msg: "skill.finished",
        userId: ids.u,
        conversationId: ids.c,
        runId: ids.r,
        tool: "skill_kr-stock-skill",
        status: "ok",
      },
      {
        msg: "skill.finished",
        userId: ids.u,
        conversationId: ids.c,
        runId: ids.r,
        tool: "skill_kr-stock-skill",
        status: "error",
        skillCode: "skill_bad_input",
      },
    ]);
    expect(JSON.stringify(recs)).not.toMatch(/005930|KOSPI|SECRET-OUTPUT/);
  });
});

describe("per-user skills (FR-1.6, #21)", () => {
  it("a user with finance hidden has no finance tool in the list, and calls to it are refused", async () => {
    const { calls, runSkill } = (() => {
      const calls: string[] = [];
      const runSkill: SkillRunner = async (s) => {
        calls.push(s.name);
        return { ok: true, output: {} };
      };
      return { calls, runSkill };
    })();
    const { svc, issue, users } = service({
      users: [MOM, SON],
      skills: [at(GOOGLE_NEWS_SKILL), at(KR_STOCK_SKILL)],
      runSkill,
    });
    expect(svc.toolNamesFor("u-mom")).toEqual([
      "echo_time",
      "skill_selftest",
      "skill_google-news-search-skill",
      "skill_kr-stock-skill",
    ]);
    const sonTools = svc.toolNamesFor("u-son");
    expect(sonTools).toEqual(["echo_time", "skill_selftest", "skill_google-news-search-skill"]);
    expect(sonTools.some(isFinanceTool)).toBe(false);

    const { url } = await svc.endpoint();
    const son = await connect(url, issue("u-son"));
    expect((await son.listTools()).tools.map((t) => t.name)).not.toContain("skill_kr-stock-skill");
    // Even a runtime that tries it anyway (it is not in its list) gets nothing.
    expect(
      errorOf(
        await son.callTool({ name: "skill_kr-stock-skill", arguments: { command: "stock", code: "005930" } }),
      ),
    ).toBeTruthy();
    expect(calls).toEqual([]);

    // Mom has it; when the admin hides it during her run, her next call is refused at once.
    const mom = await connect(url, issue("u-mom"));
    const call = () =>
      mom.callTool({ name: "skill_kr-stock-skill", arguments: { command: "stock", code: "005930" } });
    expect((await call()).isError).toBeFalsy();
    users.get("u-mom")!.permissions = { skills: ["google-news-search-skill"] };
    expect(errorOf(await call())).toBeTruthy(); // no longer listed for her
    // And a call already past the listing (same request) is refused by the service's own check.
    const host = (svc as unknown as { host(): import("@agentlee/mcp-tools").McpHost }).host();
    expect(
      await host.runSkill(
        "kr-stock-skill",
        { command: "stock", code: "005930" },
        { userId: "u-mom", conversationId: "c1", runId: "r" },
      ),
    ).toEqual({ ok: false, code: "skill_not_allowed" });
    expect(calls).toEqual(["kr-stock-skill"]);
  });

  it("admin API: catalogue with states; per-user skills set, validated and used by runs", async () => {
    const contexts: StartContext[] = [];
    const adapter: RuntimeAdapter = {
      id: "claude-code",
      capabilities: () => ({
        models: [{ id: "m", label: "M", efforts: [] }],
        canSwitchModelInSession: false,
        canResume: false,
        usesTools: true,
      }),
      start: async (ctx): Promise<RuntimeSession> => {
        contexts.push(ctx);
        return {
          externalSessionId: `s-${contexts.length}`,
          setModel: async () => {},
          close: async () => {},
          turn: () => ({
            interrupt: async () => {},
            events: (async function* (): AsyncGenerator<RuntimeEvent> {
              yield { type: "text_delta", text: "ok" };
            })(),
          }),
        };
      },
      resume: () => Promise.reject(new Error("no")),
    };
    const runtimes = new RuntimeRegistry();
    runtimes.register(adapter);
    const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
      db: createTestDb(),
      logger: false,
      runtimes,
      runs: { flushMs: 0 },
      mcp: {
        skills: [SELFTEST_SKILL, at(GOOGLE_NEWS_SKILL), at(KR_STOCK_SKILL)],
        installed: { "google-news-search-skill": "installed", "kr-stock-skill": "installed" },
        python: { exe: "/opt/py/bin/python3.12", root: "/opt/py" },
        runSkill: async () => ({ ok: true, output: {} }),
      },
    });
    closers.push(() => app.close());
    const f = await createFamily(app);
    const h = (cookie: string) => ({
      host: "localhost:3000",
      cookie,
      origin: "http://localhost:3000",
      [CSRF_HEADER]: "1",
      "content-type": "application/json",
    });

    const list = await app.inject({ url: "/api/admin/skills", headers: h(f.cookies.admin) });
    expect(list.statusCode).toBe(200);
    const skills = AdminSkillsResponse.parse(list.json()).skills;
    expect(skills.find((s) => s.name === "kr-stock-skill")).toMatchObject({
      status: "available",
      finance: true,
    });
    // Served by the finance tools (#30).
    expect(skills.find((s) => s.name === "us-stock-skill")).toMatchObject({
      status: "available",
      issue: "#30",
    });
    expect(skills.find((s) => s.name === "pdf")?.status).toBe("document");
    expect((await app.inject({ url: "/api/admin/skills", headers: h(f.cookies.owner) })).statusCode).toBe(
      403,
    );

    const put = (cookie: string, id: string, skills: unknown) =>
      app.inject({
        method: "PUT",
        url: `/api/admin/users/${id}/skills`,
        headers: h(cookie),
        payload: { skills },
      });
    // Hide finance from "stranger" (the son in this family).
    const son = f.users.stranger.id;
    expect((await put(f.cookies.owner, son, ["google-news-search-skill"])).statusCode).toBe(403);
    expect((await put(f.cookies.admin, son, ["gmail-skill"])).json()).toEqual({ error: "unknown_skill" });
    expect((await put(f.cookies.admin, son, "some")).statusCode).toBe(400);
    expect((await put(f.cookies.admin, "nope", "all")).statusCode).toBe(404);
    const ok = await put(f.cookies.admin, son, ["google-news-search-skill", "google-news-search-skill"]);
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ user: { permissions: { skills: unknown } } }>().user.permissions.skills).toEqual([
      "google-news-search-skill",
    ]);

    // Runs get the user's own tool list.
    const runFor = async (cookie: string, userId: string) => {
      const conv = app.conversations!.create(userId);
      const r = await app.inject({
        method: "POST",
        url: `/api/conversations/${conv.id}/messages`,
        headers: h(cookie),
        payload: { text: "주가 알려줘" },
      });
      expect(r.statusCode).toBe(201);
      const runId = r.json<{ run: Run }>().run.id;
      for (let i = 0; i < 400 && !(app.runs!.get(runId) as unknown as Run | undefined)?.endedAt; i++)
        await new Promise((x) => setTimeout(x, 10));
      return contexts.at(-1)!;
    };
    const sonCtx = await runFor(f.cookies.stranger, son);
    // The web tools (#50) are everyone's; web_search is offered because the news skill is its provider here.
    expect(sonCtx.tools).toEqual([
      "echo_time",
      "web_search",
      "web_fetch",
      "artifact_create",
      "artifact_update",
      "skill_selftest",
      "skill_google-news-search-skill",
    ]);
    expect(sonCtx.tools.some(isFinanceTool)).toBe(false);
    // The finance instructions follow the tools (#20): not in the son's prompt.
    expect(sonCtx.systemPrompt).not.toContain("# 금융 지침");
    const momCtx = await runFor(f.cookies.owner, f.users.owner.id);
    expect(momCtx.tools).toContain("skill_kr-stock-skill");
    expect(momCtx.systemPrompt).toContain("# 금융 지침");
  });

  it("tests never pick up skills installed in the developer's data folder", () => {
    expect(mcpOptionsFromConfig(loadConfig({ NODE_ENV: "test" }))).toEqual({});
  });
});

describe("server skill folder: install copies only listed files, refuses links and escapes (#21, D5)", () => {
  /** An admin skill folder like ~/Dev/skills/google-news-search-skill, with things that must never be copied. */
  function sourceSkill() {
    const src = tmp("src-");
    const dir = path.join(src, "google-news-search-skill");
    fs.mkdirSync(path.join(dir, "scripts", "venv"), { recursive: true });
    fs.writeFileSync(path.join(dir, "scripts", "google_news_search.py"), "print('{}')\n");
    fs.writeFileSync(path.join(dir, "scripts", "config.json"), '{"api_key":"SECRETKEY123"}');
    fs.writeFileSync(path.join(dir, "scripts", ".env"), "GEMINI_API_KEY=SECRET");
    fs.writeFileSync(path.join(dir, "SKILL.md"), "# skill");
    return { src, dir };
  }

  it("copies exactly the listed files, read-only, with a manifest; nothing else of the source", () => {
    const { dir } = sourceSkill();
    const root = path.join(tmp("data-"), "skills");
    const m = installSkill(GOOGLE_NEWS_SKILL, dir, root);
    expect(Object.keys(m.files)).toEqual(["scripts/google_news_search.py"]);
    const installed = path.join(root, "google-news-search-skill");
    const all: string[] = [];
    const walk = (d: string, rel = "") => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), r);
        else all.push(r);
      }
    };
    walk(installed);
    expect(all.sort()).toEqual([MANIFEST, "scripts/google_news_search.py"]);
    expect(fs.statSync(path.join(installed, "scripts", "google_news_search.py")).mode & 0o222).toBe(0);
    expect(fs.lstatSync(installed).isSymbolicLink()).toBe(false);
    expect(fs.statSync(path.join(installed, "scripts", "google_news_search.py")).nlink).toBe(1);
    expect(checkInstalled(GOOGLE_NEWS_SKILL, root)).toMatchObject({ state: "installed", dir: installed });
    // Reinstalling replaces the copy in one step.
    fs.writeFileSync(path.join(dir, "scripts", "google_news_search.py"), "print('{\"v\":2}')\n");
    installSkill(GOOGLE_NEWS_SKILL, dir, root);
    expect(fs.readFileSync(path.join(installed, "scripts", "google_news_search.py"), "utf8")).toContain("v");
    expect(fs.readdirSync(root)).toEqual(["google-news-search-skill"]);
    const { skills, states } = loadInstalledSkills(root, SKILL_SPECS);
    expect(states).toEqual({ "google-news-search-skill": "installed", "kr-stock-skill": "not_installed" });
    // It runs from its pinned copy, not from the install folder.
    expect(skills.map((s) => s.name)).toEqual(["google-news-search-skill"]);
    expect(path.dirname(skills[0]!.dir)).toBe(path.join(fs.realpathSync(root), PINNED));
    expect(skills[0]!.entry).toBe(path.join(skills[0]!.dir, "scripts", "google_news_search.py"));
    expect(fs.readFileSync(skills[0]!.entry, "utf8")).toContain("v");
  });

  it("refuses a parent folder swapped for a symlink between the check and the open (review #85)", () => {
    const outsideDir = tmp("outside-");
    fs.writeFileSync(path.join(outsideDir, "google_news_search.py"), "OUTSIDE FILE");
    const { dir } = sourceSkill();
    const root = path.join(tmp("data-"), "skills");
    let swapped = 0;
    expect(() =>
      installSkill(GOOGLE_NEWS_SKILL, dir, root, {
        beforeOpen: () => {
          // The checked path was fine; now its folder becomes a symlink to somewhere else.
          fs.renameSync(path.join(dir, "scripts"), path.join(dir, "scripts-real"));
          fs.symlinkSync(outsideDir, path.join(dir, "scripts"));
          swapped++;
        },
      }),
    ).toThrow(/symlink/);
    expect(swapped).toBe(1);
    expect(fs.existsSync(path.join(root, "google-news-search-skill"))).toBe(false);
  });

  it("refuses definitions whose files could escape the skill folder", () => {
    for (const files of [["../x.py"], ["/etc/passwd"], ["a/../../b.py"], ["./a.py"], ["a\\b.py"], [".."], []])
      expect(() => checkSpec({ name: "x", files }), JSON.stringify(files)).toThrow();
    for (const name of ["../x", "X", "a/b", ""])
      expect(() => checkSpec({ name, files: ["a.py"] }), name).toThrow();
  });

  it("refuses source files that are symlinks, behind a symlinked folder, or hard-linked", () => {
    const outside = path.join(tmp("outside-"), "family.txt");
    fs.writeFileSync(outside, "another family member's file");
    const root = path.join(tmp("data-"), "skills");
    const entry = (d: string) => path.join(d, "scripts", "google_news_search.py");

    const a = sourceSkill().dir;
    fs.rmSync(entry(a));
    fs.symlinkSync(outside, entry(a));
    expect(() => installSkill(GOOGLE_NEWS_SKILL, a, root)).toThrow(/symlink/);

    const b = sourceSkill().dir;
    const elsewhere = tmp("elsewhere-");
    fs.writeFileSync(path.join(elsewhere, "google_news_search.py"), "print(1)");
    fs.rmSync(path.join(b, "scripts"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(b, "scripts"));
    expect(() => installSkill(GOOGLE_NEWS_SKILL, b, root)).toThrow(/symlink/);

    const c = sourceSkill().dir;
    fs.rmSync(entry(c));
    fs.linkSync(outside, entry(c));
    expect(() => installSkill(GOOGLE_NEWS_SKILL, c, root)).toThrow(/hard-linked/);

    expect(fs.existsSync(path.join(root, "google-news-search-skill"))).toBe(false);
    expect(fs.existsSync(root) ? fs.readdirSync(root) : []).toEqual([]); // no half-written temp folders left
  });

  it("an installed copy that changed is not offered: edited, extra file, symlink, hard link, folder swapped", () => {
    const fresh = () => {
      const { dir } = sourceSkill();
      const root = path.join(tmp("data-"), "skills");
      installSkill(GOOGLE_NEWS_SKILL, dir, root);
      const inst = path.join(root, "google-news-search-skill");
      return { root, inst, file: path.join(inst, "scripts", "google_news_search.py") };
    };
    const outside = path.join(tmp("outside-"), "secret.txt");
    fs.writeFileSync(outside, "SECRET");

    let x = fresh();
    fs.chmodSync(x.file, 0o644);
    fs.writeFileSync(x.file, "import os; os.system('id')");
    expect(checkInstalled(GOOGLE_NEWS_SKILL, x.root).state).toBe("broken");

    x = fresh();
    fs.writeFileSync(path.join(x.inst, "scripts", "config.json"), "{}");
    expect(checkInstalled(GOOGLE_NEWS_SKILL, x.root).state).toBe("broken");

    x = fresh();
    fs.symlinkSync(outside, path.join(x.inst, "scripts", "link.txt"));
    expect(checkInstalled(GOOGLE_NEWS_SKILL, x.root).state).toBe("broken");

    x = fresh();
    const body = fs.readFileSync(x.file);
    fs.rmSync(x.file);
    fs.writeFileSync(outside + ".py", body);
    fs.symlinkSync(outside + ".py", x.file); // same content, but a symlink
    expect(checkInstalled(GOOGLE_NEWS_SKILL, x.root).state).toBe("broken");

    x = fresh();
    fs.linkSync(x.file, path.join(tmp("outside-"), "second-name.py")); // same inode, a second name elsewhere
    expect(checkInstalled(GOOGLE_NEWS_SKILL, x.root).state).toBe("broken");

    x = fresh();
    const moved = path.join(tmp("moved-"), "copy");
    fs.renameSync(x.inst, moved);
    fs.symlinkSync(moved, x.inst); // the skill folder itself is a symlink
    expect(checkInstalled(GOOGLE_NEWS_SKILL, x.root).state).toBe("broken");

    expect(loadInstalledSkills(x.root, SKILL_SPECS).skills).toEqual([]);
  });
});

describe("skill sandbox policy (#21 on #42)", () => {
  const py = { exe: "/opt/py/bin/python3.12", root: "/opt/py" };
  const proxy = { url: "http://127.0.0.1:41000", port: 41000 };

  it("python skill: own folder + interpreter folder, network only to its egress proxy, fixed environment", () => {
    const skill = at(GOOGLE_NEWS_SKILL, "/srv/data/skills/google-news-search-skill");
    const p = skillPolicy(
      skill,
      { query: "뉴스" },
      { node: "/n", python: py, proxy, secrets: { OTHER: "x" } },
    );
    expect(p).toMatchObject({
      command: py.exe,
      args: ["-I", "-S", "-B", skill.entry, ...GOOGLE_NEWS_SKILL.args({ query: "뉴스" })!],
      cwd: skill.dir,
      read: [skill.dir],
      trusted: [py.root, SYSTEM_CA_BUNDLE],
      write: [],
      network: { loopbackPorts: [41000] },
    });
    expect(p.env).toEqual({
      HTTPS_PROXY: proxy.url,
      https_proxy: proxy.url,
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      SSL_CERT_FILE: SYSTEM_CA_BUNDLE,
    });
    expect(p.secretValues).toEqual([]);
  });

  it("secrets: only the declared one, only when the call needs it, refused when missing", () => {
    const skill = at(KR_STOCK_SKILL);
    const ctx = { node: "/n", python: py, proxy };
    expect(
      skillPolicy(
        skill,
        { command: "stock", code: "005930" },
        { ...ctx, secrets: { ALPHAVANTAGE_API_KEY: "AVKEY12345" } },
      ).env,
    ).not.toHaveProperty("ALPHAVANTAGE_API_KEY");
    const p = skillPolicy(
      skill,
      { command: "alpha-quote", code: "AAPL" },
      { ...ctx, secrets: { ALPHAVANTAGE_API_KEY: "AVKEY12345", OPENDART_API_KEY: "DARTKEY123" } },
    );
    expect(p.env.ALPHAVANTAGE_API_KEY).toBe("AVKEY12345");
    expect(p.env).not.toHaveProperty("OPENDART_API_KEY");
    expect(p.args.join(" ")).not.toContain("AVKEY12345"); // never in argv (ps would show it)
    expect(() => skillPolicy(skill, { command: "alpha-quote", code: "AAPL" }, ctx)).toThrow(
      expect.objectContaining({ code: "skill_unconfigured" }),
    );
    expect(() =>
      skillPolicy(skill, { command: "stock", code: "005930" }, { node: "/n", python: py }),
    ).toThrow(
      expect.objectContaining({ code: "skill_unavailable" }), // no proxy, no network skill
    );
    expect(() => skillPolicy(skill, { command: "stock", code: "005930" }, { node: "/n", proxy })).toThrow(
      expect.objectContaining({ code: "skill_unavailable" }), // no python
    );
  });

  it("each skill gets its own egress proxy with its own hosts", async () => {
    const made: string[][] = [];
    const svc = new McpService(
      new McpTokens(),
      { byId: () => undefined },
      {
        skills: [SELFTEST_SKILL, at(GOOGLE_NEWS_SKILL), at(KR_STOCK_SKILL)],
        python: py,
        egress: (allow) => {
          made.push([...allow]);
          return new EgressService({ allow });
        },
      },
    );
    closers.push(() => svc.close());
    const proxyFor = (s: BundledSkill) =>
      (
        svc as unknown as { proxyFor(key: string, hosts: readonly string[]): Promise<{ port: number }> }
      ).proxyFor(s.name, s.hosts);
    const a = await proxyFor(at(GOOGLE_NEWS_SKILL));
    const b = await proxyFor(at(KR_STOCK_SKILL));
    expect(a.port).not.toBe(b.port);
    expect(await proxyFor(at(GOOGLE_NEWS_SKILL))).toBe(a);
    expect(made).toEqual([["news.google.com"], ["m.stock.naver.com", "www.alphavantage.co"]]);
    // The news skill's proxy will not tunnel to the stock site (and vice versa).
    const connectVia = (port: number, host: string) =>
      new Promise<string>((resolve) => {
        const s = net.connect(port, "127.0.0.1", () =>
          s.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}\r\n\r\n`),
        );
        s.once("data", (d) => {
          resolve(d.toString().split("\r\n")[0]!);
          s.destroy();
        });
        s.on("error", () => resolve("error"));
      });
    expect(await connectVia(a.port, "m.stock.naver.com")).toMatch(/403/);
    expect(await connectVia(b.port, "news.google.com")).toMatch(/403/);
  });

  it("pythonRuntime accepts only a self-contained build's own folder", () => {
    expect(pythonRuntime(undefined).ok).toBe(false);
    expect(pythonRuntime("python3").ok).toBe(false);
    expect(pythonRuntime("/nonexistent/bin/python3.12").ok).toBe(false);
    const fake = (rel: string) => {
      const root = tmp("py-");
      const exe = path.join(root, rel);
      fs.mkdirSync(path.dirname(exe), { recursive: true });
      fs.writeFileSync(exe, "");
      fs.chmodSync(exe, 0o755);
      return { root, exe };
    };
    const good = fake("cpython-3.12/bin/python3.12");
    fs.mkdirSync(path.join(good.root, "cpython-3.12", "lib"));
    expect(pythonRuntime(good.exe)).toEqual({
      ok: true,
      runtime: { exe: good.exe, root: path.join(good.root, "cpython-3.12") },
    });
    const framework = fake("Python.framework/Versions/3.12/bin/python3.12");
    fs.mkdirSync(path.join(framework.root, "Python.framework/Versions/3.12/lib"));
    expect(pythonRuntime(framework.exe)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/framework/),
    });
    expect(pythonRuntime(fake("x/bin/node").exe).ok).toBe(false);
    expect(pythonRuntime(fake("x/python3").exe).ok).toBe(false);
  });
});

describe("pinned copies: what runs is what was verified (review #85)", () => {
  function loaded() {
    const src = tmp("src-");
    const dir = path.join(src, "google-news-search-skill", "scripts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "google_news_search.py"), "print('{}')\n");
    const root = path.join(tmp("data-"), "skills");
    installSkill(GOOGLE_NEWS_SKILL, path.join(src, "google-news-search-skill"), root);
    const skill = loadInstalledSkills(root, SKILL_SPECS).skills[0]!;
    const writable = (f: () => void) => {
      fs.chmodSync(skill.dir, 0o755);
      fs.chmodSync(path.join(skill.dir, "scripts"), 0o755);
      f();
    };
    return { root, skill, writable, file: skill.entry };
  }

  it("is read-only, content-addressed, and passes its check while untouched", () => {
    const { root, skill } = loaded();
    expect(skill.verify!()).toBe(true);
    expect(fs.statSync(skill.dir).mode & 0o222).toBe(0);
    expect(fs.statSync(skill.entry).mode & 0o222).toBe(0);
    // Loading again reuses the same pin; pins no longer used are removed.
    const again = loadInstalledSkills(root, SKILL_SPECS).skills[0]!;
    expect(again.dir).toBe(skill.dir);
    fs.mkdirSync(path.join(root, PINNED, "stale"));
    loadInstalledSkills(root, SKILL_SPECS);
    expect(fs.readdirSync(path.join(root, PINNED))).toEqual([path.basename(skill.dir)]);
  });

  it("changing the install folder after loading does not change what runs", () => {
    const { root, skill } = loaded();
    const installed = path.join(root, "google-news-search-skill", "scripts", "google_news_search.py");
    fs.chmodSync(installed, 0o644);
    fs.writeFileSync(installed, "import os; os.system('id')");
    expect(fs.readFileSync(skill.entry, "utf8")).toBe("print('{}')\n");
    expect(skill.verify!()).toBe(true);
  });

  it("any change to the pinned copy fails the check before the run", () => {
    let x = loaded();
    x.writable(() => {
      fs.chmodSync(x.file, 0o644);
      fs.writeFileSync(x.file, "print('{\"evil\":1}')\n");
    });
    expect(x.skill.verify!()).toBe(false);

    x = loaded();
    x.writable(() => fs.writeFileSync(path.join(x.skill.dir, "scripts", "extra.txt"), "KEY"));
    expect(x.skill.verify!()).toBe(false);

    x = loaded();
    const outside = path.join(tmp("outside-"), "evil.py");
    fs.writeFileSync(outside, "print('{}')\n"); // same content, but a symlink to elsewhere
    x.writable(() => {
      fs.rmSync(x.file);
      fs.symlinkSync(outside, x.file);
    });
    expect(x.skill.verify!()).toBe(false);

    x = loaded();
    x.writable(() => fs.linkSync(x.file, path.join(tmp("outside-"), "second.py")));
    expect(x.skill.verify!()).toBe(false);

    x = loaded();
    const moved = path.join(tmp("moved-"), "pin");
    fs.chmodSync(x.skill.dir, 0o755); // a read-only folder cannot move to another parent
    fs.renameSync(x.skill.dir, moved);
    fs.symlinkSync(moved, x.skill.dir); // the pinned folder itself swapped for a symlink
    expect(x.skill.verify!()).toBe(false);

    // Same content rewritten (new inode and mtime): the full hash still matches, so it passes.
    x = loaded();
    x.writable(() => {
      const body = fs.readFileSync(x.file);
      fs.rmSync(x.file);
      fs.writeFileSync(x.file, body);
    });
    expect(x.skill.verify!()).toBe(true);
  });

  it("the runner refuses a skill whose check fails, before starting anything", async () => {
    const run = sandboxedSkillRunner({ node: "/nonexistent/node" });
    const r = await run(
      { ...SELFTEST_SKILL, verify: () => false },
      { text: "x" },
      {
        userId: "u",
        conversationId: "c",
        runId: "r",
      },
    );
    expect(r).toEqual({ ok: false, code: "skill_changed" });
  });
});

describe("secret redaction of skill results (review #85)", () => {
  const S = "AVKEY12345";
  const out = (stdout: string, secrets = [S]) => redactOutput(stdout, secrets);
  it("plain, JSON-escaped, nested, in keys: the secret never comes back", () => {
    expect(out(`{"k":"${S}"}`)).toEqual({ ok: true, output: { k: "[redacted]" } });
    // \u escapes spell the secret only after parsing.
    expect(out('{"secret":"\\u0041VKEY12345"}')).toEqual({ ok: true, output: { secret: "[redacted]" } });
    expect(out('{"s":"AVKEY\\u00312345 tail"}')).toEqual({ ok: true, output: { s: "[redacted] tail" } });
    expect(
      // Escaped everywhere, so the raw text never contains the secret: only the decoded values do.
      out(
        JSON.stringify({ a: [{ b: [`x${S}y`, 1, null] }], [`key-${S}`]: { deep: { deeper: [S] } } })
          .split(S)
          .join("\\u0041VKEY12345"),
      ),
    ).toEqual({
      ok: true,
      output: {
        a: [{ b: ["x[redacted]y", 1, null] }],
        "key-[redacted]": { deep: { deeper: ["[redacted]"] } },
      },
    });
    // A secret with characters JSON escapes (quote, backslash) is found after decoding.
    const q = 'AV"KEY\\12345';
    const r = out(JSON.stringify({ v: q, [q]: 1 }), [q]);
    expect(JSON.stringify(r)).not.toContain(JSON.stringify(q).slice(1, -1));
    expect(r).toEqual({ ok: true, output: { v: "[redacted]", "[redacted]": 1 } });
  });
  it("a numeric secret produced by number normalisation is refused (round 3)", () => {
    for (const stdout of ['{"v":1.2345678e7}', "1.2345678e7", '{"a":[[1.2345678E+7]]}'])
      expect(out(stdout, ["12345678"]), stdout).toEqual({ ok: false, code: "skill_bad_output" });
  });

  it("a replacement that recreates the secret from its surroundings is refused (round 2)", () => {
    const secret = 'redacted]"';
    expect(out(JSON.stringify({ v: secret + '"' }), [secret])).toEqual({
      ok: false,
      code: "skill_bad_output",
    });
    expect(out(JSON.stringify({ [secret + '"']: 1 }), [secret])).toEqual({
      ok: false,
      code: "skill_bad_output",
    });
    expect(out(JSON.stringify({ a: [[{ b: secret + '"' }]] }), [secret])).toEqual({
      ok: false,
      code: "skill_bad_output",
    });
  });

  it("non-JSON output is refused without content; no secrets means untouched output", () => {
    expect(out(`key is ${S}`)).toEqual({ ok: false, code: "skill_bad_output" });
    expect(out(`{"k":"${S}"}`, [])).toEqual({ ok: true, output: { k: S } });
  });
});

/** A self-contained python on this machine (uv), for the sandbox tests; they are skipped without one. */
function findStandalonePython(): string | undefined {
  if (!isMac) return undefined;
  const fromEnv = process.env.TEST_SKILL_PYTHON;
  const candidates = fromEnv ? [fromEnv] : [];
  if (!fromEnv)
    try {
      const out = execFileSync("uv", ["python", "list", "--only-installed", "--output-format", "json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const p of JSON.parse(out) as { path?: string; implementation?: string }[])
        if (p.path && p.implementation === "cpython") candidates.push(p.path);
    } catch {
      // no uv
    }
  return candidates.find((c) => pythonRuntime(c).ok);
}
const PY = findStandalonePython();

describe.skipIf(!PY)("python skills in the real sandbox (macOS, standalone python)", () => {
  const runtime = PY
    ? (pythonRuntime(PY) as { ok: true; runtime: { exe: string; root: string } }).runtime
    : undefined;

  /** A fixture python skill that probes its sandbox and reports what it could do. */
  const PROBE = String.raw`
import json, os, socket, sys
inp = json.loads(sys.stdin.read())
out = {"input": inp, "argv": sys.argv[1:], "env": sorted(os.environ)}
def attempt(name, fn):
    try:
        fn(); out[name] = "OK"
    except BaseException as e:
        out[name] = "ERR " + type(e).__name__
attempt("fork", lambda: os.fork() == 0 and os._exit(0))
attempt("read_outside", lambda: open(os.environ.get("PROBE_OUTSIDE", "/etc/hosts")).read())
attempt("read_home", lambda: os.listdir(os.path.expanduser("~")))
attempt("write_own", lambda: open("x.txt", "w").write("x"))
def direct():
    s = socket.create_connection(("127.0.0.1", int(inp["direct"])), timeout=3); s.close()
attempt("direct_net", direct)
def via_proxy(host):
    u = os.environ["HTTPS_PROXY"].rsplit(":", 1)
    s = socket.create_connection(("127.0.0.1", int(u[1])), timeout=5)
    s.sendall(("CONNECT %s:443 HTTP/1.1\r\nHost: %s\r\n\r\n" % (host, host)).encode())
    line = s.recv(200).decode().split("\r\n")[0]; s.close(); return line
out["proxy_allowed"] = via_proxy("allowed.example")
out["proxy_other"] = via_proxy("other.example")
out["secret"] = os.environ.get("PROBE_KEY", "")
print(json.dumps(out))
`;
  const spec: SkillSpec = {
    name: "probe",
    description: "probe",
    input: {},
    finance: false,
    kind: "python",
    files: ["probe.py"],
    args: (i) => [`--mode=${String(i.mode ?? "x")}`],
    hosts: ["allowed.example"],
    secrets: [{ env: "PROBE_KEY" }],
  };

  it("standard library only, no fork, reads only its folder, writes nothing, network only via its proxy", async () => {
    const dir = tmp("probe-");
    fs.writeFileSync(path.join(dir, "probe.py"), PROBE);
    const outside = path.join(tmp("outside-"), "family.txt");
    fs.writeFileSync(outside, "OUTSIDE");
    // Something listening that the skill must not reach directly.
    const target = http.createServer((_q, r) => r.end("OPEN"));
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise((r) => target.close(r)));
    const direct = (target.address() as net.AddressInfo).port;
    // The skill's proxy: allowed.example resolves to a public address; the tunnel goes to a local echo server.
    const echo = net.createServer((s) => s.on("data", (d) => s.write(d)));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise((r) => echo.close(r)));
    const egress = new EgressService({
      allow: ["allowed.example"],
      lookup: async () => ["93.184.216.34"],
      connect: () => net.connect((echo.address() as net.AddressInfo).port, "127.0.0.1"),
    });
    closers.push(() => egress.close());
    const run = sandboxedSkillRunner({
      python: runtime,
      secrets: { PROBE_KEY: "PROBE-SECRET-VALUE" },
      proxy: () => egress.endpoint(),
      limits: { timeoutMs: 20_000, maxOutputBytes: 64 * 1024, maxRssBytes: 512 * 1024 * 1024 },
    });
    const r = await run(
      { ...spec, dir, entry: path.join(dir, "probe.py") },
      { mode: "a", direct },
      { userId: "u", conversationId: "c", runId: "r" },
    );
    expect(r.ok).toBe(true);
    const out = (r as { output: Record<string, unknown> }).output;
    expect(out.input).toEqual({ mode: "a", direct });
    expect(out.argv).toEqual(["--mode=a"]);
    expect(out.env).toEqual(
      expect.arrayContaining(["HTTPS_PROXY", "https_proxy", "LANG", "LC_ALL", "PROBE_KEY", "SSL_CERT_FILE"]),
    );
    expect(
      (out.env as string[]).filter((e) => !["__CF_USER_TEXT_ENCODING", "LC_CTYPE"].includes(e)).sort(),
    ).toEqual(["HTTPS_PROXY", "LANG", "LC_ALL", "PROBE_KEY", "SSL_CERT_FILE", "https_proxy"]);
    expect(out.fork).toMatch(/^ERR/);
    expect(out.read_outside).toMatch(/^ERR/);
    expect(out.read_home).toMatch(/^ERR/);
    expect(out.write_own).toMatch(/^ERR/);
    expect(out.direct_net).toMatch(/^ERR/);
    expect(out.proxy_allowed).toMatch(/200/);
    expect(out.proxy_other).toMatch(/403/);
    // The secret reached the process, but never comes back in the result.
    expect(out.secret).toBe("[redacted]");
    expect(JSON.stringify(r)).not.toContain("PROBE-SECRET-VALUE");
  });
});

/**
 * Live checks against the real skills in the admin's folders (macOS, network). Opt in with SKILLS_LIVE=1 (and
 * TEST_SKILL_PYTHON or uv); the Alpha Vantage call additionally needs ALPHAVANTAGE_API_KEY and is skipped otherwise.
 */
const LIVE = process.env.SKILLS_LIVE === "1" && !!PY;
describe.skipIf(!LIVE)("real skills, live (SKILLS_LIVE=1)", () => {
  async function liveService() {
    const root = path.join(tmp("live-"), "skills");
    const { findSource } = await import("../src/mcp/install.js");
    const sources = [
      path.join(os.homedir(), ".agents", "skills"),
      path.join(os.homedir(), ".claude", "skills"),
    ];
    for (const s of SKILL_SPECS) installSkill(s, findSource(s.name, sources)!, root);
    const { skills, states } = loadInstalledSkills(root, SKILL_SPECS);
    const tokens = new McpTokens();
    const svc = new McpService(
      tokens,
      { byId: () => MOM as never },
      {
        skills: [SELFTEST_SKILL, ...skills],
        installed: states,
        python: (pythonRuntime(PY) as { ok: true; runtime: { exe: string; root: string } }).runtime,
        secrets: process.env.ALPHAVANTAGE_API_KEY
          ? { ALPHAVANTAGE_API_KEY: process.env.ALPHAVANTAGE_API_KEY }
          : {},
      },
    );
    closers.push(() => svc.close());
    const client = await connect(
      (await svc.endpoint()).url,
      tokens.issue({ userId: "u-mom", conversationId: "c", runId: "r" }),
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as ToolReply;
      return {
        error: errorOf(r),
        out: r.isError ? undefined : (JSON.parse(r.content[0]!.text) as Record<string, unknown>),
      };
    };
    return { call };
  }

  it("google-news-search-skill and kr-stock-skill answer through the sandbox and their proxies", async () => {
    const { call } = await liveService();
    const news = await call("skill_google-news-search-skill", { query: "삼성전자", maxResults: 2 });
    expect(news.error).toBeUndefined();
    expect(news.out).toMatchObject({ ok: true });
    expect((news.out!.items as unknown[]).length).toBeGreaterThan(0);
    const stock = await call("skill_kr-stock-skill", { command: "stock", code: "005930" });
    expect(stock.out).toMatchObject({ status: "available", code: "005930", name: "삼성전자" });
    const index = await call("skill_kr-stock-skill", { command: "index", code: "KOSPI" });
    expect(index.out).toMatchObject({ status: "available", code: "KOSPI" });
    const alpha = await call("skill_kr-stock-skill", { command: "alpha-quote", code: "AAPL" });
    if (process.env.ALPHAVANTAGE_API_KEY) expect(alpha.out).toMatchObject({ provider: "Alpha Vantage" });
    else expect(alpha.error).toBe("skill_unconfigured"); // live call skipped: no key in this environment
  }, 120_000);
});
