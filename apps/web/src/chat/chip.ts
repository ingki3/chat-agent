import type { ChangeSettingsRequest, ChatSettings, RuntimeDefaults, RuntimeOption } from "@agentlee/shared";

/**
 * The chip's pure parts (#19): its label, what "공용으로 쓰기" needs, and — on the new-conversation screen, where
 * there is no conversation to send a change to yet — the same change rules as the server
 * (`DefaultsService.change`), so the chip shows what the conversation will be created with. The server checks the
 * result again at creation (403).
 */

export const RUNTIME_NAME: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex" };

export const modelLabel = (options: RuntimeOption[] | undefined, runtime: string, model: string) =>
  options?.find((o) => o.runtime === runtime)?.models.find((m) => m.id === model)?.label ?? model;

/** `Claude Code · Opus 5.5` */
export function chipLabel(
  s: Pick<ChatSettings, "runtime" | "model"> | null,
  options?: RuntimeOption[],
): string {
  if (!s) return "쓸 수 있는 런타임 없음";
  const name = RUNTIME_NAME[s.runtime] ?? s.runtime;
  return s.model ? `${name} · ${modelLabel(options, s.runtime, s.model)}` : name;
}

/** "공용으로 쓰기" is a choice only when the user has both their own and a shared connection for the runtime. */
export function canChooseShared(option: RuntimeOption | undefined): boolean {
  if (!option?.needsConnection) return false;
  const scopes = new Set(option.connections.map((c) => c.scope));
  return scopes.has("personal") && scopes.has("shared");
}

/** The settings after `change`, as the server would make them (runtime only → its default model, …). */
export function applyChange(
  current: ChatSettings,
  change: ChangeSettingsRequest,
  options: RuntimeOption[],
  defaults: RuntimeDefaults | undefined,
): ChatSettings | null {
  const runtime = change.runtime ?? current.runtime;
  const option = options.find((o) => o.runtime === runtime);
  if (!option) return null;
  const runtimeChanged = runtime !== current.runtime;
  const saved = defaults?.models[runtime];
  let model: string;
  let preferredEffort: string | null;
  if (change.model !== undefined) {
    model = change.model;
    preferredEffort =
      !runtimeChanged && model === current.model
        ? current.effort
        : saved?.model === model
          ? saved.effort
          : null;
  } else if (runtimeChanged) {
    model = saved?.model ?? "";
    preferredEffort = saved?.effort ?? null;
  } else {
    model = current.model;
    preferredEffort = current.effort;
  }
  const m =
    option.models.find((x) => x.id === model) ?? (change.model === undefined ? option.models[0] : undefined);
  if (!m) return null;
  if (m.id !== model) preferredEffort = null;
  let effort: string | null;
  if (change.effort !== undefined) {
    if (!m.efforts.includes(change.effort)) return null;
    effort = change.effort;
  } else if (preferredEffort && m.efforts.includes(preferredEffort)) effort = preferredEffort;
  else
    effort =
      (m.defaultEffort && m.efforts.includes(m.defaultEffort) ? m.defaultEffort : m.efforts[0]) ?? null;
  const useShared = change.useShared ?? (runtimeChanged ? false : current.useShared);
  return { runtime, model: m.id, effort, useShared };
}

/** Whether the next reply is answered differently from the last one (the chip says "다음 메시지부터"). */
export const differs = (
  s: Pick<ChatSettings, "runtime" | "model" | "effort"> | null,
  last: { runtime: string | null; model: string | null; effort: string | null } | undefined,
) =>
  !!s &&
  !!last?.runtime &&
  !!last.model &&
  (s.runtime !== last.runtime || s.model !== last.model || s.effort !== last.effort);
