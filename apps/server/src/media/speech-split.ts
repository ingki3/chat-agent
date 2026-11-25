/**
 * Long scripts for `speech_generate` (#248): the production TTS model (`elevenlabs/eleven-v4` through OpenRouter)
 * stops its audio at about 290 s **without an error**. So a text is cut into pieces at paragraph and sentence
 * boundaries, each estimated at most `targetSeconds` long at a slow reading rate, synthesized one by one with the same
 * model, voice and instructions, measured (decoded by ffmpeg) and joined into one MP3 (`speech-audio.ts`).
 *
 * The estimate is a reading-rate model, not a promise: Hangul (and other CJK) characters at a syllable rate, digits
 * at a slower rate (a number is read as several syllables), everything else (Latin letters, spaces, punctuation) at
 * a character rate, plus a pause per sentence end. Two rates: **slow** sizes the pieces (a piece read that slowly
 * still ends well before the provider's cut), **typical** is what a measured piece is compared with (much shorter
 * than that = cut short). All of it is tunable here.
 */
export const SPEECH_SPLIT = {
  /** The longest a piece may be estimated at (slow rate), seconds — well under the provider's silent cut. */
  targetSeconds: 240,
  /** Where the production model stops without an error (observed on eleven-v4). */
  providerCutSeconds: 290,
  /** A piece measured this long or longer is taken as stopped by the provider (its estimate is ≤ the target). */
  nearCutSeconds: 280,
  /** A piece measured shorter than this share of its typical-rate estimate is taken as cut short… */
  shortRatio: 0.5,
  /** …but only when that estimate is at least this long (a short text's length varies too much to judge). */
  shortCheckMinSeconds: 20,
  /** Slow (sizing) and typical (checking) rates: Hangul·CJK syllables, digits, other characters per second. */
  slow: { syllables: 4.5, digits: 3, chars: 11, sentencePause: 0.4 },
  typical: { syllables: 6.5, digits: 4.5, chars: 15, sentencePause: 0.25 },
  /**
   * The longest a piece's decoded audio may be (#251 re-plans 3–5): an answer whose decoded samples are longer than
   * this is abnormal (no file, no retry, its cost recorded); the decode stops writing a little past it (`-fs`).
   */
  pieceMaxSeconds: 600,
  /** Pieces of one call at most, as first split; more is `media_too_long` (nothing is sent). */
  maxPieces: 16,
  /**
   * Paid requests of one call at most, re-split pieces included: a retry that would pass it is not made (the call
   * ends with `media_truncated`, the cost so far recorded).
   */
  maxRequests: 20,
} as const;

export type SpeechSplitLimits = {
  targetSeconds: number;
  providerCutSeconds: number;
  nearCutSeconds: number;
  shortRatio: number;
  shortCheckMinSeconds: number;
  slow: Rates;
  typical: Rates;
  maxPieces: number;
  maxRequests: number;
  pieceMaxSeconds: number;
};
type Rates = { syllables: number; digits: number; chars: number; sentencePause: number };

/** Hangul syllables and jamo, CJK ideographs, kana: one spoken syllable each. */
const SYLLABLE = /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-䶿一-鿿가-힣豈-﫿]/u;
const DIGIT = /\p{Nd}/u;
/** A sentence ends here: terminal punctuation (with closing quotes/brackets) or a line break. */
const SENTENCE_END = /[.!?。！？…]+["'”’)\]」』]*|\n/gu;
const CLOSE = String.raw`["'”’)\]」』]*`;
/**
 * Where a sentence (unit) ends: terminal punctuation and its closers followed by whitespace — or, typed without a
 * space ("했어요.그리고"), followed by a Hangul, CJK or kana letter or a capital; full-width terminals (。！？)
 * anywhere; a line break with the whitespace after it. A decimal point ("3.14") is not an end, nor a period of an
 * address, of dotted initials or of a title (`sentenceEnd`).
 */
const SENTENCE = new RegExp(
  String.raw`(?:[.!?…]+${CLOSE}(?:\s+|(?=[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Lu}]))|[。！？]+${CLOSE}\s*|\n\s*)`,
  "gu",
);
/** Titles that end in a period without ending a sentence ("Dr. Smith"), compared without case. */
const HONORIFICS = new Set([
  "mr",
  "mrs",
  "ms",
  "mx",
  "dr",
  "prof",
  "sr",
  "jr",
  "st",
  "mt",
  "no",
  "vs",
  "etc",
  "e.g",
  "i.e",
  "inc",
  "ltd",
  "co",
  "corp",
  "gen",
  "gov",
  "sen",
  "rep",
  "rev",
  "capt",
  "lt",
  "col",
  "sgt",
  "fig",
  "vol",
  "p",
  "pp",
]);
/** Dotted initials before the period: "U.S", "J.R.R", "A" (a single letter). */
const INITIALS = /^(?:\p{L}\.)*\p{L}$/u;
/** A web address or mail address around the period: "https://www.example", "www.example", "a@b". */
const ADDRESS = /:\/\/|^www\.|@/iu;

/**
 * Whether a period match is a sentence end (#251 r2): not when the word before it is a web or mail address, dotted
 * initials or a common title — "U.S. Army", "U.S.A.", "Dr. Smith", "https://www.Example.COM/path" stay together.
 * Other terminals (! ? … 。 line breaks) always end a sentence.
 */
function sentenceEnd(text: string, at: number, match: string): boolean {
  if (!match.startsWith(".") || match.startsWith("..")) return true;
  // A line break after the period ends the line whatever the word was ("…https://example.com.\n", #251 r4).
  if (/\n/u.test(match)) return true;
  let from = at;
  while (from > 0 && !/\s/u.test(text[from - 1]!)) from--;
  const word = text.slice(from, at);
  if (!word) return true;
  if (ADDRESS.test(word)) return false;
  // The rest of the same token right after the period (no space between — a word after whitespace is the next
  // sentence's, #251 r3): an address goes on ("Example.COM/path").
  if (!/\s$/u.test(match)) {
    const rest = /^\S*/u.exec(text.slice(at + match.length))![0];
    if (/[/@]|\.\p{L}/u.test(rest)) return false;
  }
  if (INITIALS.test(word)) return false;
  return !HONORIFICS.has(word.toLowerCase().replace(/^["'“‘([]+/u, ""));
}

const CLAUSE = /[,;:，、；：]\s*/gu;
/**
 * Whether a clause mark is a place to cut (#251 r4): a full-width one (，、；：) always; an ASCII one (, ; :) only
 * with whitespace after it — never inside a token such as an address ("https://…") or a number ("3,000").
 */
const clauseEnd = (_start: number, match: string): boolean => !/^[,;:]$/u.test(match);

/** A paragraph break: a line break, blank line(s), and the whitespace after them. */
const PARAGRAPH = /\n[^\S\n]*\n\s*/gu;
const SPACE = /\s+/gu;

/** Seconds of speech this text is estimated at, at these rates. */
export function speechSeconds(text: string, rates: Rates): number {
  // Counted per class as integers and divided once per class (#251 r5: adding 1/15 three hundred times gives
  // 19.99999999999995, not 20 — and a threshold compare then goes the wrong way).
  let syllables = 0;
  let digits = 0;
  let chars = 0;
  for (const ch of text) {
    if (SYLLABLE.test(ch)) syllables++;
    else if (DIGIT.test(ch)) digits++;
    else chars++;
  }
  const ends = text.match(SENTENCE_END)?.length ?? 0;
  // In whole microseconds (#251 r6: 52/6.5 + 39/4.5 + 50/15 adds up to 19.999999999999996): every comparison
  // with a limit is then between whole microseconds.
  const total =
    syllables / rates.syllables + digits / rates.digits + chars / rates.chars + ends * rates.sentencePause;
  return Math.round(total * 1_000_000) / 1_000_000;
}

/** Seconds as whole microseconds (the unit limits are compared in). */
const micros = (seconds: number): number => Math.round(seconds * 1_000_000);

/** A part of the source text: `[start, end)` in UTF-16 offsets. */
export type Span = { start: number; end: number };

/** The ends of the text's grapheme clusters (user-perceived characters): the only places a cut may go. */
function graphemeEnds(text: string): number[] {
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const out: number[] = [];
  for (const g of seg.segment(text)) out.push(g.index + g.segment.length);
  return out;
}

/**
 * The span cut after every match of `re` that ends on a grapheme boundary (each part keeps its separator) and that
 * `accept` takes (given the match's start in the text and its text).
 */
function cutAfter(
  text: string,
  span: Span,
  re: RegExp,
  ok: ReadonlySet<number>,
  accept: (start: number, match: string) => boolean = () => true,
): Span[] {
  const out: Span[] = [];
  let at = span.start;
  for (const m of text.slice(span.start, span.end).matchAll(re)) {
    const end = span.start + m.index + m[0].length;
    if (end > at && end < span.end && ok.has(end) && accept(span.start + m.index, m[0])) {
      out.push({ start: at, end });
      at = end;
    }
  }
  if (at < span.end) out.push({ start: at, end: span.end });
  return out;
}

/** A run without any boundary, cut into parts of at most `target` — between grapheme clusters only. */
function hardCut(text: string, span: Span, target: number, rates: Rates, ends: readonly number[]): Span[] {
  const out: Span[] = [];
  let start = span.start;
  let prev = span.start;
  for (const end of ends) {
    if (end <= span.start || end > span.end) continue;
    if (prev > start && speechSeconds(text.slice(start, end), rates) > target) {
      out.push({ start, end: prev });
      start = prev;
    }
    prev = end;
  }
  if (start < span.end) out.push({ start, end: span.end });
  return out;
}

/**
 * The text's units, in order and covering it whole: sentences (paragraph breaks are line breaks), each keeping its
 * trailing whitespace. A unit estimated over `target` is cut further: at clause marks (, ; : 、), then at
 * whitespace, and last — a run without any — between grapheme clusters (never inside a surrogate pair, a combining
 * mark or a ZWJ emoji).
 */
function units(text: string, target: number, rates: Rates): Span[] {
  const ends = graphemeEnds(text);
  const ok = new Set(ends);
  // Measured as sent: a span's edge whitespace is trimmed off before it goes to the model.
  const fits = (sp: Span) => speechSeconds(text.slice(sp.start, sp.end).trim(), rates) <= target;
  const out: Span[] = [];
  const isEnd = (start: number, match: string) => sentenceEnd(text, start, match);
  // Paragraphs (a blank line) first, unconditionally (#251 r4): no sentence rule can join two paragraphs.
  const paragraphs = cutAfter(text, { start: 0, end: text.length }, PARAGRAPH, ok);
  const sentences = paragraphs.flatMap((pa) => cutAfter(text, pa, SENTENCE, ok, isEnd));
  for (const s of sentences) {
    if (fits(s)) {
      out.push(s);
      continue;
    }
    for (const c of cutAfter(text, s, CLAUSE, ok, clauseEnd)) {
      if (fits(c)) {
        out.push(c);
        continue;
      }
      for (const w of cutAfter(text, c, SPACE, ok))
        out.push(...(fits(w) ? [w] : hardCut(text, w, target, rates, ends)));
    }
  }
  return out;
}

/**
 * The text as spans to synthesize, in order, covering the text **whole** (no character lost or repeated): units
 * packed greedily while a span's slow estimate stays within `target` (default `targetSeconds`).
 */
export function splitSpans(text: string, limits: SpeechSplitLimits = SPEECH_SPLIT, target?: number): Span[] {
  const t = target ?? limits.targetSeconds;
  if (speechSeconds(text, limits.slow) <= t) return [{ start: 0, end: text.length }];
  const spans: Span[] = [];
  let cur: Span | undefined;
  for (const u of units(text, t, limits.slow)) {
    if (cur && speechSeconds(text.slice(cur.start, u.end).trim(), limits.slow) > t) {
      spans.push(cur);
      cur = undefined;
    }
    cur = cur ? { start: cur.start, end: u.end } : { ...u };
  }
  if (cur) spans.push(cur);
  return spans;
}

/**
 * The text as the pieces sent to the TTS model: its spans (`splitSpans`) with the whitespace at their edges
 * trimmed (the model gets no leading or trailing blanks) and blank ones dropped. A text that fits is one piece —
 * **exactly** the text (as before #248).
 */
export function splitSpeech(
  text: string,
  limits: SpeechSplitLimits = SPEECH_SPLIT,
  target?: number,
): string[] {
  const spans = splitSpans(text, limits, target);
  if (spans.length === 1) return [text];
  return spans.map((sp) => text.slice(sp.start, sp.end).trim()).filter((p) => p.length > 0);
}

/**
 * A piece that came back cut, as smaller pieces for its one retry: split again at half its own estimate (so a
 * piece of any length gives at least two when it has two characters). Fewer than two pieces: none (it cannot be
 * made smaller).
 */
export function resplitSpeech(piece: string, limits: SpeechSplitLimits = SPEECH_SPLIT): string[] {
  const est = speechSeconds(piece, limits.slow);
  const parts = splitSpeech(piece, limits, Math.min(limits.targetSeconds, est) / 2);
  return parts.length >= 2 ? parts : [];
}

/**
 * Whether a piece's measured length says the provider cut it: at (or past) the near-cut mark, or much shorter
 * than its typical-rate estimate (for pieces long enough to judge).
 */
export function looksCut(piece: string, seconds: number, limits: SpeechSplitLimits = SPEECH_SPLIT): boolean {
  if (!Number.isFinite(seconds) || seconds <= 0) return true;
  const got = micros(seconds);
  if (got >= micros(limits.nearCutSeconds)) return true;
  const expected = micros(speechSeconds(piece, limits.typical));
  return expected >= micros(limits.shortCheckMinSeconds) && got < Math.round(expected * limits.shortRatio);
}
