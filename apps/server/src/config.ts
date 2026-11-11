import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SKILL_SECRET_NAMES } from "@agentlee/mcp-tools/skills";
import { isInside } from "./fs-safety.js";
import { parseMetricsAddress, type MetricsAddress } from "./observability/tunnel.js";

/** Repository root, resolved from apps/server/{src,dist}. `.env` and relative paths are anchored here. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Hosts the server may bind to. The service is reachable from outside only through Cloudflare Tunnel (PRD D4). */
export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"] as const;

/** An unset or empty variable (`KEY=` in .env) both mean "not configured". */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z
    .string()
    .default("127.0.0.1")
    .refine((h) => (LOOPBACK_HOSTS as readonly string[]).includes(h), {
      message:
        "HOST must be a loopback address (127.0.0.1, localhost or ::1); external access goes through Cloudflare Tunnel",
    }),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  DATA_DIR: z.string().default("./data"),
  /** Master key file for credential encryption. Must live outside DATA_DIR so backups never include it. */
  MASTER_KEY_PATH: z.string().default(path.join(os.homedir(), ".agentlee", "master.key")),
  /**
   * Daily backups (#37): one folder per backup, each deleted once it is 7 days old. Must be outside DATA_DIR (a restore replaces DATA_DIR), outside
   * the repository (never committed) and must not hold the master key. Unset = `~/agentlee-backups`; in tests unset =
   * no backups at all (a test never writes to the home folder).
   */
  BACKUP_DIR: optional(z.string()),
  /** Enables /api/diag/stream for SSE measurements (scripts/sse-probe.ts). Off unless explicitly "1". */
  DIAG_STREAM: z.enum(["0", "1"]).default("0"),
  /** Registers the scripted FakeRuntime (development and testing only, never with real family data). */
  FAKE_RUNTIME: z.enum(["0", "1"]).default("0"),
  /** Public hostname served through Cloudflare Tunnel. Requests with this Host need a valid Access JWT. */
  PUBLIC_HOST: z
    .string()
    .regex(/^[a-z0-9.-]+$/, { message: "PUBLIC_HOST must be a lower-case hostname without port" })
    .default("chat.2prostream.com"),
  /** Cloudflare Access team domain (`<team>.cloudflareaccess.com`) and application AUD tag. Set both or neither. */
  CF_ACCESS_TEAM_DOMAIN: optional(
    z.string().regex(/^[a-z0-9-]+\.cloudflareaccess\.com$/, {
      message: "CF_ACCESS_TEAM_DOMAIN must look like <team>.cloudflareaccess.com",
    }),
  ),
  CF_ACCESS_AUD: optional(
    z.string().regex(/^[a-f0-9]{64}$/, { message: "CF_ACCESS_AUD must be the 64-character AUD tag" }),
  ),
  /** Admin account email, created on the first-run screen (PRD FR-1.1). */
  ADMIN_EMAIL: z.email().default("ingki3@gmail.com"),
  /**
   * Log file written by the service itself, size-rotated (#46). Unset = stdout (development). The LaunchDaemon
   * sets it to /Library/Logs/agentlee/server.log.
   */
  LOG_FILE: optional(z.string()),
  /**
   * Legacy Claude Code credentials (before #17). Read only for the one-time import into app-managed connections
   * (connections/import.ts, docs/ops.md §11): the API key becomes a shared connection, the subscription token
   * (`claude setup-token`) the admin's own personal one (PRD D2). Remove them from `.env` after the import.
   */
  // Not checked here on purpose: the importer applies the connection rules (formats included), skips a bad
  // value without marking it imported and the server still starts — the admin sees it and fixes `.env` (review #84).
  CLAUDE_API_KEY: optional(z.string()),
  CLAUDE_OAUTH_TOKEN: optional(z.string()),
  /** Legacy OpenAI API key (before #17), imported once as a shared Codex connection (docs/ops.md §11). */
  CODEX_API_KEY: optional(z.string()),
  /**
   * Python for python skills (#21): `<install>/bin/python3.x` of a self-contained build (e.g. `uv python install
   * 3.12`, then `uv python find 3.12`). Unset = python skills are not offered. See mcp/python.ts.
   */
  SKILL_PYTHON: optional(z.string()),
  /** Where `pnpm skills:install` looks for the admin's skills (PRD D5), `:`-separated. */
  SKILL_SOURCES: optional(z.string()),
  /**
   * Web search providers tried in order (#50), comma-separated: `duckduckgo` (its HTML results page — real
   * article links, but not an official API and sometimes answered with a bot check; see
   * docs/decisions/isolation.md "웹 검색·가져오기 (#50)") and `google-news` (the installed google-news-search-skill
   * — news only, and its links are Google redirect pages web_fetch cannot read). Default: both, in that order.
   */
  WEB_SEARCH_PROVIDERS: optional(
    z.string().regex(/^(google-news|duckduckgo)(,(google-news|duckduckgo))*$/, {
      message: "WEB_SEARCH_PROVIDERS must list google-news and/or duckduckgo, comma-separated",
    }),
  ),
  /**
   * Browser for PNG/PDF export (#51): an absolute path to Playwright's `chrome-headless-shell`. Unset = the newest
   * one in Playwright's cache (`pnpm exec playwright install --only-shell chromium`); none = export unavailable.
   */
  EXPORT_BROWSER: optional(
    z.string().refine((p) => path.isAbsolute(p), { message: "EXPORT_BROWSER must be an absolute path" }),
  ),
  /**
   * `cloudflared`'s metrics server for the admin's tunnel status (#35): `http://127.0.0.1:<port>` or
   * `http://[::1]:<port>` only (cloudflared `--metrics 127.0.0.1:<port>`). Unset = "미설정".
   */
  CLOUDFLARED_METRICS: optional(
    z.string().refine((v) => parseMetricsAddress(v) !== undefined, {
      message:
        "CLOUDFLARED_METRICS must be http://127.0.0.1:<port> or http://[::1]:<port> (loopback IP, no path)",
    }),
  ),
  /** Temporary access code for the /gate page until Cloudflare Access is configured. Unset = no gate. */
  TEMP_GATE_CODE: optional(
    z.string().regex(/^\S{8,64}$/, { message: "TEMP_GATE_CODE must be 8–64 characters without spaces" }),
  ),
});

export type Config = {
  env: "development" | "production" | "test";
  host: string;
  port: number;
  dataDir: string;
  masterKeyPath: string;
  /** Backup folder (#37); undefined = backups off (tests without BACKUP_DIR). */
  backupDir?: string | undefined;
  diagStream: boolean;
  fakeRuntime: boolean;
  tempGateCode?: string | undefined;
  publicHost: string;
  /** Present when Cloudflare Access is configured. */
  access?: { teamDomain: string; aud: string } | undefined;
  adminEmail: string;
  /** Absolute path of the rotated log file; undefined = stdout. */
  logFile?: string | undefined;
  /** Legacy Claude Code credentials for the one-time import (secrets — never log this object). */
  claude?: { apiKey?: string | undefined; oauthToken?: string | undefined } | undefined;
  /** Legacy Codex credential for the one-time import (secret — never log this object). */
  codex?: { apiKey: string } | undefined;
  /** Interpreter for python skills (validated when the MCP service starts). */
  skillPython?: string | undefined;
  /** Folders `pnpm skills:install` copies skills from. */
  skillSources: string[];
  /**
   * Per-skill secrets (`SKILL_SECRET_NAMES`, e.g. ALPHAVANTAGE_API_KEY, OPENDART_API_KEY) from `.env`. Each goes
   * only into the processes of the skills that declare it (never log this object).
   */
  skillSecrets: Record<string, string>;
  /** Browser executable for PNG/PDF export (#51); undefined = look in Playwright's cache. */
  exportBrowser?: string | undefined;
  /** Web search providers in the order they are tried (#50). */
  webSearchProviders: ("google-news" | "duckduckgo")[];
  /** `cloudflared`'s loopback metrics server (#35); undefined = not configured. */
  tunnelMetrics?: MetricsAddress | undefined;
};

/** A secret value: printable ASCII, no spaces (API keys). */
const SECRET = /^[\x21-\x7e]{8,512}$/;

function skillSecrets(source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of SKILL_SECRET_NAMES) {
    const v = source[name];
    if (v === undefined || v === "") continue;
    if (!SECRET.test(v)) throw new Error(`Invalid configuration — ${name} must be a key without spaces`);
    out[name] = v;
  }
  return out;
}

/** Parses and validates settings. Throws with a readable message on invalid input. */
export function loadConfig(
  source: Record<string, string | undefined> = process.env,
  baseDir: string = REPO_ROOT,
): Config {
  const parsed = ConfigSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration — ${issues}`);
  }
  const c = parsed.data;
  if (!c.CF_ACCESS_TEAM_DOMAIN !== !c.CF_ACCESS_AUD)
    throw new Error("Invalid configuration — set both CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD, or neither");
  const dataDir = path.resolve(baseDir, c.DATA_DIR);
  const masterKeyPath = path.resolve(baseDir, c.MASTER_KEY_PATH);
  if (isInside(masterKeyPath, dataDir)) {
    throw new Error(
      "Invalid configuration — MASTER_KEY_PATH must be outside DATA_DIR (backups must not contain the key)",
    );
  }
  const backupDir =
    c.BACKUP_DIR !== undefined
      ? path.resolve(baseDir, c.BACKUP_DIR)
      : c.NODE_ENV === "test"
        ? undefined
        : path.join(os.homedir(), "agentlee-backups");
  if (backupDir !== undefined) {
    if (isInside(backupDir, dataDir) || isInside(dataDir, backupDir))
      throw new Error(
        "Invalid configuration — BACKUP_DIR must be outside DATA_DIR (a restore replaces DATA_DIR) and must not contain it",
      );
    if (isInside(masterKeyPath, backupDir))
      throw new Error("Invalid configuration — BACKUP_DIR must not contain the master key (MASTER_KEY_PATH)");
    if (isInside(backupDir, REPO_ROOT))
      throw new Error("Invalid configuration — BACKUP_DIR must be outside the repository");
  }
  return {
    env: c.NODE_ENV,
    host: c.HOST,
    port: c.PORT,
    dataDir,
    masterKeyPath,
    backupDir,
    diagStream: c.DIAG_STREAM === "1",
    fakeRuntime: c.FAKE_RUNTIME === "1",
    tempGateCode: c.TEMP_GATE_CODE,
    publicHost: c.PUBLIC_HOST,
    access:
      c.CF_ACCESS_TEAM_DOMAIN && c.CF_ACCESS_AUD
        ? { teamDomain: c.CF_ACCESS_TEAM_DOMAIN, aud: c.CF_ACCESS_AUD }
        : undefined,
    adminEmail: c.ADMIN_EMAIL.toLowerCase(),
    logFile: c.LOG_FILE ? path.resolve(baseDir, c.LOG_FILE) : undefined,
    claude:
      c.CLAUDE_API_KEY || c.CLAUDE_OAUTH_TOKEN
        ? { apiKey: c.CLAUDE_API_KEY, oauthToken: c.CLAUDE_OAUTH_TOKEN }
        : undefined,
    codex: c.CODEX_API_KEY ? { apiKey: c.CODEX_API_KEY } : undefined,
    skillPython: c.SKILL_PYTHON,
    skillSources: (
      c.SKILL_SOURCES ??
      [path.join(os.homedir(), ".agents", "skills"), path.join(os.homedir(), ".claude", "skills")].join(":")
    )
      .split(":")
      .filter(Boolean)
      .map((p) => path.resolve(baseDir, p)),
    skillSecrets: skillSecrets(source),
    exportBrowser: c.EXPORT_BROWSER,
    tunnelMetrics: c.CLOUDFLARED_METRICS ? parseMetricsAddress(c.CLOUDFLARED_METRICS) : undefined,
    webSearchProviders: [
      ...new Set(
        (c.WEB_SEARCH_PROVIDERS ?? "duckduckgo,google-news").split(",") as ("google-news" | "duckduckgo")[],
      ),
    ],
  };
}
