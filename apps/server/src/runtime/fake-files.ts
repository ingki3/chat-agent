/**
 * File citation scenarios (#48, 수용 기준 2·11): "이 PDF 12쪽 요약" as real calls of our file tools on the
 * conversation's first upload — the fixture `fixtures/extract/report.pdf` (12 pages). Used by the FakeRuntime
 * (`/file-page12`, FAKE_RUNTIME=1 — the e2e run) and by the Claude and Codex replay tests, so the same scenario
 * goes through every runtime. The extraction, the tools and the citation check are the real ones.
 *
 * Inputs may refer to an earlier call's result like the web scenarios (`"$0.items.0.fileId"`, fake-citations.ts).
 */
export type FileCall = {
  tool: "file_list" | "file_read" | "file_search" | "file_cite";
  input: Record<string, unknown>;
};
export type FileScenario = { calls: FileCall[]; answer: string };

/** Page 12 of report.pdf, as its text layer has it (fixtures/extract/make-fixtures.py). */
export const REPORT_PAGE12 = {
  summary: "Summary: the river clean-up removed 340 kg of waste.",
  volunteers: "Volunteers from 12 schools joined in March 2026.",
};

const FIRST = "$0.items.0.fileId";

export const FILE_SCENARIOS = {
  /** Summarise page 12: list the files, read page 12, cite two of its sentences. Both verified, on page 12. */
  page12: {
    calls: [
      { tool: "file_list", input: {} },
      { tool: "file_read", input: { fileId: FIRST, from: 12, to: 12 } },
      { tool: "file_cite", input: { fileId: FIRST, snippet: REPORT_PAGE12.summary, page: 12 } },
      { tool: "file_cite", input: { fileId: FIRST, snippet: REPORT_PAGE12.volunteers, page: 12 } },
    ],
    answer:
      "## 12쪽 요약\n\n강 정화 활동으로 쓰레기 340kg을 치웠어요[1]. 2026년 3월에 12개 학교의 자원봉사자가 함께했어요[2].",
  },
  /** A passage the file does not have: shown with a warning, never as normal. */
  missing: {
    calls: [
      { tool: "file_list", input: {} },
      {
        tool: "file_cite",
        input: { fileId: FIRST, snippet: "The river project was cancelled in 2025.", page: 12 },
      },
    ],
    answer: "보고서에는 사업이 취소됐다고 나와요[1].",
  },
} satisfies Record<string, FileScenario>;
export type FileScenarioName = keyof typeof FILE_SCENARIOS;
