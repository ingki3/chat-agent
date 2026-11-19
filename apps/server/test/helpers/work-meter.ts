/**
 * A deterministic measure of the work a synchronous call does (#213) — for linearity checks that a busy machine
 * cannot fail: a wall-clock ratio is the algorithm times whatever else the machine was doing, a count is only the
 * algorithm.
 *
 * While `meterWork` runs `fn`, the built-ins that walk strings and arrays are wrapped, and each call adds what it
 * had to pass over at the least:
 *
 * - `RegExp.prototype.exec` — and through it `test`, `match`, `matchAll`, `replace`, `search` and `split` with a
 *   pattern (with `exec` replaced, the engine calls it for all of them): the characters from where the search
 *   started to the end of the match, or to the end of the text when nothing matched (1 for a sticky miss);
 * - string slicing and building (`slice`, `substring`, `padEnd`, `repeat`, …): the result's length; a search
 *   (`indexOf`, `includes`): the characters from its start to the match (or the end); `charCodeAt` and the like: 1;
 * - `Array.from`, array copying (`slice`, `concat`, `splice`, `shift`, …) and every whole-array method (`map`,
 *   `join`, `indexOf`, `sort`, …): the array's (or the result's) length; `push`: the items pushed.
 *
 * Plus 1 a call. Plain loops and indexing (`a[i]`, `for…of`, spreading) are not seen: code whose cost is in its own
 * loops counts them itself (`scrubStats`, `scanStats`) and the test adds that. Only for synchronous code: the
 * built-ins are restored before `meterWork` returns, and nothing else runs meanwhile.
 */
export function meterWork(fn: () => void): number {
  let work = 0;
  const restore: (() => void)[] = [];
  const wrap = <T extends object>(
    owner: T,
    name: string,
    // Each cost reads the shape of its own built-in (`never`: any signature fits).
    cost: (self: never, args: never, result: never, lastIndex: number) => number,
  ) => {
    const desc = Object.getOwnPropertyDescriptor(owner, name);
    const orig = desc?.value as ((...a: unknown[]) => unknown) | undefined;
    if (typeof orig !== "function") return;
    Object.defineProperty(owner, name, {
      ...desc,
      value: function (this: unknown, ...args: unknown[]) {
        const before = this instanceof RegExp ? this.lastIndex : 0;
        const result = Reflect.apply(orig, this, args);
        work += 1 + (cost as (...a: unknown[]) => number)(this, args, result, before);
        return result;
      },
    });
    restore.push(() => Object.defineProperty(owner, name, desc!));
  };
  const len = (x: unknown) =>
    x != null && typeof (x as { length?: unknown }).length === "number"
      ? (x as { length: number }).length
      : 0;
  const from = (s: { length: number }, pos: unknown) => Math.max(0, Math.min(s.length, Number(pos) || 0));
  try {
    wrap(RegExp.prototype, "exec", (re: RegExp, [s]: [string], m: RegExpExecArray | null, before: number) => {
      const text = String(s);
      const start = re.global || re.sticky ? before : 0;
      if (m) return re.sticky ? m[0].length : m.index - start + m[0].length;
      return re.sticky ? 1 : Math.max(0, text.length - start);
    });
    const S = String.prototype as unknown as Record<string, unknown>;
    for (const name of [
      "slice",
      "substring",
      "substr",
      "padStart",
      "padEnd",
      "repeat",
      "concat",
      "normalize",
      "toLowerCase",
      "toUpperCase",
      "trim",
      "trimStart",
      "trimEnd",
    ])
      wrap(S, name, (_s, _a, r: string) => len(r));
    for (const name of ["split", "replace", "replaceAll", "localeCompare", "lastIndexOf"])
      wrap(S, name, (s: string) => len(s));
    for (const name of ["indexOf", "includes"])
      wrap(S, name, (s: string, [needle, pos]: [string, number], r: number | boolean) => {
        const at = from(s, pos);
        return typeof r === "number" && r >= 0 ? r - at + len(needle) : len(s) - at;
      });
    for (const name of ["startsWith", "endsWith"]) wrap(S, name, (_s, [needle]: [string]) => len(needle));
    for (const name of ["charCodeAt", "codePointAt", "charAt", "at"]) wrap(S, name, () => 1);
    wrap(Array, "from", (_s, _a, r: unknown[]) => len(r));
    const A = Array.prototype as unknown as Record<string, unknown>;
    // A copy: what it copied.
    for (const name of ["slice", "concat"]) wrap(A, name, (_s, _a, r: unknown[]) => len(r));
    // The whole array (an early exit is not credited).
    for (const name of [
      "splice",
      "shift",
      "unshift",
      "flat",
      "flatMap",
      "map",
      "filter",
      "forEach",
      "reduce",
      "reduceRight",
      "join",
      "indexOf",
      "lastIndexOf",
      "includes",
      "find",
      "findIndex",
      "findLast",
      "findLastIndex",
      "some",
      "every",
      "sort",
      "reverse",
      "fill",
      "copyWithin",
      "toSorted",
      "toReversed",
      "toSpliced",
      "with",
    ])
      wrap(A, name, (self: unknown[], _a, r: unknown) =>
        Math.max(len(self), Array.isArray(r) ? r.length : 0),
      );
    wrap(A, "push", (_s, args: unknown[]) => args.length);
    work = 0; // the wrapping itself pushed
    fn();
  } finally {
    for (let i = restore.length - 1; i >= 0; i--) restore[i]!();
  }
  return work;
}
