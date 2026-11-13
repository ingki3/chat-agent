import { carriesSecret, SEARCH_DECOY, withoutParam } from "../secrets/egress.js";
import fs from "node:fs";
import { z } from "zod";
import {
  skillToolName,
  startMcpServer,
  toolNames,
  type McpHost,
  type RunningMcpServer,
  type SkillResult,
  type ToolScope,
} from "@agentlee/mcp-tools";
import {
  ALWAYS_ON_SKILLS,
  GOOGLE_NEWS_SKILL,
  SELFTEST_SKILL,
  SKILL_CATALOGUE,
  type BundledSkill,
  type CatalogueStatus,
} from "@agentlee/mcp-tools/skills";
import { CITE_TOOL, SOURCES_LIST_TOOL, WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "@agentlee/mcp-tools/web";
import {
  FINANCE_CHART_TOOL,
  FINANCE_TOOLS,
  WATCHLIST_GET_TOOL,
  type FinanceComposedToolInfo,
  type FinanceToolInfo,
} from "@agentlee/mcp-tools/finance";
import { FinanceService, type FinanceOptions } from "../finance/service.js";
import { buildFinanceArtifacts, fetchDataset, type ChartInput } from "../finance/chart.js";
import { finalize } from "../finance/records.js";
import { watchSymbolOk, type WatchlistStore } from "../watchlist/store.js";
import {
  ARTIFACT_CREATE_TOOL,
  ARTIFACT_READ_CHARS,
  ARTIFACT_READ_TOOL,
  ARTIFACT_TOOLS,
  ARTIFACT_UPDATE_TOOL,
} from "@agentlee/mcp-tools/artifacts";
import { SCHEDULE_CREATE_TOOL } from "@agentlee/mcp-tools/schedules";
import type { ScheduleProposalStore } from "../schedules/proposals.js";
import { firstRunAfter, ScheduleInputError } from "../schedules/store.js";
import {
  artifactPath,
  frameExternal,
  ScheduleProposalInput,
  type ArtifactKind,
  type ScheduleProposalToolOutput,
} from "@agentlee/shared";
import { DOC_CREATE_TOOL, DOC_TOOLS } from "@agentlee/mcp-tools/docgen";
import type { DocGenService } from "../docgen/service.js";
import { PYTHON_RUN_TOOL, PYTHON_TOOLS, type PythonToolInfo } from "@agentlee/mcp-tools/python";
import { PYTHON_SKILL } from "@agentlee/shared";
import type { PythonScratchpad } from "../python/service.js";
import {
  FILE_CITE_TOOL,
  FILE_LIST_TOOL,
  FILE_READ_TOOL,
  FILE_SEARCH_TOOL,
  FILE_TOOLS,
} from "@agentlee/mcp-tools/files";
import type { FileTools } from "../files/text.js";
import { CiteRefused, type CitationStore } from "../citations/store.js";
import { ArtifactError, type ArtifactBody, type ArtifactStore } from "../artifacts/store.js";
import type { ServerToolInfo } from "@agentlee/mcp-tools";
import type { UserStore } from "../auth/users.js";
import { EgressService } from "../isolation/egress.js";
import type { McpTokens } from "../isolation/tokens.js";
import { runIsolated, type RunIsolatedOptions } from "../isolation/sandbox.js";
import { logEvent, type EventLogger } from "../logging.js";
import { registerToolNames } from "../observability/policy.js";
import type { InstallState } from "./install.js";
import type { ErrorLog } from "../observability/errors.js";
import type { SkillSwitches } from "./switches.js";
import type { PythonRuntime } from "./python.js";
import type { SourceStore } from "../web/sources.js";
import { scrubKnown, scrubKnownDeep } from "../secrets/known.js";
import {
  DUCKDUCKGO_HOSTS,
  duckDuckGoProvider,
  sandboxedWorker,
  WebService,
  blockedByEgress,
  type Proxy,
  type SearchProvider,
  type SearchProviderName,
  type WebWorker,
} from "../web/service.js";

/** PRD §7 finance skills (FR-7): hidden from youth accounts unless named explicitly (#30). */
const FINANCE_SKILLS: ReadonlySet<string> = new Set(
  SKILL_CATALOGUE.filter((e) => e.finance).map((e) => e.name),
);

export const isFinanceSkill = (skill: string) => FINANCE_SKILLS.has(skill);

/**
 * Whether a user's own permissions allow `skill` (FR-1.6) — not whether it is offered now (`McpService.allows`
 * adds the account being active and the server allow-list). "all" = every skill except the finance skills for a
 * youth account (the son, #30): hidden by default; only an explicit list that names them turns them on.
 */
export function skillPermitted(user: { permissions?: unknown; youth?: unknown }, skill: string): boolean {
  const p = (user as { permissions?: { skills?: unknown } }).permissions?.skills;
  if (p === "all") return !(user.youth === true && FINANCE_SKILLS.has(skill));
  return Array.isArray(p) && p.includes(skill);
}

/** The bundled skills (always available): the verification skill. Installed skills come from `install.ts`. */
export const BUNDLED_SKILLS: readonly BundledSkill[] = [SELFTEST_SKILL];

/** Runs one allow-listed skill for one call. The default runs it in the sandbox (#42). */
export type SkillRunner = (
  skill: BundledSkill,
  input: Record<string, unknown>,
  scope: ToolScope,
) => Promise<SkillResult>;

export type SkillLimits = { timeoutMs: number; maxOutputBytes: number; maxRssBytes: number };
export const DEFAULT_SKILL_LIMITS: SkillLimits = {
  timeoutMs: 10_000,
  maxOutputBytes: 256 * 1024,
  maxRssBytes: 256 * 1024 * 1024,
};

/** TLS roots for python skills (a standalone python has none of its own). */
export const SYSTEM_CA_BUNDLE = "/private/etc/ssl/cert.pem";

/** Why a call did not run (or did not succeed). Codes only — the model sees them, the log keeps them. */
export class SkillRefused extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export type SkillPolicyContext = {
  /** Absolute path of the node executable (bundled node skills). */
  node: string;
  python?: PythonRuntime | undefined;
  /** Secret values by env name; a skill gets only the ones it declares, when the call needs them. */
  secrets?: Readonly<Record<string, string>> | undefined;
  /** The skill's own egress proxy (only for skills with hosts). */
  proxy?: { url: string; port: number } | undefined;
};

/**
 * Every refusal of `skillPolicy` that does not need the egress proxy: bad arguments, a missing secret, a networked
 * node skill, no python. The runner calls it before it prepares the proxy (#135), so a refused call starts none.
 * Returns the arguments and the secret environment.
 */
export function skillPrecheck(
  skill: BundledSkill,
  input: Record<string, unknown>,
  ctx: Omit<SkillPolicyContext, "proxy">,
): { args: string[]; env: Record<string, string>; secretValues: string[] } {
  const args = skill.args(input);
  if (!args || args.some((a) => typeof a !== "string" || a.includes("\0")))
    throw new SkillRefused("skill_bad_input");
  const env: Record<string, string> = {};
  const secretValues: string[] = [];
  for (const s of skill.secrets) {
    if (s.when && !s.when(input)) continue;
    const v = ctx.secrets?.[s.env];
    if (!v) throw new SkillRefused("skill_unconfigured");
    env[s.env] = v;
    secretValues.push(v);
  }
  // A node skill's fetch follows redirects and nothing here can refuse them: a networked node skill would send
  // requests the server never checked (#129). None exists; one is refused until it has its own guard.
  if (skill.kind === "node" && skill.hosts.length) throw new SkillRefused("skill_unavailable");
  if (skill.kind !== "node" && !ctx.python) throw new SkillRefused("skill_unavailable");
  return { args, env, secretValues };
}

/**
 * Sandbox policy of one skill call. Every skill reads its own folder only; node is readable as the executable
 * (`process-exec` literal), nothing else of its install; a python skill also reads the interpreter's own install
 * folder. Nothing is written, no child processes, no inherited environment. Network: none, or the skill's own
 * egress proxy (a loopback port) that lets through HTTPS to the skill's hosts only. Secrets are env variables of
 * this process only. Arguments come from the definition's `args` (validated input), never from the model as text.
 */
export function skillPolicy(
  skill: BundledSkill,
  input: Record<string, unknown>,
  ctx: SkillPolicyContext,
): Omit<RunIsolatedOptions, "timeoutMs" | "maxOutputBytes" | "maxRssBytes"> & { secretValues: string[] } {
  const { args, env, secretValues } = skillPrecheck(skill, input, ctx);
  let network: RunIsolatedOptions["network"] = "none";
  if (skill.hosts.length) {
    if (!ctx.proxy) throw new SkillRefused("skill_unavailable");
    network = { loopbackPorts: [ctx.proxy.port] };
    env.HTTPS_PROXY = env.https_proxy = ctx.proxy.url;
  }
  if (skill.kind === "node") {
    return {
      command: ctx.node,
      args: [skill.entry, ...args],
      cwd: skill.dir,
      env,
      read: [skill.dir],
      trusted: [],
      write: [],
      network,
      secretValues,
    };
  }
  if (!ctx.python) throw new SkillRefused("skill_unavailable");
  // -I: no PYTHON* variables, no user site, no script folder on sys.path. -S: no site-packages (standard library
  // only). -B: writes no .pyc (it could not anyway).
  Object.assign(env, { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" });
  if (skill.hosts.length) env.SSL_CERT_FILE = SYSTEM_CA_BUNDLE;
  return {
    command: ctx.python.exe,
    // Every networked python skill runs under the network boot, as a tool and as a web_search provider (#113 round
    // 3, #129): urllib's redirects refused, and every request asked for on fd 3 before it is sent (`skillSendGate`).
    args: ["-I", "-S", "-B", ...(skill.hosts.length ? ["-c", SKILL_NET_BOOT] : []), skill.entry, ...args],
    cwd: skill.dir,
    env,
    read: [skill.dir],
    trusted: [ctx.python.root, ...(skill.hosts.length ? [SYSTEM_CA_BUNDLE] : [])],
    write: [],
    network,
    secretValues,
  };
}

/** Why a networked skill call failed: a request it was about to send carried a secret (#129). The log's code. */
export const SKILL_SECRET_BLOCKED = "skill_secret_blocked";

/** Requests one skill call may send at most (each one asked for on the gate); beyond it every send is refused. */
export const SKILL_SENDS_MAX = 16;

/** One request the network boot is about to send: the connection's host and the exact bytes (Latin-1 text). */
const SendRequest = z.strictObject({ host: z.string().min(1).max(253), data: z.string() });

/**
 * The per-send approval of one networked skill call (#129, the finance raw approach for skills): the network boot
 * hands over every request exactly as it goes on the wire — after the script composed and urllib encoded it, the
 * request line, every header, the body; and the proxy CONNECT — and sends it only on `true`.
 * - the connection's host must be one of the skill's hosts;
 * - the skill's own declared secret is allowed at its declared place only: the first exact `param=<value>` pair of
 *   the request target, on its declared host (Alpha Vantage `apikey=`) — once, like finance's DART exception;
 * - everything else is checked by the one egress predicate (`carriesSecret`, incl. the UTF-8 view of the bytes)
 *   against the registry and every `.env` skill secret.
 * A refusal is final for the call (`denied`): every later send is refused too. `deny()` records a failure of the
 * gate itself (an over-long request line, an fd 3 error — `serveGate`) as the same refusal (#135).
 */
export function skillSendGate(
  skill: Pick<BundledSkill, "hosts" | "secrets">,
  input: Record<string, unknown>,
  secrets?: Readonly<Record<string, string>>,
): { approve(line: string): boolean; deny(): void; readonly denied: boolean; readonly sends: number } {
  const hosts = new Set(skill.hosts.map((h) => h.toLowerCase()));
  const config = Object.values(secrets ?? {});
  const places = skill.secrets.flatMap((s) => {
    const v = secrets?.[s.env];
    return s.place && v && (!s.when || s.when(input)) ? [{ ...s.place, value: v }] : [];
  });
  let denied = false;
  let sends = 0;
  const check = (line: string): boolean => {
    if (++sends > SKILL_SENDS_MAX) return false;
    const req = SendRequest.safeParse(JSON.parse(line));
    if (!req.success) return false;
    const host = req.data.host.toLowerCase();
    if (!hosts.has(host)) return false;
    let data = req.data.data;
    const eol = data.indexOf("\r\n");
    const first = eol < 0 ? data : data.slice(0, eol);
    const m = /^([A-Z]+) (\S+) (HTTP\/1\.[01])$/.exec(first);
    if (!m) return false;
    let target = m[2]!;
    for (const p of places.filter((x) => x.host === host)) {
      const removed = withoutParam(target, p.param, p.value);
      target = removed !== target ? removed : withoutParam(target, p.param, pythonQuote(p.value));
    }
    data = `${m[1]} ${target} ${m[3]}${eol < 0 ? "" : data.slice(eol)}`;
    return !carriesSecret([data], { config });
  };
  return {
    approve(line) {
      if (denied) return false;
      let ok: boolean;
      try {
        ok = check(line);
      } catch {
        ok = false;
      }
      if (!ok) denied = true;
      return ok;
    },
    deny() {
      denied = true;
    },
    get denied() {
      return denied;
    },
    get sends() {
      return sends;
    },
  };
}

/** A value as python's `urlencode` (quote_plus) writes it: `encodeURIComponent` plus `!'()*` escaped. */
function pythonQuote(v: string): string {
  return encodeURIComponent(v)
    .replace(/%20/g, "+")
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The network boot of every networked python skill (#113, #129), run as `python -I -S -B -c <boot> <script> …`:
 * - urllib's redirects are refused: the redirect handler's `redirect_request` — which every opener, the default
 *   one and any the script builds, goes through — raises an `HTTPError` instead of building the next request;
 * - every request is approved before it is sent: `http.client.HTTPConnection.send` (urllib's and any direct
 *   http.client use, the proxy CONNECT included) first writes `{"host", "data"}` — the bytes about to go out — as
 *   one JSON line to fd 3 and reads the verdict; anything but `1` (or a missing fd 3) raises `ConnectionError`,
 *   which urllib reports as a `URLError` the script handles like any network failure.
 * Installed before the script runs; the original `send` is reachable only through the closure. Nothing else
 * changes: same flags, same `__main__`, same exit code.
 */
export const SKILL_NET_BOOT = [
  "import http.client, json, os, runpy, sys, urllib.error, urllib.request",
  "def _refuse(self, req, fp, code, msg, headers, newurl):",
  "    raise urllib.error.HTTPError(req.full_url, code, 'redirect not followed', headers, fp)",
  "urllib.request.HTTPRedirectHandler.redirect_request = _refuse",
  "urllib.request.install_opener(urllib.request.build_opener())",
  "def _gated(send):",
  "    def ask(line):",
  "        while line:",
  "            line = line[os.write(3, line):]",
  "        got = b''",
  "        while not got.endswith(b'\\n') and len(got) < 4:",
  "            more = os.read(3, 4 - len(got))",
  "            if not more:",
  "                break",
  "            got += more",
  "        return got == b'1\\n'",
  "    def guarded(self, data):",
  "        if not isinstance(data, (bytes, bytearray)):",
  "            raise ConnectionError('send refused')",
  "        host = getattr(self, '_tunnel_host', None) or self.host",
  "        line = (json.dumps({'host': host, 'data': bytes(data).decode('latin-1')}) + '\\n').encode()",
  "        try:",
  "            ok = ask(line)",
  "        except OSError:",
  "            ok = False",
  "        if not ok:",
  "            raise ConnectionError('send refused')",
  "        return send(self, data)",
  "    return guarded",
  "http.client.HTTPConnection.send = _gated(http.client.HTTPConnection.send)",
  "del _gated",
  "sys.argv = sys.argv[1:]",
  "runpy.run_path(sys.argv[0], run_name='__main__')",
].join("\n");

export type SandboxedRunnerOptions = {
  limits?: SkillLimits;
  python?: PythonRuntime | undefined;
  secrets?: Readonly<Record<string, string>> | undefined;
  /** The egress proxy of a skill with hosts (one per skill: each reaches only its own hosts). */
  proxy?: (skill: BundledSkill) => Promise<{ url: string; port: number }>;
  node?: string;
};

/** Runs a skill under `skillPolicy`. Input on stdin as JSON, a JSON result on stdout; secrets never come back. */
export function sandboxedSkillRunner(o: SandboxedRunnerOptions = {}): SkillRunner {
  const node = o.node ?? fs.realpathSync(process.execPath);
  const limits = o.limits ?? DEFAULT_SKILL_LIMITS;
  return async (skill, input) => {
    // Order (#135): every check that needs no proxy first — the pinned copy (install.ts), the policy's refusals,
    // the send gate — and only then the skill's egress proxy, so a refused call never starts one.
    // An installed skill runs only from its pinned copy, checked again before each run (install.ts).
    if (skill.verify && !skill.verify()) return { ok: false, code: "skill_changed" };
    let policy;
    try {
      skillPrecheck(skill, input, { node, python: o.python, secrets: o.secrets });
    } catch (e) {
      return { ok: false, code: e instanceof SkillRefused ? e.code : "skill_unavailable" };
    }
    // A networked skill asks for each request on fd 3 before it sends it (#129).
    const gate = skill.hosts.length ? skillSendGate(skill, input, o.secrets) : undefined;
    try {
      const proxy = skill.hosts.length && o.proxy ? await o.proxy(skill) : undefined;
      policy = skillPolicy(skill, input, { node, python: o.python, secrets: o.secrets, proxy });
    } catch (e) {
      return { ok: false, code: e instanceof SkillRefused ? e.code : "skill_unavailable" };
    }
    const { secretValues, ...run } = policy;
    let r;
    try {
      r = await runIsolated({
        ...run,
        stdin: JSON.stringify(input),
        ...limits,
        timeoutMs: skill.timeoutMs ?? limits.timeoutMs,
        // A gate failure (over-long line, fd 3 error) is a refusal: the same `skill_secret_blocked` (#135).
        ...(gate ? { gate: (line: string) => gate.approve(line), gateFailed: () => gate.deny() } : {}),
      });
    } catch {
      return { ok: false, code: "skill_unavailable" }; // no sandbox here (not macOS), hard links, spawn failure
    }
    // A refused send decides the outcome, whatever the script printed after its request failed.
    if (gate?.denied) return { ok: false, code: SKILL_SECRET_BLOCKED };
    if (r.killed === "timeout") return { ok: false, code: "skill_timeout" };
    if (r.killed) return { ok: false, code: "skill_limit" };
    if (r.code === null || !(skill.okExitCodes ?? [0]).includes(r.code) || !r.stdout.trim())
      return { ok: false, code: "skill_failed" };
    // A skill must never hand a secret back to the model (an API echoing its key, a debug print): its own
    // secrets exactly (refused if any is left), then every other secret the server knows (review round 23).
    const res = redactOutput(r.stdout, secretValues);
    return res.ok ? { ok: true, output: scrubKnownDeep(res.output) } : res;
  };
}

const REDACTED = "[redacted]";

/** Replaces every occurrence of a secret in one string. */
const scrub = (t: string, secrets: readonly string[]) => {
  let out = t;
  for (const v of secrets) out = out.split(v).join(REDACTED);
  return out;
};

/** Every string value and object key, recursively, with secrets replaced (after JSON escapes were decoded). */
export function redactValue(v: unknown, secrets: readonly string[]): unknown {
  if (typeof v === "string") return scrub(v, secrets);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, secrets));
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [
        scrub(k, secrets),
        redactValue(x, secrets),
      ]),
    );
  return v;
}

/**
 * A skill's stdout as its result, with no secret left in it. The raw text is scrubbed first (non-JSON output
 * never gets back anyway: it is refused), then — because JSON escapes such as `\u0041` or `\"` can spell a
 * secret the raw text does not contain — every decoded string and key is scrubbed again. A result that still
 * contains a secret after that is refused, not returned.
 */
export function redactOutput(stdout: string, secrets: readonly string[]): SkillResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(scrub(stdout, secrets));
  } catch {
    return { ok: false, code: "skill_bad_output" };
  }
  if (!secrets.length) return { ok: true, output: parsed };
  const output = redactValue(parsed, secrets);
  // Last check on the decoded strings themselves (not their JSON form, which escapes quotes): a replacement can
  // recreate a secret from its surroundings (e.g. secret `redacted]"` next to the `[redacted]` marker).
  // Also the serialised form: number normalisation can produce a secret (`1.2345678e7` → `12345678`).
  const text = JSON.stringify(output);
  if (containsSecret(output, secrets) || secrets.some((v) => text.includes(v)))
    return { ok: false, code: "skill_bad_output" };
  return { ok: true, output };
}

/** True if any string value or object key, at any depth, still contains a secret. */
function containsSecret(v: unknown, secrets: readonly string[]): boolean {
  const stack: unknown[] = [v];
  while (stack.length) {
    const x = stack.pop();
    if (typeof x === "string" || typeof x === "number") {
      const t = String(x);
      if (secrets.some((s) => t.includes(s))) return true;
    } else if (Array.isArray(x)) {
      for (const item of x) stack.push(item); // (no spread: a huge array would overflow the call stack)
    } else if (x && typeof x === "object")
      for (const [k, val] of Object.entries(x)) {
        if (secrets.some((s) => k.includes(s))) return true;
        stack.push(val);
      }
  }
  return false;
}

/** The decoy query (one constant for the watchlist search and web_search — secrets/egress.ts). */
export { SEARCH_DECOY };

/** Sources `sources_list` returns at most (the newest). */
const SOURCES_LIST_MAX = 100;

/** What the model is told per citation status (fixed words). */
const CITE_HINT: Record<string, string> = {
  verified: "The passage is in the stored page. Put the marker at the end of the sentence it supports.",
  snippet_not_found:
    "The passage is not in the stored page text. Copy a passage exactly from the page and cite again; otherwise the user sees this citation with a warning.",
  fetch_failed:
    "This source has no stored page text (a search result or an unreadable page). Read the page with web_fetch and cite that sourceId; otherwise the user sees this citation with a warning.",
  unknown_source:
    "Not a source of this conversation. Use a sourceId from web_fetch or sources_list; otherwise the user sees this citation with a warning.",
};

/** What the model is told per file citation status (#48, fixed words). */
const FILE_CITE_HINT: Record<string, string> = {
  verified:
    "The passage is in the file. Put the marker at the end of the sentence it supports; the user sees the file name and this place.",
  snippet_not_found:
    "The passage is not in the file's text. Copy a passage exactly from what file_read or file_search returned and cite again; otherwise the user sees this citation with a warning.",
  fetch_failed:
    "This file's text could not be read (see its extract status in file_list). Do not state its content as cited; otherwise the user sees this citation with a warning.",
  unknown_source:
    "Not a file of this conversation. Use a fileId from file_list; otherwise the user sees this citation with a warning.",
};

/** At most this many skill processes at once — in total and per run. Beyond that a call is refused at once. */
export type SkillConcurrency = { total: number; perRun: number };
export const DEFAULT_SKILL_CONCURRENCY: SkillConcurrency = { total: 4, perRun: 2 };

export type McpServiceOptions = {
  concurrency?: SkillConcurrency;
  /** Allow-list of skills offered as tools. Default: the bundled ones (app.ts adds the installed ones). */
  skills?: readonly BundledSkill[];
  /** Install state of each wrapped skill (for the admin's skill list). */
  installed?: Readonly<Record<string, InstallState>>;
  /** The python for python skills. Without it they are not offered. */
  python?: PythonRuntime | undefined;
  /** Secret values by env name (from `.env`), handed to the skills that declare them. Never logged. */
  secrets?: Readonly<Record<string, string>>;
  limits?: SkillLimits;
  /** Egress proxy per skill (tests). Default: an `EgressService` for the skill's hosts. */
  egress?: (allow: readonly string[]) => Pick<EgressService, "endpoint" | "close">;
  runSkill?: SkillRunner;
  now?: () => Date;
  timeZone?: string;
  /** Structured log (#46): one `skill.finished` per call — tool name, outcome code, duration, IDs. No content. */
  log?: EventLogger;
  /** Web search and fetch (#50). Without it the web tools are not offered (tests without a database). */
  web?: WebOptions;
  /** Artifact storage (#27). Without it the artifact tools are not offered. */
  artifacts?: ArtifactStore;
  /** Document generation (#49). Without it `doc_create` is not offered. */
  docs?: DocGenService;
  /**
   * `python_run` (#47). Without it the tool is not offered. Per user: the `python-scratchpad` skill permission.
   */
  scratchpad?: PythonScratchpad;
  /**
   * File tools (#48): the run's conversation's uploads, read through their extraction. `citations` adds
   * `file_cite`. Without it the file tools are not offered.
   */
  files?: { tools: FileTools; citations?: CitationStore };
  /** Finance tools (#30). Without it they are not offered. Per user: the owning skill's permission. */
  finance?: FinanceOptions;
  /** 관심 종목 (#31): `watchlist_get` reads the run's user's list. Without it the tool is not offered. */
  watchlist?: WatchlistStore;
  /** Schedule proposals (#55): `schedule_create` stores what it proposes. Without it the tool is not offered. */
  scheduleProposals?: ScheduleProposalStore;
  /** The server allow-list switches (#35). Without it every skill is on. */
  switches?: SkillSwitches;
  /** Recent errors (#46): failed skill calls are recorded (tool name and code only) for the admin screen. */
  errors?: ErrorLog;
};

export type WebOptions = {
  sources: SourceStore;
  /** Citations (#25): with it, `cite` is offered (checked against `sources`). */
  citations?: CitationStore;
  /** Search providers to try in order (`WEB_SEARCH_PROVIDERS`); default duckduckgo, then google-news. */
  providers?: readonly SearchProviderName[];
  /** Tests: the worker (in-process), the page proxy, and ready-made providers instead of `providers`. */
  worker?: WebWorker;
  fetchProxy?: Proxy;
  searchProviders?: readonly SearchProvider[];
};

/** A skill in the admin's list (FR-10.3): the PRD §7 catalogue plus where each one stands on this server. */
export type SkillStatus =
  | Exclude<CatalogueStatus, "implemented" | "tools">
  | "available"
  | "not_installed"
  | "broken"
  | "needs_python"
  // python_run (#47 round 2): off by default, or the dedicated account is missing / its self-check failed.
  | "disabled"
  | "needs_account";
export type SkillOverview = {
  name: string;
  tool: string;
  finance: boolean;
  status: SkillStatus;
  issue?: string;
  /** On the server allow-list (#35). */
  enabled: boolean;
};

/**
 * Our MCP server inside the Agent Lee server process (PRD D7, #43). It listens on a loopback port of its own —
 * never on the public :3000 app — and starts on first use, so tests and runs without tools open no port.
 * Every request is authenticated with a run-scoped token (`McpTokens`), every tool result is dropped when the run
 * ended meanwhile, and each user sees and can call only the skills they are allowed (#21, FR-1.6).
 */
export class McpService {
  private running: Promise<RunningMcpServer> | undefined;
  private closed = false;
  /** Offered skills: allow-listed, installed intact, and runnable here (python skills need python). */
  private readonly skills: readonly BundledSkill[];
  private active = 0;
  private readonly activeByRun = new Map<string, number>();
  private readonly proxies = new Map<string, Pick<EgressService, "endpoint" | "close">>();
  /** Runs whose answered tool calls are being recorded (connection tests, #17). */
  private readonly watched = new Map<string, Set<string>>();
  private readonly runner: SkillRunner;
  /** Web search and fetch (#50), when configured. */
  readonly web: WebService | undefined;
  /** The server's own tools (web, artifacts): every active user has them. */
  private readonly tools: readonly ServerToolInfo[];
  /** Finance tools (#30), when configured: each user gets those of the finance skills they may use. */
  readonly finance: FinanceService | undefined;
  private readonly financeTools: readonly FinanceToolInfo[];
  /** `finance_chart` and `watchlist_get` (#31): offered to a user who may use one of their finance skills. */
  private readonly composedTools: readonly FinanceComposedToolInfo[];
  /** `python_run` (#47), when configured: offered to a user who may use `python-scratchpad`. */
  private readonly pythonTools: readonly PythonToolInfo[];
  /** Whether the tool is usable now (PYTHON_RUN on, interpreter, packages, account, self-check — gated state). */
  private readonly pythonAvailable: () => boolean;

  constructor(
    private readonly tokens: McpTokens,
    private readonly users: Pick<UserStore, "byId">,
    private readonly opts: McpServiceOptions = {},
  ) {
    this.skills = (opts.skills ?? BUNDLED_SKILLS).filter((s) => s.kind !== "python" || opts.python);
    this.runner =
      opts.runSkill ??
      sandboxedSkillRunner({
        ...(opts.limits ? { limits: opts.limits } : {}),
        python: opts.python,
        secrets: opts.secrets,
        proxy: (s) => this.proxyFor(s.name, s.hosts),
      });
    this.web = opts.web ? this.buildWeb(opts.web) : undefined;
    this.tools = [
      ...(this.web
        ? [
            ...(this.web.canSearch ? [WEB_SEARCH_TOOL] : []),
            WEB_FETCH_TOOL,
            SOURCES_LIST_TOOL,
            ...(opts.web?.citations ? [CITE_TOOL] : []),
          ]
        : []),
      ...(opts.artifacts ? ARTIFACT_TOOLS : []),
      ...(opts.scheduleProposals ? [SCHEDULE_CREATE_TOOL] : []),
      ...(opts.docs ? DOC_TOOLS : []),
      ...(opts.files
        ? FILE_TOOLS.filter((t) => t.name !== FILE_CITE_TOOL.name || opts.files?.citations)
        : []),
    ];
    this.finance = opts.finance
      ? new FinanceService(
          opts.finance.worker ?? sandboxedWorker(),
          // One proxy per tool, reaching exactly its hosts (docs/decisions/isolation.md "금융 도구 (#30)").
          (t) => this.proxyFor(`finance:${t.name}`, t.hosts),
          opts.finance,
        )
      : undefined;
    this.financeTools = this.finance ? FINANCE_TOOLS : [];
    this.pythonTools = opts.scratchpad ? PYTHON_TOOLS : [];
    // Whether python_run is offered right now (gated state); cheap, re-checked at each tool list and call.
    this.pythonAvailable = () => this.opts.scratchpad?.state() === "available";
    this.composedTools = [
      ...(this.finance && opts.artifacts ? [FINANCE_CHART_TOOL] : []),
      ...(opts.watchlist ? [WATCHLIST_GET_TOOL] : []),
    ];
    // Our tool names are fixed in code: they may be logged (#46).
    registerToolNames(this.toolNames());
  }

  /**
   * Search providers in the configured order. `google-news` runs the installed google-news-search-skill (news
   * only; leads, not evidence); `duckduckgo` reads its HTML results page through a proxy for that host only.
   */
  private buildWeb(o: WebOptions): WebService {
    const worker = o.worker ?? sandboxedWorker();
    // As a web_search provider the skill runs as it does as a tool: arguments checked, redirects refused
    // (`skillPolicy`, #113 review round 3, #129). A refused redirect is a failed search (`web_search_unavailable`):
    // the next provider is tried.
    const news = this.skills.find((s) => s.name === GOOGLE_NEWS_SKILL.name);
    const providers =
      o.searchProviders ??
      (o.providers ?? ["duckduckgo", "google-news"]).flatMap((name): SearchProvider[] => {
        if (name === "duckduckgo") {
          const proxy = {
            endpoint: () => this.proxyFor("web:duckduckgo", DUCKDUCKGO_HOSTS),
            close: async () => {},
          };
          return [duckDuckGoProvider(worker, proxy)];
        }
        if (name === "google-news" && news)
          return [
            {
              name: "google-news",
              search: async (query, max, scope) => {
                const r = await this.runner(
                  news,
                  { query, maxResults: max, lookbackDays: 30, sort: "relevance" },
                  scope,
                );
                if (!r.ok) return { ok: false, code: "web_search_unavailable" };
                const out = r.output as { ok?: unknown };
                if (out?.ok === false) return { ok: false, code: "web_search_unavailable" };
                return { ok: true, hits: (news.searchHits?.(r.output) ?? []).map((h) => h.hit) };
              },
            },
          ];
        return [];
      });
    return new WebService({
      sources: o.sources,
      providers,
      worker,
      ...(o.fetchProxy ? { fetchProxy: o.fetchProxy } : {}),
    });
  }

  /** Every tool this server offers (without the `mcp__agentlee__` prefix) — for log registration. */
  toolNames(): string[] {
    return toolNames({
      skills: this.skills,
      tools: [...this.tools, ...this.pythonTools, ...this.financeTools, ...this.composedTools],
    });
  }

  /**
   * The tools one user's run gets: echo_time, the web and artifact tools, the finance tools and the skills that
   * user may use (FR-1.6).
   */
  toolNamesFor(userId: string, skills?: readonly string[]): string[] {
    const scope = skills ? { skills } : undefined;
    return toolNames({ skills: this.skillsFor(userId, scope), tools: this.toolsFor(userId, scope) });
  }

  /**
   * Whether a call of this run may use `skill` (#56): the user may (`allows`), and the run's skill scope — a
   * schedule's selection — names it (no scope: any). Checked for the tool list and again at every call.
   */
  private mayUse(scope: Pick<ToolScope, "userId" | "skills">, skill: string): boolean {
    return this.allows(scope.userId, skill) && (!scope.skills || scope.skills.includes(skill));
  }

  private mayUseAny(scope: Pick<ToolScope, "userId" | "skills">, skills: readonly string[]): boolean {
    return skills.some((s) => this.mayUse(scope, s));
  }

  /**
   * Whether this user may use this skill now: active, and the skill always on, or on the server allow-list (#35)
   * and allowed by their permissions (`skillPermitted`: youth accounts without finance under "all").
   */
  allows(userId: string, skill: string): boolean {
    const u = this.users.byId(userId);
    if (!u?.active) return false;
    if (ALWAYS_ON_SKILLS.has(skill)) return true;
    if (this.opts.switches && !this.opts.switches.enabled(skill)) return false;
    return skillPermitted(u, skill);
  }

  /** Turns a catalogue skill on or off on the server allow-list (#35); applies from the next tool list / call. */
  setServerEnabled(skill: string, enabled: boolean): void {
    this.opts.switches?.set(skill, enabled);
  }

  /** The server allow-list switch of a skill (#35). */
  serverEnabled(skill: string): boolean {
    return ALWAYS_ON_SKILLS.has(skill) || (this.opts.switches?.enabled(skill) ?? true);
  }

  private toolsFor(userId: string, scope?: Pick<ToolScope, "skills">): ServerToolInfo[] {
    const s = { userId, skills: scope?.skills };
    return [
      ...this.tools,
      ...(this.pythonAvailable() ? this.pythonTools.filter((t) => this.mayUse(s, t.skill)) : []),
      ...this.financeTools.filter((t) => this.mayUse(s, t.skill)),
      ...this.composedTools.filter((t) => this.mayUseAny(s, t.skills)),
    ];
  }

  /** Whether this user may use at least one of these skills now (`allows`). */
  allowsAny(userId: string, skills: readonly string[]): boolean {
    return skills.some((s) => this.allows(userId, s));
  }

  private skillsFor(userId: string, scope?: Pick<ToolScope, "skills">): BundledSkill[] {
    return this.skills.filter((s) => this.mayUse({ userId, skills: scope?.skills }, s.name));
  }

  /** The PRD §7 catalogue with each skill's state here (the admin screen is #35). */
  overview(): SkillOverview[] {
    const offered = new Set(this.skills.map((s) => s.name));
    return SKILL_CATALOGUE.map((e) => {
      let status: SkillStatus;
      if (this.finance && FINANCE_TOOLS.some((t) => t.skill === e.name)) status = "available";
      else if (e.name === PYTHON_SKILL && this.opts.scratchpad) {
        const st = this.opts.scratchpad.state();
        status = st === "available" ? "available" : st;
      } else if (e.status === "tools") status = "planned";
      else if (e.status === "implemented") {
        const st = this.opts.installed?.[e.name] ?? "not_installed";
        status = offered.has(e.name) ? "available" : st === "installed" ? "needs_python" : st;
      } else status = e.status;
      return {
        name: e.name,
        tool: skillToolName(e.name),
        finance: e.finance,
        status,
        ...(e.issue ? { issue: e.issue } : {}),
        enabled: this.serverEnabled(e.name),
      };
    });
  }

  /** One egress proxy per key (a skill, or a search provider), reaching only its own hosts. */
  private proxyFor(key: string, hosts: readonly string[]) {
    let p = this.proxies.get(key);
    if (!p) {
      p = (this.opts.egress ?? ((allow) => new EgressService({ allow })))(hosts);
      this.proxies.set(key, p);
    }
    return p.endpoint();
  }

  private host(): McpHost {
    const runSkill = this.runner;
    const toolByName = new Map(this.tools.map((t) => [t.name, t]));
    const financeByName = new Map(this.financeTools.map((t) => [t.name, t]));
    const composedByName = new Map(this.composedTools.map((t) => [t.name, t]));
    const byName = new Map(this.skills.map((s) => [s.name, s]));
    const now = () => Date.now();
    return {
      authenticate: (token) => {
        const s = this.tokens.verify(token);
        if (!s || !this.users.byId(s.userId)?.active) return undefined;
        return {
          userId: s.userId,
          conversationId: s.conversationId,
          runId: s.runId,
          ...(s.skills ? { skills: s.skills } : {}),
        };
      },
      userName: (id) => {
        const u = this.users.byId(id);
        return u?.active ? u.name : undefined;
      },
      skills: this.skills,
      skillsFor: (userId, scope) => this.skillsFor(userId, scope),
      runSkill: async (name, input, scope) => {
        const t0 = now();
        const r = await this.call(byName.get(name), input, scope, runSkill);
        // The guard's refusal is told to the model as an ordinary failure (no oracle for which value is a secret,
        // #113 round 1); the log and the admin's error list keep why.
        const shown: SkillResult =
          !r.ok && r.code === SKILL_SECRET_BLOCKED ? { ok: false, code: "skill_failed" } : r;
        logEvent(this.opts.log, r.ok ? "info" : "warn", "skill.finished", {
          userId: scope.userId,
          conversationId: scope.conversationId,
          runId: scope.runId,
          tool: skillToolName(name),
          status: r.ok ? "ok" : "error",
          durationMs: now() - t0,
          ...(r.ok ? {} : { skillCode: r.code }),
        });
        // The admin's "스킬 실행 실패" list (FR-10.4): tool name and code only.
        if (!r.ok)
          this.opts.errors?.record({
            source: "tool",
            code: r.code,
            category: "tool",
            tool: skillToolName(name),
            userId: scope.userId,
            conversationId: scope.conversationId,
            runId: scope.runId,
          });
        return shown;
      },
      onToolCall: (tool, scope, ok) => {
        if (ok) this.watched.get(scope.runId)?.add(tool);
      },
      tools: [...this.tools, ...this.pythonTools, ...this.financeTools, ...this.composedTools],
      toolsFor: (userId, scope) => this.toolsFor(userId, scope),
      runTool: async (name, input, scope) => {
        const t0 = now();
        const composed = composedByName.get(name);
        if (composed) {
          const r =
            composed.name === FINANCE_CHART_TOOL.name
              ? await this.callFinanceChart(input, scope)
              : this.callWatchlist(input, scope);
          logEvent(this.opts.log, r.ok ? "info" : "warn", "finance.finished", {
            userId: scope.userId,
            conversationId: scope.conversationId,
            runId: scope.runId,
            tool: name,
            status: r.ok ? "ok" : "error",
            durationMs: now() - t0,
            ...(r.ok ? {} : { financeCode: r.code }),
          });
          if (!r.ok)
            this.opts.errors?.record({
              source: "tool",
              code: r.code,
              category: "tool",
              tool: name,
              userId: scope.userId,
              conversationId: scope.conversationId,
              runId: scope.runId,
            });
          return r;
        }
        const fin = financeByName.get(name);
        if (fin) {
          const r = await this.callFinanceTool(fin, input, scope);
          logEvent(this.opts.log, r.ok ? "info" : "warn", "finance.finished", {
            userId: scope.userId,
            conversationId: scope.conversationId,
            runId: scope.runId,
            tool: name,
            status: r.ok ? "ok" : "error",
            durationMs: now() - t0,
            ...(r.ok ? {} : { financeCode: r.code }),
          });
          // Finance tools are skills too (PRD §7): their failures join the admin's skill failure list, by tool name
          // and fixed `finance_*` code only.
          if (!r.ok)
            this.opts.errors?.record({
              source: "tool",
              code: r.code,
              category: "tool",
              tool: name,
              userId: scope.userId,
              conversationId: scope.conversationId,
              runId: scope.runId,
            });
          return r;
        }
        if (name === CITE_TOOL.name || name === SOURCES_LIST_TOOL.name) {
          const r = this.callCitationTool(toolByName.get(name), input, scope);
          const status = r.ok ? (r.output as { status?: unknown }).status : undefined;
          logEvent(this.opts.log, r.ok ? "info" : "warn", "citation.finished", {
            userId: scope.userId,
            conversationId: scope.conversationId,
            runId: scope.runId,
            tool: name,
            status: r.ok ? "ok" : "error",
            durationMs: now() - t0,
            // The fixed outcome only: never the source id, the snippet or the page text.
            ...(r.ok ? (typeof status === "string" ? { citeCode: status } : {}) : { citeCode: r.code }),
          });
          return r;
        }
        if (name === SCHEDULE_CREATE_TOOL.name) {
          const r = this.callScheduleTool(input, scope);
          logEvent(this.opts.log, r.ok ? "info" : "warn", "schedule.proposed", {
            userId: scope.userId,
            conversationId: scope.conversationId,
            runId: scope.runId,
            tool: name,
            status: r.ok ? "ok" : "error",
            durationMs: now() - t0,
            ...(r.ok ? {} : { scheduleCode: r.code }),
          });
          return r;
        }
        if (FILE_TOOLS.some((t) => t.name === name)) {
          const r = await this.callFileTool(toolByName.get(name), input, scope);
          const status = r.ok ? (r.output as { status?: unknown }).status : undefined;
          logEvent(this.opts.log, r.ok ? "info" : "warn", "file.tool_finished", {
            userId: scope.userId,
            conversationId: scope.conversationId,
            runId: scope.runId,
            tool: name,
            status: r.ok ? "ok" : "error",
            durationMs: now() - t0,
            // The fixed outcome only: never the file id, the query, the snippet or the text.
            ...(r.ok
              ? typeof status === "string"
                ? { fileToolCode: status }
                : {}
              : { fileToolCode: r.code }),
          });
          return r;
        }
        if (ARTIFACT_TOOLS.some((t) => t.name === name)) {
          const r = this.callArtifactTool(toolByName.get(name), input, scope);
          logEvent(this.opts.log, r.ok ? "info" : "warn", "artifact.finished", {
            userId: scope.userId,
            conversationId: scope.conversationId,
            runId: scope.runId,
            tool: name,
            status: r.ok ? "ok" : "error",
            durationMs: now() - t0,
            ...(r.ok ? {} : { artifactCode: r.code }),
          });
          return r;
        }
        if (name === PYTHON_RUN_TOOL.name) {
          const r = await this.callPythonTool(input, scope);
          const status = r.ok ? (r.output as { status?: unknown }).status : undefined;
          logEvent(this.opts.log, r.ok ? "info" : "warn", "python.finished", {
            userId: scope.userId,
            conversationId: scope.conversationId,
            runId: scope.runId,
            tool: name,
            status: r.ok ? "ok" : "error",
            durationMs: now() - t0,
            // The fixed outcome only: never the code, its output, the file ids or names.
            pythonCode: r.ok ? (status === "ok" ? "python_ok" : "python_error") : r.code,
          });
          if (!r.ok)
            this.opts.errors?.record({
              source: "tool",
              code: r.code,
              category: "tool",
              tool: name,
              userId: scope.userId,
              conversationId: scope.conversationId,
              runId: scope.runId,
            });
          return r;
        }
        if (name === DOC_CREATE_TOOL.name) {
          const r = await this.callDocTool(input, scope);
          logEvent(this.opts.log, r.ok ? "info" : "warn", "doc.finished", {
            userId: scope.userId,
            conversationId: scope.conversationId,
            runId: scope.runId,
            tool: name,
            status: r.ok ? "ok" : "error",
            durationMs: now() - t0,
            // The fixed outcome and the format only: never the title, the blocks or the file name.
            docCode: r.ok ? "doc_ok" : r.code,
            ...(typeof input.kind === "string" ? { docKind: input.kind } : {}),
          });
          return r;
        }
        const r = await this.callTool(toolByName.get(name), input, scope);
        logEvent(this.opts.log, r.ok ? "info" : "warn", "web.finished", {
          userId: scope.userId,
          conversationId: scope.conversationId,
          runId: scope.runId,
          tool: name,
          status: r.ok ? "ok" : "error",
          durationMs: now() - t0,
          // The guard's refusal is told to the model as an ordinary failure; only the log says why (#113).
          ...(blockedByEgress(r) ? { webCode: "web_secret_blocked" } : r.ok ? {} : { webCode: r.code }),
        });
        return r;
      },
      ...(this.opts.now ? { now: this.opts.now } : {}),
      ...(this.opts.timeZone ? { timeZone: this.opts.timeZone } : {}),
    };
  }

  /**
   * An artifact tool call: active user, strict input, then the store — which writes only into the token's own
   * conversation, after checking that the token's user owns it. Content is never logged or echoed back.
   */
  private callArtifactTool(
    tool: ServerToolInfo | undefined,
    input: Record<string, unknown>,
    scope: ToolScope,
  ): SkillResult {
    const store = this.opts.artifacts;
    if (!tool || !store || !this.users.byId(scope.userId)?.active)
      return { ok: false, code: "artifact_not_allowed" };
    const parsed = z.strictObject(tool.input).safeParse(input);
    if (!parsed.success) {
      // Too long a content is its own code (the model should split or shorten, not fix a field).
      const long = parsed.error.issues.some((i) => i.code === "too_big" && i.path[0] === "content");
      return { ok: false, code: long ? "artifact_too_large" : "artifact_bad_input" };
    }
    const data = parsed.data as ArtifactBody & {
      kind?: ArtifactKind;
      title?: string;
      artifactId?: string;
      version?: number;
      offset?: number;
    };
    try {
      if (tool.name === ARTIFACT_READ_TOOL.name) return artifactRead(store, scope, data);
      const { artifact, version } =
        tool.name === ARTIFACT_CREATE_TOOL.name
          ? store.create(scope, { ...data, kind: data.kind!, title: data.title })
          : tool.name === ARTIFACT_UPDATE_TOOL.name
            ? store.update(scope, data.artifactId!, data)
            : (() => {
                throw new ArtifactError("artifact_not_allowed");
              })();
      return {
        ok: true,
        output: {
          artifactId: artifact.id,
          kind: artifact.kind,
          title: artifact.title,
          version: version.version,
          url: artifactPath(artifact.id),
        },
      };
    } catch (e) {
      if (e instanceof ArtifactError) return { ok: false, code: e.code };
      throw e;
    }
  }

  /**
   * `schedule_create` (#55, FR-8.1): checks the proposal like `POST /api/schedules` would (strict input, skills from
   * the catalogue that this user may use, a timing with a next occurrence) and stores it for the token's own
   * conversation — after checking that the token's user owns it. Nothing is scheduled: the user confirms the card.
   */
  private callScheduleTool(input: Record<string, unknown>, scope: ToolScope): SkillResult {
    const store = this.opts.scheduleProposals;
    if (!store || !this.users.byId(scope.userId)?.active) return { ok: false, code: "schedule_not_allowed" };
    if (!store.ownsConversation(scope)) return { ok: false, code: "schedule_not_allowed" };
    const parsed = ScheduleProposalInput.safeParse(input);
    if (!parsed.success) return { ok: false, code: "schedule_bad_input" };
    const p = parsed.data;
    const catalogue = new Set(this.overview().map((s) => s.name));
    if (p.skills.some((s) => !catalogue.has(s) || !this.allows(scope.userId, s)))
      return { ok: false, code: "skill_not_allowed" };
    const at = (this.opts.now?.() ?? new Date()).getTime();
    let nextRunAt: number;
    try {
      nextRunAt = firstRunAfter(p.timing, p.timeZone, at);
    } catch (e) {
      if (e instanceof ScheduleInputError) return { ok: false, code: e.code };
      throw e;
    }
    const row = store.create(scope, { ...p, skills: [...new Set(p.skills)] }, at);
    const output: ScheduleProposalToolOutput = {
      proposalId: row.id,
      status: "proposed",
      nextRunAt,
      note: "Not created yet: the user sees a confirmation card and the schedule is created only if they confirm it there. Tell them to check the card; do not say it was created.",
    };
    return { ok: true, output };
  }

  /**
   * `doc_create` (#49): active user, then a process slot like a skill (the document is made by a sandboxed worker),
   * then the service — which checks the input, writes only into the token's own conversation after checking that
   * the token's user owns it, and links the file to the run's reply. Content is never logged.
   */
  private async callDocTool(input: Record<string, unknown>, scope: ToolScope): Promise<SkillResult> {
    const docs = this.opts.docs;
    if (!docs || !this.users.byId(scope.userId)?.active) return { ok: false, code: "doc_not_allowed" };
    return (await this.withSlot(scope, () => docs.create(scope, input))) ?? { ok: false, code: "doc_busy" };
  }

  /**
   * `python_run` (#47): active user who may use `python-scratchpad` (checked again here — the permission or the
   * run's skill scope can change while a run is going), then a process slot like a skill, then the service — which
   * checks the input, reads only the token's own conversation's files and writes only into it after checking that the
   * token's user owns it. Code and output are never logged.
   */
  private async callPythonTool(input: Record<string, unknown>, scope: ToolScope): Promise<SkillResult> {
    const pad = this.opts.scratchpad;
    if (!pad || !this.mayUse(scope, PYTHON_SKILL)) return { ok: false, code: "python_not_allowed" };
    return (await this.withSlot(scope, () => pad.run(scope, input))) ?? { ok: false, code: "python_busy" };
  }

  /**
   * A file tool call (#48): active user, strict input, then the file tools — which read only the token's own
   * conversation's files, after checking that the token's user owns it (the #22 rules). File names and text go
   * back inside `<external_content>` blocks.
   */
  private async callFileTool(
    tool: ServerToolInfo | undefined,
    input: Record<string, unknown>,
    scope: ToolScope,
  ): Promise<SkillResult> {
    const files = this.opts.files;
    if (!tool || !files || !this.users.byId(scope.userId)?.active)
      return { ok: false, code: "file_not_allowed" };
    const parsed = z.strictObject(tool.input).safeParse(input);
    if (!parsed.success) return { ok: false, code: "file_bad_input" };
    const d = parsed.data as {
      fileId?: string;
      from?: number;
      to?: number;
      sheet?: string;
      cursor?: string;
      query?: string;
      maxResults?: number;
      snippet?: string;
      page?: number;
    };
    if (tool.name === FILE_LIST_TOOL.name) return files.tools.list(scope);
    if (tool.name === FILE_READ_TOOL.name)
      return files.tools.read(scope, {
        fileId: d.fileId!,
        from: d.from,
        to: d.to,
        sheet: d.sheet,
        cursor: d.cursor,
      });
    if (tool.name === FILE_SEARCH_TOOL.name)
      return files.tools.search(scope, { query: d.query!, fileId: d.fileId, maxResults: d.maxResults });
    if (tool.name !== FILE_CITE_TOOL.name || !files.citations) return { ok: false, code: "file_not_allowed" };
    const file = files.tools.fileFor(scope, d.fileId!);
    // Looked for before the citation is numbered (an extraction still running is waited for, bounded).
    const found = file ? await files.tools.check(file, d.snippet!, d.page) : undefined;
    try {
      const r = files.citations.citeFile(
        scope,
        { fileId: file?.id ?? null, snippet: d.snippet! },
        () => found!,
      );
      // The model's view of the place: a sheet by id, never its name (file text, review #107).
      const where = r.locator && file ? files.tools.modelLocator(r.locator) : undefined;
      return {
        ok: true,
        // Through the secrets known now, like every file tool output (review #107).
        output: scrubKnownDeep(
          {
            n: r.n,
            marker: r.marker,
            status: r.status,
            fileId: file?.id ?? null,
            ...(where ? { locator: where.locator, label: where.label } : {}),
            hint: FILE_CITE_HINT[r.status],
          },
          { tail: false },
        ),
      };
    } catch (e) {
      if (e instanceof CiteRefused) return { ok: false, code: e.code };
      throw e;
    }
  }

  /**
   * `cite` and `sources_list` (#25): active user, strict input, then the stores — which read and write only the
   * token's own conversation, after checking that the token's user owns it. Page titles reach the model inside an
   * `<external_content>` block (they are page text).
   */
  private callCitationTool(
    tool: ServerToolInfo | undefined,
    input: Record<string, unknown>,
    scope: ToolScope,
  ): SkillResult {
    const web = this.opts.web;
    if (!tool || !web || !this.users.byId(scope.userId)?.active)
      return { ok: false, code: "cite_not_allowed" };
    const parsed = z.strictObject(tool.input).safeParse(input);
    if (!parsed.success) return { ok: false, code: "cite_bad_input" };
    if (tool.name === SOURCES_LIST_TOOL.name) {
      const rows = web.sources.listFor(scope);
      if (!rows) return { ok: false, code: "cite_not_allowed" };
      const items = rows.slice(-SOURCES_LIST_MAX);
      return {
        ok: true,
        output: {
          items: items.map((r, i) => ({
            n: i + 1,
            sourceId: r.id,
            kind: r.kind,
            site: r.site,
            publishedAt: r.publishedAt ?? null,
            url: r.finalUrl ?? r.url,
            hasText: r.kind === "page" && !!r.body,
          })),
          content: frameExternal({
            source: "sources",
            content: items.map((r, i) => `[${i + 1}] ${r.title}`).join("\n") || "(no sources)",
          }),
        },
      };
    }
    if (!web.citations) return { ok: false, code: "cite_not_allowed" };
    const data = parsed.data as { sourceId: string; snippet: string };
    try {
      const r = web.citations.cite(scope, data);
      const src = r.sourceId ? web.sources.get(scope.conversationId, r.sourceId) : undefined;
      return {
        ok: true,
        output: {
          ...r,
          ...(src
            ? { site: src.site, url: src.finalUrl ?? src.url, publishedAt: src.publishedAt ?? null }
            : {}),
          hint: CITE_HINT[r.status],
        },
      };
    } catch (e) {
      if (e instanceof CiteRefused) return { ok: false, code: e.code };
      throw e;
    }
  }

  /**
   * A finance tool call: the user may use its skill (checked again: a permission can change during a run), strict
   * input, a process slot like a skill, then the finance service. Input and output are never logged.
   */
  private async callFinanceTool(
    tool: FinanceToolInfo,
    input: Record<string, unknown>,
    scope: ToolScope,
  ): Promise<SkillResult> {
    const finance = this.finance;
    if (!finance || !this.mayUse(scope, tool.skill)) return { ok: false, code: "finance_not_allowed" };
    const parsed = z.strictObject(tool.input).safeParse(input);
    if (!parsed.success) return { ok: false, code: "finance_bad_input" };
    return (
      (await this.withSlot(scope, () => finance.run(tool, parsed.data as Record<string, unknown>))) ?? {
        ok: false,
        code: "finance_busy",
      }
    );
  }

  /**
   * `finance_chart` (#31): the data through the finance tools — each part checked against the user's finance skills
   * (KR → kr-stock-skill, US → us-stock-skill, the exchange rate → kr-stock-skill) — in one process slot, then one
   * computation into a `table` and a `chart` artifact of the token's conversation (the store checks its owner). The
   * result is a finance result like the others (stamped values, `sources`, disclaimer) plus the two artifacts.
   */
  private async callFinanceChart(input: Record<string, unknown>, scope: ToolScope): Promise<SkillResult> {
    const finance = this.finance;
    const store = this.opts.artifacts;
    if (!finance || !store || !this.mayUseAny(scope, FINANCE_CHART_TOOL.skills))
      return { ok: false, code: "finance_not_allowed" };
    const parsed = z.strictObject(FINANCE_CHART_TOOL.input).safeParse(input);
    if (!parsed.success) return { ok: false, code: "finance_bad_input" };
    const data = parsed.data as ChartInput;
    const byName = new Map(FINANCE_TOOLS.map((t) => [t.name, t]));
    const r = await this.withSlot(scope, () =>
      fetchDataset(
        data,
        async (tool, args) => {
          const t = byName.get(tool);
          // Checked again per call: a permission may change during the run.
          if (!t || !this.mayUse(scope, t.skill)) return { ok: false, code: "finance_not_allowed" };
          return finance.run(t, args);
        },
        (skill) => this.mayUse(scope, skill),
        (this.opts.finance?.now ?? Date.now)(),
      ),
    );
    if (!r) return { ok: false, code: "finance_busy" };
    if (!r.ok) return { ok: false, code: r.code };
    const built = buildFinanceArtifacts(r.data, data.title);
    try {
      const table = store.create(scope, { kind: "table", title: built.table.title, table: built.table.data });
      const chart = store.create(scope, { kind: "chart", title: built.chart.title, chart: built.chart.spec });
      const ref = (a: typeof table) => ({
        artifactId: a.artifact.id,
        version: a.version.version,
        url: artifactPath(a.artifact.id),
      });
      return {
        ok: true,
        output: scrubKnownDeep(
          finalize(FINANCE_CHART_TOOL.name, {
            ...built.summary,
            table: { ...ref(table), title: table.artifact.title, rows: built.table.data.rows.length },
            chartArtifact: { ...ref(chart), title: chart.artifact.title },
            shown:
              "The table and the chart are already shown to the user (artifact cards and the table in the answer). Do not repeat the rows; summarise with the labels of sources.",
          }),
        ),
      };
    } catch (e) {
      if (e instanceof ArtifactError) return { ok: false, code: e.code };
      throw e;
    }
  }

  /**
   * `watchlist_get` (#31, FR-7.7): the token's user's own list, only of the markets whose finance skill they may use
   * now. Names are third-party text (the search), framed as external content.
   */
  private callWatchlist(input: Record<string, unknown>, scope: ToolScope): SkillResult {
    const store = this.opts.watchlist;
    if (!store || !this.mayUseAny(scope, WATCHLIST_GET_TOOL.skills))
      return { ok: false, code: "finance_not_allowed" };
    if (!z.strictObject(WATCHLIST_GET_TOOL.input).safeParse(input).success)
      return { ok: false, code: "finance_bad_input" };
    const markets = this.watchMarkets(scope.userId).filter((m) =>
      this.mayUse(scope, m === "KR" ? "kr-stock-skill" : "us-stock-skill"),
    );
    const items = store.list(scope.userId).filter((i) => markets.includes(i.market));
    return {
      ok: true,
      output: scrubKnownDeep({
        tool: WATCHLIST_GET_TOOL.name,
        items: items.map((i) => ({ market: i.market, symbol: i.symbol })),
        names: frameExternal({
          source: "watchlist",
          content: items.map((i) => `${i.symbol}: ${i.name ?? ""}`).join("\n") || "(empty)",
        }),
        count: items.length,
        ...(items.length
          ? {}
          : { hint: "The list is empty: the user adds symbols on the 관심 종목 screen." }),
      }),
    };
  }

  /** Markets this user may use now: KR with kr-stock-skill, US with us-stock-skill (#31). */
  watchMarkets(userId: string): ("KR" | "US")[] {
    return [
      ...(this.allows(userId, "kr-stock-skill") ? (["KR"] as const) : []),
      ...(this.allows(userId, "us-stock-skill") ? (["US"] as const) : []),
    ];
  }

  /**
   * The 관심 종목 search (#31): Korean names and codes through `kr_search` (Naver 증권, its own egress) when the user
   * may use kr-stock-skill; a typed US ticker is offered as it is (there is no US name search). Never throws.
   */
  async searchSymbols(
    userId: string,
    q: string,
  ): Promise<
    | {
        ok: true;
        items: { market: "KR" | "US"; symbol: string; name: string | null; exchange: string | null }[];
      }
    | { ok: false; code: string }
  > {
    const markets = this.watchMarkets(userId);
    if (!markets.length) return { ok: false, code: "finance_not_allowed" };
    const items: { market: "KR" | "US"; symbol: string; name: string | null; exchange: string | null }[] = [];
    // A query that carries a known secret (raw, encoded, cut off) never leaves — and its answer must not tell it
    // apart from any other query (review #111 rounds 2–3): it takes exactly the ordinary path — the same checks, the
    // same process slot, the same worker call and error handling (busy, unreachable, timeout) — with a fixed decoy
    // query in its place, whose hits are dropped. FinanceService checks every outgoing URL again.
    const upper = q.trim().toUpperCase();
    const search = FINANCE_TOOLS.find((t) => t.name === "kr_search");
    // One predicate (review #111 round 4): the egress guard's own decision on the request this query would make
    // (shared matcher + the configured secrets' windows), and on the typed ticker that would be shown back.
    const fin = this.finance;
    const secret =
      scrubKnown(q) !== q ||
      scrubKnown(upper) !== upper ||
      (!!fin && !!search && (fin.refuses(search, { query: q.trim() }) || fin.refusesText(upper)));
    // A typed ticker is offered only when it may be stored (the same single check as adding, review #111).
    if (!secret && markets.includes("US") && watchSymbolOk("US", upper))
      items.push({ market: "US", symbol: upper, name: null, exchange: null });
    if (markets.includes("KR") && this.finance && search) {
      const parsed = z.strictObject(search.input).safeParse({ query: q.trim() });
      if (parsed.success) {
        const scope = { userId, conversationId: "watchlist", runId: `watchlist:${userId}` };
        const input = secret ? { query: SEARCH_DECOY } : parsed.data;
        const r = await this.withSlot(scope, () => this.finance!.run(search, input));
        if (!r) return { ok: false, code: "finance_busy" };
        if (r.ok) {
          const found = secret ? [] : (r.output as { items?: unknown }).items;
          for (const x of Array.isArray(found) ? found : []) {
            const o = x as { code?: unknown; name?: unknown; market?: unknown };
            if (typeof o.code === "string" && /^\d{6}$/.test(o.code))
              items.push({
                market: "KR",
                symbol: o.code,
                name: typeof o.name === "string" ? o.name : null,
                exchange: typeof o.market === "string" ? o.market : null,
              });
          }
        } else if (!items.length) return { ok: false, code: r.code };
      }
    }
    return { ok: true, items: items.slice(0, 11) };
  }

  /** A web tool call: active user, strict input, a process slot like a skill, then the web service. */
  private async callTool(
    tool: ServerToolInfo | undefined,
    input: Record<string, unknown>,
    scope: ToolScope,
  ): Promise<SkillResult> {
    const web = this.web;
    if (!tool || !web || !this.users.byId(scope.userId)?.active)
      return { ok: false, code: "web_not_allowed" };
    const parsed = z.strictObject(tool.input).safeParse(input);
    if (!parsed.success) return { ok: false, code: "web_bad_input" };
    const data = parsed.data as Record<string, unknown>;
    return (
      (await this.withSlot(scope, () =>
        tool.name === WEB_SEARCH_TOOL.name
          ? web.search(data as { query: string; maxResults?: number }, scope)
          : web.fetch(data as { url: string }, scope),
      )) ?? { ok: false, code: "web_busy" }
    );
  }

  /** Runs `fn` in a process slot (total and per run), or returns undefined at once when none is free. */
  private async withSlot<T>(scope: ToolScope, fn: () => Promise<T>): Promise<T | undefined> {
    const limit = this.opts.concurrency ?? DEFAULT_SKILL_CONCURRENCY;
    const mine = this.activeByRun.get(scope.runId) ?? 0;
    if (this.active >= limit.total || mine >= limit.perRun) return undefined;
    this.active++;
    this.activeByRun.set(scope.runId, mine + 1);
    try {
      return await fn();
    } finally {
      this.active--;
      const left = (this.activeByRun.get(scope.runId) ?? 1) - 1;
      if (left > 0) this.activeByRun.set(scope.runId, left);
      else this.activeByRun.delete(scope.runId);
    }
  }

  private async call(
    skill: BundledSkill | undefined,
    input: Record<string, unknown>,
    scope: ToolScope,
    runSkill: SkillRunner,
  ): Promise<SkillResult> {
    // Checked here as well as by the MCP server's tool list: the permission may have changed during the run.
    if (!skill || !this.mayUse(scope, skill.name)) return { ok: false, code: "skill_not_allowed" };
    const parsed = z.strictObject(skill.input).safeParse(input);
    // The schema, then the wrapper's own argument rules (e.g. a code that does not fit the command).
    if (!parsed.success || !skill.args(parsed.data as Record<string, unknown>))
      return { ok: false, code: "skill_bad_input" };
    // Each call is a process: cap them so one batch or one runtime cannot exhaust the machine.
    const r = await this.withSlot(scope, () =>
      runSkill(skill, parsed.data as Record<string, unknown>, scope),
    );
    if (!r) return { ok: false, code: "skill_busy" };
    if (r.ok && skill.searchHits && this.web) this.registerHits(skill, r.output, scope);
    return r;
  }

  /** A search skill's results become sources (#50); each item gets its `sourceId` (null when not stored). */
  private registerHits(skill: BundledSkill, output: unknown, scope: ToolScope): void {
    for (const { item, hit } of skill.searchHits?.(output) ?? [])
      item.sourceId = this.web?.registerHit(skill.name, hit, scope)?.id ?? null;
  }

  /**
   * Records which tools this server successfully answered for `runId` until `stop()` — evidence for the connection
   * test (#17) that the runtime really reached our MCP server, not just that it reported a tool call.
   */
  watch(runId: string): { seen: ReadonlySet<string>; stop(): void } {
    const seen = new Set<string>();
    this.watched.set(runId, seen);
    return { seen, stop: () => void this.watched.delete(runId) };
  }

  /** Whether a start was requested (tests: runtimes without tools must not open the port). */
  get started(): boolean {
    return this.running !== undefined;
  }

  /** Starts the server once (concurrent callers share the start) and returns where it listens. */
  endpoint(): Promise<RunningMcpServer> {
    if (this.closed) return Promise.reject(new Error("mcp service closed"));
    this.running ??= startMcpServer(this.host()).catch((e: unknown) => {
      this.running = undefined; // a failed start can be retried by the next run
      throw e;
    });
    return this.running;
  }

  async close(): Promise<void> {
    this.closed = true;
    const r = await this.running?.catch(() => undefined);
    this.running = undefined;
    await r?.close();
    await Promise.all([...this.proxies.values()].map((p) => p.close()));
    this.proxies.clear();
    await this.web?.close();
  }
}

/**
 * `artifact_read` (#53, FR-3.5): one version of an artifact of the token's own conversation — the store checks that
 * the token's user owns it — so a runtime that did not write it (after a runtime switch, in a fork) can make the next
 * version. The stored text is scrubbed as one string before it is cut into pieces (a secret across JSON syntax or a
 * page end is masked in the whole, so joined pages hold none), title and text go back inside `<external_content>` blocks (artifact content is model
 * or forked text: data, not instructions). Nothing of it is logged.
 */
function artifactRead(
  store: ArtifactStore,
  scope: ToolScope,
  input: { artifactId?: string; version?: number; offset?: number },
): SkillResult {
  const { artifact, version } = store.readFor(scope, input.artifactId!, input.version);
  // The whole stored text through the secrets known now, as one string, before it is cut (#53 review): a secret is
  // masked wherever it is — across JSON syntax or across the place a page ends.
  const text = scrubKnown(version.content);
  const from = Math.min(input.offset ?? 0, text.length);
  let end = Math.min(text.length, from + ARTIFACT_READ_CHARS);
  // Never between the two halves of a surrogate pair.
  if (end < text.length && end > from && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  // No cut-off-tail rule per page (#53 review round 2): the whole was scrubbed above, so no secret is left anywhere in
  // it for pages to put back together — and the rule would mask ordinary text that only looks like a secret's start.
  const page = text.slice(from, end);
  return {
    ok: true,
    output: scrubKnownDeep(
      {
        artifactId: artifact.id,
        kind: artifact.kind,
        version: version.version,
        latestVersion: artifact.latestVersion,
        ...(version.language ? { language: version.language } : {}),
        url: artifactPath(artifact.id),
        chars: text.length,
        offset: from,
        next: end < text.length ? { offset: end } : null,
        title: frameExternal({ source: "artifact-title", content: version.title }),
        content: frameExternal({ source: "artifact", content: page }),
      },
      { tail: false },
    ),
  };
}
