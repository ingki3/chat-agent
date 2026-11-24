import { DEFAULT_MEDIA_SETTINGS, MediaSettings } from "@agentlee/shared";
import type { SettingsStore } from "../db/settings-store.js";

export const MEDIA_SETTINGS_KEY = "media.settings";

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

  set(s: MediaSettings): MediaSettings {
    this.settings?.set(MEDIA_SETTINGS_KEY, JSON.stringify(MediaSettings.parse(s)));
    return this.get();
  }
}
