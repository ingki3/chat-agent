import { describe, expect, it } from "vitest";
import { meterWork } from "./helpers/work-meter.js";

/** The meter the linearity checks rely on (#213): what it charges, and that it leaves the built-ins as they were. */
describe("meterWork", () => {
  const text = "a".repeat(10_000);

  it("a search is charged what it passed over: a hit at the first character 1, a miss the whole text", () => {
    // Review #217 (P3): `includes` returns no position — it is charged up to the match, not the rest of the text.
    const hitIncludes = meterWork(() => void text.includes("a"));
    const missIncludes = meterWork(() => void text.includes("b"));
    const hitIndexOf = meterWork(() => void text.indexOf("a"));
    const missIndexOf = meterWork(() => void text.indexOf("b"));
    expect(hitIncludes).toBeLessThanOrEqual(3);
    expect(hitIndexOf).toBeLessThanOrEqual(3);
    expect(missIncludes).toBeGreaterThanOrEqual(text.length);
    expect(missIndexOf).toBeGreaterThanOrEqual(text.length);
    // From a position: only what lies after it.
    expect(meterWork(() => void text.includes("b", 9_990))).toBeLessThanOrEqual(12);
    // Arrays alike.
    const arr = Array.from({ length: 10_000 }, (_, i) => i);
    expect(meterWork(() => void arr.includes(0))).toBeLessThanOrEqual(3);
    expect(meterWork(() => void arr.includes(-1))).toBeGreaterThanOrEqual(arr.length);
    expect(meterWork(() => void arr.indexOf(0))).toBeLessThanOrEqual(3);
    expect(meterWork(() => void arr.indexOf(-1))).toBeGreaterThanOrEqual(arr.length);
    // A linear loop of first-character hits stays linear (it was 64× for 8× the calls).
    const loop = (n: number) =>
      meterWork(() => {
        for (let i = 0; i < n; i++) text.includes("a");
      });
    expect(loop(8_000) / loop(1_000)).toBeLessThan(10);
  });

  it("lastIndexOf from a position, and an array's includes: what they passed over, each element read once", () => {
    // Review #217 2차 (P3): from position 0 the search ends at the first character.
    expect(meterWork(() => void text.lastIndexOf("a", 0))).toBeLessThanOrEqual(3);
    expect(meterWork(() => void text.lastIndexOf("a"))).toBeLessThanOrEqual(3);
    expect(meterWork(() => void text.lastIndexOf("b"))).toBeGreaterThanOrEqual(text.length);
    // An object position is converted once — by the native call, not again for the cost.
    let conversions = 0;
    const pos = {
      valueOf() {
        if (++conversions > 1) throw new Error("converted twice");
        return 0;
      },
    };
    let at = -1;
    meterWork(() => void (at = text.lastIndexOf("a", pos as unknown as number)));
    expect([at, conversions]).toEqual([0, 1]);
    const loop = (n: number) => {
      const s = "a".repeat(n);
      return meterWork(() => {
        for (let i = 0; i < n; i++) s.lastIndexOf("a", 0);
      });
    };
    expect(loop(8_000) / loop(1_000)).toBeLessThan(10);
    // SameValueZero and holes, as the built-in: found at the first element, charged so.
    const nan = [NaN, ...Array.from({ length: 10_000 }, () => 1)];
    const holes = new Array<number>(10_000);
    let found = false;
    expect(meterWork(() => void (found = nan.includes(NaN)))).toBeLessThanOrEqual(3);
    expect(found).toBe(true);
    expect(
      meterWork(() => void (found = holes.includes(undefined as unknown as number))),
    ).toBeLessThanOrEqual(3);
    expect(found).toBe(true);
    expect(meterWork(() => void (found = [0].includes(-0)))).toBeLessThanOrEqual(3);
    expect(found).toBe(true);
    expect(meterWork(() => void (found = [1, 2, 3].includes(2, -1)))).toBeLessThanOrEqual(3);
    expect(found).toBe(false);
    // The native answer and errors (review #217 3차): a null receiver and a BigInt position throw as they do natively.
    expect(() => meterWork(() => void Array.prototype.includes.call(null, 1))).toThrow(TypeError);
    expect(() => meterWork(() => void [1].includes(1, 0n as unknown as number))).toThrow(TypeError);
    // Each element read once (a getter runs once, as without the meter).
    let reads = 0;
    const arr = [1, 2, 3];
    Object.defineProperty(arr, 0, {
      get() {
        reads++;
        return 1;
      },
    });
    meterWork(() => void arr.includes(1));
    expect(reads).toBe(1);
  });

  it("a Proxy array, an array-like and an object handed to exec: read once, as natively, and a miss charged in full", () => {
    // Review #217 4차: a Proxy runs no trap the native call would not (no descriptor reads).
    const traps: string[] = [];
    const target = [1, 2, 3];
    const proxy = new Proxy(target, {
      get(t, k, r) {
        traps.push(`get ${String(k)}`);
        return Reflect.get(t, k, r) as unknown;
      },
      getOwnPropertyDescriptor(t, k) {
        traps.push(`gopd ${String(k)}`);
        return Reflect.getOwnPropertyDescriptor(t, k);
      },
    });
    const natively = (() => {
      traps.length = 0;
      const r = proxy.includes(2);
      return { r, traps: [...traps] };
    })();
    traps.length = 0;
    let r = false;
    meterWork(() => void (r = proxy.includes(2)));
    expect({ r, traps }).toEqual(natively);
    // An array-like: a miss is charged every element (64 → 4096: 64×, not 1).
    const like = (n: number) => ({
      length: n,
      ...Object.fromEntries(Array.from({ length: n }, (_, i) => [i, 1])),
    });
    const miss = (n: number) => {
      const o = like(n);
      return meterWork(() => void Array.prototype.includes.call(o, 2));
    };
    expect(miss(64)).toBeGreaterThanOrEqual(64);
    expect(miss(4096) / miss(64)).toBeGreaterThan(32);
    // Its length read once, as natively.
    let lengthReads = 0;
    const counted = {
      get length() {
        lengthReads++;
        return 3;
      },
      0: 1,
      1: 2,
      2: 3,
    };
    expect(meterWork(() => void Array.prototype.includes.call(counted, 3))).toBeGreaterThanOrEqual(3);
    expect(lengthReads).toBe(1);
    // exec on an object that becomes a long string: converted once, a miss charged its length.
    const execMiss = (n: number) => {
      let conversions = 0;
      const o = {
        toString() {
          conversions++;
          return "a".repeat(n);
        },
      };
      const w = meterWork(() => void /b/.exec(o as unknown as string));
      expect(conversions).toBe(1);
      return w;
    };
    expect(execMiss(64)).toBeGreaterThanOrEqual(64);
    expect(execMiss(4096) / execMiss(64)).toBeGreaterThan(32);
    // Errors as natively: not a RegExp.
    expect(() => meterWork(() => void RegExp.prototype.exec.call({} as RegExp, "x"))).toThrow(TypeError);
  });

  it("iterating a string or an array is charged a step each — spreading, for…of, Array.from", () => {
    // Review #217 (P2): `[...s]` copies the whole text as surely as `Array.from(s)` does.
    expect(meterWork(() => void [...text])).toBeGreaterThanOrEqual(text.length);
    expect(meterWork(() => void Array.from(text))).toBeGreaterThanOrEqual(text.length);
    expect(
      meterWork(() => {
        for (const c of text) void c;
      }),
    ).toBeGreaterThanOrEqual(text.length);
    const arr = Array.from({ length: 10_000 }, (_, i) => i);
    expect(meterWork(() => void [...arr])).toBeGreaterThanOrEqual(arr.length);
    expect(
      meterWork(() => {
        for (const [i] of arr.entries()) void i;
      }),
    ).toBeGreaterThanOrEqual(arr.length);
  });

  it("an iterator stays the engine's own: its helpers are there, and their steps are counted", () => {
    // Review #217 2차 (P3): a stand-in object lost `take`, `map`, `toArray`…
    // `take` is newer than the ES2023 lib the types know: looked up through a typed view.
    type Helpers = { take?: (n: number) => { toArray(): number[] } };
    const helpers = (it: unknown) => it as Helpers;
    const outside = typeof helpers([].values()).take;
    let inside = "";
    let taken: number[] = [];
    const arr = Array.from({ length: 10_000 }, (_, i) => i);
    const w = meterWork(() => {
      inside = typeof helpers([].values()).take;
      const it = helpers(arr.values());
      if (it.take) taken = it.take(3).toArray();
    });
    expect(inside).toBe(outside);
    if (outside === "function") {
      expect(taken).toEqual([0, 1, 2]);
      expect(w).toBeLessThan(20);
    }
  });

  it("puts every built-in back, also when the call throws", () => {
    const names = (o: object) =>
      Reflect.ownKeys(o).map((k) => [k, Object.getOwnPropertyDescriptor(o, k)] as const);
    const before = [String.prototype, Array.prototype, RegExp.prototype, Array].map(names);
    expect(() =>
      meterWork(() => {
        "x".slice(0);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const after = [String.prototype, Array.prototype, RegExp.prototype, Array].map(names);
    for (const [i, list] of before.entries())
      for (const [j, [k, d]] of list.entries()) {
        expect(after[i]![j]![0]).toBe(k);
        expect(after[i]![j]![1]!.value).toBe(d!.value);
      }
    expect(Array.prototype.values).toBe(Array.prototype[Symbol.iterator]);
  });
});
