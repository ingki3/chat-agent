import type { NotificationKind } from "@agentlee/shared";

/**
 * What a notification says (#34, FR-13.5). The server writes every title and body from typed input, so a
 * publishing point cannot put arbitrary content on a lock screen:
 * - the body is at most two lines (and a bounded length) — lock screens show it to anyone nearby;
 * - a share notification names who shared what, never the shared content;
 * - a result the recipient only sees through a share gets a fixed body (`sharedBody`), not the result summary.
 */

export const TITLE_MAX = 60;
export const LINE_MAX = 80;
export const BODY_LINES = 2;

/** Typed input of each publishing point. Later issues call `notifications.publish(userId, input)`. */
export type PublishInput =
  | {
      /** Schedule run finished (#33/#56). `summary` = the result; only its first two lines are kept. */
      kind: "schedule_succeeded";
      scheduleName: string;
      summary: string;
      url: string;
      ref?: ResourceRefInput;
    }
  | { kind: "schedule_failed"; scheduleName: string; reason: string; url: string; ref?: ResourceRefInput }
  | {
      /** A family member shared something with the recipient (#29/#52). No content — only who and the title. */
      kind: "share_received";
      fromName: string;
      itemTitle: string;
      url: string;
      ref: ResourceRefInput;
    }
  /** The recipient's runtime connection was lost or expired (#17, FR-11.8). */
  | { kind: "connection_lost"; runtimeLabel: string; url?: string }
  /** Admin only (#35). `message` is a short fixed text written by the server, never user content. */
  | { kind: "system_warning"; message: string; url?: string }
  /** Admin only (#32, FR-9.5): today's cost passed the admin's threshold. */
  | { kind: "daily_cost"; amountUsd: number; thresholdUsd: number; url?: string }
  /** "테스트 알림" button in settings. */
  | { kind: "test" };

export type ResourceRefInput = { kind: string; id: string };

export type Composed = { kind: NotificationKind; title: string; body: string; url: string };

/** Kinds only an admin may receive. */
export const ADMIN_KINDS: ReadonlySet<NotificationKind> = new Set(["system_warning", "daily_cost"]);

/** Body shown when the recipient sees the item only through a share: nothing of its content. */
export const SHARED_BODY = "공유받은 대화에 새 결과가 있어요. 눌러서 확인하세요.";

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;

function clip(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join("")}…`;
}

/** One line: no control or bidi characters, collapsed spaces, bounded length. */
export function oneLine(s: string, max = TITLE_MAX): string {
  return clip(
    s
      .replace(/\r\n?|\n/g, " ")
      .replace(CONTROL, "")
      .replace(/\s+/g, " ")
      .trim(),
    max,
  );
}

/**
 * At most two non-empty lines of at most LINE_MAX characters each. Markdown markers at line starts (#, -, >, *)
 * are dropped so a summary reads as text.
 */
export function twoLines(s: string): string {
  const lines = s
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) =>
      l
        .replace(CONTROL, "")
        .replace(/^\s*(?:#{1,6}|[-*+>]|\d+\.)\s+/, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
  const kept = lines.slice(0, BODY_LINES).map((l) => clip(l, LINE_MAX));
  if (lines.length > BODY_LINES && kept.length) {
    const last = kept.length - 1;
    if (!kept[last]!.endsWith("…")) kept[last] = `${clip(kept[last]!, LINE_MAX - 1)}…`;
  }
  return kept.join("\n");
}

/**
 * Same-origin in-app path only (`/c/<id>?x#y`). Anything else — another origin, a protocol-relative `//host`,
 * a backslash trick, `javascript:` — becomes `/`. The service worker checks again before opening it.
 */
const isSinglePath = (p: string) => p.startsWith("/") && !/^\/[/\\]/.test(p) && !/[\s\\]/.test(p);

export function safePath(url: string | undefined): string {
  if (!url || url.length > 512 || !isSinglePath(url)) return "/";
  try {
    const base = "https://agentlee.invalid";
    const u = new URL(url, base);
    if (u.origin !== base) return "/";
    const out = `${u.pathname}${u.search}${u.hash}`;
    // Normalising can turn "/a/..//evil.example" into "//evil.example": check the result again.
    return isSinglePath(out) ? out : "/";
  } catch {
    return "/";
  }
}

const won = (n: number) => `$${n.toFixed(2)}`;

export function compose(input: PublishInput): Composed {
  switch (input.kind) {
    case "schedule_succeeded":
      return {
        kind: input.kind,
        title: oneLine(input.scheduleName),
        body: twoLines(input.summary) || "실행이 끝났어요.",
        url: safePath(input.url),
      };
    case "schedule_failed":
      return {
        kind: input.kind,
        title: oneLine(input.scheduleName),
        body: twoLines(`실행 실패 — ${oneLine(input.reason, LINE_MAX)}`),
        url: safePath(input.url),
      };
    case "share_received":
      return {
        kind: input.kind,
        title: "가족이 공유했어요",
        body: twoLines(
          `${oneLine(input.fromName, 20)}님이 「${oneLine(input.itemTitle, 40)}」을(를) 공유했어요`,
        ),
        url: safePath(input.url),
      };
    case "connection_lost":
      return {
        kind: input.kind,
        title: `${oneLine(input.runtimeLabel, 30)} 연결이 끊겼어요`,
        body: "다시 로그인하거나 다른 런타임으로 이어가세요.",
        url: safePath(input.url ?? "/settings"),
      };
    case "system_warning":
      return {
        kind: input.kind,
        title: "시스템 경고",
        body: twoLines(input.message),
        url: safePath(input.url ?? "/admin"),
      };
    case "daily_cost":
      return {
        kind: input.kind,
        title: "오늘 비용이 기준을 넘었어요",
        body: `오늘 ${won(input.amountUsd)} · 기준 ${won(input.thresholdUsd)} (막지는 않아요)`,
        url: safePath(input.url ?? "/admin"),
      };
    case "test":
      return {
        kind: input.kind,
        title: "테스트 알림",
        body: "알림이 잘 와요. 누르면 설정 화면이 열려요.",
        url: "/settings",
      };
  }
}

/** One push for everything held during quiet hours (FR-13.4): a count and the first titles, never bodies. */
export function bundle(titles: string[]): { title: string; body: string; url: string } {
  return {
    title: `알림 ${titles.length}개가 와 있어요`,
    body: twoLines(titles.slice(0, BODY_LINES).join("\n")),
    url: "/notifications",
  };
}
