import { Fragment, memo, useMemo } from "react";
import { redactForDisplay, type PublicPart } from "@agentlee/shared";
import { files } from "../api.js";
import { RichText } from "./RichText.js";
import type { MarkdownCite } from "./Markdown.js";
import { CitationMarker } from "../citations/CitationMarker.js";
import { CitationSources } from "../citations/CitationNote.js";
import { markerNumbers } from "../citations/markdown.js";
import { citationNoteOf, citationView } from "../citations/segments.js";
import { ArtifactCard } from "../artifacts/ArtifactPanel.js";
import { ScheduleCard } from "../schedules/ScheduleCard.js";
import { proposalIds } from "../schedules/format.js";

type ToolCall = Extract<PublicPart, { type: "tool_call" }>;
type ToolResult = Extract<PublicPart, { type: "tool_result" }>;
type TablePart = Extract<PublicPart, { type: "table" }>;
type DividerPart = Extract<PublicPart, { type: "divider" }>;
type FinanceNotePart = Extract<PublicPart, { type: "finance_note" }>;

export const RUNTIME_LABEL: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex" };
const runtimeClass = (r: string | null | undefined) =>
  r === "codex" ? "codex" : r === "claude-code" ? "claude" : "none";

/** Short, single-line, secret-free JSON for the tool details (FR-3.4). */
export function summarize(value: unknown, max = 240): string {
  if (value === null || value === undefined) return "—";
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(redactForDisplay(value));
  } catch {
    s = String(value);
  }
  if (typeof value === "string") s = String(redactForDisplay(s));
  s = s.replace(/\s+/g, " ");
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : s;
}

type Segment =
  | { kind: "part"; part: PublicPart; index: number }
  | { kind: "tools"; calls: ToolCall[]; results: Map<string, ToolResult>; index: number };

/**
 * Display order: consecutive tool calls share one status line; everything else stays in order. Results are
 * linked to their call by `callId` across the whole reply (text may come between a call and its result), and
 * take no place of their own.
 */
export function segments(parts: readonly PublicPart[]): Segment[] {
  const results = new Map<string, ToolResult>();
  for (const p of parts) if (p.type === "tool_result") results.set(p.callId, p);
  const out: Segment[] = [];
  parts.forEach((part, index) => {
    if (part.type === "tool_result") return;
    if (part.type === "tool_call") {
      const last = out.at(-1);
      if (last?.kind === "tools") last.calls.push(part);
      else out.push({ kind: "tools", calls: [part], results, index });
    } else out.push({ kind: "part", part, index });
  });
  return out;
}

function Tools({
  calls,
  results,
  streaming,
}: {
  calls: ToolCall[];
  results: Map<string, ToolResult>;
  streaming: boolean;
}) {
  const running = calls.filter((c) => !results.has(c.id));
  const failed = calls.filter((c) => results.get(c.id)?.isError).length;
  const names = [...new Set(calls.map((c) => c.name))].join(", ");
  const summary =
    streaming && running.length > 0
      ? `⏳ ${[...new Set(running.map((c) => c.name))].join(", ")} 실행 중…`
      : `도구 사용 ${calls.length}개 · ${names}${failed ? ` · 실패 ${failed}개` : ""}`;
  return (
    <details className="tools" data-testid="tools">
      <summary aria-live={streaming ? "polite" : undefined}>{summary}</summary>
      {calls.map((c) => {
        const r = results.get(c.id);
        return (
          <div key={c.id} className="t">
            <b>{c.name}</b>
            <span className="tin">{summarize(c.input)}</span>
            <span className="tout">
              {r ? (
                <>
                  → {r.isError && <span className="badge err">오류</span>} {summarize(r.output)}
                </>
              ) : streaming ? (
                " → 실행 중…"
              ) : (
                " → 결과 없음"
              )}
            </span>
          </div>
        );
      })}
    </details>
  );
}

const fmt = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 6 });

/** Structured table part: numbers right-aligned (finance details come with #31). */
export function TableView({ t }: { t: TablePart }) {
  const numeric = t.columns.map((c) => t.rows.some((r) => typeof r[c.key] === "number"));
  return (
    <div className="tablewrap" data-testid="table-part">
      <table>
        <thead>
          <tr>
            {t.columns.map((c, i) => (
              <th key={c.key} className={numeric[i] ? "num" : undefined}>
                {c.label}
                {c.unit ? <span className="muted"> ({c.unit})</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {t.rows.map((r, ri) => (
            <tr key={ri}>
              {t.columns.map((c, i) => {
                const v = r[c.key];
                return (
                  <td key={c.key} className={numeric[i] ? "num" : undefined}>
                    {v === null || v === undefined ? "—" : typeof v === "number" ? fmt.format(v) : v}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {(t.source || t.asOf) && (
        <div className="small muted caption">
          {t.source && <>출처: {t.source}</>}
          {t.source && t.asOf && " · "}
          {t.asOf && <>기준: {t.asOf}</>}
        </div>
      )}
    </div>
  );
}

/** `── 여기부터 Codex · ○○ ──` and "앞부분은 요약해서 넘겼어요" (FR-3.5). */
export function DividerView({ d }: { d: DividerPart }) {
  return (
    <div className="divider" role="separator" data-testid="divider">
      {d.kind === "runtime_switch" && d.runtime ? (
        <>
          여기부터 <span className={`dot ${runtimeClass(d.runtime)}`} />
          {/* The server's label names the model as the chip does (#19); older dividers carry only the ids. */}
          {d.label.replace(/^여기부터\s*/, "") ||
            [RUNTIME_LABEL[d.runtime] ?? d.runtime, d.model].filter(Boolean).join(" · ")}
        </>
      ) : (
        d.label || (d.kind === "summary" ? "앞부분은 요약해서 넘겼어요" : "")
      )}
    </div>
  );
}

/**
 * The server's note under an answer that used a finance tool (#30, FR-7.6·7.8): where the numbers come from and
 * as of when, a warning when the answer itself left that out, and the disclaimer.
 */
export function FinanceNote({ note }: { note: FinanceNotePart }) {
  return (
    <div className="finance-note" data-testid="finance-note">
      {note.missing.length > 0 && (
        <div className="notice warn" data-testid="finance-missing">
          ⚠️{" "}
          {note.missing.includes("tool_meta")
            ? "일부 숫자는 출처·기준 시각을 확인하지 못했어요."
            : "답변에 출처·기준 시각이 빠진 부분이 있어 아래 기준을 덧붙였어요."}
        </div>
      )}
      {note.sources.length > 0 && (
        <ul className="sources" aria-label="출처·기준 시각">
          {note.sources.map((src) => (
            <li key={src.label}>{src.label}</li>
          ))}
        </ul>
      )}
      <p className="disclaimer">{note.disclaimer}</p>
    </div>
  );
}

const PartView = memo(function PartView({
  part,
  cite,
  text,
}: {
  part: PublicPart;
  cite?: MarkdownCite | undefined;
  text: string;
}) {
  switch (part.type) {
    case "text":
      return <RichText text={part.text} cite={cite} />;
    case "citation_note":
      return <CitationSources note={part} text={text} />;
    case "table":
      return <TableView t={part} />;
    case "divider":
      return <DividerView d={part} />;
    case "finance_note":
      return <FinanceNote note={part} />;
    // An artifact the reply made or changed (#28): a card that opens the panel.
    case "artifact_ref":
      return <ArtifactCard id={part.artifactId} version={part.version} />;
    // Citation refs and files (#22) get their real views later; until then a plain chip.
    case "citation_ref":
      return <span className="chip small">{part.label ?? "출처"}</span>;
    case "file_ref":
      return <FileRef part={part} />;
    default:
      return null;
  }
});

/** An uploaded file (#22): a download link to the original (the viewer is #24). */
export function FileRef({ part }: { part: Extract<PublicPart, { type: "file_ref" }> }) {
  return (
    <a className="chip small fileref" href={files.url(part.fileId)} download data-testid="file-ref">
      📎 {part.name ?? "파일"}
    </a>
  );
}

export function Parts({ parts, streaming = false }: { parts: readonly PublicPart[]; streaming?: boolean }) {
  // Citations (#25): once the answer is finished and carries the server's note, `[n]` become citation buttons.
  const note = streaming ? undefined : citationNoteOf(parts);
  const cite = useMemo<MarkdownCite | undefined>(() => {
    if (!note) return undefined;
    const byN = new Map(note.citations.map((c) => [c.n, c]));
    return {
      numbers: markerNumbers(note),
      render: (n) => <CitationMarker view={citationView(n, byN.get(n))} />,
    };
  }, [note]);
  // The answer text as the server joined it (the note's ranges point into it).
  const answer = parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
  return (
    <>
      {segments(parts).map((s) =>
        s.kind === "tools" ? (
          <Fragment key={`t${s.index}`}>
            <Tools calls={s.calls} results={s.results} streaming={streaming} />
            {/* `schedule_create` (#55): its proposal's confirmation card, under the tool line. */}
            {proposalIds([
              ...s.calls,
              ...s.calls.flatMap((c) => (s.results.has(c.id) ? [s.results.get(c.id)!] : [])),
            ]).map((id) => (
              <ScheduleCard key={id} id={id} />
            ))}
          </Fragment>
        ) : (
          <PartView key={s.index} part={s.part} cite={cite} text={answer} />
        ),
      )}
    </>
  );
}

/** Plain text of a reply, for "⧉ 복사". */
export const textOf = (parts: readonly PublicPart[]) =>
  parts
    .flatMap((p) => (p.type === "text" ? [p.text] : []))
    .join("\n\n")
    .trim();
