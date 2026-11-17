import { z } from "zod";
import { AUDIO_FALLBACK_MODEL, AUDIO_LIMITS } from "@agentlee/shared";
import { carriesSecret } from "../secrets/egress.js";
import type { Segment } from "./runner.js";

/**
 * The OpenRouter fallback of `audio_transcribe` (#173): used **only** when the local Whisper failed, **only** when
 * the admin turned the switch on and `OPENROUTER_API_KEY` is set. One request per MP3 piece (under the provider's
 * 25 MB multipart limit), sent by the server itself — not by a sandboxed child, so the §42 per-send gate is the
 * server's own check here, before the request exists:
 *
 * - the URL is a constant (`https://openrouter.ai/api/v1/audio/transcriptions`), redirects are refused;
 * - the key goes **only** in the `Authorization` header of that host (#171's header placement, done here directly);
 * - the form is fixed: `model` (constant), `language` (2–3 lower-case letters), `response_format`, `temperature`,
 *   a fixed file name, and the audio bytes. Every text part (URL, fields, file name) is checked with the one egress
 *   predicate (`carriesSecret`) — the audio is the user's own recording, the point of the request;
 * - nothing about the request or the answer is logged (the service logs a fixed outcome code).
 */
export const OPENROUTER_TRANSCRIBE_URL = "https://openrouter.ai/api/v1/audio/transcriptions";

export type FallbackChunk = { data: Buffer; index: number };
export type FallbackResult = { ok: true; segments: Segment[] } | { ok: false };
/** Transcribes one piece; times are relative to the piece. */
export type FallbackClient = (
  chunk: FallbackChunk,
  o: { language: string; signal?: AbortSignal | undefined },
) => Promise<FallbackResult>;

const Answer = z.object({
  text: z.string().optional(),
  segments: z
    .array(z.object({ start: z.number(), end: z.number(), text: z.string() }).passthrough())
    .optional(),
  duration: z.number().optional(),
});

/** The parts of the request besides the audio and the key (what the egress check sees). */
export function requestTexts(language: string, fileName: string): string[] {
  return [OPENROUTER_TRANSCRIBE_URL, AUDIO_FALLBACK_MODEL, language, "verbose_json", "0", fileName];
}

export function openRouterClient(o: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): FallbackClient {
  const doFetch = o.fetchImpl ?? fetch;
  return async (chunk, { language, signal }) => {
    if (!/^[a-z]{2,3}$/.test(language) || chunk.data.length > AUDIO_LIMITS.fallbackChunkBytes)
      return { ok: false };
    const fileName = `chunk-${String(chunk.index).padStart(3, "0")}.mp3`;
    if (carriesSecret(requestTexts(language, fileName))) return { ok: false };
    const form = new FormData();
    form.set("model", AUDIO_FALLBACK_MODEL);
    form.set("language", language);
    form.set("response_format", "verbose_json");
    form.set("temperature", "0");
    form.set("file", new Blob([new Uint8Array(chunk.data)], { type: "audio/mpeg" }), fileName);
    const timeout = AbortSignal.timeout(o.timeoutMs ?? AUDIO_LIMITS.fallbackRequestTimeoutMs);
    try {
      const res = await doFetch(OPENROUTER_TRANSCRIBE_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${o.apiKey}` },
        body: form,
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!res.ok) return { ok: false };
      const answer = Answer.safeParse(await res.json());
      if (!answer.success) return { ok: false };
      const segs = (answer.data.segments ?? [])
        .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end >= s.start)
        .map((s) => ({ start: s.start, end: s.end, text: s.text }));
      if (segs.length) return { ok: true, segments: segs };
      // No timestamps (a provider that ignores verbose_json): the whole piece as one segment.
      const text = answer.data.text?.trim();
      if (!text) return { ok: true, segments: [] };
      return {
        ok: true,
        segments: [{ start: 0, end: answer.data.duration ?? AUDIO_LIMITS.fallbackChunkSeconds, text }],
      };
    } catch {
      return { ok: false };
    }
  };
}
