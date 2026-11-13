import crypto from "node:crypto";
import { DocumentRef, MessagePart, type ChatSettings, type Message } from "@agentlee/shared";
import type { ArtifactStore, ArtifactRow } from "../artifacts/store.js";
import type { FileWriteLock } from "../backup/lock.js";
import type { ConversationRow, ConversationStore } from "../conversations/store.js";
import type { Db } from "../db/client.js";
import type { FileRow, FileStore } from "../files/store.js";
import { scrubKnown } from "../secrets/known.js";
import type { SourceStore } from "../web/sources.js";
import type { ForkSource } from "./projection.js";
import type { ShareRow } from "./store.js";

/** What the fork starts on: the forker's own defaults (FR-12.6 fallback applied), or none usable yet. */
export type ForkStart = {
  settings: ChatSettings | null;
  fallback: boolean;
  limitedUntil?: number | undefined;
};

/** Ids of the original → ids of the copy, per kind (also the provenance rows, `fork_items`). */
type IdMap = {
  message: Map<string, string>;
  file: Map<string, string>;
  artifact: Map<string, { id: string; versions: Map<number, number> }>;
  source: Map<string, string>;
};

/** Messages still being written are not copied: they would stay "streaming" in the copy forever. */
const UNFINISHED = new Set<Message["status"]>(["pending", "streaming"]);

/**
 * A message's (already projected) parts with every id moved to the copy's: files, artifacts and their versions, cited
 * sources. A reference to something the copy does not have is dropped (a card, a chip) or cut (a note's source), never
 * left pointing at the original. `citation_ref` parts point at citation rows of the original's runs: dropped.
 */
export function remapParts(parts: readonly MessagePart[], ids: IdMap): MessagePart[] {
  const version = (artifactId: string, v: number | undefined) => {
    const a = ids.artifact.get(artifactId);
    if (!a) return undefined;
    if (v === undefined) return { id: a.id, version: undefined };
    const n = a.versions.get(v);
    return n === undefined ? undefined : { id: a.id, version: n };
  };
  return parts.flatMap((p): MessagePart[] => {
    switch (p.type) {
      case "reasoning":
      case "citation_ref":
        return [];
      case "tool_result":
        // Already projected (no output); kept so tool calls still pair up.
        return [
          { type: "tool_result", callId: p.callId, output: null, ...(p.isError ? { isError: true } : {}) },
        ];
      case "file_ref": {
        const id = ids.file.get(p.fileId);
        return id ? [{ ...p, fileId: id }] : [];
      }
      case "artifact_ref": {
        const to = version(p.artifactId, p.version);
        if (!to) return [];
        return [{ type: "artifact_ref", artifactId: to.id, ...(to.version ? { version: to.version } : {}) }];
      }
      case "table": {
        const { artifactId, artifactVersion, ...rest } = p;
        const to = artifactId ? version(artifactId, artifactVersion) : undefined;
        return [
          {
            ...rest,
            ...(to ? { artifactId: to.id, ...(to.version ? { artifactVersion: to.version } : {}) } : {}),
          },
        ];
      }
      case "citation_note":
        return [
          {
            ...p,
            citations: p.citations.map((c) => {
              const { locator, ...rest } = c;
              const fileId = locator ? ids.file.get(locator.fileId) : undefined;
              return {
                ...rest,
                sourceId: c.sourceId ? (ids.source.get(c.sourceId) ?? null) : null,
                ...(locator && fileId ? { locator: { ...locator, fileId } } : {}),
              };
            }),
          },
        ];
      default:
        return [p];
    }
  });
}

export type ForkDeps = {
  db: Db;
  lock: FileWriteLock;
  conversations: ConversationStore;
  files: FileStore;
  artifacts: ArtifactStore;
  sources: SourceStore;
  /** Queues a copied file for text extraction (#48): the copy is extracted from its own bytes. */
  extract?: (fileId: string) => void;
  now?: () => number;
};

/**
 * "이어서 대화하기" (#52, PRD FR-14.3·14.4, docs/decisions/sharing.md): copies a share's projection — `forkSource`, i.e.
 * `bundle(share, p)` and nothing else — into a new conversation of the forker (`kind = fork`, `forkedFrom` = the
 * share), on the forker's own defaults. Every copy is a new row owned by the forker: messages (projected parts only),
 * files (their bytes copied, never linked), the visible artifact versions (numbered 1…n), the cited sources (what the
 * view showed, never the page text). Nothing of the original's runtime sessions, runs, connections or secrets
 * comes along. Each copied item is recorded in `fork_items` (original id → copy id): the provenance #54's delete
 * cascade relies on to leave fork copies alone.
 *
 * All of it is one transaction inside the file-write lock: the fork exists whole or not at all (a copy's bytes are
 * removed again when the transaction does not commit). Synchronous: no revoke can come between the projection read
 * by the caller and the copy.
 */
export class ForkService {
  private readonly now: () => number;

  constructor(private readonly deps: ForkDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * `read` gives the share and its projection's fork source *now* — called inside the lock and the transaction, so
   * a revoke while the fork waited for the lock is seen (null: refused, `ForkRefused`).
   */
  async fork(input: {
    read: () => { share: ShareRow; source: ForkSource } | null;
    forkerId: string;
    start: ForkStart | null;
  }): Promise<ConversationRow> {
    const { db, conversations, files, artifacts, sources } = this.deps;
    const { forkerId } = input;
    const made: FileRow[] = [];
    const forkId = crypto.randomUUID();
    const conv = await this.deps.lock.write(() => {
      try {
        return db.$client.transaction(() => {
          const now = input.read();
          if (!now) throw new ForkRefused();
          const { share, source } = now;
          const b = source.bundle;
          const title =
            share.itemKind === "artifact"
              ? (b.artifacts[0]?.title ?? "공유받은 아티팩트")
              : b.conversation?.title || "공유받은 대화";
          const c = conversations.create(forkerId, {
            title: scrubKnown(title).slice(0, 200) || "공유받은 대화",
            kind: "fork",
            forkedFrom: share.id,
            settings: input.start?.settings ?? null,
            fallback: input.start?.fallback ?? false,
            limitedUntil: input.start?.limitedUntil,
          });
          const ids: IdMap = { message: new Map(), file: new Map(), artifact: new Map(), source: new Map() };
          const to = { userId: forkerId, conversationId: c.id };
          // Files first (the messages' parts name them), without a message until those exist.
          for (const f of source.files) {
            const copy = files.copyFrom(f, to);
            if (!copy) continue;
            made.push(copy);
            ids.file.set(f.id, copy.id);
          }
          // Artifacts: the visible versions only; a document version whose file is not in the copy is left out.
          const artifactMessage = new Map<string, string>();
          for (const a of b.artifacts) {
            const kept: { n: number; title: string; language: string | null; content: string }[] = [];
            for (const v of source.versions.get(a.id) ?? []) {
              let content = v.content;
              if (a.kind === "document") {
                const ref = DocumentRef.safeParse(safeJson(v.content));
                const fileId = ref.success ? ids.file.get(ref.data.fileId) : undefined;
                if (!ref.success || !fileId) continue;
                content = JSON.stringify({ ...ref.data, fileId });
              }
              kept.push({ n: v.version, title: v.title, language: v.language ?? null, content });
            }
            if (!kept.length) continue;
            const copy: ArtifactRow = artifacts.copyInto(to, { kind: a.kind }, kept);
            ids.artifact.set(a.id, { id: copy.id, versions: new Map(kept.map((v, i) => [v.n, i + 1])) });
            if (a.messageId) artifactMessage.set(copy.id, a.messageId);
          }
          for (const s of b.sources) ids.source.set(s.id, sources.copyInto({ ...to, forkId }, s).id);
          // Messages, in history order, finished ones only — their parts moved to the copies' ids.
          let last: string | undefined;
          for (const m of b.messages) {
            if (UNFINISHED.has(m.status)) continue;
            const row = conversations.append(c.id, {
              role: m.role,
              parts: remapParts(MessagePart.array().parse(m.parts), ids),
              runtime: m.runtime,
              model: m.model,
              effort: m.effort,
              status: m.status,
            });
            ids.message.set(m.id, row.id);
            last = row.id;
          }
          // An artifact share has no messages: one note says what was copied and shows the card.
          if (share.itemKind === "artifact") {
            const a = [...ids.artifact.values()][0];
            const name = b.artifacts[0]?.title ?? "";
            last = conversations.append(c.id, {
              role: "assistant",
              parts: [
                {
                  type: "text",
                  text: `공유받은 「${name}」을(를) 내 대화로 복사했어요. 고칠 내용을 말해 주세요.`,
                },
                ...(a ? [{ type: "artifact_ref" as const, artifactId: a.id }] : []),
              ],
            }).id;
            for (const copy of ids.artifact.values()) artifacts.linkMessage(copy.id, last);
          } else
            for (const [copyId, from] of artifactMessage) {
              const m = ids.message.get(from);
              if (m) artifacts.linkMessage(copyId, m);
            }
          // Each file goes with its copied message; one whose message is not in the copy (a restored document's file)
          // with the last message — never left without one (that is an unsent composer file).
          const byCopy = new Map(source.files.map((f) => [ids.file.get(f.id), f]));
          for (const copy of made) {
            const from = byCopy.get(copy.id)?.messageId;
            const m = (from && ids.message.get(from)) || last;
            if (m) files.linkCopy(copy.id, m);
          }
          db.$client
            .prepare(
              `insert into forks (id, user_id, conversation_id, share_id, source_conversation_id, source_item_kind,
                 source_item_id, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              forkId,
              forkerId,
              c.id,
              share.id,
              share.conversationId,
              share.itemKind,
              share.itemId,
              this.now(),
            );
          const item = db.$client.prepare(
            "insert into fork_items (fork_id, item_type, source_id, copy_id) values (?, ?, ?, ?)",
          );
          for (const [k, map] of [
            ["message", ids.message],
            ["file", ids.file],
            ["source", ids.source],
          ] as const)
            for (const [from, copy] of map) item.run(forkId, k, from, copy);
          for (const [from, copy] of ids.artifact) item.run(forkId, "artifact", from, copy.id);
          return conversations.get(c.id)!;
        })();
      } catch (e) {
        for (const f of made) files.discard(f);
        throw e;
      }
    });
    for (const f of made) this.deps.extract?.(f.id);
    return conv;
  }
}

/** The share no longer reaches the forker (revoked, retargeted, owner deactivated, item gone): 403. */
export class ForkRefused extends Error {
  constructor() {
    super("fork_refused");
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
