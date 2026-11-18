import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";

/**
 * The diagram frame (#182): the page `<iframe sandbox="allow-scripts" src="/mermaid-frame">` loads to run mermaid
 * away from the app's document. It holds no data and needs no login (the trust boundary and the code gate still
 * apply). Its own CSP — the app's CSP is not used here:
 *
 * - `sandbox allow-scripts`: an opaque origin even if opened outside the iframe — no cookies, storage or DOM of
 *   the app;
 * - no network: `default-src 'none'`, `connect-src 'none'`, `img-src data: blob:`, `font-src 'none'`, no frames,
 *   workers, forms or `<base>`; only our pages may frame it;
 * - scripts: this page's boot script (by hash) and `blob:` — the boot script runs the bundle the app posts in as a
 *   blob. A second policy admits no external script at all: under CSP3 a hash also admits an external script whose
 *   `integrity` names it (the artifact originals' reason for two policies, docs/decisions/isolation.md #27).
 *
 * The boot script takes the bundle only from its parent window (another frame of the page cannot post it) and
 * notes the parent's origin, which the bundle answers to.
 */
export const MERMAID_FRAME_PATH = "/mermaid-frame";

const BOOT = `(function(){var started=false;addEventListener("message",function(e){if(started||e.source!==parent)return;var d=e.data;if(!d||d.type!=="agentlee:mermaid-code"||typeof d.code!=="string")return;started=true;window.__agentleeAppOrigin=e.origin;var s=document.createElement("script");s.src=URL.createObjectURL(new Blob([d.code],{type:"text/javascript"}));document.head.appendChild(s);});parent.postMessage({type:"agentlee:mermaid-boot"},"*");})();`;

const hash = `'sha256-${crypto.createHash("sha256").update(BOOT, "utf8").digest("base64")}'`;

export const MERMAID_FRAME_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>diagram</title></head><body><div id="host"></div><script>${BOOT}</script></body></html>`;

export const MERMAID_FRAME_CSP: readonly string[] = [
  [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src ${hash} blob:`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join("; "),
  "script-src 'unsafe-inline' blob:",
];

export function registerMermaidFrame(app: FastifyInstance) {
  app.get(
    MERMAID_FRAME_PATH,
    { config: { auth: "public", noResource: "static diagram frame page (no data)" } },
    async (_req, reply) =>
      reply
        .type("text/html; charset=utf-8")
        .header("Content-Security-Policy", [...MERMAID_FRAME_CSP])
        .header("Cache-Control", "no-cache")
        .header("Cross-Origin-Resource-Policy", "same-origin")
        .header(
          "Permissions-Policy",
          "camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=()",
        )
        .send(MERMAID_FRAME_HTML),
  );
}
