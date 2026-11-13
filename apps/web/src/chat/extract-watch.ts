import { EXTRACT_CODE_TEXT, type FileExtract } from "@agentlee/shared";

/**
 * Right after an upload (#23, FR-4.4): the server reads the file in the background; a file it cannot read — a
 * password or a distribution-only HWP, a damaged file … — is said on the chip at once ("… 읽을 수 없어요"), not
 * only when the agent tries to read it. The file is still stored and may be sent; the words are the fixed ones of
 * `EXTRACT_CODE_TEXT`.
 */
export function extractNotice(e: Pick<FileExtract, "status" | "code">): string | undefined {
  if (e.status !== "failed") return undefined;
  return EXTRACT_CODE_TEXT[e.code ?? "extract_failed"];
}

export type WatchOptions = {
  /** Reads at most this many times (default: until the extraction is no longer pending — review #120). */
  tries?: number;
  /** The first wait; each next one is 1.5 times longer, up to `maxDelayMs` (defaults 1 s and 15 s). */
  delayMs?: number;
  maxDelayMs?: number;
  /** True once nobody needs the answer (the chip is gone, the composer unmounted). */
  stopped?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Reads a file's extraction until it is no longer pending — however long the files before it take (one file is
 * extracted at a time) — with a growing wait; the notice for a failure, else undefined. Undefined too when it
 * was stopped.
 */
export async function watchExtract(
  read: () => Promise<Pick<FileExtract, "status" | "code">>,
  o: WatchOptions = {},
): Promise<string | undefined> {
  const tries = o.tries ?? Infinity;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let delay = o.delayMs ?? 1000;
  const max = o.maxDelayMs ?? 15_000;
  for (let i = 0; i < tries; i++) {
    if (o.stopped?.()) return undefined;
    try {
      const e = await read();
      if (e.status !== "pending") return extractNotice(e);
    } catch {
      // A passing failure (network, restart): try again; nothing is said for it.
    }
    if (o.stopped?.()) return undefined;
    await sleep(delay);
    delay = Math.min(max, Math.round(delay * 1.5));
  }
  return undefined;
}
