import {
  AdminUser,
  AuthState,
  Conversation,
  CreateUserResponse,
  CSRF_HEADER,
  Message,
  Notification,
  NotificationList,
  NotificationPrefs,
  PushCheckResponse,
  PushDeviceList,
  PushKey,
  ResetPasswordResponse,
  UnreadCount,
  Run,
  StartRunResponse,
  type Role,
} from "@agentlee/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** Called when a request finds the session gone (401) — the app re-checks login and shows the login screen. */
let onUnauthenticated: () => void = () => {};
export const setUnauthenticatedHandler = (fn: () => void) => {
  onUnauthenticated = fn;
};

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * The outer layers (Cloudflare Access, the temporary code page) answer with these when *their* login ran out.
 * The app cannot renew those itself: reload the page so they can — they bring the user back to this address.
 */
const OUTER_AUTH = new Set(["gate_required", "access_denied", "access_not_configured"]);
let reloading = false;
function reauthenticateOuter() {
  if (reloading) return;
  reloading = true;
  window.location.reload();
}

/**
 * A fetch that failed outright may be Cloudflare Access sending an expired session to its login page (a
 * cross-origin redirect a fetch cannot follow). Check without following redirects; reload only in that case.
 */
async function checkOuterRedirect() {
  try {
    const r = await fetch("/api/health", { redirect: "manual", credentials: "same-origin" });
    if (r.type === "opaqueredirect" || r.status === 401) reauthenticateOuter();
  } catch {
    // really offline / server down: nothing to re-authenticate
  }
}

async function call(method: Method, url: string, body?: unknown, headers: Record<string, string> = {}) {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        // Cloudflare Access answers an expired session with 401 (not a login-page redirect) for such requests.
        "X-Requested-With": "XMLHttpRequest",
        // Required on every state-changing call (CSRF, see apps/server/src/auth/plugin.ts).
        ...(method === "GET" ? {} : { [CSRF_HEADER]: "1" }),
        // Only with a body: Fastify refuses an empty body declared as JSON (a body-less DELETE answered 400).
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    void checkOuterRedirect();
    throw e;
  }
  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  const json = (isJson ? await res.json().catch(() => ({})) : {}) as { error?: string };
  if (!res.ok) {
    // Our server always answers JSON; a 401/403 page that is not JSON comes from Access in front of it.
    if ((json.error && OUTER_AUTH.has(json.error)) || ((res.status === 401 || res.status === 403) && !isJson))
      reauthenticateOuter();
    else if (res.status === 401 && !url.startsWith("/api/auth/")) onUnauthenticated();
    throw new ApiError(res.status, json.error ?? "unknown");
  }
  return json as unknown;
}

export const auth = {
  state: async () => AuthState.parse(await call("GET", "/api/auth/state")),
  setup: async (name: string, password: string) =>
    AuthState.parse(await call("POST", "/api/auth/setup", { name, password })),
  login: async (email: string, password: string) =>
    AuthState.parse(await call("POST", "/api/auth/login", { email, password })),
  logout: async () => AuthState.parse(await call("POST", "/api/auth/logout", {})),
  changePassword: async (currentPassword: string, newPassword: string) =>
    AuthState.parse(await call("POST", "/api/auth/password", { currentPassword, newPassword })),
};

export const admin = {
  users: async () =>
    AdminUser.array().parse(((await call("GET", "/api/admin/users")) as { users: unknown }).users),
  create: async (name: string, email: string, role: Role) =>
    CreateUserResponse.parse(await call("POST", "/api/admin/users", { name, email, role })),
  deactivate: async (id: string) => call("POST", `/api/admin/users/${encodeURIComponent(id)}/deactivate`, {}),
  resetPassword: async (id: string) =>
    ResetPasswordResponse.parse(
      await call("POST", `/api/admin/users/${encodeURIComponent(id)}/reset-password`, {}),
    ),
};

const enc = encodeURIComponent;

export const conversations = {
  /** One page of the list; pass the returned cursor for the next one. */
  list: async (q = "", cursor?: string) => {
    const r = (await call(
      "GET",
      `/api/conversations?limit=50${q ? `&q=${enc(q)}` : ""}${cursor ? `&cursor=${enc(cursor)}` : ""}`,
    )) as { items: unknown[]; nextCursor: string | null };
    return { items: Conversation.array().parse(r.items), nextCursor: r.nextCursor };
  },
  get: async (id: string) => Conversation.parse(await call("GET", `/api/conversations/${enc(id)}`)),
  create: async () => Conversation.parse(await call("POST", "/api/conversations", {})),
  rename: async (id: string, title: string) =>
    Conversation.parse(await call("PATCH", `/api/conversations/${enc(id)}`, { title })),
  pin: async (id: string, pinned: boolean) =>
    Conversation.parse(await call("PATCH", `/api/conversations/${enc(id)}`, { pinned })),
  remove: async (id: string) => call("DELETE", `/api/conversations/${enc(id)}`),
  /** A page of messages, oldest → newest; `before` asks for the page older than that seq. */
  messages: async (id: string, before?: number) => {
    const r = (await call(
      "GET",
      `/api/conversations/${enc(id)}/messages?limit=100${before ? `&before=${before}` : ""}`,
    )) as { items: unknown[]; nextBefore: number | null };
    return { items: Message.array().parse(r.items), nextBefore: r.nextBefore };
  },
  send: async (id: string, text: string) =>
    StartRunResponse.parse(
      await call("POST", `/api/conversations/${enc(id)}/messages`, { text }, { "Idempotency-Key": newKey() }),
    ),
  activeRun: async (id: string) => {
    const r = (await call("GET", `/api/conversations/${enc(id)}/active-run`)) as { run: unknown };
    return r.run === null ? null : Run.parse(r.run);
  },
};

/** Every notification query lives under this key (badge and list), so one invalidation refreshes both. */
export const NOTIFICATIONS_KEY = ["notifications"] as const;

/** Inbox (🔔) and notification settings (#34). */
export const notifications = {
  list: async () => NotificationList.parse(await call("GET", "/api/notifications?limit=100")),
  unread: async () => UnreadCount.parse(await call("GET", "/api/notifications/unread")).unread,
  read: async (id: string) =>
    Notification.parse(await call("POST", `/api/notifications/${enc(id)}/read`, {})),
  readAll: async () => UnreadCount.parse(await call("POST", "/api/notifications/read-all", {})).unread,
  test: async () => call("POST", "/api/notifications/test", {}),
  prefs: async () => NotificationPrefs.parse(await call("GET", "/api/notifications/prefs")),
  setPrefs: async (p: NotificationPrefs) =>
    NotificationPrefs.parse(await call("PUT", "/api/notifications/prefs", p)),
};

/** Web push devices (#34). */
export const push = {
  key: async () => PushKey.parse(await call("GET", "/api/push/key")).publicKey,
  /** The account's devices and this session's tag. */
  devices: async () => PushDeviceList.parse(await call("GET", "/api/push/devices")),
  /**
   * Registers this browser for the session tagged `sessionTag` (409 `session_changed` if the browser is now
   * signed in to another one); `replaces` = this session's older device, swapped in one server transaction.
   */
  register: async (sub: PushSubscriptionJSON, label: string, sessionTag: string, replaces?: string) =>
    PushDeviceList.parse(
      await call("POST", "/api/push/devices", {
        ...sub,
        label,
        sessionTag,
        ...(replaces ? { replaces } : {}),
      }),
    ),
  remove: async (id: string) => PushDeviceList.parse(await call("DELETE", `/api/push/devices/${enc(id)}`)),
  /** Is this endpoint hash the one registered by my session? (compared on the server) */
  check: async (endpointHash: string) =>
    PushCheckResponse.parse(await call("POST", "/api/push/devices/check", { endpointHash })).match,
};

export const runs = {
  interrupt: async (id: string) => Run.parse(await call("POST", `/api/runs/${enc(id)}/interrupt`, {})),
};

/** One key per user action, so a retried request (double tap, flaky network) never starts a second reply. */
export function newKey(): string {
  return `k-${crypto.randomUUID()}`;
}

const MESSAGES: Record<string, string> = {
  email_taken: "이미 등록된 이메일이에요.",
  cannot_change_self: "본인 계정에는 할 수 없어요.",
  last_admin: "마지막 관리자는 비활성화할 수 없어요.",
  forbidden: "권한이 없어요.",
  invalid_credentials: "이메일 또는 비밀번호가 맞지 않아요.",
  too_many_attempts: "시도가 너무 많아요. 15분 뒤에 다시 시도하세요.",
  access_email_mismatch: "Cloudflare로 로그인한 이메일과 같은 계정으로만 들어올 수 있어요.",
  already_set_up: "관리자 계정이 이미 있어요. 로그인하세요.",
  invalid_request: "입력값을 확인하세요.",
  csrf: "요청이 거부됐어요. 페이지를 새로 고친 뒤 다시 시도하세요.",
  run_in_progress: "아직 답하는 중이에요. 끝나거나 멈춘 뒤에 보내세요.",
  not_found: "찾을 수 없어요.",
};
export const errorText = (e: unknown) =>
  e instanceof ApiError ? (MESSAGES[e.code] ?? `오류가 났어요 (${e.code})`) : "서버에 연결하지 못했어요.";
