import { hash, verify, type Algorithm } from "@node-rs/argon2";

// argon2id with the OWASP baseline (19 MiB, t=2, p=1).
// `Algorithm` is an ambient const enum (not importable as a value here); 2 = Argon2id.
const OPTIONS = {
  algorithm: 2 as Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const hashPassword = (password: string): Promise<string> => hash(password, OPTIONS);

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

/** Verified against when the account does not exist, so a miss costs as much time as a hit. */
let dummy: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  return (dummy ??= hashPassword("agent-lee-dummy-password"));
}
