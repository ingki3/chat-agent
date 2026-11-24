import type { MediaKeySource } from "@agentlee/shared";
import type { SettingsStore } from "../db/settings-store.js";

/** Settings keys of the admin's OpenRouter key (#238): the key (encrypted) and its last check (plain JSON). */
export const OPENROUTER_KEY_SETTING = "media.openrouter_key";
export const OPENROUTER_KEY_STATUS_SETTING = "media.openrouter_key_status";

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

  source(): MediaKeySource {
    return this.resolve()?.source ?? "none";
  }
}
