import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { CopyButton } from "./CopyButton.js";
import { DiagramFixContext } from "./diagram-fix.js";
import {
  cached,
  fixRequest,
  MAX_SOURCE,
  prepareSource,
  renderDiagram,
  type RenderResult,
  type SvgImage,
} from "./mermaid.js";

/**
 * A ```mermaid block (#182): drawn once its closing fence has arrived (while the reply streams it stays a code
 * block), shown as an image of the SVG (`<img src="blob:…">` — nothing of the SVG runs), with the source a click
 * away, copy, SVG/PNG download and a large view. The theme follows the app's (light/dark, redrawn on a switch).
 * A diagram that cannot be drawn stays a code block with a notice — and in a conversation, "다이어그램 고치기".
 */

// ---- dark mode: the app's choice (data-theme) or the system's ----
const DARK_QUERY = "(prefers-color-scheme: dark)";
function isDark(): boolean {
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "dark") return true;
  if (t === "light") return false;
  return typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches;
}
function subscribeDark(onChange: () => void) {
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const mq = typeof matchMedia === "function" ? matchMedia(DARK_QUERY) : null;
  mq?.addEventListener("change", onChange);
  return () => {
    mo.disconnect();
    mq?.removeEventListener("change", onChange);
  };
}
export const useDark = () => useSyncExternalStore(subscribeDark, isDark, () => false);

// ---- blob URLs of the images: one per SVG, released when no block shows it any more ----
const urls = new Map<string, { url: string; refs: number; timer?: ReturnType<typeof setTimeout> }>();
function urlFor(svg: string): string {
  let e = urls.get(svg);
  if (!e) {
    e = { url: URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })), refs: 0 };
    urls.set(svg, e);
    scheduleRelease(svg); // a render that is never committed leaves nothing behind
  }
  return e.url;
}
function scheduleRelease(svg: string) {
  const e = urls.get(svg);
  if (!e) return;
  clearTimeout(e.timer);
  e.timer = setTimeout(() => {
    if (e.refs > 0) return;
    URL.revokeObjectURL(e.url);
    urls.delete(svg);
  }, 1000);
}
function retain(svg: string) {
  const e = urls.get(svg);
  if (!e) return;
  e.refs++;
  clearTimeout(e.timer);
}
function release(svg: string) {
  const e = urls.get(svg);
  if (!e) return;
  e.refs--;
  if (e.refs <= 0) scheduleRelease(svg);
}
/** The blob URL showing `svg`, kept while this component is mounted. */
function useSvgUrl(svg: string): string {
  const url = urlFor(svg);
  useEffect(() => {
    retain(svg);
    return () => release(svg);
  }, [svg]);
  return url;
}

/** Saves a blob as a file (a temporary link; its object URL is released right after). */
function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const MAX_CANVAS = 8192;
/** The diagram as a PNG (twice its size, on the theme's background), drawn from the image — not from the SVG text. */
async function savePng(url: string, img: SvgImage, dark: boolean): Promise<boolean> {
  try {
    const el = new Image();
    el.src = url;
    await el.decode();
    const scale = Math.min(2, MAX_CANVAS / img.width, MAX_CANVAS / img.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.fillStyle = dark ? "#1d1c1a" : "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return false;
    saveBlob(blob, "diagram.png");
    return true;
  } catch {
    return false;
  }
}

function Zoom({ img, onClose }: { img: SvgImage; onClose: () => void }) {
  const src = useSvgUrl(img.svg);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      back?.focus?.();
    };
  }, [onClose]);
  return (
    <div
      className="mmd-zoom"
      role="dialog"
      aria-modal="true"
      aria-label="다이어그램 크게 보기"
      data-testid="mermaid-zoom"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="mmd-zoom-bar">
        <button type="button" ref={close} className="small" onClick={onClose}>
          ✕ 닫기
        </button>
      </div>
      <div className="mmd-zoom-body">
        <img
          src={src}
          alt="다이어그램 (크게)"
          width={Math.round(img.width * 1.6)}
          height={Math.round(img.height * 1.6)}
        />
      </div>
    </div>
  );
}

/** The diagram as an image: exactly one `<img>`, its source a blob URL of the SVG. */
function DiagramImage({ img, onZoom }: { img: SvgImage; onZoom: () => void }) {
  const src = useSvgUrl(img.svg);
  return (
    <button type="button" className="mmd-img" onClick={onZoom} aria-label="다이어그램 크게 보기">
      <img src={src} alt="다이어그램" width={img.width} height={img.height} data-testid="mermaid-img" />
    </button>
  );
}

type State = { text: string; dark: boolean; r: RenderResult };

export function MermaidBlock({ source, closed, code }: { source: string; closed: boolean; code: ReactNode }) {
  const dark = useDark();
  const fix = useContext(DiagramFixContext);
  const prepared = useMemo(() => prepareSource(source), [source]);
  // Only a finished block with something left to draw is drawn.
  const want = closed && prepared.ok && prepared.text ? prepared.text : null;
  const [state, setState] = useState<State | null>(() => {
    const hit = want ? cached(want, dark) : undefined;
    return want && hit ? { text: want, dark, r: hit } : null;
  });
  const [view, setView] = useState<"diagram" | "source">("diagram");
  const [zoom, setZoom] = useState(false);
  const [pngFailed, setPngFailed] = useState(false);
  const closeZoom = useCallback(() => setZoom(false), []);

  useEffect(() => {
    if (!want) return;
    const ac = new AbortController();
    // A cached result comes back on the queue's next turn; the one already shown stays until then.
    void renderDiagram(want, dark, ac.signal).then((r) => {
      if (!ac.signal.aborted && r.kind !== "aborted") setState({ text: want, dark, r });
    });
    return () => ac.abort();
  }, [want, dark]);

  // The result for this source (of either theme: on a switch the old picture stays until the new one is drawn).
  const r = state && want && state.text === want ? state.r : null;
  const current = r && state!.dark === dark;
  const img = r?.kind === "ok" ? r : null;
  const failed = current && r && r.kind !== "ok" ? r : null;

  const header = (extra: ReactNode) => (
    <div className="ch">
      <span>mermaid</span>
      <span className="mmd-tools">
        {extra}
        <CopyButton text={source} label="코드 복사" />
      </span>
    </div>
  );
  const codeBlock = <pre>{code}</pre>;

  let notice: ReactNode = null;
  if (!prepared.ok)
    notice = (
      <span>
        다이어그램이 너무 길어 그리지 않았어요 (원본 {prepared.length.toLocaleString("ko-KR")}자, 최대{" "}
        {MAX_SOURCE.toLocaleString("ko-KR")}자).
      </span>
    );
  else if (failed?.kind === "too-big") notice = <span>다이어그램이 너무 커서 보여 드리지 않았어요.</span>;
  else if (failed?.kind === "timeout")
    notice = <span>다이어그램을 그리는 데 시간이 너무 걸려 멈췄어요.</span>;
  else if (failed?.kind === "load-failed")
    notice = <span>다이어그램 도구를 불러오지 못했어요. 새로 고침 뒤에 다시 시도해 주세요.</span>;
  else if (failed?.kind === "error")
    notice = (
      <>
        <span>
          <strong>다이어그램을 그릴 수 없습니다.</strong>{" "}
          <span className="mmd-err" data-testid="mermaid-error">
            {failed.message}
          </span>
        </span>
        {fix && (
          <button
            type="button"
            className="small"
            data-testid="mermaid-fix"
            disabled={!fix.send}
            title={fix.send ? undefined : "답변이 끝난 뒤에 누를 수 있어요"}
            onClick={() => fix.send?.(fixRequest(failed.message, source))}
          >
            다이어그램 고치기
          </button>
        )}
      </>
    );

  const status = !want
    ? prepared.ok
      ? "source"
      : "limit"
    : notice
      ? failed?.kind === "error"
        ? "error"
        : "limit"
      : img
        ? view
        : "pending";

  return (
    <div
      className="codeblk mmd"
      data-testid="mermaid"
      data-state={status}
      data-theme={img ? (current ? (dark ? "dark" : "light") : "stale") : undefined}
    >
      {header(
        img ? (
          <>
            <button
              type="button"
              data-testid="mermaid-toggle"
              aria-pressed={view === "source"}
              onClick={() => setView(view === "diagram" ? "source" : "diagram")}
            >
              {view === "diagram" ? "원본 보기" : "그림 보기"}
            </button>
            <button
              type="button"
              data-testid="mermaid-save-svg"
              onClick={() => saveBlob(new Blob([img.svg], { type: "image/svg+xml" }), "diagram.svg")}
            >
              SVG 저장
            </button>
            <button
              type="button"
              data-testid="mermaid-save-png"
              onClick={() => void savePng(urlFor(img.svg), img, dark).then((ok) => setPngFailed(!ok))}
            >
              {pngFailed ? "PNG 저장 실패" : "PNG 저장"}
            </button>
            <button type="button" data-testid="mermaid-zoom-open" onClick={() => setZoom(true)}>
              크게 보기
            </button>
          </>
        ) : want && !notice ? (
          <span className="muted">그리는 중…</span>
        ) : null,
      )}
      {img && view === "diagram" ? (
        <div className={`mmd-view${dark ? " dark" : ""}`}>
          <DiagramImage img={img} onZoom={() => setZoom(true)} />
        </div>
      ) : (
        codeBlock
      )}
      {notice && (
        <div className="notice warn fx small mmd-notice" role="status" data-testid="mermaid-notice">
          {notice}
        </div>
      )}
      {zoom && img && <Zoom img={img} onClose={closeZoom} />}
    </div>
  );
}
