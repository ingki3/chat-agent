import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { SkillResult, ToolScope } from "@agentlee/mcp-tools";
import { PYTHON_RUN_TOOL } from "@agentlee/mcp-tools/python";
import {
  fileKindOf,
  frameExternal,
  PYTHON_LIMITS,
  PYTHON_OUTPUT_KINDS,
  type FileKind,
  type PythonCode,
  type PythonSkipReason,
} from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { conversations, messages, runs } from "../db/schema.js";
import { contentMatches } from "../files/detect.js";
import { cleanName, FileLimitError, type FileRow, type FileStore } from "../files/store.js";
import { scrubKnown, scrubKnownDeep } from "../secrets/known.js";
import { storagePaths } from "../storage/paths.js";
import { SCRATCHPAD_DIR, type ScratchpadState } from "./packages.js";
import { JOB_ID, jobWorkdir, runLauncherCleanSync, scratchRoot, type PythonAccount } from "./account.js";
import type { PythonJob, PythonReport, PythonRunner } from "./runner.js";

/**
 * `python_run` (#47, PRD §7 `python-scratchpad`): checks the request, copies the given conversation files into a
 * working folder made for this call, has the code run by the sandboxed interpreter (runner.ts), and stores the text
 * files it wrote as files of the conversation (#22), linked to the reply of the run that made them.
 *
 * - Scope: the run's token (user, conversation, run) — the user must own the conversation, and the run must be that
 *   conversation's with its reply message still there (the files are linked to it).
 * - Inputs: files of the same conversation and user only, sent with a message still in the history (uploads, or
 *   files a reply made — `isActiveAttachment`), read through the store's checked open and checked against their
 *   stored hash. Never a path or a URL.
 * - Working folder: `scratch/<user>/<conversation>/<call>`, fresh per call, the only folder the process may read or
 *   write besides its program folders; removed when the call ends (and every left-over at server start). Nothing is
 *   kept between calls — a later call passes the stored files again.
 * - Known secrets (round 23–27) leave everything that comes back: stdout, stderr and the traceback are scrubbed whole
 *   **before** they are cut (`scrubKnown` with its tail rule also masks a secret the interpreter's own capture limit
 *   cut off), and every text file is scrubbed before it is stored. Only text formats are stored
 *   (`PYTHON_OUTPUT_KINDS`) — a binary one could carry a secret the server cannot see. The server's own paths are
 *   taken out of the text first (the working folder becomes `.`).
 * - Text from the run reaches the model inside `<external_content>` blocks: it may come from uploaded files.
 * - At most `PYTHON_SLOTS` runs at once (each may take 768 MB) — over it, `python_busy` at once (no queue).
 */
export const PYTHON_SLOTS = { total: 2, perUser: 1 } as const;

class PythonError extends Error {
  constructor(readonly code: PythonCode) {
    super(code);
  }
}

export type PythonScratchpadOptions = {
  db: Db;
  dataDir: string;
  /** The conversation file store (#22); undefined while the app is starting (refused as unavailable). */
  files: () => FileStore | undefined;
  runner: PythonRunner;
  /** What this server can run now (`scratchpadState`, from SKILL_PYTHON and the installed packages). */
  state: () => ScratchpadState;
  slots?: { total: number; perUser: number };
};

export type PythonFileOut = { fileId: string; name: string; kind: FileKind; bytes: number; url: string };

export type PythonRunOutput = {
  status: "ok" | "error";
  exitCode: number;
  stdout: string;
  stdoutTruncated: boolean;
  stdoutChars: number;
  stderr: string;
  stderrTruncated: boolean;
  error?: { type: string; traceback: string };
  files: PythonFileOut[];
  skipped: { name: string; reason: PythonSkipReason }[];
  /** The whole kept stdout as a text file, when `stdout` is only its start. */
  outputFile?: PythonFileOut;
};

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ERROR_TYPE = /^[A-Za-z_][A-Za-z0-9_.]{0,99}$/;
const OUTPUT_KINDS: ReadonlySet<string> = new Set(PYTHON_OUTPUT_KINDS);
const MAX_DEPTH = 3;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** At most `n` code points of `t` from the start (`end`: from the end). */
function cut(t: string, n: number, end = false): { text: string; cut: boolean } {
  const cps = Array.from(t);
  if (cps.length <= n) return { text: t, cut: false };
  return { text: (end ? cps.slice(-n) : cps.slice(0, n)).join(""), cut: true };
}

/** Opens every folder below `dir` to its owner (links are never followed), so the tree can be listed and removed. */
function openUp(dir: string): void {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    try {
      fs.chmodSync(d, 0o700);
      for (const e of fs.readdirSync(d, { withFileTypes: true }))
        if (e.isDirectory()) stack.push(path.join(d, e.name));
    } catch {
      // removed below as far as possible
    }
  }
}

/**
 * Removes a folder tree the sandboxed code may have made unreadable, unwritable or (despite the profile's
 * `noFlagChanges`) immutable: folders opened to the owner, then — if removing still fails — the user flags cleared
 * (`chflags -R nouchg,nouappnd`, never following links) and once more. Never throws: false when something is left
 * (the next server start tries again, and does not fail on it).
 */
export function removeTree(dir: string): boolean {
  try {
    const st = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!st) return true;
    if (st.isDirectory()) openUp(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      if (process.platform === "darwin")
        spawnSync("/usr/bin/chflags", ["-R", "-P", "nouchg,nouappnd", dir], { stdio: "ignore", env: {} });
      if (st.isDirectory()) openUp(dir);
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    }
  } catch {
    return false;
  }
}

/** A local name for an input copy: the file's name made safe as one path segment, unique in the folder. */
function localName(name: string, taken: Set<string>): string {
  let base = cleanName(name)
    .replace(/[/\\:\0]/g, "_")
    .replace(/^[.\s]+/, "");
  if (!base) base = "file";
  // Under a typical file system's name limit (255 bytes), keeping the extension.
  while (Buffer.byteLength(base) > 200) {
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 ? base.slice(dot) : "";
    base =
      Array.from(base.slice(0, base.length - ext.length))
        .slice(0, -1)
        .join("") + ext;
  }
  let out = base;
  for (let i = 2; taken.has(out.toLowerCase()); i++) {
    const dot = base.lastIndexOf(".");
    out = dot > 0 ? `${base.slice(0, dot)}-${i}${base.slice(dot)}` : `${base}-${i}`;
  }
  taken.add(out.toLowerCase());
  return out;
}

export class PythonScratchpad {
  private running = 0;
  private readonly byUser = new Map<string, number>();
  private readonly stop = new AbortController();
  /** Most runs seen at once (for tests). */
  peak = 0;

  constructor(private readonly opts: PythonScratchpadOptions) {}

  /** The admin's view (FR-10.3): available, or why not. */
  state(): ScratchpadState["state"] {
    return this.opts.state().state;
  }

  /**
   * Removes the job folders left by an earlier process (server start, before anything runs). **Keeps** the scratch
   * root and its `.ctl` control dir so the installed ACL (inherited by every job dir) survives — review #121 round
   * 3: deleting the root dropped the ACL and later jobs lost account access. An account-owned leftover is removed
   * through the launcher's `clean` (the account restores modes it may have cleared); anything else by the server.
   * Never throws: false when something is left (logged by the caller; the server starts anyway).
   */
  sweep(account?: PythonAccount): boolean {
    const root = scratchRoot(this.opts.dataDir);
    let ok = true;
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      // No scratch yet: nothing to sweep (ensureLayout/makeWorkdir create it).
      return true;
    }
    for (const n of names) {
      if (n === ".ctl") {
        // Keep the control dir itself; clear its stale per-job entries.
        try {
          for (const j of fs.readdirSync(path.join(root, ".ctl"))) removeTree(path.join(root, ".ctl", j));
        } catch {
          ok = false;
        }
        continue;
      }
      if (account && JOB_ID.test(n)) runLauncherCleanSync(account, n);
      if (fs.existsSync(path.join(root, n)) && !removeTree(path.join(root, n))) ok = false;
    }
    return ok;
  }

  /** Stops the running processes (server shutdown). */
  close(): void {
    this.stop.abort();
  }

  /** The reply message of the scope's run, if the user owns the conversation and the run is that conversation's. */
  private replyOf(scope: ToolScope): string | undefined {
    const r = this.opts.db
      .select({ ownerId: conversations.ownerId, messageId: runs.assistantMessageId })
      .from(runs)
      .innerJoin(conversations, eq(conversations.id, runs.conversationId))
      .innerJoin(messages, eq(messages.id, runs.assistantMessageId))
      .where(and(eq(runs.id, scope.runId), eq(runs.conversationId, scope.conversationId)))
      .get();
    return r && r.ownerId === scope.userId ? r.messageId : undefined;
  }

  async run(scope: ToolScope, input: Record<string, unknown>): Promise<SkillResult> {
    try {
      return { ok: true, output: await this.execute(scope, input) };
    } catch (e) {
      if (e instanceof PythonError) return { ok: false, code: e.code };
      throw e;
    }
  }

  private async execute(scope: ToolScope, raw: Record<string, unknown>): Promise<PythonRunOutput> {
    const parsed = z.strictObject(PYTHON_RUN_TOOL.input).safeParse(raw);
    if (!parsed.success) throw new PythonError("python_bad_input");
    const req = parsed.data as { code: string; files?: string[] };
    const ready = this.opts.state();
    if (ready.state !== "available") throw new PythonError("python_not_installed");
    const store = this.opts.files();
    if (!store) throw new PythonError("python_unavailable");
    const messageId = this.replyOf(scope);
    if (!messageId || !SAFE_ID.test(scope.userId) || !SAFE_ID.test(scope.conversationId))
      throw new PythonError("python_not_allowed");

    const inputs: FileRow[] = [];
    let inputBytes = 0;
    for (const id of new Set(req.files ?? [])) {
      const f = store.get(id);
      // Another user's or conversation's file, an unsent one, one of a message no longer in the history: the same
      // answer as a file that does not exist (nothing is said about files outside the scope).
      if (
        !f ||
        f.userId !== scope.userId ||
        f.conversationId !== scope.conversationId ||
        !store.isActiveAttachment(f)
      )
        throw new PythonError("python_file_not_found");
      inputBytes += f.bytes;
      if (inputBytes > PYTHON_LIMITS.inputBytes) throw new PythonError("python_files_too_large");
      inputs.push(f);
    }

    // One of the server's interpreter slots (2 at once, 1 per user), else busy.
    const mine = this.byUser.get(scope.userId) ?? 0;
    const limits = this.opts.slots ?? PYTHON_SLOTS;
    if (this.running >= limits.total || mine >= limits.perUser) throw new PythonError("python_busy");
    this.running++;
    this.byUser.set(scope.userId, mine + 1);
    this.peak = Math.max(this.peak, this.running);
    let made: { jobId: string; dir: string } | undefined;
    try {
      made = makeJobWorkdir(this.opts.dataDir);
      const copies = this.copyInputs(store, inputs, made.dir);
      const job: PythonJob = {
        code: req.code,
        workdir: made.dir,
        jobId: made.jobId,
        files: Object.fromEntries([...copies].map(([rel, c]) => [c.fileId, rel])),
        inputBytes,
        env: ready.env,
        dataDir: this.opts.dataDir,
      };
      const r = await this.opts.runner(job, this.stop.signal);
      if (!r.ok) throw new PythonError(r.code);
      return await this.answer(store, scope, messageId, job, r.report, copies);
    } finally {
      this.running--;
      const left = (this.byUser.get(scope.userId) ?? 1) - 1;
      if (left > 0) this.byUser.set(scope.userId, left);
      else this.byUser.delete(scope.userId);
      // The account owns what the code made; it may have cleared modes the server cannot restore. Clean through
      // the launcher first (as the account), then remove the rest ourselves.
      if (made) {
        const acct = ready.env.account;
        if (acct) runLauncherCleanSync(acct, made.jobId);
        removeTree(made.dir);
      }
    }
  }

  /** Copies the inputs into the working folder, checked against their stored hash. Local name → what was copied. */
  private copyInputs(
    store: FileStore,
    inputs: readonly FileRow[],
    workdir: string,
  ): Map<string, { fileId: string; bytes: number; sha256: string }> {
    const taken = new Set<string>([".tmp"]);
    const out = new Map<string, { fileId: string; bytes: number; sha256: string }>();
    for (const f of inputs) {
      const name = localName(f.name, taken);
      const fd = store.open(f);
      if (fd === undefined) throw new PythonError("python_file_not_found");
      try {
        if (!writeInputCopy(fd, path.join(workdir, name), f.bytes, f.sha256))
          throw new PythonError("python_file_not_found");
      } finally {
        fs.closeSync(fd);
      }
      out.set(name, { fileId: f.id, bytes: f.bytes, sha256: f.sha256 });
    }
    return out;
  }

  /** The text of the run as the model gets it: server paths out, known secrets out (all of it, before any cut). */
  /**
   * `cut`: the text ends where the interpreter's capture limit cut it — then a secret the cut left only the start of
   * is masked too (`scrubKnown`'s tail rule). A text that is whole is scrubbed without that rule (review #121 round
   * 1: the rule masked an intact `customer-2026` because a secret `customer-2026-private-…` starts with it).
   */
  private cleaner(job: PythonJob): (t: string, cut?: boolean) => string {
    const paths: [string, string][] = [
      [job.workdir, "."],
      ...(job.env.packages ? ([[job.env.packages, "<packages>"]] as [string, string][]) : []),
      [SCRATCHPAD_DIR, "<runner>"],
      [job.env.runtime.root, "<python>"],
      [storagePaths(this.opts.dataDir).root, "<data>"],
    ];
    return (t, cut = false) =>
      scrubKnown(
        paths.reduce((s, [p, w]) => s.split(p).join(w), t),
        { tail: cut },
      );
  }

  private async answer(
    store: FileStore,
    scope: ToolScope,
    messageId: string,
    job: PythonJob,
    report: PythonReport,
    copies: Map<string, { fileId: string; bytes: number; sha256: string }>,
  ): Promise<PythonRunOutput> {
    const clean = this.cleaner(job);
    const frame = (source: string, t: string) => (t ? frameExternal({ source, content: t }) : "");
    // Cut by the interpreter when it counted more than it kept (code points, as Python counts them).
    const stdoutCaptureCut = report.stdoutChars > Array.from(report.stdout).length;
    const stderrCaptureCut = report.stderrChars > Array.from(report.stderr).length;
    const stdoutAll = clean(report.stdout, stdoutCaptureCut);
    const stdout = cut(stdoutAll, PYTHON_LIMITS.stdoutChars);
    const stderr = cut(clean(report.stderr, stderrCaptureCut), PYTHON_LIMITS.stderrChars, true);
    const out: PythonRunOutput = {
      status: report.status,
      exitCode: report.exitCode,
      stdout: frame("python_run stdout", stdout.text),
      // Cut here, or already by the interpreter's capture limit (it counts what it did not keep).
      stdoutTruncated: stdout.cut || stdoutCaptureCut,
      stdoutChars: report.stdoutChars,
      stderr: frame("python_run stderr", stderr.text),
      stderrTruncated: stderr.cut || stderrCaptureCut,
      files: [],
      skipped: [],
    };
    if (report.status === "error")
      out.error = {
        type: report.errorType && ERROR_TYPE.test(report.errorType) ? report.errorType : "Error",
        traceback: frame(
          "python_run traceback",
          cut(clean(report.traceback ?? ""), PYTHON_LIMITS.stderrChars, true).text,
        ),
      };

    let full = false;
    const skip = (name: string, reason: PythonSkipReason) => {
      if (out.skipped.length < PYTHON_LIMITS.skippedListed)
        out.skipped.push({ name: scrubKnown(name.split("/").map(cleanName).join("/")) || "file", reason });
    };
    const register = async (
      name: string,
      kind: FileKind,
      text: string,
    ): Promise<PythonFileOut | undefined> => {
      const data = Buffer.from(text, "utf8");
      const tmp = store.tempFile();
      try {
        fs.writeFileSync(tmp, data, { flag: "wx", mode: 0o600 });
        if (!contentMatches(tmp, kind)) {
          skip(name, "not_text");
          return undefined;
        }
        const row = await store.addGenerated({
          userId: scope.userId,
          conversationId: scope.conversationId,
          messageId,
          name,
          kind,
          bytes: data.length,
          sha256: crypto.createHash("sha256").update(data).digest("hex"),
          tmp,
        });
        return {
          fileId: row.id,
          name: row.name,
          kind,
          bytes: row.bytes,
          url: `/api/files/${row.id}/content`,
        };
      } catch (e) {
        if (e instanceof FileLimitError) {
          full = true;
          skip(name, "conversation_full");
          return undefined;
        }
        // The reply or the conversation went while the code ran (their foreign keys).
        if ((e as { code?: unknown }).code === "SQLITE_CONSTRAINT_FOREIGNKEY")
          throw new PythonError("python_not_allowed");
        throw e;
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    };

    // Outputs may be owned by the dedicated account (it ran the code); inputs the server copied are the server's.
    // Anything owned by a third uid is rejected (a file planted across the uid boundary).
    const allowed = new Set<number>([process.getuid?.() ?? -1]);
    if (job.env.accountUid !== undefined) allowed.add(job.env.accountUid);
    for (const c of collectOutputs(job.workdir, copies, skip, allowed)) {
      if (full) {
        skip(c.rel, "conversation_full");
        continue;
      }
      if (out.files.length >= PYTHON_LIMITS.outputFiles) {
        skip(c.rel, "too_many");
        continue;
      }
      const f = await register(path.basename(c.rel), c.kind, clean(c.text));
      if (f) out.files.push(f);
    }
    if (out.stdoutTruncated && stdoutAll && !full) {
      const f = await register("python-output.txt", "txt", stdoutAll);
      if (f) out.outputFile = f;
    }
    // Last pass over everything (names included): nothing that is a secret now goes back.
    return scrubKnownDeep(out, { tail: false });
  }
}

/**
 * The work folder of a fresh job: `<scratch>/<jobId>` (jobId a UUID — the only token the launcher takes). The
 * root is a plain folder (never a link); the job dir is created fresh and owner-only (the account reaches it
 * through the scratch ACL). Returns the job id and the resolved folder.
 */
export function makeJobWorkdir(dataDir: string): { jobId: string; dir: string } {
  const root = scratchRoot(dataDir);
  let rootSt = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!rootSt) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    rootSt = fs.lstatSync(root);
  }
  if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) throw new PythonError("python_unavailable");
  const jobId = crypto.randomUUID();
  const dir = jobWorkdir(dataDir, jobId);
  if (fs.lstatSync(dir, { throwIfNoEntry: false })) throw new PythonError("python_unavailable"); // fresh only
  fs.mkdirSync(dir, { mode: 0o700 });
  const real = fs.realpathSync.native(dir);
  fs.mkdirSync(path.join(real, ".tmp"), { mode: 0o700 });
  return { jobId, dir: real };
}

/**
 * Writes one input copy into a working folder exactly as a real call does: a new server-owned file (`O_EXCL`, mode
 * 0600 — the account reads it through the scratch ACL), the bytes of `fd`, checked against the expected size and
 * SHA-256. False when they do not match. Shared with the account self-check (#121 round 8).
 */
export function writeInputCopy(fd: number, dest: string, bytes: number, sha256: string): boolean {
  let wfd: number | undefined;
  try {
    wfd = fs.openSync(dest, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    const hash = crypto.createHash("sha256");
    const buf = Buffer.alloc(1024 * 1024);
    let at = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, at);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
      fs.writeSync(wfd, buf, 0, n);
      at += n;
    }
    return at === bytes && hash.digest("hex") === sha256;
  } finally {
    if (wfd !== undefined) fs.closeSync(wfd);
  }
}

/**
 * The new or changed text files of the working folder, in name order — read through a no-follow open, a plain
 * file with one link only (a hard link could be someone else's file), at most `outputBytes`, valid UTF-8 without
 * NUL. Hidden entries (`.tmp` …) are not looked at; an input copy left as it was is not an output.
 */
export function collectOutputs(
  workdir: string,
  copies: Map<string, { bytes: number; sha256: string }>,
  skip: (name: string, reason: PythonSkipReason) => void,
  allowedUids: ReadonlySet<number>,
): { rel: string; kind: FileKind; text: string }[] {
  const found: { rel: string; kind: FileKind; text: string }[] = [];
  let seen = 0;
  const walk = (dir: string, rel: string, depth: number) => {
    let names: string[];
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (n.startsWith(".")) continue;
      if (++seen > PYTHON_LIMITS.workEntries) return;
      const p = path.join(dir, n);
      const r = rel ? `${rel}/${n}` : n;
      const st = fs.lstatSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isSymbolicLink()) {
        skip(r, "link");
        continue;
      }
      if (st.isDirectory()) {
        if (depth < MAX_DEPTH) walk(p, r, depth + 1);
        else skip(r, "too_deep");
        continue;
      }
      const file = readOutput(p, r, copies.get(r), skip, allowedUids);
      if (file) found.push(file);
    }
  };
  walk(workdir, "", 1);
  return found;
}

function readOutput(
  p: string,
  rel: string,
  copy: { bytes: number; sha256: string } | undefined,
  skip: (name: string, reason: PythonSkipReason) => void,
  allowedUids: ReadonlySet<number>,
): { rel: string; kind: FileKind; text: string } | undefined {
  let fd: number;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    skip(rel, "link");
    return undefined;
  }
  try {
    const st = fs.fstatSync(fd);
    // A plain file, one link only (no hard link to another file), owned by the server or the account — never a
    // third uid (review #121 round 2). O_NOFOLLOW above already refused a symlink.
    if (!st.isFile() || st.nlink !== 1 || !allowedUids.has(st.uid)) {
      skip(rel, "link");
      return undefined;
    }
    // An input copy left as it was: not an output (and not worth a word).
    const unchangedSize = copy && copy.bytes === st.size;
    const kind = fileKindOf(rel);
    if (!unchangedSize && (!kind || !OUTPUT_KINDS.has(kind))) {
      skip(rel, "unsupported_kind");
      return undefined;
    }
    if (st.size > PYTHON_LIMITS.outputBytes) {
      skip(rel, "too_large");
      return undefined;
    }
    const buf = Buffer.alloc(st.size);
    let at = 0;
    while (at < buf.length) {
      const n = fs.readSync(fd, buf, at, buf.length - at, at);
      if (n <= 0) break;
      at += n;
    }
    const data = buf.subarray(0, at);
    if (copy && copy.bytes === at && crypto.createHash("sha256").update(data).digest("hex") === copy.sha256)
      return undefined;
    if (!kind || !OUTPUT_KINDS.has(kind)) {
      skip(rel, "unsupported_kind");
      return undefined;
    }
    let text: string;
    try {
      text = UTF8.decode(data);
    } catch {
      skip(rel, "not_text");
      return undefined;
    }
    if (!text || text.includes("\0")) {
      skip(rel, "not_text");
      return undefined;
    }
    return { rel, kind: kind as FileKind, text };
  } finally {
    fs.closeSync(fd);
  }
}
