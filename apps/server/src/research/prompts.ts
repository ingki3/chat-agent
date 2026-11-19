import fs from "node:fs";
import path from "node:path";
import {
  CITATION_LIMITS,
  frameExternal,
  RESEARCH_LIMITS,
  ResearchScope,
  type ResearchPlan,
  type ResearchSubQuestion,
} from "@agentlee/shared";
import { INSTRUCTIONS_DIR } from "../instructions/assemble.js";
import type { ResearchNote } from "./store.js";

/**
 * 깊이 조사's step prompts (#211): versioned Markdown in `apps/server/instructions/deep-research/` with the same header
 * as the system instructions (`---\nid: …\nversion: …\n---`). Each step's system prompt is the run's usual
 * instructions (common, youth, research mode, AGENT.md — `assembleInstructions`) followed by the step's template; the
 * turn text says what to work on. The ideas (lead / sub-researcher split, query types, tool budget, notes, a citation
 * pass) are adapted from Anthropic's published research prompts (anthropics/claude-cookbooks, patterns/agents/prompts,
 * MIT) — the text is our own (docs/decisions/deep-research.md).
 */

export const RESEARCH_PROMPT_IDS = ["plan", "subagent", "reflect", "writer"] as const;
export type ResearchPromptId = (typeof RESEARCH_PROMPT_IDS)[number];
export type ResearchPrompt = { id: ResearchPromptId; version: number; body: string };
export type ResearchPrompts = Record<ResearchPromptId, ResearchPrompt>;

export const RESEARCH_PROMPTS_DIR = path.join(INSTRUCTIONS_DIR, "deep-research");

const HEADER = /^---\nid: ([a-z]+)\nversion: ([1-9]\d*)\n---\n/;

export function parseResearchPrompt(source: string, file = "prompt"): ResearchPrompt {
  const src = source.replace(/\r\n/g, "\n");
  const m = HEADER.exec(src);
  if (!m) throw new Error(`deep-research: ${file} has no "---\\nid: …\\nversion: …\\n---" header`);
  const id = m[1] as ResearchPromptId;
  if (!RESEARCH_PROMPT_IDS.includes(id)) throw new Error(`deep-research: ${file} has an unknown id`);
  const body = src.slice(m[0].length).trim();
  if (!body) throw new Error(`deep-research: ${file} is empty`);
  return { id, version: Number(m[2]), body };
}

/** Reads every prompt (`<id>.md`); throws when one is missing or malformed — at start-up, not at the first job. */
export function loadResearchPrompts(dir = RESEARCH_PROMPTS_DIR): ResearchPrompts {
  const out: Partial<ResearchPrompts> = {};
  for (const id of RESEARCH_PROMPT_IDS) {
    const p = parseResearchPrompt(fs.readFileSync(path.join(dir, `${id}.md`), "utf8"), `${id}.md`);
    if (p.id !== id) throw new Error(`deep-research: ${id}.md declares id "${p.id}"`);
    out[id] = p;
  }
  return out as ResearchPrompts;
}

let cached: ResearchPrompts | undefined;
export const defaultResearchPrompts = () => (cached ??= loadResearchPrompts());

/** The step's template with its numbers filled in. */
export function stepPrompt(p: ResearchPrompts, id: ResearchPromptId): string {
  return p[id].body
    .replaceAll("{{toolCalls}}", String(RESEARCH_LIMITS.subagentToolCalls))
    .replaceAll("{{notes}}", String(RESEARCH_LIMITS.notesPerQuestion))
    .replaceAll("{{gaps}}", String(RESEARCH_LIMITS.maxGapQuestions));
}

/** The first line of every turn: what the step is (the FakeRuntime's scripts match it too). */
export const TURN_MARK = {
  plan: "[깊이 조사 · 계획]",
  subagent: "[깊이 조사 · 조사]",
  reflect: "[깊이 조사 · 보강]",
  writer: "[깊이 조사 · 작성]",
} as const;

export type AttachedFile = { id: string; name: string };

const fileLines = (files: readonly AttachedFile[]) =>
  files.length
    ? files.map((f) => `- ${f.name.replace(/[\r\n[\]<>]/g, " ").slice(0, 80)} (fileId: ${f.id})`).join("\n")
    : "- (첨부 파일 없음)";

export function planTurn(input: {
  question: string;
  files: readonly AttachedFile[];
  clarify?: { question: string; answer: string } | null;
}): string {
  return [
    TURN_MARK.plan,
    `질문: ${input.question}`,
    ...(input.clarify
      ? [`확인 질문: ${input.clarify.question}`, `사용자의 답: ${input.clarify.answer} (다시 묻지 않는다)`]
      : []),
    `첨부 파일:\n${fileLines(input.files)}`,
  ].join("\n\n");
}

export function subagentTurn(input: {
  question: string;
  plan: ResearchPlan;
  sub: ResearchSubQuestion;
  files: readonly AttachedFile[];
}): string {
  const scope =
    input.sub.scope === "web"
      ? "웹만 (web_search · web_fetch)"
      : input.sub.scope === "files"
        ? "첨부 파일만 (file_search · file_read)"
        : "웹과 첨부 파일 (web_search · web_fetch · file_search · file_read)";
  return [
    TURN_MARK.subagent,
    `전체 질문: ${input.question}`,
    `보고서: ${input.plan.title}`,
    `맡은 하위 질문: ${input.sub.question}`,
    `범위: ${scope}`,
    ...(input.sub.scope === "web" ? [] : [`첨부 파일:\n${fileLines(input.files)}`]),
  ].join("\n\n");
}

/** Notes as the lead and the writer see them: page and file text, so inside an external-content block. */
export function notesBlock(notes: readonly ResearchNote[]): string {
  const lines = notes.map((n) =>
    JSON.stringify({
      note: n.id,
      claim: n.claim,
      quote: n.quote,
      ...(n.sourceId ? { sourceId: n.sourceId } : {}),
      ...(n.fileId ? { fileId: n.fileId } : {}),
      ...(n.page !== undefined ? { page: n.page } : {}),
      ...(n.title ? { title: n.title } : {}),
    }),
  );
  return frameExternal({ source: "research-notes", content: lines.join("\n") || "(노트 없음)" });
}

export function reflectTurn(input: {
  question: string;
  plan: ResearchPlan;
  asked: readonly string[];
  notes: readonly ResearchNote[];
  /** What the owner approved: gap questions may use only these sources. */
  scopes: readonly ("web" | "files")[];
}): string {
  const allowed =
    input.scopes.includes("web") && input.scopes.includes("files")
      ? "web, files, both"
      : input.scopes.includes("files")
        ? "files (첨부 파일만 — 웹 검색은 승인되지 않았다)"
        : "web";
  return [
    TURN_MARK.reflect,
    `질문: ${input.question}`,
    `쓸 수 있는 범위(scope): ${allowed}`,
    `이미 조사한 하위 질문:\n${input.asked.map((q) => `- ${q}`).join("\n")}`,
    `확인된 노트:\n${notesBlock(input.notes)}`,
  ].join("\n\n");
}

export function writerTurn(input: {
  question: string;
  plan: ResearchPlan;
  notes: readonly ResearchNote[];
}): string {
  return [
    TURN_MARK.writer,
    `질문: ${input.question}`,
    `보고서 제목: ${input.plan.title}`,
    `하위 질문:\n${input.plan.subQuestions.map((q) => `- ${q.question}`).join("\n")}`,
    `확인된 노트 (이것만 근거로 쓴다):\n${notesBlock(input.notes)}`,
  ].join("\n\n");
}

/** The first JSON object of a model's answer (a ```json fence or surrounding words tolerated). */
export function firstJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

const clip = (s: string, n: number) => Array.from(s.trim()).slice(0, n).join("");

/** The lead's plan answer: a plan (sub-questions cut to the limits), a clarifying question, or nothing usable. */
export function parsePlan(
  text: string,
  opts: { hasFiles: boolean; mayClarify: boolean },
): { kind: "plan"; plan: ResearchPlan } | { kind: "clarify"; question: string } | undefined {
  const v = firstJson(text) as Record<string, unknown> | undefined;
  if (!v || typeof v !== "object") return undefined;
  if (typeof v.clarify === "string" && v.clarify.trim() && opts.mayClarify && !Array.isArray(v.subQuestions))
    return { kind: "clarify", question: clip(v.clarify, RESEARCH_LIMITS.clarifyChars) };
  const subs = Array.isArray(v.subQuestions) ? v.subQuestions : [];
  const subQuestions: ResearchSubQuestion[] = [];
  for (const s of subs) {
    if (subQuestions.length >= RESEARCH_LIMITS.maxSubQuestions) break;
    const q = s && typeof s === "object" ? (s as Record<string, unknown>) : {};
    if (typeof q.question !== "string" || !q.question.trim()) continue;
    const scope = ResearchScope.safeParse(q.scope);
    const sc = scope.success ? scope.data : "web";
    subQuestions.push({
      id: `q${subQuestions.length + 1}`,
      question: clip(q.question, RESEARCH_LIMITS.subQuestionChars),
      // No attached files: the web only, whatever the lead wrote.
      scope: opts.hasFiles ? sc : "web",
    });
  }
  // 2–6 (RESEARCH_LIMITS): fewer is no plan — the lead is asked for at least two.
  if (subQuestions.length < RESEARCH_LIMITS.minSubQuestions) return undefined;
  const title = typeof v.title === "string" && v.title.trim() ? clip(v.title, 120) : "깊이 조사 보고서";
  const est = typeof v.estimateMinutes === "number" ? Math.round(v.estimateMinutes) : 15;
  return {
    kind: "plan",
    plan: {
      title,
      subQuestions,
      estimateMinutes: Math.min(30, Math.max(1, est)),
      backend: "claude",
    },
  };
}

/** The lead's gap list (at most `maxGapQuestions`; anything unusable is none). */
export function parseGaps(text: string, hasFiles: boolean): { question: string; scope: ResearchScope }[] {
  const v = firstJson(text) as Record<string, unknown> | undefined;
  const gaps = v && Array.isArray(v.gaps) ? v.gaps : [];
  const out: { question: string; scope: ResearchScope }[] = [];
  for (const g of gaps) {
    if (out.length >= RESEARCH_LIMITS.maxGapQuestions) break;
    const q = g && typeof g === "object" ? (g as Record<string, unknown>) : {};
    if (typeof q.question !== "string" || !q.question.trim()) continue;
    const scope = ResearchScope.safeParse(q.scope);
    out.push({
      question: clip(q.question, RESEARCH_LIMITS.subQuestionChars),
      scope: hasFiles && scope.success ? scope.data : "web",
    });
  }
  return out;
}

/** A sub-researcher's note as written (before the server checks its passage). */
export type RawNote = { claim: string; quote: string; sourceId?: string; fileId?: string; page?: number };

/**
 * The `NOTE {…}` lines of a sub-researcher's text — also of a turn that was stopped half-way (a line cut off is
 * dropped). At most `max` notes.
 */
export function parseNotes(text: string, max: number = RESEARCH_LIMITS.notesPerQuestion): RawNote[] {
  const out: RawNote[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (out.length >= max) break;
    const m = /^\s*(?:[-*]\s*)?NOTE\s+(\{.*\})\s*$/.exec(line);
    if (!m) continue;
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(m[1]!) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof v.claim !== "string" || typeof v.quote !== "string") continue;
    const claim = clip(v.claim, 500);
    const quote = v.quote.trim();
    // Longer than `cite` takes whole (CITATION_LIMITS.snippet): the writer could not cite it.
    if (!claim || !quote || quote.length > CITATION_LIMITS.snippet) continue;
    const sourceId = typeof v.sourceId === "string" && v.sourceId.trim() ? v.sourceId.trim() : undefined;
    const fileId =
      typeof v.fileId === "string" && v.fileId.trim() ? v.fileId.trim().replace(/^file:/, "") : undefined;
    if (!sourceId && !fileId) continue;
    const page = typeof v.page === "number" && Number.isInteger(v.page) && v.page > 0 ? v.page : undefined;
    out.push({
      claim,
      quote,
      ...(sourceId ? { sourceId } : { fileId: fileId! }),
      ...(page !== undefined && !sourceId ? { page } : {}),
    });
  }
  return out;
}
