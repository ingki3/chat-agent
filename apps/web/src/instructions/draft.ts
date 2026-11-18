/**
 * A saved draft (review #195 round 3): once a save succeeds the editor goes back to `cleared` — but only if what is in
 * it now is still what was sent. Anything typed meanwhile stays (the editors are also locked while saving).
 */
export function afterSave<T>(current: T, submitted: T, cleared: T): T {
  return current === submitted ? cleared : current;
}
