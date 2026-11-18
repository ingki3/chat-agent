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
      /**
       * The schedule's next run would find no usable runtime connection (#56, FR-11.8): said before it (an hour
       * ahead). `runtimeLabel` is the runtime's fixed name; `at` the occurrence, shown in the schedule's time zone.
       */
      kind: "schedule_warning";
      scheduleName: string;
      runtimeLabel: string;
      at: number;
      timeZone: string;
      url: string;
      ref?: ResourceRefInput;
    }
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
  | { kind: "test" }
  /** 기억 정리 (#146, spec §8): N proposals wait for the user's review. A count only — never an item's text. */
  | { kind: "memory_proposal"; count: number }
  /** 기억 정리 applied N changes on its own (자동 반영). A count only. */
  | { kind: "memory_applied"; count: number }
  /** 기억 정리 (#188): the user's own round failed at its last attempt — a fixed reason code, never content. */
  | { kind: "memory_failed"; code: string | null }
  /** Admin only (#188): allowed shared connections are gone while N users chose them. No names, no content. */
  | { kind: "dreaming_failed"; users: number };

export type ResourceRefInput = { kind: string; id: string };

export type Composed = { kind: NotificationKind; title: string; body: string; url: string };

/** Kinds only an admin may receive. */
export const ADMIN_KINDS: ReadonlySet<NotificationKind> = new Set([
  "system_warning",
  "daily_cost",
  "dreaming_failed",
]);

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

/**
 * "오전 8:00" in the schedule's zone (a bad zone: Seoul). Written by hand from the numeric parts, so it reads the same
 * whatever the server's ICU data or locale (review #116: a small-ICU Node formats ko-KR as "8:00 AM").
 */
export function clock(at: number, timeZone: string): string {
  const parts = (tz: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .reduce<Record<string, string>>((o, p) => ({ ...o, [p.type]: p.value }), {});
  let p: Record<string, string>;
  try {
    p = parts(timeZone);
  } catch {
    p = parts("Asia/Seoul");
  }
  const h = Number(p.hour) % 24;
  return `${h < 12 ? "오전" : "오후"} ${h % 12 || 12}:${p.minute}`;
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
    case "schedule_warning":
      return {
        kind: input.kind,
        title: oneLine(input.scheduleName),
        body: twoLines(
          `${clock(input.at, input.timeZone)} 실행 전에 확인해 주세요 — ${oneLine(input.runtimeLabel, 30)} 연결을 쓸 수 없어요.\n` +
            "다시 연결하거나 예약의 런타임을 바꿔 주세요.",
        ),
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
    case "memory_proposal":
      return {
        kind: input.kind,
        title: "기억 정리",
        body: `기억 정리 제안 ${count(input.count)}개가 있어요`,
        url: "/settings/instructions?doc=dreams",
      };
    case "memory_applied":
      return {
        kind: input.kind,
        title: "기억 정리",
        body: `기억 ${count(input.count)}개를 정리했어요`,
        url: "/settings/instructions?doc=dreams",
      };
    case "memory_failed":
      return {
        kind: input.kind,
        title: "기억 정리 실패",
        body: twoLines(memoryFailedBody(input.code)),
        url: "/settings/instructions?doc=dreams",
      };
    case "dreaming_failed":
      return {
        kind: input.kind,
        title: "기억 정리 설정 확인",
        body: twoLines(
          `기억 정리에 쓰는 공용 연결을 쓸 수 없어 멈췄어요 (사용자 ${count(input.users)}명)\n관리자 → 기억 정리에서 확인해 주세요`,
        ),
        url: "/admin?tab=dreaming",
      };
  }
}

/** Fixed texts only (spec §8: no content) — the reason by its code. */
function memoryFailedBody(code: string | null): string {
  if (code === "too_large")
    return "오늘 기억 정리가 실패했어요 — 메시지가 1회 토큰 상한보다 커요\n관리자에게 상한을 올려 달라고 하세요";
  if (code === "runtime_auth" || code === "no_connection" || code === "connection_limited")
    return "오늘 기억 정리가 실패했어요 — 연결을 쓸 수 없었어요. 내일 다시 해요";
  return "오늘 기억 정리가 실패했어요. 내일 다시 해요";
}

const count = (n: number) => (Number.isInteger(n) && n >= 0 ? Math.min(n, 9999) : 0);

/** One push for everything held during quiet hours (FR-13.4): a count and the first titles, never bodies. */
export function bundle(titles: string[]): { title: string; body: string; url: string } {
  return {
    title: `알림 ${titles.length}개가 와 있어요`,
    body: twoLines(titles.slice(0, BODY_LINES).join("\n")),
    url: "/notifications",
  };
}
