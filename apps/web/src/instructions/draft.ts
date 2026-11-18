/**
 * Drafts of the 기억 정리 and notification forms (#188 reviews 3–12): one rule for every form.
 *
 * - A form keeps only the fields the person **changed** (`Partial<T>`); every other field shows the cached value, so
 *   a refetch updates it.
 * - A save sends only those fields; the server merges them into what is stored (the same field from two places: the
 *   later write wins).
 * - When the save succeeds, its answer (the stored settings with their revision) is merged into the cache by revision
 *   (`rev.ts`: only if strictly newer, and only the stored part), and the sent fields that still hold what was sent
 *   leave the draft — anything typed after sending stays. A refused save keeps the draft and says why. Live state
 *   (whether it runs, problems, the status sentence's `liveRev`) comes from GETs only (`rev.ts`). Forms are locked
 *   while saving.
 */

/** The value a form shows: the server's, with the person's changes on top. */
export function withDraft<T extends object>(server: T, draft: Partial<T> | undefined): T {
  return { ...server, ...(draft ?? {}) };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The draft after `sent` was saved: the fields still as sent are dropped (undefined when nothing is left). */
export function settleDraft<T extends object>(
  draft: Partial<T> | undefined,
  sent: Partial<T>,
): Partial<T> | undefined {
  if (!draft) return undefined;
  const left = Object.fromEntries(
    Object.entries(draft).filter(([k, v]) => !(k in sent) || !same(v, (sent as Record<string, unknown>)[k])),
  ) as Partial<T>;
  return Object.keys(left).length ? left : undefined;
}

/** A whole-value draft (a prompt box, a quiet-hours pair): cleared after a save only if it still holds what was sent. */
export function afterSave<T>(current: T, submitted: T, cleared: T): T {
  return same(current, submitted) ? cleared : current;
}
