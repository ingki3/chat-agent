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
| `@anthropic-ai/claude-agent-sdk` | 스파이크 0.3.319 → **앱은 0.3.312** (2026-10-27 배포. 의존성은 2주 이상 된 버전만 쓴다는 규칙에 따라 #15에서 낮춤. 샌드박스 실행·인증 실패 경로는 0.3.312로 다시 확인) |
| `@openai/codex-sdk` / `codex` CLI·app-server | 스파이크 0.167.0 → **앱은 `@openai/codex` 0.165.0** (2026-10-27 배포. 2주 규칙에 따라 #16에서 낮춤. 0.166.0은 10-29 배포라 아직 2주가 안 됨). 서버는 이 패키지가 함께 내려받는 플랫폼 바이너리(`@openai/codex-darwin-arm64`의 `vendor/aarch64-apple-darwin/bin/codex`)만 실행하고, PATH의 `codex`는 쓰지 않는다. 아래 2.4절에서 핵심 사실을 0.165.0으로 다시 확인 |
| `@modelcontextprotocol/sdk` (시험용 MCP 서버) | 1.32.2 |
| Node | 22.22.0 |

시험 조건: 두 런타임 모두 관리자 본인 구독 로그인(Claude: 키체인 로그인, Codex: ChatGPT 로그인). 이 환경에는 API 키가 없어 API 키 인증은 **타입·문서**로만 확인. 시험용 MCP 서버(`echo-mcp.mjs`)는 run 토큰의 원문 대신 전달 여부(`present/missing`)만 돌려준다.

## 1. Claude Code (Claude Agent SDK)

| 항목 | 판정 | 근거 |
|---|---|---|
| 토큰 단위 스트리밍 | 지원 | **실행** `includePartialMessages` → `text_delta` 22개 (`claude-stream.json`) |
| 세션 이어가기 | 지원 | **실행** 같은 실행 묶음에서 stream → `resume: <session_id>`(ID 일치) → 태그 `c1` 기억 (`claude-stream.json`, `claude-resume.json`) |
| 특정 메시지까지 잘라 이어가기 | 있음 | **타입·문서** `resumeSessionAt` + `resumeDropsTurn` (`sdk.d.ts`). 실행 미검증. *#45: 쓰지 않기로 함 — 수정·재생성 뒤에는 잘라 이어가지 않고 서버 기록으로 새 세션을 연다(ops.md §27.1). 두 런타임이 같은 규칙이고, 런타임 쪽 기록 잘라내기를 믿을 필요가 없다* |
| 같은 세션에서 모델 변경 | 지원 | **실행** 스트리밍 입력 모드, 1턴 `answeredBy: claude-opus-5-5` → `setModel` → 2턴 `answeredBy: claude-haiku-5-5`, 같은 세션 ID, 앞 내용 기억 (`claude-setmodel.json`) |
| 중단 | 지원 | **실행** `interrupt()` 응답 6ms, 종료까지 583ms. 결과는 `error_during_execution` + 예외 (`claude-interrupt.json`). 어댑터는 **우리가 interrupt를 요청한 run만** "중지됨"으로 매핑하고, 그 밖의 `error_during_execution`은 실패로 처리 |
| 추론 강도 | 수락만 확인 | **실행** Opus·Haiku 모두 `effort: low`·`max`를 오류 없이 수락하고 해당 모델이 응답 (`claude-effort.json`). 값이 실제 적용·무시·정규화되는지는 확인하지 않음 → 허용 범위는 우리 capability 표(관리자 설정 + 문서 근거)로 검증 |
| MCP 연결 | 지원 | **실행** stdio MCP `echo_time` 호출 성공, MCP 프로세스에 run 토큰 전달(`runToken=present`) (`claude-stream.json`) |
| MCP 연결 — 우리 HTTP 서버 (#43) | 지원 | **실행** 2026-11-11 `http-mcp-probe.mjs claude`: `{ type: "http", url, headers: { Authorization: "Bearer …" } }` → init `agentlee: connected`, 도구는 `mcp__agentlee__echo_time` 하나, 서버가 토큰 일치 확인, 응답에 사용자 이름. **`PreToolUse` 훅이 `{}`(결정 없음)만 돌려주면 SDK가 권한을 물어 호출이 실패**하므로, 훅은 우리 도구에 `permissionDecision: "allow"`를 명시한다 |
| 내장 도구 차단 | 지원 — **방식 주의** | **실행** (`claude-gate.json`, `claude-lockdown*.json`): ① `tools: []` → 내장 도구가 목록에서 빠짐(`claude-lockdown.json` 실행에서는 도구가 `mcp__echo__echo_time` 하나뿐. 단 아래 "계정 커넥터" 행 참조) ② `disallowedTools: ["Bash"]` → 도구 자체가 사라짐 ③ `PreToolUse` 훅 → 읽기 전용 명령까지 모든 호출을 잡아 거부 ④ **`canUseTool`은 읽기 전용 명령(`echo`)에는 호출되지 않고 그대로 실행됨**(쓰기 명령 `touch`에만 호출) ⑤ `allowedTools`에 넣으면 자동 승인. → **`canUseTool`·`allowedTools`에 의존하지 않는다** |
| claude.ai 계정 커넥터 노출 | **간헐 발생 — 차단 필요** | **실행** claude.ai 로그인 상태의 한 실행(`claude-stream.json`)에서 `settingSources: []`인데도 계정 커넥터(Claude Docs·Google Drive 연결됨, Gmail·Calendar 인증 필요)가 MCP로 붙고 도구 20여 개가 노출됨. 이후 같은 조건 9회(`claude-mcp-scope.json`, `claude-mcp-repeat.json`, `strictMcpConfig` 유무 각각)에서는 재현되지 않음. 대응: `strictMcpConfig: true` + `PreToolUse` 훅은 **우리 MCP 서버 이름만** 허용 + **세션 시작(init) 때 `mcp_servers` 목록이 우리 서버만이 아니면 즉시 중단(fail closed)**. 훅이 커넥터 호출을 실제로 막는지는 재현이 안 돼 미검증 → #15에서 가짜 MCP 서버로 시험 |
| 사용자 설정 격리 | 지원 | **실행** `settingSources: []` → `~/.claude/CLAUDE.md` 미로딩(NO), `['user']`면 로딩(YES) (`claude-isolation.json`) |
| 설정·세션 폴더 격리 | 지원 | **실행** `CLAUDE_CONFIG_DIR=<연결 폴더>` → 키체인 로그인 미사용("Not logged in"), `.claude.json`·`sessions`·`projects`가 그 폴더에 생김 (`claude-configdir.json`). 인증은 `ANTHROPIC_API_KEY` 또는 `CLAUDE_CODE_OAUTH_TOKEN` 환경변수로 주입(**타입·문서**) |
| 환경변수 상속 차단 | 지원 | **타입·문서** `options.env`는 부모 환경을 대체(병합 아님) — 설치된 SDK 소스와 일치 |
| 사용량 | 지원 | **실행** `usage`(입력·출력·캐시 생성·캐시 읽기), `modelUsage`, `total_cost_usd`(추정치, 구독에서도 나옴) |
| 프롬프트 캐싱 | 자동 | **실행** resume 시 `cache_read_input_tokens` 약 14.7k (`claude-resume.json`) |
| 구독 한도 신호 | 미확인(실계정) | 한도 미도달. 어댑터는 `rate_limit` 오류·`rate_limit_event rejected`를 한도로 본다(#15). #18: 구독 연결의 한도는 `subscription_limit` 안내로 이어진다. 실제 신호는 수동 확인(`docs/evidence/subscription/checklist.md`) |
| 구독 장기 토큰 | 경로만 | **타입·문서** `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`. #18: 저장(암호화)·관리자 전용 규칙·환경 변수 주입·만료 처리는 시험으로 확인(`claude.test.ts`, `subscription.test.ts`). 실제 토큰으로 로그인·응답·만료 확인은 관리자 수동 확인으로 남김(`docs/evidence/subscription/checklist.md`) |
| 구독 사용량 | 토큰만 기록 | #18: CLI는 구독에서도 `total_cost_usd`(API 가격으로 친 추정치)를 주지만, 구독에는 호출당 비용이 없으므로(FR-9.2) 어댑터가 비용을 빼고 토큰만 보고한다 |

## 2. Codex

### 2.1 app-server 프로토콜 (채택 경로)

| 항목 | 판정 | 근거 |
|---|---|---|
| 토큰 단위 스트리밍 | 지원 | **실행** `item/agentMessage/delta` 48개, 첫 delta 약 2.7초 (`codex-appserver.json` turn1) |
| MCP 호출 — 우리 HTTP 서버 (#43) | 지원 | **실행** 2026-11-11 `http-mcp-probe.mjs codex`(`codex exec`, 0.167.0): `mcp_servers.agentlee.url` + `bearer_token_env_var = "AGENTLEE_MCP_TOKEN"` + `default_tools_approval_mode = "approve"` → `mcp_tool_call agentlee/echo_time` 완료, 서버가 토큰 일치 확인. app-server·연결별 `CODEX_HOME`에서의 확인은 #16 |
| MCP 호출(잠금 설정) | 지원 | **실행** features 끄기 + 사용자 MCP `node_repl` 끄기 설정에서 `mcpToolCall echo/echo_time: completed` (turn1). 같은 턴에 `~/.zshrc` 읽기를 요청했으나 **도구 호출 시도 자체가 관측되지 않았고** 모델이 "읽지 못했다"고만 답함 → 파일 접근 차단은 **접근 미관측**일 뿐 입증 아님. 또한 이 시험은 별도 `CODEX_HOME`이 아니라 기본 홈에서 사용자 MCP 하나만 끈 대용 설정 → **최종 격리 설정(연결별 `CODEX_HOME`)은 미검증**, #16·#42에서 로그인한 격리 홈으로 실행 검증 |
| 턴 사이 모델 변경 | 지원 | **실행** 같은 thread에서 `turn/start {model: "gpt-6-astra"}` → 앞 턴 태그 `a1` 기억, 이후 `thread/resume` 응답 모델이 `gpt-6-astra` (turn2) |
| 중단 | 지원 | **실행** delta 10개 후 `turn/interrupt` → 9ms 뒤 `turn/completed status: interrupted` (turn3). 도구 실행 중 중단은 미검증 → #16 |
| 모델 목록 | 지원 | **실행** `model/list` → 8개 (`gpt-6.1-sol`, `gpt-6-astra` 등) |
| 한도 신호 | 지원 | **실행** `account/rateLimits/read` 응답에 `rateLimits.primary` 존재. `account/rateLimits/updated` 알림은 **타입·문서** |
| 로그인 | 있음 | `account/login/start`: `apiKey`, `chatgpt`, `chatgptDeviceCode`, `chatgptAuthTokens`. 0.165.0에서 실행 확인 → 2.5절(#18) |
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
| 내장 도구 끄기 | 지원(조합, 범위 한정) | **실행** `features.shell_tool/unified_exec/plugins/apps/browser_use/computer_use/memories=false` + 사용자 MCP 끄기 → 셸·파일 도구로 읽으려는 시도에서 실패 보고(`codex-lockdown2.json`, `codex-exec.json`의 `functions.exec` 시도는 "파일·셸 접근 없음"으로 실패), MCP는 성공 (app-server turn1). **`code_mode_host`는 끄면 안 됨** — 끄면 MCP 호출도 실패함(app-server 1차 실행에서 관측). *→ #16에서 원인 확인: 내장 카탈로그의 code mode 때문. 우리 카탈로그(`tool_mode: "direct"`)로는 끄고도 MCP가 동작하며, 켜 두면 자식 프로세스가 생긴다(2.4절).* code mode 런타임 자체에는 파일·셸 접근이 없음(`codex-exec.json`). 남는 도구: `request_user_input`, `clock.sleep`, `collaboration.*`(하위 에이전트) — 하위 에이전트 차단 설정은 미확인 → #16 *(2.4절: 카탈로그 `multi_agent_version: "disabled"`로 차단)* |
| `CODEX_HOME` 격리 | 지원 | **실행** 빈 `CODEX_HOME` → 401(로그인 없음), 상태 sqlite·sessions가 그 폴더에 생김 (`codex-codexhome.json`). 401이면 재시도로 약 40초 지연 → 어댑터가 401을 즉시 실패 처리 |
| 환경변수 상속 차단 | 지원 | **타입·문서** `new Codex({ env })`는 부모 환경을 상속하지 않음. app-server는 우리가 프로세스 환경을 직접 지정 |
| 사용량 | 토큰만 | **실행** `input/cached_input/cache_write_input/output/reasoning_output` 토큰, 비용 없음 → 가격표로 계산. 기본 입력이 턴당 약 3만~4.4만 토큰(대부분 캐시) |

### 2.4 0.165.0 재확인 (#16, 2026-11-11)

자격 증명 없이 확인했다. 실제 바이너리를 우리 샌드박스(`spawnIsolated`, fork 금지)로 띄우고 **가짜 Responses API**(로컬 SSE 서버, 시험 전용 `model_provider`)에 붙였다. 모델에게 실제로 보낸 요청 본문(도구 목록·지시문·입력)을 그대로 볼 수 있다. OpenAI API 경로는 가짜 키로 401까지만 확인했다. 재현: `apps/server/test/codex.test.ts`의 macOS 실바이너리 시험.

| 항목 | 0.165.0 판정 | 근거 |
|---|---|---|
| app-server 메서드 | 지원 | **실행** `initialize` → `account/login/start` → `thread/start`·`thread/resume` → `turn/start` → `turn/interrupt`. 알림: `item/agentMessage/delta`(글자), `item/reasoning/summaryTextDelta`·`textDelta`, `item/started`·`item/completed`(`mcpToolCall`은 `server`·`tool`이 따로 옴 — 이름 접두사 없음), `thread/tokenUsage/updated`, `account/rateLimits/updated`, `error`(`codexErrorInfo`, `willRetry`), `turn/completed`(`completed`·`interrupted`·`failed`) |
| **`code_mode_host`** | **스파이크 결론을 뒤집음 — 끈다** | **실행** 내장 모델 카탈로그가 모든 모델을 `tool_mode: "code_mode_only"`로 둔다. 이때 MCP 도구는 JavaScript `exec` 도구 안에서만 부를 수 있고, `exec`는 별도 바이너리 `codex-code-mode-host`를 **자식 프로세스로 띄워** 실행한다. 샌드박스에서는 `failed to spawn code-mode host …: Operation not permitted`. 스파이크의 "끄면 MCP도 실패"는 이 때문이었다. **우리 카탈로그**(`model_catalog_json`, 내장 카탈로그에서 만들고 `tool_mode: "direct"`)를 쓰면 MCP 도구가 일반 함수 도구(`mcp__agentlee` 네임스페이스)가 된다. 그러면 `code_mode_host = false`에서도 MCP 호출이 성공하고, 자식 프로세스는 생기지 않는다 |
| 하위 에이전트(`collaboration.*`) | 막힘(카탈로그로) | **실행** `spawn_agent`·`send_message`·`wait_agent` 등이 기본으로 제공된다. 모델 카탈로그의 `multi_agent_version: "v2"` 때문이라 `features.multi_agent = false`만으로는 **안 빠진다**. 카탈로그에서 `multi_agent_version: "disabled"`로 하면 빠진다. 다른 thread의 알림이 오면 어댑터가 턴을 멈춘다(fail closed) |
| 최종 도구 목록 | 확인 | **실행** 모델에게 가는 도구는 `functions.list_mcp_resources`·`list_mcp_resource_templates`·`read_mcp_resource`와 그 run의 우리 도구(`mcp__agentlee.<이름>`)뿐이다. `exec`·셸·`apply_patch`·`view_image`·goals·sleep·sub-agent·skills·`request_user_input`(`[tools.experimental_request_user_input] enabled = false`) 없음. `enabled_tools`로 run에 허용된 도구만 노출됨 |
| MCP 승인 설정 | 여전히 필수 | **실행** `default_tools_approval_mode` 없이 approval `never` → `MCP tool call requires approval, but approval policy is never` |
| 401 | 즉시 실패 처리 | **실행** 가짜 키로 실제 API(프록시 경유): 첫 `error` 알림이 약 3초에 `willRetry: true`, `responseStreamDisconnected{httpStatusCode: 401}`로 온다. 그대로 두면 WebSocket 5회 + HTTPS 5회 재시도 뒤 15~22초에 실패. 어댑터는 첫 401에서 `turn/interrupt`하고 `runtime_auth` |
| API 키 전달 | stdin으로만 | **실행** app-server는 환경 변수 `CODEX_API_KEY`·`OPENAI_API_KEY`를 쓰지 않는다("Missing bearer"). `account/login/start {type:"apiKey"}` + `cli_auth_credentials_store = "ephemeral"` → 키는 메모리에만 있고 `auth.json`이 생기지 않는다. 실행 뒤 연결 폴더에 키 원문 없음 |
| 프록시 | 지원 | **실행** `HTTPS_PROXY`를 WebSocket(`wss://api.openai.com/v1/responses`)과 HTTPS 모두에 쓴다. API 키 경로에서 연결한 호스트는 `api.openai.com`뿐(우리 설정: 카탈로그 고정, 분석·업데이트 확인 끔) |
| TLS | CA 파일 필요 | **실행** 샌드박스 안에서는 플랫폼 인증서 검증이 trustd에 닿지 못해 `invalid peer certificate: UnknownIssuer`. `CODEX_CA_CERTIFICATE=/private/etc/ssl/cert.pem`(읽기 허용)로 해결 |
| fork | 없음 | **실행** 위 설정으로 시작·MCP 호출·중단·재개 모두 fork 없이 동작. 단 `shell_snapshot`(기본 켜짐)은 사용자 셸을 띄워 환경 변수를 `shell_snapshots/`에 저장한다(샌드박스 밖 시험에서 환경 변수의 키가 파일에 남는 것을 확인) → 끈다 |
| 프롬프트 확장 | `$스킬`만 있음 → 막음 | **실행** `@파일`·`/명령`·`!명령`은 글자 그대로 간다. **`$이름`은 SKILL.md를 읽어 프롬프트에 붙인다.** `skills.include_instructions = false`, 내장 스킬 끄기로도 꺼지지 않는다. 찾는 곳: `CODEX_HOME/skills`, `HOME/.agents/skills`, cwd의 `.agents/skills`·`.codex/skills`. 또 `CODEX_HOME/AGENTS.md`는 `project_doc_max_bytes = 0`이어도 읽힌다. 대응: 시작마다 이 파일들을 지우고, 프로세스는 `work`·`home`에 쓸 수 없게 한다(아래 isolation.md) |
| 알림의 thread 표시 | 형태가 여러 가지 | **바인딩** `generate-ts`(0.165.0): 대부분 `params.threadId`(문자열). `mcpServer/startupStatus/updated`·`oauthLogin/completed`·`warning`은 `string \| null`(null = 전역). `thread/started`는 `params.thread.id`. 계정·속도 제한 등은 thread 없음. 표는 `apps/server/src/runtime/codex-protocol.ts` |
| 도구 실행 중 중단 | 지원 | **실행** 우리 MCP 도구가 20초 걸리는 동안 `turn/interrupt` → 수 ms 안에 `turn/completed status: interrupted`. 그 도구의 `item/completed`는 오지 않는다 |
| 재개 | 지원 | **실행** 새 프로세스에서 `thread/resume` → 이전 턴 내용이 요청에 포함, 시작 때의 developer 지시(이전 대화)는 한 번만. 없는 thread id는 오류 응답 → `SessionGoneError` |
| 한도 | 지원 | **실행**(가짜 API) 사용 한도 429 → `codexErrorInfo: "usageLimitExceeded"`, `willRetry: false`. 속도 제한 429 → `responseTooManyFailedAttempts{429}`. 스냅샷의 `rateLimitReachedType`. 어댑터는 실패한 턴만 `limit`으로 본다 |
| 사용량·캐시 | 토큰만 | **실행** `thread/tokenUsage/updated`의 `total`(thread 누적)·`last`(마지막 요청). `cachedInputTokens`·`cacheWriteInputTokens` 포함, 비용 없음. 요청에 `prompt_cache_key = thread id`. 어댑터는 턴의 첫 보고에서 기준값(`total − last`)을 잡아 그 턴의 몫만 보고. 실제 API의 캐시 적중은 자격 증명이 생기면 녹화로 확인 |

### 2.5 ChatGPT 로그인 (#18, 0.165.0, 2026-11-11)

실제 ChatGPT 계정 없이 확인했다(사용자의 `~/.codex` 로그인은 쓰지 않음). 고정 바이너리를 우리 샌드박스와 송신 프록시로 띄우고, 프록시가 받은 CONNECT 호스트를 기록했다. 재현: `apps/server/test/codex.test.ts`의 macOS 시험 3개(`#18`), 프로토콜은 `codex app-server generate-ts`.

| 항목 | 판정 | 근거 |
|---|---|---|
| 디바이스 코드 시작 | 지원 | **실행** `account/login/start {type:"chatgptDeviceCode"}` → `{type, loginId, verificationUrl: "https://auth.openai.com/codex/device", userCode: "XXXX-XXXXX"}`. 이때 연결한 호스트는 **`auth.openai.com`뿐**. 계정이 필요 없는 요청이라 실제 서비스로 시험한다(온라인일 때) |
| 취소 | 지원 | **실행** `account/login/cancel {loginId}` → `{status:"canceled"}`, 이어서 `account/login/completed {loginId, success:false, error:"Login was not completed"}` |
| 완료 알림 | 바인딩 | **바인딩** `account/login/completed {loginId, success, error}`. 성공은 실제 계정이 있어야 해서 수동 확인(`docs/evidence/subscription/checklist.md`) |
| 토큰 꺼내기 | 파일로만 | **바인딩·문자열** app-server에는 토큰을 돌려주는 요청이 없다(`account/read`는 `{type:"chatgpt", email, planType}`만). 그래서 **로그인 과정 하나만** `cli_auth_credentials_store = "file"`로 띄워, 끝나면 `CODEX_HOME/auth.json`(`tokens.{id_token, access_token, refresh_token, account_id}`)을 서버가 곧바로 읽고 덮어쓴 뒤 로그인 폴더째 지운다. 파일 형식은 고정 버전 기준이라 버전을 올리면 수동 확인을 다시 한다 |
| 실행에 토큰 주입 | 지원 | **실행** `account/login/start {type:"chatgptAuthTokens", accessToken, chatgptAccountId, chatgptPlanType}` → `{type:"chatgptAuthTokens"}`. **`initialize`에서 `experimentalApi: true`가 있어야 한다**(없으면 `requires experimentalApi capability` 오류). 네트워크 없이도 받아들이고, `auth.json`은 생기지 않으며 폴더에 토큰이 남지 않는다 |
| 갱신 요청 | 지원 | **실행**(가짜 토큰) 백엔드가 거부하면 app-server가 클라이언트에게 서버 요청 `account/chatgptAuthTokens/refresh {reason:"unauthorized", previousAccountId}`를 보낸다. 응답 `{accessToken, chatgptAccountId, chatgptPlanType}`. 거부하면 재시도할 때마다(웹소켓 5회 + HTTPS 5회) 다시 묻고, 오류 알림은 `httpStatusCode: null`("workspace routing discovery unauthorized (401)")로 온다 → 어댑터는 갱신 거부·3회 초과 시 `runtime_auth`로 끝낸다. 외부 토큰 모드에서는 app-server가 스스로 갱신하지 않는다(`GetAccountParams.refreshToken` 설명) |
| 갱신 방법 | 서버가 직접 | **문자열** 바이너리의 OAuth 클라이언트 id `app_EMoamEEZ73f0CkXaXp7hrann`, 토큰 엔드포인트 `https://auth.openai.com/oauth/token`(`grant_type: refresh_token`, `scope: "openid profile email"`, JSON). 서버(`connections/chatgpt.ts`)가 이 요청을 보내고 결과를 암호화해 저장한다. 리프레시 토큰은 런타임 프로세스에 들어가지 않는다. 실제 응답 형식은 수동 확인 대상 |
| ChatGPT 세션의 호스트 | `chatgpt.com`만 | **실행**(가짜 토큰) 모델 목록 `https://chatgpt.com/backend-api/codex/models`, 작업 공간 확인, 응답 요청이 모두 `chatgpt.com`. `api.openai.com`·`auth.openai.com`·`ab.chatgpt.com`(분석, 꺼 둠)은 연결하지 않음 |
| 로그인 직후 작업 공간 확인 | `chatgpt.com` 필요 | **실행**(가짜 토큰, 온라인) ChatGPT 로그인이 들어가면(`chatgptAuthTokens`) 우리가 아무 요청도 하지 않아도 app-server가 스스로 `chatgpt.com`에 "workspace routing discovery"를 하고, 그 결과로 `account/login/completed`를 보낸다(실패면 `success:false`, "workspace routing discovery unauthorized (401)"). `account/read`도 같은 확인을 한다. 디바이스 코드 로그인도 끝에 같은 ChatGPT 로그인을 들이므로, `chatgpt.com`을 막으면 실제 로그인이 완료되지 못할 것으로 본다(실계정 확인은 체크리스트) |
| 링크·코드 형식 | 고정 | **실행** 세 번 시작해 모두 `https://auth.openai.com/codex/device`, 코드는 `XXXX-XXXXX`(영문 대문자·숫자 4+5). 이 둘만 화면에 보인다 |
| 송신 허용 | 근거 | API 키 세션: `api.openai.com`(그대로). ChatGPT 세션: `chatgpt.com`(`CODEX_CHATGPT_EGRESS_HOSTS`). 로그인 과정: `auth.openai.com`(코드·폴링·토큰 교환) + `chatgpt.com`(위 작업 공간 확인 — `codex.test.ts` macOS 온라인 시험이 재현)(`CODEX_LOGIN_EGRESS_HOSTS`). 서버 자신은 갱신 때 `auth.openai.com`에 직접 요청한다(`safeFetch`, 사설 주소 차단). 셋은 프록시가 따로라 API 키 세션은 `chatgpt.com`에, ChatGPT 세션은 `auth.openai.com`에 닿지 못한다 |
| 구독 한도 | 기존 신호 | `usageLimitExceeded` 등 2.4절과 같은 신호. 구독이면 대화에 `subscription_limit` 안내("지금 이 런타임은 한도에 걸렸어요")와 다른 런타임 제안(`switchTo`) |

## 3. 구독 로그인 정책 (공식 문서, 2026-11-08 조회)

| 회사 | 판정 | 근거 |
|---|---|---|
| Anthropic | 불명확 — 가족 여러 명 사용은 금지 쪽에 가까움 | Agent SDK 개요: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods…" (https://code.claude.com/docs/en/agent-sdk/overview). 지원 문서는 SDK가 구독 한도에서 차감된다고만 함 (https://support.claude.com/en/articles/15036540). 소비자 약관은 계정·로그인 정보 공유와 API 키 외 자동화 접근을 제한 (https://www.anthropic.com/legal/consumer-terms). 본인이 본인 앱에서 쓰는 경우는 명시 없음 |
| OpenAI | 조건부 허용 | 헤드리스는 디바이스 코드 로그인 권장, 자동화는 API 키 권장 (https://learn.chatgpt.com/docs/auth). "ChatGPT plan usage for open-source and locally hosted apps" 경로 문서화, 유료·원격 호스팅은 별도 신청 (https://developers.openai.com/siwc/token-sharing-open-source) |

**사용자 결정 (2026-11-09)**: Claude 구독 로그인은 **관리자 본인 계정을 관리자 본인 대화에만**. 아내·아들의 Claude Code는 API 키. ChatGPT(Codex) 로그인은 가족 각자 본인 계정. → PRD v0.5 D2·FR-11.

## 4. 이슈 반영

1. **어댑터 계약(#12)**: 유지. 추론 강도 허용 범위는 우리 capability 표가 검증. 중단은 "사용자 요청 중단"과 "실패"를 구분하는 상태로 정의.
2. **Claude 어댑터(#15)**: `tools: []` + `disallowedTools`(내장 도구 이름 전체) + `strictMcpConfig: true` + **`PreToolUse` 훅으로 우리 MCP(`mcp__agentlee__*`) 외 전부 거부** + init의 `mcp_servers`가 우리 서버만이 아니면 세션 중단(계정 커넥터 대비, 관리자 Claude 구독 연결에서 특히 중요). `canUseTool`·`allowedTools`에 의존하지 않음. `settingSources: []`, 연결별 `CLAUDE_CONFIG_DIR`, `env` 허용 목록, 인증 환경변수 주입.
3. **Codex 어댑터(#16)**: app-server 프로토콜. 연결별 `CODEX_HOME` + 우리 `config.toml`만, 위 features 끄기, MCP `default_tools_approval_mode = "approve"`, 401 즉시 실패, 하위 에이전트 차단, 도구 실행 중 중단 시험. **0.165.0에서 바뀐 점(2.4절):** 우리 모델 카탈로그(`tool_mode: "direct"`, `multi_agent_version: "disabled"`)를 쓰고 **`code_mode_host`는 끈다**(켜 두면 MCP 호출마다 자식 프로세스).
4. **실행 격리(#42)**: 1차 방어는 내장 도구 제거(위 2·3), 2차 방어는 OS 수준 경로 제한. Codex `read-only` sandbox에 의존하지 않음. 최종 설정에서 "허용 MCP 성공 + 금지 접근 실패"를 함께 시험.
5. **구독 로그인(#18)**: Codex는 디바이스 코드 시작·취소, `chatgptAuthTokens` 주입, 갱신 요청을 0.165.0으로 실행 확인(2.5절). 실제 계정으로의 로그인 완료·응답·만료와 Claude 장기 토큰 주입은 수동 확인으로 남김(`docs/evidence/subscription/checklist.md`).
