import { describe, expect, it } from "vitest";
import { IDLE, enter, free, type EnterContext } from "../src/chat/deferred-send.js";

const ctx = (c: Partial<EnterContext> = {}): EnterContext => ({
  text: "다음 질문",
  fileIds: ["f1"],
  sending: false,
  uploading: false,
  busy: false,
  finishing: false,
  ...c,
});
const inWindow = { busy: true, finishing: true };
const q = { text: "다음 질문", fileIds: ["f1"] };

describe("Enter while the composer cannot send yet (#141)", () => {
  it("sends at once, text and files, when the composer is free", () => {
    expect(enter(IDLE, ctx())).toEqual({ next: IDLE, send: q });
  });

  it("queues an Enter after `done` with its text and files, and sends exactly that once free", () => {
    const s = enter(IDLE, ctx(inWindow));
    expect(s).toEqual({ next: { queued: q, hint: null }, send: null });
    expect(free(s.next, { text: "다음 질문", fileIds: ["f1"] })).toEqual({ next: IDLE, send: q });
  });

  it("the queue is a snapshot: later changes to the input or the files do not alter it", () => {
    const fileIds = ["f1"];
    const s = enter(IDLE, ctx({ ...inWindow, fileIds }));
    fileIds.push("f2");
    expect(s.next.queued?.fileIds).toEqual(["f1"]);
  });

  it("a queue that no longer matches the composer is dropped, never sent with other content", () => {
    const s = enter(IDLE, ctx(inWindow)).next;
    for (const now of [
      { text: "고친 질문", fileIds: ["f1"] },
      { text: "다음 질문", fileIds: [] }, // a file removed
      { text: "다음 질문", fileIds: ["f1", "f2"] }, // a file added (its upload done)
    ])
      expect(free(s, now)).toEqual({ next: IDLE, send: null });
  });

  it("only hints while the reply is still being written: nothing is sent later", () => {
    const s = enter(IDLE, ctx({ busy: true }));
    expect(s).toEqual({ next: { queued: null, hint: "busy" }, send: null });
    expect(free(s.next, q)).toEqual({ next: IDLE, send: null });
  });

  it("hints while a file is uploading — in the inWindow, while streaming, or idle — and queues nothing", () => {
    for (const c of [
      ctx({ uploading: true }),
      ctx({ ...inWindow, uploading: true }),
      ctx({ busy: true, uploading: true }),
    ]) {
      const s = enter(IDLE, c);
      expect(s).toEqual({ next: { queued: null, hint: "uploading" }, send: null });
      expect(free(s.next, q).send).toBeNull();
    }
  });

  it("an Enter in the inWindow again keeps one queued send", () => {
    const once = enter(IDLE, ctx(inWindow)).next;
    const twice = enter(once, ctx(inWindow));
    expect(twice.next).toEqual({ queued: q, hint: null });
    expect(free(twice.next, q).send).toEqual(q);
  });

  it("nothing to send (empty, already sending) changes nothing", () => {
    const queued = { queued: q, hint: null };
    for (const c of [ctx({ text: "  \n" }), ctx({ sending: true })]) {
      expect(enter(IDLE, c)).toEqual({ next: IDLE, send: null });
      expect(enter(queued, c)).toEqual({ next: queued, send: null });
    }
  });

  it("free without a queued Enter sends nothing", () => {
    expect(free(IDLE, q)).toEqual({ next: IDLE, send: null });
  });
});
