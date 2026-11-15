import { DREAMING_MARKER } from "../dreaming/prompt.js";
import type { FakeStep } from "./fake.js";

/**
 * The FakeRuntime's answer to a 기억 정리 request (#146, e2e and local tries): deterministic decisions from the
 * messages it was given, as a real model would answer them — the server checks them like any other.
 *   "기억: …"   one line for MEMORY.md (from that message)
 *   "나: …"     one line for USER.md
 *   "/dreaming-raw <json>"   that JSON as the whole answer (to try the server's checks)
 * Anything else: nothing to change.
 */
export function dreamingSteps(text: string): FakeStep[] | undefined {
  if (!text.startsWith(DREAMING_MARKER)) return undefined;
  const json = text.slice(text.indexOf("{"));
  let data: { messages?: { id: string; text: string; docs: string[] }[] } = {};
  try {
    data = JSON.parse(json) as typeof data;
  } catch {
    return [{ text: "{}" }];
  }
  const decisions: unknown[] = [];
  for (const m of data.messages ?? []) {
    const raw = /^\/dreaming-raw\s+([\s\S]+)$/.exec(m.text.trim());
    if (raw) return [{ text: raw[1]! }, { usage: { inputTokens: 500, outputTokens: 50, costUsd: 0.001 } }];
    for (const line of m.text.split("\n")) {
      const mem = /^\s*기억:\s*(.+)$/.exec(line);
      const me = /^\s*나:\s*(.+)$/.exec(line);
      const doc = mem ? "memory" : me ? "user" : null;
      if (doc && m.docs.includes(doc))
        decisions.push({ action: "add", doc, text: (mem ?? me)![1]!.trim(), sources: [m.id] });
    }
  }
  return [
    { text: JSON.stringify({ decisions }) },
    { usage: { inputTokens: 100 + 10 * (data.messages?.length ?? 0), outputTokens: 20, costUsd: 0.0005 } },
  ];
}
