import type { FakeStep } from "./fake.js";

/**
 * Runtime switch scenarios (#53, FR-3.5): after a switch the new runtime goes on with the conversation's files,
 * sources and artifacts by the ids it was told in its start context (`renderPriorContext` — the conversation
 * references), never by ids it was given otherwise. Used by the FakeRuntime (FAKE_RUNTIME=1 — the e2e run) and by
 * the Claude and Codex replay tests, so the same scenario goes through every runtime.
 *
 * `readReferences` reads the ids back from the rendered text the way a model would; the commands refer to them as
 * `"$refs.<kind>.<i>"` (fake-citations.ts `resolveRefs`).
 */
export type ReadReferences = {
  file: string[];
  artifact: string[];
  source: string[];
  /** The URL of each source, in the same order. */
  sourceUrl: string[];
};

/** The ids (and source URLs) in a session's start context, in the order they are listed. */
export function readReferences(prior: string): ReadReferences {
  const out: ReadReferences = { file: [], artifact: [], source: [], sourceUrl: [] };
  const block = /<conversation_references>([\s\S]*?)<\/conversation_references>/.exec(prior)?.[1] ?? "";
  for (const line of block.split("\n")) {
    const f = /^- .* \(file:([\w-]+), \w+\)$/.exec(line);
    if (f) out.file.push(f[1]!);
    const a = /^- .* \(artifact:([\w-]+)\)$/.exec(line);
    if (a) out.artifact.push(a[1]!);
    const s = /^- .* — (\S+) \(source:([\w-]+)\)$/.exec(line);
    if (s) {
      out.sourceUrl.push(s[1]!);
      out.source.push(s[2]!);
    }
  }
  return out;
}

export type SwitchCall = { tool: string; input: Record<string, unknown> };
export type SwitchScenario = { calls: SwitchCall[]; answer: string };

/**
 * The commands (the message text):
 *   /ref-file-cite <i> <snippet>     `file_cite` of the i-th referenced file
 *   /ref-cite <i> <snippet>          `cite` of the i-th referenced source (its stored text)
 *   /ref-refetch-cite <i> <snippet>  `web_fetch` of the i-th referenced source's URL, then `cite` of the new source
 *                                    (a fork's source has no stored text, #52)
 *   /ref-artifact-update <i>         (next lines: the new content) `artifact_read` of the i-th referenced artifact,
 *                                    then `artifact_update` with the new content
 */
export function switchScenario(t: string): SwitchScenario | undefined {
  const nl = t.indexOf("\n");
  const head = nl === -1 ? t : t.slice(0, nl);
  const body = nl === -1 ? "" : t.slice(nl + 1);
  const m = /^\/ref-(file-cite|cite|refetch-cite)\s+(\d+)\s+([\s\S]+)$/.exec(t);
  if (m) {
    const i = m[2]!;
    const snippet = m[3]!.trim();
    if (m[1] === "file-cite")
      return {
        calls: [{ tool: "file_cite", input: { fileId: `$refs.file.${i}`, snippet } }],
        answer: "앞에서 올린 파일에 그렇게 나와요[1].",
      };
    if (m[1] === "cite")
      return {
        calls: [{ tool: "cite", input: { sourceId: `$refs.source.${i}`, snippet } }],
        answer: "앞에서 인용한 자료에 그렇게 나와요[1].",
      };
    return {
      calls: [
        { tool: "web_fetch", input: { url: `$refs.sourceUrl.${i}` } },
        { tool: "cite", input: { sourceId: "$0.sourceId", snippet } },
      ],
      answer: "그 자료를 다시 읽어 보니 그렇게 나와요[1].",
    };
  }
  const a = /^\/ref-artifact-update\s+(\d+)$/.exec(head);
  if (a && body)
    return {
      calls: [
        { tool: "artifact_read", input: { artifactId: `$refs.artifact.${a[1]!}` } },
        { tool: "artifact_update", input: { artifactId: `$refs.artifact.${a[1]!}`, content: body } },
      ],
      answer: "읽어 보고 새 버전으로 고쳤어요.",
    };
  return undefined;
}

/** The FakeRuntime's steps of a switch command, or undefined. */
export function switchSteps(t: string): FakeStep[] | undefined {
  const sc = switchScenario(t.trim());
  return sc && [...sc.calls.map((c) => ({ call: c.tool, input: c.input })), { text: sc.answer }];
}
