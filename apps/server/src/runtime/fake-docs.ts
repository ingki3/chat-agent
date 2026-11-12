import type { DocContent } from "@agentlee/shared";

/**
 * Document generation scenarios (#49) for the FakeRuntime, the e2e run and the Claude / Codex replays: "이 내용을
 * DOCX 보고서로" as real calls of our MCP tools — `doc_create` with a fixed report, then `artifact_create` linking the
 * file as a `document` artifact — and a short answer. The same report in every runtime, so the tests can open the
 * file and find its title, table and paragraphs.
 */

export const DOC_FIXTURE: DocContent = {
  title: "제주 가족 여행 보고서",
  subtitle: "2026년 10월 · 3박 4일",
  author: "이아들",
  blocks: [
    { type: "heading", text: "여행 개요" },
    {
      type: "paragraph",
      text: "가족 네 명이 제주도 동쪽을 중심으로 여행했다. 날씨가 맑아 계획한 일정을 모두 소화했다.",
    },
    { type: "list", items: ["성산일출봉 오르기", "우도 자전거 일주", "만장굴 탐방"] },
    { type: "heading", text: "경비 정리" },
    {
      type: "table",
      caption: "항목별 경비",
      columns: ["항목", "금액(원)", "비고"],
      rows: [
        ["숙박", 480000, "3박"],
        ["렌터카", 210000, null],
        ["식비", 356000, "=SUM(B2:B3)"],
      ],
    },
    { type: "paragraph", text: "총 경비는 104만 6천 원으로 예산 안에서 마쳤다." },
    { type: "references", items: ["제주관광공사 (2026). 제주 여행 안내서. https://example.org/jeju"] },
  ],
};

/** Text that must be in every generated file (the fixture tests read it back). */
export const DOC_FIXTURE_TEXT = {
  title: DOC_FIXTURE.title,
  paragraph: "가족 네 명이 제주도 동쪽을 중심으로 여행했다.",
  cells: ["항목", "금액(원)", "숙박", "480000", "렌터카", "=SUM(B2:B3)"],
} as const;

export type DocCall = { tool: "doc_create" | "artifact_create"; input: Record<string, unknown> };

/** The calls of one "make it a <kind> file" turn: the file, then its `document` artifact (`$0.…` = the file). */
export function docScenario(kind: string, imageFileId?: string): { calls: DocCall[]; answer: string } {
  const blocks = imageFileId
    ? [...DOC_FIXTURE.blocks, { type: "image", fileId: imageFileId, caption: "올린 사진" }]
    : DOC_FIXTURE.blocks;
  const create: DocCall = { tool: "doc_create", input: { kind, ...DOC_FIXTURE, blocks } };
  // HWP is refused with a guidance message (FR-4.4): there is no file to link.
  if (kind === "hwp" || kind === "hwpx")
    return { calls: [create], answer: "한글 파일은 만들 수 없어요. DOCX나 PDF로 만들어 드릴까요?" };
  return {
    calls: [
      create,
      {
        tool: "artifact_create",
        input: {
          kind: "document",
          title: DOC_FIXTURE.title,
          document: { fileId: "$0.fileId", name: "$0.name", mimeType: "$0.mediaType" },
        },
      },
    ],
    answer: `${kind.toUpperCase()} 파일로 만들었어요. 아래에서 내려받을 수 있어요.`,
  };
}
