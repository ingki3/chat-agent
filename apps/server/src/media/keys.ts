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
   * The key's mark (#238 stage 3): `admin:<revision>` for the admin's key, `env` for `.env`'s (it changes only with a
   * restart and its own configuration), undefined without a key.
   */
  mark(): string | undefined {
    const r = this.resolve();
    if (!r) return undefined;
    if (r.source === "env") return "env";
    let rev: string | undefined;
    try {
      rev = this.settings?.get(OPENROUTER_KEY_REVISION_SETTING);
    } catch {
      rev = undefined;
    }
    return `admin:${rev || "initial"}`;
  }

  source(): MediaKeySource {
    return this.resolve()?.source ?? "none";
  }
}
