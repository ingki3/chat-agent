import { z } from "zod";
import { MEDIA_TOOL_LIMITS } from "@agentlee/shared";
import type { ServerToolInfo } from "./index.js";

/**
 * 미디어 생성 stage 2 (#238): images and speech made by the OpenRouter model the admin chose. How a call runs — the
 * admin's switch and model, the per-run and daily limits, the request policy, the stored file — is the host's
 * business (apps/server/src/media/generate.ts). Offered only while the kind is on (관리자 → 미디어 생성), to every
 * active account — youth accounts too, with the provider's strictest moderation where the model has one.
 */
export type MediaToolInfo = ServerToolInfo & { kind: "image" | "speech" };

/** The forbidden uses, the same for every account (#238 plan, user decision 2026-11-24). */
const RULES =
  "Call it ONLY when the user explicitly asked for this in the current request — never on your own initiative, never to illustrate an answer. Never: imitate or depict a real, identifiable person (a celebrity, a politician, a private person, a family member) or their voice; sexual or sexualized content of anyone; content that harasses, deceives (fake evidence, fake news, impersonation) or harms. Refuse such a request in your own words instead of calling. Each call costs money (the user's daily media budget): make one call per thing asked, never variations nobody asked for.";

export const IMAGE_GENERATE_TOOL: MediaToolInfo = {
  name: "image_generate",
  kind: "image",
  description: `Makes one image with the image model the admin chose and saves it as a PNG/JPG/WebP file of this conversation; the user sees it in the chat under your reply. ${RULES} Optional referenceFileIds: up to ${MEDIA_TOOL_LIMITS.referenceFiles} images of this conversation (fileId from file_list; png, jpg or webp) the model edits or follows — only images the user gave or made here, never one of a real person to alter their likeness. Returns fileId, file {fileId, name, bytes, url, kind}, model and costUsd (OpenRouter's reported cost; null when not reported). Describe the result briefly; do not paste the URL.`,
  input: {
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(MEDIA_TOOL_LIMITS.promptChars)
      .describe("What the image shows, in the user's words (any language)."),
    aspectRatio: z
      .string()
      .regex(/^(\d{1,2}:\d{1,2}|auto)$/)
      .optional()
      .describe('Width:height such as "1:1", "16:9", "9:16" — only when the user asked for a shape.'),
    referenceFileIds: z
      .array(z.string().min(1).max(64))
      .min(1)
      .max(MEDIA_TOOL_LIMITS.referenceFiles)
      .optional()
      .describe("Images of this conversation to edit or follow (fileId from file_list)."),
  },
};

export const SPEECH_GENERATE_TOOL: MediaToolInfo = {
  name: "speech_generate",
  kind: "speech",
  description: `Reads a text aloud with the text-to-speech model the admin chose and saves it as an MP3 file of this conversation; the user can play it in the chat under your reply. ${RULES} Only the model's own voices: never clone or imitate someone's voice (no voice samples are taken). Up to ${MEDIA_TOOL_LIMITS.speechChars} characters per call: a long script is split automatically at sentence and paragraph boundaries, read piece by piece with the same voice and instructions, and joined into ONE MP3 — always pass the whole script in one call, never split it yourself. Returns fileId, file {fileId, name, bytes, url, kind}, model, voice, durationSeconds (the audio's length), chunks (pieces read) and costUsd (OpenRouter's reported cost of all pieces; null when not reported).`,
  input: {
    text: z
      .string()
      .trim()
      .min(1)
      .max(MEDIA_TOOL_LIMITS.speechChars)
      .describe("The exact text to read aloud."),
    voice: z
      .string()
      .trim()
      .min(1)
      .max(MEDIA_TOOL_LIMITS.voiceChars)
      .regex(/^[A-Za-z0-9 _.:()-]+$/)
      .optional()
      .describe(
        "One of the model's voice ids — only when the user asked for a voice; default: the model's first.",
      ),
    instructions: z
      .string()
      .trim()
      .min(1)
      .max(MEDIA_TOOL_LIMITS.instructionsChars)
      .optional()
      .describe(
        'How to say it ("calm and slow", "cheerful") — only when the user asked; some models ignore it.',
      ),
  },
};

export const MEDIA_TOOLS: readonly MediaToolInfo[] = [IMAGE_GENERATE_TOOL, SPEECH_GENERATE_TOOL];
