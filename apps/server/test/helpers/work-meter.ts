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
  // The native iterator, its own `next` counting each step: still the engine's object, so everything on its
  // prototype (`take`, `map`, `toArray`, … — review #217 2차) is there and goes through the counted `next`.
  const counted = (orig: (...a: unknown[]) => unknown) =>
    function (this: unknown) {
      const it = Reflect.apply(orig, this, []) as Iterator<unknown>;
      const next = it.next;
      work++;
      Object.defineProperty(it, "next", {
        configurable: true,
        writable: true,
        value: function (this: Iterator<unknown>) {
          const r = Reflect.apply(next, this, []) as IteratorResult<unknown>;
          if (!r.done) work++;
          return r;
        },
      });
      return it;
    };
  // Costs never run the caller's code again (review #217 3차): a length only of a string or a real array (no
  // getter), and a search's arguments looked at only when they are primitives — an object's `valueOf`/`toString`
  // ran once, in the native call; then the search is charged as a miss over the whole text.
  const len = (x: unknown) => (typeof x === "string" || Array.isArray(x) ? x.length : 0);
  // (An index loop: the array methods are the metered ones.)
  const plain = (args: unknown[], from = 0) => {
    for (let i = from; i < args.length; i++) {
      const a = args[i];
      if (a !== undefined && typeof a !== "string" && typeof a !== "number") return false;
    }
    return true;
  };
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
      const text = typeof args[0] === "string" ? args[0] : "";
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
      plain(args) ? searched(len(s), startOf(len(s), args[1], false), r, len(String(args[0]))) : len(s),
    );
    wrap(S, "includes", (s: string, args) => {
      if (!plain(args) || typeof s !== "string") return len(s);
      const at = startOf(len(s), args[1], false);
      const needle = String(args[0]);
      return searched(len(s), at, Reflect.apply(strIndexOf, s, [needle, at]) as number, len(needle));
    });
    // Backwards from `position` (the end when there is none): to the match, or to the start on a miss.
    wrap(S, "lastIndexOf", (s: string, args, r: number) => {
      if (!plain(args)) return len(s);
      const p = Number(args[1]);
      const start = Number.isNaN(p) ? len(s) : Math.max(0, Math.min(len(s), Math.trunc(p)));
      const needle = len(String(args[0]));
      return r >= 0 ? start - r + needle : Math.min(len(s), start + needle);
    });
    for (const name of ["startsWith", "endsWith"]) wrap(S, name, (_s, args) => len(args[0]));
    for (const name of ["charCodeAt", "codePointAt", "charAt", "at"]) wrap(S, name, () => 1);
    replace(S, Symbol.iterator, counted);
    wrap(Array, "from", (_s, _a, r: unknown[]) => len(r));
    const A = Array.prototype;
    // A copy: what it copied.
    for (const name of ["slice", "concat"]) wrap(A, name, (_s, _a, r: unknown[]) => len(r));
    wrap(A, "indexOf", (self: unknown[], args, r: number) =>
      searched(len(self), startOf(len(self), args[1], true), r, 1),
    );
    // `includes`: the native call gives the answer (and its errors); the cost never reads an element again (review
    // #217 2차/3차 — a getter would run twice). A hit in a real array is charged up to where it is, found from the
    // element descriptors (no getter runs; one with a getter, or not a real array: the whole length).
    wrap(A, "includes", (self: unknown[], args, found: boolean) => {
      const n = len(self);
      const at = plain(args, 1) ? startOf(n, args[1], true) : 0;
      if (!found || !Array.isArray(self)) return n - at;
      const x = args[0];
      for (let i = at; i < n; i++) {
        const d = Object.getOwnPropertyDescriptor(self, i);
        if (d && !("value" in d)) return n - at;
        const v = d?.value;
        if (v === x || (v !== v && x !== x)) return i - at + 1;
      }
      return n - at;
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
