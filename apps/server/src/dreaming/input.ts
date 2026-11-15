import { DREAMING_INPUT_CHARS, utf8Bytes, type MemoryListKind } from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { scrubKnown } from "../secrets/known.js";
import type { ItemSource } from "../memory/store.js";

/**
 * A 기억 정리 run's input (#146, docs/memory-spec.md §3·§6): the user's own messages only — role user, in the user's
 * own conversations, not a schedule conversation, not a message a fork copied, the revision active now — and only
 * their text parts (no attachment, extracted text, tool result or answer). Ordered by the user's processing sequence:
 * the re-processing queue first, then the new messages after the checkpoint, oldest first, until the next one would
 * not fit (60,000 characters). A single message longer than that goes in cut to its first 60,000 characters (it
 * counts as processed). Text is scrubbed of known secrets once more on the way in.
 */

export type InputMessage = {
  /** The reference the model sees (`msg-1`, …). */
  ref: string;
  source: ItemSource;
  seq: number;
  text: string;
  /** From the queue (re-processing) or new (after the checkpoint). */
  queued: boolean;
  /** The documents it may be a source for: a queued one only for the document it was queued for. */
  docs: Set<MemoryListKind>;
  /** Cut to the input cap: the code-point range that went in. */
  range: { from: number; to: number } | null;
  /** The message itself reads like an instruction to the assistant (spec §3.5 — never auto-applied from). */
  suspicious: boolean;
};

export type PackedInput = {
  messages: InputMessage[];
  /** The processing sequence of the last new message that went in (null: none — the checkpoint stays). */
  lastNewSeq: number | null;
  /** Queue entries the run takes up (removed when it ends with an outcome). */
  takenQueue: { messageId: string; doc: MemoryListKind }[];
  /** Queue entries of messages no longer allowed (deleted, edited away): dropped. */
  staleQueue: { messageId: string; doc: MemoryListKind }[];
  cut: boolean;
};

/** Text of a user message as Dreaming reads it: its text parts only. */
export function messageBody(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .flatMap((p) =>
      p &&
      typeof p === "object" &&
      (p as { type?: unknown }).type === "text" &&
      typeof (p as { text?: unknown }).text === "string"
        ? [(p as { text: string }).text]
        : [],
    )
    .join("\n")
    .trim();
}

/** The spec §3 conditions on a message `m` joined with its conversation `c`. */
export const ALLOWED = `m.role = 'user' and m.active = 1 and c.owner_id = @u and c.kind != 'schedule'
  and not exists (select 1 from fork_items f where f.item_type = 'message' and f.copy_id = m.id)`;

type Row = {
  id: string;
  revision: number;
  conversationId: string;
  seq: number;
  parts: string;
  doc?: MemoryListKind;
};

export function gatherInput(
  db: Db,
  input: {
    userId: string;
    checkpoint: number;
    /** Documents this run may change (a document with a bundle waiting for review is left out, spec §5). */
    docs: readonly MemoryListKind[];
    /** Characters (code points) — the spec's 60,000. */
    maxChars?: number;
    /** UTF-8 bytes left for messages under the run's token cap. */
    maxBytes: number;
    suspicious: (text: string) => boolean;
  },
): PackedInput {
  const sql = db.$client;
  const maxChars = input.maxChars ?? DREAMING_INPUT_CHARS;
  const allowedDocs = new Set(input.docs);
  // The queue: every entry, the allowed ones in sequence order (an entry for a document left out stays queued).
  const queued = sql
    .prepare(
      `select q.message_id as id, q.doc as doc, m.revision as revision, m.conversation_id as conversationId,
              s.seq as seq, m.parts as parts,
              (select 1 from messages m join conversations c on c.id = m.conversation_id
                 where m.id = q.message_id and ${ALLOWED}) as ok
         from dreaming_queue q
         join messages m on m.id = q.message_id
         left join memory_message_seq s on s.message_id = q.message_id
        where q.user_id = @u
        order by s.seq, q.message_id`,
    )
    .all({ u: input.userId }) as (Row & { ok: number | null; seq: number | null })[];
  const staleQueue = queued
    .filter((q) => !q.ok || q.seq === null)
    .map((q) => ({ messageId: q.id, doc: q.doc! }));
  const queue = queued.filter((q) => q.ok && q.seq !== null && allowedDocs.has(q.doc!));

  const messages: InputMessage[] = [];
  const byId = new Map<string, InputMessage>();
  const takenQueue: PackedInput["takenQueue"] = [];
  let chars = 0;
  let bytes = 0;
  let cut = false;
  let full = false;
  let lastNewSeq: number | null = null;

  /** Puts one message in, or says it does not fit (then nothing after it goes in either). */
  const put = (r: Row, isQueued: boolean, docs: Set<MemoryListKind>): boolean => {
    const known = byId.get(r.id);
    if (known) {
      for (const d of docs) known.docs.add(d);
      return true;
    }
    const raw = scrubKnown(messageBody(JSON.parse(r.parts) as unknown));
    if (!raw) return true; // nothing of the user's own words (an attachment only): passed over
    const points = [...raw];
    let text = raw;
    let range: InputMessage["range"] = null;
    const size = utf8Bytes(raw);
    if (chars + points.length > maxChars || bytes + size > input.maxBytes) {
      // Only the first message may go in cut — anything later waits for the next run (spec §6).
      if (messages.length) return false;
      let take = Math.min(points.length, maxChars);
      text = points.slice(0, take).join("");
      while (take > 0 && utf8Bytes(text) > input.maxBytes) {
        take = Math.max(0, Math.floor(take * 0.9) - 1);
        text = points.slice(0, take).join("");
      }
      if (!take) return false;
      range = { from: 0, to: take };
      cut = true;
    }
    chars += [...text].length;
    bytes += utf8Bytes(text);
    const m: InputMessage = {
      ref: `msg-${messages.length + 1}`,
      source: { messageId: r.id, revision: r.revision, conversationId: r.conversationId },
      seq: r.seq,
      text,
      queued: isQueued,
      docs,
      range,
      suspicious: input.suspicious(raw),
    };
    messages.push(m);
    byId.set(r.id, m);
    if (range) full = true;
    return true;
  };

  for (const q of queue) {
    if (full) break;
    if (!put(q, true, new Set([q.doc!]))) {
      full = true;
      break;
    }
    takenQueue.push({ messageId: q.id, doc: q.doc! });
  }
  // New messages after the checkpoint, in sequence order, a page at a time.
  let after = input.checkpoint;
  const page = sql.prepare(
    `select m.id as id, m.revision as revision, m.conversation_id as conversationId, s.seq as seq, m.parts as parts
       from memory_message_seq s
       join messages m on m.id = s.message_id
       join conversations c on c.id = m.conversation_id
      where s.user_id = @u and s.seq > @after and ${ALLOWED}
      order by s.seq limit 200`,
  );
  while (!full && allowedDocs.size) {
    const rows = page.all({ u: input.userId, after }) as Row[];
    if (!rows.length) break;
    for (const r of rows) {
      after = r.seq;
      if (!put(r, false, new Set(allowedDocs))) {
        full = true;
        break;
      }
      lastNewSeq = r.seq;
      if (full) break;
    }
  }
  return { messages, lastNewSeq, takenQueue, staleQueue, cut };
}

/**
 * The resume rule (spec §6): when the rounds start again after a pause (or for the first time), a checkpoint older
 * than 7 days moves to the last message from before then — older messages are not processed. Returns the new
 * checkpoint, and whether anything was passed over.
 */
export function resumeCheckpoint(
  db: Db,
  userId: string,
  checkpoint: number,
  now: number,
): { checkpoint: number; skippedOld: boolean } {
  const cutoff = now - 7 * 86_400_000;
  const r = db.$client
    .prepare(
      `select max(s.seq) as seq from memory_message_seq s join messages m on m.id = s.message_id
         join conversations c on c.id = m.conversation_id
        where s.user_id = @u and s.created_at < @cutoff and s.seq > @cp and ${ALLOWED}`,
    )
    .get({ u: userId, cutoff, cp: checkpoint }) as { seq: number | null };
  if (r.seq === null) return { checkpoint, skippedOld: false };
  return { checkpoint: r.seq, skippedOld: true };
}
