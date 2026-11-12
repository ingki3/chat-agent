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
export function chipLabel(s: { runtime: string; model: string } | null, options?: RuntimeOption[]): string {
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

/**
 * Usage limits of a runtime's connections (#19): `blocked` when every connection the user could use is at its limit
 * (the server refuses moving onto it, 403 `connection_limited`); `viaShared` when only the personal ones are, so the
 * chip can switch with "공용으로 쓰기" instead; `until` = when the earliest limit ends.
 */
export function runtimeLimit(
  option: RuntimeOption | undefined,
  now: number,
): { blocked: boolean; viaShared: boolean; until: number | null } {
  const conns = option?.needsConnection ? option.connections : [];
  const limited = (c: (typeof conns)[number]) => c.limitedUntil !== null && c.limitedUntil > now;
  const personal = conns.filter((c) => c.scope === "personal");
  const shared = conns.filter((c) => c.scope === "shared");
  const ends = conns.filter(limited).map((c) => c.limitedUntil!);
  const until = ends.length ? Math.min(...ends) : null;
  // Personal first (FR-11.3): the run would take a personal one when there is any.
  const first = personal.length ? personal : shared;
  const firstBlocked = first.length > 0 && first.every(limited);
  const sharedFree = shared.some((c) => !limited(c));
  return {
    blocked: firstBlocked && !(personal.length > 0 && sharedFree),
    viaShared: firstBlocked && personal.length > 0 && sharedFree,
    until,
  };
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

/** "기본값을 쓸 수 없어 ○○로 시작했어요" (FR-12.6). */
export const noticeText = (n: { runtime: string; model: string }, options?: RuntimeOption[]) =>
  `기본값을 쓸 수 없어 ${chipLabel(n, options)}로 시작했어요`;

/**
 * Asks the server for the fallback notice: what it hands over, or null — also when the request fails, so a notice is
 * never shown without the server having given it out (it stays there for the next page instead).
 */
export async function takeFallbackNotice<N>(consume: () => Promise<N | null>): Promise<N | null> {
  try {
    return await consume();
  } catch {
    return null;
  }
}

/** The conversation with only its notice cleared (nothing else of a possibly older response is applied). */
export const withoutNotice = <C extends { fallbackNotice: unknown }>(c: C): C => ({
  ...c,
  fallbackNotice: null,
});

/** Whether the next reply is answered differently from the last one (the chip says "다음 메시지부터"). */
export const differs = (
  s: Pick<ChatSettings, "runtime" | "model" | "effort"> | null,
  last: { runtime: string | null; model: string | null; effort: string | null } | undefined,
) =>
  !!s &&
  !!last?.runtime &&
  !!last.model &&
  (s.runtime !== last.runtime || s.model !== last.model || s.effort !== last.effort);
