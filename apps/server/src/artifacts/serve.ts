import crypto from "node:crypto";
import {
  ARTIFACT_ESCAPE_MESSAGE,
  type ArtifactKind,
  type ChartSeries,
  type ChartSpec,
  type TableData,
} from "@agentlee/shared";

/**
 * How an artifact version is served (#27, PRD FR-6.5, docs/decisions/isolation.md "아티팩트 서빙").
 *
 * The original (`/a/:id/v/:ver/raw`) is always sent with a CSP whose first directive is `sandbox allow-scripts`:
 * the document gets an opaque origin wherever it is opened — in the app's `<iframe sandbox="allow-scripts">` or
 * as a top-level page — so it cannot read the app's cookies, storage or DOM, and `connect-src 'none'` stops every
 * request it could make from script. Scripts: each inline `<script>` of an HTML artifact is allowed by its
 * SHA-256 (computed here, at serve time), external ones only from the exact URLs of `CDN_ALLOW_LIST`. Inline
 * event-handler attributes (`onclick=…`) and `javascript:` URLs never run (no 'unsafe-inline' / 'unsafe-hashes').
 */

/**
 * External scripts an HTML artifact may load: exact, versioned URLs (CSP path match is exact for a path that does
 * not end in "/"), each with its Subresource Integrity hash, which is added to the `<script src>` tag at serve
 * time when the tag has none. To add one, see docs/ops.md "아티팩트" (download the file, `openssl dgst -sha384`).
 */
export const CDN_ALLOW_LIST: readonly { name: string; url: string; integrity: string }[] = [
  {
    name: "Chart.js 4.4.1",
    url: "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js",
    integrity: "sha384-9nhczxUqK87bcKHh20fSQcTGD4qq5GhayNYSYWqwBkINBhOfQLg/P5HG5lF1urn4",
  },
];

/** More inline scripts than this in one document: the rest are not allowed (keeps the header bounded). */
export const MAX_SCRIPT_HASHES = 256;

export type ScriptTag = {
  /** Offsets of the opening tag `<script …>` in the document. */
  tagStart: number;
  tagEnd: number;
  attrs: Map<string, string>;
  /** Inline text (scripts without `src`), as the HTML parser hands it to the script engine. */
  text: string | undefined;
};

const WS = /[\t\n\f\r ]/;

/** Parses the attributes of a start tag from `i` (just after the tag name) to its `>`. Returns the end offset. */
function parseAttrs(html: string, i: number, attrs: Map<string, string>): number {
  const n = html.length;
  for (;;) {
    while (i < n && (WS.test(html[i]!) || html[i] === "/")) i++;
    if (i >= n) return n;
    if (html[i] === ">") return i + 1;
    let name = "";
    // The first character of a name may be "=" (HTML tokenizer); after that "=" ends it.
    do name += html[i++]!;
    while (i < n && !WS.test(html[i]!) && html[i] !== "/" && html[i] !== ">" && html[i] !== "=");
    while (i < n && WS.test(html[i]!)) i++;
    let value = "";
    if (html[i] === "=") {
      i++;
      while (i < n && WS.test(html[i]!)) i++;
      const q = html[i];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, i + 1);
        value = html.slice(i + 1, close === -1 ? n : close);
        i = close === -1 ? n : close + 1;
      } else {
        const start = i;
        while (i < n && !WS.test(html[i]!) && html[i] !== ">") i++;
        value = html.slice(start, i);
      }
    }
    const key = name.toLowerCase();
    if (!attrs.has(key)) attrs.set(key, value); // the first of duplicate attributes wins, as in the parser
  }
}

/**
 * Finds the `<script>` elements of an HTML document the way the HTML tokenizer does for the common cases: comments
 * are skipped, attributes may be quoted and contain `>`, and script text runs to the first `</script` followed by
 * whitespace, `/` or `>`. Line endings are normalised (CRLF/CR → LF) and NUL becomes U+FFFD before hashing, as the
 * parser does. Where this differs from a browser (e.g. the "double-escaped" `<!--<script>` state, `<script>` in
 * SVG or inside `<textarea>`), the computed hash simply does not match and that script is blocked — a mismatch
 * never lets anything else run.
 */
export function findScripts(html: string): ScriptTag[] {
  const out: ScriptTag[] = [];
  const re = /<!--|<script(?=[\t\n\f\r />])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[0] === "<!--") {
      const end = html.indexOf("-->", m.index + 4);
      if (end === -1) break;
      re.lastIndex = end + 3;
      continue;
    }
    const attrs = new Map<string, string>();
    const tagEnd = parseAttrs(html, m.index + 7, attrs);
    let text: string | undefined;
    const close = /<\/script[\t\n\f\r />]/gi;
    close.lastIndex = tagEnd;
    const c = close.exec(html);
    const bodyEnd = c ? c.index : html.length;
    if (!attrs.has("src")) text = normalise(html.slice(tagEnd, bodyEnd));
    out.push({ tagStart: m.index, tagEnd, attrs, text });
    re.lastIndex = c ? c.index + 8 : html.length;
  }
  return out;
}

const normalise = (s: string) => s.replace(/\r\n?/g, "\n").replace(/\0/g, "�");

const hashOf = (s: string) => `'sha256-${crypto.createHash("sha256").update(s, "utf8").digest("base64")}'`;

/** CSP of every served original. `scripts` = the `script-src` sources ('none' when empty). */
export function artifactCsp(scripts: readonly string[]): string {
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src ${scripts.length ? scripts.join(" ") : "'none'"}`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "connect-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
  ].join("; ");
}

/**
 * The second, independent policy sent with an HTML artifact. Under CSP3 a hash source also admits an *external*
 * script whose `integrity` names that hash (§ "allowing external JavaScript via hashes"), so policy A alone would
 * let `<script src="https://anywhere/x.js" integrity="sha256-<hash of an inline script>">` run. The browser
 * enforces every policy it receives; this one admits external scripts only from the exact CDN URLs, and leaves
 * inline scripts to policy A (which still demands the hash and blocks event-handler attributes).
 */
export const cdnOnlyCsp = () => `script-src 'unsafe-inline' ${CDN_ALLOW_LIST.map((c) => c.url).join(" ")}`;

/**
 * An HTML artifact ready to serve: its inline scripts' hashes and the allow-listed CDN URLs in `script-src` (policy
 * A) plus the CDN-only policy B (`cdnOnlyCsp`) — sent as two CSP headers, enforced together — and the SRI
 * `integrity` (+ `crossorigin`) added to `<script src>` tags of allow-listed URLs that have none.
 */
export function prepareHtml(html: string): { body: string; csp: readonly string[] } {
  const scripts = findScripts(html);
  const hashes = new Set<string>();
  const edits: { at: number; text: string }[] = [];
  for (const s of scripts) {
    if (s.text !== undefined) {
      if (hashes.size < MAX_SCRIPT_HASHES) hashes.add(hashOf(s.text));
      continue;
    }
    const src = (s.attrs.get("src") ?? "").trim();
    const cdn = CDN_ALLOW_LIST.find((c) => c.url === src);
    if (!cdn || s.attrs.has("integrity") || html[s.tagEnd - 1] !== ">") continue;
    // Before the tag's closing ">" (or "/>"): a value-less attribute right before it stays intact.
    let at = s.tagEnd - 1;
    if (html[at - 1] === "/") at--;
    const cross = s.attrs.has("crossorigin") ? "" : ' crossorigin="anonymous"';
    edits.push({ at, text: ` integrity="${cdn.integrity}"${cross}` });
  }
  let body = html;
  for (const e of edits.reverse()) body = body.slice(0, e.at) + e.text + body.slice(e.at);
  return {
    body,
    csp: [artifactCsp([...hashes, ...CDN_ALLOW_LIST.map((c) => c.url)]), cdnOnlyCsp()],
  };
}

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const PAGE_STYLE =
  "body{margin:0;padding:16px;font:14px/1.5 system-ui,-apple-system,'Apple SD Gothic Neo',sans-serif;color:#23211d;background:#fff}" +
  "@media (prefers-color-scheme:dark){body{color:#ecebe7;background:#1d1c1a}svg text{fill:#ecebe7}table th{background:#262522}td,th{border-color:#3a3833!important}}" +
  "h1{font-size:16px;margin:0 0 12px}table{border-collapse:collapse}th,td{border:1px solid #dedad2;padding:4px 8px;text-align:left;vertical-align:top}" +
  "th{background:#f3f1ec;position:sticky;top:0}td.n{text-align:right;font-variant-numeric:tabular-nums}";

/** A plain page around server-made markup (charts, tables, exported text). */
export const page = (title: string, inner: string) =>
  `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head><body>${inner}</body></html>`;

/** Series colours (distinct in light and dark, colour-blind friendly order). */
const COLOURS = [
  "#2f6fb0",
  "#d9822b",
  "#3d8b5a",
  "#b8423a",
  "#7b5ea7",
  "#8a6d3b",
  "#c2559c",
  "#5f6b73",
  "#a4a42a",
  "#2a9fa4",
];
/** Candles (Korean convention): rising red, falling blue. */
const UP = "#d9443a";
const DOWN = "#2f6fb0";

const fmt = (v: number) =>
  Math.abs(v) >= 1e6 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(2) : `${+v.toFixed(3)}`;
const tip = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 4 });

/** What one drawing shows: a chart's own series or one of its views, over all labels or a zoomed window. */
type Drawing = {
  type: ChartSpec["type"];
  title?: string | undefined;
  xLabel?: string | undefined;
  yLabel?: string | undefined;
  unit?: string | undefined;
  labels: readonly string[];
  series: readonly ChartSeries[];
  /** Text lines under the plot (the download carries the sources this way). */
  footer?: readonly string[];
};

/**
 * Draws one chart as an SVG document fragment (no script). Every text — title, labels, series names, tooltips,
 * footer — comes from the spec and is escaped. Tooltips are SVG `<title>`s: one hover band per label naming every
 * series' value there.
 */
function drawSvg(d: Drawing): string {
  const W = 760;
  const footer = (d.footer ?? []).map((l) => l.slice(0, 140));
  const H = 420 + footer.length * 16;
  const m = { top: d.title ? 40 : 16, right: 16, bottom: 64 + footer.length * 16, left: 72 };
  const pw = W - m.left - m.right;
  const ph = H - m.top - m.bottom;
  const vals = d.series.flatMap((s) => [
    ...s.values.filter((v): v is number => v !== null),
    ...(d.type === "candle" ? (s.ohlc ?? []).flatMap((q) => (q ? [q[1], q[2]] : [])) : []),
  ]);
  let lo: number;
  let hi: number;
  if (d.type === "bar" || !vals.length) {
    lo = Math.min(0, ...vals);
    hi = Math.max(0, ...vals);
  } else {
    lo = Math.min(...vals);
    hi = Math.max(...vals);
  }
  if (lo === hi) hi = lo + 1;
  const pad = (hi - lo) * 0.05;
  if (d.type !== "bar" || hi > 0) hi += pad;
  if (d.type !== "bar" || lo < 0) lo -= pad;
  const y = (v: number) => m.top + ph - ((v - lo) / (hi - lo)) * ph;
  const n = d.labels.length;
  const band = pw / n;
  const x = (i: number) => m.left + band * (i + 0.5);
  const unit = d.unit ? ` ${d.unit}` : "";
  const parts: string[] = [];
  if (d.title)
    parts.push(
      `<text x="${W / 2}" y="24" text-anchor="middle" font-size="16" font-weight="600">${escapeHtml(d.title)}</text>`,
    );
  // Tick labels as precise as their spacing needs (no "35.373" on a 0–40 axis).
  const digits = Math.min(4, Math.max(0, 1 - Math.floor(Math.log10((hi - lo) / 4))));
  const tick = (v: number) =>
    Math.abs(v) >= 1e9 || (Math.abs(v) < 1e-3 && v !== 0)
      ? fmt(v)
      : v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  for (let t = 0; t <= 4; t++) {
    const v = lo + ((hi - lo) * t) / 4;
    parts.push(
      `<line x1="${m.left}" x2="${W - m.right}" y1="${y(v)}" y2="${y(v)}" stroke="#8884" stroke-width="1"/>`,
      `<text x="${m.left - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11">${tick(v)}</text>`,
    );
  }
  const step = Math.ceil(n / 8);
  d.labels.forEach((l, i) => {
    if (i % step === 0)
      parts.push(
        `<text x="${x(i)}" y="${m.top + ph + 18}" text-anchor="middle" font-size="11">${escapeHtml(l.slice(0, 16))}</text>`,
      );
  });
  const k = d.series.length;
  d.series.forEach((s, si) => {
    const colour = COLOURS[si % COLOURS.length]!;
    if (d.type === "bar") {
      const bw = (band * 0.8) / k;
      s.values.forEach((v, i) => {
        if (v === null) return;
        const top = Math.min(y(v), y(0));
        const h = Math.max(Math.abs(y(v) - y(0)), 0.5);
        parts.push(
          `<rect class="bar" x="${(x(i) - band * 0.4 + bw * si).toFixed(2)}" y="${top.toFixed(2)}" width="${bw.toFixed(2)}" height="${h.toFixed(2)}" fill="${colour}"><title>${escapeHtml(`${s.name} · ${d.labels[i]}: ${tip.format(v)}${unit}`)}</title></rect>`,
        );
      });
    } else if (d.type === "candle") {
      const bw = Math.max(Math.min((band * 0.7) / k, 14), 1);
      (s.ohlc ?? []).forEach((q, i) => {
        if (!q) return;
        const [o, h, l, c] = q;
        const cx = x(i) - (band * 0.35 * (k - 1)) / Math.max(k, 1) + bw * si;
        const col = c >= o ? UP : DOWN;
        const top = Math.min(y(o), y(c));
        parts.push(
          `<line class="wick" x1="${cx.toFixed(2)}" x2="${cx.toFixed(2)}" y1="${y(h).toFixed(2)}" y2="${y(l).toFixed(2)}" stroke="${col}" stroke-width="1"/>`,
          `<rect class="candle" x="${(cx - bw / 2).toFixed(2)}" y="${top.toFixed(2)}" width="${bw.toFixed(2)}" height="${Math.max(Math.abs(y(o) - y(c)), 0.8).toFixed(2)}" fill="${col}"/>`,
        );
      });
    } else {
      const pts = s.values
        .map((v, i) => (v === null ? null : `${x(i).toFixed(2)},${y(v).toFixed(2)}`))
        .filter(Boolean)
        .join(" ");
      parts.push(`<polyline class="line" points="${pts}" fill="none" stroke="${colour}" stroke-width="2"/>`);
    }
    parts.push(
      `<rect x="${m.left + si * 130}" y="${H - 22 - footer.length * 16}" width="12" height="12" fill="${d.type === "candle" ? UP : colour}"/>`,
      `<text x="${m.left + si * 130 + 16}" y="${H - 12 - footer.length * 16}" font-size="12">${escapeHtml(s.name.slice(0, 16))}</text>`,
    );
  });
  if (lo <= 0 && hi >= 0)
    parts.push(
      `<line x1="${m.left}" x2="${W - m.right}" y1="${y(0)}" y2="${y(0)}" stroke="#888" stroke-width="1"/>`,
    );
  // Hover bands (line and candle): the date and every series' value there.
  if (d.type !== "bar")
    d.labels.forEach((l, i) => {
      const lines = d.series.flatMap((s) => {
        const q = d.type === "candle" ? s.ohlc?.[i] : undefined;
        if (q)
          return [
            `${s.name}: 시가 ${tip.format(q[0])} · 고가 ${tip.format(q[1])} · 저가 ${tip.format(q[2])} · 종가 ${tip.format(q[3])}${unit}`,
          ];
        const v = s.values[i];
        if (v === null || v === undefined) return [];
        // A candle day with a close but no open/high/low: no candle is drawn — say why (review #111).
        const none = d.type === "candle" ? " (시가·고가·저가 없음)" : "";
        return [`${s.name}: ${tip.format(v)}${unit}${none}`];
      });
      if (!lines.length) return;
      parts.push(
        `<rect class="hit" x="${(x(i) - band / 2).toFixed(2)}" y="${m.top}" width="${band.toFixed(2)}" height="${ph}" fill="#888" fill-opacity="0"><title>${escapeHtml([l, ...lines].join("\n"))}</title></rect>`,
      );
    });
  if (d.yLabel)
    parts.push(
      `<text transform="translate(14 ${m.top + ph / 2}) rotate(-90)" text-anchor="middle" font-size="12">${escapeHtml(d.yLabel)}</text>`,
    );
  if (d.xLabel)
    parts.push(
      `<text x="${m.left + pw / 2}" y="${m.top + ph + 38}" text-anchor="middle" font-size="12">${escapeHtml(d.xLabel)}</text>`,
    );
  footer.forEach((l, i) =>
    parts.push(
      `<text x="8" y="${H - 6 - (footer.length - 1 - i) * 16}" font-size="11">${escapeHtml(l)}</text>`,
    ),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${escapeHtml(d.title ?? "chart")}" font-family="system-ui,sans-serif" fill="currentColor">${parts.join("")}</svg>`;
}

/** Sources and notes as lines (finance: "출처 …", FR-7.6). */
const footerOf = (spec: ChartSpec) => [
  ...(spec.sources ?? []).map((s) => `출처 ${s}`),
  ...(spec.notes ?? []),
];

/** The chart's own series as one SVG (the download and the PNG/PDF), with its sources and notes under it. */
export function chartSvg(spec: ChartSpec): string {
  return drawSvg({ ...spec, footer: footerOf(spec) });
}

/** One series set to switch to: the chart's own (first) and its views (원화·달러 기준, #31). */
function seriesSets(spec: ChartSpec) {
  return [
    { label: spec.seriesLabel ?? "기본", yLabel: spec.yLabel, unit: spec.unit, series: spec.series },
    ...(spec.views ?? []).map((v) => ({
      label: v.label,
      yLabel: v.yLabel ?? spec.yLabel,
      unit: v.unit ?? spec.unit,
      series: v.series,
    })),
  ];
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** `ymd` minus `months` (clamped to the month's last day). */
function monthsBefore(ymd: string, months: number): string {
  const [yy, mm, dd] = ymd.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(yy, mm - 1 - months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(dd, last));
  return t.toISOString().slice(0, 10);
}

/**
 * Zoom windows of a line or candle chart (#31 "확대"): the whole range and, for long ones, the latest part — by
 * calendar months when the labels are dates (3개월, 1개월), else the latest half and quarter. A window is the same
 * values (never re-based), drawn on its own axis.
 */
export function zoomWindows(spec: ChartSpec): { label: string; start: number }[] {
  const n = spec.labels.length;
  const out = [{ label: "전체", start: 0 }];
  if (spec.type === "bar" || n < 30) return out;
  if (spec.labels.every((l) => ISO_DAY.test(l))) {
    const last = spec.labels[n - 1]!;
    for (const [months, label] of [
      [3, "3개월"],
      [1, "1개월"],
    ] as const) {
      const cut = monthsBefore(last, months);
      const start = spec.labels.findIndex((l) => l > cut);
      if (start > 0 && n - start >= 5) out.push({ label, start });
    }
  } else {
    out.push(
      { label: "최근 절반", start: Math.floor(n / 2) },
      { label: "최근 1/4", start: Math.floor((n * 3) / 4) },
    );
  }
  return out;
}

const CHART_STYLE =
  ".chart{position:relative}.chart>input{position:absolute;opacity:0;width:1px;height:1px;margin:0}" +
  ".controls{display:flex;flex-wrap:wrap;gap:8px 16px;margin:0 0 8px}.seg{display:flex;gap:4px;align-items:center}" +
  ".seg span{font-size:12px;opacity:.7;margin-right:2px}.seg label{border:1px solid #8886;border-radius:999px;padding:2px 10px;font-size:13px;cursor:pointer;user-select:none}" +
  ".cv{display:none}.hit:hover{fill-opacity:.14}" +
  ".src{margin:8px 0 0;padding-left:18px;font-size:12px}.note{margin:4px 0 0;font-size:12px;opacity:.85}";

/**
 * The chart page (served original, HTML download, exports): the drawing, a 기준 switch over the series sets and a
 * zoom switch (#31) — radio buttons and CSS only, so it needs no script (the artifact's CSP allows none but the
 * Escape bridge) and a PNG/PDF export shows the first set over the whole range — then the sources and notes.
 */
export function chartPage(title: string, spec: ChartSpec): string {
  const sets = seriesSets(spec);
  const zooms = zoomWindows(spec);
  const draw = (si: number, zi: number) => {
    const set = sets[si]!;
    const start = zooms[zi]!.start;
    return drawSvg({
      type: spec.type,
      title: spec.title,
      xLabel: spec.xLabel,
      yLabel: set.yLabel,
      unit: set.unit,
      labels: spec.labels.slice(start),
      series: set.series.map((s) => ({
        name: s.name,
        values: s.values.slice(start),
        ...(s.ohlc ? { ohlc: s.ohlc.slice(start) } : {}),
      })),
    });
  };
  const notes =
    (spec.sources?.length
      ? `<ul class="src" aria-label="출처·기준 시각">${spec.sources.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>`
      : "") + (spec.notes ?? []).map((n) => `<p class="note">${escapeHtml(n)}</p>`).join("");
  if (sets.length === 1 && zooms.length === 1) return `<style>${CHART_STYLE}</style>${draw(0, 0)}${notes}`;
  // Radios first (siblings of .controls and .views, so `:checked ~` selects), labels in .controls.
  const radio = (g: string, i: number) =>
    `<input type="radio" name="${g}" id="${g}${i}"${i === 0 ? " checked" : ""}>`;
  const seg = (g: string, aria: string, items: readonly { label: string }[]) =>
    items.length > 1
      ? `<div class="seg" role="radiogroup" aria-label="${aria}"><span>${aria}</span>${items.map((it, i) => `<label for="${g}${i}">${escapeHtml(it.label)}</label>`).join("")}</div>`
      : "";
  const css: string[] = [CHART_STYLE];
  for (const [g, items] of [
    ["cv", sets],
    ["cz", zooms],
  ] as const)
    items.forEach((_, i) =>
      css.push(
        `#${g}${i}:checked~.controls label[for=${g}${i}]{background:#2f6fb0;border-color:#2f6fb0;color:#fff}`,
        `#${g}${i}:focus-visible~.controls label[for=${g}${i}]{outline:2px solid #d9822b;outline-offset:1px}`,
      ),
    );
  const views: string[] = [];
  sets.forEach((_, si) =>
    zooms.forEach((__, zi) => {
      css.push(`#cv${si}:checked~#cz${zi}:checked~.views .v${si}.z${zi}{display:block}`);
      views.push(`<div class="cv v${si} z${zi}">${draw(si, zi)}</div>`);
    }),
  );
  return (
    `<style>${css.join("")}</style><div class="chart">` +
    sets.map((_, i) => radio("cv", i)).join("") +
    zooms.map((_, i) => radio("cz", i)).join("") +
    `<div class="controls">${seg("cv", "기준", sets)}${seg("cz", "확대", zooms)}</div>` +
    `<div class="views">${views.join("")}</div></div>${notes}`
  );
}

export function tableHtml(t: TableData): string {
  const head = t.columns.map((c) => `<th scope="col">${escapeHtml(c)}</th>`).join("");
  const rows = t.rows
    .map(
      (r) =>
        `<tr>${r.map((v) => (typeof v === "number" ? `<td class="n">${v}</td>` : `<td>${escapeHtml(v ?? "")}</td>`)).join("")}</tr>`,
    )
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

/**
 * CSV of a table (RFC 4180), with a BOM so spreadsheet apps read UTF-8 (Korean). A text cell starting with
 * `= + - @` or a tab/CR is prefixed with `'`, so a spreadsheet does not run it as a formula (CSV injection).
 */
export function tableCsv(t: TableData): string {
  const cell = (v: string | number | null) => {
    if (v === null) return "";
    let s = String(v);
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `\uFEFF${[t.columns, ...t.rows].map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

/** `csp`: the policies to send, one `Content-Security-Policy` header each (all are enforced). */
export type Served = { type: string; body: string; csp: readonly string[] };

/**
 * The one message an artifact page sends the app (#28): Escape pressed inside the sandboxed frame, so the panel can
 * close (key events in a frame never reach the parent page). Added to the HTML documents served in the app's frame
 * only — an HTML original and the server-drawn chart and table pages; not to downloads or exports — as an inline
 * script allowed by its hash (policy A for HTML; the chart and table pages allow that hash and nothing else). It
 * carries nothing but its type; the app accepts it only from the frame it shows, in exactly this shape, and only
 * closes. An artifact that handles Escape itself (`preventDefault`) keeps it.
 */
const ESCAPE_SCRIPT = `addEventListener("keydown",function(e){if(e.key==="Escape"&&!e.defaultPrevented&&window.parent!==window)window.parent.postMessage({type:"${ARTIFACT_ESCAPE_MESSAGE}"},"*")})`;
export const ESCAPE_BRIDGE = `<script>${ESCAPE_SCRIPT}</script>`;
/** The bridge's `script-src` source. */
export const ESCAPE_BRIDGE_HASH = hashOf(ESCAPE_SCRIPT);

/**
 * What `/a/:id/v/:ver/raw` sends for one version: HTML with its scripts allowed by hash, SVG as an image document
 * (scripts never allowed), chart and table drawn by the server (no script), markdown and code as plain text.
 * `document` has no original yet (#49/#22): undefined.
 */
export function serveVersion(
  kind: ArtifactKind,
  title: string,
  content: string,
  opts: { escapeBridge?: boolean } = {},
): Served | undefined {
  const none = [artifactCsp([])];
  switch (kind) {
    case "html": {
      // Appended at the end: parsed into the body, never before a doctype (no quirks mode).
      const { body, csp } = prepareHtml(opts.escapeBridge ? content + ESCAPE_BRIDGE : content);
      return { type: "text/html; charset=utf-8", body, csp };
    }
    case "svg":
      return { type: "image/svg+xml; charset=utf-8", body: content, csp: none };
    case "markdown":
    case "code":
      return { type: "text/plain; charset=utf-8", body: content, csp: none };
    // Server-drawn pages (everything in them escaped, so the bridge at the end always runs): no script, or in the
    // app's frame exactly the bridge.
    case "chart":
    case "table": {
      const body =
        kind === "chart"
          ? page(title, chartPage(title, JSON.parse(content) as ChartSpec))
          : page(title, `<h1>${escapeHtml(title)}</h1>${tableHtml(JSON.parse(content) as TableData)}`);
      return opts.escapeBridge
        ? {
            type: "text/html; charset=utf-8",
            body: body + ESCAPE_BRIDGE,
            csp: [artifactCsp([ESCAPE_BRIDGE_HASH])],
          }
        : { type: "text/html; charset=utf-8", body, csp: none };
    }
    case "document":
      return undefined;
  }
}

/** Download of one version: the original file (the stored text), CSV for a table, SVG for a chart. */
export function downloadVersion(
  kind: ArtifactKind,
  content: string,
  language: string | null,
): { type: string; body: string; ext: string } | undefined {
  switch (kind) {
    case "html":
      return { type: "text/html; charset=utf-8", body: content, ext: "html" };
    case "svg":
      return { type: "image/svg+xml; charset=utf-8", body: content, ext: "svg" };
    case "markdown":
      return { type: "text/markdown; charset=utf-8", body: content, ext: "md" };
    case "code":
      return { type: "text/plain; charset=utf-8", body: content, ext: codeExt(language) };
    case "chart":
      return {
        type: "image/svg+xml; charset=utf-8",
        body: chartSvg(JSON.parse(content) as ChartSpec),
        ext: "svg",
      };
    case "table":
      return {
        type: "text/csv; charset=utf-8",
        body: tableCsv(JSON.parse(content) as TableData),
        ext: "csv",
      };
    case "document":
      return undefined;
  }
}

const EXT: Record<string, string> = {
  python: "py",
  javascript: "js",
  typescript: "ts",
  bash: "sh",
  shell: "sh",
  ruby: "rb",
  rust: "rs",
  kotlin: "kt",
  markdown: "md",
  "c++": "cpp",
  "c#": "cs",
};
const codeExt = (l: string | null) => {
  if (!l) return "txt";
  const e = EXT[l] ?? l;
  return /^[a-z0-9]{1,10}$/.test(e) ? e : "txt";
};

/**
 * `Content-Disposition` for a download: an ASCII fallback name and the title as RFC 5987 `filename*`. Characters
 * that file systems or headers do not take are replaced.
 */
export function attachment(title: string, ext: string): string {
  const clean = title
    // A lone surrogate cannot be percent-encoded (encodeURIComponent throws): replace it.
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
    // eslint-disable-next-line no-control-regex -- control characters are not allowed in a file name
    .replace(/[\\/:*?"<>|\0-\x1f\x7f]+/g, "_");
  // Cut by code points, never inside a surrogate pair.
  const base = Array.from(clean).slice(0, 100).join("") || "artifact";
  const ascii = base.replace(/[^\x20-\x7e]/g, "_").replace(/[%;]/g, "_");
  return `attachment; filename="${ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent(`${base}.${ext}`)}`;
}
