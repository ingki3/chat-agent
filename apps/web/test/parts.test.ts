import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { REDACTED, type PublicPart, type StreamEvent } from "@agentlee/shared";
import { Parts, segments, summarize } from "../src/chat/Parts.js";
import { applyEvent, emptyLive } from "../src/chat/stream.js";

const render = (parts: PublicPart[], streaming = false) =>
  renderToStaticMarkup(createElement(Parts, { parts, streaming }));

describe("applyEvent", () => {
  const ev = (e: Omit<StreamEvent & { messageId?: string }, "messageId">) =>
    ({ messageId: "m", ...e }) as StreamEvent;
  it("rebuilds the parts the same way the server stores them", () => {
    let l = emptyLive("r", "m");
    l = applyEvent(l, ev({ type: "delta", partIndex: 0, text: "도구를 " } as StreamEvent));
    l = applyEvent(l, ev({ type: "delta", partIndex: 0, text: "쓸게요." } as StreamEvent));
    l = applyEvent(
      l,
      ev({ type: "tool_start", callId: "c1", name: "web_search", input: { q: 1 } } as StreamEvent),
    );
    l = applyEvent(l, ev({ type: "tool_end", callId: "c1", output: { n: 3 } } as StreamEvent));
    l = applyEvent(l, ev({ type: "delta", partIndex: 3, text: "끝" } as StreamEvent));
    expect(l.parts).toEqual([
      { type: "text", text: "도구를 쓸게요." },
      { type: "tool_call", id: "c1", name: "web_search", input: { q: 1 } },
      { type: "tool_result", callId: "c1", output: { n: 3 } },
      { type: "text", text: "끝" },
    ]);
  });
  it("keeps unchanged parts by identity (memoised rendering skips them)", () => {
    let l = emptyLive("r", "m");
    l = applyEvent(l, { type: "delta", messageId: "m", partIndex: 0, text: "a" });
    l = applyEvent(l, { type: "tool_start", messageId: "m", callId: "c", name: "t" });
    const first = l.parts[0];
    l = applyEvent(l, { type: "tool_end", messageId: "m", callId: "c" });
    expect(l.parts[0]).toBe(first);
  });
  it("records notices, errors and the final status", () => {
    let l = emptyLive("r", "m");
    l = applyEvent(l, { type: "notice", level: "warn", code: "usage_limit", message: "한도" });
    l = applyEvent(l, { type: "error", code: "usage_limit", message: "사용 한도에 도달했어요." });
    l = applyEvent(l, { type: "done", messageId: "m", status: "error" });
    expect(l.notices).toEqual([{ level: "warn", code: "usage_limit", message: "한도" }]);
    expect(l.error?.code).toBe("usage_limit");
    expect(l.status).toBe("error");
  });
});

describe("Parts", () => {
  it("groups consecutive tool parts into one status line", () => {
    const s = segments([
      { type: "text", text: "a" },
      { type: "tool_call", id: "1", name: "x", input: null },
      { type: "tool_call", id: "2", name: "y", input: null },
      { type: "tool_result", callId: "1", output: null },
      { type: "text", text: "b" },
    ]);
    expect(s.map((x) => x.kind)).toEqual(["part", "tools", "part"]);
  });
  it("links a result to its call even with text in between, and gives the result no line of its own", () => {
    const parts: PublicPart[] = [
      { type: "tool_call", id: "1", name: "web_search", input: { q: "a" } },
      { type: "text", text: "찾는 중이에요" },
      { type: "tool_result", callId: "1", output: { n: 3 }, isError: true },
    ];
    expect(segments(parts).map((x) => x.kind)).toEqual(["tools", "part"]);
    const html = render(parts);
    expect(html).toContain("도구 사용 1개 · web_search · 실패 1개");
    expect(html).toContain("{&quot;n&quot;:3}");
    expect(html).not.toContain("결과 없음");
    expect(html).not.toContain("도구 사용 0개");
  });
  it("shows running tools while streaming and a summary afterwards", () => {
    const parts: PublicPart[] = [{ type: "tool_call", id: "1", name: "web_search", input: { q: "a" } }];
    expect(render(parts, true)).toContain("web_search 실행 중…");
    const done: PublicPart[] = [
      ...parts,
      { type: "tool_result", callId: "1", output: { n: 3 }, isError: true },
    ];
    const html = render(done);
    expect(html).toContain("도구 사용 1개 · web_search · 실패 1개");
    expect(html).toContain("{&quot;q&quot;:&quot;a&quot;}");
  });
  it("never shows secret fields of tool inputs or outputs", () => {
    const s = summarize({ query: "x", apiKey: "abc", nested: { password: "p" }, auth: "Bearer zzz", n: 5 });
    expect(s).not.toMatch(/abc|"p"|zzz/);
    expect(s).toContain(REDACTED);
    expect(s).toContain('"n":5');
    expect(summarize("sk-ant-abcdefghijklmnop")).toBe(REDACTED);
  });
  it("renders a structured table part with numbers aligned right, source and date", () => {
    const html = render([
      {
        type: "table",
        columns: [
          { key: "name", label: "종목" },
          { key: "price", label: "종가", unit: "원" },
        ],
        rows: [
          { name: "삼성전자", price: 71200 },
          { name: "<b>x</b>", price: null },
        ],
        source: "KRX",
        asOf: "2026-11-10",
      },
    ]);
    expect(html).toContain('<td class="num">71,200</td>');
    expect(html).toContain('<td class="num">—</td>');
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("출처: KRX · 기준: 2026-11-10");
  });
  it("renders runtime-switch and summary dividers", () => {
    const html = render([
      { type: "divider", kind: "runtime_switch", label: "", runtime: "codex", model: "gpt-6.1-sol" },
      { type: "divider", kind: "summary", label: "" },
    ]);
    expect(html).toContain("여기부터");
    expect(html).toContain("Codex · gpt-6.1-sol");
    expect(html).toContain("앞부분은 요약해서 넘겼어요");
  });
});
