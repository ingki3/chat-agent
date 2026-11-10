import { z } from "zod";
import { RuntimeId } from "./runtime.js";

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
export const Conversation = z.object({
  id: z.string(),
  title: z.string(),
  pinned: z.boolean(),
  kind: ConversationKind,
  lastRuntime: RuntimeId.nullable(),
  forkedFrom: z.string().nullable(),
  /** Bumped whenever history is rewritten (edit / regenerate). Runtime sessions record which they reflect. */
  revision: z.number().int(),
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
export const CreateConversationRequest = z.object({ title: z.string().trim().min(1).max(200).optional() });
export const UpdateConversationRequest = z
  .object({ title: z.string().trim().min(1).max(200).optional(), pinned: z.boolean().optional() })
  .refine((v) => v.title !== undefined || v.pinned !== undefined, { message: "nothing to update" });
export const ListMessagesQuery = z.object({
  /** Return messages with seq below this (older page). */
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const SendMessageRequest = z.object({ text: z.string().trim().min(1).max(100_000) });
export const EditMessageRequest = SendMessageRequest;

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
