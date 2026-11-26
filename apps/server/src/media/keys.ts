import type { MediaKeySource } from "@agentlee/shared";
import type { SettingsStore } from "../db/settings-store.js";

/** Settings keys of the admin's OpenRouter key (#238): the key (encrypted) and its last check (plain JSON). */
export const OPENROUTER_KEY_SETTING = "media.openrouter_key";
export const OPENROUTER_KEY_STATUS_SETTING = "media.openrouter_key_status";
/**
 * #238 stage 3 (review item 9): a random token written with every save or delete of the admin's key — what a video
 * card remembers of the key it was made under (never the key, never derived from it), across restarts.
 */
export const OPENROUTER_KEY_REVISION_SETTING = "media.key_revision";

export type ResolvedKey = { key: string; source: Exclude<MediaKeySource, "none"> };

/**
 * The one OpenRouter key resolver (#238): the key the admin saved (관리자 → 미디어 생성) first, else `.env`'s
 * `OPENROUTER_API_KEY`. Media generation and `audio_transcribe`'s fallback both ask this, per request — a key
 * saved or deleted takes effect on the next request without a restart.
 */
export class OpenRouterKeys {
  constructor(
    private readonly settings: Pick<SettingsStore, "get"> | undefined,
    private readonly envKey: string | undefined,
  ) {}

  resolve(): ResolvedKey | undefined {
    let saved: string | undefined;
    try {
      saved = this.settings?.get(OPENROUTER_KEY_SETTING);
    } catch {
      saved = undefined; // a row that does not decrypt with this master key holds no usable key
    }
    if (saved) return { key: saved, source: "admin" };
    if (this.envKey) return { key: this.envKey, source: "env" };
    return undefined;
  }

  /**
   * The key and its mark from **one** read (#238 stage 3, review r4): `<source>:<revision>`, the revision a random
   * token written with every save or delete of the admin's key (`OPENROUTER_KEY_REVISION_SETTING`) — so a mark never
   * comes back (a key saved and deleted again leaves `.env`'s key with a new mark too); never the key or derived from
   * it. `ok: false` when the settings could not be read (an error, a row that does not decrypt) — unlike `resolve`,
   * which then falls back to `.env`'s key: a video job is never sent, polled or downloaded with another account's key
   * than the one it was approved under. `key` undefined: no key at all.
   */
  snapshot(): { ok: true; key: (ResolvedKey & { mark: string }) | undefined } | { ok: false } {
    let saved: string | undefined;
    let rev: string | undefined;
    try {
      saved = this.settings?.get(OPENROUTER_KEY_SETTING);
      rev = this.settings?.get(OPENROUTER_KEY_REVISION_SETTING);
    } catch {
      return { ok: false };
    }
    const r: ResolvedKey | undefined = saved
      ? { key: saved, source: "admin" }
      : this.envKey
        ? { key: this.envKey, source: "env" }
        : undefined;
    return { ok: true, key: r && { ...r, mark: `${r.source}:${rev || "initial"}` } };
  }

  /** The key's mark (`snapshot`); undefined without a key or when it could not be read. */
  mark(): string | undefined {
    const s = this.snapshot();
    return s.ok ? s.key?.mark : undefined;
  }

  source(): MediaKeySource {
    return this.resolve()?.source ?? "none";
  }
}
