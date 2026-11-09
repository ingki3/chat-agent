# 결정 기록 — 두 런타임의 SDK·인증·권한 능력 (스파이크 #39)

- 날짜: 2026-11-08 (리뷰 반영 2026-11-09)
- 작성: Dev agent (Claude Opus 5.5) · 리뷰: Review & Test agent (Codex Sol 6.1)
- 관련 이슈: #39 (이 기록), #3 (PRD v0.5), #12, #15, #16, #18, #42
- 재현: `spike/runtime/`에서 `npm i` 후 아래 스크립트 실행. 결과 원본은 `spike/runtime/results/*.json`
  - `claude-probe.mjs [stream|resume|lockdown|isolation|configdir|effort|setmodel|interrupt]`, `claude-gate-probe.mjs`
  - `codex-probe.mjs [stream|resume|modelswitch|lockdown|lockdown2|readonly_default|codexhome|effort|abort|mcp_noapprove]`, `codex-exec-probe.mjs`, `codex-appserver-probe.mjs`

**근거 표기**: **실행** = 이 스파이크에서 실제로 돌려 결과 파일이 있음 / **타입·문서** = 타입 정의나 공식 문서로만 확인, 실행 미검증.

## 고정 버전

| 구성 요소 | 버전 |
|---|---|
| `@anthropic-ai/claude-agent-sdk` | 0.3.319 (Claude Code CLI 2.1.319) |
| `@openai/codex-sdk` / `codex` CLI·app-server | 0.167.0 / 0.167.0 |
| `@modelcontextprotocol/sdk` (시험용 MCP 서버) | 1.32.2 |
| Node | 22.22.0 |

시험 조건: 두 런타임 모두 관리자 본인 구독 로그인(Claude: 키체인 로그인, Codex: ChatGPT 로그인). 이 환경에는 API 키가 없어 API 키 인증은 **타입·문서**로만 확인. 시험용 MCP 서버(`echo-mcp.mjs`)는 run 토큰의 원문 대신 전달 여부(`present/missing`)만 돌려준다.

## 1. Claude Code (Claude Agent SDK)

| 항목 | 판정 | 근거 |
|---|---|---|
| 토큰 단위 스트리밍 | 지원 | **실행** `includePartialMessages` → `text_delta` 22개 (`claude-stream.json`) |
| 세션 이어가기 | 지원 | **실행** 같은 실행 묶음에서 stream → `resume: <session_id>`(ID 일치) → 태그 `c1` 기억 (`claude-stream.json`, `claude-resume.json`) |
| 특정 메시지까지 잘라 이어가기 | 있음 | **타입·문서** `resumeSessionAt` + `resumeDropsTurn` (`sdk.d.ts`). 실행 미검증 → #45에서 시험 |
| 같은 세션에서 모델 변경 | 지원 | **실행** 스트리밍 입력 모드, 1턴 `answeredBy: claude-opus-5-5` → `setModel` → 2턴 `answeredBy: claude-haiku-5-5`, 같은 세션 ID, 앞 내용 기억 (`claude-setmodel.json`) |
| 중단 | 지원 | **실행** `interrupt()` 응답 6ms, 종료까지 583ms. 결과는 `error_during_execution` + 예외 (`claude-interrupt.json`). 어댑터는 **우리가 interrupt를 요청한 run만** "중지됨"으로 매핑하고, 그 밖의 `error_during_execution`은 실패로 처리 |
| 추론 강도 | 수락만 확인 | **실행** Opus·Haiku 모두 `effort: low`·`max`를 오류 없이 수락하고 해당 모델이 응답 (`claude-effort.json`). 값이 실제 적용·무시·정규화되는지는 확인하지 않음 → 허용 범위는 우리 capability 표(관리자 설정 + 문서 근거)로 검증 |
| MCP 연결 | 지원 | **실행** stdio MCP `echo_time` 호출 성공, MCP 프로세스에 run 토큰 전달(`runToken=present`) (`claude-stream.json`) |
| 내장 도구 차단 | 지원 — **방식 주의** | **실행** (`claude-gate.json`, `claude-lockdown*.json`): ① `tools: []` → 내장 도구가 목록에서 빠짐(`claude-lockdown.json` 실행에서는 도구가 `mcp__echo__echo_time` 하나뿐. 단 아래 "계정 커넥터" 행 참조) ② `disallowedTools: ["Bash"]` → 도구 자체가 사라짐 ③ `PreToolUse` 훅 → 읽기 전용 명령까지 모든 호출을 잡아 거부 ④ **`canUseTool`은 읽기 전용 명령(`echo`)에는 호출되지 않고 그대로 실행됨**(쓰기 명령 `touch`에만 호출) ⑤ `allowedTools`에 넣으면 자동 승인. → **`canUseTool`·`allowedTools`에 의존하지 않는다** |
| claude.ai 계정 커넥터 노출 | **간헐 발생 — 차단 필요** | **실행** claude.ai 로그인 상태의 한 실행(`claude-stream.json`)에서 `settingSources: []`인데도 계정 커넥터(Claude Docs·Google Drive 연결됨, Gmail·Calendar 인증 필요)가 MCP로 붙고 도구 20여 개가 노출됨. 이후 같은 조건 9회(`claude-mcp-scope.json`, `claude-mcp-repeat.json`, `strictMcpConfig` 유무 각각)에서는 재현되지 않음. 대응: `strictMcpConfig: true` + `PreToolUse` 훅은 **우리 MCP 서버 이름만** 허용 + **세션 시작(init) 때 `mcp_servers` 목록이 우리 서버만이 아니면 즉시 중단(fail closed)**. 훅이 커넥터 호출을 실제로 막는지는 재현이 안 돼 미검증 → #15에서 가짜 MCP 서버로 시험 |
| 사용자 설정 격리 | 지원 | **실행** `settingSources: []` → `~/.claude/CLAUDE.md` 미로딩(NO), `['user']`면 로딩(YES) (`claude-isolation.json`) |
| 설정·세션 폴더 격리 | 지원 | **실행** `CLAUDE_CONFIG_DIR=<연결 폴더>` → 키체인 로그인 미사용("Not logged in"), `.claude.json`·`sessions`·`projects`가 그 폴더에 생김 (`claude-configdir.json`). 인증은 `ANTHROPIC_API_KEY` 또는 `CLAUDE_CODE_OAUTH_TOKEN` 환경변수로 주입(**타입·문서**) |
| 환경변수 상속 차단 | 지원 | **타입·문서** `options.env`는 부모 환경을 대체(병합 아님) — 설치된 SDK 소스와 일치 |
| 사용량 | 지원 | **실행** `usage`(입력·출력·캐시 생성·캐시 읽기), `modelUsage`, `total_cost_usd`(추정치, 구독에서도 나옴) |
| 프롬프트 캐싱 | 자동 | **실행** resume 시 `cache_read_input_tokens` 약 14.7k (`claude-resume.json`) |
| 구독 한도 신호 | 미확인 | 한도 미도달 → #18에서 확인 |
| 구독 장기 토큰 | 경로만 | **타입·문서** `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`. 실제 주입 시험은 관리자의 1회 발급 필요(#18) |

## 2. Codex

### 2.1 app-server 프로토콜 (채택 경로)

| 항목 | 판정 | 근거 |
|---|---|---|
| 토큰 단위 스트리밍 | 지원 | **실행** `item/agentMessage/delta` 48개, 첫 delta 약 2.7초 (`codex-appserver.json` turn1) |
| MCP 호출(잠금 설정) | 지원 | **실행** features 끄기 + 사용자 MCP `node_repl` 끄기 설정에서 `mcpToolCall echo/echo_time: completed` (turn1). 같은 턴에 `~/.zshrc` 읽기를 요청했으나 **도구 호출 시도 자체가 관측되지 않았고** 모델이 "읽지 못했다"고만 답함 → 파일 접근 차단은 **접근 미관측**일 뿐 입증 아님. 또한 이 시험은 별도 `CODEX_HOME`이 아니라 기본 홈에서 사용자 MCP 하나만 끈 대용 설정 → **최종 격리 설정(연결별 `CODEX_HOME`)은 미검증**, #16·#42에서 로그인한 격리 홈으로 실행 검증 |
| 턴 사이 모델 변경 | 지원 | **실행** 같은 thread에서 `turn/start {model: "gpt-6-astra"}` → 앞 턴 태그 `a1` 기억, 이후 `thread/resume` 응답 모델이 `gpt-6-astra` (turn2) |
| 중단 | 지원 | **실행** delta 10개 후 `turn/interrupt` → 9ms 뒤 `turn/completed status: interrupted` (turn3). 도구 실행 중 중단은 미검증 → #16 |
| 모델 목록 | 지원 | **실행** `model/list` → 8개 (`gpt-6.1-sol`, `gpt-6-astra` 등) |
| 한도 신호 | 지원 | **실행** `account/rateLimits/read` 응답에 `rateLimits.primary` 존재. `account/rateLimits/updated` 알림은 **타입·문서** |
| 로그인 | 있음 | **타입·문서** `account/login/start`: `apiKey`, `chatgpt`, `chatgptDeviceCode`, `chatgptAuthTokens`. 실행 미검증 → #18 |
| 상태 | experimental | `codex app-server --help`에 실험적 표시 → 버전 고정, 업그레이드 시 프로브 재실행 |

### 2.2 SDK (`@openai/codex-sdk`, 내부적으로 `codex exec --json`) — 대체 구현으로 쓰지 않음

| 항목 | 판정 | 근거 |
|---|---|---|
| 토큰 단위 스트리밍 | **불가** | **실행** `item.completed`만, 글자 단위 갱신 0회 (`codex-stream.json`) |
| 이어가기 | 지원 | **실행** 같은 실행 묶음 stream → `resumeThread`(ID 일치) → `x1` 기억 (`codex-stream.json`, `codex-resume.json`) |
| 추론 강도 변경 | 지원 | **실행** 같은 thread를 다른 effort로 resume → 앞 내용 기억 (`codex-modelswitch.json`). 모델 자체 변경은 app-server에서 검증 |
| 추론 강도 검증 | 서버가 거부 | **실행** `gpt-6.1-sol`에 `minimal` → API가 거부(`turn.failed`), `low~max` 수락 (`codex-effort.json`) |
| 중단 | 지원 | **실행** `AbortSignal` — 첫 항목 완료 후 중단, 실행 시작부터 약 4초 (`codex-abort.json`). 중단 요청~종료 지연과 도구 실행 중 중단은 미측정 |

### 2.3 격리·권한 (두 경로 공통)

| 항목 | 판정 | 근거 |
|---|---|---|
| MCP 승인 설정 필요 | 필수 | **실행** 대조군: `default_tools_approval_mode` 없이 approval `never` → `MCP tool call requires approval` 실패 (`codex-mcp-noapprove.json`). 설정하면 성공 (`codex-stream.json`) |
| 사용자 설정 병합 | **위험 확인** | **실행** 기본 `CODEX_HOME`에서는 사용자 `~/.codex/config.toml`의 `node_repl` MCP가 붙어 `~/.zshrc`를 읽음 (`codex-lockdown.json`, 내용은 결과 파일에서 삭제) → **연결별 `CODEX_HOME` + 우리 `config.toml`만** 필수 |
| `read-only` sandbox | 읽기 제한 아님 | **실행** 셸 켜진 상태에서 `head -1 ~/.zshrc` 성공 (`codex-readonly-default.json`) |
| 내장 도구 끄기 | 지원(조합, 범위 한정) | **실행** `features.shell_tool/unified_exec/plugins/apps/browser_use/computer_use/memories=false` + 사용자 MCP 끄기 → 셸·파일 도구로 읽으려는 시도에서 실패 보고(`codex-lockdown2.json`, `codex-exec.json`의 `functions.exec` 시도는 "파일·셸 접근 없음"으로 실패), MCP는 성공 (app-server turn1). **`code_mode_host`는 끄면 안 됨** — 끄면 MCP 호출도 실패함(app-server 1차 실행에서 관측). code mode 런타임 자체에는 파일·셸 접근이 없음(`codex-exec.json`). 남는 도구: `request_user_input`, `clock.sleep`, `collaboration.*`(하위 에이전트) — 하위 에이전트 차단 설정은 미확인 → #16 |
| `CODEX_HOME` 격리 | 지원 | **실행** 빈 `CODEX_HOME` → 401(로그인 없음), 상태 sqlite·sessions가 그 폴더에 생김 (`codex-codexhome.json`). 401이면 재시도로 약 40초 지연 → 어댑터가 401을 즉시 실패 처리 |
| 환경변수 상속 차단 | 지원 | **타입·문서** `new Codex({ env })`는 부모 환경을 상속하지 않음. app-server는 우리가 프로세스 환경을 직접 지정 |
| 사용량 | 토큰만 | **실행** `input/cached_input/cache_write_input/output/reasoning_output` 토큰, 비용 없음 → 가격표로 계산. 기본 입력이 턴당 약 3만~4.4만 토큰(대부분 캐시) |

## 3. 구독 로그인 정책 (공식 문서, 2026-11-08 조회)

| 회사 | 판정 | 근거 |
|---|---|---|
| Anthropic | 불명확 — 가족 여러 명 사용은 금지 쪽에 가까움 | Agent SDK 개요: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods…" (https://code.claude.com/docs/en/agent-sdk/overview). 지원 문서는 SDK가 구독 한도에서 차감된다고만 함 (https://support.claude.com/en/articles/15036540). 소비자 약관은 계정·로그인 정보 공유와 API 키 외 자동화 접근을 제한 (https://www.anthropic.com/legal/consumer-terms). 본인이 본인 앱에서 쓰는 경우는 명시 없음 |
| OpenAI | 조건부 허용 | 헤드리스는 디바이스 코드 로그인 권장, 자동화는 API 키 권장 (https://learn.chatgpt.com/docs/auth). "ChatGPT plan usage for open-source and locally hosted apps" 경로 문서화, 유료·원격 호스팅은 별도 신청 (https://developers.openai.com/siwc/token-sharing-open-source) |

**사용자 결정 (2026-11-09)**: Claude 구독 로그인은 **관리자 본인 계정을 관리자 본인 대화에만**. 아내·아들의 Claude Code는 API 키. ChatGPT(Codex) 로그인은 가족 각자 본인 계정. → PRD v0.5 D2·FR-11.

## 4. 이슈 반영

1. **어댑터 계약(#12)**: 유지. 추론 강도 허용 범위는 우리 capability 표가 검증. 중단은 "사용자 요청 중단"과 "실패"를 구분하는 상태로 정의.
2. **Claude 어댑터(#15)**: `tools: []` + `disallowedTools`(내장 도구 이름 전체) + `strictMcpConfig: true` + **`PreToolUse` 훅으로 우리 MCP(`mcp__agentlee__*`) 외 전부 거부** + init의 `mcp_servers`가 우리 서버만이 아니면 세션 중단(계정 커넥터 대비, 관리자 Claude 구독 연결에서 특히 중요). `canUseTool`·`allowedTools`에 의존하지 않음. `settingSources: []`, 연결별 `CLAUDE_CONFIG_DIR`, `env` 허용 목록, 인증 환경변수 주입.
3. **Codex 어댑터(#16)**: app-server 프로토콜. 연결별 `CODEX_HOME` + 우리 `config.toml`만, 위 features 끄기(**`code_mode_host`는 유지**), MCP `default_tools_approval_mode = "approve"`, 401 즉시 실패, 하위 에이전트 차단 확인, 도구 실행 중 중단 시험.
4. **실행 격리(#42)**: 1차 방어는 내장 도구 제거(위 2·3), 2차 방어는 OS 수준 경로 제한. Codex `read-only` sandbox에 의존하지 않음. 최종 설정에서 "허용 MCP 성공 + 금지 접근 실패"를 함께 시험.
5. **구독 로그인(#18)**: Codex는 app-server `chatgptDeviceCode` 로그인 실행 검증, Claude는 관리자 장기 토큰 주입 실행 검증.
