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
  /** Pieces of one call at most (before any re-split); more is `media_too_long`. */
  maxPieces: 16,
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
};
type Rates = { syllables: number; digits: number; chars: number; sentencePause: number };

/** Hangul syllables and jamo, CJK ideographs, kana: one spoken syllable each. */
const SYLLABLE = /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-䶿一-鿿가-힣豈-﫿]/u;
const DIGIT = /\p{Nd}/u;
/** A sentence ends here: terminal punctuation (with closing quotes/brackets) or a line break. */
const SENTENCE_END = /[.!?。！？…]+["'”’)\]」』]*|\n/gu;

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

/**
 * The text's units: paragraphs, then sentences, each keeping its trailing whitespace (so joining them gives the
 * text back). A unit estimated over `target` is cut further: at clause marks (, ; : 、), then at whitespace, and
 * last — a run without any — every so many characters (never inside a surrogate pair).
 */
function units(text: string, target: number, rates: Rates): string[] {
  const out: string[] = [];
  const sentences = splitKeeping(text, /(?:[.!?。！？…]+["'”’)\]」』]*\s+|\n\s*)/gu);
  for (const s of sentences) {
    if (speechSeconds(s, rates) <= target) out.push(s);
    else
      for (const c of splitKeeping(s, /[,;:，、；：]\s*/gu)) {
        if (speechSeconds(c, rates) <= target) out.push(c);
        else
          for (const w of splitKeeping(c, /\s+/gu)) {
            if (speechSeconds(w, rates) <= target) out.push(w);
            else out.push(...hardCut(w, target, rates));
          }
      }
  }
  return out;
}

/** The text cut after every match of `re` (each piece keeps its separator); empty pieces dropped. */
function splitKeeping(text: string, re: RegExp): string[] {
  const out: string[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    const end = m.index + m[0].length;
    if (end > at) out.push(text.slice(at, end));
    at = end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out.filter((p) => p.length > 0);
}

/** A run without any boundary, cut into pieces of at most `target` (by code points). */
function hardCut(text: string, target: number, rates: Rates): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of text) {
    if (cur && speechSeconds(cur + ch, rates) > target) {
      out.push(cur);
      cur = "";
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The text as pieces to synthesize, in order: units packed greedily while the piece's slow estimate stays within
 * `targetSeconds`. A text that fits is one piece — **exactly** the text (as before #248). Pieces are trimmed;
 * blank ones are dropped.
 */
export function splitSpeech(
  text: string,
  limits: SpeechSplitLimits = SPEECH_SPLIT,
  target?: number,
): string[] {
  const t = target ?? limits.targetSeconds;
  if (speechSeconds(text, limits.slow) <= t) return [text];
  const pieces: string[] = [];
  let cur = "";
  for (const u of units(text, t, limits.slow)) {
    if (cur && speechSeconds(cur + u, limits.slow) > t) {
      pieces.push(cur);
      cur = "";
    }
    cur += u;
  }
  if (cur) pieces.push(cur);
  return pieces.map((p) => p.trim()).filter((p) => p.length > 0);
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
