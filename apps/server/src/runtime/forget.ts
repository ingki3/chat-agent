import fs from "node:fs";
import path from "node:path";

/** Session ids the runtimes generate (Claude session UUIDs, Codex thread UUIDs): nothing else names a path here. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Sessions of this process that are live right now (any caller: runs, summaries, connection tests) — noted by the
 * adapters the moment an id exists, before anything of it is written, and dropped once the session has ended (its
 * processes exited, or its start failed). The reconciliation never takes a live one for an orphan (#54); an ended
 * one without a row is an orphan like any other.
 */
const liveInProcess = new Set<string>();
export function noteStarted(id: string): void {
  liveInProcess.add(id);
}
export function noteEnded(id: string): void {
  liveInProcess.delete(id);
}
export function startedHere(id: string): boolean {
  return liveInProcess.has(id);
}

/** A connection folder or one of its parts is a link (or not a folder): forgetting refuses to touch it. */
export class LinkedFolderError extends Error {
  constructor() {
    super("linked_folder");
    this.name = "LinkedFolderError";
  }
}

/** Each path is a plain folder or absent; a link (or a file) anywhere throws `LinkedFolderError`. */
export function assertNoLinks(paths: readonly string[]): void {
  for (const p of paths) {
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new LinkedFolderError();
  }
}

/**
 * The paths from the runtimes root down to a connection folder `runtimes/<connection>/<user>` (the root, the
 * connection, the user folder, its `-meta` sibling) and then `parts` inside it — for `assertNoLinks` before anything
 * is created, written or removed there.
 */
export function connectionChain(dir: string, parts: readonly string[] = []): string[] {
  const conn = path.dirname(dir);
  return [path.dirname(conn), conn, dir, `${dir}-meta`, ...parts];
}

/** A plain folder (not a link, not a file), or undefined. */
export function plainDir(p: string): string | undefined {
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  return st && !st.isSymbolicLink() && st.isDirectory() ? p : undefined;
}

/**
 * Removes the entries under `root` that are named after the session (`<id>`, `<id>.jsonl`, `<id>-agent-…`, or — with
 * `suffix` — ending in it), down to `depth` levels. Only plain folders are walked (a link is never followed: the
 * entry types are the entries' own); a matching link is removed as a link. Returns how many entries went.
 */
export function removeNamed(root: string, match: (name: string) => boolean, depth: number): number {
  if (!plainDir(root)) return 0;
  let removed = 0;
  const walk = (dir: string, level: number) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (match(e.name)) {
        // rmSync never follows the last name, nor links inside a folder it removes.
        fs.rmSync(p, { recursive: true, force: true });
        removed++;
      } else if (e.isDirectory() && level < depth) walk(p, level + 1);
    }
  };
  walk(root, 0);
  return removed;
}

/** `<id>` itself, or `<id>` followed by a separator (`.jsonl`, `-agent-…`, `_…`). */
export const namedAfter = (id: string) => (name: string) =>
  name === id || (name.startsWith(id) && /^[.\-_]/.test(name.slice(id.length)));

/** Our own per-session note `<dir>-meta/<id>.json` (both adapters keep one), through a plain folder only. */
export function removeMeta(dir: string, id: string): void {
  const meta = plainDir(`${dir}-meta`);
  if (!meta) return;
  for (const name of [`${id}.json`, `${id}.json.tmp`]) fs.rmSync(path.join(meta, name), { force: true });
}

const UUID_IN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

/** Session ids of our notes in `<dir>-meta/` (`<id>.json`, a `.tmp` left by a crash too). */
export function metaIds(dir: string): string[] {
  const meta = plainDir(`${dir}-meta`);
  if (!meta) return [];
  return fs.readdirSync(meta).flatMap((n) => {
    const m = /^([0-9a-f-]{36})\.json(\.tmp)?$/.exec(n);
    return m && SESSION_ID.test(m[1]!) ? [m[1]!] : [];
  });
}

/**
 * Session ids found in entry names under `root` (plain folders only, down to `depth`), by `pick` — a name's id or
 * undefined.
 */
export function idsNamed(root: string, pick: (name: string) => string | undefined, depth: number): string[] {
  if (!plainDir(root)) return [];
  const out = new Set<string>();
  const walk = (dir: string, level: number) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const id = pick(e.name);
      if (id && SESSION_ID.test(id)) out.add(id);
      else if (e.isDirectory() && level < depth) walk(path.join(dir, e.name), level + 1);
    }
  };
  walk(root, 0);
  return [...out];
}

/** The id of `<id>`, `<id>.jsonl`. */
export const ownName = (name: string) => {
  const m = /^([0-9a-f-]{36})(\.jsonl)?$/.exec(name);
  return m?.[1];
};
/** The id at the end of a Codex rollout name (`rollout-<time>-<id>.jsonl`). */
export const rolloutName = (name: string) => {
  if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) return undefined;
  return UUID_IN.exec(name.slice(-(36 + 6)))?.[1];
};
