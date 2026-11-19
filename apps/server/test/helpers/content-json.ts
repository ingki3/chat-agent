/**
 * JSON for "this secret never appears anywhere" checks over whole records (#208). A short numeric synthetic secret
 * (`9876`, `123456`) could otherwise match digits that merely occur in a random id (`…-9876-…`) or a clock reading
 * of the record's envelope. Only the envelope fields the server itself generates are masked, each at its one known
 * position (the top level of a message row, a stream frame and its `data`, a log record) — never by the shape of a
 * value, and never inside `parts`, tool input or output, or any other content: a leak there is still caught, whatever
 * it looks like.
 */
const MASK = "<meta>";

/** Server-generated fields of a message row (API item or stored row). */
const MESSAGE_META = [
  "id",
  "conversationId",
  "createdAt",
  "replaces",
  "supersededBy",
  "connectionId",
] as const;
/** A stream frame's SSE id, and the envelope of its `data`. */
const FRAME_META = ["id"] as const;
const FRAME_DATA_META = ["messageId", "runId", "conversationId", "createdAt"] as const;
/** A log record's ids and duration. */
const LOG_META = ["userId", "conversationId", "runId", "durationMs"] as const;

const masked = (value: unknown, keys: readonly string[]): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const k of keys) if (copy[k] !== undefined && copy[k] !== null) copy[k] = MASK;
  return copy;
};

/** Message rows (`/api/conversations/:id/messages` items, or `conversations.messages()`). */
export function messagesJson(rows: readonly unknown[]): string {
  return JSON.stringify(rows.map((r) => masked(r, MESSAGE_META)));
}

/** Stream frames as `stream().read()` returns them: `{ id, event, data }`. */
export function framesJson(frames: readonly unknown[]): string {
  return JSON.stringify(
    frames.map((f) => {
      const m = masked(f, FRAME_META);
      if (!m || typeof m !== "object" || Array.isArray(m)) return m;
      const frame = m as Record<string, unknown>;
      return "data" in frame ? { ...frame, data: masked(frame.data, FRAME_DATA_META) } : frame;
    }),
  );
}

/** Log records (one object per line written). */
export function logsJson(records: readonly unknown[]): string {
  return JSON.stringify(records.map((r) => masked(r, LOG_META)));
}
