import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { SkillInfo } from "./index.js";

/** Folder of the bundled skills (same from src/ and dist/). */
export const SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skills");

/** A bundled skill: what the MCP server shows, plus the script the host runs in its sandbox. */
export type BundledSkill = SkillInfo & { dir: string; entry: string };

/** The verification skill — confirms the allow-listed, sandboxed skill path works end to end. */
export const SELFTEST_SKILL: BundledSkill = {
  name: "selftest",
  description:
    "Verification skill: returns the character count, SHA-256 and reverse of a short text. Use it only to check that Agent Lee skills work.",
  input: { text: z.string().max(2000) },
  dir: path.join(SKILLS_DIR, "selftest"),
  entry: path.join(SKILLS_DIR, "selftest", "main.mjs"),
};

export const BUNDLED_SKILLS: readonly BundledSkill[] = [SELFTEST_SKILL];
