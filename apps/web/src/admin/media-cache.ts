import type { MediaAdmin, MediaCatalog } from "@agentlee/shared";

/**
 * The admin screen's rules for which key status and which catalog it may show (#238 review r3), kept apart from the
 * components so they can be tested without a DOM. One closed design:
 *
 * - Every key status carries the server's key generation `<process id>:<key changes>`. A status never replaces one
 *   with a higher counter of the **same** process (a delayed GET or save answer from before a key change); a status
 *   from another process (a restart) always wins.
 * - Every catalog carries the generation it was actually read with. It is shown only while the key status shown has
 *   that same generation (and a key). Anything else shows no list.
 * - A catalog answer `media_key_changed` or `media_no_key` means the screen's status is out of date: hide the list
 *   and read the status again (which re-keys the catalog queries).
 */

export type Generation = { boot: string; n: number };

export function parseGeneration(g: string): Generation | undefined {
  const m = /^(.+):(\d+)$/.exec(g);
  return m ? { boot: m[1]!, n: Number(m[2]) } : undefined;
}

/** The status to keep: `incoming`, unless it is an older generation of the same server process than `current`. */
export function newerStatus(current: MediaAdmin | undefined, incoming: MediaAdmin): MediaAdmin {
  if (!current) return incoming;
  const a = parseGeneration(current.key.generation);
  const b = parseGeneration(incoming.key.generation);
  if (!a || !b || a.boot !== b.boot) return incoming;
  return b.n < a.n ? current : incoming;
}

/** The list to show for this status: only one read in the status's own generation, and only with a key. */
export function catalogView(
  status: Pick<MediaAdmin, "key"> | undefined,
  catalog: MediaCatalog | undefined,
): MediaCatalog | undefined {
  if (!status || status.key.source === "none" || !catalog) return undefined;
  return catalog.generation === status.key.generation ? catalog : undefined;
}

/** Error codes that say the screen's key status is out of date (not an error to show: the status is read again). */
export const STALE_KEY_CODES: ReadonlySet<string> = new Set(["media_key_changed", "media_no_key"]);

export const isStaleKeyError = (e: unknown): boolean =>
  typeof e === "object" && e !== null && STALE_KEY_CODES.has(String((e as { code?: unknown }).code));
