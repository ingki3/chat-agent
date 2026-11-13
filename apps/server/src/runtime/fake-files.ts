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

/** The third table's second row of 과제안내.hwp (`fixtures/extract/assignment.hwp`, make-hwp-fixtures.py). */
export const ASSIGNMENT_TABLE3_ROW2 = "학교 누리집 과제방에 PDF로 올립니다.";
/** The OCR text of the scanned page (`fixtures/extract/scanned.pdf`, second line). */
export const SCANNED_LINE2 = "가족 과제 안내문 확인";

const FIRST = "$0.items.0.fileId";
const SECOND = "$0.items.1.fileId";

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
  /** 과제안내.hwp: one sentence of the third table's second row (#24: the viewer opens and highlights that row). */
  table3: {
    calls: [
      { tool: "file_list", input: {} },
      { tool: "file_cite", input: { fileId: FIRST, snippet: ASSIGNMENT_TABLE3_ROW2 } },
    ],
    answer: "과제는 학교 누리집 과제방에 PDF로 올려요[1].",
  },
  /** A scanned PDF: a line OCR read (#24: the viewer shows the passage's box on the page). */
  scan: {
    calls: [
      { tool: "file_list", input: {} },
      { tool: "file_cite", input: { fileId: FIRST, snippet: SCANNED_LINE2, page: 1 } },
    ],
    answer: "스캔한 안내문에는 가족 과제 안내문을 확인하라고 적혀 있어요[1].",
  },
  /**
   * 수용 기준 2: a PDF and an HWP compared — the first upload is report.pdf, the second 과제안내.hwp. Every citation
   * names its file and place (12쪽, 3번째 표 · 2행 · 2열).
   */
  compare: {
    calls: [
      { tool: "file_list", input: {} },
      { tool: "file_read", input: { fileId: FIRST, from: 12, to: 12 } },
      { tool: "file_read", input: { fileId: SECOND } },
      { tool: "file_cite", input: { fileId: FIRST, snippet: REPORT_PAGE12.summary, page: 12 } },
      { tool: "file_cite", input: { fileId: SECOND, snippet: ASSIGNMENT_TABLE3_ROW2 } },
    ],
    answer:
      "## 두 문서 비교\n\n보고서는 강 정화 활동으로 쓰레기 340kg을 치웠다고 해요[1]. 과제 안내문은 결과를 학교 누리집 과제방에 PDF로 올리라고 해요[2].",
  },
} satisfies Record<string, FileScenario>;
export type FileScenarioName = keyof typeof FILE_SCENARIOS;
