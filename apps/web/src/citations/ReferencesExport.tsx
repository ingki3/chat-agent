import { useEffect, useId, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  CITATION_STATUS_TEXT,
  REFERENCE_STYLES,
  REFERENCE_STYLE_LABEL,
  type ReferenceFormat,
  type ReferenceStyle,
} from "@agentlee/shared";
import { errorText, references } from "../api.js";
import { copyText } from "../chat/copy.js";
import "./citations.css";

/**
 * 참고문헌 내보내기 (#26, PRD FR-5.6): the sources this conversation's answers cited, in APA 7, MLA 9 or the school
 * format — copied, or downloaded as `.txt` / `.docx`. The server gathers, de-duplicates, checks and writes the
 * entries (this screen only shows them). Sources whose citations all failed the check are listed with ⚠️ and left
 * out until "검증 실패 출처 포함" is turned on.
 */
export function ReferencesButton({ conversationId }: { conversationId: string }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="ghost small refs-button"
        data-testid="references-open"
        aria-haspopup="dialog"
        // Not "…내보내기": the composer's 보내기 button is found by that name (a substring would match both).
        aria-label="참고문헌"
        title="참고문헌 내보내기"
        onClick={() => setOpen(true)}
      >
        📚<span className="refs-button-label"> 참고문헌</span>
      </button>
      {open && (
        <ReferencesDialog
          conversationId={conversationId}
          onClose={() => {
            setOpen(false);
            button.current?.focus();
          }}
        />
      )}
    </>
  );
}

const STYLE_HINT: Record<ReferenceStyle, string> = {
  apa: "심리·사회·과학 보고서에 많이 써요",
  mla: "국어·영어·인문 보고서에 많이 써요",
  school: "저자·제목·사이트·날짜·URL·접속일",
};

function ReferencesDialog({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [style, setStyle] = useState<ReferenceStyle>("apa");
  const [includeUnverified, setInclude] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState<ReferenceFormat | null>(null);
  const q = useQuery({
    queryKey: ["references", conversationId, style, includeUnverified],
    queryFn: () => references.list(conversationId, style, includeUnverified),
    placeholderData: keepPreviousData,
    staleTime: 0,
  });

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  const data = q.data;
  const included = data?.items.filter((i) => i.included) ?? [];
  const excludedItems = data?.items.filter((i) => !i.included) ?? [];
  const failed = data?.items.filter((i) => !i.verified).length ?? 0;
  const empty = !included.length;
  // The list shown may still be the previous choice's (kept while the new one loads): copy and downloads wait
  // until the answer is for the style and toggle chosen now.
  const current =
    !!data && !q.isPlaceholderData && data.style === style && data.includeUnverified === includeUnverified;
  const blocked = empty || !current || !!busy;

  const copy = async () => {
    if (!current || !data?.text) return;
    const ok = await copyText(data.text);
    setStatus(
      ok ? { text: `${included.length}개 항목을 복사했어요.` } : { text: "복사하지 못했어요.", error: true },
    );
  };
  const download = async (format: ReferenceFormat) => {
    setBusy(format);
    setStatus({ text: `.${format} 파일을 만드는 중…` });
    try {
      const { blob, name } = await references.download(conversationId, style, includeUnverified, format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setStatus({ text: `${name} 파일을 내려받았어요.` });
    } catch (e) {
      setStatus({ text: errorText(e), error: true });
    } finally {
      setBusy(null);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="refs-dialog"
      data-testid="references-dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop (the dialog element itself, outside its box) closes it.
        if (e.target === dialog.current) dialog.current.close();
      }}
    >
      <div className="refs-body">
        <div className="refs-head">
          <h2 id={titleId}>참고문헌 내보내기</h2>
          <button
            type="button"
            className="ghost small"
            aria-label="닫기"
            onClick={() => dialog.current?.close()}
          >
            ✕
          </button>
        </div>
        <p className="muted small">이 대화의 답에서 인용한 출처를 한 번씩 모아 보고서용 목록으로 만들어요.</p>

        <fieldset className="refs-styles">
          <legend>형식</legend>
          {REFERENCE_STYLES.map((s) => (
            <label key={s} className={`refs-style${style === s ? " on" : ""}`}>
              <input
                type="radio"
                name={`${titleId}-style`}
                value={s}
                checked={style === s}
                onChange={() => {
                  setStyle(s);
                  setStatus(null);
                }}
              />
              <span className="refs-style-name">{REFERENCE_STYLE_LABEL[s]}</span>
              <span className="refs-style-hint">{STYLE_HINT[s]}</span>
            </label>
          ))}
        </fieldset>

        <label className="refs-toggle">
          <input
            type="checkbox"
            data-testid="references-include-unverified"
            checked={includeUnverified}
            onChange={(e) => {
              setInclude(e.currentTarget.checked);
              setStatus(null);
            }}
          />
          검증 실패 출처 포함
          {failed > 0 && <span className="muted small"> (⚠️ {failed}개)</span>}
        </label>

        <div className="refs-list" aria-busy={q.isFetching} data-testid="references-list">
          {q.isError ? (
            <div className="notice err" role="alert">
              목록을 불러오지 못했어요. {errorText(q.error)}
            </div>
          ) : !data ? (
            <p className="muted">불러오는 중…</p>
          ) : !data.items.length ? (
            <p className="muted" data-testid="references-empty">
              이 대화에는 아직 인용한 출처가 없어요.
            </p>
          ) : (
            <>
              {included.length > 0 && (
                <ol className={`refs-entries${style === "school" ? " numbered" : ""}`}>
                  {included.map((i) => (
                    <li
                      key={i.id}
                      data-testid="references-entry"
                      data-verified={i.verified}
                      className={i.verified ? undefined : "warn"}
                    >
                      {!i.verified && (
                        <span className="refs-warn" title={CITATION_STATUS_TEXT[i.status]}>
                          ⚠️ <span className="sr-only">{CITATION_STATUS_TEXT[i.status]}: </span>
                        </span>
                      )}
                      {i.text}
                    </li>
                  ))}
                </ol>
              )}
              {excludedItems.length > 0 && (
                <div className="refs-excluded" data-testid="references-excluded">
                  <p className="small">
                    ⚠️ 검증에 실패한 출처 {excludedItems.length}개는 빼고 내보내요 (위 &quot;검증 실패 출처
                    포함&quot;을 켜면 들어가요).
                  </p>
                  <ul>
                    {excludedItems.map((i) => (
                      <li key={i.id} data-testid="references-excluded-entry">
                        <span className="refs-reason">{CITATION_STATUS_TEXT[i.status]}</span> {i.text}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {data.truncated && <p className="muted small">출처가 너무 많아 처음 200개만 담았어요.</p>}
            </>
          )}
        </div>

        <div className="refs-actions">
          <button
            type="button"
            className="primary"
            data-testid="references-copy"
            disabled={blocked}
            onClick={() => void copy()}
          >
            ⧉ 복사
          </button>
          <button
            type="button"
            data-testid="references-txt"
            disabled={blocked}
            onClick={() => void download("txt")}
          >
            {busy === "txt" ? "만드는 중…" : ".txt 내려받기"}
          </button>
          <button
            type="button"
            data-testid="references-docx"
            disabled={blocked}
            onClick={() => void download("docx")}
          >
            {busy === "docx" ? "만드는 중…" : ".docx 내려받기"}
          </button>
        </div>
        <p
          className={`refs-status small${status?.error ? " err" : ""}`}
          role={status?.error ? "alert" : "status"}
          aria-live="polite"
          data-testid="references-status"
        >
          {status?.text ?? ""}
        </p>
      </div>
    </dialog>
  );
}
