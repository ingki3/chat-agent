import { describe, expect, it } from "vitest";
import { IDLE, enter, free, type EnterContext } from "../src/chat/deferred-send.js";

const ctx = (c: Partial<EnterContext> = {}): EnterContext => ({
  text: "다음 질문",
  sending: false,
  uploading: false,
  busy: false,
  finishing: false,
  ...c,
});

describe("Enter while the composer is busy (#141)", () => {
  it("sends at once when the composer is free", () => {
    expect(enter(IDLE, ctx())).toEqual({ next: IDLE, send: true });
  });

  it("queues an Enter that comes after `done`, before the run is confirmed ended", () => {
    const s = enter(IDLE, ctx({ busy: true, finishing: true }));
    expect(s).toEqual({ next: { queued: true, hint: false }, send: false });
    // …and sends it once the composer is free again.
    expect(free(s.next)).toEqual({ next: IDLE, send: true });
  });

  it("only hints while the reply is still being written: nothing is sent later", () => {
    const s = enter(IDLE, ctx({ busy: true }));
    expect(s).toEqual({ next: { queued: false, hint: true }, send: false });
    expect(free(s.next)).toEqual({ next: IDLE, send: false });
  });

  it("an Enter in the window again keeps one queued send", () => {
    const once = enter(IDLE, ctx({ busy: true, finishing: true })).next;
    const twice = enter(once, ctx({ busy: true, finishing: true }));
    expect(twice.next).toEqual({ queued: true, hint: false });
    expect(free(twice.next).send).toBe(true);
  });

  it("nothing to send (empty, already sending, uploading) changes nothing", () => {
    const queued = { queued: true, hint: false };
    for (const c of [ctx({ text: "  \n" }), ctx({ sending: true }), ctx({ uploading: true, busy: true })]) {
      expect(enter(IDLE, c)).toEqual({ next: IDLE, send: false });
      expect(enter(queued, c)).toEqual({ next: queued, send: false });
    }
  });

  it("free without a queued Enter sends nothing", () => {
    expect(free(IDLE)).toEqual({ next: IDLE, send: false });
  });
});
