import {
  AdminRuntimesResponse,
  BackupItem,
  BackupsResponse,
  AdminSkillsResponse,
  DefaultsResponse,
  RuntimeOption,
  RuntimePolicy,
  SystemStatus,
  UserSkillsResponse,
  type RuntimeDefaults,
  AdminUsageReport,
  MyUsage,
  PriceTable,
  PriceTableResponse,
  UsageSettings,
  type ModelPrice,
  ArtifactDetail,
  ArtifactListResponse,
  AdminUser,
  AuthState,
  Connection,
  ConnectionTestResult,
  Conversation,
  type ChangeSettingsRequest,
  ConsumeFallbackNoticeResponse,
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
  SubscriptionLogin,
  UnreadCount,
  Run,
  type RunChoice,
  StartRunResponse,
  type ConnectionAuthType,
  type Role,
  type RuntimeId,
} from "@agentlee/shared";

const enc = encodeURIComponent;

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

async function call(
  method: Method,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
) {
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
      ...(signal ? { signal } : {}),
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
  create: async (name: string, email: string, role: Role, youth = false) =>
    CreateUserResponse.parse(await call("POST", "/api/admin/users", { name, email, role, youth })),
  deactivate: async (id: string) => call("POST", `/api/admin/users/${encodeURIComponent(id)}/deactivate`, {}),
  resetPassword: async (id: string) =>
    ResetPasswordResponse.parse(
      await call("POST", `/api/admin/users/${encodeURIComponent(id)}/reset-password`, {}),
    ),
  /** Name, email, role (#35). */
  update: async (id: string, patch: { name?: string; email?: string; role?: Role }) =>
    AdminUser.parse(((await call("PATCH", `/api/admin/users/${enc(id)}`, patch)) as { user: unknown }).user),
  setYouth: async (id: string, youth: boolean) =>
    AdminUser.parse(
      ((await call("PUT", `/api/admin/users/${enc(id)}/youth`, { youth })) as { user: unknown }).user,
    ),
  /** The admin's initial defaults for a user (FR-12.4); null = the service default. */
  setInitialDefaults: async (id: string, defaults: RuntimeDefaults | null) =>
    AdminUser.parse(
      ((await call("PUT", `/api/admin/users/${enc(id)}/defaults`, { defaults })) as { user: unknown }).user,
    ),
  policies: async (id: string) =>
    RuntimePolicy.array().parse(
      ((await call("GET", `/api/admin/users/${enc(id)}/runtime-policies`)) as { items: unknown }).items,
    ),
  setPolicies: async (id: string, items: RuntimePolicy[]) =>
    RuntimePolicy.array().parse(
      ((await call("PUT", `/api/admin/users/${enc(id)}/runtime-policies`, { items })) as { items: unknown })
        .items,
    ),
  userSkills: async (id: string) =>
    UserSkillsResponse.parse(await call("GET", `/api/admin/users/${enc(id)}/skills`)),
  setUserSkill: async (id: string, name: string, enabled: boolean) =>
    UserSkillsResponse.parse(
      await call("PUT", `/api/admin/users/${enc(id)}/skills/${enc(name)}`, { enabled }),
    ),
  skills: async () => AdminSkillsResponse.parse(await call("GET", "/api/admin/skills")).skills,
  setServerSkill: async (name: string, enabled: boolean) =>
    AdminSkillsResponse.parse(await call("PUT", `/api/admin/skills/${enc(name)}`, { enabled })).skills,
  runtimes: async () => AdminRuntimesResponse.parse(await call("GET", "/api/admin/runtimes")).items,
  system: async () => SystemStatus.parse(await call("GET", "/api/admin/system")),
  /** Backups (#37): list and "지금 백업". Restore is the CLI only. */
  backups: async () => BackupsResponse.parse(await call("GET", "/api/admin/backups")),
  backupNow: async () =>
    BackupItem.parse(((await call("POST", "/api/admin/backups", {})) as { item: unknown }).item),
  /** Family shared connections (#17): API keys only. */
  sharedConnections: async () =>
    Connection.array().parse(((await call("GET", "/api/admin/connections")) as { items: unknown }).items),
  addShared: async (body: { runtime: RuntimeId; secret: string; label?: string }) =>
    Connection.parse(
      (
        (await call("POST", "/api/admin/connections", { ...body, authType: "api_key" })) as {
          connection: unknown;
        }
      ).connection,
    ),
  testShared: async (id: string) =>
    ConnectionTestResult.parse(
      ((await call("POST", `/api/admin/connections/${enc(id)}/test`, {})) as { result: unknown }).result,
    ),
  removeShared: async (id: string) => call("DELETE", `/api/admin/connections/${enc(id)}`),
  /** A member's personal connections: list, register on their behalf (API keys), test as them, remove. */
  userConnections: async (id: string) =>
    Connection.array().parse(
      ((await call("GET", `/api/admin/users/${enc(id)}/connections`)) as { items: unknown }).items,
    ),
  addUserConnection: async (id: string, body: { runtime: RuntimeId; secret: string }) =>
    Connection.parse(
      (
        (await call("POST", `/api/admin/users/${enc(id)}/connections`, { ...body, authType: "api_key" })) as {
          connection: unknown;
        }
      ).connection,
    ),
  testUserConnection: async (id: string, connectionId: string) =>
    ConnectionTestResult.parse(
      (
        (await call("POST", `/api/admin/users/${enc(id)}/connections/${enc(connectionId)}/test`, {})) as {
          result: unknown;
        }
      ).result,
    ),
  removeUserConnection: async (id: string, connectionId: string) =>
    call("DELETE", `/api/admin/users/${enc(id)}/connections/${enc(connectionId)}`),
};

/** 설정 → 기본 런타임·모델 (FR-12.1, #35): what the picker may show and the saved defaults. */
export const settings = {
  runtimes: async () =>
    RuntimeOption.array().parse(((await call("GET", "/api/runtimes")) as { items: unknown }).items),
  /** The chip (#19): only runtimes that can answer now (allowed, with a passed connection or none needed). */
  usableRuntimes: async () =>
    RuntimeOption.array().parse(((await call("GET", "/api/runtimes/usable")) as { items: unknown }).items),
  defaults: async () => DefaultsResponse.parse(await call("GET", "/api/settings/defaults")),
  setDefaults: async (defaults: RuntimeDefaults | null) =>
    DefaultsResponse.parse(await call("PUT", "/api/settings/defaults", { defaults })),
};

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
  /** Starts on the defaults (FR-12.6 fallback by the server); `settings` = a chip choice made before sending. */
  create: async (settings?: ChangeSettingsRequest) =>
    Conversation.parse(await call("POST", "/api/conversations", settings ? { settings } : {})),
  /** The chip (#19): from the next message on. */
  changeSettings: async (id: string, change: ChangeSettingsRequest) =>
    Conversation.parse(await call("PUT", `/api/conversations/${enc(id)}/settings`, change)),
  /** Takes the fallback notice (#19): non-null only for the one caller that got it. */
  consumeFallbackNotice: async (id: string) =>
    ConsumeFallbackNoticeResponse.parse(
      await call("POST", `/api/conversations/${enc(id)}/fallback-notice/consume`, {}),
    ).notice,
  rename: async (id: string, title: string) =>
    Conversation.parse(await call("PATCH", `/api/conversations/${enc(id)}`, { title })),
  pin: async (id: string, pinned: boolean) =>
    Conversation.parse(await call("PATCH", `/api/conversations/${enc(id)}`, { pinned })),
  /** 자료 조사 모드 (FR-5.5, #25): the next reply of this conversation gets the research instructions. */
  research: async (id: string, researchMode: boolean) =>
    Conversation.parse(await call("PATCH", `/api/conversations/${enc(id)}`, { researchMode })),
  remove: async (id: string) => call("DELETE", `/api/conversations/${enc(id)}`),
  /** A page of messages, oldest → newest; `before` asks for the page older than that seq. */
  messages: async (id: string, before?: number) => {
    const r = (await call(
      "GET",
      `/api/conversations/${enc(id)}/messages?limit=100${before ? `&before=${before}` : ""}`,
    )) as { items: unknown[]; nextBefore: number | null };
    return { items: Message.array().parse(r.items), nextBefore: r.nextBefore };
  },
  /** `choice`: runtime / model / connection for this reply (#17, #19); none = the defaults. */
  send: async (id: string, text: string, choice: RunChoice = {}) =>
    StartRunResponse.parse(
      await call(
        "POST",
        `/api/conversations/${enc(id)}/messages`,
        { ...choice, text },
        { "Idempotency-Key": newKey() },
      ),
    ),
  /** "수정 후 다시 보내기": replaces a user message (and everything after it) and starts a new reply. */
  edit: async (id: string, messageId: string, text: string, choice: RunChoice = {}) =>
    StartRunResponse.parse(
      await call(
        "POST",
        `/api/conversations/${enc(id)}/messages/${enc(messageId)}/edit`,
        { ...choice, text },
        { "Idempotency-Key": newKey() },
      ),
    ),
  /** "다시 생성": replaces an assistant reply with a new one. */
  regenerate: async (id: string, messageId: string, choice: RunChoice = {}) =>
    StartRunResponse.parse(
      await call("POST", `/api/conversations/${enc(id)}/messages/${enc(messageId)}/regenerate`, choice, {
        "Idempotency-Key": newKey(),
      }),
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
  /** Removes every device of this login session ("끄기" on this device). */
  removeCurrent: async () => PushDeviceList.parse(await call("DELETE", "/api/push/devices/current")),
  remove: async (id: string) => PushDeviceList.parse(await call("DELETE", `/api/push/devices/${enc(id)}`)),
  /** Is this endpoint hash the one registered by my session? (compared on the server) */
  check: async (endpointHash: string) =>
    PushCheckResponse.parse(await call("POST", "/api/push/devices/check", { endpointHash })).match,
};

/** 설정 → 내 런타임 연결 (#17). Credentials go up once and never come back — the list shows a hint only. */
export const connections = {
  list: async () =>
    Connection.array().parse(((await call("GET", "/api/connections")) as { items: unknown }).items),
  create: async (body: {
    runtime: RuntimeId;
    authType: ConnectionAuthType;
    secret: string;
    label?: string;
  }) =>
    Connection.parse(((await call("POST", "/api/connections", body)) as { connection: unknown }).connection),
  test: async (id: string) =>
    ConnectionTestResult.parse(
      ((await call("POST", `/api/connections/${enc(id)}/test`, {})) as { result: unknown }).result,
    ),
  remove: async (id: string) => call("DELETE", `/api/connections/${enc(id)}`),
  /** Codex ChatGPT device-code login (#18): start, poll, cancel. `connectionId` = log in again on it. */
  startLogin: async (body: { runtime: "codex"; connectionId?: string }) =>
    SubscriptionLogin.parse(
      ((await call("POST", "/api/connections/logins", body)) as { login: unknown }).login,
    ),
  /** One poll; `signal` ends a request that hangs. */
  login: async (id: string, signal?: AbortSignal) => {
    const r = (await call("GET", `/api/connections/logins/${enc(id)}`, undefined, {}, signal)) as {
      login: unknown;
      connection: unknown;
    };
    return {
      login: SubscriptionLogin.parse(r.login),
      connection: r.connection ? Connection.parse(r.connection) : null,
    };
  },
  cancelLogin: async (id: string) => call("DELETE", `/api/connections/logins/${enc(id)}`),
};

/** Usage (#32): my own this month (sidebar, settings) and the admin's report, price table and threshold. */
export const USAGE_KEY = ["usage"] as const;
export const usage = {
  mine: async () => MyUsage.parse(await call("GET", "/api/usage/me")),
  report: async () => AdminUsageReport.parse(await call("GET", "/api/admin/usage")),
  prices: async () => PriceTableResponse.parse(await call("GET", "/api/admin/usage/prices")),
  savePrices: async (prices: ModelPrice[]) =>
    PriceTable.parse(await call("PUT", "/api/admin/usage/prices", { prices })),
  saveSettings: async (s: UsageSettings) =>
    UsageSettings.parse(await call("PUT", "/api/admin/usage/settings", s)),
};

export const runs = {
  get: async (id: string) => Run.parse(await call("GET", `/api/runs/${enc(id)}`)),
  interrupt: async (id: string) => Run.parse(await call("POST", `/api/runs/${enc(id)}/interrupt`, {})),
};

/** One key per user action, so a retried request (double tap, flaky network) never starts a second reply. */
export function newKey(): string {
  return `k-${crypto.randomUUID()}`;
}

const MESSAGES: Record<string, string> = {
  email_taken: "이미 등록된 이메일이에요.",
  cannot_change_self: "본인 계정에는 할 수 없어요.",
  last_admin: "관리자가 한 명도 남지 않게 할 수는 없어요. 다른 관리자를 먼저 지정하세요.",
  admin_email_change: "관리자 이메일은 Access 확인 절차(#36)로만 바꿔요.",
  subscription_self_only: "구독은 그 계정 주인이 직접 연결해야 해요.",
  forbidden: "권한이 없어요.",
  invalid_credentials: "이메일 또는 비밀번호가 맞지 않아요.",
  too_many_attempts: "시도가 너무 많아요. 15분 뒤에 다시 시도하세요.",
  access_email_mismatch: "Cloudflare로 로그인한 이메일과 같은 계정으로만 들어올 수 있어요.",
  already_set_up: "관리자 계정이 이미 있어요. 로그인하세요.",
  invalid_request: "입력값을 확인하세요.",
  csrf: "요청이 거부됐어요. 페이지를 새로 고친 뒤 다시 시도하세요.",
  run_in_progress: "아직 답하는 중이에요. 끝나거나 멈춘 뒤에 보내세요.",
  not_found: "찾을 수 없어요.",
  invalid_secret: "키 형식이 맞지 않아요. 복사한 값을 다시 확인하세요.",
  subscription_not_allowed: "이 계정에서는 이 구독을 연결할 수 없어요.",
  unsupported_auth: "아직 지원하지 않는 연결 방식이에요.",
  login_required: "ChatGPT 계정은 ‘ChatGPT로 로그인’으로 연결해요.",
  login_busy: "지금 진행 중인 로그인이 많아요. 잠시 뒤 다시 시도하세요.",
  login_unavailable: "로그인을 시작하지 못했어요. 잠시 뒤 다시 시도하세요.",
  shared_subscription: "공용 연결은 API 키로만 만들 수 있어요.",
  test_in_progress: "이미 테스트 중이에요.",
  connection_not_allowed: "이 연결은 쓸 수 없어요. 설정 → 내 런타임 연결을 확인하세요.",
  connection_limited: "이 런타임은 지금 사용 한도에 걸렸어요. 다른 런타임을 고르거나 잠시 뒤에 바꿔 주세요.",
  model_not_allowed: "허용되지 않은 모델이에요.",
  effort_not_allowed: "허용되지 않은 추론 강도예요.",
  runtime_not_allowed: "허용되지 않은 런타임이에요.",
  chip_unavailable: "지금은 고를 수 없는 조합이에요.",
  backup_running: "이미 백업 중이에요. 끝난 뒤 다시 눌러 주세요.",
  backup_unavailable: "이 서버에서는 백업을 만들지 않아요(BACKUP_DIR 확인).",
  backup_failed: "백업에 실패했어요. 디스크와 백업 폴더 권한을 확인하세요.",
  backup_disk_full: "디스크가 가득 차서 백업하지 못했어요.",
  shutting_down: "서버가 다시 시작하는 중이에요. 잠시 뒤에 다시 시도하세요.",
};
export const errorText = (e: unknown) =>
  e instanceof ApiError ? (MESSAGES[e.code] ?? `오류가 났어요 (${e.code})`) : "서버에 연결하지 못했어요.";

/** Artifacts (#27): one with its versions, a conversation's list, and revert (a copy as the newest version). */
export const artifacts = {
  get: async (id: string) => ArtifactDetail.parse(await call("GET", `/api/artifacts/${enc(id)}`)),
  list: async (conversationId: string) =>
    ArtifactListResponse.parse(await call("GET", `/api/conversations/${enc(conversationId)}/artifacts`))
      .items,
  revert: async (id: string, version: number) =>
    ArtifactDetail.parse(await call("POST", `/api/artifacts/${enc(id)}/revert`, { version })),
};
