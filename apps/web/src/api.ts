import {
  AdminUser,
  AuthState,
  Conversation,
  CreateUserResponse,
  CSRF_HEADER,
  Message,
  ResetPasswordResponse,
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

type Method = "GET" | "POST" | "PATCH" | "DELETE";

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

async function call(method: Method, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      // Required on every state-changing call (CSRF, see apps/server/src/auth/plugin.ts).
      ...(method === "GET" ? {} : { "Content-Type": "application/json", [CSRF_HEADER]: "1" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    if (json.error && OUTER_AUTH.has(json.error)) reauthenticateOuter();
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
  list: async (q = "") => {
    const r = (await call("GET", `/api/conversations?limit=100${q ? `&q=${enc(q)}` : ""}`)) as {
      items: unknown[];
    };
    return Conversation.array().parse(r.items);
  },
  get: async (id: string) => Conversation.parse(await call("GET", `/api/conversations/${enc(id)}`)),
  create: async () => Conversation.parse(await call("POST", "/api/conversations", {})),
  rename: async (id: string, title: string) =>
    Conversation.parse(await call("PATCH", `/api/conversations/${enc(id)}`, { title })),
  pin: async (id: string, pinned: boolean) =>
    Conversation.parse(await call("PATCH", `/api/conversations/${enc(id)}`, { pinned })),
  remove: async (id: string) => call("DELETE", `/api/conversations/${enc(id)}`),
  messages: async (id: string) => {
    const r = (await call("GET", `/api/conversations/${enc(id)}/messages?limit=200`)) as { items: unknown[] };
    return Message.array().parse(r.items);
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
