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
 *   (`indexOf`, `includes`, `lastIndexOf`): the characters from its start to the match, or to the end on a miss —
 *   `includes` finds where with the original `indexOf` (review #217: a hit at the first character costs 1, not
 *   the rest of the text); `charCodeAt` and the like: 1;
 * - iterating a string or an array (`for…of`, spreading `[...s]`, `Array.from`, destructuring): 1 a step;
 * - `Array.from`, array copying (`slice`, `concat`): the result's length; `indexOf`/`includes`: as for strings;
 *   every other whole-array method (`map`, `join`, `sort`, `shift`, `splice`, …): the array's (or the result's)
 *   length, an early exit not credited; `push`: the items pushed.
 *
 * Plus 1 a call. Plain loops and indexing (`a[i]`, `s[i]`, property reads) are not seen: code whose cost is in its
 * own loops counts them itself (`scrubStats`, `scanStats`) and the test adds that, or the test counts the reads of
 * its own input (a getter). Only for synchronous code: the built-ins are restored before `meterWork` returns
 * (also when `fn` throws), and nothing else runs meanwhile.
 */
export function meterWork(fn: () => void): number {
  let work = 0;
  const restore: (() => void)[] = [];
  const strIndexOf = String.prototype.indexOf;
  const arrIndexOf = Array.prototype.indexOf;
  const replace = (
    owner: object,
    key: PropertyKey,
    make: (orig: (...a: unknown[]) => unknown) => unknown,
  ) => {
    const desc = Object.getOwnPropertyDescriptor(owner, key);
    const orig = desc?.value as ((...a: unknown[]) => unknown) | undefined;
    if (typeof orig !== "function") return;
    Object.defineProperty(owner, key, { ...desc, value: make(orig) });
    restore[restore.length] = () => Object.defineProperty(owner, key, desc!);
  };
  // `args` is read by index everywhere below: destructuring would run the (metered) array iterator.
  const wrap = (
    owner: object,
    key: PropertyKey,
    cost: (self: never, args: unknown[], result: never, lastIndex: number) => number,
  ) =>
    replace(
      owner,
      key,
      (orig) =>
        function (this: unknown, ...args: unknown[]) {
          const before = this instanceof RegExp ? this.lastIndex : 0;
          const result = Reflect.apply(orig, this, args);
          work += 1 + (cost as (...a: unknown[]) => number)(this, args, result, before);
          return result;
        },
    );
  // An iterator whose every step is counted.
  const counted = (orig: (...a: unknown[]) => unknown) =>
    function (this: unknown) {
      const it = Reflect.apply(orig, this, []) as Iterator<unknown>;
      work++;
      const step: IterableIterator<unknown> = {
        next() {
          const r = it.next();
          if (!r.done) work++;
          return r;
        },
        [Symbol.iterator]() {
          return step;
        },
      };
      return step;
    };
  const len = (x: unknown) =>
    x != null && typeof (x as { length?: unknown }).length === "number"
      ? (x as { length: number }).length
      : 0;
  // Where a search starts: `pos` clamped (negative counts from the end for arrays).
  const startOf = (n: number, pos: unknown, fromEnd: boolean) => {
    const p = Math.trunc(Number(pos) || 0);
    return Math.max(0, Math.min(n, p < 0 && fromEnd ? n + p : p));
  };
  // The distance a search passed over: to the match's end, or to the end of the text on a miss.
  const searched = (n: number, at: number, found: number, needle: number) =>
    found >= 0 ? found - at + needle : n - at;
  try {
    wrap(RegExp.prototype, "exec", (re: RegExp, args, m: RegExpExecArray | null, before) => {
      const text = String(args[0]);
      const start = re.global || re.sticky ? before : 0;
      if (m) return re.sticky ? m[0].length : m.index - start + m[0].length;
      return re.sticky ? 1 : Math.max(0, text.length - start);
    });
    const S = String.prototype;
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
    for (const name of ["split", "replace", "replaceAll", "localeCompare"])
      wrap(S, name, (s: string) => len(s));
    wrap(S, "indexOf", (s: string, args, r: number) =>
      searched(len(s), startOf(len(s), args[1], false), r, len(String(args[0]))),
    );
    wrap(S, "includes", (s: string, args) => {
      const at = startOf(len(s), args[1], false);
      const needle = String(args[0]);
      return searched(len(s), at, Reflect.apply(strIndexOf, s, [needle, at]) as number, len(needle));
    });
    wrap(S, "lastIndexOf", (s: string, _a, r: number) => (r >= 0 ? len(s) - r : len(s)));
    for (const name of ["startsWith", "endsWith"]) wrap(S, name, (_s, args) => len(String(args[0])));
    for (const name of ["charCodeAt", "codePointAt", "charAt", "at"]) wrap(S, name, () => 1);
    replace(S, Symbol.iterator, counted);
    wrap(Array, "from", (_s, _a, r: unknown[]) => len(r));
    const A = Array.prototype;
    // A copy: what it copied.
    for (const name of ["slice", "concat"]) wrap(A, name, (_s, _a, r: unknown[]) => len(r));
    wrap(A, "indexOf", (self: unknown[], args, r: number) =>
      searched(len(self), startOf(len(self), args[1], true), r, 1),
    );
    wrap(A, "includes", (self: unknown[], args) => {
      const at = startOf(len(self), args[1], true);
      return searched(len(self), at, Reflect.apply(arrIndexOf, self, [args[0], at]) as number, 1);
    });
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
      "lastIndexOf",
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
    wrap(A, "push", (_s, args) => args.length);
    // `values` and `[Symbol.iterator]` are one function: both replaced, both restored.
    for (const key of [Symbol.iterator, "values", "keys", "entries"]) replace(A, key, counted);
    work = 0; // setting up iterated the lists above
    fn();
  } finally {
    for (let i = restore.length - 1; i >= 0; i--) restore[i]!();
  }
  return work;
}
