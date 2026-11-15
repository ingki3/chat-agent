import { z } from "zod";

/**
 * 내 지침 (PRD FR-16, #144; detailed rules in docs/memory-spec.md). Four documents per user, stored by the server and
 * put into every new runtime session the same way for both runtimes: `AGENT` (the admin's rules — family-wide and per
 * account), `SOUL` (tone and persona — the admin's default until the user writes their own), `USER` and `MEMORY` (one
 * line per item, each item with a stable id and its sources).
 */
export const MemoryDocKind = z.enum(["agent", "soul", "user", "memory"]);
export type MemoryDocKind = z.infer<typeof MemoryDocKind>;
/** The documents a user edits themselves (`AGENT` is read-only for them). */
export const UserDocKind = z.enum(["soul", "user", "memory"]);
export type UserDocKind = z.infer<typeof UserDocKind>;
/** The admin's documents: the family-wide `AGENT` and the default `SOUL`. Per-account `AGENT` is under the user. */
export const SystemDocRef = z.enum(["common-agent", "default-soul"]);
export type SystemDocRef = z.infer<typeof SystemDocRef>;

export const MEMORY_DOC_FILE: Record<MemoryDocKind, string> = {
  agent: "AGENT.md",
  soul: "SOUL.md",
  user: "USER.md",
  memory: "MEMORY.md",
};

/**
 * Storage caps (spec §1): Unicode code points AND UTF-8 bytes (newlines included) — a save over either is refused.
 * `agentCommon` is the family-wide AGENT, `agent` a per-account one.
 */
export type MemoryDocLimit = { chars: number; bytes: number };
export const MEMORY_DOC_LIMITS = {
  agentCommon: { chars: 8000, bytes: 20_000 },
  agent: { chars: 4000, bytes: 10_000 },
  soul: { chars: 2000, bytes: 6000 },
  user: { chars: 4000, bytes: 12_000 },
  memory: { chars: 8000, bytes: 24_000 },
} as const satisfies Record<string, MemoryDocLimit>;

/** Code points (an emoji outside the BMP is one, not two UTF-16 units). */
export const codePoints = (s: string): number => [...s].length;
/** UTF-8 bytes, computed without Buffer (the browser counts the same). */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}
export const docSize = (s: string) => ({ chars: codePoints(s), bytes: utf8Bytes(s) });
export const withinLimit = (s: string, l: MemoryDocLimit) => {
  const z = docSize(s);
  return z.chars <= l.chars && z.bytes <= l.bytes;
};

/** Line endings as the server stores them. */
export const normalizeDoc = (s: string) => s.replace(/\r\n?/g, "\n");

/**
 * The items of a list document as the user wrote them (spec §1): one item per non-empty line, a leading Markdown
 * list marker (`- `, `* `, `+ `) dropped, surrounding spaces trimmed.
 */
export function parseItemLines(content: string): string[] {
  return normalizeDoc(content)
    .split("\n")
    .map((l) =>
      l
        .trim()
        .replace(/^[-*+]\s+/, "")
        .trim(),
    )
    .filter((l) => l !== "");
}
/** A list document as it is shown, stored and put into the context: `- item` per line. */
export const renderItems = (items: readonly string[]): string => items.map((t) => `- ${t}`).join("\n");

export type DiffOp = { op: "same" | "add" | "del"; text: string };
/**
 * Line diff (longest common subsequence) — the version screen's 차이 보기 and the server's line-to-item matching.
 * Deletions come before additions inside a changed stretch.
 */
export function lineDiff(a: readonly string[], b: readonly string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // Common prefix and suffix first: most edits touch a few lines.
  let start = 0;
  while (start < n && start < m && a[start] === b[start]) start++;
  let endA = n;
  let endB = m;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const A = a.slice(start, endA);
  const B = b.slice(start, endB);
  const rows = A.length + 1;
  const cols = B.length + 1;
  const lcs = new Uint32Array(rows * cols);
  for (let i = A.length - 1; i >= 0; i--)
    for (let j = B.length - 1; j >= 0; j--)
      lcs[i * cols + j] =
        A[i] === B[j]
          ? lcs[(i + 1) * cols + j + 1]! + 1
          : Math.max(lcs[(i + 1) * cols + j]!, lcs[i * cols + j + 1]!);
  const mid: DiffOp[] = [];
  let i = 0;
  let j = 0;
  const dels: DiffOp[] = [];
  const adds: DiffOp[] = [];
  const flush = () => {
    mid.push(...dels.splice(0), ...adds.splice(0));
  };
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) {
      flush();
      mid.push({ op: "same", text: A[i]! });
      i++;
      j++;
    } else if (j >= B.length || (i < A.length && lcs[(i + 1) * cols + j]! >= lcs[i * cols + j + 1]!)) {
      dels.push({ op: "del", text: A[i]! });
      i++;
    } else {
      adds.push({ op: "add", text: B[j]! });
      j++;
    }
  }
  flush();
  return [
    ...a.slice(0, start).map((text) => ({ op: "same" as const, text })),
    ...mid,
    ...a.slice(endA).map((text) => ({ op: "same" as const, text })),
  ];
}

/** Who made a version (spec §1, FR-16.3): the user, the admin, the conversation tool, Dreaming, deletion linkage. */
export const VersionAuthor = z.enum(["user", "admin", "tool", "dreaming", "deletion"]);
export type VersionAuthor = z.infer<typeof VersionAuthor>;
export const VERSION_AUTHOR_LABEL: Record<VersionAuthor, string> = {
  user: "내가 고침",
  admin: "관리자",
  tool: "대화 중 기억",
  dreaming: "기억 정리",
  deletion: "삭제 연동",
};
/** Who wrote an item of `USER.md` / `MEMORY.md`. */
export const ItemAuthor = z.enum(["user", "tool", "dreaming"]);
export type ItemAuthor = z.infer<typeof ItemAuthor>;

/** One document as its screen shows it. */
export const InstructionDoc = z.object({
  kind: MemoryDocKind,
  /** `common-agent` / `default-soul` for the admin's documents; null for a user's own. */
  ref: z.string().nullable(),
  editable: z.boolean(),
  /**
   * own: the user's (or the admin's) own text · default: the admin's default SOUL (the user has not written one) ·
   * composed: the AGENT a user reads (family-wide rules → youth guideline → per-account rules).
   */
  source: z.enum(["own", "default", "composed"]),
  /** Current version number of the caller's own document (0 = never saved — also while it shows the default). */
  version: z.number().int().nonnegative(),
  content: z.string(),
  limit: z.object({ chars: z.number().int(), bytes: z.number().int() }).nullable(),
  /** List documents: the current items (stable ids), in order. */
  items: z
    .array(
      z.object({
        id: z.string(),
        text: z.string(),
        author: ItemAuthor,
        /** How many messages the item came from (0 = written by the user). */
        sources: z.number().int().nonnegative(),
      }),
    )
    .nullable(),
  updatedAt: z.number().nullable(),
});
export type InstructionDoc = z.infer<typeof InstructionDoc>;

/** `GET /api/instructions`: the caller's four documents. */
export const InstructionsResponse = z.object({ docs: z.array(InstructionDoc) });
export type InstructionsResponse = z.infer<typeof InstructionsResponse>;

/**
 * `PUT /api/instructions/:kind` and the admin's saves. `baseVersion`: the version the editor started from — a save
 * on top of a newer one is refused (409 `doc_changed`), never silently merged.
 */
export const SaveDocRequest = z
  .object({ content: z.string().max(200_000), baseVersion: z.number().int().nonnegative().optional() })
  .strict();
export type SaveDocRequest = z.infer<typeof SaveDocRequest>;
export const RestoreDocRequest = z
  .object({ baseVersion: z.number().int().nonnegative().optional() })
  .strict();

export const DocVersionSummary = z.object({
  version: z.number().int().positive(),
  author: VersionAuthor,
  prevVersion: z.number().int().nullable(),
  /** A restore (되돌리기) of this version. */
  restoredFrom: z.number().int().nullable(),
  createdAt: z.number(),
  chars: z.number().int(),
});
export type DocVersionSummary = z.infer<typeof DocVersionSummary>;
export const DocVersionsResponse = z.object({ versions: z.array(DocVersionSummary) });
export type DocVersionsResponse = z.infer<typeof DocVersionsResponse>;
export const DocVersionDetail = DocVersionSummary.extend({ content: z.string() });
export type DocVersionDetail = z.infer<typeof DocVersionDetail>;

/** `GET /api/admin/instructions`: the family-wide AGENT, the default SOUL, and each account's AGENT. */
export const AdminInstructionsResponse = z.object({
  commonAgent: InstructionDoc,
  defaultSoul: InstructionDoc,
  accounts: z.array(
    z.object({ userId: z.string(), name: z.string(), youth: z.boolean(), agent: InstructionDoc }),
  ),
});
export type AdminInstructionsResponse = z.infer<typeof AdminInstructionsResponse>;

/**
 * Refusals of a save (spec §4 user direct edit): over a cap, a secret value, a sentence that tries to change the rules
 * (SOUL/USER/MEMORY), saved on top of a newer version, a read-only document.
 */
export const DOC_ERRORS = {
  doc_too_long: "저장 상한(글자 수 또는 바이트)을 넘었어요.",
  doc_secret: "비밀 값(키·비밀번호 같은 것)은 지침에 적을 수 없어요.",
  doc_rule_change:
    "규칙·안전 지침·도구·권한·다른 사용자·비밀을 바꾸려는 문장은 적을 수 없어요. 답변 선호만 적어 주세요.",
  doc_changed: "다른 곳에서 먼저 바뀌었어요. 새로 불러온 뒤 다시 고쳐 주세요.",
  doc_read_only: "이 문서는 관리자만 고칠 수 있어요.",
} as const;

/** The chip-side note when `MEMORY` / `USER` items had to be left out of a new session (spec §2). */
export const MEMORY_TRIMMED_CODE = "memory_trimmed";
export const MEMORY_TRIMMED_TEXT = "기억 일부만 넣었어요";
