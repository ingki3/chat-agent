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
import { FileLimitError, type FileRow, type FileStore } from "../files/store.js";
import { removeTree, writeInputCopy } from "../python/service.js";
import { scrubKnown, scrubKnownDeep } from "../secrets/known.js";
import { storagePaths } from "../storage/paths.js";
import { mergeTranscript, transcriptMarkdown, type TranscriptSegment } from "./merge.js";
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
  fallback: { switch: AudioFallbackSwitch; client?: FallbackClient | undefined };
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
  segmentsTruncated: boolean;
  transcriptFile?: AudioFileOut;
};

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
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

  async run(scope: ToolScope, input: Record<string, unknown>): Promise<SkillResult> {
    try {
      return { ok: true, output: await this.execute(scope, input) };
    } catch (e) {
      if (e instanceof AudioError) return { ok: false, code: e.code };
      throw e;
    }
  }

  private async execute(scope: ToolScope, raw: Record<string, unknown>): Promise<AudioTranscribeOutput> {
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

    const mine = this.byUser.get(scope.userId) ?? 0;
    const limits = this.opts.slots ?? AUDIO_SLOTS;
    if (this.running >= limits.total || mine >= limits.perUser) throw new AudioError("audio_busy");
    this.running++;
    this.byUser.set(scope.userId, mine + 1);
    let workdir: string | undefined;
    try {
      workdir = makeAudioWorkdir(this.opts.dataDir);
      const input = this.copyInput(store, f, workdir);
      return await this.transcribe(store, scope, messageId, f, req, ready.env, workdir, input);
    } finally {
      this.running--;
      const left = (this.byUser.get(scope.userId) ?? 1) - 1;
      if (left > 0) this.byUser.set(scope.userId, left);
      else this.byUser.delete(scope.userId);
      if (workdir) removeTree(workdir);
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
  ): Promise<AudioTranscribeOutput> {
    // The server shutting down, or the whole call over its budget.
    const budget = AbortSignal.timeout(AUDIO_LIMITS.callTimeoutMs);
    const signal = AbortSignal.any([this.stop.signal, budget]);
    const over = () => new AudioError(budget.aborted ? "audio_timeout" : "audio_unavailable");
    const runner = this.opts.runner;
    const converted = await runner.convert({ env, workdir, input }, signal);
    if (signal.aborted) throw over();
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
      if (signal.aborted) throw over();
      diarization = d.ok ? "local" : "failed";
      if (d.ok) turns = d.turns;
    }

    let stt: AudioSttEngine = "local";
    let words: Segment[];
    const local = await runner.transcribe(job, signal);
    if (signal.aborted) throw over();
    if (local.ok) words = local.segments;
    else {
      const client = this.opts.fallback.client;
      if (!client || !this.opts.fallback.switch.enabled()) throw new AudioError(local.code);
      words = await this.viaOpenRouter(client, job, signal);
      if (signal.aborted) throw over();
      stt = "openrouter";
    }

    const external = stt === "openrouter";
    const merged = mergeTranscript(words, turns, {
      ...(req.maxSpeakers ? { maxSpeakers: req.maxSpeakers } : {}),
      maxChars: AUDIO_LIMITS.segmentChars,
    });
    // Known secrets out of every word before anything is stored or handed back.
    const segments: TranscriptSegment[] = merged.segments.map((s) => ({
      speaker: s.speaker,
      start: round(s.start),
      end: round(s.end),
      text: scrubKnown(s.text, { tail: false }),
    }));
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
    };
    const file = await this.store(store, scope, messageId, f, segments, {
      durationSeconds: converted.seconds,
      speakers: merged.speakers,
      external,
      notice: AUDIO_EXTERNAL_NOTICE,
    });
    if (file) out.transcriptFile = file;
    return scrubKnownDeep(out, { tail: false });
  }

  /** The words through OpenRouter: the WAV in MP3 pieces, one request each, times shifted to the whole recording. */
  private async viaOpenRouter(
    client: FallbackClient,
    job: {
      env: Extract<AudioState, { state: "available" }>["env"];
      workdir: string;
      wav: string;
      language: string;
    },
    signal: AbortSignal,
  ): Promise<Segment[]> {
    const pieces = await this.opts.runner.chunks(job, signal);
    if (!pieces.ok) throw new AudioError("audio_fallback_failed");
    const words: Segment[] = [];
    for (const [i, c] of pieces.chunks.entries()) {
      if (signal.aborted) throw new AudioError("audio_timeout");
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
      const r = await client({ data, index: i }, { language: job.language, signal });
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
  ): Promise<AudioFileOut | undefined> {
    const base = f.name.replace(/\.[^.]*$/, "") || "audio";
    let text = transcriptMarkdown(base, segments, meta);
    // Over the size (a very long recording): cut whole characters off the end. The words are already scrubbed.
    while (Buffer.byteLength(text) > AUDIO_LIMITS.transcriptBytes) {
      const cps = Array.from(text);
      text = cps.slice(0, Math.floor(cps.length * 0.9)).join("");
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
      });
      this.opts.extract?.(row.id);
      return { fileId: row.id, name: row.name, bytes: row.bytes, url: `/api/files/${row.id}/content` };
    } catch (e) {
      if (e instanceof FileLimitError) return undefined;
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
