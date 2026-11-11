import fs from "node:fs";
import path from "node:path";
import { spawnIsolated, type SpawnIsolatedOptions } from "../isolation/sandbox.js";
import { CHATGPT_ISSUER, credentialFromAuthJson, type ChatgptCredential } from "../connections/chatgpt.js";
import { CA_BUNDLE, codexBinary, codexEnv, codexPaths, Rpc, RpcError, type CodexChild } from "./codex.js";
import { codexConfigToml } from "./lockdown.js";

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
  /** Tests: replaces the sandboxed spawn (scripted app-server, test/helpers/codex-replay.ts). */
  spawn?: (o: SpawnIsolatedOptions) => CodexChild;
  now?: () => number;
};

const USER_CODE = /^[A-Za-z0-9-]{4,32}$/;
const EMAIL = /^[^\s@]{1,128}@[^\s@]{1,125}$/;

/** app-server's failure text → a fixed code (the text itself is never kept). */
function endCode(error: unknown): LoginEndCode {
  return typeof error === "string" && /expire|timed? ?out/i.test(error) ? "login_expired" : "login_failed";
}

/** The tokens file is overwritten before it is removed (best effort on a copy-on-write disk). */
function shred(file: string) {
  try {
    const n = fs.statSync(file).size;
    fs.writeFileSync(file, Buffer.alloc(n));
  } catch {
    // not there
  }
  fs.rmSync(file, { force: true });
}

export class CodexDeviceLogin {
  constructor(private readonly opts: CodexLoginOptions = {}) {}

  /** Starts a login in `dir` (created empty; removed when the login ends). Rejects with `LoginEnded("login_error")`. */
  async start(dir: string): Promise<DeviceLogin> {
    const now = this.opts.now ?? Date.now;
    fs.rmSync(dir, { recursive: true, force: true });
    const p = codexPaths(dir);
    for (const d of [dir, ...Object.values(p)]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(p.codexHome, "config.toml"), codexConfigToml({ credentialsStore: "file" }), {
      mode: 0o600,
    });
    const authFile = path.join(p.codexHome, "auth.json");
    const removeDir = () => {
      shred(authFile);
      fs.rmSync(dir, { recursive: true, force: true });
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
      const r = await rpc.request("account/login/start", { type: "chatgptDeviceCode" });
      const url = typeof r.verificationUrl === "string" ? r.verificationUrl : "";
      const code = typeof r.userCode === "string" ? r.userCode : "";
      // Only OpenAI's own sign-in page and a plain code are ever shown to the user.
      if (
        r.type !== "chatgptDeviceCode" ||
        typeof r.loginId !== "string" ||
        !url.startsWith(`${CHATGPT_ISSUER}/`) ||
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
        let text: string;
        try {
          text = fs.readFileSync(authFile, "utf8");
        } catch {
          throw new LoginEnded("login_error");
        }
        shred(authFile); // the tokens are in memory now; nothing stays in the folder
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
