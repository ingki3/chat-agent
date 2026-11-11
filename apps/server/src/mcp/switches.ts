import { SKILL_CATALOGUE } from "@agentlee/mcp-tools/skills";
import type { SettingsStore } from "../db/settings-store.js";

const KEY = "skills.disabled";
const CATALOGUE = new Set(SKILL_CATALOGUE.map((e) => e.name));

/**
 * The server allow-list switch of each PRD §7 skill (#35, FR-10.3, D5): which skills this server offers at all.
 * Every skill is on unless the admin turned it off; an off skill is offered to nobody, whatever a user's own
 * permissions say (`McpService.allows`). Stored in settings as the list of switched-off names.
 */
export class SkillSwitches {
  private off: Set<string>;
  constructor(private readonly settings?: Pick<SettingsStore, "get" | "set">) {
    this.off = new Set(this.load());
  }

  private load(): string[] {
    try {
      const v: unknown = JSON.parse(this.settings?.get(KEY) ?? "[]");
      return Array.isArray(v) ? v.filter((n): n is string => typeof n === "string" && CATALOGUE.has(n)) : [];
    } catch {
      return [];
    }
  }

  enabled(skill: string): boolean {
    return !this.off.has(skill);
  }

  /** Turns one catalogue skill on or off for everyone. Unknown names are the caller's error (checked first). */
  set(skill: string, enabled: boolean): void {
    const next = new Set(this.off);
    if (enabled) next.delete(skill);
    else next.add(skill);
    this.settings?.set(KEY, JSON.stringify([...next].sort()));
    this.off = next;
  }
}
