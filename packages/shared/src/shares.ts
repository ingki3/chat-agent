import { z } from "zod";
import { Conversation, Message } from "./chat.js";
import { UploadedFile } from "./files.js";
import { Artifact } from "./artifacts.js";
import { Source } from "./sources.js";

/**
 * Family sharing (#29, PRD FR-14.1~14.3·14.7). A share names one item (a conversation — schedule result
 * conversations included — or an artifact), who sees it (the whole family or chosen family accounts) and how:
 * - `live`: what the owner sees now, new messages and versions included (reasoning and raw tool results never).
 * - `snapshot`: "이 메시지까지" — the messages up to the boundary message and only what *those* messages brought
 *   (attached or generated files, the artifact versions their runs wrote, the sources they cited), frozen when the
 *   share is made. Anything else is 403, even if it existed before the share.
 *
 * Targets are family accounts only, named by their account id: no request takes an email address (FR-14.7).
 */
export const ShareMode = z.enum(["live", "snapshot"]);
export type ShareMode = z.infer<typeof ShareMode>;
export const ShareItemKind = z.enum(["conversation", "artifact"]);
export type ShareItemKind = z.infer<typeof ShareItemKind>;

/** Up to this many chosen accounts (a family is small; the limit only bounds the request). */
export const SHARE_MAX_TARGETS = 20;

/** Account ids are server-generated UUIDs: an email address (or anything else) is refused by the schema itself. */
const AccountId = z.uuid();

/** Who sees a share: everyone in the family (the owner aside), or the chosen family accounts. */
export const ShareAudience = z.discriminatedUnion("audience", [
  z.strictObject({ audience: z.literal("family") }),
  z.strictObject({
    audience: z.literal("users"),
    userIds: z.array(AccountId).min(1).max(SHARE_MAX_TARGETS),
  }),
]);
export type ShareAudience = z.infer<typeof ShareAudience>;

/**
 * `POST /api/conversations/:id/shares`. `boundaryMessageId`: "이 메시지까지" — required for a snapshot, refused for a
 * live share (a live share is the whole conversation).
 */
export const CreateConversationShareRequest = z
  .strictObject({
    target: ShareAudience,
    mode: ShareMode,
    boundaryMessageId: z.string().min(1).max(64).optional(),
  })
  .refine((v) => (v.mode === "snapshot") === (v.boundaryMessageId !== undefined), {
    message: "a snapshot needs its boundary message, a live share has none",
  });
export type CreateConversationShareRequest = z.infer<typeof CreateConversationShareRequest>;
/** `POST /api/artifacts/:id/shares`: a snapshot freezes the versions that exist now. */
export const CreateArtifactShareRequest = z.strictObject({ target: ShareAudience, mode: ShareMode });
export type CreateArtifactShareRequest = z.infer<typeof CreateArtifactShareRequest>;
/** `PATCH /api/shares/:id`: change who it is for (takes effect at once, like a revoke for those removed). */
export const UpdateShareRequest = z.strictObject({ target: ShareAudience });
export type UpdateShareRequest = z.infer<typeof UpdateShareRequest>;

/** A share as its owner sees it. */
export const Share = z.object({
  id: z.string(),
  itemKind: ShareItemKind,
  itemId: z.string(),
  mode: ShareMode,
  audience: z.enum(["family", "users"]),
  /** The chosen accounts (`users`), or every family account it reaches right now (`family`). */
  targets: z.array(z.object({ id: z.string(), name: z.string() })),
  boundaryMessageId: z.string().nullable(),
  /**
   * Read receipts (#52, FR-14.6): the accounts listed in `targets` that opened it, with when they first and last
   * did. An account not here has not opened it yet.
   */
  views: z.array(
    z.object({ id: z.string(), name: z.string(), firstViewedAt: z.number(), lastViewedAt: z.number() }),
  ),
  createdAt: z.number(),
  updatedAt: z.number(),
  revokedAt: z.number().nullable(),
});
export type Share = z.infer<typeof Share>;
export const SharesResponse = z.object({ items: z.array(Share) });
export type SharesResponse = z.infer<typeof SharesResponse>;

/** A share as the person it is shared with sees it: who shared what, when (FR-14.6). */
export const IncomingShare = z.object({
  id: z.string(),
  itemKind: ShareItemKind,
  itemId: z.string(),
  mode: ShareMode,
  title: z.string(),
  ownerName: z.string(),
  createdAt: z.number(),
  /** When the caller first opened it (null: not yet — the sidebar marks it new). */
  viewedAt: z.number().nullable(),
});
export type IncomingShare = z.infer<typeof IncomingShare>;
export const IncomingSharesQuery = z.object({ q: z.string().trim().max(200).optional() });
export const IncomingSharesResponse = z.object({ items: z.array(IncomingShare) });
export type IncomingSharesResponse = z.infer<typeof IncomingSharesResponse>;

/** `GET /api/share-targets`: the family accounts the caller can share with (names only, never emails). */
export const ShareTargetsResponse = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type ShareTargetsResponse = z.infer<typeof ShareTargetsResponse>;

/**
 * `GET /api/shares/:id/view`: the shared item through the share's projection, read-only. Conversation shares carry
 * the projected messages, files, artifacts (with their visible versions) and cited sources; artifact shares the
 * artifact alone.
 */
export const SharedView = z.object({
  share: IncomingShare,
  conversation: z.object({ id: z.string(), title: z.string() }).nullable(),
  messages: z.array(Message),
  files: z.array(UploadedFile),
  artifacts: z.array(Artifact.extend({ versions: z.array(z.number().int()) })),
  sources: z.array(Source),
  /**
   * The caller's own choices as a viewer (#52, FR-8.8): `notifyResults` for a shared schedule-result conversation —
   * null for the owner's preview and for any other item (nothing to choose).
   */
  viewer: z.object({ notifyResults: z.boolean() }).nullable(),
  /** The caller is the owner, previewing what the share shows (no fork, no receipt). */
  own: z.boolean(),
});
export type SharedView = z.infer<typeof SharedView>;

/** `PUT /api/shares/:id/subscription`: a viewer's "새 결과 알림 받기" for a shared schedule-result conversation. */
export const ShareSubscriptionRequest = z.strictObject({ notifyResults: z.boolean() });
export type ShareSubscriptionRequest = z.infer<typeof ShareSubscriptionRequest>;

/**
 * `POST /api/shares/:id/fork` — "이어서 대화하기" (#52, FR-14.3·14.4): the share's projection copied into a new
 * conversation of the caller (messages, files, artifact versions, cited sources — projected ones only), on the
 * caller's own default runtime. No runtime session, connection or secret of the original comes along.
 */
export const ForkResponse = z.object({ conversation: Conversation });
export type ForkResponse = z.infer<typeof ForkResponse>;

/** Shown next to "이어서 대화하기". */
export const SHARE_FORK_NOTICE =
  "공유받은 내용을 내 대화로 복사해요. 원래 대화는 바뀌지 않고, 내 기본 런타임과 내 연결로 이어가요.";

/** Shown wherever a share is changed or revoked (FR-14.2): what a revoke cannot take back. */
export const SHARE_REVOKE_NOTICE =
  "공유를 끄면 바로 안 보여요. 이미 내려받은 파일과 '이어서 대화하기'로 만든 사본은 되돌릴 수 없어요.";
