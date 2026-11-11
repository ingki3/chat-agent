import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { isInside } from "./fs-safety.js";

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
  diagStream: boolean;
  fakeRuntime: boolean;
  tempGateCode?: string | undefined;
  publicHost: string;
  /** Present when Cloudflare Access is configured. */
  access?: { teamDomain: string; aud: string } | undefined;
  adminEmail: string;
  /** Absolute path of the rotated log file; undefined = stdout. */
  logFile?: string | undefined;
};

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
  return {
    env: c.NODE_ENV,
    host: c.HOST,
    port: c.PORT,
    dataDir,
    masterKeyPath,
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
  };
}
