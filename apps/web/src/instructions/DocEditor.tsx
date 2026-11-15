import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  docSize,
  lineDiff,
  MEMORY_DOC_FILE,
  normalizeDoc,
  VERSION_AUTHOR_LABEL,
  type InstructionDoc,
} from "@agentlee/shared";
import { errorText, type DocApi } from "../api.js";
import { RichText } from "../chat/RichText.js";

const time = (ms: number) =>
  new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Seoul" }).format(
    ms,
  );
const num = (n: number) => n.toLocaleString("ko-KR");

/** Lines as the server compares them (list documents: one item per line, the `- ` marker kept as written). */
const linesOf = (s: string) => normalizeDoc(s).split("\n");

/**
 * One 내 지침 document (#144): the editor with its character and byte counter (both caps, spec §1), a preview, and
 * the version list with 차이 보기 and 되돌리기 (a new version with the chosen one's content). `doc.editable` false: a
 * read-only view (AGENT for a user). `queryKey`: refreshed after a save or a restore.
 */
export function DocEditor({
  doc,
  api,
  queryKey,
  hint,
}: {
  doc: InstructionDoc;
  api: DocApi;
  queryKey: readonly unknown[];
  hint?: string;
}) {
  const qc = useQueryClient();
  const [text, setText] = useState(doc.content);
  const [base, setBase] = useState(doc.version);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  // A newer version from elsewhere (a restore, another tab) replaces the text only while it is not being edited; an
  // edit in progress keeps its base, so saving it is refused (409) instead of overwriting the newer one.
  const [loaded, setLoaded] = useState({ content: doc.content, version: doc.version });
  if (loaded.content !== doc.content || loaded.version !== doc.version) {
    if (text === loaded.content) {
      setText(doc.content);
      setBase(doc.version);
    }
    setLoaded({ content: doc.content, version: doc.version });
  }
  const size = docSize(text);
  const over = doc.limit !== null && (size.chars > doc.limit.chars || size.bytes > doc.limit.bytes);
  const done = (d: InstructionDoc, what: string) => {
    // The list refreshes after this: `loaded` stays the old one, so the refresh does not reset the text again.
    setText(d.content);
    setBase(d.version);
    setMessage({ ok: true, text: what });
    void qc.invalidateQueries({ queryKey });
    void qc.invalidateQueries({ queryKey: [...queryKey, "versions", doc.kind, doc.ref] });
  };
  const save = useMutation({
    mutationFn: () => api.save(text, base),
    onMutate: () => setMessage(undefined),
    onSuccess: (d) => done(d, "저장했어요. 다음 메시지부터 새 대화 세션에 적용돼요."),
    onError: (e) => setMessage({ ok: false, text: errorText(e) }),
  });
  const label = doc.ref ?? doc.kind;
  return (
    <div className="doc-editor" data-testid={`doc-${label}`}>
      {hint && <p className="muted small">{hint}</p>}
      {doc.source === "default" && (
        <p className="notice info small" data-testid="doc-default">
          관리자가 정한 기본값이에요. 고쳐서 저장하면 내 것으로 바뀌어요.
        </p>
      )}
      {doc.editable ? (
        <>
          <div className="segmented" role="radiogroup" aria-label="보기">
            {(
              [
                ["edit", "편집"],
                ["preview", "미리보기"],
              ] as const
            ).map(([v, l]) => (
              <label key={v} className={mode === v ? "on" : ""}>
                <input
                  type="radio"
                  name={`doc-mode-${label}`}
                  checked={mode === v}
                  onChange={() => setMode(v)}
                />
                {l}
              </label>
            ))}
          </div>
          {mode === "edit" ? (
            <textarea
              className="doc-text"
              aria-label={`${MEMORY_DOC_FILE[doc.kind]} 내용`}
              value={text}
              rows={14}
              onChange={(e) => {
                setText(e.target.value);
                setMessage(undefined);
              }}
            />
          ) : (
            <div className="doc-preview" data-testid="doc-preview">
              <RichText text={text || "_(비어 있어요)_"} />
            </div>
          )}
          <div className="doc-bar">
            {doc.limit && (
              <span className={`small ${over ? "error" : "muted"}`} data-testid="doc-counter">
                글자 {num(size.chars)} / {num(doc.limit.chars)} · 바이트 {num(size.bytes)} /{" "}
                {num(doc.limit.bytes)}
              </span>
            )}
            <span className="spacer" />
            <button
              type="button"
              disabled={(text === doc.content && base === doc.version) || save.isPending}
              onClick={() => {
                setText(doc.content);
                setBase(doc.version);
                setMessage(undefined);
              }}
            >
              취소
            </button>
            <button
              type="button"
              className="primary"
              disabled={over || save.isPending || (text === doc.content && base === doc.version)}
              onClick={() => save.mutate()}
            >
              저장
            </button>
          </div>
          {message && (
            <p className={`small ${message.ok ? "muted" : "error"}`} role={message.ok ? "status" : "alert"}>
              {message.text}
            </p>
          )}
        </>
      ) : (
        <div className="doc-preview" data-testid="doc-readonly">
          <RichText text={doc.content || "_(비어 있어요)_"} />
        </div>
      )}
      {doc.editable && (
        <Versions
          doc={doc}
          api={api}
          queryKey={[...queryKey, "versions", doc.kind, doc.ref]}
          current={doc.content}
          onRestored={(d) => done(d, "되돌렸어요. 고른 버전의 내용으로 새 버전을 만들었어요.")}
          onError={(text) => setMessage({ ok: false, text })}
          base={base}
        />
      )}
    </div>
  );
}

function Versions({
  doc,
  api,
  queryKey,
  current,
  base,
  onRestored,
  onError,
}: {
  doc: InstructionDoc;
  api: DocApi;
  queryKey: readonly unknown[];
  current: string;
  base: number;
  onRestored: (d: InstructionDoc) => void;
  onError: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<number>();
  const list = useQuery({ queryKey: [...queryKey, doc.version], queryFn: api.versions, enabled: open });
  const detail = useQuery({
    queryKey: [...queryKey, "v", chosen],
    queryFn: () => api.version(chosen!),
    enabled: chosen !== undefined,
  });
  const restore = useMutation({
    mutationFn: (v: number) => api.restore(v, base),
    onSuccess: (d) => {
      setChosen(undefined);
      onRestored(d);
    },
    onError: (e) => onError(errorText(e)),
  });
  const diff = useMemo(
    () => (detail.data ? lineDiff(linesOf(current), linesOf(detail.data.content)) : []),
    [detail.data, current],
  );
  return (
    <details
      className="doc-versions"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary>버전 ({doc.version})</summary>
      {list.isError && <p className="error small">{errorText(list.error)}</p>}
      {list.data && list.data.length === 0 && <p className="muted small">아직 저장한 버전이 없어요.</p>}
      <ul className="version-list">
        {list.data?.map((v) => (
          <li key={v.version} className={chosen === v.version ? "on" : ""}>
            <button type="button" className="link" onClick={() => setChosen(v.version)}>
              v{v.version}
            </button>
            <span className="small muted">
              {" "}
              {time(v.createdAt)} · {VERSION_AUTHOR_LABEL[v.author]}
              {v.restoredFrom !== null ? ` · v${v.restoredFrom}에서 되돌림` : ""} · {num(v.chars)}자
            </span>
            {v.version === doc.version && <span className="small"> (지금)</span>}
          </li>
        ))}
      </ul>
      {chosen !== undefined && detail.data && (
        <div className="version-diff" data-testid="version-diff">
          <p className="small muted">지금 내용 → v{chosen} (빨강: 빠짐, 초록: 생김)</p>
          <pre className="diff">
            {diff.map((d, i) => (
              <span key={i} className={`diff-${d.op}`}>
                {d.op === "add" ? "+ " : d.op === "del" ? "− " : "  "}
                {d.text}
                {"\n"}
              </span>
            ))}
          </pre>
          <button
            type="button"
            disabled={chosen === doc.version || restore.isPending}
            onClick={() => restore.mutate(chosen)}
          >
            v{chosen}으로 되돌리기
          </button>
        </div>
      )}
    </details>
  );
}
