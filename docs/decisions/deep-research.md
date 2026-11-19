# 결정 기록 — 깊이 조사 (Deep Research, #211)

- 날짜: 2026-11-19
- 작성: Dev agent (Claude Opus 5.5), 계획: #211 본문(사용자 결정 1–6, 2026-11-19 승인)
- 관련: PRD FR-17(v0.8)·FR-5(출처)·FR-13(알림)·FR-9(사용량), `docs/decisions/sources.md`(#185·#186·#202 인용 규칙), `docs/ops.md` 50절, `docs/traceability.md`
- 범위: **1단계** — Claude 백엔드 전 과정 + 외부 백엔드 인터페이스. **2단계(후속 PR, TODO)** — 외부 Deep Research API(Gemini·OpenAI) 실제 연결.

## 1. 문제와 목표

"🔎 자료 조사"(#25)는 답변 규칙을 바꾸는 토글일 뿐, 여러 단계로 오래 조사하는 작업이 아니다. 깊이 조사는 한 질문을 **계획 → 승인 → 병렬 조사 → 보강 → 작성·검증 → 보고서**로 처리하고, 보고서의 모든 사실 문장이 서버가 확인한 인용을 갖게 한다. 외부 프레임워크(LangGraph, GPT Researcher 등)는 들이지 않고 **패턴과 프롬프트 아이디어만** 가져와 기존 도구(`web_search`·`web_fetch`·`cite`·`file_*`·아티팩트·알림) 위에 만든다. 새 의존성은 없다.

## 2. 핵심 결정: 서버가 오케스트레이션한다 (Agent SDK 서브에이전트를 쓰지 않음)

| 선택지 | 판단 |
|---|---|
| Agent SDK의 서브에이전트(`Task` 도구, `agents` 옵션)로 리드가 서브에이전트를 띄움 | **쓰지 않음.** (1) 보안 잠금(`runtime/lockdown.ts`)이 `Task`를 포함한 내장 도구를 모두 막고 우리 MCP 도구만 허용한다 — 서브에이전트를 열면 그 경계를 다시 설계해야 한다. (2) 동시 실행 수·서브에이전트별 도구 호출·시간 상한, 30분 하드 상한, 단계별 체크포인트·재시작 이어하기, 진행 이벤트를 **서버가 강제**할 수 없다(모델이 정한다). (3) FakeRuntime으로 결정적으로 시험할 수 없다. (4) Codex에는 같은 기능이 없어 런타임 독립 설계(D8)와도 어긋난다. |
| **서버가 여러 번의 Claude 실행을 직접 조율** | **채택.** 각 단계(리드 계획, 서브 연구자 하나, 리드 보강 판단, 작성자)는 **한 번 쓰고 닫는 세션**(`research/step.ts` — 기억 정리 #146의 일회성 세션과 같은 방식: 이어가지 않고, 끝나면 닫고, 런타임 상태는 삭제 작업에 넘겨 지운다)이다. 동시 실행은 서버의 풀(기본 3), 상한은 서버 타이머, 체크포인트는 DB 행이 맡는다. |

각 단계의 MCP 토큰은 `{사용자, 대화, 단계 id(research:<job>:<step>)}`로 묶이고 단계가 끝나거나 한도에 걸리는 즉시 폐기된다(#173 규칙: 진행 중이던 도구 호출도 멈춘다). 단계가 가져온 페이지(`sources`)와 인용(`citations`)은 그 대화의 것이 되어, 보고서 뒤 후속 대화에서도 `sources_list`·`cite`로 다시 쓸 수 있다.

## 3. 흐름 (`apps/server/src/research/engine.ts`)

1. **시작** `POST /api/conversations/:id/research {text, fileIds?}` — 질문을 사용자 메시지(첨부 `file_ref` 포함)로, 카드를 답 메시지(`research` 부분, `jobId`)로 쓰고 `research_jobs` 행을 만든다. 대화 주인만, Claude 대화만(`research_claude_only` 409), 진행 중인 채팅 답이 없을 때, 한 사람당 동시 1개(`research_busy` 409 — 횟수 한도는 없음).
2. **계획**(도구 없음, 1분): 리드가 JSON 계획(제목·하위 질문 2–6개·범위·예상 시간) 또는 확인 질문 하나를 쓴다. 확인 질문은 한 번만(답을 받은 뒤에는 계획만 받아들인다). 계획은 카드에서 **승인 / 고치기 / 취소**. 승인 전에는 검색 도구가 없으므로 아무것도 가져오지 않는다(시험: 승인 전 `sources` 0행, 계획 단계 `tools: []`).
3. **승인** `POST /api/research/:id/approve {subQuestions?}` — 고친 하위 질문으로 바꾸고(id는 서버가 다시 매김, 첨부가 없으면 범위는 웹), **마감 = 승인 시각 + 30분 − 계획에 쓴 시간**을 정한다.
4. **조사**: 서브 연구자를 동시 3개까지. 각자 도구 12번·6분 상한, `web_search`·`web_fetch`(첨부 범위면 `file_search`·`file_read`). 찾을 때마다 바로 `NOTE {"claim","sourceId"|"fileId","quote"}` 줄을 쓰게 해서, 한도로 중간에 멈춰도 그때까지의 노트가 남는다. 서버는 노트의 구절을 **페이지 본문(`CitationStore.recheck`)이나 파일 추출 본문(`FileTools.check`)과 대조해 맞는 것만** 남긴다(같은 출처·구절은 하나로).
5. **보강**: 리드가 확인된 노트를 보고 빈 곳을 최대 3개 더한다 — 최대 2단계, 조사 예산이 3분 넘게 남았을 때만. 아니면 바로 작성(강제 마무리).
6. **작성·검증**: 작성자는 확인된 노트(하위 질문마다 번갈아 최대 45개 — 한 단계의 인용 상한 50개 안, 500자 넘는 구절은 버림)만 받고 `cite`/`file_cite`로 모든 사실 문장을 인용한다. 서버(`research/report.ts`)가:
   - 확인된(`verified`) 표시가 **하나도 없는 문장을 삭제**하고(인용 없음, 실패한 인용에만 기댐),
   - 남는 문장에서 실패한 표시를 빼고, 표·코드 블록은 넣지 않으며(행마다 삭제로 셈), 내용 없는 소제목을 정리하고,
   - 표시를 나타난 순서로 1부터 다시 매긴 뒤, 출처 목록(웹: 제목·사이트·주소·원문 구절 / 파일: 이름·위치·구절)과 "한계"(삭제한 문장 수, 시간 상한, 근거를 못 찾은 하위 질문)를 붙인다.
   - 작성자가 시간 안에 못 끝내거나 확인된 표시가 하나도 없으면 **확인된 원문 구절을 하위 질문별로 정리한 보고서**(대체 보고서)를 만든다 — 구절은 이미 서버가 대조한 것이다.
7. **결과**: 마크다운 아티팩트 하나, 카드 메시지에 요약(보고서 "요약" 절에서 표시를 뺀 글 — 출처는 보고서에)과 `artifact_ref`. 알림 `research_done`.

## 4. 시간 (`RESEARCH_LIMITS`, `packages/shared/src/research.ts`)

| 예산 | 값 | 넘으면 |
|---|---|---|
| 계획 | 1분 | `plan_failed` |
| 조사(모든 단계) | 승인 후 20분, 그리고 마감 − 9분을 넘지 않음 | 하던 서브 연구자를 멈추고(노트는 남음) 작성으로 — "시간 상한으로 일부만 조사" |
| 서브 연구자 하나 | 6분, 도구 12번 | 그 연구자만 멈춤(`capped`) |
| 작성·검증 | 최대 8분, 마감 − 1분을 넘지 않음 | 쓴 데까지 검증, 확인된 것이 없으면 대체 보고서 |
| 하드 상한 | 마감(승인 + 30분 − 계획 시간) | 모든 단계 중단 신호 |

시간은 `research/clock.ts`의 `Clock`으로 재서 시험은 수동 시계(`ManualClock`)로 30분을 돌린다. 마감은 벽시계다 — 서버가 꺼져 있던 시간도 센다.

## 5. 체크포인트와 재시작

`research_jobs.state`(JSON)가 체크포인트다: 단계, 보강 단계, 하위 질문별 상태·확인된 노트, 시간 초과 여부. 단계가 끝날 때마다 쓴다. 시작할 때(`onReady → recover`) `planning`·`researching`·`writing`인 작업을 이어 간다 — 끝난 하위 질문은 다시 묻지 않고, 하던 것은 처음부터 다시 한다. 마감이 이미 지났으면 바로 작성(남은 시간이 없으면 대체 보고서), 확인된 노트가 없으면 `server_restart`로 실패. 종료(`preClose → shutdown`)는 단계만 멈추고 상태는 그대로 둔다.

## 6. 권한·공유·포크

자원 종류 `research`(대화의 권한 규칙): 주인만 시작·승인·고치기·확인 답·취소·중지(403), 공유받은 가족은 카드 메시지가 투영에 있을 때 `GET /api/research/:id`·`/events`만(`owned: false`, 버튼 없음). 포크는 카드(`research` 부분)를 복사하지 않는다 — 요약과 보고서 아티팩트만. 권한 행렬(`test/helpers/permission-matrix.ts`)에 모든 경로가 있다.

## 7. 알림 (FR-13)

`research_done` / `research_failed`(실패·중지·근거 없음). 제목 "깊이 조사", 본문은 한 줄 — "깊이 조사가 끝났어요: <주제 앞부분>" / "깊이 조사를 마치지 못했어요: <주제> — <고정 이유>". 내용·출처는 넣지 않는다. 방해 금지 시간에는 `held`(알림함에만, 끝나면 묶어서 푸시), 알림 설정 "깊이 조사 알림"에서 종류별로 끈다(`notification_prefs.research_done`·`research_failed`). 누르면 `/c/<대화>#m-<카드>`.

## 8. 외부 백엔드 (2단계 — 인터페이스만)

`research/backend.ts`의 `ResearchBackend`: `id`·`label`·`external`·`available(user)`·`collect({question, plan, signal, deadlineAt}) → {claim, url, quote}[]`. 계획·작성·검증은 언제나 우리 것(Claude 리드·작성자, `cite`/`file_cite`)이고, 백엔드는 **찾은 것만** 돌려준다. 2단계에서 엔진은 외부 결과의 URL을 `web_fetch`처럼 대화 출처로 가져와 구절을 대조하고 맞는 것만 노트로 쓴다 — 내장 노트와 같은 기준. 관리자 설정(키 암호화 저장·허용 여부·청소년 기본 끔), 카드의 "기본(Claude) / 외부" 선택과 전송 안내는 2단계에서 붙인다. 1단계의 `ResearchBackendId`는 `claude`뿐이고 다른 값은 `backend_unavailable`(400)이다. **TODO(#211 2단계)**: Gemini Deep Research API, OpenAI deep research 연결.

## 9. 개인정보·로그

질문·계획·노트(페이지·파일 글)는 쓸 때마다 알려진 비밀 값을 가리고(`ResearchStore`), 백그라운드 재가림 대상이다(`secrets/columns.ts`). 로그에는 `research.*` 이벤트로 id·개수·고정 코드만(`researchId`, `researchCode`, `count`) — 질문·계획·노트·보고서는 남기지 않는다. 사용량은 `research` 분류로 단계마다(`usage_records.run_id = research:<job>:<step>`).

## 10. 참고한 공개 자료와 라이선스

코드는 가져오지 않았다. 아래 자료의 **패턴과 프롬프트 아이디어**를 참고해 우리 프롬프트(한국어, `apps/server/instructions/deep-research/*.md`, 버전 머리말 — 시스템 지침과 같은 형식)를 새로 썼다.

| 자료 | 라이선스 | 가져온 생각 |
|---|---|---|
| Anthropic, "How we built our multi-agent research system" (engineering blog) | — (글) | 리드 + 병렬 서브에이전트, 노력 규모를 질문 난이도에 맞추기, 넓게 시작해 좁히기, 별도 인용 단계 |
| anthropics/claude-cookbooks `patterns/agents/prompts` (research_lead_agent, research_subagent, citations_agent) | MIT | 질문 유형(깊이형·넓이형·단순형) 분류, 서브에이전트의 도구 예산과 출처 품질 판단, 작성 뒤 인용을 다는 단계 |
| jina-ai/node-DeepResearch | Apache-2.0 | 예산(토큰·시간) 안에서 반복하다 예산이 다하면 정리해 답하기 |
| dzhng/deep-research | MIT | 깊이(depth)·넓이(breadth) 매개변수, 단계마다 배운 것으로 다음 질문 만들기 |
| assafelovic/gpt-researcher | Apache-2.0 | 계획 → 하위 질문별 조사 → 보고서 작성의 3단 구조 |
| langchain-ai/open_deep_research | MIT | 사용자 확인(clarify) 한 번, 계획 승인 뒤 실행, 동시 실행 수 상한 |
| Gemini Deep Research API, OpenAI deep research guide | 각 서비스 약관 | 2단계 외부 백엔드의 형태(비동기 작업, 인용 URL 반환) |

## 11. 시험

- `apps/server/test/research.test.ts` — FakeRuntime(`runtime/fake-research.ts`)로: 계획(승인 전 검색 없음) → 승인 → 병렬 조사(동시 상한 3, 고친 계획) → 노트 대조(맞지 않는 노트 버림) → 작성 → 검증 실패 문장 삭제·번호 다시 매김·"한계" → 아티팩트·카드 메시지·사용량; 확인 질문 1회·취소; 첨부 파일(`file_cite`); 수동 시계로 조사 예산 종료(강제 마무리)·작성 시간 초과(대체 보고서, 30분 안); 중지; 재시작 이어하기(끝난 하위 질문 다시 안 함)·마감 지난 재시작; 알림(방해 금지 `held`, 종류별 끄기, 한 줄 본문); Codex 대화 거부; 청소년 허용·한 사람당 동시 1개; 공유받은 사람 읽기만; 대화 삭제 시 중단.
- `apps/server/test/research-report.test.ts` — 삭제 규칙·문장 나누기·보고서 렌더(링크·이스케이프)·모델 출력 읽기(계획·노트·보강)·프롬프트 버전 스냅숏.
- `apps/server/test/permissions.test.ts` — 새 경로 전부(권한 행렬).
- `e2e/deep-research.spec.ts` — 데스크톱·모바일: 계획 카드 고치기·승인 → 실시간 진행 → 보고서 카드, 취소·중지, Codex 대화의 비활성 버튼과 이유.
