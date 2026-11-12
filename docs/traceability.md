# 요구사항 추적표

PRD v0.5의 모든 항목이 어느 이슈에서 구현되고 어떻게 검증되는지 보여준다. 이슈 PR을 머지할 때 해당 행의 상태를 갱신한다. `pnpm test`가 PRD를 파싱해 이 표의 **담당 이슈** 칸에 이슈가 없는 항목을 찾는다(`scripts/traceability.ts`, `scripts/test/traceability.test.ts`). v1.1로 미룬 항목은 추적 이슈(#64)를 가리켜야 한다.

**검증 방법**: U 단위 테스트 · I 통합 테스트(서버 inject, 실제 DB) · E E2E(Playwright) · M 수동 확인(기록 필수) · S 정적 검토(리뷰 에이전트)
**상태**: ⬜ 미착수 · 🟨 진행 중 · ✅ 완료(머지 + 검증 기록)

## 기능 요구사항 (FR)

| 항목 | 내용 | 담당 이슈 | 검증 | 상태 |
|---|---|---|---|---|
| FR-1.1 | 가족 계정 생성, 첫 실행 관리자, 임시 비밀번호 | #9, #41, #35 | I, E | 🟨 (#35 관리자 화면 사용자 탭: 추가(청소년 표시 포함)·임시 비밀번호·초기화·비활성화 — `e2e/admin.spec.ts`) |
| FR-1.2 | 비밀번호 로그인, 세션 쿠키 속성 | #9 | U, I | ✅ |
| FR-1.3 | 외부 두 겹 인증, 로컬 예외, Access·앱 이메일 일치 | #8, #9, #36 | I, M | 🟨 |
| FR-1.4 | Access JWT 검증 | #9 | U, I | 🟨 |
| FR-1.5 | 역할, 본인·공유만 열람, 관리자도 내용 불가 | #10, #29 | I | 🟨 |
| FR-1.6 | 사용자별 런타임·모델·스킬 허용 | #17, #21, #35 | I, E | 🟨 (#17 런타임·모델·추론 강도·연결 허용 정책과 공통 검사 함수 — 보내기·고치기·다시 생성에 403. #21 스킬: `users.permissions.skills`·`PUT /api/admin/users/:id/skills`, 사용자별 도구 목록·호출 거부 — `skills.test.ts`. #30 청소년 계정은 `"all"`이어도 금융 스킬·도구 숨김 — `finance.test.ts`. #35 관리자 화면 권한 탭(런타임·모델·추론 강도·개인/공용 연결 허용·스킬·처음 기본값), 스킬 한 개씩 켜기 `PUT /api/admin/users/:id/skills/:name`(청소년 금융 숨김 유지), 서버 허용 목록 `PUT /api/admin/skills/:name`. 아들 Haiku 해제 → `/api/runtimes`·설정 선택기에서 빠지고 실행·기본값 저장 403 — `admin.test.ts`·`e2e/admin.spec.ts`. 칩(#19)은 그중 지금 답할 수 있는 것만 `/api/runtimes/usable`) |
| FR-2.1 | 대화 목록·새 대화·이름 변경·삭제·고정·검색 | #11, #13, #54 | I, E | 🟨 |
| FR-2.2 | 첫 메시지 뒤 제목 자동 생성 | #11 | I | 🟨 |
| FR-2.3 | 대화 간 맥락 분리 | #11, #42, #45 | I | 🟨 (#45 새 세션 맥락은 그 대화의 활성 기록·요약·참조만, 세션은 대화별 — `context.test.ts`) |
| FR-2.4 | 사이드바 "가족 공유" 묶음 | #13, #52 | E | 🟨 |
| FR-2.5 | 프로젝트 (v1.1 선택) | #64 (v1.1 백로그) | — | v1.1 |
| FR-2.6 | 새로고침·다른 기기에서 이어짐 | #11, #12, #13 | E | 🟨 |
| FR-3.1 | 스트리밍, 중지 | #12, #14, #15, #16 | I, E, M | 🟨 (#14 화면·FakeRuntime E2E, 실제 런타임은 #15·#16) |
| FR-3.2 | 마크다운·표·코드·수식·링크 | #14 | U, E | 🟨 (#14 구현·U·E, 머지 대기) |
| FR-3.3 | 다시 생성, 수정 후 다시 보내기 | #11, #14, #45 | I, E | 🟨 (#14 화면·E2E. #45 수정·재생성 뒤 새 세션에 잘린 기록 그대로 — FakeRuntime·두 런타임 녹화 재생 `context.test.ts`·`context-replay.test.ts`) |
| FR-3.4 | 도구 진행 상태와 상세 | #14 | E | 🟨 (#14 구현·E, 비밀 필드 제거 U·I, 알려진 비밀 값 가림 — 등록부 하나·인코딩·청크 분할 성질 시험 I, 머지 대기) |
| FR-3.5 | 기본값으로 시작, 칩, 대화 중 런타임·모델·추론 강도 전환, 구분선, 넘어가는 맥락 | #19, #45, #53 | I, E, M | 🟨 (#14 칩 자리·구분선·메시지별 런타임 표시. #19 선택 단계 없는 새 대화, 칩 팝오버(허용 + `passed`만 `GET /api/runtimes/usable`, 추론 강도, 공용으로 쓰기), `PUT /api/conversations/:id/settings` 다음 메시지부터, 답이 바뀌는 자리에 구분선 — `chat-settings.test.ts`·`e2e/runtime-chip.spec.ts`. #45 이어가기 조건(같은 런타임·연결·revision·마지막 메시지·지침·요약), 모델만 변경 → `setModel`(못 하면 새 세션), 새 세션 맥락 = 서버 기록(요약 + 최근, `reasoning` 제외) + 파일·아티팩트·인용 출처 목록, Claude→Codex→Claude·수정·재생성·연결 변경에서 런타임이 받은 맥락 = 서버 원본 — `context.test.ts`·`context-replay.test.ts`, 변이 시험 16개. 실제 연결 확인은 #53) |
| FR-3.6 | 긴 대화 자동 요약 | #45 | I | 🟨 (#45 맥락 한도 비율(`CONTEXT_SUMMARY_RATIO`, 기본 0.7) 도달 시 싼 모델(허용될 때)로 요약·저장(`conversation_summaries`, 덮는 위치·해시)·재사용, 사용량 `summary`, "앞부분을 요약했어요" 구분선, 실패해도 답은 계속 — `context.test.ts`·`context-replay.test.ts`. 머지 후 ✅) |
| FR-4.1 | 드래그·붙여넣기·첨부, 여러 파일 | #22 | E | 🟨 (#22 입력창 📎·끌어다 놓기·붙여넣기, 여러 파일, 첨부 칩(올리는 중·실패·✕), 새 대화는 첫 파일에 대화 생성, 보낸 메시지의 `file_ref` → 원본 내려받기, 올리는 중 뺀 칩은 끝나면 삭제, 보내지 않은 파일은 새로고침 뒤 칩으로 복원 — `e2e/files.spec.ts`. 머지 후 ✅) |
| FR-4.2 | 지원 형식 | #22, #48, #23 | U | 🟨 (#22 받는 형식 PDF·HWP·HWPX·DOCX·XLSX·CSV·PPTX·TXT·MD·PNG·JPG(`FILE_KINDS`), 확장자 + 매직 바이트(ZIP 중앙 디렉터리·OLE `FileHeader`) 판별, 위장 확장자·SVG·HTML 거부(최선 판별 — 서빙은 항상 내려받기) — `files.test.ts`, 변이 시험 isolation.md. 추출은 #48·#23) |
| FR-4.3 | 위치 정보와 함께 추출, 스캔 OCR | #48 | U | ⬜ |
| FR-4.4 | HWP·HWPX 처리, 암호·배포용 거부, HWP 생성 제외 | #23, #49 | U, M | ⬜ |
| FR-4.5 | 파일 인용 → 뷰어 위치 열기·강조 | #24 | E | ⬜ |
| FR-4.6 | 크기·개수 한도, 업로드 전 안내 | #22 | I, E | 🟨 (#22 파일당 50MB·대화당 20개: 화면이 올리기 전에 칩에 알림, 서버가 `Content-Length`·스트리밍 중 크기(본문을 메모리에 모으지 않음)·한 문장 조건부 INSERT로 개수(동시 21개 → 20개) 재검사 — `files.test.ts`·`e2e/files.spec.ts`, 변이 시험. 머지 후 ✅) |
| FR-4.7 | 에이전트가 만든 파일 내려받기 | #49, #22 | I | ⬜ (#22 원본 내려받기 경로 `GET /api/files/:id/content`(attachment·nosniff·샌드박스 CSP)는 올린 파일에 완료 — 에이전트가 만든 파일은 #49) |
| FR-5.1 | 번호 인용과 출처 목록 | #25, #50 | I, E | 🟨 (#50 `sources` 저장·`GET /api/conversations/:id/sources`(소유자만). #25 `cite` 번호(`[n]`)·서버 `citation_note`(실행 끝 `attachNoteTo` — 중지·복구 포함)·답변 아래 출처 목록(제목·사이트·날짜·URL·상태), 인용 없는 문단 "일부 내용에 출처 표시 없음"(제목·머리말·면책 제외) — `citation-runs.test.ts`·`e2e/citations.spec.ts`. 머지 후 ✅) |
| FR-5.2 | 인용 구절 검증, 실패 ⚠️ | #50, #25 | U, I | 🟨 (#25 `cite {sourceId, snippet}` → 저장 본문과 대조(NFKC·따옴표·대시·공백·대소문자 정규화 후 통째 일치, 단어·숫자 경계, 8자 이상) → `verified`·`snippet_not_found`·`fetch_failed`·`unknown_source`(다른 대화·다른 사용자 — 범위는 토큰에서만), `citations` 표(0016). 실패는 화면 모든 경로에서 ⚠️ — `citations.test.ts`·`apps/web/test/citations.test.ts`, 변이 시험 36개 isolation.md) |
| FR-5.3 | 미리보기, 원문 열기 | #25 | E | 🟨 (#25 데스크톱 hover·모바일 탭 → 상태·인용 구절·"원문 열기"(http(s)만, 새 창 `noopener`) — `e2e/citations.spec.ts` 두 프로젝트. 머지 후 ✅) |
| FR-5.4 | 날짜 명시, 출처 충돌 표시 | #20, #25 | U, M | 🟨 (#20 공통 지침·오늘 날짜 주입. #25 충돌 fixture(두 출처 각각 인용) 두 런타임 재생, 지침 `common@2`·`research@2`. 실런타임 답변 확인은 `docs/evidence/citations/checklist.md` A) |
| FR-5.5 | 자료 조사 모드 | #20, #25 | U, I, M | 🟨 (#20 대화별 토글 API·지침. #25 화면 토글 `ResearchToggle`(대화별, 서버 저장) → 다음 실행 `research@2` — `citation-runs.test.ts`·`e2e/citations.spec.ts`. 실런타임 "출처가 충분하지 않아요"는 체크리스트 B) |
| FR-5.6 | 참고문헌 내보내기 | #26 | U | ⬜ |
| FR-5.7 | 뉴스·실시간·요약 스킬 | #50, #21 | I, M | 🟨 (#21 `google-news-search-skill`, #50 `web_search`·`web_fetch`(샌드박스 작업자 + 공개 주소 송신 프록시, 두 런타임 대본 시험 `web-contract.test.ts`), 뉴스 결과 출처 등록. `news-search-skill`·`realtime-lookup-skill`·`summarize` 유튜브는 미룸 — `docs/skills.md`) |
| FR-6.1 | 아티팩트 패널 | #27, #28 | E | 🟨 (#27 저장·`artifact_create`/`artifact_update` 도구·`/a/:id` 보기 화면 — `e2e/artifacts.spec.ts`. #28 오른쪽 패널(열 때만, 주소 `?artifact=`, 900px 이하 전체 화면·`main` inert)·대화 속 카드(`artifact_ref` — 서버가 그 run이 저장한 버전으로 붙임), `/a/:id`와 같은 보기 코드(`sandbox="allow-scripts"` 한 곳) — `e2e/artifact-panel.spec.ts` 데스크톱·모바일, `artifacts.test.ts`, 변이 시험 isolation.md. 머지 후 ✅) |
| FR-6.2 | 버전, 되돌리기 | #27, #28 | I, E | 🟨 (#27 불변 `artifact_versions`(트리거)·되돌리기 = 복사한 새 버전, `POST /api/artifacts/:id/revert` — `artifacts.test.ts`·e2e. #28 패널의 버전 선택·되돌리기: 수정 요청 → v2 → v1 보기 → 되돌리기(v3 = v1 복원) — `e2e/artifact-panel.spec.ts`. 머지 후 ✅) |
| FR-6.3 | 고유 주소, 기본 비공개 | #27, #29 | I | 🟨 (#27 `/a/:id`·원본·내려받기·API 주인만, 남 403 — 권한 행렬 7행·e2e. 공유는 #29) |
| FR-6.4 | 내려받기 HTML·PNG·PDF·원본 | #28, #51 | U, I, E | 🟨 (#27 원본·SVG·CSV 내려받기, #51 PNG(차트·SVG·HTML — 차트는 클라이언트 캡처 먼저, 실패 시 서버)·PDF(HTML·차트·표·마크다운·코드): 격리 렌더러(헤드리스 셸 + #42 샌드박스·CDN 전용 송신 프록시·요청 가로채기, 쿠키·세션 없음, 시간·메모리 한도), 앱·사설 IP 차단과 샘플 생성 — `artifact-export.test.ts`·e2e·권한 행렬, 변이 시험 isolation.md. #28 패널에 같은 버튼과 원본·HTML 내려받기(차트·표는 `?format=html`, `attachment`) — `artifacts.test.ts`·`e2e/artifact-panel.spec.ts`) |
| FR-6.5 | sandbox iframe + CSP, 쿠키·API 접근 불가 | #27 | E | 🟨 (#27 `sandbox="allow-scripts"` iframe + 원본 CSP `sandbox`·`connect-src 'none'`·인라인 해시·CDN 정확한 URL+SRI. 차트가 그려진 뒤 쿠키·fetch·parent·top 실패, 허용 밖 CDN 차단, 최상위로 열어도 불투명 출처 — `e2e/artifacts.spec.ts`, 변이 시험 isolation.md. 머지 후 ✅) |
| FR-6.6 | 아티팩트 목록 화면 | #28, #52 | E | 🟨 (#28 "내가 만든 것" — 모든 대화의 내 아티팩트, 최근 순, 그 대화의 패널로 다시 열기, `GET /api/artifacts`(본인만: 가족 네 계정·비로그인 시험) — `artifacts.test.ts`·`e2e/artifact-panel.spec.ts`. "공유받은 것"은 #52까지 빈 화면) |
| FR-7.1 | 한국 주식 | #30, #21 | U, M | 🟨 (#30 `kr_quote`·`kr_index`·`kr_history`·`kr_search`·`kr_etf`(네이버 증권) — 합성 응답 스냅샷 `finance.test.ts`. 실데이터 녹화·실런타임 확인은 `docs/evidence/finance/checklist.md`) |
| FR-7.2 | 미국 주식 | #30 | U, M | 🟨 (#30 `us_*` 9개(Yahoo Finance) — 합성 응답 스냅샷. 녹화·실런타임은 체크리스트) |
| FR-7.3 | 환율(비교·환산에만) | #30, #31 | U | 🟨 (#30 `fx_usdkrw` — 비교·환산 용도 명시. 비교 화면은 #31) |
| FR-7.4 | 공시 DART·SEC | #30 | U, M | 🟨 (#30 `dart_disclosures`·`sec_8k`·`sec_form4`·`sec_13f` — 합성 응답 스냅샷, 제목은 `<external_content>`. 키(`OPENDART_API_KEY`·`SEC_USER_AGENT`)로 실호출 확인은 체크리스트) |
| FR-7.5 | 정렬 표·대화형 차트·통화 기준 | #31, #51 | U, E | ⬜ (#51 차트 저장 = PNG·PDF 내보내기 완료. 표·차트 자체는 #31) |
| FR-7.6 | 모든 숫자에 출처·기준 시각 | #30, #31 | U | 🟨 (#30 값마다 `{source, asOf, timeZone, delayed, kind}`, 휴장일 → 최근 거래일 종가, 결과 검사(`finalize`)와 답변 검사(`finance_note`) — `finance.test.ts`·`finance-runs.test.ts`·`e2e/finance.spec.ts`. 차트·표는 #31) |
| FR-7.7 | 관심 종목 | #31 | I, E | ⬜ |
| FR-7.8 | 면책 문구, 매매 금지 | #20, #30 | U | ✅ (#20 금융 지침, #30 공통 금융 출력기가 금융 도구를 쓴 모든 답변·후속 답변·예약 실행에 면책 첨부 — `finance-runs.test.ts`, 변이 시험) |
| FR-8.1 | 대화·예약 화면에서 만들기 | #55 | E | ✅ (#55 MCP 도구 `schedule_create`(두 런타임 공통)는 제안만 저장(`schedule_proposals`, 0022) → 답 아래 확인 카드 → 주인이 “예약 만들기”를 눌러야 생성(본인 세션의 API, 한 번만). 화면의 새 예약 폼 — `test/schedule-ui.test.ts`, `e2e/schedules.spec.ts`, 변이 시험. docs/ops.md §28) |
| FR-8.2 | 예약 항목, 기본값 자동 적용 | #33, #55 | I | 🟨 (#33 `schedules` 표(0020): 이름·프롬프트(저장 시 가림·재가림)·다섯 유형·시간대(기본 서울)·스킬·알림(기본 켬)·런타임·모델·추론 강도. 만들 때 안 주면 만든 사람의 기본값(FR-12.6 대체), 주면 칩과 같은 검사(403) — `test/schedules.test.ts` "schedule API". #55 폼: 기본값으로 시작, 칩(허용·사용 가능한 것만, 서버 미리보기)으로만 바꿈, 허용 안 된 모델 만들기·수정 403 — `test/schedule-ui.test.ts`) |
| FR-8.3 | 전용 대화에 결과, 새 결과 표시 | #56 | I, E | ⬜ |
| FR-8.4 | 실행 결과 알림 | #56, #34, #57 | I, M | 🟨 (#34 발행 API `schedule_succeeded`·`schedule_failed` 완료. #33 핸들러 계약의 `notify` 단계(실행 id마다 멱등, 크래시 뒤 한 번만) — 실제 발행 연결은 #56) |
| FR-8.5 | 일시정지·바로 실행·수정·삭제·이력 | #55 | E | ✅ (#55 `/schedules`: 목록·일시정지·바로 실행·수정(모든 칸, `PATCH`)·삭제·실행 이력(성공·실패·건너뜀·비용 = `priced_cost_micros` 합) — `test/schedule-ui.test.ts`, `e2e/schedules.spec.ts`. 실제 실행 결과는 #56) |
| FR-8.6 | 2분 뒤 1회 재시도, 실패 기록 | #33, #56 | U | 🟨 (#33 엔진: 실패 → 정확히 2분 뒤 1회, 결과 저장·알림은 마지막 시도만, 두 번 실패 → `failed`·이유 저장·실패 알림, 크래시한 시작도 시도로 셈 — `test/schedules.test.ts` "retry"·"crash recovery". 실제 실패 이유를 대화에 남기는 것은 #56) |
| FR-8.7 | 놓친 실행 1회, 겹침 건너뜀, 서머타임 | #33 | U | ✅ (영속 `next_run_at` + 유니크 실행 키(`schedule_runs.run_key`), 시작 시 예약당 가장 최근 놓친 회차 1회, 안 끝난 실행 중 회차 → `skipped`·`overlap`, 바로 실행은 별도 키, America/New_York 없는 시각 → 직후 03:00 1회·두 번 있는 시각 → 첫 번째 1회 — `test/schedules.test.ts`, `test/schedules-time.test.ts`, 변이 시험. docs/ops.md §25) |
| FR-8.8 | 예약 결과 공유와 알림 선택 | #52, #57 | I | ⬜ |
| FR-9.1 | API 비용 기록, 예산 v1.1 | #44, #32 | U | ✅ (#44 `usage_records`: run·attempt마다 1행, 원시 비용·토큰(미제공 NULL)·요청 수, upsert로 멱등 — 같은 attempt 두 번 → 1행, 중지·실패 실행도 기록, `test/usage.test.ts`. #32 버전 가격표 `price_tables`(저장마다 새 버전), 첫 기록 때 `auth_type`·`price_version` 고정 → 가격 수정이 지난 비용을 바꾸지 않음, API 키만 비용(가격은 십진 문자열 ≤ 6자리 → BigInt로 정확히 곱해 행마다 마이크로 USD 반올림(0.5 올림), 정수 합계·기준 비교 — 50×$0.29/M = 15, 667행 $0.01 경계)·미제공 NULL, 0013 업그레이드가 옛 기록의 `auth_type`을 연결에서 채우고 못 찾으면 `unknown`(미확인·미제공, 가격 미적용) — `test/usage-review.test.ts`, 예산 스위치 "추후 제공" 비활성, 예산 꺼진 상태에서 사용량으로 막히는 경로 없음(가격표·알림 실패해도 실행 완료) — `test/usage-screen.test.ts`, `e2e/usage.spec.ts`) |
| FR-9.2 | 구독 사용 집계, 한도 안내·전환 | #18, #44 | I, M | 🟨 (#44 구독 연결도 같은 표에 토큰·요청 수 기록, 연결 테스트는 `connection_test` — `test/connections.test.ts`. #18 구독은 비용 없이 토큰만(`cost_usd` NULL — `claude.test.ts`, `subscription.test.ts`), 한도 → `subscription_limit` 안내 "지금 이 런타임은 한도에 걸렸어요" + `switchTo`. 실제 전환은 #19, 실제 한도 확인(M)은 체크리스트) |
| FR-9.3 | 내 사용량, 관리자 분류별 사용량 | #32 | I, E | ✅ (`GET /api/usage/me` 본인 것만 — 사이드바·설정, 관리자 `GET /api/admin/usage` 사용자·런타임·모델·연결·목적별, 다섯 분류 합계 동일, 아들·가족 403(Fastify가 실제 등록한 `/api/admin/**` 전체를 순회 — 관리자 선언이 빠진 경로, 명시적 HEAD 경로도 실패), 토큰 미보고는 "미제공" — `test/usage-screen.test.ts`, `test/permissions.test.ts`, `e2e/usage.spec.ts`) |
| FR-9.4 | 프롬프트 캐싱 | #15, #16 | M | 🟨 (Claude: cache 읽기·쓰기 토큰 보고. Codex: `cachedInputTokens`·`cacheWriteInputTokens` 보고, 실제 적중은 녹화 대기) |
| FR-9.5 | 누적·예상 비용, 일일 비용 알림 | #32, #34 | U | ✅ (#34 관리자 전용 `daily_cost` 발행 API. #32 이번 달 누적·오늘·예상(누적 + 일평균 × 남은 일수, 서울 기준), 선택 기준 초과 → 관리자 알림 하루 한 번(날짜를 먼저 기록), 같으면 아님($0.30 = 기준 $0.30 경계 포함), 오늘·예상에도 미제공 건수 표시, 막지 않음 — `test/usage-screen.test.ts`) |
| FR-10.1 | 사용자 관리 | #41, #35 | I, E | 🟨 (#35 사용자 탭 + 이름·이메일·역할 수정 `PATCH /api/admin/users/:id`, 마지막 관리자 강등·비활성화 거부 — `admin.test.ts`·`e2e/admin.spec.ts`. Access 동기화는 #36) |
| FR-10.2 | 런타임 연결 관리 | #17, #35 | I, E | 🟨 (#17 공용 연결·대신 등록·허용 정책 API. #35 런타임 탭: 런타임별 모델·capability `GET /api/admin/runtimes`, 공용 연결 등록·테스트·삭제, 가족 대신 API 키 등록·그 사람으로 테스트(`POST /api/admin/users/:id/connections/:connectionId/test`)·삭제, 본인 구독 안내, 다른 관리자 계정에 구독 붙이기·남의 구독 대신 테스트 403 `subscription_self_only` — `admin.test.ts`·권한 행렬) |
| FR-10.3 | 스킬 허용 목록 | #21, #35 | I | 🟨 (#21 정의 허용 목록·서버 스킬 폴더 `pnpm skills:install`·`GET /api/admin/skills`. #35 스킬 탭: 서버 허용 스위치(settings `skills.disabled`, 끄면 누구에게도 제공 안 됨)·사용자별 켜기 — `admin.test.ts`) |
| FR-10.4 | 시스템 상태 | #35, #46 | I, M | 🟨 (#46 최근 오류 API 완료, 가동률 7일 측정 대기. #35 시스템 상태 탭 `GET /api/admin/system`: 가동 시간, 런타임 연결 상태, 터널(`CLOUDFLARED_METRICS` 루프백 IP만, 없으면 미설정), 최근 오류·스킬·금융 도구 실패(코드만), 디스크 — `admin.test.ts`. 실제 cloudflared 메트릭 확인은 M) |
| FR-10.5 | 백업·복원 | #37 | I, M | 🟨 (#37 매일 03:30(서울) `VACUUM INTO` + 파일 쓰기 잠금으로 같은 시점, 7일 보관(최신 것까지 만료, 백업 실패와 무관하게 정리·실패마다 관리자 알림), 관리자 → 백업 탭(목록·지금 백업·복원 안내, `/api/admin/backups` 관리자만 — 권한 행렬), 복원은 서버를 멈춘 뒤 `pnpm -s restore check/apply`(데이터 폴더 커널 잠금(SQLite 배타 잠금, 실경로 — 별도 프로세스 경합·kill -9 시험)·키 확인 → 해시 → 무결성 → 스키마 버전(이전 스키마는 업그레이드) → 연결·설정·푸시 비밀 복호화, 교체 일지 단계(prepared→old_moved→swapped→done, rolling_back)로 실패·강제 종료 복구, 일지에 옛 폴더 id·DB 해시와 후보 전체 목록(파일별 크기·해시) — 옛 DB는 체크포인트 후 DB·-wal·-shm 상태까지 정체에 포함, 파일 fsync 오류는 교체 전 실패, 증명된 쪽으로만 진행, 증명 못 하면 일지 보존·시작 거부, 모든 단계 경계 강제 종료 시험, 옛 폴더는 옆으로) — `test/backup.test.ts`·`e2e/admin.spec.ts`. 실제 맥에서 분기 리허설(M)은 ops.md 21.4절) |
| FR-11.1 | 연결 = 런타임 × 인증 × 범위 | #17 | I | ✅ (`connections` 표, 내 연결·공용·관리자 대신 등록 API — `test/connections.test.ts`) |
| FR-11.2 | 런타임별 연결 정보, 실행 방식 | #15, #16, #18, #39 | I, M | 🟨 (Claude 어댑터, Codex app-server 어댑터 — API 키. #18 Claude 장기 토큰 `CLAUDE_CODE_OAUTH_TOKEN`, Codex 디바이스 코드 로그인·`chatgptAuthTokens`·토큰 갱신 — `subscription.test.ts`, 0.165.0 실바이너리 시험. 실제 계정 확인(M)은 `docs/evidence/subscription/checklist.md`) |
| FR-11.3 | 개인 우선, 공용 선택, 한도 시 확인 | #17 | I | ✅ (개인 우선, `useShared`, 한도 시 `personal_limit_use_shared` 안내 → `runs.use_shared`. #19 칩 “공용으로 쓰기” → `conversations.use_shared`, 다른 런타임으로 가면 꺼짐 — `chat-settings.test.ts`) |
| FR-11.4 | 구독 공유 금지, Claude 구독은 관리자만 | #17, #18 | I, E | ✅ (#17 공용 구독 400, 범위 변경 400, 관리자 외 Claude 구독 403. #18 ChatGPT 로그인은 본인 개인 연결로만, 다른 사람 404/403, 등록 화면 안내 — `subscription.test.ts`, `e2e/connections.spec.ts`) |
| FR-11.5 | 연결 테스트 | #17, #43 | I, E | ✅ (응답·스트리밍·`echo_time`·`skill_selftest` SHA-256 + MCP 서버 실제 처리 확인, `passed`만 선택기·실행. CI는 가짜 런타임, 실제 키는 같은 경로 — M 기록은 AC-9) |
| FR-11.6 | 인증 정보 암호화, 원문 비노출 | #7, #17, #18 | U, I | ✅ (#7 암호화 모듈, #17 연결 키 암호화·끝 4자리·응답·로그·DB 원문 검색 시험. #18 ChatGPT 토큰 암호화·갱신 토큰도 암호화·이메일만 표시, 응답·로그·DB·폴더에서 가짜 토큰 검색 — `subscription.test.ts`) |
| FR-11.7 | 런타임 격리 | #15, #16, #42 | I | 🟨 (Claude·Codex: 잠금 설정 + 샌드박스, fork 없음 확인. Codex는 우리 모델 카탈로그로 code-mode host·하위 에이전트 제거) |
| FR-11.8 | 연결 끊김·만료 처리 | #17, #18, #14, #56, #34 | I, E | 🟨 (#17 `runtime_auth` → 오류 종료·안내·`expired`·`connection_lost`/관리자 `system_warning`. #18 구독 만료 → `subscription_expired` 재로그인 안내 + `switchTo`, 갱신 거부 → `expired`. #14 화면 오류 안내·재연결 표시·"다른 런타임으로 이어가기" 자리, #19 그 버튼이 칩을 열고 바꾼 뒤 다시 생성은 새 런타임으로, 예약 알림 #56) |
| FR-11.9 | 연결 해제 후 기록 유지 | #17 | I | ✅ (기록 유지, 세션 무효화·같은 연결만 resume, 진행 중 실행 중지, 폴더 삭제) |
| FR-12.1 | 기본 런타임·모델·추론 강도 설정 | #19, #35 | I, E | ✅ (#35 저장·검사: `GET/PUT /api/settings/defaults`(허용 밖 403, 런의 검사 함수 그대로)·설정 화면 기본값 섹션 — `admin.test.ts`·`e2e/admin.spec.ts`. #19 새 대화에 적용 — `e2e/runtime-chip.spec.ts`) |
| FR-12.2 | 새 대화·새 예약에 자동 적용 | #19, #55 | I | 🟨 (#19 새 대화: 만들 때 기본값(대체 적용)을 대화에 기록, 선택 단계 없음 — `chat-settings.test.ts`. 예약은 #55) |
| FR-12.3 | 런타임별 기본 모델 기억 | #19 | I | ✅ (칩에서 런타임만 바꾸면 그 런타임의 기본 모델·추론 강도, 없으면 허용된 첫 모델 — `chat-settings.test.ts` "runtime only") |
| FR-12.4 | 초기값 Claude Code · Opus 5.5, 관리자 초기값 | #19, #41, #35 | I | ✅ (#35 `users.initial_defaults`·`PUT /api/admin/users/:id/defaults`(대상 사용자 권한 안에서만, 400), 본인 값 → 관리자 초기값 → 서비스 기본값 순 — `admin.test.ts`. #19 미설정 사용자의 새 대화가 Opus 5.5, 관리자 초기값으로 시작 — `chat-settings.test.ts`·`e2e/runtime-chip.spec.ts`) |
| FR-12.5 | 기본값 변경 시 기존 대화 불변 | #19 | I | ✅ (답한 대화·아직 안 답한 대화 모두 설정·다음 답의 런타임·모델·추론 강도 그대로 — `chat-settings.test.ts` "never changes an existing conversation", `e2e/runtime-chip.spec.ts`) |
| FR-12.6 | 기본값 불가 시 대체 순서 | #19 | U, E | ✅ (같은 런타임 첫 허용 모델 → Claude Code → Codex 순 다른 런타임의 기본 모델 → 후보 없음 화면, `passed` 연결만 셈, 사용 한도도 대체 조건(`connection_limits`: 구독은 연결 전체·모델 창별 해제 시각/5시간, API 키는 그 모델만 retry-after/1분, 한도 뒤에 시작한 같은 범위의 성공만 해제), 칩 옆 안내 1회(서버가 한 번만 넘김), 설정 화면 안내 — `chat-settings.test.ts`·`e2e/runtime-chip.spec.ts`) |
| FR-12.7 | 내 런타임 연결 관리 | #17, #18 | E | ✅ (#17 설정 → 내 런타임 연결: 추가·테스트·해제, `e2e/connections.spec.ts`. #18 "ChatGPT로 로그인"(코드·링크·취소·다시 로그인), 관리자만 Claude 구독 항목) |
| FR-12.8 | 알림 설정 | #34 | E | ✅ (기기별 켜기/끄기·방해 금지 — `e2e/notifications.spec.ts`) |
| FR-13.1 | 웹 푸시, 기기별, iOS 안내 | #34 | M | 🟨 (구현·자동 시험 완료, 실기기 확인 대기 — `docs/evidence/push/checklist.md`) |
| FR-13.2 | 알림 종류 | #34, #57 | I | 🟨 (#34 종류별 발행 API·전송 직전 권한 재검사 완료, 발행 지점 연결은 #33/#56·#29/#52·#17·#32·#35) |
| FR-13.3 | 알림함, 읽음 | #34 | E | ✅ |
| FR-13.4 | 방해 금지, 끝나면 묶어서 | #34 | U | ✅ (재시작 후 복구 포함 — `apps/server/test/notifications.test.ts`) |
| FR-13.5 | 본문 2줄, 공유 내용 비노출 | #34 | U | ✅ |
| FR-14.1 | 공유 대상 | #29, #52 | I | ⬜ |
| FR-14.2 | 기본 비공개, 즉시 해제 | #29 | I | ⬜ |
| FR-14.3 | 읽기 전용, 살아 있는 공유, 포크, 부분 공유 불변 목록 | #29, #52 | I, E | ⬜ |
| FR-14.4 | 아티팩트 공유·포크 | #52 | E | ⬜ |
| FR-14.5 | 가족 공유 묶음, 공유 알림 | #52, #34 | E | 🟨 (#34 `share_received` 발행 API — 내용 없이 누가·무엇만, 연결은 #29/#52) |
| FR-14.6 | 공유한 사람·시각, 열람 확인 | #52 | E | ⬜ |
| FR-14.7 | 가족 계정끼리만 | #29 | I | ⬜ |
| FR-15.1 | 이름·이메일·역할 관리 | #35 | E | 🟨 (#35 사용자 탭 수정, 이메일 변경 시 세션 종료, 관리자 이메일은 #36 절차로만(409 `admin_email_change`) — `admin.test.ts`·`e2e/admin.spec.ts`. Access 자동 반영은 #36) |
| FR-15.2 | Access 자동 반영, 미리보기, 실패 재시도, 현재 관리자 이메일 보호 | #36 | I, M | ⬜ |
| FR-15.3 | 동기화 상태 비교 | #36 | I | ⬜ |
| FR-15.4 | 토큰 없이 수동 모드 | #36 | E | ⬜ |
| FR-15.5 | 비활성화 시 Access 제거·세션 종료 | #41, #36 | I | ⬜ |
| FR-15.6 | Cloudflare 토큰 암호화 | #7, #36 | U | 🟨 (#7 암호화 모듈) |
| FR-15.7 | 관리자 이메일 변경 절차 | #36 | I, M | ⬜ |

## 핵심 결정 (D)

| 항목 | 내용 | 담당 이슈 | 검증 | 상태 |
|---|---|---|---|---|
| D1 | 두 런타임, 어댑터 | #12, #15, #16, #39 | I, M | 🟨 (#39 완료, #15·#16 어댑터 — 실제 녹화 대기) |
| D2 | 인증 방식·범위, Claude 구독은 관리자만 | #17, #18 | I | ✅ (#17 API 키·Claude 구독 규칙. #18 가족 각자 ChatGPT 디바이스 코드 로그인 — `subscription.test.ts`) |
| D3 | 기본값으로 바로 시작 | #19 | E | ✅ (`e2e/runtime-chip.spec.ts` 수용 기준 7) |
| D4 | 자체 호스팅, 127.0.0.1:3000, Tunnel + Access | #5, #8, #9 | U, M | 🟨 (#5 완료) |
| D5 | 스킬 허용 목록, 설정 격리 | #21, #42, #15, #16 | I | 🟨 (#21 허용 목록 스킬만 서버 폴더로 복사, 링크·하드링크·변조 거부, 샌드박스 실행 — `skills.test.ts`, isolation.md) |
| D6 | SQLite + 파일 저장소 | #7 | U | ✅ |
| D7 | 공통 MCP 서버 | #43, #21 | I | 🟨 (#21 두 런타임 같은 도구 결과 — `skills-contract.test.ts`, 대본 런타임. 실제 런타임 녹화는 자격 증명 후) |
| D8 | 서버 원본 기록, 대화 중 전환 | #11, #45, #53 | I | 🟨 |

## 비기능 요구사항 (NFR)

| 항목 | 담당 이슈 | 검증 | 상태 |
|---|---|---|---|
| NFR 성능 | #38 (측정 규격은 `docs/acceptance.md` §3) | M | ⬜ |
| NFR 가용성 | #8, #46 | M | 🟨 (#46 측정기·판정 스크립트 완료, Access 후 7일 측정 대기) |
| NFR 보안 | #5, #7, #9, #10, #42, #50, #27, #51, #25, #22 | U, I, E, S | 🟨 (#5 완료, #50 SSRF fixture 전부 거부 — `web.test.ts`, #27 아티팩트 샌드박스·CSP — `e2e/artifacts.spec.ts`, #51 내보내기 렌더러 격리(앱·사설 IP 차단, 쿠키 없음) — `artifact-export.test.ts`, #25 `cite` 범위는 토큰에서만·출처 글은 글자로만 그림, 변이 시험 기록 isolation.md, #22 업로드 원본은 올린 사람만(남 403)·항상 attachment·nosniff·샌드박스 CSP·PNG/JPG만 인라인(형식 판별은 최선 — 위장 파일도 내려받기로만), 상위 폴더 링크를 따라가지 않음(읽기·쓰기·지우기) — `files.test.ts`·권한 행렬) |
| NFR 스트리밍 | #8, #12 | I, M | ⬜ |
| NFR 격리 | #15, #16, #42, #47, #21 | I | ⬜ |
| NFR 권한 | #10, #29 | I | ⬜ |
| NFR 프롬프트 주입 | #20, #42 (시험 규격은 `docs/acceptance.md` §4) | U, M | 🟨 (#20 지침·외부 콘텐츠 블록·평가 도구 완료(가짜 런타임으로 CI 검증), 두 런타임 실측은 자격 증명·#16·#23/#24 도구 후 — `docs/ops.md` §14) |
| NFR 개인정보 | #54, #46 | I | 🟨 (#46 로그·오류 비노출 완료) |
| NFR 청소년 | #20 (평가 규격은 `docs/acceptance.md` §5) | U, I, M | 🟨 (#20 청소년 지침·아들 계정 표시(`users.youth`) 완료, 20문항 평가는 두 런타임 연결 후) |
| NFR 관측성 | #46 | U | 🟨 (#46 로그·오류 정제 완료, 7일 가동률 측정 대기) |
| NFR 백업 | #37, #22 | I, M | 🟨 (#37 매일 자동·7일 보관, 연결 인증 정보는 암호문 그대로·마스터 키 미포함(모든 형태 바이트 검색), 런타임 폴더·격리 폴더·스킬 제외, 폴더 700·파일 600, 7일 지난 백업은 최신 것까지 정리(백업 실패와 무관, 30일 연속 실패 시험)·실패마다 관리자 알림, 지운 대화가 7일 안에 모든 백업에서 사라짐, 파일 읽기 오류는 백업 실패, 별도 폴더·되살린 키 리허설(로그인·대화·첨부·아티팩트·연결 테스트 통과), 틀린 키 `wrong_key`·새 스키마 `schema_newer` — `test/backup.test.ts`, 변이 시험. 실제 키 사본 리허설(M) 대기 — ops.md 3절·21.4절. #22 업로드 파일이 백업에 들어가고(`FILE_REFERENCES` — 행이 가리키는 파일이 없으면 백업 실패), 업로드·대화 삭제가 쓰기 잠금을 따름 — `files.test.ts`, 리허설에 API 업로드 포함) |

## 수용 기준 (AC, PRD §11) — 절차는 `docs/acceptance.md`

| 항목 | 담당 이슈 | 검증 | 두 런타임 필요 | 상태 |
|---|---|---|---|---|
| AC-1 | #5, #8, #9, #13 | E, M | — | ⬜ |
| AC-2 | #48, #23, #24 | E, M | 예 | ⬜ |
| AC-3 | #25 | U, E | 예 | 🟨 (#25 실패 상태마다 ⚠️, 정상 표시 경로 없음(모르는 상태 값 포함) — 단위·E2E. 두 런타임 녹화 형식 재생으로 네 fixture 시나리오 같은 결과 — `citation-runs.test.ts`. 실런타임은 `docs/evidence/citations/checklist.md`) |
| AC-4 | #30, #31 | U, E, M | 예 | 🟨 (#30 두 런타임 녹화 형식 재생으로 "AAPL, 005930 현재가" → 출처·기준 시각·면책(`finance-runs.test.ts`), 화면 `e2e/finance.spec.ts`. 표·차트 아티팩트는 #31, 실런타임은 `docs/evidence/finance/checklist.md`) |
| AC-5 | #33, #56, #34, #57 | U, M | — | 🟨 (#34 알림 부분: 자동 시험 완료, 실기기 체크리스트 대기. #33 예외 자동 시험(가짜 시계): 2분 뒤 재시도 1회, 정지 중 회차 2개 이상 → 1회, 겹침 건너뜀, 서머타임 두 규칙, 시작 오차 ±1분 측정(실제 시계 1초 미만) — `test/schedules.test.ts`. 7일 실측은 #56·#57) |
| AC-6 | #10, #29 | I | — | ⬜ |
| AC-7 | #19 | E | — | ✅ (설정 → 새 대화 → 바로 보내기가 기본값으로, 미설정은 Opus 5.5, 막히면 대체 + 안내 1회 — `e2e/runtime-chip.spec.ts`) |
| AC-8 | #45, #53 | I, M | 예 | 🟨 (#45 자동: 두 런타임 녹화 재생으로 전환·모델만 변경 뒤 앞에서 정한 종목이 새 세션 맥락에 있음 — `context-replay.test.ts`. 실런타임·전환 후 첫 토큰 p95는 `docs/evidence/context/checklist.md`) |
| AC-9 | #17, #18 | I, E, M | 예 | 🟨 (#17 자동 시험: 다른 사용자 개인 연결 403, 관리자 외 Claude 구독 403. #18 자동 시험: 개인 ChatGPT 구독 연결이 다른 사람 선택기에 없음·id로 쓰면 403(관리자 포함) — `subscription.test.ts`. 실제 계정 확인(M: 관리자 Claude 토큰, 가족 1명 이상 ChatGPT)은 `docs/evidence/subscription/checklist.md`, 사용자 확인 대기) |
| AC-10 | #17, #55 | I | — | 🟨 (#17 메시지 보내기·고치기·다시 생성 403. #19 대화 설정 변경·새 대화 선택도 403(허용 안 된 추론 강도 포함) — `chat-settings.test.ts`. 예약은 #55) |
| AC-11 | #38 | S | 예 | ⬜ |
| AC-12 | #44, #32 | U, I | — | 🟨 (fixture 기록별 비용·총 $6.55·엄마 $4.50·아들 구독 43만 토큰·분류 합계 동일·예산 차단 없음 — `test/usage-screen.test.ts` "AC-12". 화면 스크린샷·구독 한도 안내(2)는 양식 B 기록 대기) |
| AC-13 | #36 | I, M | — | ⬜ |
