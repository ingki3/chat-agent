import { useEffect, useRef, type ReactNode } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router";
import {
  EXTRACT_CODE_TEXT,
  LOCATE_REASON_TEXT,
  locatorLabel,
  parseLocParam,
  type FileLocator,
  type FileViewResponse,
  type UploadedFile,
  type ViewSegment,
  type ViewTarget,
} from "@agentlee/shared";
import { ApiError, errorText, files } from "../api.js";
import { TopBar } from "../Shell.js";
import {
  blocks,
  boxStyle,
  cellsOf,
  colName,
  columns,
  GRID_COLS,
  highlightsOf,
  isTargetUnit,
  linesOf,
  loadedView,
  pieces,
  type Block,
  type Cell,
} from "./view-model.js";
import "./files.css";

/**
 * `/c/:id/files/:fileId?loc=` — the file viewer (#24, PRD FR-4.5): the file's extracted text laid out by its units
 * (pages with their line or word boxes, paragraphs, tables by row and column, sheets, slides, lines), opened at the
 * locator with the passage highlighted — or, when the server could not stand behind the exact passage, the unit
 * it is in, with the reason; nothing at all for a place the file does not have.
 *
 * Safety: only the server's scrubbed text is shown (a known secret is a placeholder, #78), always as text — no
 * file is ever run or parsed here. An image is shown from the original's inline route (an `<img>`, the same CSP'd
 * response the download uses); PDF pages are never rendered from the original. Every request goes through the
 * share projection on the server (#29).
 */
type Window = { from: number; to?: number | undefined };

export function FileViewerPage({ conversationId, fileId }: { conversationId: string; fileId: string }) {
  const { search } = useLocation();
  const loc = parseLocParam(new URLSearchParams(search).get("loc"));
  const navigate = useNavigate();
  const view = useInfiniteQuery({
    queryKey: ["file-view", fileId, loc ? JSON.stringify(loc) : null],
    // The opening window resolves the locator; the windows before and after only page the text (review #123: the
    // target is read from the opening window, wherever it ends up in the list).
    queryFn: ({ pageParam }) => files.view(fileId, pageParam === undefined ? { loc } : pageParam),
    initialPageParam: undefined as Window | undefined,
    getNextPageParam: (last): Window | undefined => (last.next === null ? undefined : { from: last.next }),
    // A window before ends where the first one shown starts: nothing is shown twice.
    getPreviousPageParam: (first): Window | undefined =>
      first.prev === null ? undefined : { from: first.prev, to: first.items[0]?.seq },
    retry: false,
    // Still being read: look again until the text is there.
    refetchInterval: (q) => (q.state.data?.pages[0]?.extract.status === "pending" ? 3000 : false),
  });
  const back = () => {
    // Back where the link was followed from; a link opened on its own goes to the conversation.
    if ((window.history.state as { idx?: number } | null)?.idx) void navigate(-1);
    else void navigate(`/c/${encodeURIComponent(conversationId)}`);
  };
  const loaded = view.data ? loadedView(view.data) : undefined;
  const first = loaded?.opening;
  const refused =
    view.error instanceof ApiError && [400, 403, 404].includes(view.error.status)
      ? true
      : !!first && first.file.conversationId !== conversationId;
  const bar = (title: ReactNode, file?: UploadedFile) => (
    <TopBar title={title}>
      <button type="button" className="small ghost" onClick={back} data-testid="file-view-back">
        ← 대화로
      </button>
      {file && (
        <a className="small" href={files.url(file.id)} download>
          원본 내려받기
        </a>
      )}
    </TopBar>
  );
  if (refused)
    return (
      <>
        {bar("📄 파일")}
        <div className="empty" role="alert" data-testid="file-view-refused">
          <p>이 파일을 열 수 없어요.</p>
          <p className="muted small">지워졌거나, 나에게 공유되지 않은 파일이에요.</p>
        </div>
      </>
    );
  if (view.isError)
    return (
      <>
        {bar("📄 파일")}
        <div className="empty" role="alert">
          {errorText(view.error)}
        </div>
      </>
    );
  if (!first || !view.data)
    return (
      <>
        {bar("📄 파일")}
        <div className="empty muted">불러오는 중…</div>
      </>
    );
  const items = loaded!.items;
  return (
    <>
      {bar(`📄 ${first.file.name}`, first.file)}
      <div className="file-view" data-testid="file-view">
        {loc && <TargetNotice loc={loc} target={first.target} />}
        <ExtractNotice d={first} />
        {view.hasPreviousPage && (
          <button
            type="button"
            className="ghost small"
            disabled={view.isFetchingPreviousPage}
            onClick={() => void view.fetchPreviousPage()}
          >
            {view.isFetchingPreviousPage ? "불러오는 중…" : "↑ 앞부분 더 보기"}
          </button>
        )}
        <FileBody file={first.file} items={items} target={first.target} />
        {view.hasNextPage && (
          <button
            type="button"
            className="ghost small"
            disabled={view.isFetchingNextPage}
            onClick={() => void view.fetchNextPage()}
          >
            {view.isFetchingNextPage ? "불러오는 중…" : "↓ 뒷부분 더 보기"}
          </button>
        )}
      </div>
    </>
  );
}

/** What the viewer could do with the locator: highlighted exactly, the unit only (why), or nothing (why). */
function TargetNotice({ loc, target }: { loc: FileLocator; target: ViewTarget | null }) {
  if (!target) return null;
  const place = locatorLabel(loc) || "인용한 위치";
  const ok = target.status === "exact";
  return (
    <div
      className={`notice ${ok ? "info" : "warn"} small`}
      role="status"
      data-testid="file-view-status"
      data-status={target.status}
    >
      <strong>{place}</strong>{" "}
      {ok
        ? "— 인용한 구절을 강조했어요."
        : target.reasons.map((r) => (
            <span key={r} data-reason={r}>
              {LOCATE_REASON_TEXT[r]}{" "}
            </span>
          ))}
    </div>
  );
}

function ExtractNotice({ d }: { d: FileViewResponse }) {
  const e = d.extract;
  if (e.status === "pending")
    return (
      <p className="notice info small" role="status">
        파일의 글자를 읽는 중이에요…
      </p>
    );
  if (e.status === "failed")
    return (
      <p className="notice warn small" role="status">
        {e.code ? EXTRACT_CODE_TEXT[e.code] : "파일을 읽을 수 없어요"} — 원본을 내려받아 확인하세요.
      </p>
    );
  return (
    <>
      {e.segments === 0 && (
        <p className="notice info small">
          {e.ocr === "unavailable"
            ? "이 서버에서는 사진 속 글자를 읽을 수 없어 보여 줄 글자가 없어요."
            : "이 파일에서 읽은 글자가 없어요."}
        </p>
      )}
      {e.truncated && <p className="notice warn small">파일이 길어 앞부분만 읽었어요.</p>}
      {e.ocr === "partial" && (
        <p className="notice warn small">스캔한 쪽이 많아 일부 쪽의 글자만 읽었어요.</p>
      )}
    </>
  );
}

/** The blocks, scrolled to the located unit once it is on screen. */
export function FileBody({
  file,
  items,
  target,
}: {
  file: UploadedFile;
  items: ViewSegment[];
  target: ViewTarget | null;
}) {
  const root = useRef<HTMLDivElement>(null);
  const scrolled = useRef<string | null>(null);
  const key = target ? JSON.stringify(target) : null;
  useEffect(() => {
    if (!key || scrolled.current === key) return;
    const el = root.current?.querySelector<HTMLElement>("[data-target='1']");
    if (!el) return;
    scrolled.current = key;
    el.scrollIntoView({ block: "center" });
    el.focus({ preventScroll: true });
  }, [key, items.length]);
  return (
    <div ref={root} className="fv-body">
      {blocks(items).map((b) => (
        <BlockView key={b.key} b={b} file={file} target={target} />
      ))}
    </div>
  );
}

/** Text with its highlights: the passage as `<mark>`, the named line or cell underlined. */
function Text({
  seg,
  target,
  start = 0,
  end,
}: {
  seg: ViewSegment;
  target: ViewTarget | null;
  start?: number;
  end?: number;
}) {
  return (
    <>
      {pieces(seg.text, highlightsOf(seg.seq, target), start, end ?? seg.text.length).map((p, i) =>
        p.hit ? (
          <mark key={i} className={`fv-hit${p.focus ? " fv-focus" : ""}`} data-testid="file-view-hit">
            {p.text}
          </mark>
        ) : p.focus ? (
          <span key={i} className="fv-focus" data-testid="file-view-focus">
            {p.text}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/** Attributes of the located unit's element (highlighted, focusable, the scroll target). */
const unitAttrs = (on: boolean) =>
  on ? { "data-target": "1", "data-testid": "file-view-unit", tabIndex: -1 } : {};

function BlockView({ b, file, target }: { b: Block; file: UploadedFile; target: ViewTarget | null }) {
  switch (b.kind) {
    case "page":
      return <PageView b={b} file={file} target={target} />;
    case "lines": {
      const on = isTargetUnit(b.seg.seq, target);
      return (
        <ol className={`fv-lines${on ? " fv-unit" : ""}`} {...unitAttrs(on)}>
          {linesOf(b.seg).map((l, i) => (
            <li key={i} data-line={l.line}>
              <span className="fv-no" aria-hidden="true">
                {l.line ?? "·"}
              </span>
              <span className="fv-text">
                <Text seg={b.seg} target={target} start={l.start} end={l.end} />
              </span>
            </li>
          ))}
        </ol>
      );
    }
    case "paragraph": {
      const on = isTargetUnit(b.seg.seq, target);
      const l = b.seg.locator;
      return (
        <div
          className={`fv-para${b.note ? " fv-note" : ""}${on ? " fv-unit" : ""}`}
          data-paragraph={l.paragraph}
          {...unitAttrs(on)}
        >
          <span className="fv-no">{locatorLabel(l)}</span>
          <p className="fv-text">
            <Text seg={b.seg} target={target} />
          </p>
        </div>
      );
    }
    case "table":
      return <TableView b={b} target={target} />;
    case "sheet":
      return <SheetView b={b} target={target} />;
    case "slide": {
      const on = isTargetUnit(b.seg.seq, target);
      return (
        <section
          className={`fv-slide${on ? " fv-unit" : ""}`}
          data-slide={b.seg.locator.slide}
          {...unitAttrs(on)}
        >
          <h3 className="fv-no">{locatorLabel(b.seg.locator)}</h3>
          <div className="fv-text pre">
            <Text seg={b.seg} target={target} />
          </div>
        </section>
      );
    }
  }
}

/**
 * A page: its place on the page (a map of its line or word boxes, the cited passage's box marked) and its text.
 * An image shows the picture itself under the boxes; a PDF page is drawn from its boxes only.
 */
function PageView({
  b,
  file,
  target,
}: {
  b: Extract<Block, { kind: "page" }>;
  file: UploadedFile;
  target: ViewTarget | null;
}) {
  const on = isTargetUnit(b.seg.seq, target);
  const hitBox = on && target?.status === "exact" ? target.bbox : undefined;
  const boxes = b.seg.marks.flatMap((m) => (m.bbox ? [m.bbox] : []));
  const image = b.ocr && b.page === undefined && (file.kind === "png" || file.kind === "jpg");
  const title = [b.page !== undefined && `${b.page}쪽`, b.ocr && "사진 속 글자"].filter(Boolean).join(" · ");
  return (
    <section className={`fv-page${on ? " fv-unit" : ""}`} data-page={b.page} {...unitAttrs(on)}>
      <h3 className="fv-no">{title || "본문"}</h3>
      <div className="fv-page-body">
        {(image || boxes.length > 0 || hitBox) && (
          <div
            className={`fv-map${image ? " fv-map-image" : ""}`}
            role="img"
            aria-label={hitBox ? `${title} · 인용한 구절의 위치` : `${title}의 글자 위치`}
          >
            {image && <img src={files.url(file.id, true)} alt="" draggable={false} />}
            {boxes.map((bx, i) => (
              <span key={i} className="fv-box" style={boxStyle(bx)} />
            ))}
            {hitBox && (
              <span className="fv-box fv-box-hit" style={boxStyle(hitBox)} data-testid="file-view-box-hit" />
            )}
          </div>
        )}
        <div className="fv-text pre">
          <Text seg={b.seg} target={target} />
        </div>
      </div>
    </section>
  );
}

/** Cells by column (1…max), the gaps of merged cells left empty; null when the row is wider than a grid draws. */
function CellText({ c, segs, target }: { c: Cell; segs: readonly ViewSegment[]; target: ViewTarget | null }) {
  const seg = segs.find((s) => s.seq === c.seq)!;
  return <Text seg={seg} target={target} start={c.start} end={c.end} />;
}

const focusIn = (c: Cell, target: ViewTarget | null) =>
  !!target?.focus && target.focus.seq === c.seq && target.focus.start <= c.start && target.focus.end >= c.end;

function RowCells({
  segs,
  target,
  letters,
}: {
  segs: ViewSegment[];
  target: ViewTarget | null;
  letters?: number;
}) {
  const cells = cellsOf(segs);
  const g = cells.length ? columns(cells) : null;
  if (!cells.length || !g)
    // No columns kept (a secret's removal cost the marks) or too wide: the row's text as it is.
    return (
      <td colSpan={Math.max(1, letters ?? 1)}>
        {segs.map((s) => (
          <span key={s.seq}>
            <Text seg={s} target={target} />{" "}
          </span>
        ))}
      </td>
    );
  const width = Math.max(g.length, letters ?? 0);
  return (
    <>
      {Array.from({ length: width }, (_, i) => {
        // Every piece of the column, in reading order (a cell split around a note is several, review #123).
        const cs = g[i] ?? [];
        return (
          <td
            key={i}
            className={cs.some((c) => focusIn(c, target)) ? "fv-cell-focus" : undefined}
            title={cs[0]?.ref}
          >
            {cs.map((c, k) => (
              <span key={k}>
                {k > 0 && " "}
                <CellText c={c} segs={segs} target={target} />
              </span>
            ))}
          </td>
        );
      })}
    </>
  );
}

function TableView({ b, target }: { b: Extract<Block, { kind: "table" }>; target: ViewTarget | null }) {
  const width = Math.min(
    GRID_COLS,
    b.rows.reduce((m, r) => Math.max(m, ...cellsOf(r.segs).map((c) => c.col), 1), 1),
  );
  return (
    <div className="fv-table" data-table={b.table}>
      <h3 className="fv-no">{b.table !== undefined ? `${b.table}번째 표` : "표"}</h3>
      <div className="fv-scroll">
        <table>
          <tbody>
            {b.rows.map((r, i) => {
              const on = r.segs.some((s) => isTargetUnit(s.seq, target));
              return (
                <tr key={i} className={on ? "fv-unit" : undefined} data-row={r.row} {...unitAttrs(on)}>
                  <th scope="row" className="fv-no">
                    {r.row !== undefined ? `${r.row}행` : ""}
                  </th>
                  <RowCells segs={r.segs} target={target} letters={width} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {b.notes.map((s) => {
        const on = isTargetUnit(s.seq, target);
        return (
          <div key={s.seq} className={`fv-para fv-note${on ? " fv-unit" : ""}`} {...unitAttrs(on)}>
            <span className="fv-no">{locatorLabel(s.locator)}</span>
            <p className="fv-text">
              <Text seg={s} target={target} />
            </p>
          </div>
        );
      })}
    </div>
  );
}

function SheetView({ b, target }: { b: Extract<Block, { kind: "sheet" }>; target: ViewTarget | null }) {
  const width = b.rows.reduce((m, r) => Math.max(m, ...cellsOf([r.seg]).map((c) => c.col), 1), 1);
  const letters = width <= GRID_COLS ? width : undefined;
  return (
    <div className="fv-table fv-sheet">
      <h3 className="fv-no">{b.sheet ?? "표"}</h3>
      <div className="fv-scroll">
        <table>
          {letters && (
            <thead>
              <tr>
                <th />
                {Array.from({ length: letters }, (_, i) => (
                  <th key={i} scope="col" className="fv-no">
                    {colName(i + 1)}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {b.rows.map((r) => {
              const on = isTargetUnit(r.seg.seq, target);
              return (
                <tr
                  key={r.seg.seq}
                  className={on ? "fv-unit" : undefined}
                  data-row={r.row}
                  {...unitAttrs(on)}
                >
                  <th scope="row" className="fv-no">
                    {r.row}
                  </th>
                  <RowCells segs={[r.seg]} target={target} {...(letters ? { letters } : {})} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
