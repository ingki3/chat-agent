import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { skillToolName } from "@agentlee/mcp-tools";
import { OUR_TOOL_PREFIX } from "../runtime/lockdown.js";

/**
 * System instructions (#20, PRD NFR 프롬프트 주입·청소년, FR-5.4·5.5, FR-7.6·7.8). One runtime-independent
 * assembly: the run manager builds the text per run and hands it to every adapter as `StartContext.systemPrompt`,
 * so Claude Code and Codex get exactly the same instructions.
 *
 * Templates are versioned Markdown files in `apps/server/instructions/` (docs/ops.md: how to change them).
 */

/** Same path from src/ and dist/ (both one level below apps/server/). */
export const INSTRUCTIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../instructions",
);

export const SECTION_IDS = ["common", "finance", "youth", "research"] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export type Template = { id: SectionId; version: number; body: string };
export type Templates = Record<SectionId, Template>;

/** Who the run is for — only what the instructions depend on. */
export type InstructionUser = { youth: boolean };
/** "research" = 자료 조사 모드 (FR-5.5), a per-conversation toggle. */
export type InstructionMode = "normal" | "research";

export type AssembledInstructions = {
  text: string;
  /** Template versions used, in order, e.g. `["common@1", "youth@1"]`. */
  versions: string[];
  /** SHA-256 of `text`: a runtime session is resumed only with the instructions it was started with. */
  hash: string;
};

const HEADER = /^---\nid: ([a-z]+)\nversion: ([1-9]\d*)\n---\n/;

/** Parses one template. The header is required: a template without an id and version is a deploy error. */
export function parseTemplate(source: string, file = "template"): Template {
  const src = source.replace(/\r\n/g, "\n");
  const m = HEADER.exec(src);
  if (!m) throw new Error(`instructions: ${file} has no "---\\nid: …\\nversion: …\\n---" header`);
  const id = m[1] as SectionId;
  if (!SECTION_IDS.includes(id)) throw new Error(`instructions: ${file} has an unknown id`);
  const body = src.slice(m[0].length).trim();
  if (!body) throw new Error(`instructions: ${file} is empty`);
  return { id, version: Number(m[2]), body };
}

/** Reads every section from `dir` (`<id>.md`); throws when one is missing or malformed. */
export function loadTemplates(dir = INSTRUCTIONS_DIR): Templates {
  const out: Partial<Templates> = {};
  for (const id of SECTION_IDS) {
    const file = path.join(dir, `${id}.md`);
    const t = parseTemplate(fs.readFileSync(file, "utf8"), `${id}.md`);
    if (t.id !== id) throw new Error(`instructions: ${id}.md declares id "${t.id}"`);
    out[id] = t;
  }
  return out as Templates;
}

let cached: Templates | undefined;
/** The repository templates, read once per process. */
export function defaultTemplates(): Templates {
  return (cached ??= loadTemplates());
}

/**
 * Finance skills (PRD FR-7) and any future tool named `finance_*`. Tool names may carry the runtime prefix
 * (`mcp__agentlee__`).
 */
export const FINANCE_SKILLS = [
  "kr-stock-skill",
  "us-stock-skill",
  "market-disclosure-monitor",
  "dart-investment-monitor",
] as const;
const FINANCE_TOOLS = new Set<string>(FINANCE_SKILLS.map(skillToolName));

export function isFinanceTool(name: string): boolean {
  const bare = name.startsWith(OUR_TOOL_PREFIX) ? name.slice(OUR_TOOL_PREFIX.length) : name;
  return FINANCE_TOOLS.has(bare) || bare.startsWith("finance_");
}

/** Today in Seoul as YYYY-MM-DD — the model needs it to date recent facts (FR-5.4). */
export function seoulDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * The system instructions for one run:
 * - common: always (Korean, external content is data, `cite`, dated facts, conflicting sources)
 * - finance: only when the run's tools include a finance tool
 * - youth: only for a youth account (the son)
 * - research: only in 자료 조사 모드
 * followed by today's date. Nothing else about the user (name, email) goes in.
 */
export function assembleInstructions(input: {
  user: InstructionUser;
  mode: InstructionMode;
  tools: readonly string[];
  now: Date;
  templates?: Templates;
}): AssembledInstructions {
  const t = input.templates ?? defaultTemplates();
  const sections: Template[] = [t.common];
  if (input.tools.some(isFinanceTool)) sections.push(t.finance);
  if (input.user.youth === true) sections.push(t.youth);
  if (input.mode === "research") sections.push(t.research);
  const text = [
    ...sections.map((s) => s.body),
    `## 오늘\n- 오늘 날짜는 ${seoulDate(input.now)} (Asia/Seoul)이다.`,
  ].join("\n\n");
  return {
    text,
    versions: sections.map((s) => `${s.id}@${s.version}`),
    hash: crypto.createHash("sha256").update(text).digest("hex"),
  };
}
