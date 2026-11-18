import { describe, expect, it } from "vitest";
import type { MessagePart } from "@agentlee/shared";
import { sourceKindOf, usedSourceKinds } from "../src/sources/provenance.js";

/** Where an answer's sources come from (#185): the tools it called, one registry for every kind. */
describe("source provenance (#185)", () => {
  it("each source tool has its kind, with or without the runtime prefix; other tools bring no source", () => {
    const cases: [string, string | undefined][] = [
      ["web_search", "web"],
      ["mcp__agentlee__web_fetch", "web"],
      ["sources_list", "web"],
      ["cite", "web"],
      ["mcp__agentlee__skill_search-google", "web"],
      ["skill_google-news-search-skill", "web"],
      ["file_read", "file"],
      ["mcp__agentlee__file_search", "file"],
      ["file_cite", "file"],
      ["us_quote", "finance"],
      ["mcp__agentlee__kr_quote", "finance"],
      ["finance_chart", "finance"],
      ["skill_kr-stock-skill", "finance"],
      // A transcript is reached as a file (file_read / file_cite); making one is not citing it.
      ["audio_transcribe", undefined],
      ["artifact_create", undefined],
      ["memory_propose", undefined],
      ["python_run", undefined],
      ["Bash", undefined],
    ];
    for (const [name, kind] of cases) expect(sourceKindOf(name), name).toBe(kind);
  });

  it("an answer's kinds are those of its tool calls — never of its text", () => {
    const call = (name: string): MessagePart => ({ type: "tool_call", id: name, name, input: {} });
    expect([...usedSourceKinds([{ type: "text", text: "349.8달러, 출처 [1]" }])]).toEqual([]);
    expect(
      [...usedSourceKinds([call("us_quote"), call("web_fetch"), call("artifact_create")])].sort(),
    ).toEqual(["finance", "web"]);
  });
});
