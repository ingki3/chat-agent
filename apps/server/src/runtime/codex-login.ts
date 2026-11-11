import fs from "node:fs";
import path from "node:path";
import { spawnIsolated, type SpawnIsolatedOptions } from "../isolation/sandbox.js";
import { CHATGPT_ISSUER, credentialFromAuthJson, type ChatgptCredential } from "../connections/chatgpt.js";
import { CA_BUNDLE, codexBinary, codexEnv, codexPaths, Rpc, RpcError, type CodexChild } from "./codex.js";
import { codexConfigToml } from "./lockdown.js";
import {
  disposeLoginFolder,
  emptyQuarantine,
  quarantineDir,
  readLoginFile,
  shredLoginFile,
  type LoginFileHooks,
} from "./login-files.js";

/**
 * Codex ChatGPT device-code login (#18, PRD D2 / FR-11.2), run by the server for the web screen. A short-lived
 * `codex app-server` in its own login folder, in the same sandbox as a session (its folder only, no child
 * processes, the internet only through the egress proxy — `auth.openai.com` and `chatgpt.com`):
 *  1. `account/login/start {type:"chatgptDeviceCode"}` → `{loginId, verificationUrl, userCode}` (checked on 0.165.0
 *     against the real service: `https://auth.openai.com/codex/device`);
 *  2. app-server polls OpenAI until the user has entered the code, then sends `account/login/completed
 *     {loginId, success, error}` (a cancel — `account/login/cancel` — ends it the same way, `success: false`);
 *  3. the tokens: app-server has no request that returns them, so this one process stores them in its own
 *     CODEX_HOME (`cli_auth_credentials_store = "file"` → `auth.json`); the server reads that file at once, then
 *     asks `account/read` for the account's email, stops the process and removes the whole login folder.
 * The caller stores the credential encrypted (store.ts). Runs never see the refresh token (chatgpt.ts).
 */

export type LoginEndCode = "login_failed" | "login_expired" | "login_error" | "cancelled" | "timeout";

/** How a login ended without a credential. Carries a fixed code only — never app-server's text. */
export class LoginEnded extends Error {
  constructor(readonly code: LoginEndCode) {
    super(code);
  }
}

export type DeviceLoginResult = {
  credential: ChatgptCredential;
  email: string | null;
  planType: string | null;
};

export type DeviceLogin = {
  verificationUrl: string;
  userCode: string;
  /** When the login stops waiting (ms). */
  expiresAt: number;
  /** The login's end: the credential, or `LoginEnded`. The folder is gone by the time it settles. */
  result: Promise<DeviceLoginResult>;
  /** Stops waiting (`cancelled`). */
  cancel(): void;
};

export type CodexLoginOptions = {
  executable?: string;
  /** Egress proxy for the login process (auth.openai.com, chatgpt.com). Without it: no internet. */
  egress?: { endpoint(): Promise<{ port: number; url: string }> };
  /** How long the user has to enter the code (OpenAI's device codes last 15 minutes). */
  timeoutMs?: number;
  requestTimeoutMs?: number;
  maxRssBytes?: number;
  /** Tests: how a started process is identified (default: `ps`). */
  identify?: (pid: number) => ProcessIdentity | undefined;
  /** Tests: replaces the sandboxed spawn (scripted app-server, test/helpers/codex-replay.ts). */
  spawn?: (o: SpawnIsolatedOptions) => CodexChild;
  now?: () => number;
};

/**
 * The only sign-in page and code shape shown to a user — exactly what the pinned 0.165.0 returns (checked against
 * the real service: always this URL, codes like `AB1C-2D3E4`). Anything else (another path, a query, a fragment,
 * another code shape) fails the login: an app-server that changed is checked again before it is trusted.
 */
export const DEVICE_VERIFICATION_URL = `${CHATGPT_ISSUER}/codex/device`;
const USER_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{5}$/;
const EMAIL = /^[^\s@]{1,128}@[^\s@]{1,125}$/;

/** app-server's failure text → a fixed code (the text itself is never kept). */
function endCode(error: unknown): LoginEndCode {
  return typeof error === "string" && /expire|timed? ?out/i.test(error) ? "login_expired" : "login_failed";
}

const PID_FILE = "login.pid";
/** Login folders: `runtimes/logins/login-<id>` (new connections) and `runtimes/<connection id>/login-<id>`. */
const LOGIN_DIR = /^login-[A-Za-z0-9_-]{1,64}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The tokens file of a login folder, relative to it (never followed through a link: login-files.ts). */
const AUTH_FILE = ["codex-home", "auth.json"];

/**
 * Who a process is, as `ps` tells it: process group, start time (`lstart`, to the second) and command line. A pid
 * alone is not an identity — the system reuses it. Recorded when a login process starts; a left-over process is
 * killed only when all three still match (and the record belongs to that very login folder).
 */
export { processIdentity, type ProcessIdentity } from "../storage/process-identity.js";
import { processIdentity, type ProcessIdentity } from "../storage/process-identity.js";

type PidRecord = { login: string; pid: number } & ProcessIdentity;

function readPidRecord(dir: string): PidRecord | undefined {
  const text = readLoginFile(dir, [PID_FILE]);
  if (!text) return undefined;
  try {
    const r = JSON.parse(text) as Partial<PidRecord>;
    if (
      typeof r.login !== "string" ||
      !Number.isInteger(r.pid) ||
      !Number.isInteger(r.pgid) ||
      typeof r.lstart !== "string" ||
      typeof r.command !== "string"
    )
      return undefined;
    return r as PidRecord;
  } catch {
    return undefined;
  }
}

export type LeftoverOutcome = "leftover_cleaned" | "leftover_process_killed" | "leftover_process_kept";

/**
 * Startup (#18 review): login folders a previous server left behind — it died or was killed while a login waited,
 * so its `finally` never ran — are removed with their tokens file (overwritten first), and a login process still
 * running from then is killed. Nothing is followed through a link (login-files.ts). A process is killed only when
 * its recorded identity (login folder, process group, start time, command line) still matches exactly; otherwise
 * it is left alone. Calls `report` once per folder with a fixed outcome code.
 */
export function cleanupLeftoverLogins(
  dataDir: string,
  o: {
    identify?: (pid: number) => ProcessIdentity | undefined;
    report?: (outcome: LeftoverOutcome) => void;
    hooks?: LoginFileHooks;
  } = {},
): number {
  const root = path.join(dataDir, "runtimes");
  const identify = o.identify ?? processIdentity;
  const dirs: string[] = [];
  const list = (d: string) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  for (const top of list(root)) {
    if (!top.isDirectory() || !SAFE_ID.test(top.name)) continue; // symbolic links are not directories here
    for (const e of list(path.join(root, top.name)))
      if (e.isDirectory() && LOGIN_DIR.test(e.name)) dirs.push(path.join(root, top.name, e.name));
  }
  for (const dir of dirs) {
    let outcome: LeftoverOutcome = "leftover_cleaned";
    const rec = readPidRecord(dir);
    if (rec && rec.pid > 1) {
      const now = identify(rec.pid);
      const ours =
        rec.login === path.basename(dir) &&
        now !== undefined &&
        now.pgid === rec.pgid &&
        now.lstart === rec.lstart &&
        now.command === rec.command;
      if (ours) {
        try {
          process.kill(rec.pgid === rec.pid ? -rec.pid : rec.pid, "SIGKILL");
          outcome = "leftover_process_killed";
        } catch {
          // already gone
        }
      } else if (now !== undefined) outcome = "leftover_process_kept"; // that pid is someone else's now
    }
    // A writer may still be alive (its identity did not match): quarantine first, then remove (login-files.ts).
    disposeLoginFolder(dir, quarantineDir(dataDir), o.hooks);
    o.report?.(outcome);
  }
  emptyQuarantine(quarantineDir(dataDir), o.hooks);
  return dirs.length;
}

export class CodexDeviceLogin {
  constructor(private readonly opts: CodexLoginOptions = {}) {}

  /** Starts a login in `dir` (created empty; removed when the login ends). Rejects with `LoginEnded("login_error")`. */
  async start(dir: string): Promise<DeviceLogin> {
    const now = this.opts.now ?? Date.now;
    // Login folders sit at `runtimes/<logins | connection id>/login-<id>`: the quarantine is `runtimes/.quarantine`.
    const quarantine = path.join(path.dirname(path.dirname(dir)), ".quarantine");
    disposeLoginFolder(dir, quarantine);
    const p = codexPaths(dir);
    for (const d of [dir, ...Object.values(p)]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    // The folder holding login folders is the server's only, also when something else made it first.
    for (const d of [path.dirname(dir), dir]) fs.chmodSync(d, 0o700);
    fs.writeFileSync(path.join(p.codexHome, "config.toml"), codexConfigToml({ credentialsStore: "file" }), {
      mode: 0o600,
    });
    const removeDir = () => {
      // The process is stopped by now, but nothing here relies on that: quarantine first (login-files.ts).
      disposeLoginFolder(dir, quarantine);
    };

    let child: CodexChild;
    let proxy: { port: number; url: string } | undefined;
    try {
      const bin = this.opts.executable ?? codexBinary();
      if (!bin) throw new LoginEnded("login_error");
      proxy = this.opts.egress ? await this.opts.egress.endpoint() : undefined;
      const env = codexEnv({ dir });
      if (proxy) Object.assign(env, { HTTPS_PROXY: proxy.url, NO_PROXY: "127.0.0.1,localhost" });
      child = (this.opts.spawn ?? spawnIsolated)({
        command: bin,
        args: ["app-server", "--strict-config", "--listen", "stdio://"],
        cwd: p.work,
        env,
        read: [dir, CA_BUNDLE],
        write: [p.codexHome, p.tmp],
        network: { loopbackPorts: proxy ? [proxy.port] : [] },
        maxRssBytes: this.opts.maxRssBytes ?? 1024 ** 3,
        onStderr: () => {}, // never logged
      });
    } catch {
      removeDir();
      throw new LoginEnded("login_error");
    }
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    const stop = async () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 2000).unref())]);
      removeDir();
    };

    let loginId: string | undefined;
    let completed: ((m: { success: boolean; error: unknown }) => void) | undefined;
    const completion = new Promise<{ success: boolean; error: unknown }>((r) => (completed = r));
    let early: { success: boolean; error: unknown } | undefined;
    const rpc = new Rpc(
      child,
      {
        notification: (m) => {
          if (m.method !== "account/login/completed") return;
          const params = m.params ?? {};
          const done = { success: params.success === true, error: params.error };
          if (loginId === undefined) early = done;
          else if (params.loginId === loginId) completed?.(done);
        },
        serverRequest: () => {}, // refused (a login process has no reason to ask anything)
        exit: () => completed?.({ success: false, error: null }),
      },
      this.opts.requestTimeoutMs ?? 30_000,
    );

    let started: { verificationUrl: string; userCode: string };
    try {
      await rpc.request("initialize", {
        clientInfo: { name: "agentlee", title: null, version: "0.1.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      rpc.notify("initialized", {});
      // Who wrote here, for the next start if this server dies mid-login (`cleanupLeftoverLogins`). Recorded once
      // the process answered — sandbox-exec has exec'd the binary by then, so the command line is final. Outside
      // what the process may write.
      if (child.pid) {
        const id = (this.opts.identify ?? processIdentity)(child.pid);
        if (id)
          fs.writeFileSync(
            path.join(dir, PID_FILE),
            JSON.stringify({ login: path.basename(dir), pid: child.pid, ...id }),
            { mode: 0o600, flag: "wx" },
          );
      }
      const r = await rpc.request("account/login/start", { type: "chatgptDeviceCode" });
      const url = typeof r.verificationUrl === "string" ? r.verificationUrl : "";
      const code = typeof r.userCode === "string" ? r.userCode : "";
      // Only OpenAI's own sign-in page and a plain code are ever shown to the user.
      if (
        r.type !== "chatgptDeviceCode" ||
        typeof r.loginId !== "string" ||
        url !== DEVICE_VERIFICATION_URL ||
        !USER_CODE.test(code)
      )
        throw new LoginEnded("login_error");
      loginId = r.loginId;
      started = { verificationUrl: url, userCode: code };
      if (early) completed?.(early);
    } catch (e) {
      await stop();
      throw e instanceof LoginEnded || e instanceof RpcError ? new LoginEnded("login_error") : e;
    }

    const timeoutMs = this.opts.timeoutMs ?? 15 * 60_000;
    let reason: "cancelled" | "timeout" | undefined;
    const end = (why: "cancelled" | "timeout") => {
      if (reason) return;
      reason = why;
      // app-server ends the wait with `account/login/completed {success: false}`; a process that does not is
      // stopped anyway.
      void rpc.request("account/login/cancel", { loginId: loginId! }).catch(() => undefined);
      setTimeout(() => completed?.({ success: false, error: null }), 2000).unref();
    };
    const timer = setTimeout(() => end("timeout"), timeoutMs);
    timer.unref();

    const result = (async (): Promise<DeviceLoginResult> => {
      try {
        const done = await completion;
        clearTimeout(timer);
        if (reason) throw new LoginEnded(reason);
        if (!done.success) throw new LoginEnded(rpc.exited ? "login_error" : endCode(done.error));
        // Never through a link the process may have put there, only a plain single-link file (login-files.ts).
        let text = readLoginFile(dir, AUTH_FILE);
        // The tokens are in memory now: the file is zeroed through its own descriptor at once. Its name is removed
        // with the folder, after quarantine — the process is still alive here (account/read below).
        shredLoginFile(dir, AUTH_FILE, undefined, { keepName: true });
        if (text === undefined) throw new LoginEnded("login_error");
        const credential = credentialFromAuthJson(text);
        text = "";
        if (!credential) throw new LoginEnded("login_error");
        // Only the email is shown of the account (FR-11.6).
        let email: string | null = null;
        let planType = credential.planType;
        try {
          const a = (await rpc.request("account/read", {})).account as
            { type?: unknown; email?: unknown; planType?: unknown } | null | undefined;
          if (a?.type === "chatgpt") {
            if (typeof a.email === "string" && EMAIL.test(a.email)) email = a.email;
            if (typeof a.planType === "string") planType = a.planType;
          }
        } catch {
          // the login itself worked; the email stays unknown
        }
        // A cancel or the timeout while the account was read: the login is over, nothing is handed out.
        if (reason) throw new LoginEnded(reason);
        return { credential: { ...credential, planType }, email, planType };
      } finally {
        clearTimeout(timer);
        await stop();
      }
    })();
    result.catch(() => undefined); // the caller awaits it; never an unhandled rejection meanwhile
    return {
      ...started,
      expiresAt: now() + timeoutMs,
      result,
      cancel: () => end("cancelled"),
    };
  }
}
