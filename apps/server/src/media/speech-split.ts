/**
 * Long scripts for `speech_generate` (#248): the production TTS model (`elevenlabs/eleven-v4` through OpenRouter)
 * stops its audio at about 290 s **without an error**. So a text is cut into pieces at paragraph and sentence
 * boundaries, each estimated at most `targetSeconds` long at a slow reading rate, synthesized one by one with the same
 * model, voice and instructions, measured (ffprobe) and joined into one MP3 (`speech-audio.ts`).
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
 * anywhere; a line break with the whitespace after it. A decimal point ("3.14") is not an end.
 */
const SENTENCE = new RegExp(
  String.raw`(?:[.!?…]+${CLOSE}(?:\s+|(?=[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Lu}]))|[。！？]+${CLOSE}\s*|\n\s*)`,
  "gu",
);
const CLAUSE = /[,;:，、；：]\s*/gu;
const SPACE = /\s+/gu;

/** Seconds of speech this text is estimated at, at these rates. */
export function speechSeconds(text: string, rates: Rates): number {
  let s = 0;
  for (const ch of text) {
    if (SYLLABLE.test(ch)) s += 1 / rates.syllables;
    else if (DIGIT.test(ch)) s += 1 / rates.digits;
    else s += 1 / rates.chars;
  }
  const ends = text.match(SENTENCE_END)?.length ?? 0;
  return s + ends * rates.sentencePause;
}

/** A part of the source text: `[start, end)` in UTF-16 offsets. */
export type Span = { start: number; end: number };

/** The ends of the text's grapheme clusters (user-perceived characters): the only places a cut may go. */
function graphemeEnds(text: string): number[] {
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const out: number[] = [];
  for (const g of seg.segment(text)) out.push(g.index + g.segment.length);
  return out;
}

/** The span cut after every match of `re` that ends on a grapheme boundary (each part keeps its separator). */
function cutAfter(text: string, span: Span, re: RegExp, ok: ReadonlySet<number>): Span[] {
  const out: Span[] = [];
  let at = span.start;
  for (const m of text.slice(span.start, span.end).matchAll(re)) {
    const end = span.start + m.index + m[0].length;
    if (end > at && end < span.end && ok.has(end)) {
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
  const fits = (sp: Span) => speechSeconds(text.slice(sp.start, sp.end), rates) <= target;
  const out: Span[] = [];
  for (const s of cutAfter(text, { start: 0, end: text.length }, SENTENCE, ok)) {
    if (fits(s)) {
      out.push(s);
      continue;
    }
    for (const c of cutAfter(text, s, CLAUSE, ok)) {
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
    if (cur && speechSeconds(text.slice(cur.start, u.end), limits.slow) > t) {
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
  if (seconds >= limits.nearCutSeconds) return true;
  const expected = speechSeconds(piece, limits.typical);
  return expected >= limits.shortCheckMinSeconds && seconds < expected * limits.shortRatio;
}
