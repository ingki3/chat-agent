import { useCallback, useEffect, useRef, useState } from "react";
import { FILE_ACCEPT, FILE_LIMITS, fileKindOf, type UploadedFile } from "@agentlee/shared";
import { useQueryClient } from "@tanstack/react-query";
import { errorText, files as filesApi } from "../api.js";
import { watchExtract } from "./extract-watch.js";

/**
 * Composer attachments (#22, FR-4.1·4.6): files picked, dropped or pasted are checked here first — size, count
 * and type, so the user hears about it before anything is sent — then uploaded one by one to the conversation.
 * The server checks everything again; its answer replaces the chip's state.
 */
export type Attachment = {
  key: string;
  name: string;
  bytes: number;
  status: "uploading" | "done" | "failed";
  error?: string;
  /** The client's id for the upload (sent with it): cancelling by it works before the file's id is known. */
  uploadId?: string;
  file?: UploadedFile;
  /** The server could not read the file's text (#23): said at once, the file still goes with the message. */
  notice?: string;
};

const sizeText = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;

/** Why a file cannot be sent, before uploading it; undefined when it may go. */
export function precheck(file: File, taken: number): string | undefined {
  if (!fileKindOf(file.name))
    return "지원하지 않는 형식이에요 (PDF·한글·Word·Excel·CSV·PowerPoint·텍스트·PNG·JPG).";
  if (file.size > FILE_LIMITS.bytes) return "50MB를 넘어서 올릴 수 없어요.";
  if (file.size === 0) return "빈 파일이에요.";
  if (taken >= FILE_LIMITS.perConversation) return "한 대화에 파일은 20개까지예요.";
  return undefined;
}

let seq = 0;

/**
 * Uploads this browser session has cancelled or removed, by upload id (review #102 5·6차), shared by every composer:
 * known from the moment the upload starts, so a composer that mounts later (the new chat's conversation page) never
 * brings one back — whatever order the upload, the cancel and its list read finish in — and a send never carries
 * one. The server refuses them too (FileStore.refs).
 */
const discarded = new Set<string>();
/** A file's key in `discarded`: its upload id (files from before upload ids: the file id). */
const discardKey = (f: UploadedFile) => f.uploadId ?? f.id;

/**
 * Chips for the conversation's unsent files this composer has not shown yet (uploaded before a reload or on
 * another device): marked as shown in `seen`, handed to `register` (the composer's list), and only then each
 * watched until its extraction is final (`watch`) — so a file the server cannot read says so after a reload too
 * (review #120).
 */
export function restoreChips(
  existing: readonly UploadedFile[],
  seen: Set<string>,
  register: (chips: Attachment[]) => void,
  watch: (key: string, fileId: string) => void,
): Attachment[] {
  const back = existing.filter(
    (f) => f.messageId === null && !seen.has(f.id) && !discarded.has(discardKey(f)),
  );
  const out = back.map((f): Attachment => ({
    key: `a${++seq}`,
    name: f.name,
    bytes: f.bytes,
    status: "done",
    file: f,
  }));
  if (!out.length) return out;
  for (const a of out) seen.add(a.file!.id);
  register(out);
  for (const a of out) watch(a.key, a.file!.id);
  return out;
}

/**
 * `conversation()`: the conversation to upload to (the new-chat screen makes one on the first file);
 * `existing`: the conversation's files on the server (sent ones count towards the 20 too). Unsent ones — uploaded
 * before a reload or on another device — come back as chips, so they can be sent or removed (review #102).
 */
export function useAttachments(conversation: () => Promise<string>, existing: readonly UploadedFile[]) {
  const qc = useQueryClient();
  const [items, setItems] = useState<Attachment[]>([]);
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  /** Server files this composer has shown or removed: never brought back again (a removed or sent one). */
  const seen = useRef(new Set<string>());
  /** Server files deleted from here: no longer counted, even before the server list is fetched again. */
  const gone = useRef(new Set<string>());
  /** Chips removed while their upload was still under way, with their cancel request. */
  const cancelled = useRef(new Map<string, Promise<unknown>>());
  const patch = (key: string, p: Partial<Attachment>) =>
    setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));
  /** False once the composer is gone: its watches stop. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  /**
   * A file the server cannot read (password, distribution-only HWP, damaged …) is said on its chip — watched until
   * its extraction is final, for new uploads and for chips restored after a reload (review #120).
   */
  const watch = useCallback((key: string, fileId: string) => {
    void watchExtract(() => filesApi.extract(fileId), {
      stopped: () => !alive.current || !itemsRef.current.some((x) => x.key === key),
    }).then((notice) => {
      if (notice && alive.current) patch(key, { notice });
    });
  }, []);
  useEffect(() => {
    restoreChips(
      existing,
      seen.current,
      (restored) => {
        itemsRef.current = [...restored, ...itemsRef.current];
        setItems((xs) => [...restored, ...xs]);
      },
      watch,
    );
  }, [existing, watch]);

  const add = useCallback(
    (picked: Iterable<File>) => {
      const mine = new Set(itemsRef.current.flatMap((x) => (x.file ? [x.file.id] : [])));
      let taken =
        existing.filter((f) => !mine.has(f.id) && !gone.current.has(f.id)).length +
        itemsRef.current.filter((x) => x.status !== "failed").length;
      const next: { a: Attachment; file: File }[] = [];
      for (const file of picked) {
        const error = precheck(file, taken);
        const a: Attachment = {
          key: `a${++seq}`,
          name: file.name,
          bytes: file.size,
          status: error ? "failed" : "uploading",
          ...(error ? { error } : { uploadId: crypto.randomUUID() }),
        };
        if (!error) taken++;
        next.push({ a, file });
      }
      setItems((xs) => [...xs, ...next.map((n) => n.a)]);
      for (const { a, file } of next) {
        if (a.status === "failed") continue;
        void (async () => {
          try {
            const id = await conversation();
            // Cancelled while the conversation was being made: never sent at all (review #102 7차).
            if (discarded.has(a.uploadId!)) {
              cancelled.current.delete(a.key);
              return;
            }
            const uploaded = await filesApi.upload(id, file, a.uploadId!);
            seen.current.add(uploaded.id);
            // Removed while it was uploading: the server was told at once, by upload id (review #102 6차) — it
            // discards the upload, or deletes it if it was already stored. The list is fetched again once the
            // cancel is done.
            const cancel = cancelled.current.get(a.key);
            if (cancel) {
              cancelled.current.delete(a.key);
              await cancel;
              void qc.invalidateQueries({ queryKey: ["files", id] });
              return;
            }
            // The conversation's list is fetched again: if this composer is gone meanwhile (the new chat moved to
            // its conversation while this upload ran), the composer there shows the file as an unsent chip
            // (review #102 4차). This one has it in `seen` and does not add it twice.
            void qc.invalidateQueries({ queryKey: ["files", id] });
            patch(a.key, { status: "done", file: uploaded });
            watch(a.key, uploaded.id);
          } catch (e) {
            // Cancelled (the server answers `upload_cancelled`) or failed after the chip went: nothing to show.
            if (cancelled.current.delete(a.key)) return;
            patch(a.key, { status: "failed", error: errorText(e) });
          }
        })();
      }
    },
    [conversation, existing, qc, watch],
  );

  const remove = useCallback((key: string) => {
    const a = itemsRef.current.find((x) => x.key === key);
    setItems((xs) => xs.filter((x) => x.key !== key));
    if (!a || a.status === "failed") return;
    // Cancelled on the server by upload id, whether the upload is under way, stored or not yet arrived (review #102
    // 6차); a file from before upload ids by its file id. A failed cancel just leaves the file in the conversation
    // (it comes back as a chip on the next visit). A removed file frees its place in the 20 once the server has
    // cancelled it (review 2).
    const uploadId = a.uploadId ?? a.file?.uploadId ?? undefined;
    const fileId = a.file?.id;
    const key2 = uploadId ?? fileId;
    if (!key2) return;
    discarded.add(key2);
    const request = (uploadId ? filesApi.cancelUpload(uploadId) : filesApi.remove(fileId!))
      .then(() => {
        if (fileId) gone.current.add(fileId);
      })
      .catch(() => undefined);
    if (a.status === "uploading") cancelled.current.set(key, request);
  }, []);

  /**
   * After a send: drops the chips of the files that went with it — only those (review #102 3차: files added while
   * the send was under way stay as unsent chips).
   */
  const sent = useCallback((ids: readonly string[]) => {
    const went = new Set(ids);
    setItems((xs) => xs.filter((x) => !(x.file && went.has(x.file.id))));
  }, []);
  /**
   * After a send was refused for its files (`invalid_attachment`): the server's list decides — chips whose file is
   * gone or already sent are dropped, so the next send goes through (review #102 5차).
   */
  const reconcile = useCallback(async () => {
    const id = await conversation();
    const list = await filesApi.list(id);
    void qc.invalidateQueries({ queryKey: ["files", id] });
    const unsent = new Set(list.flatMap((f) => (f.messageId === null ? [f.id] : [])));
    setItems((xs) => xs.filter((x) => !x.file || unsent.has(x.file.id)));
  }, [conversation, qc]);
  const uploading = items.some((x) => x.status === "uploading");
  // Never a file this session has discarded (a chip restored from a list read before its delete finished).
  const ready = items.flatMap((x) =>
    x.status === "done" && x.file && !discarded.has(discardKey(x.file)) ? [x.file.id] : [],
  );
  return { items, add, remove, sent, reconcile, uploading, ready };
}

export function AttachmentChips({
  items,
  onRemove,
}: {
  items: readonly Attachment[];
  onRemove: (key: string) => void;
}) {
  if (!items.length) return null;
  return (
    <ul className="attachments" aria-label="첨부 파일">
      {items.map((a) => (
        <li
          key={a.key}
          className={`chip attach ${a.status}`}
          data-testid="attachment"
          data-status={a.status}
          title={a.error ?? a.notice ?? a.name}
        >
          <span aria-hidden>{a.status === "uploading" ? "⏳" : a.status === "failed" ? "⚠️" : "📎"}</span>
          <span className="attach-name">{a.name}</span>
          <span className="muted">
            {a.status === "uploading" ? "올리는 중…" : a.status === "failed" ? "실패" : sizeText(a.bytes)}
          </span>
          {a.status === "done" && a.notice && (
            <span className="attach-notice" role="status" data-testid="attachment-notice">
              {a.notice}
            </span>
          )}
          {a.status === "failed" && a.error && (
            <span className="attach-error" role="alert">
              {a.error}
            </span>
          )}
          <button
            type="button"
            className="ghost small"
            aria-label={`${a.name} 빼기`}
            onClick={() => onRemove(a.key)}
          >
            ✕
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The 📎 button and its hidden file picker (several files at once). */
export function AttachButton({ onPick, disabled }: { onPick: (files: File[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className="ghost"
        aria-label="파일 첨부"
        title="파일 첨부 (파일당 50MB, 대화당 20개)"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        📎
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={FILE_ACCEPT}
        data-testid="file-input"
        onChange={(e) => {
          const picked = [...(e.target.files ?? [])];
          e.target.value = "";
          if (picked.length) onPick(picked);
        }}
      />
    </>
  );
}
