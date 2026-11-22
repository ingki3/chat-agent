/**
 * Chat answers for the #202 missing-citation check (#233 review 3): the report-only Markdown changes in
 * `packages/shared` must leave the chat's units, markers and missing ranges exactly as they were.
 */
export const CHAT_CITATION_CORPUS: readonly string[] = [
  "수출이 늘었다[1]. 근거 없는 문장이다.\n\n두 번째 문단이다[2][3].",
  "## 요약\n\n- 항목이다[1]\n- 근거 없는 항목\n\n> 인용문이다[2].\n> 이어진다.",
  "| 자료 | 값 |\n|---|---|\n| 가 | 32%[1] |\n| 나 | 28% |\n\n출처: 통계청[2]",
  "| 가 | 나 |\n|---|---|\n| 값 | 사실 | 숨은[1] |",
  "코드 `a[1]`와 링크 [1](https://x.test), 자동 <https://x.test/[2]>도 있다[3].\n\n```\nb[4]\n```",
  "각주가 있다[^1] 그리고 표시[2].\n\n[^1]: 각주 본문이다[3].",
  // A hard line break written with a backslash (no trailing spaces in the snapshot).
  "![그림 **99%**](https://x.test/a.png) 설명이다[1].\\\n강제 줄바꿈 뒤다.",
  "<b>99%</b> 원문이다[1].\n\n<div>블록 HTML[2]</div>\n\n※ 출처가 부족해요.",
  "10. 비교\n\n    | 지역 | 값 |\n    |---|---|\n    | 서울 | 40%[1] |\n\n> 💡 분석\n> 해석이다[2].",
  "[정책][ref]을 봤다[1].\n\n[ref]: https://x.test\n\n$$\nx[2]\n$$\n\n수식 $a[3]$도 있다.",
];
