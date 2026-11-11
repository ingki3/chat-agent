import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { SkillInfo } from "./index.js";

/**
 * Skill definitions of the common MCP server (#21, PRD §7, D5). A definition is the wrapper around one installed
 * skill: what the model sees (name, description, input schema), which of the skill's files the server copies into
 * its own skill folder, how the validated input becomes the process's arguments, which hosts it may reach and
 * which secrets it gets. How it runs (sandbox, egress proxy, limits) is the host's business (apps/server mcp).
 *
 * Arguments are never free text in flag position: every value is checked by the schema and passed as one
 * `--flag=value` element (no shell is involved, and `--flag=--other` is a value, not a flag).
 */

/** Folder of the bundled skills (same from src/ and dist/). */
export const SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skills");

/** A secret env variable a skill gets in its own process only — when the call needs it (`when`, default always). */
export type SkillSecret = { env: string; when?: (input: Record<string, unknown>) => boolean };

/** One search result a skill returned, to register as a source (#50). Untrusted text: bounded by the host. */
export type SearchHit = { url: string; title: string; site?: string; publishedAt?: string; snippet?: string };

/** How a skill is started: a node script, or a python script run by the configured self-contained python. */
export type SkillKind = "node" | "python";

export type SkillSpec = SkillInfo & {
  /** A finance skill (PRD FR-7) — hidden from users without finance access, and gets the finance instructions. */
  finance: boolean;
  kind: SkillKind;
  /** Files of the skill (relative, `/`-separated) copied into the server's skill folder; the first is the entry. */
  files: readonly string[];
  /** The arguments after the entry script, built from the validated input. `undefined` refuses the input. */
  args(input: Record<string, unknown>): string[] | undefined;
  /** Hosts it may reach over HTTPS (through the egress proxy). Empty: no network at all. */
  hosts: readonly string[];
  secrets: readonly SkillSecret[];
  /** Exit codes whose stdout is a result (default: 0 only). */
  okExitCodes?: readonly number[];
  timeoutMs?: number;
  /**
   * The search results in a successful output (#50): each becomes a source of the conversation, and the host
   * writes its id into the item as `sourceId` (the item is an object of the parsed output).
   */
  searchHits?(output: unknown): { item: Record<string, unknown>; hit: SearchHit }[];
};

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** A skill ready to run: its definition plus where its files are. */
export type BundledSkill = SkillSpec & {
  dir: string;
  entry: string;
  /** Re-checks the files just before a run (installed skills: their pinned copy is unchanged). */
  verify?: () => boolean;
};

/**
 * One line of free text for a skill argument: no control characters, no shell metacharacters (no shell is ever
 * used, but nothing legitimate needs them either), and it cannot look like a flag.
 */
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
export const SAFE_TEXT = /^(?!-)[^\0-\x1f\x7f;|&$`<>\\]+$/u;
const text = (max: number) => z.string().min(1).max(max).regex(SAFE_TEXT);

/** The verification skill — confirms the allow-listed, sandboxed skill path works end to end. */
export const SELFTEST_SKILL: BundledSkill = {
  name: "selftest",
  description:
    "Verification skill: returns the character count, SHA-256 and reverse of a short text. Use it only to check that Agent Lee skills work.",
  input: { text: z.string().max(2000) },
  finance: false,
  kind: "node",
  files: ["main.mjs"],
  args: () => [],
  hosts: [],
  secrets: [],
  dir: path.join(SKILLS_DIR, "selftest"),
  entry: path.join(SKILLS_DIR, "selftest", "main.mjs"),
};

/** Skills every active user has (the connection test runs them, FR-11.5); not subject to per-user permissions. */
export const ALWAYS_ON_SKILLS: ReadonlySet<string> = new Set([SELFTEST_SKILL.name]);

/** `google-news-search-skill` — Google News RSS, date-bounded (PRD §7, FR-5.7). Standard library python only. */
export const GOOGLE_NEWS_SKILL: SkillSpec = {
  name: "google-news-search-skill",
  description:
    "Recent news discovery from Google News RSS with a date window. Returns titles, publishers, links and publication times (JSON). Use for recent news context and to find sources; not for prices, scores or weather.",
  input: {
    query: text(200).describe("Search words (Google News operators such as site: or quotes are allowed)."),
    lookbackDays: z.number().int().min(1).max(30).optional().describe("Days back from now (default 1)."),
    site: z
      .string()
      .regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i)
      .max(100)
      .optional()
      .describe("Only this publisher domain, e.g. yna.co.kr"),
    locale: z.enum(["ko-KR", "en-US"]).optional(),
    sort: z.enum(["published", "relevance"]).optional(),
    maxResults: z.number().int().min(1).max(20).optional(),
  },
  finance: false,
  kind: "python",
  files: ["scripts/google_news_search.py"],
  args: (i) => [
    `--query=${String(i.query)}`,
    `--lookback-days=${Number(i.lookbackDays ?? 1)}`,
    ...(i.site ? [`--site=${String(i.site)}`] : []),
    `--locale=${String(i.locale ?? "ko-KR")}`,
    `--sort=${String(i.sort ?? "published")}`,
    `--max-results=${Number(i.maxResults ?? 10)}`,
    "--timeout=15",
    "--format=json",
  ],
  hosts: ["news.google.com"],
  secrets: [],
  // 1 = every query attempt failed; stdout is still the JSON report ({ ok: false, ... }).
  okExitCodes: [0, 1],
  timeoutMs: 40_000,
  // { items: [{ title, link, source, published_at, ... }] }
  searchHits: (output) => {
    const items = (output as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) return [];
    return items.flatMap((item: unknown) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const o = item as Record<string, unknown>;
      const url = str(o.link);
      const title = str(o.title);
      if (!url || !title) return [];
      const site = str(o.source);
      const publishedAt = str(o.published_at);
      return [
        { item: o, hit: { url, title, ...(site ? { site } : {}), ...(publishedAt ? { publishedAt } : {}) } },
      ];
    });
  },
};

/**
 * `kr-stock-skill` — Korean quotes (PRD §7, FR-7.1). Wrapped commands: Naver mobile snapshots of a stock or of
 * KOSPI/KOSDAQ (standard library only), and the optional Alpha Vantage quote, which needs ALPHAVANTAGE_API_KEY.
 * The FinanceDataReader commands (listing, history, FX, market summary) need the skill's venv: #30.
 */
export const KR_STOCK_SKILL: SkillSpec = {
  name: "kr-stock-skill",
  description:
    "Fallback only — prefer kr_quote / kr_index, whose numbers carry source and as-of time. Korean stock market numbers. command=stock with a 6-digit KRX code (e.g. 005930) or command=index with KOSPI/KOSDAQ: latest Naver m.stock snapshot with price, change, trading time and delay status (JSON). command=alpha-quote with a ticker: Alpha Vantage GLOBAL_QUOTE.",
  input: {
    command: z.enum(["stock", "index", "alpha-quote"]),
    code: z
      .string()
      .regex(/^[A-Za-z0-9.]{1,12}$/)
      .describe("stock: 6-digit code · index: KOSPI or KOSDAQ · alpha-quote: ticker"),
  },
  finance: true,
  kind: "python",
  files: ["scripts/kr_stock.py"],
  args: (i) => {
    const code = String(i.code);
    switch (i.command) {
      case "stock":
        return /^\d{6}$/.test(code) ? ["naver-stock", `--code=${code}`, "--json"] : undefined;
      case "index":
        return code === "KOSPI" || code === "KOSDAQ"
          ? ["naver-index", `--code=${code}`, "--json"]
          : undefined;
      case "alpha-quote":
        return /^[A-Z0-9.]{1,12}$/.test(code) ? ["alpha-quote", `--symbol=${code}`, "--json"] : undefined;
      default:
        return undefined;
    }
  },
  hosts: ["m.stock.naver.com", "www.alphavantage.co"],
  secrets: [{ env: "ALPHAVANTAGE_API_KEY", when: (i) => i.command === "alpha-quote" }],
  // 1 = the snapshot was not available; stdout is still the JSON report ({ status: "unavailable", ... }).
  okExitCodes: [0, 1],
  timeoutMs: 40_000,
};

/** Skills wrapped so far, installed from the admin's skill folders into the server's own (`pnpm skills:install`). */
export const SKILL_SPECS: readonly SkillSpec[] = [GOOGLE_NEWS_SKILL, KR_STOCK_SKILL];

/** Where each PRD §7 skill stands (docs/skills.md has the details). */
export type CatalogueStatus =
  /** Wrapped here; offered once installed (and python is configured). */
  | "implemented"
  /** Needs more than this runner offers today — the issue that brings it. */
  | "planned"
  /** A library usage guide, not a program: becomes a server function of our MCP server. */
  | "document"
  /**
   * Its lookups are server functions of our MCP server (the finance tools, #30, `@agentlee/mcp-tools/finance`):
   * the skill needs a venv or is a stateful monitor, so its data sources are read directly instead.
   */
  | "tools";

export type CatalogueEntry = {
  name: string;
  finance: boolean;
  status: CatalogueStatus;
  /** Issue that implements it (planned / document). */
  issue?: string;
  /** Secrets it needs (env names), documented for ops. */
  secrets: readonly string[];
};

const entry = (
  name: string,
  status: CatalogueStatus,
  o: { finance?: boolean; issue?: string; secrets?: string[] } = {},
): CatalogueEntry => ({
  name,
  finance: o.finance ?? false,
  status,
  ...(o.issue ? { issue: o.issue } : {}),
  secrets: o.secrets ?? [],
});

/** PRD §7, in order. Per-user permissions name these (FR-1.6); unknown names are refused. */
export const SKILL_CATALOGUE: readonly CatalogueEntry[] = [
  entry("kr-stock-skill", "implemented", { finance: true, secrets: ["ALPHAVANTAGE_API_KEY"] }),
  // us_* finance tools (Yahoo Finance, the source yfinance reads).
  entry("us-stock-skill", "tools", { finance: true, issue: "#30" }),
  // sec_* finance tools (SEC EDGAR). SEC asks every client for a User-Agent naming a contact: SEC_USER_AGENT.
  entry("market-disclosure-monitor", "tools", { finance: true, issue: "#30", secrets: ["SEC_USER_AGENT"] }),
  // dart_disclosures (OpenDART list API).
  entry("dart-investment-monitor", "tools", { finance: true, issue: "#30", secrets: ["OPENDART_API_KEY"] }),
  // Needs the skill's venv (google-genai): not runnable with the standard library only. #50 kept it planned.
  entry("news-search-skill", "planned", {
    issue: "#50 후속 (venv 또는 node 재구현 + 키로 실호출 확인)",
    secrets: ["GEMINI_API_KEY"],
  }),
  entry("google-news-search-skill", "implemented"),
  // Imports a package outside its folder (simpleclaw, not installed); its news path is web_search + web_fetch now.
  entry("realtime-lookup-skill", "planned", { issue: "#50 후속 (스포츠·날씨 구조화 조회)" }),
  // URL summaries: web_fetch + the runtime's own model. YouTube transcripts: not yet.
  entry("summarize", "planned", { issue: "#50 후속 (유튜브 자막)" }),
  entry("pdf", "document", { issue: "#48, #49" }),
  entry("docx", "document", { issue: "#48, #49" }),
  entry("xlsx", "document", { issue: "#48, #49" }),
  entry("pptx", "document", { issue: "#48, #49" }),
  entry("python-scratchpad", "planned", { issue: "#21 후속 (대화 작업 폴더 #22 필요)" }),
];

/** Every secret env name any skill may get (the server reads exactly these from its environment). */
export const SKILL_SECRET_NAMES: readonly string[] = [
  ...new Set(SKILL_CATALOGUE.flatMap((e) => e.secrets)),
].sort();
