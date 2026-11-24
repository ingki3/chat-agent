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

/** What is stored next to the key: never the key, only what the screen shows. */
type StoredStatus = KeyStatus & { source: "admin" | "env"; last4: string | null; checkedAt: number };

export type MediaAdminOptions = {
  settings: Pick<SettingsStore, "get" | "set" | "setSecret">;
  /** `DELETE` of settings rows (the key and its status). */
  remove: (keys: string[]) => void;
  keys: OpenRouterKeys;
  store: MediaSettingsStore;
  /** Tests and the e2e fixture: OpenRouter's answers. */
  fetchImpl?: typeof fetch | undefined;
  now?: () => number;
  /** How long a fetched catalog is reused for the screen (saving always fetches it again). */
  catalogTtlMs?: number;
};

const CATALOG_TTL_MS = 10 * 60_000;

/**
 * 관리자 → 미디어 생성 (#238 stage 1): the OpenRouter key (checked with `GET /api/v1/key` before it is saved, then
 * stored encrypted — the screen sees its last 4 characters and the limit left), the per-kind catalogs, and the
 * settings (each newly chosen model is checked against a freshly fetched catalog before the save). Writes run one
 * at a time; the caller is checked again right before anything is stored (another admin may have demoted them, or
 * the session ended, while OpenRouter answered).
 */
export class MediaAdminService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly cache = new Map<MediaKind, { at: number; catalog: MediaCatalog }>();
  private readonly now: () => number;

  constructor(private readonly o: MediaAdminOptions) {
    this.now = o.now ?? Date.now;
  }

  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private fetchOpts() {
    return this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {};
  }

  private status(): StoredStatus | undefined {
    const raw = this.o.settings.get(OPENROUTER_KEY_STATUS_SETTING);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as StoredStatus;
    } catch {
      return undefined;
    }
  }

  keyView(): MediaKeyView {
    const resolved = this.o.keys.resolve();
    const st = this.status();
    // A status of another key (the admin's deleted, `.env` changed) is not shown.
    const own =
      st &&
      resolved &&
      st.source === resolved.source &&
      (resolved.source === "env" || st.last4 === resolved.key.slice(-4))
        ? st
        : undefined;
    return {
      source: resolved?.source ?? "none",
      last4: resolved?.source === "admin" ? resolved.key.slice(-4) : null,
      limitUsd: own?.limitUsd ?? null,
      limitRemainingUsd: own?.limitRemainingUsd ?? null,
      usageUsd: own?.usageUsd ?? null,
      checkedAt: own?.checkedAt ?? null,
    };
  }

  view(): MediaAdmin {
    return {
      key: this.keyView(),
      settings: this.o.store.get(),
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

  /** A new admin key: checked with OpenRouter, then saved encrypted (only its last 4 characters are ever shown). */
  registerKey(key: string, authorize: () => boolean): Promise<MediaAdmin> {
    return this.exclusive(async () => {
      if (!authorize()) throw new MediaError(403, "forbidden");
      const st = await this.check(key);
      if (!authorize()) throw new MediaError(403, "forbidden");
      this.o.settings.setSecret(OPENROUTER_KEY_SETTING, key);
      const stored: StoredStatus = { ...st, source: "admin", last4: key.slice(-4), checkedAt: this.now() };
      this.o.settings.set(OPENROUTER_KEY_STATUS_SETTING, JSON.stringify(stored));
      this.cache.clear();
      return this.view();
    });
  }

  /** The admin's key goes (the `.env` key, if any, is then the one in use). */
  deleteKey(authorize: () => boolean): Promise<MediaAdmin> {
    return this.exclusive(async () => {
      if (!authorize()) throw new MediaError(403, "forbidden");
      this.o.remove([OPENROUTER_KEY_SETTING, OPENROUTER_KEY_STATUS_SETTING]);
      this.cache.clear();
      return this.view();
    });
  }

  /** Checks the key in use again (the admin's or `.env`'s) and stores the limit left. */
  refreshKey(authorize: () => boolean): Promise<MediaAdmin> {
    return this.exclusive(async () => {
      const resolved = this.o.keys.resolve();
      if (!resolved) throw new MediaError(400, "media_no_key");
      const st = await this.check(resolved.key);
      if (!authorize()) throw new MediaError(403, "forbidden");
      const stored: StoredStatus = {
        ...st,
        source: resolved.source,
        last4: resolved.source === "admin" ? resolved.key.slice(-4) : null,
        checkedAt: this.now(),
      };
      this.o.settings.set(OPENROUTER_KEY_STATUS_SETTING, JSON.stringify(stored));
      return this.view();
    });
  }

  /** A kind's catalog (reused for a while unless `fresh`). Needs a key: the catalogs are read with it. */
  async catalog(kind: MediaKind, fresh = false): Promise<MediaCatalog> {
    const hit = this.cache.get(kind);
    if (!fresh && hit && this.now() - hit.at < (this.o.catalogTtlMs ?? CATALOG_TTL_MS)) return hit.catalog;
    const resolved = this.o.keys.resolve();
    if (!resolved) throw new MediaError(400, "media_no_key");
    let catalog: MediaCatalog;
    try {
      catalog = await fetchCatalog(kind, { apiKey: resolved.key, ...this.fetchOpts() });
    } catch (e) {
      if (e instanceof OpenRouterError && e.code === "unauthorized")
        throw new MediaError(400, "media_key_invalid");
      throw new MediaError(502, "media_catalog_failed", kind);
    }
    this.cache.set(kind, { at: this.now(), catalog });
    return catalog;
  }

  /**
   * Saves the settings. A kind turned on, or given another model, is checked against its catalog fetched again
   * right now (`media_model_unknown` when the model is not in it); turning a kind off or changing only the limits
   * needs no OpenRouter call.
   */
  saveSettings(next: MediaSettings, authorize: () => boolean): Promise<MediaAdmin> {
    return this.exclusive(async () => {
      if (!authorize()) throw new MediaError(403, "forbidden");
      const current = this.o.store.get();
      for (const kind of MEDIA_KINDS) {
        const n = next.kinds[kind];
        const c = current.kinds[kind];
        if (!n.enabled || n.model === null) continue;
        if (c.enabled && c.model === n.model) continue;
        const catalog = await this.catalog(kind, true);
        if (!catalog.models.some((m) => m.id === n.model))
          throw new MediaError(409, "media_model_unknown", kind);
      }
      if (!authorize()) throw new MediaError(403, "forbidden");
      this.o.store.set(next);
      return this.view();
    });
  }
}
