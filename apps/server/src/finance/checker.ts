import {
  FINANCE_DISCLAIMER,
  FINANCE_NOTE_MAX_SOURCES,
  FinanceMeta,
  FinanceSource,
  financeLabel,
  type FinanceMissing,
  type FinanceNotePart,
  type MessagePart,
} from "@agentlee/shared";
import { isFinanceTool } from "../instructions/assemble.js";

/**
 * The common finance output check (#30, PRD FR-7.6·7.8). It runs on every answer that used a finance tool — for
 * every user, in follow-up answers anywhere later in a conversation that has finance results (finance/results.ts),
 * in scheduled runs (#33
 * starts them through the same run manager) and on partial answers recovered after a restart — whichever runtime
 * wrote it:
 * - collects the sources, as-of times and numbers the tools returned;
 * - checks the answer **figure by figure**: each figure needs its source and its as-of date (and, for an intraday
 *   value, the time with its zone) in the same sentence or in a sentence without figures of the same paragraph
 *   (a header or a footnote). A figure that equals a tool value must name *that* value's source and date;
 * - appends a `finance_note` part with the sources, what was missing, and the disclaimer.
 * The note is the server's, after the runtime's text: a runtime cannot leave it out or word it away.
 */

/** One number a finance tool returned, with the label of its stamp. */
export type FinanceValue = { n: number; source: FinanceSource };

/** What finance tool calls returned (one answer, or the recent conversation). */
export type FinanceEvidence = {
  /** A finance tool was called. */
  used: boolean;
  sources: FinanceSource[];
  values: FinanceValue[];
  /** Codes, tickers, names and other identifiers in the calls and results: not figures in the answer. */
  identifiers: string[];
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

const META_KEYS = new Set(["source", "asOf", "timeZone", "delayed", "kind", "unit", "label", "stale"]);
const ID_KEYS = new Set([
  "code",
  "symbol",
  "ticker",
  "cik",
  "corpCode",
  "stockCode",
  "accessionNumber",
  "receiptNo",
  "name",
  "company",
  "index",
  "exchange",
  "title",
  "form",
  "items",
  "tickers",
]);

/** Numbers of stamped records (a value record or a row) and identifiers, at any depth. */
function walkResult(x: unknown, values: FinanceValue[], ids: Set<string>, depth = 0): void {
  if (depth > 8 || !x || typeof x !== "object") return;
  if (Array.isArray(x)) {
    for (const y of x) walkResult(y, values, ids, depth + 1);
    return;
  }
  const o = x as Record<string, unknown>;
  let stamp: FinanceSource | undefined;
  if (Object.prototype.hasOwnProperty.call(o, "asOf")) {
    const m = FinanceMeta.safeParse(o);
    if (m.success) stamp = { ...m.data, label: financeLabel(m.data) };
  }
  for (const [k, v] of Object.entries(o)) {
    if (ID_KEYS.has(k)) {
      for (const s of Array.isArray(v) ? v : [v]) if (typeof s === "string" && /\d/.test(s)) ids.add(s);
      continue;
    }
    if (stamp && typeof v === "number" && Number.isFinite(v) && !META_KEYS.has(k))
      values.push({ n: v, source: stamp });
    else walkResult(v, values, ids, depth + 1);
  }
}

export function financeEvidence(parts: readonly MessagePart[]): FinanceEvidence {
  const calls = new Map<string, string>();
  const ids = new Set<string>();
  for (const p of parts)
    if (p.type === "tool_call" && isFinanceTool(p.name)) {
      calls.set(p.id, p.name);
      for (const v of Object.values(asObject(p.input) ?? {})) if (typeof v === "string") ids.add(v);
    }
  const sources = new Map<string, FinanceSource>();
  const values: FinanceValue[] = [];
  let toolMetaMissing = false;
  for (const p of parts) {
    if (p.type !== "tool_result" || !calls.has(p.callId) || p.isError) continue;
    const o = asObject(p.output);
    // An error answer carries no numbers.
    if (!o || typeof o.error === "string") continue;
    walkResult(o, values, ids);
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
  return {
    used: calls.size > 0,
    sources: [...sources.values()],
    values,
    identifiers: [...ids],
    toolMetaMissing,
  };
}

// ---- figures ----------------------------------------------------------------------------------------------

/**
 * Digits that are not figures: dates, times, years and quarters, filing forms (8-K, 10-Q, Form 4, 13F-HR, S-1),
 * index names with numbers (S&P 500, KOSPI 200), ordinals and list markers, and 6-digit codes with a leading zero.
 */
/** A unit or magnitude after a number makes it an amount, never an identifier. */
const UNIT_AFTER = String.raw`\s*(?:원|달러|불|엔|위안|유로|%|퍼센트|pt|포인트|주|배|bp|천|만|억|조|[KMBT](?![A-Za-z])|USD|KRW)`;
const NUM_END = String.raw`(?!\d|[,.]\d|${UNIT_AFTER})`;
const NUM_START = String.raw`(?<![\d,.$₩])`;
/** Words around the number in Korean ETF names. */
const ETF_WORDS = [
  "미국",
  "코리아",
  "차이나",
  "중국",
  "일본",
  "인도",
  "글로벌",
  "선진국",
  "S&P",
  "나스닥",
  "NASDAQ",
  "코스피",
  "KOSPI",
  "코스닥",
  "KOSDAQ",
  "KRX",
  "MSCI",
  "TOP",
  "선물",
  "레버리지",
  "인버스",
  "커버드콜",
  "채권",
  "국채",
  "액티브",
  "TR",
  "IT",
  "반도체",
].join("|");

const NOT_FIGURES: RegExp[] = [
  /\d{4}\s*[-./년]\s*\d{1,2}\s*[-./월]\s*\d{1,2}\s*일?/g,
  /\d{1,2}\s*월\s*\d{1,2}\s*일/g,
  /(?<![\d.,])\d{1,2}\/\d{1,2}(?![\d/])/g,
  /\d{1,2}:\d{2}(:\d{2})?/g,
  /\d{1,2}\s*시(\s*\d{1,2}\s*분)?(?![가-힣])/g,
  /\d{4}\s*년/g,
  /\d\s*분기/g,
  /\b(?:[1-4]Q\d{0,4}|Q[1-4]|FY\s*\d{2,4})\b/gi,
  /\b\d{1,2}-[A-Z]{1,2}\b/g,
  /\b[A-Z]{1,2}-\d{1,2}\b/g,
  /\b13[FDG](?:-[A-Z]{1,3})?(?:\/A)?\b/gi,
  /\bForm\s*\d+[A-Z]?\b/gi,
  /\b(?:items?|아이템)\s*\d+(?:\.\d+)?(?:\s*,\s*\d+(?:\.\d+)?)*/gi,
  // Index names with numbers — the number must end there (나스닥 10000pt is a level, not "NASDAQ 100").
  new RegExp(
    String.raw`(?:S&P\s*500|Russell\s*2000|(?:KOSPI|코스피)\s*200|(?:NASDAQ|나스닥)[-\s]*100|(?:Dow|다우)\s*30)${NUM_END}`,
    "gi",
  ),
  // Korean ETF brands carry numbers in their names (KODEX 200, TIGER 미국S&P500, KODEX 200선물인버스2X): the brand,
  // known market words, the number — which must not be an amount (no unit right after its digits: KODEX 84540원
  // is a price) — and known suffix words. Nothing else is taken with it.
  new RegExp(
    String.raw`\b(?:KODEX|TIGER|KBSTAR|RISE|ACE|SOL|HANARO|KOSEF|ARIRANG|PLUS|KIWOOM)(?:\s*(?:${ETF_WORDS}))*\s*\d+${NUM_END}(?:\s*(?:${ETF_WORDS}|\d?X))*`,
    "g",
  ),
  /\d+\s*번째/g,
  /^\s*\d+[.)]\s/gm,
  /\[\d+\]/g,
  new RegExp(String.raw`${NUM_START}0\d{5}${NUM_END}`, "g"),
];

/**
 * A number and an optional magnitude (20.6만, 1.2억, 3.5조, 1.2B, 500K). Korean compound amounts (`20만 6000원`,
 * `20만6000원`, `1억 2,300만 4,000원`) are joined into one figure in `figuresOf`.
 */
const FIGURE = /[+-]?\d[\d,]*(?:\.\d+)?(?:\s*([십백천]?[만억조]|천|[KMBT](?![A-Za-z])))?/g;
const KOREAN_PREFIX: Record<string, number> = { 십: 10, 백: 100, 천: 1000 };
/** 만 = 1e4, 천만 = 1e7, 백억 = 1e10, K = 1e3 … */
const magnitude = (u: string) => (u.length === 2 ? KOREAN_PREFIX[u[0]!]! * MAGNITUDE[u[1]!]! : MAGNITUDE[u]!);
const MAGNITUDE: Record<string, number> = {
  천: 1e3,
  만: 1e4,
  억: 1e8,
  조: 1e12,
  K: 1e3,
  M: 1e6,
  B: 1e9,
  T: 1e12,
};
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A figure: its value (magnitude applied) and how far a value may be from it and still be the same number. */
export type Figure = { n: number; tolerance: number };

/** The figures of a text, identifiers and non-figure digits taken out. */
export function figuresOf(text: string, identifiers: readonly string[] = []): Figure[] {
  let t = text;
  // Longest first, so a code inside a longer identifier goes with it. Only as a whole token, and never when an
  // amount is written: 373220원 (code 373220) or 4달러 (CIK 4) are prices, ₩373220 too.
  for (const id of [...new Set(identifiers)].sort((a, b) => b.length - a.length)) {
    if (!id.trim()) continue;
    const re = new RegExp(
      String.raw`(?<![A-Za-z0-9,.$₩])${escapeRe(id)}(?![A-Za-z0-9]|[,.]\d|${UNIT_AFTER})`,
      "g",
    );
    t = t.replace(re, " ");
  }
  for (const re of NOT_FIGURES) t = t.replace(re, " ");
  type Part = { n: number; mult: number; korean: boolean; tolerance: number; start: number; end: number };
  const parts: Part[] = [...t.matchAll(FIGURE)].flatMap((m) => {
    const digits = /[+-]?\d[\d,]*(?:\.\d+)?/.exec(m[0])![0].replace(/,/g, "");
    const base = Number(digits);
    if (!Number.isFinite(base)) return [];
    const mult = m[1] ? magnitude(m[1]) : 1;
    const decimals = digits.includes(".") ? digits.split(".")[1]!.length : 0;
    // Half a unit of the last written digit: 20.6만 covers 205,500–206,500; 206,000 only 206,000 (±0.5).
    return [
      {
        n: base * mult,
        mult,
        korean: !!m[1] && /[천만억조]/.test(m[1]),
        tolerance: 0.5 * 10 ** -decimals * mult,
        start: m.index,
        end: m.index + m[0].length,
      },
    ];
  });
  // Korean compound amounts: 조 → 억 → 만 → (천) → units, each part a smaller unit, only spaces between.
  const out: Figure[] = [];
  for (let i = 0; i < parts.length;) {
    const head = parts[i]!;
    let n = head.n;
    let last = head;
    let j = i + 1;
    while (j < parts.length) {
      const next = parts[j]!;
      const gap = t.slice(last.end, next.start);
      if (
        !last.korean ||
        !(next.korean || next.mult === 1) ||
        !/^\s*$/.test(gap) ||
        next.mult >= last.mult ||
        next.n < 0
      )
        break;
      n += next.n;
      last = next;
      j++;
    }
    // The precision is that of the last written part (20만 6000원: ±0.5).
    out.push({ n, tolerance: last.tolerance });
    i = j;
  }
  return out;
}

// ---- naming a source, a date, a time ------------------------------------------------------------------------

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

const ZONE_WORDS: Record<string, RegExp> = {
  "Asia/Seoul": /KST|한국\s*시간|서울/,
  "America/New_York": /\bE[SD]?T\b|뉴욕|미\s*동부/,
};

/** The as-of time (HH:MM) with its zone — required for an intraday value, whose time is part of the fact. */
function namesTime(text: string, asOf: string, timeZone: string): boolean {
  const hh = Number(asOf.slice(11, 13));
  const mm = asOf.slice(14, 16);
  const time = new RegExp(`(?<!\\d)0?${hh}:${mm}(?!\\d)`).test(text);
  const zone = (ZONE_WORDS[timeZone] ?? new RegExp(timeZone.replace(/[/]/g, "\\/"))).test(text);
  return time && zone;
}

const hasAsOf = (text: string, s: FinanceSource) =>
  namesDate(text, s.asOf) && (s.kind !== "intraday" || namesTime(text, s.asOf, s.timeZone));

/** Same number as written, within the precision it was written with (the sign may be said in words). */
function sameNumber(figure: Figure, v: number): boolean {
  return Math.abs(Math.abs(v) - Math.abs(figure.n)) <= figure.tolerance * (1 + 1e-9);
}

/** Paragraphs → sentences (a decimal point is not a sentence end). */
function sentences(text: string): string[][] {
  return text
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .split(/\n|(?<=[.!?。])\s+/)
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .filter((b) => b.length);
}

export type AnswerEvidence = Pick<FinanceEvidence, "sources" | "values" | "identifiers">;

/**
 * What an answer leaves out, figure by figure. A figure's context is its sentence plus the paragraph's sentences
 * without figures (a header such as "네이버 증권 · 11월 13일 종가 기준" or a footnote). A figure equal to a tool
 * value must name one of the sources that returned it, with that source's date (and time + zone if intraday);
 * any other figure (a sum, a conversion) one of the answer's sources with its date.
 */
export function checkAnswer(text: string, ev: AnswerEvidence): FinanceMissing[] {
  let noSource = false;
  let noAsOf = false;
  for (const block of sentences(text)) {
    const figs = block.map((s) => figuresOf(s, ev.identifiers));
    const shared = block.filter((_, i) => figs[i]!.length === 0).join("\n");
    block.forEach((sentence, i) => {
      if (!figs[i]!.length) return;
      const ctx = `${sentence}\n${shared}`;
      for (const f of figs[i]!) {
        const own = ev.values.filter((v) => sameNumber(f, v.n)).map((v) => v.source);
        const candidates = own.length ? own : ev.sources;
        // The source and its as-of must be one stamp's, not one value's source and another's date.
        const named = candidates.filter((s) => namesSource(ctx, s.source));
        if (!named.length) {
          noSource = true;
          if (!candidates.some((s) => hasAsOf(ctx, s))) noAsOf = true;
        } else if (!named.some((s) => hasAsOf(ctx, s))) noAsOf = true;
      }
    });
  }
  return [...(noSource ? (["source"] as const) : []), ...(noAsOf ? (["as_of"] as const) : [])];
}

/** The answer text (public text parts). */
export const answerText = (parts: readonly MessagePart[]): string =>
  parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");

/** The evidence of several answers as one (a conversation's stored finance results, oldest first). */
export function mergeEvidence(list: readonly AnswerEvidence[]): AnswerEvidence | undefined {
  if (!list.length) return undefined;
  const sources = new Map<string, FinanceSource>();
  const ids = new Set<string>();
  const values: FinanceValue[] = [];
  for (const e of list) {
    for (const x of e.sources) sources.set(x.label, x);
    for (const i of e.identifiers) ids.add(i);
    values.push(...e.values);
  }
  return { sources: [...sources.values()], values, identifiers: [...ids] };
}

/** At most this many numbers of one answer are kept for later answers' checks. */
export const MAX_STORED_VALUES = 2000;

/** What one answer's finance results leave for the rest of the conversation (stored, finance/results.ts). */
export function storedEvidence(parts: readonly MessagePart[]): AnswerEvidence | undefined {
  const ev = financeEvidence(parts);
  if (!ev.used) return undefined;
  return {
    sources: ev.sources,
    values: ev.values.slice(0, MAX_STORED_VALUES),
    identifiers: ev.identifiers.slice(0, 200),
  };
}

/**
 * The note for an answer, or undefined when none is due:
 * - the answer used a finance tool and wrote something; or
 * - finance results are anywhere earlier in the conversation (`context`) and the answer states figures.
 */
export function financeNote(
  parts: readonly MessagePart[],
  context?: AnswerEvidence | undefined,
): FinanceNotePart | undefined {
  const text = answerText(parts);
  if (!text.trim()) return undefined;
  const ev = financeEvidence(parts);
  const identifiers = [...ev.identifiers, ...(context?.identifiers ?? [])];
  if (!ev.used && !(context && figuresOf(text, identifiers).length)) return undefined;
  const all: AnswerEvidence = {
    sources: ev.used ? ev.sources : [...(context?.sources ?? [])],
    values: [...ev.values, ...(context?.values ?? [])],
    identifiers,
  };
  const missing = checkAnswer(text, all);
  if (ev.toolMetaMissing) missing.push("tool_meta");
  return {
    type: "finance_note",
    sources: all.sources.slice(0, FINANCE_NOTE_MAX_SOURCES),
    missing,
    disclaimer: FINANCE_DISCLAIMER,
  };
}
