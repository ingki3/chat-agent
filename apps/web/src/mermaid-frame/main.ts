import mermaid from "mermaid";
import {
  CONFIG_REFUSED,
  errorText,
  FRAME_READY,
  FRAME_RENDER,
  FRAME_RESULT,
  MAX_SOURCE,
  mermaidConfig,
  type FrameResult,
} from "../chat/mermaid-config.js";

/**
 * The diagram frame's bundle (#182): runs inside `<iframe sandbox="allow-scripts" src="/mermaid-frame">` — an
 * opaque origin with no network (its CSP, apps/server/src/mermaid-frame.ts). The page's boot script ran this code
 * from the app's message and noted the app's origin. Here: answer the app's render requests, one at a time, with
 * the SVG text — measured and drawn in this frame's own DOM, never the app's.
 */
const appOrigin = (window as unknown as { __agentleeAppOrigin?: string }).__agentleeAppOrigin;
const host = document.getElementById("host") ?? document.body.appendChild(document.createElement("div"));
let busy = false;

const reply = (m: FrameResult) => parent.postMessage(m, appOrigin!);

window.addEventListener("message", (e: MessageEvent) => {
  if (!appOrigin || e.source !== parent || e.origin !== appOrigin) return;
  const d = e.data as { type?: unknown; id?: unknown; text?: unknown; dark?: unknown } | null;
  if (!d || d.type !== FRAME_RENDER || typeof d.id !== "number" || typeof d.dark !== "boolean") return;
  if (typeof d.text !== "string" || d.text.length > MAX_SOURCE || busy) return;
  const { id, text, dark } = d as { id: number; text: string; dark: boolean };
  busy = true;
  void (async () => {
    try {
      mermaid.initialize(mermaidConfig(dark));
      // mermaid's own reading of the source: any config it still finds (front matter, directives) is refused —
      // theme and security are the app's.
      const parsed = await mermaid.parse(text);
      if (parsed && Object.keys(parsed.config ?? {}).length)
        return reply({ type: FRAME_RESULT, id, error: CONFIG_REFUSED });
      const { svg } = await mermaid.render(`mmd-${id}`, text, host);
      reply({ type: FRAME_RESULT, id, svg });
    } catch (err) {
      reply({ type: FRAME_RESULT, id, error: errorText(err) });
    } finally {
      host.replaceChildren();
      document.getElementById(`dmmd-${id}`)?.remove();
      busy = false;
    }
  })();
});

if (appOrigin) parent.postMessage({ type: FRAME_READY }, appOrigin);
