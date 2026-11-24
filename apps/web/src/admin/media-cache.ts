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
  /** The ticket of the latest read started so far (0 before any). */
  current(): number {
    return this.started;
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
 * The screen's memory with the QueryClient's lifetime, as an external store (`useSyncExternalStore`): whichever
 * form is mounted now sees its changes — the settings save in progress, the rejected generations — and every
 * request to read the status again goes through one place (`requestRefresh`), coalesced into one read per turn.
 */
export type SettingsOp = "save" | "reload";

export class MediaScreenStore {
  readonly reads = new StatusReads();
  readonly rejected = new RejectedGenerations();
  private pending: SettingsSave | null = null;
  private version = 0;
  private readonly listeners = new Set<() => void>();
  private scheduled = false;
  private run: (() => void) | null = null;

  constructor(private readonly schedule: (f: () => void) => void = (f) => void setTimeout(f, 0)) {}

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  getSnapshot = (): number => this.version;
  private emit(): void {
    this.version += 1;
    for (const l of [...this.listeners]) l();
  }

  get save(): SettingsSave | null {
    return this.pending;
  }
  /** Drops a finished or failed save (an edit takes over) and its reload failure note. A save being sent stays. */
  clearSave(): void {
    if (this.pending?.phase === "sending") return;
    this.pending = null;
    this.failedReload = false;
    this.emit();
  }

  // ---- the one settings-operation slot (review r8) -------------------------------------------------------
  // At most one settings operation — a save, or a "최신 값 불러오기" read — is in flight, each with its own id.
  // Starting one needs the slot free (every mounted form is locked while it is taken); a completion counts only
  // when its id is the slot's current one, so a late answer of an older operation changes nothing.
  private slot: { id: number; kind: SettingsOp } | null = null;
  private nextId = 0;
  private failedReload = false;

  get op(): SettingsOp | null {
    return this.slot?.kind ?? null;
  }
  get reloadFailed(): boolean {
    return this.failedReload;
  }
  private take(kind: SettingsOp): number | null {
    if (this.slot) return null;
    this.slot = { id: ++this.nextId, kind };
    return this.slot.id;
  }
  private owns(id: number): boolean {
    return this.slot?.id === id;
  }

  /** A save of `values` made from revision `base`; null (nothing starts) while another operation runs. */
  beginSave(values: MediaSettings, base: string): number | null {
    const id = this.take("save");
    if (id === null) return null;
    this.failedReload = false;
    this.pending = { phase: "sending", values, base };
    this.emit();
    return id;
  }
  /**
   * The save's answer. Success: confirmed by the first status read **started after** this moment (read order, not
   * a revision compare — a restore may bring back any revision). Ignored unless it is the current operation.
   */
  settleSave(id: number, r: { ok: true } | { ok: false; code: string; kind?: string | undefined }): boolean {
    if (!this.owns(id) || this.pending?.phase !== "sending") return false;
    const { values, base } = this.pending;
    this.pending = r.ok
      ? { phase: "confirming", values, base, afterTicket: this.reads.current() }
      : { phase: "failed", values, base, code: r.code, kind: r.kind, afterTicket: this.reads.current() };
    this.slot = null;
    this.emit();
    return true;
  }

  /** "최신 값 불러오기": null (nothing starts) while another operation runs. */
  beginReload(): number | null {
    const id = this.take("reload");
    if (id === null) return null;
    this.failedReload = false;
    this.emit();
    return id;
  }
  /**
   * The read's outcome. Only a new status that actually arrived drops the save's draft; otherwise the draft stays
   * and a retry is offered. Ignored (false) unless it is the current operation.
   */
  settleReload(id: number, arrived: boolean): boolean {
    if (!this.owns(id)) return false;
    this.slot = null;
    if (arrived) this.pending = null;
    else this.failedReload = true;
    this.emit();
    return true;
  }

  /** How the status is read again (set by the mounted screen; the QueryClient's, so any screen's will do). */
  setRefresh(run: () => void): void {
    this.run = run;
  }
  /** One status read for every request made in the same turn (a write's error and its settle, four 409s). */
  requestRefresh(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      this.run?.();
    });
  }

  /**
   * A call refused for `generation` (a catalog or a key write): an out-of-date status rejects the generation and
   * asks for one status read. Returns whether the error is one to show.
   */
  stale(e: unknown, generation: string): boolean {
    if (!isStaleKeyError(e)) return true;
    // Only the first refusal of a generation starts a read (later ones, in any turn, find it under way).
    if (this.rejected.reject(generation)) {
      this.emit();
      this.requestRefresh();
    }
    return false;
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
export type SettingsWrite = { settings: MediaSettings; expectedRevision: string };

export const keySaveArgs = (input: string, generation: string): KeySave => ({
  key: input.trim(),
  expectedGeneration: generation,
});
export const keyWriteArgs = (generation: string): KeyWrite => ({ expectedGeneration: generation });

/** After a key save: the input is cleared only if it still holds the key that was saved (a newer one is kept). */
export const inputAfterSave = (input: string, saved: string): string => (input.trim() === saved ? "" : input);

/**
 * A settings save (review r5–r9), held in the screen store so whichever form is mounted shows it: `sending` until
 * the server answers; `confirming` until a status read that **started after** the answer is shown (`afterTicket` —
 * read order, whatever revision it shows: a restore may bring back an old one); `failed` with the server's code (the
 * admin's values stay as their draft). Throughout `sending`/`confirming` the form shows the submitted values and is
 * locked. `base` is the revision the save was made from.
 */
export type SettingsSave =
  | { phase: "sending"; values: MediaSettings; base: string }
  | { phase: "confirming"; values: MediaSettings; base: string; afterTicket: number }
  | {
      phase: "failed";
      values: MediaSettings;
      base: string;
      code: string;
      kind?: string | undefined;
      /** The latest read started at the refusal: a later one shows the latest values (review r10). */
      afterTicket: number;
    };

export type FormState = {
  values: MediaSettings;
  locked: boolean;
  /** The save went through (shown from the answer on — apart from the lock). */
  saved: boolean;
  /** The failed save's code, when its values are still the draft shown. */
  failed: string | null;
  /** A status read started after the refusal is shown (the latest values are here; a re-save may go). */
  refreshed: boolean;
};

export function formState(o: {
  edit: MediaSettings | null;
  save: SettingsSave | null;
  server: MediaSettings;
  /** The ticket of the status read shown. */
  shownTicket: number;
  /** Another settings operation holds the slot. */
  busy?: boolean;
}): FormState {
  const { save } = o;
  const busy = o.busy ?? false;
  const none = { failed: null, refreshed: false };
  if (save?.phase === "sending") return { values: save.values, locked: true, saved: false, ...none };
  if (save?.phase === "confirming" && o.shownTicket <= save.afterTicket)
    return { values: save.values, locked: true, saved: true, ...none };
  if (save?.phase === "failed" && o.edit === null)
    return {
      values: save.values,
      locked: busy,
      saved: false,
      failed: save.code,
      refreshed: o.shownTicket > save.afterTicket,
    };
  return {
    values: formValue(o.edit, o.server),
    locked: busy,
    saved: save?.phase === "confirming" && o.edit === null,
    ...none,
  };
}

/**
 * Where the status read stands (review r12): under way, waiting for the connection (React Query's `paused`), failed
 * with nothing under way, or idle. A paused read is not a failure — it goes as soon as the connection is back.
 */
export type ReadState = "fetching" | "paused" | "failed" | "idle";
export function readState(fetchStatus: "fetching" | "paused" | "idle", isError: boolean): ReadState {
  if (fetchStatus !== "idle") return fetchStatus;
  return isError ? "failed" : "idle";
}

/**
 * What a settings conflict says before the latest values are here (review r10–r12): loading while a read is under
 * way, waiting while it waits for the connection, and the banner's retry once it failed. Null once the latest
 * values are here (the server's own message then).
 */
export function conflictNotice(refreshed: boolean, read: ReadState): string | null {
  if (refreshed) return null;
  if (read === "paused") return "다른 곳에서 설정이 바뀌었어요. 연결을 기다리는 중…";
  if (read === "failed")
    return "다른 곳에서 설정이 바뀌었어요. 최신 값을 불러오지 못했어요 — 위의 '다시 시도'를 눌러 주세요.";
  return "다른 곳에서 설정이 바뀌었어요. 최신 값을 불러오는 중…";
}

/** A write's button text while it is out: waiting for the connection (a paused mutation), or under way. */
export const pendingText = (paused: boolean, busy: string): string => (paused ? "연결을 기다리는 중…" : busy);

/**
 * The revision a save is made from: the one the admin's edit started from (an edit started before another save
 * elsewhere must not overwrite it — the server answers `media_settings_changed`), else the revision shown.
 */
export const expectedRevision = (editBase: string | null, serverRevision: string): string =>
  editBase ?? serverRevision;

/** The base of the draft shown: the edit's, else a failed save's (its values are the draft), else none. */
export const draftBase = (editBase: string | null, save: SettingsSave | null): string | null =>
  editBase ?? (save?.phase === "failed" ? save.base : null);
