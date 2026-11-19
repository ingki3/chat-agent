import { z } from "zod";
import { ArtifactKind } from "./artifacts.js";

/**
 * Public artifact links (#204, PRD FR-14.7 v0.7): one artifact version opened to anyone with the link at
 * `/artifact/<token>` — same host as the app, but outside Cloudflare Access (a Bypass application for that path only,
 * docs/ops.md §49) and outside the app login. Only the artifact's owner makes one; the version is fixed; the link
 * expires after 1–365 days (no "never") and can be turned off at once.
 */

/** Path prefix of every public route (`/artifact/<token>`, `/raw`, `/download`). Never `/artifacts` (the app's list). */
export const PUBLIC_LINK_PREFIX = "/artifact/";
/** A token: 32 random bytes as base64url (43 characters). */
export const PUBLIC_LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const publicLinkPath = (token: string) => `${PUBLIC_LINK_PREFIX}${token}`;

export const PUBLIC_LINK_DAYS = { min: 1, max: 365, default: 7 } as const;
/** Active (not expired, not turned off) links one account may have at once. */
export const PUBLIC_LINK_MAX_ACTIVE = 20;

/** `POST /api/artifacts/:id/public-links`. */
export const CreatePublicLinkRequest = z.strictObject({
  version: z.number().int().positive(),
  expiresInDays: z
    .number()
    .int()
    .min(PUBLIC_LINK_DAYS.min)
    .max(PUBLIC_LINK_DAYS.max)
    .default(PUBLIC_LINK_DAYS.default),
});
export type CreatePublicLinkRequest = z.input<typeof CreatePublicLinkRequest>;

/**
 * What the server found in a version before it is made public (`GET /api/artifacts/:id/public-links/check`). A known
 * secret value blocks the link; email addresses and phone numbers are only warned about; external hosts the page
 * loads from are named (a visitor's browser contacts them).
 */
export const PublicLinkCheck = z.object({
  version: z.number().int().positive(),
  secret: z.boolean(),
  emails: z.number().int().nonnegative(),
  phones: z.number().int().nonnegative(),
  externalHosts: z.array(z.string()),
});
export type PublicLinkCheck = z.infer<typeof PublicLinkCheck>;

export const PublicLinkStatus = z.enum(["active", "expired", "disabled"]);
export type PublicLinkStatus = z.infer<typeof PublicLinkStatus>;

/** A link as its owner sees it (never the token: it is shown once, in the creation answer). */
export const PublicLink = z.object({
  id: z.string(),
  artifactId: z.string(),
  artifactTitle: z.string(),
  kind: ArtifactKind,
  version: z.number().int().positive(),
  createdAt: z.number(),
  expiresAt: z.number(),
  disabledAt: z.number().nullable(),
  viewCount: z.number().int().nonnegative(),
  lastViewedAt: z.number().nullable(),
  status: PublicLinkStatus,
});
export type PublicLink = z.infer<typeof PublicLink>;

/**
 * `GET /api/public-links[?artifactId=&cursor=]`: every open link (complete — never cut off, so each can be turned
 * off), and the expired or turned-off ones a page at a time (`nextCursor`, null on the last page).
 */
export const PublicLinksResponse = z.object({
  active: z.array(PublicLink),
  history: z.array(PublicLink),
  nextCursor: z.string().nullable(),
});
export type PublicLinksResponse = z.infer<typeof PublicLinksResponse>;

/**
 * The creation answer: the link, its path and full address with the token (shown once) — the address is built by the
 * server from `PUBLIC_HOST` (https), so a link made at home on localhost is still the one outsiders can open — and
 * what the check found.
 */
export const CreatePublicLinkResponse = z.object({
  link: PublicLink,
  path: z.string(),
  url: z.string(),
  check: PublicLinkCheck,
});
export type CreatePublicLinkResponse = z.infer<typeof CreatePublicLinkResponse>;

/** `GET /api/public-links/settings`: whether the server offers public links at all (`PUBLIC_LINKS_ENABLED`). */
export const PublicLinkSettings = z.object({
  enabled: z.boolean(),
  maxActive: z.number().int(),
  active: z.number().int(),
});
export type PublicLinkSettings = z.infer<typeof PublicLinkSettings>;

/**
 * The admin's view (FR-1.5: never a title or content): counts, and per link who owns it, when it expires and
 * whether it is on — to turn one off.
 */
export const AdminPublicLink = z.object({
  id: z.string(),
  ownerName: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
  disabledAt: z.number().nullable(),
  viewCount: z.number().int().nonnegative(),
  status: PublicLinkStatus,
});
export type AdminPublicLink = z.infer<typeof AdminPublicLink>;
/** `GET /api/admin/public-links[?cursor=]`: counts, every open link, and the history a page at a time. */
export const AdminPublicLinksResponse = z.object({
  enabled: z.boolean(),
  counts: z.object({ active: z.number(), expired: z.number(), disabled: z.number() }),
  active: z.array(AdminPublicLink),
  history: z.array(AdminPublicLink),
  nextCursor: z.string().nullable(),
});
export type AdminPublicLinksResponse = z.infer<typeof AdminPublicLinksResponse>;

/** Error codes of the public link API. */
export const PUBLIC_LINK_ERRORS = {
  public_links_disabled: "이 서버에서는 공개 링크를 쓸 수 없어요(관리자 설정).",
  public_link_limit: `공개 링크는 한 사람당 ${PUBLIC_LINK_MAX_ACTIVE}개까지 켜 둘 수 있어요. 안 쓰는 링크를 끄세요.`,
  public_link_secret: "이 버전에 비밀 값(키·토큰)이 들어 있어 공개할 수 없어요.",
  public_link_unsupported: "이 종류의 아티팩트는 공개 링크로 열 수 없어요.",
  artifact_redacted: "가려진 버전은 공개할 수 없어요.",
} as const;
