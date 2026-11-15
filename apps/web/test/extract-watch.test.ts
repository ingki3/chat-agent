import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EXTRACT_CODE_TEXT, type FileExtract, type UploadedFile } from "@agentlee/shared";
import { AttachmentChips, restoreChips } from "../src/chat/Attachments.js";
import { extractNotice, watchExtract } from "../src/chat/extract-watch.js";

type E = Pick<FileExtract, "status" | "code">;
const noSleep = async () => {};

describe("the chip says at once when the server cannot read a file (#23, FR-4.4)", () => {
  it("a failed extraction is its fixed words; ok and pending say nothing", () => {
    expect(extractNotice({ status: "failed", code: "extract_encrypted" })).toBe(
      EXTRACT_CODE_TEXT.extract_encrypted,
    );
    expect(extractNotice({ status: "failed", code: "extract_distribution" })).toBe(
      "배포용(편집 제한) 문서라 읽을 수 없어요",
    );
    expect(extractNotice({ status: "failed", code: null })).toBe(EXTRACT_CODE_TEXT.extract_failed);
    expect(extractNotice({ status: "ok", code: null })).toBeUndefined();
    expect(extractNotice({ status: "pending", code: null })).toBeUndefined();
  });

  it("reads until the extraction is no longer pending; passing errors are tried again", async () => {
    const answers: (E | Error)[] = [
      { status: "pending", code: null },
      new Error("network"),
      { status: "failed", code: "extract_distribution" },
    ];
    let reads = 0;
    const notice = await watchExtract(
      async () => {
        const a = answers[reads++]!;
        if (a instanceof Error) throw a;
        return a;
      },
      { sleep: noSleep },
    );
    expect([notice, reads]).toEqual([EXTRACT_CODE_TEXT.extract_distribution, 3]);
  });

  it("gives up after its tries, and stops once the chip is gone", async () => {
    let reads = 0;
    const pending = async (): Promise<E> => {
      reads++;
      return { status: "pending", code: null };
    };
    expect(await watchExtract(pending, { tries: 4, sleep: noSleep })).toBeUndefined();
    expect(reads).toBe(4);
    reads = 0;
    let gone = false;
    const n = watchExtract(
      async () => {
        gone = true;
        return pending();
      },
      { stopped: () => gone, sleep: noSleep },
    );
    expect(await n).toBeUndefined();
    expect(reads).toBe(1);
  });
});

describe("the notice is never lost (review #120)", () => {
  it("keeps reading past any number of pending answers, waiting longer each time (up to the cap)", async () => {
    let reads = 0;
    const waits: number[] = [];
    const notice = await watchExtract(
      async (): Promise<E> =>
        ++reads <= 40 ? { status: "pending", code: null } : { status: "failed", code: "extract_encrypted" },
      { sleep: async (ms) => void waits.push(ms), delayMs: 1000, maxDelayMs: 15_000 },
    );
    expect([notice, reads]).toEqual([EXTRACT_CODE_TEXT.extract_encrypted, 41]);
    expect(waits.slice(0, 3)).toEqual([1000, 1500, 2250]);
    expect(Math.max(...waits)).toBe(15_000);
  });

  it("chips restored after a reload are registered, then watched; sent or already shown files are not", () => {
    const file = (id: string, messageId: string | null) =>
      ({ id, name: `${id}.hwp`, bytes: 10, messageId, uploadId: null }) as unknown as UploadedFile;
    const seen = new Set(["shown"]);
    const order: string[] = [];
    const chips = restoreChips(
      [file("a", null), file("sent", "m1"), file("shown", null)],
      seen,
      (cs) => order.push(`register ${cs.map((c) => c.file!.id).join(",")}`),
      (_key, id) => order.push(`watch ${id}`),
    );
    expect(chips.map((c) => c.file!.id)).toEqual(["a"]);
    expect(order[0]).toBe("register a");
    expect(order[1]).toBe("watch a");
    expect(seen.has("a")).toBe(true);
    // Shown once: not again.
    expect(
      restoreChips(
        [file("a", null)],
        seen,
        () => order.push("x"),
        () => order.push("y"),
      ),
    ).toEqual([]);
    expect(order).toHaveLength(2);
  });

  it("the chip shows the final notice", () => {
    const html = renderToStaticMarkup(
      createElement(AttachmentChips, {
        items: [
          {
            key: "k",
            name: "안내.hwp",
            bytes: 10,
            status: "done",
            notice: EXTRACT_CODE_TEXT.extract_distribution,
          },
        ],
        onRemove: () => {},
      }),
    );
    expect(html).toContain('data-testid="attachment-notice"');
    expect(html).toContain("배포용(편집 제한) 문서라 읽을 수 없어요");
  });
});
