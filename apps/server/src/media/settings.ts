import { DEFAULT_MEDIA_SETTINGS, MediaSettings } from "@agentlee/shared";
import type { SettingsStore } from "../db/settings-store.js";

export const MEDIA_SETTINGS_KEY = "media.settings";
/** Bumped by every save (#238 review r5): a save must name the version it was made from. */
export const MEDIA_SETTINGS_VERSION_KEY = "media.settings_version";

/**
 * The admin's media settings (#238) as one JSON row of `settings`. A missing or unreadable row is the defaults
 * (every kind off, $50 a day per user, the per-run call limits of the issue, 8-second videos).
 */
export class MediaSettingsStore {
  constructor(private readonly settings: Pick<SettingsStore, "get" | "set"> | undefined) {}

  get(): MediaSettings {
    const raw = this.settings?.get(MEDIA_SETTINGS_KEY);
    if (raw) {
      try {
        const r = MediaSettings.safeParse(JSON.parse(raw));
        if (r.success) return r.data;
      } catch {
        // falls through to the defaults
      }
    }
    return structuredClone(DEFAULT_MEDIA_SETTINGS);
  }

  /** The settings' version: 0 before the first save, +1 per save. */
  version(): number {
    const n = Number(this.settings?.get(MEDIA_SETTINGS_VERSION_KEY) ?? "0");
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  }

  /** Writes the settings and their new version (the caller runs both in one transaction). */
  set(s: MediaSettings, version: number = this.version() + 1): MediaSettings {
    this.settings?.set(MEDIA_SETTINGS_KEY, JSON.stringify(MediaSettings.parse(s)));
    this.settings?.set(MEDIA_SETTINGS_VERSION_KEY, String(version));
    return this.get();
  }
}
