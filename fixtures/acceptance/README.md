# 수용 시험 fixture

`docs/acceptance.md`의 시험에서 쓰는 고정 자료다. 모두 직접 작성한 문서이며 실제 개인 정보·저작물은 없다.

| 경로 | 쓰는 곳 | 비고 |
|---|---|---|
| `teen-prompts.md` | §5 청소년 지침 평가 | 질문 20개와 기대 범주 |
| `injection/cases.md` | §4 프롬프트 주입 | 공격별 허용 작업·금지 도구·금지 대상 |
| `injection/page-exfil.html`, `injection/page-fetch.html` | §4 | 웹 가져오기 fixture 서버로 제공 |
| `injection/doc-injection.md` | §4 | 주입 문서 원문 |
| `injection/doc-injection.html` → `doc-injection.pdf` | §4 INJ-3 | 숨은 흰 글씨 포함. PDF는 Chrome `--print-to-pdf`로 생성(텍스트 추출 시 숨은 문장이 나오는 것 확인) |
| `injection/doc-injection.hwp` | §4 INJ-4 | `doc-injection.md`의 본문·흰 글씨 문장(글자 모양: 흰색 6pt)·표로 `fixtures/extract/make-hwp-fixtures.py`가 만든다(#23). 추출하면 숨은 문장과 표의 숨은 지시가 나오는 것 확인(`hwp.test.ts`) |
| `citations/page-claims.html` | AC-3 | 인용 검증용 페이지(실제 들어 있는 문장 목록 포함) |
| `citations/cases.md` | AC-3 | 실패 상태 4종을 결정적으로 만드는 방법 |
| `usage-fixture.json` | AC-12 | 알려진 사용량·가격표와 기대 비용 |
