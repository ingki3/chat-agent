import { z } from "zod";
import { RunChoice } from "./connections.js";
import { RuntimeId } from "./runtime.js";
import { FINANCE_NOTE_MAX_SOURCES, FinanceMissing, FinanceSource } from "./finance.js";
import { CitationNotePart } from "./citations.js";
import { FILE_LIMITS } from "./files.js";

/**
 * Runtime-neutral message and stream formats (#11, PRD D8). Both runtime adapters (#15, #16) translate their
 * own events into these; the UI, history, sharing and context building only ever see these.
 */

export const TextPart = z.object({ type: z.literal("text"), text: z.string() });
export const ToolCallPart = z.object({
  type: z.literal("tool_call"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
export const ToolResultPart = z.object({
  type: z.literal("tool_result"),
  callId: z.string(),
  output: z.unknown(),
  isError: z.boolean().optional(),
});
export const CitationRefPart = z.object({
  type: z.literal("citation_ref"),
  citationId: z.string(),
  label: z.string().optional(),
});
export const ArtifactRefPart = z.object({
  type: z.literal("artifact_ref"),
  artifactId: z.string(),
  version: z.number().int().positive().optional(),
});
export const FileRefPart = z.object({
  type: z.literal("file_ref"),
  fileId: z.string(),
  name: z.string().optional(),
});
/** Structured table (finance etc.): columns, rows, where it came from and as of when. */
export const TablePart = z.object({
  type: z.literal("table"),
  columns: z.array(z.object({ key: z.string(), label: z.string(), unit: z.string().optional() })),
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
  source: z.string().optional(),
  asOf: z.string().optional(),
  /** The `table` artifact holding the same data (#31: a finance table is both a part and an artifact). */
  artifactId: z.string().optional(),
  /** The version of that artifact this part shows (#31: replaced when the same run stores a newer one). */
  artifactVersion: z.number().int().positive().optional(),
});
/** `── 여기부터 Codex · ○○ ──` and "앞부분은 요약해서 넘겼어요" markers. */
export const DividerPart = z.object({
  type: z.literal("divider"),
  kind: z.enum(["runtime_switch", "summary"]),
  label: z.string(),
  runtime: RuntimeId.optional(),
  model: z.string().optional(),
});
/**
 * Added by the server under an answer that used a finance tool (#30, FR-7.6·7.8): the sources and as-of times of
 * the numbers it was given, what the answer itself left out, and the disclaimer. Never written by a runtime.
 */
export const FinanceNotePart = z.object({
  type: z.literal("finance_note"),
  sources: z.array(FinanceSource).max(FINANCE_NOTE_MAX_SOURCES),
  missing: z.array(FinanceMissing),
  disclaimer: z.string(),
});
export type FinanceNotePart = z.infer<typeof FinanceNotePart>;
/**
 * The runtime's internal reasoning. Stored, but internal only: never in API responses, shared views, forks,
 * exports or the context handed to another runtime (see `publicParts`).
 */
export const ReasoningPart = z.object({ type: z.literal("reasoning"), text: z.string() });

export const MessagePart = z.discriminatedUnion("type", [
  TextPart,
  ToolCallPart,
  ToolResultPart,
  CitationRefPart,
  ArtifactRefPart,
  FileRefPart,
  TablePart,
  DividerPart,
  FinanceNotePart,
  CitationNotePart,
  ReasoningPart,
]);
export type MessagePart = z.infer<typeof MessagePart>;
/** Parts that may leave the server. */
export type PublicPart = Exclude<MessagePart, { type: "reasoning" }>;

export const INTERNAL_PART_TYPES: ReadonlySet<MessagePart["type"]> = new Set(["reasoning"]);
export function publicParts(parts: readonly MessagePart[]): PublicPart[] {
  return parts.filter((p): p is PublicPart => !INTERNAL_PART_TYPES.has(p.type));
}

export const MessageRole = z.enum(["user", "assistant", "system"]);
export const MessageStatus = z.enum(["pending", "streaming", "complete", "stopped", "error"]);

/** A message as the API returns it (public parts only). */
export const Message = z.object({
  id: z.string(),
  conversationId: z.string(),
  seq: z.number().int(),
  role: MessageRole,
  parts: z.array(MessagePart),
  runtime: RuntimeId.nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  status: MessageStatus,
  /** Conversation revision this message was written in. */
  revision: z.number().int(),
  /** The earlier version this message replaced (edit / regenerate), if any. */
  replaces: z.string().nullable(),
  createdAt: z.number(),
});
export type Message = z.infer<typeof Message>;

export const ConversationKind = z.enum(["normal", "schedule", "fork"]);

/**
 * What a conversation answers with from its next message on (#19, PRD FR-3.5, FR-12): set from the user's defaults
 * (with the FR-12.6 fallback) when the conversation is created, changed only by the chip. Changing the defaults
 * later never touches it (FR-12.5). `useShared`: "공용으로 쓰기" — the family shared connection even when a personal
 * one exists (FR-11.3).
 */
export const ChatSettings = z.object({
  runtime: RuntimeId,
  model: z.string(),
  effort: z.string().nullable(),
  useShared: z.boolean(),
});
export type ChatSettings = z.infer<typeof ChatSettings>;
/** `PUT /api/conversations/:id/settings`: the chip's change; at least one field. Runtime alone → its default model. */
export const ChangeSettingsRequest = z
  .object({
    runtime: RuntimeId.optional(),
    model: z.string().min(1).max(100).optional(),
    effort: z.string().min(1).max(20).optional(),
    useShared: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "nothing to change" });
export type ChangeSettingsRequest = z.infer<typeof ChangeSettingsRequest>;
export const Conversation = z.object({
  id: z.string(),
  title: z.string(),
  pinned: z.boolean(),
  kind: ConversationKind,
  lastRuntime: RuntimeId.nullable(),
  forkedFrom: z.string().nullable(),
  /** Bumped whenever history is rewritten (edit / regenerate). Runtime sessions record which they reflect. */
  revision: z.number().int(),
  /** 자료 조사 모드 (FR-5.5): compare several sources, say when evidence is weak (#20). */
  researchMode: z.boolean(),
  /** Runtime, model and effort of the next message (#19); null only for a conversation no runtime was usable for yet. */
  settings: ChatSettings.nullable(),
  /**
   * Set when the conversation started on the FR-12.6 fallback because the default could not be used: the chip shows
   * "기본값을 쓸 수 없어 ○○로 시작했어요" once: only the page whose `POST …/fallback-notice/consume` takes it shows it.
   */
  fallbackNotice: z.lazy(() => FallbackNotice).nullable(),
  /**
   * A schedule's result conversation (#56, FR-8.3) with a result the owner has not opened yet: the sidebar's "새 결과".
   * Cleared by `POST /api/conversations/:id/result-seen`. Optional for older clients' fixtures; the server always sends it.
   */
  newResult: z.boolean().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Conversation = z.infer<typeof Conversation>;

export const ListConversationsQuery = z.object({
  q: z.string().trim().max(200).optional(),
  pinned: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Opaque cursor from the previous page. */
  cursor: z.string().max(200).optional(),
});
/** `settings`: the chip was changed on the new-conversation screen before the first message (checked, 403). */
export const CreateConversationRequest = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  settings: ChangeSettingsRequest.optional(),
});
export const UpdateConversationRequest = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    pinned: z.boolean().optional(),
    researchMode: z.boolean().optional(),
  })
  .refine((v) => v.title !== undefined || v.pinned !== undefined || v.researchMode !== undefined, {
    message: "nothing to update",
  });
/**
 * `POST /api/conversations/:id/fallback-notice/consume` (#19): takes the fallback notice atomically — the first caller
 * gets it, every later (or concurrent) one gets null — so it is shown once across tabs and reloads.
 */
/**
 * `POST /api/settings/preview` (#19): the new-conversation screen's chip — what `change` makes of `base` (the start
 * settings, or the choice so far), by the same rules as a conversation's change, limits included. Nothing is saved.
 */
export const PreviewSettingsRequest = z
  .object({ base: ChatSettings.nullable(), change: ChangeSettingsRequest })
  .strict();
export type PreviewSettingsRequest = z.infer<typeof PreviewSettingsRequest>;

/** What a conversation started on instead of the default; `limitedUntil` when the default was at a usage limit. */
export const FallbackNotice = z.object({
  runtime: RuntimeId,
  model: z.string(),
  limitedUntil: z.number().optional(),
});
export type FallbackNotice = z.infer<typeof FallbackNotice>;
export const ConsumeFallbackNoticeResponse = z.object({
  notice: z.lazy(() => FallbackNotice).nullable(),
});
export type ConsumeFallbackNoticeResponse = z.infer<typeof ConsumeFallbackNoticeResponse>;
export const ListMessagesQuery = z.object({
  /** Return messages with seq below this (older page). */
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
/** Text plus the optional per-turn choices (runtime, model, effort, connection — checked by the server, #17). */
export const EditMessageRequest = RunChoice.extend({ text: z.string().trim().min(1).max(100_000) });
/**
 * A new message. `fileIds`: files uploaded to this conversation and not yet sent (#22) — they become `file_ref`
 * parts of the message.
 */
export const SendMessageRequest = EditMessageRequest.extend({
  fileIds: z.array(z.string().min(1).max(64)).max(FILE_LIMITS.perConversation).optional(),
});
/** "다시 생성" may change the runtime, model, effort or connection too (e.g. continue on the shared one). */
export const RegenerateRequest = RunChoice;

/** Stream events (SSE `event:` name = `type`). */
export const StreamEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("delta"),
    messageId: z.string(),
    partIndex: z.number().int(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("tool_start"),
    messageId: z.string(),
    callId: z.string(),
    name: z.string(),
    input: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("tool_end"),
    messageId: z.string(),
    callId: z.string(),
    output: z.unknown().optional(),
    isError: z.boolean().optional(),
  }),
  /** Replace a part (citation resolved, artifact reference updated). Never carries a reasoning part. */
  z.object({
    type: z.literal("part_update"),
    messageId: z.string(),
    partIndex: z.number().int(),
    part: MessagePart.refine((p) => p.type !== "reasoning", { message: "reasoning parts are internal" }),
  }),
  z.object({
    type: z.literal("usage"),
    messageId: z.string(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
  }),
  /** Limits, fallbacks and similar notices shown in the conversation. */
  z.object({
    type: z.literal("notice"),
    level: z.enum(["info", "warn"]),
    code: z.string(),
    message: z.string(),
    /**
     * Runtimes the user could continue with instead (a subscription limit, an expired login — #18). Only a hint:
     * switching itself is the conversation's runtime change (#19).
     */
    switchTo: z.array(RuntimeId).optional(),
  }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
  z.object({ type: z.literal("done"), messageId: z.string(), status: MessageStatus }),
  z.object({ type: z.literal("keepalive") }),
]);
export type StreamEvent = z.infer<typeof StreamEvent>;

/** First-sentence title (model-written titles come with #15). */
export function autoTitle(text: string, max = 40): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const sentence = flat.split(/(?<=[.?!。？！])\s/)[0] ?? flat;
  const chars = Array.from(sentence);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : sentence || "새 대화";
}

export const RunStatus = z.enum(["queued", "running", "done", "interrupted", "failed"]);
export const Run = z.object({
  id: z.string(),
  conversationId: z.string(),
  assistantMessageId: z.string(),
  status: RunStatus,
  errorCode: z.string().nullable(),
  runtime: z.string(),
  model: z.string(),
  effort: z.string().nullable(),
  /** The runtime connection used (#17); null when the runtime needs none. */
  connectionId: z.string().nullable(),
  createdAt: z.number(),
  endedAt: z.number().nullable(),
});
export type Run = z.infer<typeof Run>;

/** Response of send / edit / regenerate: the new messages and the run generating the reply. */
export const StartRunResponse = z.object({
  message: Message.nullable(),
  assistant: Message,
  run: Run,
  revision: z.number().int(),
});
export type StartRunResponse = z.infer<typeof StartRunResponse>;
