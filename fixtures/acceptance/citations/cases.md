# AC-3 인용 실패 상태 만들기

자동 시험(#25)은 FakeRuntime이 정해진 `cite` 도구 호출을 내보내게 해서, 각 상태를 결정적으로 만든다. 실제 런타임 시험은 같은 페이지로 수동 1회 기록한다.

| 상태 | 만드는 방법 | 기대 표시 |
|---|---|---|
| `verified` | `page-claims.html`을 가져온 뒤 snippet "1377년에 금속 활자로 인쇄되었다"로 `cite` | 원문 구절 확인 |
| `snippet_not_found` | 같은 페이지에 snippet "1500년에 처음 발명되었다"로 `cite` | ⚠️ 출처에서 이 내용을 찾지 못했어요 |
| `fetch_failed` | fixture 서버의 `/missing.html`(404 응답)을 가져온 뒤 `cite` | ⚠️ 출처를 가져오지 못했어요 |
| `unknown_source` | 등록되지 않은 sourceId로 `cite`, 또는 다른 대화의 sourceId로 `cite` | ⚠️ 출처를 확인할 수 없어요 |
| 출처 표시 없음 | 웹 도구를 쓴 답변에 `cite` 없는 본문 문단 포함 | "일부 내용에 출처 표시 없음" 경고 + 해당 문단 표시 |
