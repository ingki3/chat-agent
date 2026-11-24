import crypto from "node:crypto";
import { DEFAULT_MEDIA_SETTINGS, MediaSettings } from "@agentlee/shared";
import type { SettingsStore } from "../db/settings-store.js";

export const MEDIA_SETTINGS_KEY = "media.settings";
/**
 * The settings' revision (#238 review r5, r9): a fresh random token written with every save. A save must name the
 * revision it was made from. A token, not a counter: a restored backup carries an older token, and a save after the
 * restore makes a new one — an open draft's base can never match it by accident (a counter would be reused).
 */
export const MEDIA_SETTINGS_REVISION_KEY = "media.settings_revision";
/** The revision before any save. */
export const INITIAL_REVISION = "initial";

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

  /** The settings' revision token (`INITIAL_REVISION` before the first save). */
  revision(): string {
    return this.settings?.get(MEDIA_SETTINGS_REVISION_KEY) || INITIAL_REVISION;
  }

  /** Writes the settings and a new revision token (the caller runs both in one transaction). */
  set(s: MediaSettings, revision: string = crypto.randomUUID()): MediaSettings {
    this.settings?.set(MEDIA_SETTINGS_KEY, JSON.stringify(MediaSettings.parse(s)));
    this.settings?.set(MEDIA_SETTINGS_REVISION_KEY, revision);
    return this.get();
  }
}
