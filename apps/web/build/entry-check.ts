/**
 * Build check (#182): the app's first load never carries heavy, rarely needed libraries. mermaid is loaded with
 * `import()` the first time a diagram is drawn; if a change pulled it into the entry chunk (or a chunk the entry
 * imports statically), the build fails.
 */
export type ChunkInfo = { fileName: string; isEntry: boolean; imports: string[]; moduleIds: string[] };

/** Packages that must never be in the first load. */
export const LAZY_ONLY = ["mermaid"];

const inPackage = (id: string, pkg: string) =>
  new RegExp(
    `[\\\\/]node_modules[\\\\/](?:\\.pnpm[\\\\/][^\\\\/]+[\\\\/]node_modules[\\\\/])?${pkg}[\\\\/]`,
  ).test(id);

/** Problems found: `<chunk>: <module>` for each lazy-only module reachable from an entry without `import()`. */
export function firstLoadProblems(chunks: ChunkInfo[], lazyOnly: string[] = LAZY_ONLY): string[] {
  const byName = new Map(chunks.map((c) => [c.fileName, c]));
  const seen = new Set<string>();
  const stack = chunks.filter((c) => c.isEntry).map((c) => c.fileName);
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    stack.push(...(byName.get(f)?.imports ?? []));
  }
  const out: string[] = [];
  for (const f of seen)
    for (const id of byName.get(f)?.moduleIds ?? [])
      if (lazyOnly.some((p) => inPackage(id, p))) out.push(`${f}: ${id}`);
  return out;
}
