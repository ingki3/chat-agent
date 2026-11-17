import type { Segment, SpeakerTurn } from "./runner.js";

/** One line of the transcript: who (null without diarization), when (seconds) and what. */
export type TranscriptSegment = { speaker: string | null; start: number; end: number; text: string };

/** Same speaker, a pause shorter than this: one segment. */
const JOIN_GAP_SECONDS = 2;

const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/** The time between two intervals (0 when they touch or overlap). */
const gap = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  Math.max(0, Math.max(a.start, b.start) - Math.min(a.end, b.end));

/**
 * At most `max` speakers: the ones with the most speaking time stay; each turn of another speaker goes to the kept
 * speaker of the nearest kept turn (in time). The diarizer cannot be told a speaker count, so this is how the
 * `maxSpeakers` hint is honoured.
 */
export function capSpeakers(turns: readonly SpeakerTurn[], max: number): SpeakerTurn[] {
  const total = new Map<number, number>();
  for (const t of turns) total.set(t.speaker, (total.get(t.speaker) ?? 0) + (t.end - t.start));
  if (total.size <= max) return [...turns];
  const keep = new Set(
    [...total.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, max)
      .map(([s]) => s),
  );
  const kept = turns.filter((t) => keep.has(t.speaker));
  return turns.map((t) => {
    if (keep.has(t.speaker)) return t;
    let best = kept[0]!;
    for (const k of kept) if (gap(k, t) < gap(best, t)) best = k;
    return { ...t, speaker: best.speaker };
  });
}

/**
 * The speaker of one timed text: the one who talks most during it; with no overlap at all, the one whose turn is
 * nearest. Undefined without turns.
 */
function speakerOf(s: Segment, turns: readonly SpeakerTurn[]): number | undefined {
  if (!turns.length) return undefined;
  const talk = new Map<number, number>();
  for (const t of turns) {
    const o = overlap(s, t);
    if (o > 0) talk.set(t.speaker, (talk.get(t.speaker) ?? 0) + o);
  }
  if (talk.size) return [...talk.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
  let best = turns[0]!;
  for (const t of turns) if (gap(t, s) < gap(best, s)) best = t;
  return best.speaker;
}

/**
 * The transcript: Whisper's timed text, each piece given the speaker of the diarizer's turns it overlaps most,
 * speakers renamed `speaker_1`, `speaker_2`… in order of first appearance, and consecutive pieces of one speaker
 * joined (a pause under two seconds, the joined text under `maxChars`). Nothing is cut: a piece longer than
 * `maxChars` stays whole here (the caller takes known secrets out of the whole text, then `splitLong` splits it).
 * `turns` undefined: no diarization — every speaker is null.
 */
export function mergeTranscript(
  stt: readonly Segment[],
  turns: readonly SpeakerTurn[] | undefined,
  o: { maxSpeakers?: number; maxChars: number },
): { segments: TranscriptSegment[]; speakers: number } {
  const capped = turns && o.maxSpeakers ? capSpeakers(turns, o.maxSpeakers) : turns;
  const names = new Map<number, string>();
  const out: TranscriptSegment[] = [];
  for (const s of [...stt].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const text = s.text.trim();
    if (!text) continue;
    const raw = capped ? speakerOf(s, capped) : undefined;
    let speaker: string | null = null;
    if (raw !== undefined) {
      if (!names.has(raw)) names.set(raw, `speaker_${names.size + 1}`);
      speaker = names.get(raw)!;
    }
    const last = out[out.length - 1];
    if (
      last &&
      last.speaker === speaker &&
      s.start - last.end < JOIN_GAP_SECONDS &&
      Array.from(last.text).length + 1 + Array.from(text).length <= o.maxChars
    ) {
      last.text = `${last.text} ${text}`;
      last.end = Math.max(last.end, s.end);
      continue;
    }
    out.push({ speaker, start: s.start, end: s.end, text });
  }
  return { segments: out, speakers: names.size };
}

/**
 * Every segment longer than `maxChars` (code points) split into consecutive pieces of the same speaker — at the
 * last space before the limit when there is one — with times shared out by position in the text. No character is
 * lost: the pieces joined back with their spaces are the original text.
 */
export function splitLong(segments: readonly TranscriptSegment[], maxChars: number): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const s of segments) {
    const cps = Array.from(s.text);
    if (cps.length <= maxChars) {
      out.push({ ...s });
      continue;
    }
    const span = s.end - s.start;
    let at = 0;
    while (at < cps.length) {
      let end = Math.min(cps.length, at + maxChars);
      if (end < cps.length) {
        const space = cps.lastIndexOf(" ", end);
        if (space > at) end = space;
      }
      const text = cps.slice(at, end).join("").trim();
      if (text)
        out.push({
          speaker: s.speaker,
          start: s.start + (span * at) / cps.length,
          end: s.start + (span * end) / cps.length,
          text,
        });
      at = end;
      while (at < cps.length && cps[at] === " ") at++;
    }
  }
  return out;
}

/** `[hh:mm:ss]` of a time in seconds. */
export function clock(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

/** The transcript as markdown: a header, then one paragraph per segment. */
export function transcriptMarkdown(
  title: string,
  segments: readonly TranscriptSegment[],
  meta: { durationSeconds: number; speakers: number; external: boolean; notice: string },
): string {
  const lines = [
    `# ${title.replace(/[\r\n]+/g, " ")} — 대본`,
    "",
    `- 길이: ${clock(meta.durationSeconds)}`,
    `- 화자: ${meta.speakers ? `${meta.speakers}명 (자동 구분 — 이름은 추정)` : "구분 안 함"}`,
    ...(meta.external ? [`- ${meta.notice}`] : []),
    "",
  ];
  for (const s of segments)
    lines.push(`**[${clock(s.start)}] ${s.speaker ?? "화자"}:** ${s.text.replace(/[\r\n]+/g, " ")}`, "");
  return lines.join("\n");
}
