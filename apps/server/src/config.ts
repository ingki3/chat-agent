import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { isInside } from "./fs-safety.js";

/** Repository root, resolved from apps/server/{src,dist}. `.env` and relative paths are anchored here. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Hosts the server may bind to. The service is reachable from outside only through Cloudflare Tunnel (PRD D4). */
export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"] as const;

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
  /** Temporary access code for the /gate page until Cloudflare Access is configured. Unset = no gate. */
  TEMP_GATE_CODE: z
    .string()
    .regex(/^\S{8,64}$/, { message: "TEMP_GATE_CODE must be 8–64 characters without spaces" })
    .optional(),
});

export type Config = {
  env: "development" | "production" | "test";
  host: string;
  port: number;
  dataDir: string;
  masterKeyPath: string;
  diagStream: boolean;
  tempGateCode?: string | undefined;
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
    tempGateCode: c.TEMP_GATE_CODE,
  };
}
