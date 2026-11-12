import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DOC_LIMITS, type DocContent, type DocKind } from "@agentlee/shared";
import type { Config } from "../config.js";
import { runIsolated, type RunIsolatedOptions, type RunResult } from "../isolation/sandbox.js";

/**
 * How a document is made (#49): `apps/server/docgen/worker.mjs` with the pinned libraries (docx, exceljs, pptxgenjs,
 * pdfkit; jszip and saxes to re-open and parse what was made) and the embedded PDF font, in its own sandboxed process (#42) — read
 * access to its folder, those packages and the font only (program folders, never family data: the pictures come in
 * on stdin), nothing writable, no network, no child processes, an environment of one flag; time, memory and output
 * limits (`DOC_WORKER_LIMITS`). Only tests and development (the `ISOLATION_IN_PROCESS_FOR_TESTS` switch, refused in
 * production) may run the same worker in this process (`inProcessDocRunner`, `docRunnerKind`).
 */

/** Folder of the worker (the same from src/ and dist/). */
export const DOC_WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docgen");
export const DOC_WORKER_ENTRY = path.join(DOC_WORKER_DIR, "worker.mjs");

/** The packages the worker imports (by absolute file URL, `modules` of the job). */
export const DOC_PACKAGES = ["docx", "exceljs", "pptxgenjs", "pdfkit", "jszip", "saxes"] as const;
/** The PDF font (SIL Open Font License 1.1): Gothic A1 regular and bold, from the pinned npm package. */
export const DOC_FONT_PACKAGE = "@expo-google-fonts/gothic-a1";

export const DOC_WORKER_LIMITS = {
  timeoutMs: 60_000,
  maxRssBytes: 768 * 1024 * 1024,
  /** The file as base64 in a JSON line, and a little more. */
  maxOutputBytes: Math.ceil((DOC_LIMITS.outputBytes * 4) / 3) + 64 * 1024,
};

export type DocJob = {
  kind: DocKind;
  doc: DocContent;
  /** Pictures by file id: their kind and bytes (base64), read by the server through the file store's checks. */
  images: Record<string, { kind: "png" | "jpg"; data: string }>;
};

export type DocRunResult =
  { ok: true; data: Buffer; checks: Record<string, number> } | { ok: false; code: string };

export type DocRunner = (job: DocJob) => Promise<DocRunResult>;

const require = createRequire(import.meta.url);

/**
 * The folder of an installed package, found the way Node looks for it (the `node_modules` folders up from `req`) —
 * also a package without a main entry or whose package.json is not exported. Undefined when it is not installed.
 */
function packageDir(name: string, req: NodeJS.Require): string | undefined {
  for (const base of req.resolve.paths(name) ?? []) {
    const dir = path.join(base, name);
    try {
      const real = fs.realpathSync(dir);
      if (
        (JSON.parse(fs.readFileSync(path.join(real, "package.json"), "utf8")) as { name?: unknown }).name ===
        name
      )
        return real;
    } catch {
      // not here
    }
  }
  return undefined;
}

/**
 * The folders the worker may read for `names` and everything they depend on: for a pnpm install the
 * `.pnpm/<id>/node_modules` folder of each package (it holds the package and the links to its dependencies),
 * otherwise the package folder itself.
 */
export function packageFolders(names: readonly string[]): string[] {
  const out = new Set<string>();
  const seen = new Set<string>();
  const visit = (name: string, req: NodeJS.Require) => {
    const dir = packageDir(name, req);
    if (!dir || seen.has(dir)) return;
    seen.add(dir);
    const up = name.startsWith("@") ? path.dirname(path.dirname(dir)) : path.dirname(dir);
    out.add(path.basename(up) === "node_modules" && up.includes(`${path.sep}.pnpm${path.sep}`) ? up : dir);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const next = createRequire(path.join(dir, "package.json"));
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) visit(dep, next);
  };
  for (const n of names) visit(n, require);
  return [...out];
}

type Libraries = {
  modules: Record<(typeof DOC_PACKAGES)[number], string>;
  fonts: { regular: string; bold: string };
  folders: string[];
};
let libCache: Libraries | undefined;

/** Where the worker's libraries and font are (resolved once). Throws when a package is missing. */
export function docLibraries(): Libraries {
  if (libCache) return libCache;
  const modules = Object.fromEntries(
    DOC_PACKAGES.map((n) => [n, pathToFileURL(fs.realpathSync(require.resolve(n))).href]),
  ) as Libraries["modules"];
  const fontDir = packageDir(`${DOC_FONT_PACKAGE}`, require);
  if (!fontDir) throw new Error("font package missing");
  const fonts = {
    regular: path.join(fontDir, "400Regular", "GothicA1_400Regular.ttf"),
    bold: path.join(fontDir, "700Bold", "GothicA1_700Bold.ttf"),
  };
  for (const f of Object.values(fonts)) if (!fs.statSync(f).isFile()) throw new Error("font missing");
  libCache = { modules, fonts, folders: [...packageFolders(DOC_PACKAGES), fontDir] };
  return libCache;
}

/** The sandbox run of one job (see the file comment). */
export function docRunOptions(job: DocJob, node = fs.realpathSync(process.execPath)): RunIsolatedOptions {
  const libs = docLibraries();
  return {
    command: node,
    args: [DOC_WORKER_ENTRY],
    cwd: DOC_WORKER_DIR,
    env: { AGENTLEE_DOC_WORKER: "1" },
    read: [],
    trusted: [DOC_WORKER_DIR, ...libs.folders],
    write: [],
    network: "none",
    stdin: JSON.stringify({ ...job, modules: libs.modules, fonts: libs.fonts }),
    ...DOC_WORKER_LIMITS,
  };
}

const CODE = /^doc_[a-z_]{1,40}$/;

/** The worker's answer as a result; anything unexpected is `doc_failed`. */
export function workerResult(r: RunResult): DocRunResult {
  if (r.killed === "timeout") return { ok: false, code: "doc_timeout" };
  if (r.killed) return { ok: false, code: "doc_limit" };
  let out: { ok?: unknown; data?: unknown; checks?: unknown; code?: unknown };
  try {
    out = JSON.parse(r.stdout) as typeof out;
  } catch {
    return { ok: false, code: "doc_failed" };
  }
  if (out?.ok === true && typeof out.data === "string")
    return {
      ok: true,
      data: Buffer.from(out.data, "base64"),
      checks: checksOf(out.checks),
    };
  return { ok: false, code: typeof out?.code === "string" && CODE.test(out.code) ? out.code : "doc_failed" };
}

const checksOf = (v: unknown): Record<string, number> =>
  v && typeof v === "object"
    ? Object.fromEntries(
        Object.entries(v).filter(
          (e): e is [string, number] => /^[a-z]{1,20}$/.test(e[0]) && Number.isInteger(e[1]),
        ),
      )
    : {};

/** The default runner: the worker under `runIsolated`. */
export function sandboxedDocRunner(): DocRunner {
  return async (job) => {
    let r: RunResult;
    try {
      r = await runIsolated(docRunOptions(job));
    } catch {
      // No sandbox here (not macOS), packages missing, a spawn failure: nothing ran.
      return { ok: false, code: "doc_unavailable" };
    }
    return workerResult(r);
  };
}

type Worker = {
  run(job: unknown): Promise<{ buf: Buffer; checks: Record<string, number> }>;
  DocError: new (code: string) => Error & { code: string };
};

/**
 * Which runner the app uses: the sandbox, always in production — whatever else is set (FAKE_RUNTIME included). In
 * process only with the test switch `ISOLATION_IN_PROCESS_FOR_TESTS=1` (which `loadConfig` refuses in production)
 * and a non-production environment, checked again here.
 */
export function docRunnerKind(
  config: Pick<Config, "env" | "isolationInProcessForTests">,
): "sandbox" | "in-process" {
  return config.env !== "production" && config.isolationInProcessForTests ? "in-process" : "sandbox";
}

/**
 * The same worker in this process — for tests and development on machines without the macOS sandbox, behind
 * `docRunnerKind` — never in production.
 */
export function inProcessDocRunner(): DocRunner {
  return async (job) => {
    const libs = docLibraries();
    const worker = (await import(pathToFileURL(DOC_WORKER_ENTRY).href)) as Worker;
    const common = (await import(pathToFileURL(path.join(DOC_WORKER_DIR, "common.mjs")).href)) as Worker;
    try {
      // Through JSON like the sandboxed run: the worker sees exactly what it would get on stdin.
      const { buf, checks } = await worker.run(
        JSON.parse(JSON.stringify({ ...job, modules: libs.modules, fonts: libs.fonts })),
      );
      return { ok: true, data: buf, checks: checksOf(checks) };
    } catch (e) {
      return {
        ok: false,
        code: e instanceof common.DocError && CODE.test(e.code) ? e.code : "doc_failed",
      };
    }
  };
}
