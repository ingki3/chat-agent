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
  fingerprints: WorkerFingerprints;
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

/**
 * Every entry below one tree `root` (not following links): names checked; a link must resolve to an existing path
 * inside that same tree (the launcher refuses anything else). A dangling link — pnpm's link to an optional
 * dependency that is not installed — is removed.
 */
function checkTree(root: string): number {
  const dir = fs.realpathSync(root);
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!NAME.test(e.name)) throw new Error(`a name the launcher refuses: ${path.join(d, e.name)}`);
      n++;
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) {
        let target: string;
        try {
          target = fs.realpathSync(p);
        } catch {
          fs.unlinkSync(p);
          n--;
          continue;
        }
        if (!target.startsWith(dir + path.sep)) throw new Error(`a link leaves its tree: ${p}`);
        // The launcher's one-hop rule: a relative target, `..` only leading, staying in the tree from here.
        const t = fs.readlinkSync(p);
        const parts = t.split("/");
        const firstName = parts.findIndex((x) => x !== "..");
        if (
          path.isAbsolute(t) ||
          firstName < 0 ||
          parts.slice(firstName).some((x) => x === ".." || x === "." || x === "" || !NAME.test(x)) ||
          !(path.resolve(d, parts.slice(0, firstName).join("/") || ".") + path.sep).startsWith(dir + path.sep)
        )
          throw new Error(`a link target the launcher refuses: ${p}`);
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

/** The manifest's paths (library paths relative to `app/`) for this server's checkout. */
export function workerManifestBody(): Omit<WorkerManifest, "version" | "fingerprints"> {
  const doc = docLibraries();
  const ext = extractLibraries();
  const rel = (p: string) => inApp(p.endsWith(path.sep) ? p.slice(0, -1) : p);
  return {
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
}

/** The pnpm folders (`<id>/node_modules`) of the workers' libraries and everything they depend on, transitively. */
export function libraryIds(): { store: string; id: string }[] {
  const folders = new Set([...packageFolders(["pdfjs-dist", "tesseract.js"]), ...docLibraries().folders]);
  const out = new Map<string, string>();
  for (const f of folders) {
    const [store, id] = storeEntry(f);
    out.set(id, store);
  }
  return [...out].map(([id, store]) => ({ store, id })).sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * The resolved dependency graph of those folders, as pnpm links it: for every library folder, each package link in
 * its `node_modules` (`<name>` or `@scope/<name>`) with its target text — `id<TAB>name<TAB>target`, sorted. Two locks
 * with the same package set but other links (`a→b@1, c→b@2` vs `a→b@2, c→b@1`) differ here. Dangling links (pnpm's
 * optional dependencies that are not installed — the bundle drops them) are left out.
 */
export function libraryLinks(libs = libraryIds()): string[] {
  const out: string[] = [];
  for (const { store, id } of libs) {
    const nm = path.join(store, id);
    const visit = (dir: string, prefix: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isSymbolicLink()) {
          if (!fs.existsSync(p)) continue;
          out.push(`${id}\t${prefix}${e.name}\t${fs.readlinkSync(p)}`);
        } else if (e.isDirectory() && e.name.startsWith("@") && !prefix) visit(p, `${e.name}/`);
      }
    };
    visit(nm, "");
  }
  return out.sort();
}

/** What the fingerprints are made of; the defaults are this server's own (tests change one at a time). */
export type FingerprintSources = {
  body: ReturnType<typeof workerManifestBody>;
  /** Worker program folders and their names in the bundle. */
  workerDirs: readonly (readonly [string, string])[];
  /** The library folders' pnpm ids: their versions and peer sets, so a lock change shows. */
  libraryIds: readonly string[];
  /** Their dependency graph (`libraryLinks`). */
  libraryLinks: readonly string[];
  ocrFiles: readonly string[];
  node: { exe: string; version: string };
  /** The headless shell's executable; undefined when this server has none. */
  browser: string | undefined;
};

export function defaultFingerprintSources(browser?: string): FingerprintSources {
  return {
    body: workerManifestBody(),
    workerDirs: [
      [EXTRACT_WORKER_DIR, "extract"],
      [DOC_WORKER_DIR, "docgen"],
    ],
    libraryIds: libraryIds().map((l) => l.id),
    libraryLinks: libraryLinks(),
    ocrFiles: OCR_LANGS.map(langFile),
    node: { exe: fs.realpathSync(process.execPath), version: process.version },
    browser: findBrowser(browser),
  };
}

/**
 * Per part of the bundle, a SHA-256 of everything that decides what runs there: `app` — the manifest's paths, every
 * worker program file, the transitive library ids (versions), the OCR data; `node` — its version and executable;
 * `browser` — the headless shell's executable (null without one). The self-check compares the parts a kind runs
 * with the installed bundle's (`installedFingerprints`): after a `git pull`, a lock, node or Chromium update or new
 * OCR data, a bundle not made again is refused — the account never runs other code than the server's.
 */
export type WorkerFingerprints = { app: string; node: string; browser: string | null };

const hashFile = (hash: crypto.Hash, file: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const s = fs.createReadStream(file);
    s.on("data", (c) => hash.update(c));
    s.on("error", reject);
    s.on("end", () => resolve());
  });

export async function computeFingerprints(src: FingerprintSources): Promise<WorkerFingerprints> {
  const app = crypto.createHash("sha256").update(JSON.stringify(src.body));
  for (const [dir, name] of src.workerDirs)
    for (const f of fs
      .readdirSync(dir)
      .filter((x) => x.endsWith(".mjs"))
      .sort()) {
      app.update(`\0${name}/${f}\0`);
      await hashFile(app, path.join(dir, f));
    }
  app.update(`\0libraries\0${src.libraryIds.join("\n")}`);
  app.update(`\0links\0${src.libraryLinks.join("\n")}`);
  for (const f of src.ocrFiles) {
    app.update(`\0ocr/${path.basename(f)}\0`);
    await hashFile(app, f);
  }
  const node = crypto.createHash("sha256").update(`${src.node.version}\0`);
  await hashFile(node, src.node.exe);
  let browser: string | null = null;
  if (src.browser) {
    const b = crypto.createHash("sha256");
    await hashFile(b, src.browser);
    browser = b.digest("hex");
  }
  return { app: app.digest("hex"), node: node.digest("hex"), browser };
}

/** What a kind runs, as one string to compare: extract/docgen — `app` + `node`; render — `browser`. */
export function kindFingerprint(f: WorkerFingerprints, kind: "extract" | "docgen" | "render"): string {
  return kind === "render" ? `browser:${f.browser ?? "none"}` : `app:${f.app} node:${f.node}`;
}

const HEX = /^[0-9a-f]{64}$/;

/**
 * The installed bundle's fingerprints: the root-owned config's `app=` line → `<app>/manifest.json`. Undefined when
 * either cannot be read or is not the expected shape (the self-check then fails at its `bundle` step).
 */
export function installedFingerprints(conf = WORKER_CONF): WorkerFingerprints | undefined {
  try {
    const app = /^app=(\/[^\n]+)$/m.exec(fs.readFileSync(conf, "utf8"))?.[1];
    if (!app) return undefined;
    const m = JSON.parse(fs.readFileSync(path.join(app, "manifest.json"), "utf8")) as {
      fingerprints?: { app?: unknown; node?: unknown; browser?: unknown };
    };
    const f = m.fingerprints;
    if (
      !f ||
      typeof f.app !== "string" ||
      !HEX.test(f.app) ||
      typeof f.node !== "string" ||
      !HEX.test(f.node)
    )
      return undefined;
    if (f.browser !== null && (typeof f.browser !== "string" || !HEX.test(f.browser))) return undefined;
    return { app: f.app, node: f.node, browser: f.browser };
  } catch {
    return undefined;
  }
}

export async function bundleWorkers(
  out: string,
  o: { browser?: string | undefined } = {},
): Promise<{ nodes: number }> {
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
  for (const { store, id } of libraryIds())
    copy(path.join(store, id), path.join(app, "node_modules", ".pnpm", id));

  // OCR language data (the pinned packages' files, as the server copies them for itself).
  fs.mkdirSync(path.join(app, "ocr"));
  for (const lang of OCR_LANGS)
    fs.copyFileSync(langFile(lang), path.join(app, "ocr", `${lang}.traineddata.gz`), CLONE);

  // The browser: the headless shell's folder.
  const exe = findBrowser(o.browser);
  if (!exe || path.basename(exe) !== "chrome-headless-shell")
    throw new Error(
      "no headless shell: pnpm exec playwright install --only-shell chromium (or EXPORT_BROWSER)",
    );
  copy(path.dirname(exe), path.join(root, "browser"));

  const sources = defaultFingerprintSources(o.browser);
  const manifest: WorkerManifest = {
    version: 1,
    fingerprints: await computeFingerprints(sources),
    ...sources.body,
  };
  for (const p of [
    ...Object.values(manifest.docgen.modules),
    ...Object.values(manifest.docgen.fonts),
    ...Object.values(manifest.extract.modules),
    ...Object.values(manifest.extract.assets),
  ])
    if (!fs.existsSync(path.join(app, p))) throw new Error(`missing from the bundle: ${p}`);
  fs.writeFileSync(path.join(app, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  let nodes = 0;
  for (const t of ["node", "app", "browser"]) nodes += checkTree(path.join(root, t));
  return { nodes };
}
