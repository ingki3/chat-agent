# 결정 기록 — 두 런타임의 SDK·인증·권한 능력 (스파이크 #39)

- 날짜: 2026-11-08
- 작성: Dev agent (Claude Opus 5.5)
- 관련 이슈: #39 (이 기록), #3 (PRD v0.5), #12, #15, #16, #18, #42
- 재현: `spike/runtime/` — `npm i` 후 `node claude-probe.mjs [test]`, `node codex-probe.mjs [test]`, `node codex-exec-probe.mjs`. 결과 원본은 `spike/runtime/results/*.json`

## 고정 버전

| 구성 요소 | 버전 |
|---|---|
| `@anthropic-ai/claude-agent-sdk` | 0.3.319 (Claude Code CLI 2.1.319) |
| `@openai/codex-sdk` / `codex` CLI | 0.167.0 / 0.167.0 |
| `@modelcontextprotocol/sdk` (시험용 MCP 서버) | 1.32.2 |
| Node | 22.22.0 |

시험 조건: 두 런타임 모두 관리자 본인 구독 로그인(Claude: 키체인 로그인, Codex: ChatGPT 로그인)으로 실행. API 키는 이 환경에 없어 API 키 경로는 문서·타입으로만 확인했다.

## 1. Claude Code (Claude Agent SDK)

| 항목 | 판정 | 증거 / 메모 |
|---|---|---|
| 토큰 단위 스트리밍 | 지원 | `includePartialMessages: true` → `stream_event` `text_delta` 34개 (`claude-stream.json`) |
| 세션 이어가기 | 지원 | `resume: <session_id>` → 앞 턴의 태그 `c1` 기억 (`claude-resume.json`). `resumeSessionAt`으로 특정 메시지까지 잘라 이어가기도 가능(수정·재생성 대응) |
| 같은 세션에서 모델 변경 | 지원 | 스트리밍 입력 모드에서 `q.setModel('claude-haiku-5-5')` 후 앞 내용 기억 (`claude-setmodel.json`) |
| 중단 | 지원 | `q.interrupt()` → 결과 `error_during_execution` + 예외. 어댑터는 이를 "중지됨"으로 매핑해야 함 (`claude-interrupt.json`) |
| 추론 강도 | 지원, **검증은 우리가** | `effort: low~max`. Opus·Haiku 모두 `max`를 오류 없이 받음 → SDK가 모델별 허용 범위를 막지 않으므로 서버 capability 표로 검증 (`claude-effort.json`) |
| MCP 연결 | 지원 | stdio MCP `echo_time` 호출 성공, MCP 프로세스에 run 토큰 환경변수 전달 확인 (`claude-stream.json`) |
| 내장 도구 기본 거부 | 지원 | `tools: []` + `canUseTool`(MCP만 허용) → 셸·파일 접근 불가, 모델이 "echo_time만 있다"고 답함 (`claude-lockdown.json`). **주의: `allowedTools`에 이름을 넣으면 `canUseTool`을 건너뛰고 자동 승인됨** — 쓰지 않는다 |
| 사용자 설정 격리 | 지원 | `settingSources: []` → `~/.claude/CLAUDE.md` 미로딩(NO), `['user']`면 로딩(YES) (`claude-isolation.json`) |
| 설정·세션 폴더 격리 | 지원 | `CLAUDE_CONFIG_DIR=<연결 폴더>` → 키체인 로그인을 쓰지 않음("Not logged in"), `.claude.json`·`sessions`·`projects`가 그 폴더에 생김 (`claude-configdir.json`) → 인증은 `ANTHROPIC_API_KEY` 또는 `CLAUDE_CODE_OAUTH_TOKEN` 환경변수로 주입 |
| 환경변수 상속 차단 | 지원 | `options.env`는 부모 환경을 **대체**(병합 아님) — 허용 목록만 전달 |
| 사용량 | 지원 | `usage`(입력·출력·캐시 생성·캐시 읽기 토큰), `modelUsage`(모델별), `total_cost_usd`(추정치, 구독에서도 나옴) |
| 프롬프트 캐싱 | 자동 | resume 시 `cache_read_input_tokens` 15k (`claude-resume.json`) |
| 구독 한도 신호 | 미확인 | 이번 시험에서 한도 미도달. 구현 시 오류 결과 유형으로 확인 (#18) |
| 구독 장기 토큰 | 경로 확인 | `claude setup-token`(구독 필요) → `CLAUDE_CODE_OAUTH_TOKEN`. 실제 주입 시험은 관리자의 1회 토큰 발급 필요 |

## 2. Codex (Codex SDK / CLI / app-server)

| 항목 | 판정 | 증거 / 메모 |
|---|---|---|
| 토큰 단위 스트리밍 | **SDK 불가**, app-server 지원 | SDK(`codex exec --json`)는 `item.completed`만 내보내고 글자 단위 갱신 0회 (`codex-stream.json`). app-server 프로토콜에는 `item/agentMessage/delta` 알림이 있음(`codex app-server generate-ts`로 확인, experimental) |
| 세션 이어가기 | 지원 | `resumeThread(id)` → `x1` 기억 (`codex-resume.json`) |
| 턴 사이 모델·추론 강도 변경 | 지원 | 같은 thread를 다른 옵션으로 `resumeThread` → 앞 내용 기억 (`codex-modelswitch.json`) |
| 추론 강도 | 지원, 서버가 검증 | `gpt-6.1-sol`은 `low~max`, `minimal`은 API가 거부(`turn.failed`) (`codex-effort.json`) |
| 중단 | 지원 | `AbortSignal` → 4초 안에 종료 (`codex-abort.json`). app-server는 `turn/interrupt` |
| MCP 연결 | 지원, 설정 필요 | `config.mcp_servers`. `approvalPolicy: never`면 MCP 호출이 **차단**됨 → 서버별 `default_tools_approval_mode = "approve"` 필요 (`codex-stream.json`) |
| 사용자 설정 격리 | **필수 조치** | 기본 `CODEX_HOME`에서는 사용자 `~/.codex/config.toml`이 병합되어 사용자의 `node_repl` MCP로 `~/.zshrc`를 읽음 (`codex-lockdown.json`) → **연결별 `CODEX_HOME` 격리가 필수** |
| `read-only` sandbox | **읽기 제한 아님** | 셸 켜진 상태에서 `head -1 ~/.zshrc` 성공 (`codex-readonly-default.json`) — 쓰기만 막음 |
| 내장 도구 기본 거부 | 지원(조합) | `features.shell_tool=false`, `unified_exec=false`, `code_mode_host=false`, `plugins/apps/browser_use/computer_use/memories=false` + 사용자 MCP 없음 → 파일·셸 접근 불가 (`codex-lockdown2.json`, `codex-exec.json`). 남는 도구: `request_user_input`, `clock.sleep`, `collaboration.*`(하위 에이전트) → 하위 에이전트 끄는 설정은 구현 때 확인 |
| `CODEX_HOME` 격리 | 지원 | 빈 `CODEX_HOME` → 401(로그인 없음), 상태 sqlite·sessions가 그 폴더에 생김 (`codex-codexhome.json`). 401이면 10회 재시도로 ~40초 지연 → 어댑터가 401을 즉시 실패로 처리해야 함 |
| 환경변수 상속 차단 | 지원 | `new Codex({ env })`는 부모 환경을 상속하지 않음 |
| 사용량 | 토큰만 | `input/cached_input/cache_write_input/output/reasoning_output` 토큰. 비용은 없음 → 가격표로 계산. 기본 입력이 턴당 약 3만~4.4만 토큰(대부분 캐시) |
| 구독 한도 신호 | app-server 지원 | `account/rateLimits/read`, `account/rateLimits/updated` |
| 로그인 | app-server 지원 | `account/login/start` 종류: `apiKey`, `chatgpt`, `chatgptDeviceCode`, `chatgptAuthTokens` → 웹 화면에서 디바이스 코드 로그인 가능 |

## 3. 구독 로그인 정책 (공식 문서, 2026-11-08 조회)

| 회사 | 판정 | 근거 |
|---|---|---|
| Anthropic | **불명확 — 가족 여러 명 사용은 금지 쪽에 가까움** | Agent SDK 개요: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods…" (https://code.claude.com/docs/en/agent-sdk/overview). 지원 문서는 SDK가 구독 한도에서 차감된다고만 함 (https://support.claude.com/en/articles/15036540). 소비자 약관은 계정·로그인 정보 공유와 API 키 외 자동화 접근을 제한(https://www.anthropic.com/legal/consumer-terms). 본인이 본인 앱에서 쓰는 경우는 명시 없음 |
| OpenAI | **조건부 허용** | 헤드리스 서버는 디바이스 코드 로그인 권장, 자동화는 API 키 권장(https://learn.chatgpt.com/docs/auth). "ChatGPT plan usage for open-source and locally hosted apps" 경로가 문서화됨, 유료·원격 호스팅은 별도 신청(https://developers.openai.com/siwc/token-sharing-open-source). 사용자별 로그인 모델 |

## 4. 결론과 이슈 반영

1. **어댑터 계약(#12)은 그대로 유지 가능.** 두 런타임 모두 시작·이어가기·중단·모델 변경·MCP·사용량을 지원한다. 단 추론 강도 허용 범위는 우리 capability 표가 검증한다(Claude는 SDK가 막지 않음).
2. **Claude 어댑터(#15)**: `tools: []`, `canUseTool`로 MCP만 허용(`allowedTools` 금지), `settingSources: []`, 연결별 `CLAUDE_CONFIG_DIR`, `env` 허용 목록, 인증은 환경변수 주입, `interrupt` 결과를 "중지됨"으로 매핑.
3. **Codex 어댑터(#16)**: **app-server 프로토콜(stdio JSON-RPC)을 기본**으로 한다 — 토큰 스트리밍·중단·로그인·한도 신호가 모두 여기 있다(실험적 표시이므로 버전 고정). SDK(`exec --json`)는 대안(글자 단위 스트리밍 없음). 연결별 `CODEX_HOME` + 우리 `config.toml`만, 위 feature 끄기 목록, MCP `default_tools_approval_mode = "approve"`, 401 즉시 실패.
4. **실행 격리(#42)**: Codex `read-only`가 읽기를 막지 않음을 확인 — 내장 도구를 끄는 것이 1차 방어, OS 수준 경로 제한이 2차 방어.
5. **구독 로그인(#18)**:
   - Codex: ChatGPT 디바이스 코드 로그인을 연결별 `CODEX_HOME`에서 진행 — 각자 본인 계정. 문서상 조건부 허용.
   - Claude: **사용자 결정 필요**(#3). 아래 선택지.

## 5. 사용자 결정 요청 (Claude 구독 로그인)

| 선택지 | 내용 | 정책 위험 |
|---|---|---|
| A | Claude Code는 **API 키만**(공용·개인). 구독 로그인은 Codex(ChatGPT)만 | 없음 |
| B | Claude 구독 로그인은 **관리자 본인 계정을 관리자 본인 대화에만** 허용, 아내·아들은 API 키 | 낮음~불명확 (본인 사용) |
| C | 가족 각자 본인 Claude 구독 연결 허용(현재 PRD) | 높음 (문서상 "claude.ai 로그인 제공" 금지에 가까움) |

권장: **B** (불명확한 부분은 Anthropic에 문의해 답을 받으면 C로 넓힐 수 있음). 결정에 따라 D2·FR-11·수용 기준 9를 PRD v0.5에서 고친다.
