import {
  FINANCE_DISCLAIMER,
  FINANCE_NOTE_MAX_SOURCES,
  FinanceSource,
  type FinanceMissing,
  type FinanceNotePart,
  type MessagePart,
} from "@agentlee/shared";
import { isFinanceTool } from "../instructions/assemble.js";

/**
 * The common finance output check (#30, PRD FR-7.6·7.8). It runs on every answer that used a finance tool — for
 * every user, in follow-up answers that go on with those numbers, and in scheduled runs (#33 starts them through the
 * same run manager) — whichever runtime wrote it:
 * - collects the sources and as-of times the tools returned (`sources` of each finance result);
 * - checks the answer: if it states numbers, does it name a source and an as-of date of those results?
 * - appends a `finance_note` part with the sources, what was missing, and the disclaimer.
 * The note is the server's, after the runtime's text: a runtime cannot leave it out or word it away.
 */

/** What the run's finance tool calls returned. */
export type FinanceEvidence = {
  /** A finance tool was called. */
  used: boolean;
  sources: FinanceSource[];
  /** A finance result came back without complete stamps (or from a tool that does not stamp). */
  toolMetaMissing: boolean;
};

/** A tool result as an object (adapters hand our JSON text through parsed; a string is parsed here). */
function asObject(output: unknown): Record<string, unknown> | undefined {
  let o = output;
  if (typeof o === "string") {
    try {
      o = JSON.parse(o) as unknown;
    } catch {
      return undefined;
    }
  }
  return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : undefined;
}

export function financeEvidence(parts: readonly MessagePart[]): FinanceEvidence {
  const calls = new Map<string, string>();
  for (const p of parts) if (p.type === "tool_call" && isFinanceTool(p.name)) calls.set(p.id, p.name);
  const sources = new Map<string, FinanceSource>();
  let toolMetaMissing = false;
  for (const p of parts) {
    if (p.type !== "tool_result" || !calls.has(p.callId) || p.isError) continue;
    const o = asObject(p.output);
    // An error answer carries no numbers.
    if (!o || typeof o.error === "string") continue;
    if (!Array.isArray(o.sources)) {
      // A finance result that does not say where its numbers come from (e.g. the kr-stock-skill fallback).
      toolMetaMissing = true;
      continue;
    }
    for (const s of o.sources) {
      const r = FinanceSource.safeParse(s);
      if (r.success) sources.set(r.data.label, r.data);
      else toolMetaMissing = true;
    }
    if (Array.isArray(o.warnings) && o.warnings.includes("finance_meta_missing")) toolMetaMissing = true;
  }
  return { used: calls.size > 0, sources: [...sources.values()], toolMetaMissing };
}

/** Names a reader would recognise for each source (the answer may say "네이버", "Yahoo", "DART"…). */
const ALIASES: [RegExp, RegExp][] = [
  [/네이버/, /네이버|naver/i],
  [/yahoo/i, /yahoo|야후/i],
  [/dart/i, /dart|다트|전자공시/i],
  [/sec|edgar/i, /\bsec\b|edgar|미국\s*증권거래위원회/i],
];

function namesSource(text: string, source: string): boolean {
  if (text.includes(source)) return true;
  return ALIASES.some(([which, alias]) => which.test(source) && alias.test(text));
}

/** The as-of date of a source written the ways an answer may write it: 2026-11-13, 2026.11.13, 11월 13일, 11/13. */
function namesDate(text: string, asOf: string): boolean {
  const [y, m, d] = asOf.slice(0, 10).split("-") as [string, string, string];
  const mm = String(Number(m));
  const dd = String(Number(d));
  const pats = [
    `${y}\\s*[-./년]\\s*0?${mm}\\s*[-./월]\\s*0?${dd}(?!\\d)`,
    `(?<!\\d)0?${mm}\\s*월\\s*0?${dd}\\s*일`,
    `(?<![\\d./-])0?${mm}[./]0?${dd}(?![\\d./])`,
  ];
  return pats.some((p) => new RegExp(p).test(text));
}

/** Numbers in prose (not just digits inside a name): at least one figure such as 206,000 / 348.51 / 3.5%. */
const HAS_FIGURE = /\d[\d,]*(\.\d+)?\s*(%|원|달러|\$|pt|포인트|배)?/;

/**
 * What an answer leaves out. Only an answer that states figures is checked: it must name at least one of the
 * sources and at least one of their as-of dates.
 */
export function checkAnswer(text: string, sources: readonly FinanceSource[]): FinanceMissing[] {
  if (!HAS_FIGURE.test(text)) return [];
  const missing: FinanceMissing[] = [];
  if (!sources.some((s) => namesSource(text, s.source))) missing.push("source");
  if (!sources.some((s) => namesDate(text, s.asOf))) missing.push("as_of");
  return missing;
}

/** The answer text (public text parts). */
export const answerText = (parts: readonly MessagePart[]): string =>
  parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");

/**
 * The note for an answer, or undefined when none is due:
 * - the run used a finance tool and wrote something; or
 * - a follow-up (`carried`: the note of the answer just before) that states figures.
 */
export function financeNote(
  parts: readonly MessagePart[],
  carried?: readonly FinanceSource[] | undefined,
): FinanceNotePart | undefined {
  const text = answerText(parts);
  if (!text.trim()) return undefined;
  const ev = financeEvidence(parts);
  if (!ev.used && !(carried && HAS_FIGURE.test(text))) return undefined;
  const sources = ev.used ? ev.sources : [...(carried ?? [])];
  const missing = checkAnswer(text, sources);
  if (ev.toolMetaMissing) missing.push("tool_meta");
  return {
    type: "finance_note",
    sources: sources.slice(0, FINANCE_NOTE_MAX_SOURCES),
    missing,
    disclaimer: FINANCE_DISCLAIMER,
  };
}

/** The sources of the latest assistant answer's note, if it had one (what a follow-up goes on from). */
export function carriedSources(
  history: readonly { role: string; parts: unknown }[],
): FinanceSource[] | undefined {
  const last = [...history].reverse().find((m) => m.role === "assistant");
  const parts = Array.isArray(last?.parts) ? (last.parts as MessagePart[]) : [];
  const note = parts.find((p): p is FinanceNotePart => p.type === "finance_note");
  return note?.sources;
}
