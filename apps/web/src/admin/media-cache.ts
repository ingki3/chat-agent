import type { MediaAdmin, MediaCatalog, MediaSettings } from "@agentlee/shared";

/**
 * The admin screen's rules for what it may show (#238 review r3–r4), kept apart from the components so they can be
 * tested without a DOM. One closed design:
 *
 * 1. **The key status and settings shown are the answer of the most recently started status read — only.** Write
 *    answers (key saved, deleted, re-checked; settings saved) are never shown as status: whatever a write's outcome
 *    (success or failure), a new status read is started, and an answer of a read that is no longer the latest one
 *    started is dropped (`StatusReads`). Restarts, delayed writes and balance checks need no ordering of their own.
 * 2. **A catalog shows only in its own generation, and never in a rejected one.** Every catalog answer carries the
 *    key generation it was read with; it shows only while the status shown has that same generation and a key.
 *    When any catalog call answers `media_key_changed` or `media_no_key`, that generation is rejected for the whole
 *    screen (all four kinds hide their lists at once) and one status read is started — once per generation
 *    (`RejectedGenerations`), however many kinds hit it.
 * 3. **The settings form follows the latest status until the admin edits it** (`formValue`); an edit is kept until
 *    it is saved (then the form follows the next status read again).
 */

/** Hands out a ticket per status read started; only the latest ticket's answer may be shown. */
export class StatusReads {
  private started = 0;
  start(): number {
    return ++this.started;
  }
  isLatest(ticket: number): boolean {
    return ticket === this.started;
  }
}

/** Key generations a catalog call said are out of date. `reject` is true only the first time (start one read). */
export class RejectedGenerations {
  private readonly gens = new Set<string>();
  reject(generation: string): boolean {
    if (this.gens.has(generation)) return false;
    this.gens.add(generation);
    return true;
  }
  has(generation: string): boolean {
    return this.gens.has(generation);
  }
}

/** Error codes that say the screen's key status is out of date (not an error to show: the status is read again). */
export const STALE_KEY_CODES: ReadonlySet<string> = new Set(["media_key_changed", "media_no_key"]);

export const isStaleKeyError = (e: unknown): boolean =>
  typeof e === "object" && e !== null && STALE_KEY_CODES.has(String((e as { code?: unknown }).code));

/**
 * A catalog call failed under `generation`: an out-of-date status rejects the generation and starts one status read
 * (`refresh`, only for the first call to hit it). Returns whether the error is one to show.
 */
export function onCatalogError(
  e: unknown,
  generation: string,
  rejected: RejectedGenerations,
  refresh: () => void,
): boolean {
  if (!isStaleKeyError(e)) return true;
  if (rejected.reject(generation)) refresh();
  return false;
}

/** The list to show: read in the shown status's own generation, with a key, and that generation not rejected. */
export function catalogView(
  status: Pick<MediaAdmin, "key"> | undefined,
  catalog: MediaCatalog | undefined,
  rejected?: Pick<RejectedGenerations, "has">,
): MediaCatalog | undefined {
  if (!status || status.key.source === "none" || !catalog) return undefined;
  if (rejected?.has(status.key.generation)) return undefined;
  return catalog.generation === status.key.generation ? catalog : undefined;
}

/** The settings the form shows: the admin's unsaved edit, else the latest status read's. */
export const formValue = (edit: MediaSettings | null, server: MediaSettings): MediaSettings => edit ?? server;

/**
 * The screen's memory that must outlive the component (review r5): status read tickets and rejected generations
 * live with the QueryClient — leaving the menu and coming back keeps them, as the query cache does.
 */
export class MediaScreenStore {
  readonly reads = new StatusReads();
  readonly rejected = new RejectedGenerations();
  private pending: SettingsSave | null = null;
  /** A settings save sent or waiting for its confirming read (review r6: a re-entered form stays locked). */
  get save(): SettingsSave | null {
    return this.pending;
  }
  setSave(v: SettingsSave | null): void {
    this.pending = v;
  }
}
const stores = new WeakMap<object, MediaScreenStore>();
export function mediaScreenStore(queryClient: object): MediaScreenStore {
  let s = stores.get(queryClient);
  if (!s) stores.set(queryClient, (s = new MediaScreenStore()));
  return s;
}

/**
 * The inputs of every write, fixed when the admin clicks (review r6): a write React Query holds back (offline) and
 * sends later must send what was on screen at the click — never the input or generation of the moment it is sent.
 */
export type KeyWrite = { expectedGeneration: string };
export type KeySave = KeyWrite & { key: string };
export type SettingsWrite = { settings: MediaSettings; expectedVersion: number };

export const keySaveArgs = (input: string, generation: string): KeySave => ({
  key: input.trim(),
  expectedGeneration: generation,
});
export const keyWriteArgs = (generation: string): KeyWrite => ({ expectedGeneration: generation });

/** After a key save: the input is cleared only if it still holds the key that was saved (a newer one is kept). */
export const inputAfterSave = (input: string, saved: string): string => (input.trim() === saved ? "" : input);

/**
 * A settings save in progress (review r5): `sending` until the server answers, then `confirming` until a status read
 * shows the saved version (or a later one). Throughout, the form shows the submitted values and is locked — no
 * flash back to older values, no edit made meanwhile that the save would drop.
 */
export type SettingsSave =
  | { phase: "sending"; values: MediaSettings }
  | { phase: "confirming"; values: MediaSettings; version: number };

export type FormState = { values: MediaSettings; locked: boolean };

export function formState(o: {
  edit: MediaSettings | null;
  save: SettingsSave | null;
  server: MediaSettings;
  serverVersion: number;
}): FormState {
  const { save } = o;
  if (save && (save.phase === "sending" || o.serverVersion < save.version))
    return { values: save.values, locked: true };
  return { values: formValue(o.edit, o.server), locked: false };
}

/**
 * The version a save is made from: the version the admin's edit started from (an edit started before another save
 * elsewhere must not overwrite it — the server answers `media_settings_changed`), else the version shown.
 */
export const expectedVersion = (editBase: number | null, serverVersion: number): number =>
  editBase ?? serverVersion;
