import crypto from "node:crypto";
import {
  MEDIA_KINDS,
  type MediaAdmin,
  type MediaCatalog,
  type MediaKeyView,
  type MediaKind,
  type MediaSettings,
} from "@agentlee/shared";
import type { SettingsStore } from "../db/settings-store.js";
import { OPENROUTER_KEY_SETTING, OPENROUTER_KEY_STATUS_SETTING, type OpenRouterKeys } from "./keys.js";
import { checkKey, fetchCatalog, OpenRouterError, type KeyStatus } from "./openrouter.js";
import { YOUTH_STRICT_MODERATION } from "./policy.js";
import type { MediaSettingsStore } from "./settings.js";

export class MediaError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly kind?: MediaKind,
  ) {
    super(code);
  }
}

/** The admin key's last check, stored next to it: never the key, only what the screen shows. */
type StoredStatus = KeyStatus & { source: "admin"; last4: string; checkedAt: number };
/** The `.env` key's last check: in memory only, bound to that key's fingerprint (a rotated key shows nothing). */
type EnvStatus = KeyStatus & { fp: string; checkedAt: number };

export type MediaAdminOptions = {
  settings: Pick<SettingsStore, "get" | "set" | "setSecret">;
  /** Runs `fn` in one database transaction (all of its writes, or none). */
  transaction: (fn: () => void) => void;
  /** One `DELETE` of these settings rows. */
  remove: (keys: string[]) => void;
  keys: OpenRouterKeys;
  store: MediaSettingsStore;
  /** Tests and the e2e fixture: OpenRouter's answers. */
  fetchImpl?: typeof fetch | undefined;
  now?: () => number;
  /** How long a fetched catalog is reused for the screen (saving always fetches it again). */
  catalogTtlMs?: number;
  /** Tests: the process id part of the key generation (default: random). */
  bootId?: string;
};

const CATALOG_TTL_MS = 10 * 60_000;

/** A key's fingerprint for in-memory comparisons only (never stored, never sent). */
const fingerprint = (key: string) => crypto.createHash("sha256").update(key).digest("hex");

/**
 * 관리자 → 미디어 생성 (#238 stage 1): the OpenRouter key (checked with `GET /api/v1/key` before it is saved, then
 * stored encrypted together with its check in one transaction — the screen sees its last 4 characters and the
 * limit left), the per-kind catalogs, and the settings (each newly chosen model is checked against a freshly
 * fetched catalog before the save). Writes run one at a time; the caller is checked again right before anything
 * is stored (another admin may have demoted them, or the session ended, while OpenRouter answered).
 */
export class MediaAdminService {
  private queue: Promise<unknown> = Promise.resolve();
  /** Catalogs by kind, each tied to the key (fingerprint) and key generation it was read with. */
  private readonly cache = new Map<
    MediaKind,
    { at: number; fp: string; gen: number; catalog: MediaCatalog }
  >();
  /** Bumped on every key change (saved, deleted): a catalog read under another generation is never kept. */
  private gen = 0;
  /** This process's id: with `gen`, the key generation (a restart never reuses an old one). */
  private readonly boot: string;
  private envStatus: EnvStatus | undefined;
  private readonly now: () => number;

  constructor(private readonly o: MediaAdminOptions) {
    this.now = o.now ?? Date.now;
    this.boot = o.bootId ?? crypto.randomBytes(6).toString("hex");
  }

  /** The key generation: `<process id>:<key changes so far>` — never derived from the key. */
  generation(): string {
    return `${this.boot}:${this.gen}`;
  }

  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private fetchOpts() {
    return this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {};
  }

  private keyChanged(): void {
    this.gen += 1;
    this.cache.clear();
  }

  private stored(): StoredStatus | undefined {
    const raw = this.o.settings.get(OPENROUTER_KEY_STATUS_SETTING);
    if (!raw) return undefined;
    try {
      const s = JSON.parse(raw) as StoredStatus;
      return s.source === "admin" ? s : undefined;
    } catch {
      return undefined;
    }
  }

  keyView(): MediaKeyView {
    const resolved = this.o.keys.resolve();
    let own: (KeyStatus & { checkedAt: number }) | undefined;
    if (resolved?.source === "admin") {
      const st = this.stored();
      own = st && st.last4 === resolved.key.slice(-4) ? st : undefined;
    } else if (resolved?.source === "env") {
      const st = this.envStatus;
      own = st && st.fp === fingerprint(resolved.key) ? st : undefined;
    }
    return {
      source: resolved?.source ?? "none",
      last4: resolved?.source === "admin" ? resolved.key.slice(-4) : null,
      limitUsd: own?.limitUsd ?? null,
      limitRemainingUsd: own?.limitRemainingUsd ?? null,
      usageUsd: own?.usageUsd ?? null,
      checkedAt: own?.checkedAt ?? null,
      generation: this.generation(),
    };
  }

  view(): MediaAdmin {
    return {
      key: this.keyView(),
      settings: this.o.store.get(),
      settingsRevision: this.o.store.revision(),
      youthStrictModeration: YOUTH_STRICT_MODERATION,
    };
  }

  private async check(key: string): Promise<KeyStatus> {
    try {
      return await checkKey(key, this.o.fetchImpl);
    } catch (e) {
      if (e instanceof OpenRouterError && e.code === "unauthorized")
        throw new MediaError(400, "media_key_invalid");
      throw new MediaError(502, "media_key_check_failed");
    }
  }

  /**
   * A new admin key: checked with OpenRouter, then the key (encrypted) and its check saved in **one** transaction —
   * a failed write keeps the old key and its check as they were. Only its last 4 characters are ever shown.
   */
  registerKey(key: string, expectedGeneration: string, authorize: () => boolean): Promise<MediaAdmin> {
    return this.exclusive(async () => {
      if (!authorize()) throw new MediaError(403, "forbidden");
      this.expectGeneration(expectedGeneration);
      const st = await this.check(key);
      if (!authorize()) throw new MediaError(403, "forbidden");
      const stored: StoredStatus = { ...st, source: "admin", last4: key.slice(-4), checkedAt: this.now() };
      this.o.transaction(() => {
        this.expectGeneration(expectedGeneration);
        this.o.settings.setSecret(OPENROUTER_KEY_SETTING, key);
        this.o.settings.set(OPENROUTER_KEY_STATUS_SETTING, JSON.stringify(stored));
      });
      this.keyChanged();
      return this.view();
    });
  }

  /**
   * Every key write names the key generation the screen showed (#238 review r5): another one (the key was changed
   * elsewhere meanwhile) is `media_key_changed` and nothing changes — a delete never removes a key the screen did
   * not show.
   */
  private expectGeneration(expected: string): void {
    if (expected !== this.generation()) throw new MediaError(409, "media_key_changed");
  }

  /** The admin's key and its check go in one statement (the `.env` key, if any, is then the one in use). */
  deleteKey(expectedGeneration: string, authorize: () => boolean): Promise<MediaAdmin> {
    return this.exclusive(async () => {
      if (!authorize()) throw new MediaError(403, "forbidden");
      this.o.transaction(() => {
        this.expectGeneration(expectedGeneration);
        this.o.remove([OPENROUTER_KEY_SETTING, OPENROUTER_KEY_STATUS_SETTING]);
      });
      this.keyChanged();
      return this.view();
    });
  }

  /** Checks the key in use again (the admin's — stored — or `.env`'s — kept in memory) and its limit left. */
  refreshKey(expectedGeneration: string, authorize: () => boolean): Promise<MediaAdmin> {
    return this.exclusive(async () => {
      if (!authorize()) throw new MediaError(403, "forbidden");
      this.expectGeneration(expectedGeneration);
      const resolved = this.o.keys.resolve();
      if (!resolved) throw new MediaError(400, "media_no_key");
      const st = await this.check(resolved.key);
      if (!authorize()) throw new MediaError(403, "forbidden");
      this.o.transaction(() => {
        this.expectGeneration(expectedGeneration);
        if (resolved.source === "env")
          this.envStatus = { ...st, fp: fingerprint(resolved.key), checkedAt: this.now() };
        else {
          const stored: StoredStatus = {
            ...st,
            source: "admin",
            last4: resolved.key.slice(-4),
            checkedAt: this.now(),
          };
          this.o.settings.set(OPENROUTER_KEY_STATUS_SETTING, JSON.stringify(stored));
        }
      });
      return this.view();
    });
  }

  /**
   * A kind's catalog, read with the key in use (reused for a while unless `fresh` — only while that same key is in
   * use; `prices: false` reads the list alone and is not kept), answered with the generation it was read with. A read that started before the key changed is neither kept
   * nor returned (`media_key_changed`); so is one asked for under another generation than the current one
   * (`expected` — the screen's).
   */
  async catalog(kind: MediaKind, fresh = false, expected?: string, prices = true): Promise<MediaCatalog> {
    if (expected !== undefined && expected !== this.generation())
      throw new MediaError(409, "media_key_changed");
    const resolved = this.o.keys.resolve();
    if (!resolved) throw new MediaError(400, "media_no_key");
    const fp = fingerprint(resolved.key);
    const gen = this.gen;
    const hit = this.cache.get(kind);
    if (
      !fresh &&
      hit &&
      hit.fp === fp &&
      hit.gen === gen &&
      this.now() - hit.at < (this.o.catalogTtlMs ?? CATALOG_TTL_MS)
    )
      return hit.catalog;
    let catalog: Omit<MediaCatalog, "generation"> | undefined;
    let failure: unknown;
    try {
      catalog = await fetchCatalog(kind, { apiKey: resolved.key, prices, ...this.fetchOpts() });
    } catch (e) {
      failure = e;
    }
    // First whether the key is still the one this read used — for a failure as for a success: an old key's
    // 401 or outage is not the new key's.
    const now = this.o.keys.resolve();
    if (this.gen !== gen || !now || fingerprint(now.key) !== fp)
      throw new MediaError(409, "media_key_changed");
    if (!catalog) {
      if (failure instanceof OpenRouterError && failure.code === "unauthorized")
        throw new MediaError(400, "media_key_invalid");
      throw new MediaError(502, "media_catalog_failed", kind);
    }
    const answer: MediaCatalog = { ...catalog, generation: `${this.boot}:${gen}` };
    // A list read without its prices (a save's model check) is not what the screen should reuse.
    if (prices) this.cache.set(kind, { at: this.now(), fp, gen, catalog: answer });
    return answer;
  }

  /**
   * Saves the settings. A kind turned on, or given another (non-empty) model — on or off — is checked against its
   * catalog fetched again right now (`media_model_unknown` when the model is not in it). Turning a kind off with its
   * model kept, clearing a model, or changing only the limits needs no OpenRouter call.
   */
  saveSettings(next: MediaSettings, expectedRevision: string, authorize: () => boolean): Promise<MediaAdmin> {
    // Made from another revision than the stored one (saved elsewhere meanwhile, or restored): nothing is saved.
    const expectVersion = () => {
      if (this.o.store.revision() !== expectedRevision) throw new MediaError(409, "media_settings_changed");
    };
    return this.exclusive(async () => {
      if (!authorize()) throw new MediaError(403, "forbidden");
      expectVersion();
      const current = this.o.store.get();
      for (const kind of MEDIA_KINDS) {
        const n = next.kinds[kind];
        const c = current.kinds[kind];
        if (n.model === null) continue;
        const newModel = n.model !== c.model;
        const turnedOn = n.enabled && !c.enabled;
        if (!newModel && !turnedOn) continue;
        // Only whether the model is listed: the per-model price reads are not needed for that.
        const catalog = await this.catalog(kind, true, undefined, false);
        if (!catalog.models.some((m) => m.id === n.model))
          throw new MediaError(409, "media_model_unknown", kind);
      }
      if (!authorize()) throw new MediaError(403, "forbidden");
      this.o.transaction(() => {
        expectVersion();
        this.o.store.set(next);
      });
      return this.view();
    });
  }
}
