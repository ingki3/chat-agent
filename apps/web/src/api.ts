import {
  AdminUser,
  AuthState,
  CreateUserResponse,
  CSRF_HEADER,
  ResetPasswordResponse,
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

async function call(method: "GET" | "POST", url: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      // Required on every state-changing call (CSRF, see apps/server/src/auth/plugin.ts).
      ...(method === "POST" ? { "Content-Type": "application/json", [CSRF_HEADER]: "1" } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, json.error ?? "unknown");
  return json;
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

const MESSAGES: Record<string, string> = {
  email_taken: "이미 등록된 이메일이에요.",
  cannot_change_self: "본인 계정에는 할 수 없어요.",
  last_admin: "마지막 관리자는 비활성화할 수 없어요.",
  forbidden: "권한이 없어요. 다시 로그인해 보세요.",
  invalid_credentials: "이메일 또는 비밀번호가 맞지 않아요.",
  too_many_attempts: "시도가 너무 많아요. 15분 뒤에 다시 시도하세요.",
  access_email_mismatch: "Cloudflare로 로그인한 이메일과 같은 계정으로만 들어올 수 있어요.",
  already_set_up: "관리자 계정이 이미 있어요. 로그인하세요.",
  invalid_request: "입력값을 확인하세요.",
  csrf: "요청이 거부됐어요. 페이지를 새로 고친 뒤 다시 시도하세요.",
};
export const errorText = (e: unknown) =>
  e instanceof ApiError ? (MESSAGES[e.code] ?? `오류가 났어요 (${e.code})`) : "서버에 연결하지 못했어요.";
