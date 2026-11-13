import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBrowser } from "../artifacts/browser.js";
import { WORKER_CONF } from "./account.js";
import { DOC_PACKAGES, DOC_WORKER_DIR, docLibraries } from "../docgen/runner.js";
import {
  EXTRACT_WORKER_DIR,
  extractLibraries,
  langFile,
  OCR_LANGS,
  packageFolders,
} from "../files/extract.js";

/**
 * `pnpm workers:bundle <out>` (#122): one self-contained copy of everything the worker account runs, for the
 * administrator to install root-owned (`sudo ditto <out> /usr/local/lib/agentlee-workers`, docs/ops.md §41.2):
 *
 * - `node/bin/node` — this server's node executable (a copy: the account cannot traverse the server's home);
 * - `app/` — `extract/` and `docgen/` (the worker programs), the pnpm folders of their pinned libraries
 *   (`app/node_modules/.pnpm/<id>/node_modules`, the links between them kept — every link stays inside `app/`),
 *   the OCR language data (`app/ocr/`) and `app/manifest.json`: where the libraries, pdf.js data and fonts are,
 *   relative to `app/` — the worker reads its paths from it under the account, never from the job;
 * - `browser/` — the headless shell's folder (`findBrowser`).
 *
 * Every name must be one the launcher's tree check accepts (`[A-Za-z0-9_.+@-]`). The bundle holds no secret and
 * no family data: program files only. Nothing here needs sudo; the server never installs it itself.
 */

export type WorkerManifest = {
  version: 1;
  fingerprint: string;
  docgen: {
    modules: Record<(typeof DOC_PACKAGES)[number], string>;
    fonts: { regular: string; bold: string };
  };
  extract: {
    modules: { pdfjs: string; tesseract: string };
    assets: { cmaps: string; standardFonts: string };
    ocrLangDir: string;
  };
};

const NAME = /^[A-Za-z0-9_.+@-]+$/;
const STORE = `${path.sep}node_modules${path.sep}.pnpm${path.sep}`;

/** `<store>/<id>/node_modules/...` → [store, "<id>/node_modules"]; throws outside a pnpm store. */
function storeEntry(p: string): [string, string] {
  const i = p.lastIndexOf(STORE);
  if (i < 0) throw new Error(`not in a pnpm store: ${p}`);
  const store = p.slice(0, i + STORE.length - 1);
  const [id, nm] = p.slice(i + STORE.length).split(path.sep);
  if (!id || nm !== "node_modules") throw new Error(`unexpected pnpm path: ${p}`);
  return [store, `${id}/node_modules`];
}

/** A path inside the pnpm store → the same path under `app/` (`node_modules/.pnpm/…`). */
function inApp(p: string): string {
  const [store] = storeEntry(p);
  return ["node_modules", ".pnpm", ...path.relative(store, p).split(path.sep)].join("/");
}

/** Every entry below `dir` (not following links): names checked, links must resolve inside `root`. */
function checkTree(dir: string, root: string): number {
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!NAME.test(e.name)) throw new Error(`a name the launcher refuses: ${path.join(d, e.name)}`);
      n++;
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) {
        const target = path.resolve(d, fs.readlinkSync(p));
        if (target !== root && !target.startsWith(root + path.sep))
          throw new Error(`a link leaves the bundle: ${p}`);
      } else if (e.isDirectory()) stack.push(p);
      else if (!e.isFile()) throw new Error(`not a file or folder: ${p}`);
    }
  }
  return n;
}

/** Copy-on-write clones where the file system has them (APFS), plain copies elsewhere. */
const CLONE = fs.constants.COPYFILE_FICLONE;
const copy = (src: string, dest: string) =>
  fs.cpSync(src, dest, {
    recursive: true,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false,
    mode: CLONE,
  });

/**
 * What a bundle of this server's checkout holds, without making one: the manifest (library paths relative to `app/`)
 * and its `fingerprint` — a SHA-256 over that manifest (pinned library versions are in its paths) and every worker
 * program file. The self-check compares it with the installed bundle's (`installedFingerprint`): a bundle made from
 * other code (a `git pull`, a lock update) is refused, so the account never runs workers older than the server's.
 */
export function workerManifest(): WorkerManifest {
  const doc = docLibraries();
  const ext = extractLibraries();
  const rel = (p: string) => inApp(p.endsWith(path.sep) ? p.slice(0, -1) : p);
  const body = {
    docgen: {
      modules: Object.fromEntries(
        Object.entries(doc.modules).map(([k, url]) => [k, rel(fileURLToPath(url))]),
      ) as WorkerManifest["docgen"]["modules"],
      fonts: { regular: rel(doc.fonts.regular), bold: rel(doc.fonts.bold) },
    },
    extract: {
      modules: {
        pdfjs: rel(fileURLToPath(ext.modules.pdfjs)),
        tesseract: rel(fileURLToPath(ext.modules.tesseract)),
      },
      assets: { cmaps: rel(ext.assets.cmaps), standardFonts: rel(ext.assets.standardFonts) },
      ocrLangDir: "ocr",
    },
  };
  const hash = crypto.createHash("sha256").update(JSON.stringify(body));
  for (const [dir, name] of [
    [EXTRACT_WORKER_DIR, "extract"],
    [DOC_WORKER_DIR, "docgen"],
  ] as const)
    for (const f of fs
      .readdirSync(dir)
      .filter((x) => x.endsWith(".mjs"))
      .sort())
      hash.update(`\0${name}/${f}\0`).update(fs.readFileSync(path.join(dir, f)));
  return { version: 1, fingerprint: hash.digest("hex"), ...body };
}

/**
 * The installed bundle's fingerprint: the root-owned config's `app=` line → `<app>/manifest.json`. Undefined when
 * either cannot be read or is not the expected shape (the self-check then fails at its `bundle` step).
 */
export function installedFingerprint(conf = WORKER_CONF): string | undefined {
  try {
    const app = /^app=(\/[^\n]+)$/m.exec(fs.readFileSync(conf, "utf8"))?.[1];
    if (!app) return undefined;
    const m = JSON.parse(fs.readFileSync(path.join(app, "manifest.json"), "utf8")) as {
      fingerprint?: unknown;
    };
    return typeof m.fingerprint === "string" && /^[0-9a-f]{64}$/.test(m.fingerprint)
      ? m.fingerprint
      : undefined;
  } catch {
    return undefined;
  }
}

export function bundleWorkers(out: string, o: { browser?: string | undefined } = {}): { nodes: number } {
  const root = path.resolve(out);
  if (fs.existsSync(root)) throw new Error(`${root} exists: give a new folder`);
  const app = path.join(root, "app");
  fs.mkdirSync(path.join(root, "node", "bin"), { recursive: true });
  fs.mkdirSync(app, { recursive: true });

  // node: the executable alone (official builds link only system libraries).
  fs.copyFileSync(fs.realpathSync(process.execPath), path.join(root, "node", "bin", "node"), CLONE);
  fs.chmodSync(path.join(root, "node", "bin", "node"), 0o755);

  // The worker programs (their .mjs files; nothing else lives there).
  for (const [src, name] of [
    [EXTRACT_WORKER_DIR, "extract"],
    [DOC_WORKER_DIR, "docgen"],
  ] as const) {
    fs.mkdirSync(path.join(app, name));
    for (const f of fs.readdirSync(src))
      if (f.endsWith(".mjs")) fs.copyFileSync(path.join(src, f), path.join(app, name, f), CLONE);
  }

  // Their libraries: the pnpm folders of the packages and everything they depend on, links between them kept.
  const doc = docLibraries();
  const folders = new Set([...packageFolders(["pdfjs-dist", "tesseract.js"]), ...doc.folders]);
  const ids = new Set<string>();
  for (const f of folders) {
    const [store, id] = storeEntry(f);
    if (ids.has(id)) continue;
    ids.add(id);
    copy(path.join(store, id), path.join(app, "node_modules", ".pnpm", id));
  }

  // OCR language data (the pinned packages' files, as the server copies them for itself).
  fs.mkdirSync(path.join(app, "ocr"));
  for (const lang of OCR_LANGS)
    fs.copyFileSync(langFile(lang), path.join(app, "ocr", `${lang}.traineddata.gz`), CLONE);

  const manifest = workerManifest();
  for (const p of [
    ...Object.values(manifest.docgen.modules),
    ...Object.values(manifest.docgen.fonts),
    ...Object.values(manifest.extract.modules),
    ...Object.values(manifest.extract.assets),
  ])
    if (!fs.existsSync(path.join(app, p))) throw new Error(`missing from the bundle: ${p}`);
  fs.writeFileSync(path.join(app, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  // The browser: the headless shell's folder.
  const exe = findBrowser(o.browser);
  if (!exe || path.basename(exe) !== "chrome-headless-shell")
    throw new Error(
      "no headless shell: pnpm exec playwright install --only-shell chromium (or EXPORT_BROWSER)",
    );
  copy(path.dirname(exe), path.join(root, "browser"));

  const nodes = checkTree(root, root);
  return { nodes };
}
