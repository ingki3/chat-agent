import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { SkillResult, ToolScope } from "@agentlee/mcp-tools";
import { AUDIO_TRANSCRIBE_TOOL } from "@agentlee/mcp-tools/audio";
import {
  AUDIO_EXTERNAL_NOTICE,
  AUDIO_FILE_KINDS,
  AUDIO_LIMITS,
  frameExternal,
  type AudioCode,
  type AudioSttEngine,
} from "@agentlee/shared";
import type { Db } from "../db/client.js";
import type { SettingsStore } from "../db/settings-store.js";
import { conversations, messages, runs } from "../db/schema.js";
import { FileAddCancelledError, FileLimitError, type FileRow, type FileStore } from "../files/store.js";
import { removeTree, writeInputCopy } from "../python/service.js";
import { scrubKnown, scrubKnownDeep } from "../secrets/known.js";
import { storagePaths } from "../storage/paths.js";
import { mergeTranscript, splitLong, transcriptMarkdown, type TranscriptSegment } from "./merge.js";
import { folderUsage } from "../python/runner.js";
import type { FallbackClient } from "./openrouter.js";
import type { AudioState } from "./packages.js";
import { workFolders, type AudioRunner, type Segment, type SpeakerTurn } from "./runner.js";

/**
 * `audio_transcribe` (#173): checks the request, copies the conversation's audio file into a working folder made for
 * this call, has ffmpeg turn it into a 16 kHz mono WAV, finds the speaker turns (Nemotron) and the timed words (MLX
 * Whisper) on this Mac, merges them by time, and stores the transcript as a markdown file of the conversation,
 * linked to the reply of the run.
 *
 * - Scope and inputs exactly as `python_run` (#47): the user's own conversation, the run's reply still there, a
 *   file of that conversation sent with a message still in the history, read through the store's checked open and
 *   checked against its stored hash — never a path or a URL.
 * - Local first. Only when the **local Whisper** fails (an error, a crash, a time or memory limit) and the admin's
 *   fallback switch is on with `OPENROUTER_API_KEY` set, the WAV goes to OpenRouter (`openai/whisper-large-v3`) in
 *   MP3 pieces; the answer then says so (`stt: "openrouter"`, `externalTranscription`, `notice`). Speaker turns are
 *   always local — a diarization failure leaves the words without speakers (`diarization: "failed"`).
 * - The words come from an uploaded recording: they reach the model inside an `<external_content>` block, and every
 *   known secret is taken out first. Nothing of the content is logged (the MCP service logs a fixed code).
 * - One transcription at a time on the whole server (the GPU and several GB of memory) — over it, `audio_busy`.
 */
export const AUDIO_SLOTS = { total: 1, perUser: 1 } as const;

class AudioError extends Error {
  constructor(readonly code: AudioCode) {
    super(code);
  }
}

/** The admin's switch for the OpenRouter fallback (off unless turned on), stored in settings. */
export class AudioFallbackSwitch {
  static readonly KEY = "audio.fallback";
  constructor(private readonly settings?: Pick<SettingsStore, "get" | "set">) {}
  enabled(): boolean {
    return this.settings?.get(AudioFallbackSwitch.KEY) === "on";
  }
  set(on: boolean): void {
    this.settings?.set(AudioFallbackSwitch.KEY, on ? "on" : "off");
  }
}

export type AudioServiceOptions = {
  db: Db;
  dataDir: string;
  files: () => FileStore | undefined;
  runner: AudioRunner;
  state: () => AudioState;
  /** The fallback: the admin's switch, and the client when `OPENROUTER_API_KEY` is set. */
  fallback: {
    switch: AudioFallbackSwitch;
    client?: FallbackClient | undefined;
    /** Whether this user may still use the skill (checked before every piece is sent). */
    allowed?: ((scope: ToolScope) => boolean) | undefined;
  };
  /** How often a running call checks the run, the switch and its folder (tests lower it). */
  watchMs?: number;
  /** Tests only: replaces the working-folder measurement. */
  measure?: typeof folderUsage;
  /** Reads the stored transcript's text in the background (#48), so `file_read` has it at once. */
  extract?: (fileId: string) => void;
  slots?: { total: number; perUser: number };
};

export type AudioFileOut = { fileId: string; name: string; bytes: number; url: string };

export type AudioTranscribeOutput = {
  status: "ok";
  stt: AudioSttEngine;
  externalTranscription: boolean;
  notice?: string;
  diarization: "local" | "off" | "failed";
  language: string;
  durationSeconds: number;
  speakers: number;
  /** A JSON array of `{speaker, start, end, text}` inside an `<external_content>` block (the first ones). */
  segments: string;
  segmentCount: number;
  /** `segments` holds only the first `AUDIO_LIMITS.segments` of `segmentCount`. */
  segmentsTruncated: boolean;
  /** The stored transcript left whole segments off its end (over `AUDIO_LIMITS.transcriptBytes`). */
  transcriptTruncated: boolean;
  transcriptFile?: AudioFileOut;
};

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const WATCH_MS = 250;

type CallContext = {
  /** Aborted when the call must stop: the steps kill their process group, a request in flight is aborted. */
  signal: AbortSignal;
  /** Throws the reason when the call must stop (checks the run and the fallback switch once more). */
  check: () => void;
  /** Starts watching the fallback's own conditions (the switch and the user's permission). */
  fallbackPhase: (on: () => boolean) => void;
};

/** Free bytes of the volume holding DATA_DIR (its nearest existing folder). */
function freeBytes(dataDir: string): number {
  let dir = path.resolve(dataDir);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  try {
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
const KINDS: ReadonlySet<string> = new Set(AUDIO_FILE_KINDS);
const round = (n: number) => Math.round(n * 100) / 100;

export class AudioTranscriber {
  private running = 0;
  private readonly byUser = new Map<string, number>();
  private readonly stop = new AbortController();

  constructor(private readonly opts: AudioServiceOptions) {}

  /** The admin's view (FR-10.3): available, or why not. */
  state(): AudioState["state"] {
    return this.opts.state().state;
  }

  /** The fallback as the admin sees it: switched on, and whether a key is configured. */
  fallback(): { enabled: boolean; keyConfigured: boolean } {
    return { enabled: this.opts.fallback.switch.enabled(), keyConfigured: !!this.opts.fallback.client };
  }

  setFallback(on: boolean): void {
    this.opts.fallback.switch.set(on);
  }

  /** Removes the working folders left by an earlier process (server start). Never throws. */
  sweep(): boolean {
    const root = storagePaths(this.opts.dataDir).audioScratch;
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      return true;
    }
    let ok = true;
    for (const n of names) if (!removeTree(path.join(root, n))) ok = false;
    return ok;
  }

  close(): void {
    this.stop.abort();
  }

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

  /**
   * One call. `o.signal`: the caller's own stop (the MCP service aborts it when the run ends). `o.alive`: whether the
   * run may still have this result — checked every `WATCH_MS` (a false stops every step: the process group is
   * killed and the working folder removed before this returns), and again right before anything is sent outside
   * and before anything is stored. Default: the run has not ended.
   */
  async run(
    scope: ToolScope,
    input: Record<string, unknown>,
    o: { signal?: AbortSignal | undefined; alive?: (() => boolean) | undefined } = {},
  ): Promise<SkillResult> {
    try {
      return { ok: true, output: await this.execute(scope, input, o) };
    } catch (e) {
      if (e instanceof AudioError) return { ok: false, code: e.code };
      throw e;
    }
  }

  /** The run has not ended (finished, interrupted, failed). */
  private runOpen(scope: ToolScope): boolean {
    const r = this.opts.db.select({ endedAt: runs.endedAt }).from(runs).where(eq(runs.id, scope.runId)).get();
    return !!r && r.endedAt === null;
  }

  private async execute(
    scope: ToolScope,
    raw: Record<string, unknown>,
    o: { signal?: AbortSignal | undefined; alive?: (() => boolean) | undefined },
  ): Promise<AudioTranscribeOutput> {
    const parsed = z.strictObject(AUDIO_TRANSCRIBE_TOOL.input).safeParse(raw);
    if (!parsed.success) throw new AudioError("audio_bad_input");
    const req = parsed.data as {
      fileId: string;
      language?: string;
      diarize?: boolean;
      maxSpeakers?: number;
      threshold?: number;
    };
    const ready = this.opts.state();
    if (ready.state !== "available") throw new AudioError("audio_not_installed");
    const store = this.opts.files();
    if (!store) throw new AudioError("audio_unavailable");
    const messageId = this.replyOf(scope);
    if (!messageId || !SAFE_ID.test(scope.userId) || !SAFE_ID.test(scope.conversationId))
      throw new AudioError("audio_not_allowed");
    const f = store.get(req.fileId);
    // Another user's or conversation's file, an unsent one, one of a message no longer in the history: the same
    // answer as a file that does not exist.
    if (
      !f ||
      f.userId !== scope.userId ||
      f.conversationId !== scope.conversationId ||
      !store.isActiveAttachment(f)
    )
      throw new AudioError("audio_file_not_found");
    if (!KINDS.has(f.kind)) throw new AudioError("audio_unsupported_kind");
    const alive = () => this.runOpen(scope) && (o.alive?.() ?? true);
    if (!alive() || o.signal?.aborted) throw new AudioError("audio_cancelled");
    if (freeBytes(this.opts.dataDir) < AUDIO_LIMITS.minFreeBytes) throw new AudioError("audio_disk_limit");

    const mine = this.byUser.get(scope.userId) ?? 0;
    const limits = this.opts.slots ?? AUDIO_SLOTS;
    if (this.running >= limits.total || mine >= limits.perUser) throw new AudioError("audio_busy");
    this.running++;
    this.byUser.set(scope.userId, mine + 1);
    let workdir: string | undefined;
    // Why this call was stopped (the first reason wins); the steps see one signal.
    const stop = new AbortController();
    let why: AudioCode | undefined;
    const halt = (code: AudioCode) => {
      why ??= code;
      stop.abort();
    };
    const budget = setTimeout(() => halt("audio_timeout"), AUDIO_LIMITS.callTimeoutMs);
    const onShutdown = () => halt("audio_unavailable");
    const onCaller = () => halt("audio_cancelled");
    this.stop.signal.addEventListener("abort", onShutdown, { once: true });
    o.signal?.addEventListener("abort", onCaller, { once: true });
    let fallbackOn: (() => boolean) | undefined;
    // The working folder: over its size or entry budget — or not measurable at all (a folder made unreadable) —
    // stops the call. Fail closed: what cannot be measured cannot be bounded.
    const measure = this.opts.measure ?? folderUsage;
    const folderOk = () => {
      if (!workdir) return true;
      try {
        const u = measure(workdir, AUDIO_LIMITS.workBytes, AUDIO_LIMITS.workEntries);
        return !u.blocked && u.bytes <= AUDIO_LIMITS.workBytes && u.entries <= AUDIO_LIMITS.workEntries;
      } catch {
        return false;
      }
    };
    const look = () => {
      if (why) return;
      try {
        if (!alive()) return halt("audio_cancelled");
        if (fallbackOn && !fallbackOn()) return halt("audio_failed");
      } catch {
        return halt("audio_cancelled");
      }
      if (!folderOk()) halt("audio_disk_limit");
    };
    // Never throws out of the timer: any failure to check stops this call only.
    const watch = setInterval(look, this.opts.watchMs ?? WATCH_MS);
    const ctx: CallContext = {
      signal: stop.signal,
      // After every step too: a folder that went over between two looks is still over.
      check: () => {
        look();
        if (why) throw new AudioError(why);
      },
      fallbackPhase: (on) => (fallbackOn = on),
    };
    try {
      workdir = makeAudioWorkdir(this.opts.dataDir);
      const input = this.copyInput(store, f, workdir);
      return await this.transcribe(store, scope, messageId, f, req, ready.env, workdir, input, ctx);
    } catch (e) {
      // A step that failed because it was stopped answers with why it was stopped.
      if (why) throw new AudioError(why);
      throw e;
    } finally {
      clearInterval(watch);
      clearTimeout(budget);
      this.stop.signal.removeEventListener("abort", onShutdown);
      o.signal?.removeEventListener("abort", onCaller);
      // The steps have returned: their process groups are gone. The folder goes before the slot is free.
      if (workdir) removeTree(workdir);
      this.running--;
      const left = (this.byUser.get(scope.userId) ?? 1) - 1;
      if (left > 0) this.byUser.set(scope.userId, left);
      else this.byUser.delete(scope.userId);
    }
  }

  private copyInput(store: FileStore, f: FileRow, workdir: string): string {
    const ext = f.kind === "mp4" ? "mp4" : f.kind;
    const dest = path.join(workFolders(workdir).in, `input.${ext}`);
    const fd = store.open(f);
    if (fd === undefined) throw new AudioError("audio_file_not_found");
    try {
      if (!writeInputCopy(fd, dest, f.bytes, f.sha256)) throw new AudioError("audio_file_not_found");
    } finally {
      fs.closeSync(fd);
    }
    return dest;
  }

  private async transcribe(
    store: FileStore,
    scope: ToolScope,
    messageId: string,
    f: FileRow,
    req: { language?: string; diarize?: boolean; maxSpeakers?: number; threshold?: number },
    env: Extract<AudioState, { state: "available" }>["env"],
    workdir: string,
    input: string,
    ctx: CallContext,
  ): Promise<AudioTranscribeOutput> {
    const { signal } = ctx;
    const runner = this.opts.runner;
    const converted = await runner.convert({ env, workdir, input }, signal);
    ctx.check();
    if (!converted.ok) throw new AudioError(converted.code);
    if (converted.seconds > AUDIO_LIMITS.maxSeconds) throw new AudioError("audio_too_long");
    if (converted.seconds < 0.1) throw new AudioError("audio_empty");
    const language = req.language ?? "ko";
    const job = {
      env,
      workdir,
      wav: converted.wav,
      language,
      threshold: req.threshold ?? AUDIO_LIMITS.threshold.default,
    };

    let turns: SpeakerTurn[] | undefined;
    let diarization: AudioTranscribeOutput["diarization"] = "off";
    if (req.diarize !== false) {
      const d = await runner.diarize(job, signal);
      ctx.check();
      diarization = d.ok ? "local" : "failed";
      if (d.ok) turns = d.turns;
    }

    let stt: AudioSttEngine = "local";
    let words: Segment[];
    const local = await runner.transcribe(job, signal);
    ctx.check();
    if (local.ok) words = local.segments;
    else {
      const client = this.opts.fallback.client;
      const sw = this.opts.fallback.switch;
      if (!client || !sw.enabled()) throw new AudioError(local.code);
      // From here on the switch is watched too: turned off, the request in flight is aborted.
      ctx.fallbackPhase(() => sw.enabled() && (this.opts.fallback.allowed?.(scope) ?? true));
      words = await this.viaOpenRouter(client, job, ctx);
      // Every piece is back: the switch no longer matters for storing what was already received.
      ctx.fallbackPhase(() => true);
      stt = "openrouter";
    }

    const external = stt === "openrouter";
    // Known secrets out of every whole text first — before anything joins, splits or shortens it.
    const clean = words.map((w) => ({ ...w, text: scrubKnown(w.text, { tail: false }) }));
    const merged = mergeTranscript(clean, turns, {
      ...(req.maxSpeakers ? { maxSpeakers: req.maxSpeakers } : {}),
      maxChars: AUDIO_LIMITS.segmentChars,
    });
    const segments: TranscriptSegment[] = splitLong(
      merged.segments.map((s) => ({ ...s, text: scrubKnown(s.text, { tail: false }) })),
      AUDIO_LIMITS.segmentChars,
    ).map((s) => ({ ...s, start: round(s.start), end: round(s.end) }));
    const shown = segments.slice(0, AUDIO_LIMITS.segments);
    const out: AudioTranscribeOutput = {
      status: "ok",
      stt,
      externalTranscription: external,
      ...(external ? { notice: AUDIO_EXTERNAL_NOTICE } : {}),
      diarization,
      language,
      durationSeconds: round(converted.seconds),
      speakers: merged.speakers,
      segments: frameExternal({ source: "audio_transcribe", content: JSON.stringify(shown) }),
      segmentCount: segments.length,
      segmentsTruncated: shown.length < segments.length,
      transcriptTruncated: false,
    };
    // Last look before anything is stored: the run may have ended meanwhile.
    ctx.check();
    const file = await this.store(
      store,
      scope,
      messageId,
      f,
      segments,
      {
        durationSeconds: converted.seconds,
        speakers: merged.speakers,
        external,
        notice: AUDIO_EXTERNAL_NOTICE,
      },
      ctx,
    );
    if (file) {
      out.transcriptTruncated = file.truncated;
      out.transcriptFile = { fileId: file.fileId, name: file.name, bytes: file.bytes, url: file.url };
    }
    return scrubKnownDeep(out, { tail: false });
  }

  /**
   * The words through OpenRouter: the WAV in MP3 pieces, one request each, times shifted to the whole recording.
   * Before every piece: the run still open, the user still allowed, the switch still on (`ctx.check`); a change while
   * a piece is in flight aborts that request (the watch).
   */
  private async viaOpenRouter(
    client: FallbackClient,
    job: {
      env: Extract<AudioState, { state: "available" }>["env"];
      workdir: string;
      wav: string;
      language: string;
    },
    ctx: CallContext,
  ): Promise<Segment[]> {
    const pieces = await this.opts.runner.chunks(job, ctx.signal);
    ctx.check();
    if (!pieces.ok) throw new AudioError("audio_fallback_failed");
    const words: Segment[] = [];
    for (const [i, c] of pieces.chunks.entries()) {
      ctx.check();
      let data: Buffer;
      try {
        const st = fs.lstatSync(c.file);
        if (!st.isFile() || st.nlink !== 1 || st.size > AUDIO_LIMITS.fallbackChunkBytes)
          throw new AudioError("audio_fallback_failed");
        data = fs.readFileSync(c.file);
      } catch (e) {
        if (e instanceof AudioError) throw e;
        throw new AudioError("audio_fallback_failed");
      }
      ctx.check();
      const r = await client({ data, index: i }, { language: job.language, signal: ctx.signal });
      ctx.check();
      if (!r.ok) throw new AudioError("audio_fallback_failed");
      for (const s of r.segments)
        words.push({ start: s.start + c.start, end: s.end + c.start, text: s.text });
    }
    return words;
  }

  /** The transcript as a markdown file of the conversation, linked to the run's reply. Undefined when full. */
  private async store(
    store: FileStore,
    scope: ToolScope,
    messageId: string,
    f: FileRow,
    segments: readonly TranscriptSegment[],
    meta: { durationSeconds: number; speakers: number; external: boolean; notice: string },
    ctx: CallContext,
  ): Promise<(AudioFileOut & { truncated: boolean }) | undefined> {
    const base = f.name.replace(/\.[^.]*$/, "") || "audio";
    let text = transcriptMarkdown(base, segments, meta);
    // Over the size (a very long recording): whole segments are left off the end, and the file says so. The words
    // were scrubbed whole before this.
    let kept = segments.length;
    let truncated = false;
    while (Buffer.byteLength(text) > AUDIO_LIMITS.transcriptBytes && kept > 0) {
      kept = Math.floor(kept * 0.9);
      truncated = true;
      text = transcriptMarkdown(base, segments.slice(0, kept), meta);
      text += `\n_(대본이 너무 길어 ${kept}/${segments.length} 구간까지만 담았어요)_\n`;
    }
    text = scrubKnown(text, { tail: false });
    const data = Buffer.from(text, "utf8");
    const tmp = store.tempFile();
    try {
      fs.writeFileSync(tmp, data, { flag: "wx", mode: 0o600 });
      const row = await store.addGenerated({
        userId: scope.userId,
        conversationId: scope.conversationId,
        messageId,
        name: `${base}-대본.md`,
        kind: "md",
        bytes: data.length,
        sha256: crypto.createHash("sha256").update(data).digest("hex"),
        tmp,
        // Inside the file-write lock (it may have waited behind a backup): the run must still be open, the user
        // still allowed — otherwise nothing is stored.
        guard: () => {
          try {
            ctx.check();
            return true;
          } catch {
            return false;
          }
        },
      });
      this.opts.extract?.(row.id);
      return {
        fileId: row.id,
        name: row.name,
        bytes: row.bytes,
        url: `/api/files/${row.id}/content`,
        truncated,
      };
    } catch (e) {
      if (e instanceof FileLimitError) return undefined;
      if (e instanceof FileAddCancelledError) throw new AudioError("audio_cancelled");
      if ((e as { code?: unknown }).code === "SQLITE_CONSTRAINT_FOREIGNKEY")
        throw new AudioError("audio_not_allowed");
      throw e;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
}

/** A fresh, owner-only working folder `audio-scratch/<uuid>` with its `in/` (resolved, never a link). */
export function makeAudioWorkdir(dataDir: string): string {
  const root = storagePaths(dataDir).audioScratch;
  let st = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!st) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    st = fs.lstatSync(root);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new AudioError("audio_unavailable");
  const dir = path.join(root, crypto.randomUUID());
  fs.mkdirSync(dir, { mode: 0o700 });
  const real = fs.realpathSync.native(dir);
  fs.mkdirSync(path.join(real, "in"), { mode: 0o700 });
  return real;
}
