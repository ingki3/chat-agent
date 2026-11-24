import { ACTIVITY_LABEL, ResearchActivity } from "@agentlee/shared";
import { OUR_TOOL_PREFIX } from "../runtime/lockdown.js";

/**
 * A sub-researcher's tool call as the 깊이 조사 card shows it (#232): a fixed phrase and a count — nothing of the
 * call's input or output, the model's words, a page or a file (no query, title, file name, URL or host; the user's
 * decision in review). Every label is one of `ACTIVITY_LABEL`.
 */

/** Every label there is (the shared schema's): fixed text and an integer. */
export { ACTIVITY_LABEL };

/** An activity as the engine keeps it (memory only). */
export type LiveActivity = ResearchActivity;

/** How many of each a step has made so far (its own; counted by the engine). */
export type StepCounts = { search: number; fetch: number };

const nth = (n: number) => Math.min(999_999_999, Math.max(1, Math.floor(Number.isFinite(n) ? n : 1)));

/**
 * The activity of one tool call — undefined for a tool that is not a step of finding things (`cite`, a note): those
 * count as activity (the time) without a line of their own.
 */
export function activityOf(name: string, at: number, counts: StepCounts): ResearchActivity | undefined {
  const tool = name.startsWith(OUR_TOOL_PREFIX) ? name.slice(OUR_TOOL_PREFIX.length) : name;
  switch (tool) {
    case "web_search":
      return { kind: "search", label: `검색 중 · ${nth(counts.search)}번째 검색`, at };
    case "web_fetch":
      return { kind: "fetch", label: `페이지 읽는 중 · ${nth(counts.fetch)}번째 페이지`, at };
    case "web_find":
      return { kind: "find", label: "페이지에서 찾는 중", at };
    case "file_search":
      return { kind: "file", label: "파일 검색 중", at };
    default:
      return tool.startsWith("file_") && tool !== "file_cite"
        ? { kind: "file", label: "파일 읽는 중", at }
        : undefined;
  }
}

/** What goes out: a valid activity, or none (one that is not never breaks the job it is part of). */
export function activityView(a: unknown): ResearchActivity | null {
  const r = ResearchActivity.safeParse(a);
  return r.success ? r.data : null;
}
