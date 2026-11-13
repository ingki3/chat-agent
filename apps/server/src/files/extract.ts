import { CLEANUP_PENDING_KEY, setKey } from "../secrets/markers.js";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import {
  ExtractCode,
  OcrState,
  type ExtractStatus,
  type FileExtract,
  type FileKind,
  type UnitLocator,
} from "@agentlee/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { fileExtracts, fileSegments } from "../db/schema.js";
import { runIsolated, type RunIsolatedOptions, type RunResult } from "../isolation/sandbox.js";
import { logEvent, type EventLogger } from "../logging.js";
import { knownSecrets, scrubKnownDeep, type KnownSecrets } from "../secrets/known.js";
import { capText, capUnit, parseMarks, scrubFile, type ScrubbedSegment } from "./scrub.js";

/** Characters of an XLSX sheet name kept (after it was scrubbed whole). */
const MAX_SHEET_NAME = 200;
import type { FileRow, FileStore } from "./store.js";

/**
 * Text extraction of uploads (#48, PRD FR-4.2·4.3): every stored file is read once by the extractor
 * (`apps/server/extract/worker.mjs`) in its own sandboxed process (#42) — read access to that one file, the
 * worker's folder, the pinned libraries it imports and the OCR language data; no writes, no network, no child
 * processes, no inherited environment; time, memory and output limits (`EXTRACT_LIMITS`). Its result — text units
 * with locators — is stored in `file_extracts` / `file_segments` (scrubbed of known secrets), where the file tools
 * read it.
 *
 * Extraction runs in the background, one file at a time, in upload order. A file whose row is still `pending`
 * at start (a server that stopped mid-way) is tried again, at most `MAX_ATTEMPTS` times in all. A newer extractor
 * (`EXTRACTOR_VERSION`) extracts every file again.
 */

/** Bumped whenever the worker's output changes: rows of an older version are extracted again. */
export const EXTRACTOR_VERSION = "extract-11";
const MAX_ATTEMPTS = 3;

/** Folder of the extractor (same from src/ and dist/). */
export const EXTRACT_WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../extract");
export const EXTRACT_WORKER_ENTRY = path.join(EXTRACT_WORKER_DIR, "worker.mjs");

/** Time and memory of one extraction: more for kinds that may need OCR (pictures, scanned PDFs). */
export const EXTRACT_LIMITS = {
  text: { timeoutMs: 60_000, maxRssBytes: 768 * 1024 * 1024 },
  ocr: { timeoutMs: 300_000, maxRssBytes: 1536 * 1024 * 1024 },
  /** stdout + stderr of the worker (the result is at most ~2M characters of text with its marks). */
  maxOutputBytes: 64 * 1024 * 1024,
};
const OCR_KINDS: ReadonlySet<FileKind> = new Set(["pdf", "png", "jpg"]);

/** What the worker answers. */
export type WorkerSegment = {
  unit: number;
  loc: UnitLocator;
  text: string;
  marks?: [number, number, Record<string, unknown>][];
  /** Text the extractor did not take follows right after this unit (`extract/segments.mjs` `boundary`). */
  endsEarly?: boolean;
  /**
   * Text the extractor read but leaves out (an HWP header, a hidden comment …, `Segments.hidden`, review #120): at
   * its place in the reading order, scrubbed with the kept units and then dropped — never stored, served or
   * logged. No `unit` or `loc`.
   */
  hidden?: true;
};

/** A kept unit after the scrub: its scrubbed text and marks, and what the store records about it. */
export type KeptSegment = { seg: WorkerSegment; scrubbed: ScrubbedSegment; gap: boolean; endsEarly: boolean };

/**
 * The one place a worker's units become the text anyone may see (the store, the injection evaluation — review
 * #120 3차): known secrets masked over the whole, uncut text in reading order — kept and hidden units together, in
 * one linear pass: a secret across two units, or between kept text and a part the extractor leaves out, either
 * way round, is found whole; the marks follow the replacements. (An HWPX `hp:case` is never read — its default is
 * ordinary text in this order; review #120 4차.) The cut-off-secret rule at each point the extractor left text out for a limit (`endsEarly`) —
 * and only there. Then the hidden units are dropped: only kept ones come out (a long unit is capped for display
 * only after this — review #107 6차).
 *
 * `gap`: the stored copy is not the whole text around it (next to hidden text): like a
 * capped unit it is never joined on read, and a secret registered later extracts the file again
 * (`reextractCut`) — scrubbed with the hidden text once more.
 */
export function keptSegments(segments: readonly WorkerSegment[], registry?: KnownSecrets): KeptSegment[] {
  const all = segments.filter(
    (seg) =>
      typeof seg?.text === "string" && (seg.hidden === true || (Number.isInteger(seg.unit) && !!seg.loc)),
  );
  const scrubbed = scrubFile(
    all.map((seg) => ({
      text: seg.text,
      marks: seg.hidden ? undefined : seg.marks,
      endsEarly: !!seg.endsEarly,
    })),
    registry,
  );
  const out: KeptSegment[] = [];
  for (const [i, seg] of all.entries()) {
    // Hidden text is dropped here, after the scrub.
    if (seg.hidden) continue;
    const gap = !!all[i - 1]?.hidden || !!all[i + 1]?.hidden;
    // The text after it ended early when a hidden unit right after it did (a limit cut there).
    const endsEarly = !!seg.endsEarly || (!!all[i + 1]?.hidden && !!all[i + 1]?.endsEarly);
    out.push({ seg, scrubbed: scrubbed[i]!, gap, endsEarly });
  }
  return out;
}
export type WorkerResult =
  | {
      ok: true;
      sha256: string;
      units: number | null;
      truncated: boolean;
      ocr: string;
      segments: WorkerSegment[];
    }
  | { ok: false; code: string };

export type ExtractJob = { file: FileRow; path: string; signal: AbortSignal };
/** Runs the extractor for one file. The default runs the worker in the sandbox. */
export type ExtractRunner = (job: ExtractJob) => Promise<WorkerResult>;

const require = createRequire(import.meta.url);

/**
 * The real folder of a package and of every package it needs (its dependencies, transitively), resolved from
 * this server's own install. With pnpm, each package's folder is `node_modules/.pnpm/<pkg>@<v>/node_modules/<pkg>`
 * next to links to its dependencies: the `node_modules` folder that holds both is what the sandbox may read.
 */
export function packageFolders(names: readonly string[]): string[] {
  const out = new Set<string>();
  const seen = new Set<string>();
  const visit = (name: string, from: NodeRequire) => {
    let pkgJson: string;
    try {
      pkgJson = fs.realpathSync(from.resolve(`${name}/package.json`));
    } catch {
      return;
    }
    if (seen.has(pkgJson)) return;
    seen.add(pkgJson);
    const dir = path.dirname(pkgJson);
    // `.pnpm/<id>/node_modules/<name>` (scoped: two levels) → `.pnpm/<id>/node_modules`; otherwise the folder.
    const up = name.startsWith("@") ? path.dirname(path.dirname(dir)) : path.dirname(dir);
    out.add(path.basename(up) === "node_modules" && up.includes(`${path.sep}.pnpm${path.sep}`) ? up : dir);
    const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const req = createRequire(pkgJson);
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) visit(dep, req);
  };
  for (const n of names) visit(n, require);
  return [...out];
}

/** pdf.js and tesseract.js as the worker imports them (absolute file URLs) and pdf.js's font and CMap data. */
function libraries() {
  const pdfjsDir = path.dirname(fs.realpathSync(require.resolve("pdfjs-dist/package.json")));
  return {
    modules: {
      pdfjs: pathToFileURL(path.join(pdfjsDir, "legacy/build/pdf.mjs")).href,
      tesseract: pathToFileURL(fs.realpathSync(require.resolve("tesseract.js"))).href,
    },
    assets: {
      cmaps: path.join(pdfjsDir, "cmaps") + path.sep,
      standardFonts: path.join(pdfjsDir, "standard_fonts") + path.sep,
    },
  };
}

/** The OCR language models (pinned npm packages): Korean and English, LSTM ("best_int"). */
const OCR_LANGS = ["kor", "eng"] as const;
const langFile = (lang: string) => {
  const dir = path.dirname(fs.realpathSync(require.resolve(`@tesseract.js-data/${lang}/package.json`)));
  return path.join(dir, "4.0.0_best_int", `${lang}.traineddata.gz`);
};

export type OcrCapability = { available: true; langDir: string } | { available: false; reason: string };

/**
 * Whether this server can read text in pictures, and where the language data is. OCR is tesseract.js (WebAssembly,
 * in the extractor's own process) with the pinned Korean and English models — nothing to install on the Mac and
 * nothing downloaded while running. The models are copied (checked by hash) into `<dir>` once: tesseract reads
 * every language from one folder. Off with `EXTRACT_OCR=off`; unavailable when a package is missing — then
 * pictures report `ocr_unavailable` (docs/ops.md §26).
 */
export function ocrCapability(dir: string, env: NodeJS.ProcessEnv = process.env): OcrCapability {
  if (env.EXTRACT_OCR === "off") return { available: false, reason: "disabled (EXTRACT_OCR=off)" };
  try {
    require.resolve("tesseract.js");
    require.resolve("tesseract.js-core/package.json", {
      paths: [path.dirname(fs.realpathSync(require.resolve("tesseract.js/package.json")))],
    });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const lang of OCR_LANGS) {
      const src = fs.readFileSync(langFile(lang));
      const dest = path.join(dir, `${lang}.traineddata.gz`);
      const st = fs.lstatSync(dest, { throwIfNoEntry: false });
      const same =
        st?.isFile() &&
        st.nlink === 1 &&
        crypto.createHash("sha256").update(fs.readFileSync(dest)).digest("hex") ===
          crypto.createHash("sha256").update(src).digest("hex");
      if (!same) {
        fs.rmSync(dest, { force: true });
        fs.writeFileSync(dest, src, { mode: 0o600, flag: "wx" });
      }
    }
    return { available: true, langDir: dir };
  } catch {
    return {
      available: false,
      reason: "the OCR packages (tesseract.js, @tesseract.js-data/kor, eng) are missing",
    };
  }
}

/** The worker's answer from its process result: limits and failures become fixed codes. */
export function workerResult(r: RunResult): WorkerResult {
  if (r.killed === "timeout") return { ok: false, code: "extract_timeout" };
  if (r.killed) return { ok: false, code: "extract_limit" };
  try {
    const out = JSON.parse(r.stdout) as WorkerResult;
    if (out && typeof out === "object" && typeof out.ok === "boolean") return out;
  } catch {
    // below
  }
  return { ok: false, code: "extract_failed" };
}

let libCache: ReturnType<typeof libraries> | undefined;
let folderCache: string[] | undefined;

/**
 * The sandbox run of one extraction: the worker reads `filePath` (family data — checked for hard links before the
 * run), its own folder and the pinned packages it imports (program folders, `trusted`) and, for a kind that may
 * need OCR, the language data. Nothing is writable, no network, the environment is one flag.
 */
export function extractRunOptions(
  file: Pick<FileRow, "kind" | "bytes">,
  filePath: string,
  ocr: OcrCapability | undefined,
  node = fs.realpathSync(process.execPath),
): RunIsolatedOptions {
  const libs = (libCache ??= libraries());
  folderCache ??= packageFolders(["pdfjs-dist", "tesseract.js"]);
  const langDir = ocr?.available ? ocr.langDir : undefined;
  return {
    command: node,
    args: [EXTRACT_WORKER_ENTRY],
    cwd: EXTRACT_WORKER_DIR,
    env: { AGENTLEE_EXTRACT_WORKER: "1" },
    read: [filePath, ...(langDir ? [langDir] : [])],
    trusted: [EXTRACT_WORKER_DIR, ...folderCache],
    write: [],
    network: "none",
    stdin: JSON.stringify({
      path: filePath,
      kind: file.kind,
      bytes: file.bytes,
      ...libs,
      ocr: langDir ? { langDir } : null,
    }),
    ...(langDir ? EXTRACT_LIMITS.ocr : EXTRACT_LIMITS.text),
    maxOutputBytes: EXTRACT_LIMITS.maxOutputBytes,
  };
}

/** The default runner: the worker under `runIsolated` with `extractRunOptions`. */
export function sandboxedExtractor(ocr: () => OcrCapability): ExtractRunner {
  return async ({ file, path: filePath, signal }) => {
    let r: RunResult;
    try {
      const options = extractRunOptions(file, filePath, OCR_KINDS.has(file.kind) ? ocr() : undefined);
      r = await runIsolated({ ...options, signal });
    } catch {
      // No sandbox here (not macOS), a hard-linked file, packages missing, a spawn failure: nothing ran.
      return { ok: false, code: "extract_unavailable" };
    }
    return workerResult(r);
  };
}

/**
 * The worker run in this process, without the sandbox — **development and tests only**: the FakeRuntime mode on a
 * machine without `sandbox-exec` (the Linux CI's e2e run) and tests of what comes after extraction. Same job, same
 * limits inside the worker; no process boundary, no time or memory limit. `buildApp` picks it only through
 * `extractorKind` (`ISOLATION_IN_PROCESS_FOR_TESTS`, never in production).
 */
/**
 * Which runner a server uses: the sandbox — except on a test machine without one that says so explicitly
 * (`ISOLATION_IN_PROCESS_FOR_TESTS`, refused with NODE_ENV=production by `loadConfig`; checked again here).
 * FAKE_RUNTIME alone never removes the sandbox.
 */
export function extractorKind(
  config: Pick<Config, "env" | "isolationInProcessForTests">,
): "sandbox" | "in-process" {
  return config.isolationInProcessForTests && config.env !== "production" ? "in-process" : "sandbox";
}

export function inProcessExtractor(ocr: () => OcrCapability): ExtractRunner {
  let worker: Promise<{ run: (job: unknown) => Promise<WorkerResult> }> | undefined;
  return async ({ file, path: filePath }) => {
    try {
      worker ??= import(pathToFileURL(EXTRACT_WORKER_ENTRY).href) as Promise<{
        run: (job: unknown) => Promise<WorkerResult>;
      }>;
      const options = extractRunOptions(file, filePath, OCR_KINDS.has(file.kind) ? ocr() : undefined);
      return await (await worker).run(JSON.parse(options.stdin!));
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      return {
        ok: false,
        code: typeof code === "string" && ExtractCode.safeParse(code).success ? code : "extract_failed",
      };
    }
  };
}

export type FileExtractRow = typeof fileExtracts.$inferSelect;
export type SegmentRow = typeof fileSegments.$inferSelect;

export type FileExtractsOptions = {
  runner?: ExtractRunner;
  log?: EventLogger;
  now?: () => number;
  /**
   * Stored rows of a file were replaced (re-extraction — e.g. a capped file after a new secret): the old text may
   * still be in WAL frames and old pages. The clean-up-pending marker is set in the same transaction; this asks the
   * background rescrub to checkpoint (`StoredRescrub.cleanup`, review #111).
   */
  onReplaced?: () => void;
};

/** The API shape of an extraction row (`pending` for a file without one yet). */
export function toFileExtract(f: FileRow, row: FileExtractRow | undefined): FileExtract {
  const code = ExtractCode.safeParse(row?.code);
  const ocr = OcrState.safeParse(row?.ocr);
  return {
    fileId: f.id,
    fileRevision: f.sha256,
    status: (row?.status ?? "pending") as ExtractStatus,
    code: code.success ? code.data : null,
    ocr: ocr.success ? ocr.data : "none",
    units: row?.units ?? null,
    segments: row?.segments ?? 0,
    characters: row?.characters ?? 0,
    truncated: row?.truncated ?? false,
  };
}

/** Background extraction and the stored results (see the file comment). */
export class FileExtracts {
  private readonly queue: string[] = [];
  private readonly waiters = new Map<string, (() => void)[]>();
  private running: Promise<void> | undefined;
  private closed = false;
  /** Stops a running extractor when the service closes (the file stays pending: the next start resumes it). */
  private readonly abort = new AbortController();
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    private readonly store: FileStore,
    private readonly runner: ExtractRunner,
    private readonly opts: FileExtractsOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    // A secret registered now may be in a file's text where the stored copy was cut for display: the cut part is
    // not there to scrub, so such files are extracted again from their original bytes — pending until then.
    this.offRegistered = knownSecrets.onRegistered(() => this.reextractCut());
  }

  private readonly offRegistered: () => void;

  /**
   * Files with a unit cut for display (`file_segments.cut`): back to pending — nothing of them is served — and
   * queued, so the whole uncut text is scrubbed again (review #107 6차). Files without a cut unit are rescrubbed
   * in place (`StoredRescrub`, the whole file in order). Returns how many.
   */
  reextractCut(): number {
    if (this.closed) return 0;
    const ids = this.db.$client
      .prepare(
        `SELECT DISTINCT s.file_id AS id FROM file_segments s JOIN file_extracts e ON e.file_id = s.file_id
         WHERE s.cut = 1 AND e.status = 'ok'`,
      )
      .all() as { id: string }[];
    for (const { id } of ids) this.reextract(id);
    return ids.length;
  }

  get(fileId: string): FileExtractRow | undefined {
    const row = this.db.select().from(fileExtracts).where(eq(fileExtracts.fileId, fileId)).get();
    // A file stored with a unit cut for display, extracted before a secret this process registered since (or by
    // another process): its stored text cannot be scrubbed again in place — pending, extracted again.
    if (row?.status === "ok" && this.stale(fileId)) {
      this.reextract(fileId);
      return this.db.select().from(fileExtracts).where(eq(fileExtracts.fileId, fileId)).get();
    }
    return row;
  }

  /** `knownSecrets.storedGeneration` each file's text was scrubbed with at its extraction (this process only). */
  private readonly scrubbedAt = new Map<string, number>();

  private capped(fileId: string): boolean {
    return !!this.db.$client
      .prepare("SELECT 1 FROM file_segments WHERE file_id = ? AND cut = 1 LIMIT 1")
      .get(fileId);
  }

  /** A capped file whose extraction is older than the secrets known now (or not known to this process). */
  private stale(fileId: string): boolean {
    return this.scrubbedAt.get(fileId) !== knownSecrets.storedGeneration && this.capped(fileId);
  }

  private reextract(fileId: string): void {
    this.db.$client
      .prepare("UPDATE file_extracts SET status = 'pending', attempts = 0, updated_at = ? WHERE file_id = ?")
      .run(this.now(), fileId);
    this.cache.delete(fileId);
    this.enqueue(fileId);
  }

  /**
   * Segments of a file in order (`seq`), from `from`, at most `limit` — scrubbed again with the secrets known
   * **now** (review #107: one registered after the extraction must not come back before the background rescrub
   * reaches the row). The whole file is matched in document order (`scrubFile`: a secret across two units is one
   * value), then the requested ones are returned; marks follow the replacements, the locator's strings are
   * scrubbed too.
   */
  segments(fileId: string, from = 0, limit = 100_000): SegmentRow[] {
    const all = this.scrubbedFile(fileId);
    const out: SegmentRow[] = [];
    for (const r of all) {
      if (out.length >= limit) break;
      if (r.seq >= from) out.push(r);
    }
    return out;
  }

  /**
   * Scrubbed files, kept until the file's extraction or the set of known secrets changes (review #107 4차: a read
   * must not rescan a whole file each time). Keyed on the extraction row's `updated_at` (every `save` changes it)
   * and the registry's generation; a few files at a time.
   */
  private readonly cache = new Map<string, { stamp: string; rows: SegmentRow[] }>();
  private static readonly CACHE_FILES = 8;

  private scrubbedFile(fileId: string): SegmentRow[] {
    const row = this.db.$client
      .prepare("SELECT updated_at AS u, extractor AS e, status AS s FROM file_extracts WHERE file_id = ?")
      .get(fileId) as { u: number; e: string; s: string } | undefined;
    if (!row) return [];
    // Only a finished extraction is served: one pending (a re-extraction after a new secret) shows nothing.
    if (row.s !== "ok") return [];
    if (this.stale(fileId)) {
      this.reextract(fileId);
      return [];
    }
    const stamp = `${row.u}:${row.e}:${knownSecrets.generation}`;
    const hit = this.cache.get(fileId);
    if (hit?.stamp === stamp) {
      this.cache.delete(fileId);
      this.cache.set(fileId, hit);
      return hit.rows;
    }
    const rows = this.db.$client
      .prepare(
        `SELECT file_id AS fileId, seq, unit, locator, text, marks, approximate, cut, ends_early AS endsEarly
         FROM file_segments WHERE file_id = ? ORDER BY seq`,
      )
      .all(fileId) as (Omit<SegmentRow, "approximate" | "cut" | "endsEarly"> & {
      approximate: number;
      cut: number;
      endsEarly: number;
    })[];
    // A file with a unit cut for display: its stored text was scrubbed whole, before the cut, with the secrets known
    // now (an older extraction is pending, `get`). Its stored pieces are never joined again — across a cut they
    // would make up values that are not in the file (review #107 7차); each unit on its own is scrubbed once more.
    // Every other file: the whole file in order, with the secrets known now.
    // Every other file: the whole file in order, with the cut-off-secret rule only at the units after which the
    // extractor left text out (`ends_early`). A capped file: full matches only — its early ends were masked on save,
    // in the whole text before the cap; the end of a unit's display cut is not one (review #107 9차).
    const units = rows.map((r) => ({ text: r.text, marks: parseMarks(r.marks), endsEarly: !!r.endsEarly }));
    const scrubbed = rows.some((r) => r.cut)
      ? units.map((u) => scrubFile([{ text: u.text, marks: u.marks }])[0]!)
      : scrubFile(units);
    const out = rows.map((r, i): SegmentRow => {
      const s = scrubbed[i]!;
      let locator = r.locator;
      try {
        locator = JSON.stringify(scrubKnownDeep(JSON.parse(r.locator) as unknown, { tail: false }));
      } catch {
        // stored by `save` as JSON
      }
      return {
        ...r,
        locator,
        text: s.text,
        marks: s.marks ? JSON.stringify(s.marks) : null,
        approximate: !!r.approximate || s.approximate,
        cut: !!r.cut,
        endsEarly: !!r.endsEarly,
      };
    });
    this.cache.set(fileId, { stamp, rows: out });
    while (this.cache.size > FileExtracts.CACHE_FILES) this.cache.delete(this.cache.keys().next().value!);
    return out;
  }

  /** Queues a file for extraction (a pending row first, so readers see `pending`). */
  enqueue(fileId: string): void {
    if (this.closed) return;
    this.db.$client
      .prepare(
        `INSERT INTO file_extracts (file_id, status, extractor, updated_at) SELECT id, 'pending', ?, ? FROM files
         WHERE id = ? ON CONFLICT(file_id) DO NOTHING`,
      )
      .run(EXTRACTOR_VERSION, this.now(), fileId);
    if (!this.queue.includes(fileId)) this.queue.push(fileId);
    this.running ??= this.drain().finally(() => (this.running = undefined));
  }

  /**
   * Start-up: every file without a finished extraction of this extractor version is queued — new files whose row
   * never came (a crash right after the upload), ones left `pending`, ones of an older version.
   */
  resume(): number {
    // Secrets known to this process may be newer than a file's extraction: files with a cut unit go again.
    this.reextractCut();
    const ids = this.db.$client
      .prepare(
        `SELECT f.id FROM files f LEFT JOIN file_extracts e ON e.file_id = f.id
         WHERE e.file_id IS NULL OR e.status = 'pending' OR e.extractor <> ?
         ORDER BY f.created_at, f.id`,
      )
      .all(EXTRACTOR_VERSION) as { id: string }[];
    for (const { id } of ids) {
      // An older version's result is replaced: back to pending (and a fresh attempt count).
      this.db.$client
        .prepare(
          `UPDATE file_extracts SET status = 'pending', attempts = 0, extractor = ?, updated_at = ?
           WHERE file_id = ? AND extractor <> ?`,
        )
        .run(EXTRACTOR_VERSION, this.now(), id, EXTRACTOR_VERSION);
      this.enqueue(id);
    }
    return ids.length;
  }

  /**
   * Resolves once the file's extraction is no longer pending (or after `timeoutMs`, or when the service closes).
   * Returns the row as it is then.
   */
  async settled(fileId: string, timeoutMs: number): Promise<FileExtractRow | undefined> {
    const row = this.get(fileId);
    if (row && row.status !== "pending") return row;
    if (!row && !this.store.get(fileId)) return undefined;
    if (!this.queue.includes(fileId) && !this.inFlight.has(fileId)) this.enqueue(fileId);
    await new Promise<void>((resolve) => {
      const t = setTimeout(done, timeoutMs);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.waiters.set(fileId, [...(this.waiters.get(fileId) ?? []), done]);
    });
    return this.get(fileId);
  }

  /** Resolves once nothing is queued or running (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  close(): void {
    this.closed = true;
    this.offRegistered();
    this.abort.abort();
    this.queue.length = 0;
    for (const ws of this.waiters.values()) for (const w of ws) w();
    this.waiters.clear();
  }

  private readonly inFlight = new Set<string>();

  private async drain(): Promise<void> {
    while (!this.closed && this.queue.length) {
      const id = this.queue.shift()!;
      this.inFlight.add(id);
      try {
        await this.extract(id);
      } catch (e) {
        logEvent(this.opts.log, "error", "file.extract_failed", { fileId: id, err: e });
      } finally {
        this.inFlight.delete(id);
        for (const w of this.waiters.get(id) ?? []) w();
        this.waiters.delete(id);
      }
    }
  }

  private async extract(id: string): Promise<void> {
    const file = this.store.get(id);
    if (!file) return;
    const row = this.get(id);
    if (row && row.status !== "pending" && row.extractor === EXTRACTOR_VERSION) return;
    const attempts = (row?.attempts ?? 0) + 1;
    // Counted before the run: a file that takes the server down with it is not tried for ever.
    this.db.$client
      .prepare(`UPDATE file_extracts SET attempts = ?, updated_at = ? WHERE file_id = ?`)
      .run(attempts, this.now(), id);
    const started = this.now();
    let result: WorkerResult;
    if (attempts > MAX_ATTEMPTS) result = { ok: false, code: "extract_failed" };
    else {
      // The checked store folder (never a link) and the file in it; the sandbox reads that real path only.
      const dir = this.store.storeDir(file.userId, file.conversationId);
      result = dir
        ? await this.runner({ file, path: path.join(dir, file.id), signal: this.abort.signal })
        : { ok: false, code: "extract_unavailable" };
    }
    // Stopped by the shutdown: nothing is stored, the file stays pending (resumed at the next start).
    if (this.closed) return;
    if (result.ok && result.sha256 !== file.sha256) result = { ok: false, code: "extract_changed" };
    const stored = this.save(file, result);
    logEvent(this.opts.log, stored.status === "ok" ? "info" : "warn", "file.extracted", {
      fileId: id,
      conversationId: file.conversationId,
      userId: file.userId,
      extractCode: stored.status === "ok" ? "extract_ok" : (stored.code ?? "extract_failed"),
      durationMs: this.now() - started,
    });
  }

  /**
   * Stores the result in one transaction: the old segments go, the new ones (text and locator scrubbed of known
   * secrets) come, the row says what happened. Nothing is stored for a file deleted meanwhile.
   */
  private save(file: FileRow, r: WorkerResult): { status: ExtractStatus; code: string | null } {
    const sql = this.db.$client;
    this.cache.delete(file.id);
    const code = r.ok ? null : ExtractCode.safeParse(r.code).success ? r.code : "extract_failed";
    let replaced = false;
    const out = sql.transaction(() => {
      if (!sql.prepare("SELECT 1 FROM files WHERE id = ? AND sha256 = ?").get(file.id, file.sha256))
        return { status: "failed" as const, code: "extract_changed" };
      if (sql.prepare("DELETE FROM file_segments WHERE file_id = ?").run(file.id).changes) {
        setKey(sql, CLEANUP_PENDING_KEY, "1");
        replaced = true;
      }
      let chars = 0;
      let count = 0;
      let capped = false;
      let endedEarly = false;
      if (r.ok) {
        const insert = sql.prepare(
          `INSERT INTO file_segments (file_id, seq, unit, locator, text, marks, approximate, cut, ends_early)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        this.scrubbedAt.set(file.id, knownSecrets.storedGeneration);
        for (const { seg, scrubbed, gap, endsEarly } of keptSegments(r.segments)) {
          const s = capUnit(scrubbed);
          // A sheet name comes whole: scrubbed whole, then capped for display (review #107 9차). A capped name is
          // stored with a gap, like a capped text: the unit counts as cut (a later secret extracts it again).
          const loc = scrubKnownDeep(seg.loc, { tail: false }) as WorkerSegment["loc"];
          let nameCut = false;
          if (typeof loc.sheet === "string") {
            const capped = capText(loc.sheet, MAX_SHEET_NAME);
            loc.sheet = capped.text;
            nameCut = capped.cut;
          }
          if (s.cut || nameCut) capped = true;
          if (endsEarly) endedEarly = true;
          insert.run(
            file.id,
            count++,
            seg.unit,
            JSON.stringify(loc),
            s.text,
            s.marks ? JSON.stringify(s.marks) : null,
            s.approximate ? 1 : 0,
            s.cut || nameCut || gap ? 1 : 0,
            endsEarly ? 1 : 0,
          );
          chars += s.text.length;
        }
      }
      const ocr = r.ok && OcrState.safeParse(r.ocr).success ? r.ocr : "none";
      sql
        .prepare(
          `INSERT INTO file_extracts (file_id, status, code, ocr, units, segments, characters, truncated, ended_early,
             extractor, attempts, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(file_id) DO UPDATE SET status = excluded.status, code = excluded.code, ocr = excluded.ocr,
             units = excluded.units, segments = excluded.segments, characters = excluded.characters,
             truncated = excluded.truncated, ended_early = excluded.ended_early, extractor = excluded.extractor, updated_at = excluded.updated_at`,
        )
        .run(
          file.id,
          r.ok ? "ok" : "failed",
          code,
          ocr,
          r.ok && Number.isInteger(r.units) ? r.units : null,
          count,
          chars,
          // More than is kept: past the 2M total (the extractor) or past a unit's display cap.
          r.ok && (r.truncated || capped) ? 1 : 0,
          r.ok && endedEarly ? 1 : 0,
          EXTRACTOR_VERSION,
          this.now(),
        );
      return { status: r.ok ? ("ok" as const) : ("failed" as const), code };
    })();
    if (replaced) this.opts.onReplaced?.();
    return out;
  }
}

/** Files of a conversation, with their extraction rows (one query each). */
export function extractRowsFor(db: Db, fileRows: readonly FileRow[]): Map<string, FileExtractRow> {
  const out = new Map<string, FileExtractRow>();
  for (const f of fileRows) {
    const row = db.select().from(fileExtracts).where(eq(fileExtracts.fileId, f.id)).get();
    if (row) out.set(f.id, row);
  }
  return out;
}
