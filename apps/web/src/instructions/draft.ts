/**
 * Drafts of the 기억 정리 and notification forms (#188 reviews 3–5): one rule for every form.
 *
 * - A form keeps only the fields the person **changed** (`Partial<T>`); every other field shows the server's value,
 *   so a refetch updates it.
 * - A save sends only those fields; the server merges them into what is stored (the same field from two places: the
 *   later write wins — no versions in a family-sized app).
 * - After a save the form refetches (the cache is never replaced by a mutation's response, which could be older than
 *   what another form saved meanwhile) and drops the fields it sent only if they still hold what was sent — anything
 *   typed after sending stays. A failed save keeps the draft. The forms are locked while saving.
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

/** A single-value draft (a prompt box): cleared after a save only if it still holds what was sent. */
export function afterSave<T>(current: T, submitted: T, cleared: T): T {
  return current === submitted ? cleared : current;
}
