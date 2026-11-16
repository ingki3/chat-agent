import { z } from "zod";

/**
 * Cloudflare Access sync (#36, PRD FR-15): the admin screen's "Access" tab. One Access application and one policy of
 * it are managed — only that policy's include-email rules; every other rule stays as it is.
 */
export const AccessMode = z.enum(["auto", "manual"]);
export type AccessMode = z.infer<typeof AccessMode>;

const Email = z.string().trim().toLowerCase().max(254).pipe(z.email());
const CfId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{1,64}$/);

/** `PUT /api/admin/access/registration`. `token` may be left out to keep the stored one (ids replaced only). */
export const AccessRegisterRequest = z
  .object({
    token: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{20,200}$/)
      .optional(),
    accountId: CfId,
    appId: CfId,
    policyId: CfId,
  })
  .strict();
export type AccessRegisterRequest = z.infer<typeof AccessRegisterRequest>;

export const AccessRegistration = z.object({
  accountId: z.string(),
  appId: z.string(),
  policyId: z.string(),
  /** Where the policy is written: a reusable policy or the application's own. */
  scope: z.enum(["reusable", "app"]),
  appName: z.string().nullable(),
  policyName: z.string().nullable(),
  /** The token's last 4 characters only (FR-15.6). */
  tokenMasked: z.string(),
  registeredAt: z.number().int(),
});
export type AccessRegistration = z.infer<typeof AccessRegistration>;

export const AccessSyncStatus = z.enum(["pending", "applying", "applied", "failed"]);
export type AccessSyncStatus = z.infer<typeof AccessSyncStatus>;
export const AccessRevokeResult = z.enum(["revoked", "unavailable", "failed"]);
export const AccessSync = z.object({
  id: z.string(),
  status: AccessSyncStatus,
  reasons: z.array(z.string()),
  mode: AccessMode.nullable(),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  errorCode: z.string().nullable(),
  attempts: z.number().int(),
  /** A rate-limited write is retried by the server itself at this time. */
  retryAt: z.number().int().nullable(),
  /** Access-session revocation of each removed email (where the token may do it). */
  revokes: z.array(z.object({ email: z.string(), result: AccessRevokeResult })),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  appliedAt: z.number().int().nullable(),
});
export type AccessSync = z.infer<typeof AccessSync>;

export const AdminEmailChangeState = z.enum(["pending", "added", "switched", "done", "cancelled"]);
export type AdminEmailChangeState = z.infer<typeof AdminEmailChangeState>;
export const AdminEmailChange = z.object({
  id: z.string(),
  userId: z.string(),
  oldEmail: z.string(),
  newEmail: z.string(),
  state: AdminEmailChangeState,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  switchedAt: z.number().int().nullable(),
});
export type AdminEmailChange = z.infer<typeof AdminEmailChange>;

/** One email the app wants in Access: an active account's, or the admin's new one during a change. */
export const AppAccessEmail = z.object({
  email: z.string(),
  name: z.string(),
  role: z.enum(["admin", "member"]),
  source: z.enum(["user", "admin_email_change"]),
});
export type AppAccessEmail = z.infer<typeof AppAccessEmail>;

/** `GET /api/admin/access`. */
export const AccessOverview = z.object({
  mode: AccessMode,
  registration: AccessRegistration.nullable(),
  /** What the app wants in the policy (sorted by email). */
  appEmails: z.array(AppAccessEmail),
  /** The open sync (pending, applying or failed), if any. */
  open: AccessSync.nullable(),
  /** The last applied sync. */
  lastApplied: AccessSync.nullable(),
  /** The app's list differs from what was last applied (or nothing was ever applied). */
  dirty: z.boolean(),
  adminEmailChange: AdminEmailChange.nullable(),
});
export type AccessOverview = z.infer<typeof AccessOverview>;

/** A change about to be saved, previewed before it is (FR-15.2: "Access 허용 목록이 이렇게 바뀝니다"). */
export const AccessPreviewChange = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), email: Email }).strict(),
  z.object({ kind: z.literal("update"), userId: z.string().min(1).max(64), email: Email }).strict(),
  z.object({ kind: z.literal("deactivate"), userId: z.string().min(1).max(64) }).strict(),
]);
export type AccessPreviewChange = z.infer<typeof AccessPreviewChange>;
export const AccessPreviewRequest = z.object({ change: AccessPreviewChange.optional() }).strict();
export type AccessPreviewRequest = z.infer<typeof AccessPreviewRequest>;

const Delta = z.object({ add: z.array(z.string()), remove: z.array(z.string()) });
/**
 * `POST /api/admin/access/preview`: the final list and what it really changes. `change` = what the change being
 * saved does; `drift` = differences already there before it (someone edited the dashboard, or an earlier sync did
 * not land); `add`/`remove` = both together, against the live list. In manual mode there is no live list:
 * `revision`, `accessEmails` and `drift` are null.
 */
export const AccessPreview = z.object({
  mode: AccessMode,
  revision: z.string().nullable(),
  policyName: z.string().nullable(),
  accessEmails: z.array(z.string()).nullable(),
  /** Include rules of the policy that are not a single email (groups, domains…): kept as they are. */
  otherRules: z.number().int(),
  final: z.array(z.string()),
  add: z.array(z.string()),
  remove: z.array(z.string()),
  change: Delta,
  drift: Delta.nullable(),
});
export type AccessPreview = z.infer<typeof AccessPreview>;

/** `POST /api/admin/access/apply`: the preview's revision and final list — refused when either has moved since. */
export const AccessApplyRequest = z
  .object({ revision: z.string().min(1).max(64), final: z.array(Email).max(500) })
  .strict();
/** `POST /api/admin/access/manual-done`: manual mode — the admin changed the dashboard to this final list. */
export const AccessManualDoneRequest = z.object({ final: z.array(Email).max(500) }).strict();
/** `POST /api/admin/access/admin-email`. */
export const AdminEmailChangeRequest = z.object({ email: Email }).strict();

/** `GET /api/access/admin-email/confirm` (FR-15.7 step 3): is this browser ready to confirm the new email? */
export const AdminEmailConfirmState = z.object({
  ready: z.boolean(),
  oldEmail: z.string().nullable(),
  newEmail: z.string().nullable(),
});
export type AdminEmailConfirmState = z.infer<typeof AdminEmailConfirmState>;

/** Korean text of the Access sync's error and failure codes. */
export const ACCESS_ERRORS: Record<string, string> = {
  access_not_registered: "Cloudflare API 토큰이 등록되지 않았어요(수동 모드).",
  access_manual_mode: "자동 반영을 쓰는 중이에요. 수동 완료 표시는 수동 모드에서만 해요.",
  access_revision_changed:
    "미리보기 뒤에 Cloudflare 쪽 정책이 바뀌었어요. 다시 미리보기를 열어 최종 목록을 확인하세요.",
  access_preview_stale: "미리보기 뒤에 앱 사용자 목록이 바뀌었어요. 다시 미리보기를 확인하세요.",
  admin_email_protected:
    "현재 관리자 이메일은 Access 허용 목록에서 뺄 수 없어요. 관리자 이메일 변경 절차를 쓰세요.",
  access_nothing_to_retry: "다시 시도할 반영이 없어요.",
  access_busy: "이미 반영 중이에요. 잠시 뒤 다시 확인하세요.",
  access_app_mismatch: "이 애플리케이션의 AUD 태그가 서버 설정(CF_ACCESS_AUD)과 달라요.",
  access_policy_not_allow: "허용(Allow) 정책만 관리할 수 있어요.",
  access_policy_not_in_app: "이 정책은 그 애플리케이션에 붙어 있지 않아요.",
  access_token_required: "처음 등록할 때는 API 토큰이 필요해요.",
  admin_email_change_open: "진행 중인 관리자 이메일 변경이 있어요. 끝내거나 취소한 뒤 다시 하세요.",
  admin_email_same: "지금 쓰는 이메일과 같아요.",
  admin_email_no_change: "진행 중인 관리자 이메일 변경이 없어요.",
  admin_email_step: "지금 단계에서는 할 수 없어요. 화면의 순서대로 진행하세요.",
  admin_email_verify_edge: "외부 주소(Cloudflare Access)로 새 이메일로 로그인한 뒤에 확인할 수 있어요.",
  admin_email_verify_mismatch: "Access에 로그인한 이메일이 새 관리자 이메일과 달라요.",
  cf_unauthorized:
    "Cloudflare가 토큰을 거부했어요. 토큰과 권한(Access: Apps and Policies 편집)을 확인하세요.",
  cf_not_found: "Cloudflare에서 계정·애플리케이션·정책을 찾지 못했어요. ID를 확인하세요.",
  cf_rate_limited: "Cloudflare 요청 한도에 걸렸어요. 잠시 뒤 자동으로 다시 시도해요.",
  cf_unavailable: "Cloudflare에 연결하지 못했어요. 잠시 뒤 다시 시도하세요.",
  cf_bad_response: "Cloudflare 응답을 이해하지 못했어요. 잠시 뒤 다시 시도하세요.",
  access_registration_changed:
    "반영하는 사이 Cloudflare 등록(토큰·정책)이 바뀌었어요. 다시 미리보기를 확인하세요.",
  access_superseded: "그사이 다른 요청이 이 반영 상태를 바꿨어요. 화면을 새로 고쳐 확인하세요.",
  interrupted: "반영 중에 서버가 다시 시작됐어요. 다시 시도하면 실제 목록을 먼저 확인해요.",
};
