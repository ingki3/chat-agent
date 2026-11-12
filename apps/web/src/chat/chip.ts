import { limitApplies, type ChatSettings, type RuntimeOption } from "@agentlee/shared";

/**
 * The chip's pure parts (#19): its label, what "공용으로 쓰기" needs, usage limits and the fallback notice. What a
 * change makes of the settings is never computed here — the server does it (`PUT …/settings`, and
 * `POST /api/settings/preview` on the new-conversation screen), so the screen cannot drift from its rules.
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

type Limit = { blocked: boolean; viaShared: boolean; until: number | null };

/** Until when `model` is limited on connection `c` (its latest applicable limit in force), or null. */
const connUntil = (c: RuntimeOption["connections"][number], model: string, now: number) => {
  const ends = c.limits.filter((l) => l.until > now && limitApplies(l.scope, model)).map((l) => l.until);
  return ends.length ? Math.max(...ends) : null;
};

/**
 * Usage limits for one model of a runtime (#19): `blocked` when the connection a run would take (personal first,
 * FR-11.3) is limited for it and there is no way around it (the server refuses, 403 `connection_limited`);
 * `viaShared` when only the personal ones are and a shared one is free — the chip switches with "공용으로 쓰기";
 * `until` = when the earliest of those limits ends.
 */
export function modelLimit(option: RuntimeOption | undefined, model: string, now: number): Limit {
  const conns = option?.needsConnection ? option.connections : [];
  const personal = conns.filter((c) => c.scope === "personal");
  const shared = conns.filter((c) => c.scope === "shared");
  const ends = conns.map((c) => connUntil(c, model, now)).filter((u): u is number => u !== null);
  const until = ends.length ? Math.min(...ends) : null;
  const first = personal.length ? personal : shared;
  const firstBlocked = first.length > 0 && first.every((c) => connUntil(c, model, now) !== null);
  const sharedFree = shared.some((c) => connUntil(c, model, now) === null);
  const viaShared = firstBlocked && personal.length > 0 && sharedFree;
  return { blocked: firstBlocked && !viaShared, viaShared, until };
}

/**
 * The same for a whole runtime: switching to it takes its default model, or its first model that is not limited
 * (the server's rule) — so it is `blocked` only when every model is, `viaShared` when none is free on the personal
 * connection but one is on the shared one.
 */
export function runtimeLimit(option: RuntimeOption | undefined, now: number): Limit {
  const per = (option?.models ?? []).map((m) => modelLimit(option, m.id, now));
  if (!per.length) return { blocked: false, viaShared: false, until: null };
  const free = per.some((l) => !l.blocked && !l.viaShared);
  const ends = per.map((l) => l.until).filter((u): u is number => u !== null);
  return {
    blocked: per.every((l) => l.blocked),
    viaShared: !free && per.some((l) => l.viaShared),
    until: ends.length ? Math.min(...ends) : null,
  };
}

const when = new Intl.DateTimeFormat("ko-KR", {
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
/** `11. 12. 오후 3:05` — when a usage limit ends. */
export const untilText = (ms: number) => when.format(ms);

/**
 * "기본값을 쓸 수 없어 ○○로 시작했어요" (FR-12.6), with the cause when it was a usage limit: "(사용 한도 · ○○ 이후
 * 다시 쓸 수 있어요)".
 */
export const noticeText = (
  n: { runtime: string; model: string; limitedUntil?: number | undefined },
  options?: RuntimeOption[],
) =>
  `기본값을 쓸 수 없어 ${chipLabel(n, options)}로 시작했어요` +
  (n.limitedUntil !== undefined ? ` (사용 한도 · ${untilText(n.limitedUntil)} 이후 다시 쓸 수 있어요)` : "");

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
