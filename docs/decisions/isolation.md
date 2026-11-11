# 결정 기록 — 실행 격리 방식 (#42)

## 결론
런타임 CLI·스킬 프로세스는 **macOS `sandbox-exec`** 로 실행한다(`apps/server/src/isolation/sandbox.ts`). 프로파일은 실행마다 만든다.

- `(deny default)` + `(import "system.sb")`(OS 라이브러리·dyld) 위에 허용할 것만 연다.
  - 읽기·쓰기 경로
  - 실행 파일(`literal`)
  - 네트워크: 없음 / 전체 / 특정 루프백 포트(우리 MCP 서버)
- 환경 변수는 호출자가 준 것만 넘긴다(부모 환경 상속 없음).
- **자식 프로세스 생성(fork)은 금지**다(프로파일에 `process-fork` 없음).
  - 폴링으로 자손을 쫓는 방식은 첫 측정 전에 `setsid`로 고아가 된 프로세스를 놓칠 수 있어(리뷰 #76) 쓰지 않는다.
  - 프로세스 하나만 실행하므로 한도·종료가 확실하다.
  - 우리 MCP 서버는 서버 안에서 루프백 포트로 제공한다(런타임이 MCP 때문에 fork할 필요가 없다).
  - #15·#16에서 런타임 CLI가 fork 없이 동작하는지 확인하고, 필요하면 이 결정을 다시 연다.
    - 확인됨: Claude Code 0.3.312(#15), codex app-server 0.165.0(#16 — 우리 모델 카탈로그로 code-mode host를 쓰지 않을 때).
- 메모리는 250ms마다 `ps`로 잰다. 측정이 안 되면 실행을 멈춘다(fail closed).
- **하드링크:** 샌드박스 안에서는 허용 폴더 밖 파일로 하드링크를 만들 수 없다(실행 확인). 밖에서 이미 만들어진 하드링크는 경로 검사로 구별할 수 없다. 그래서:
  - 링크가 2개 이상인 일반 파일은 경로 검사에서 거부한다(`resolveInside`).
  - 허용 폴더에 그런 파일이 하나라도 있으면 프로세스 실행 자체를 거부한다(`runIsolated`). 프로그램 설치 폴더처럼 가족 데이터가 아닌 곳은 `trusted`로 넘겨 검사하지 않는다.
- **실행 중에 생기는 하드링크**(리뷰 #76 3차)는 실행 전 검사로는 못 막는다. 하지만 가족 폴더에 하드링크를 만들 수 있는 주체는 셋뿐이다.
  - **샌드박스 프로세스:** 허용 폴더 밖 파일로는 링크를 만들 수 없다(커널이 거부, 시험으로 확인).
  - **서버:** 링크를 만들지 않는다(소스에 `link()`가 없음을 시험으로 고정).
  - **Mac의 사용자·관리자:** 원래 모든 파일에 접근할 수 있어 격리 대상이 아니다.
  - 그래서 실행 전 검사로 충분하다고 본다. 서버가 링크를 만들게 되거나 샌드박스 밖 작업자가 가족 폴더에 쓰게 되면 이 판단을 다시 연다.
- **서버가 직접 파일을 열 때**(`openInside`):
  - 검사한 실제 경로를 macOS `O_NOFOLLOW_ANY`로 연다. 검사 뒤 상위 폴더가 심볼릭 링크로 바뀌면 열기가 실패한다.
  - 연 디스크립터의 inode·링크 수를 다시 확인한다.
  - `O_NONBLOCK`으로 열어 FIFO·장치 파일이 서버의 파일 I/O 작업자를 붙잡지 못하게 하고, 디스크립터 검사에서 거부한다.
  - macOS가 아니면 거부한다.
- **외부 요청:** 전역 Agent 대신 전용 Agent를 쓴다(프록시 환경변수 무시).
- 작업 폴더는 고정한다.
- 한도:
  - 시간·출력 크기·메모리(프로세스 그룹 RSS를 250ms마다 확인)
  - 넘으면 프로세스 그룹 전체를 SIGKILL로 끝낸다.
- macOS가 아니면 실행을 거부한다(fail closed). 운영 머신은 집 Mac 한 대다(D4).

## 근거 (2026-11-10, macOS 27.0.1에서 실행)

| 시험 | 결과 |
|---|---|
| 허용 폴더 파일 읽기 | 성공 |
| 다른 가족 폴더 절대경로 | 거부 (`Operation not permitted`) |
| 허용 폴더 안의 심볼릭 링크 → 다른 가족 파일·폴더 | 거부(커널이 실제 경로로 판정) |
| `~/.claude`·`~/.codex`·`~/.zshrc` | 거부 |
| 허용하지 않은 실행 파일(`/bin/ls`, `/usr/bin/id`) | `execvp` 거부 |
| 허용 폴더 밖 쓰기 | 거부 |
| 네트워크 기본 | 거부 |
| 루프백 한 포트만 허용 | 그 포트 성공, 다른 포트 `EPERM` |

주의:
- `/bin/sh`는 `/private/var/select/sh`를 거쳐 bash를 다시 실행하므로 그대로는 막힌다. 셸이 필요하면 `/bin/bash`를 직접 허용한다.
- `curl`은 프록시 자동 구성 서비스가 필요해 네트워크 시험에 맞지 않다. 시험은 node로 한다.

## 대안
- **Codex `read-only` sandbox:** 읽기를 막지 않는다(스파이크 #39). 그래서 의존하지 않는다.
- **컨테이너(Docker 등):** 집 Mac에 상주 VM이 필요하다. 런타임의 구독 로그인·키체인 처리도 복잡해진다.
- **`sandbox-exec`가 deprecated인 점:** macOS 27까지 동작하는 것을 확인했다. 업그레이드 때 `apps/server/test/isolation.test.ts`(macOS에서만 실행)가 바로 알려 준다.

## 이 이슈에서 만든 것과 남은 것
- **만든 것:**
  - 프로세스 래퍼
  - 경로 검사 `resolveInside`
  - 네트워크 정책 `safeFetch`: 연결 시점 DNS 주소 검사, 리다이렉트마다 재검사
  - run 범위 MCP 토큰
  - 두 런타임의 내장 도구 잠금 설정: `runtime/lockdown.ts`
- **남은 것:** 실제 런타임(#15 Claude, #16 Codex)을 이 래퍼·설정으로 실행한다. "허용 MCP 호출 성공 + 금지 접근 실패"를 같은 시험에서 확인하는 일은 각 어댑터 이슈에서 이 모듈로 한다.

## 공통 MCP 서버 연결 (#43)
- 우리 MCP 서버(`packages/mcp-tools`)는 Agent Lee 서버 프로세스 안에서 **별도 루프백 포트**(`127.0.0.1:임의 포트`, Streamable HTTP, 경로 `/mcp`)로 연다.
  - 공개 앱 포트(3000, 터널 연결)와는 다른 포트라서 바깥에서는 닿지 않는다.
  - 도구를 쓰는 런타임(`capabilities().usesTools`)의 첫 실행 때 연다. 가짜 런타임이나 테스트에서는 포트를 열지 않는다.
- 요청은 하나하나 따로 확인하고(세션 상태 없음), 다음 경우 거부한다.
  - 경로가 `/mcp`가 아님
  - Host가 루프백 주소이면서 이 포트가 아님(DNS 리바인딩 방지)
  - 브라우저 `Origin` 헤더가 있음
  - POST가 아님
  - 본문이 1MB를 넘음
  - run 범위 토큰(`Authorization: Bearer`)이 없거나, 만료·폐기됐거나, 비활성 사용자의 것임
  - 도구가 끝났을 때 run이 이미 끝나 토큰이 폐기됐으면, 그 결과도 버린다.
- 런타임 설정(`runtime/lockdown.ts`):
  - **Claude:** `mcpServers.agentlee = { type: "http", url, headers: { Authorization } }`
  - **Codex:** `config.toml`에는 `url`과 `bearer_token_env_var = "AGENTLEE_MCP_TOKEN"`만 적는다. 토큰은 app-server 환경 변수로만 넘긴다(`codexMcpEnv`).
  - 샌드박스 네트워크는 `{ loopbackPorts: [mcpLoopbackPort(mcp)] }`이다.
- **스킬:** 허용 목록(`BUNDLED_SKILLS`, 지금은 검증용 `selftest` 하나)에 있는 것만 `skill_<이름>` 도구로 보인다. 실행은 `runIsolated`로 한다.
  - 읽기: 스킬 폴더와 node 실행 파일만(설치 폴더는 읽지 못함 — 시스템 라이브러리만 쓰는 공식 빌드 node 필요, 아니면 `skill_failed`로 막힘)
  - 쓰기·네트워크·자식 프로세스·환경 변수: 없음
  - 입력은 실행 전에 검증한다.
  - macOS가 아니면 `skill_unavailable`로 거부한다.
- 샌드박스 프로파일은 허용 경로 **상위 폴더들의 메타데이터(stat)** 를 읽게 한다. 내용과 목록은 읽지 못한다. node가 스크립트 경로를 `realpath`로 풀 때 상위 폴더를 하나씩 stat하기 때문이다.

## Claude Code CLI를 샌드박스에서 실행 (#15)
- SDK의 `spawnClaudeCodeProcess`로 CLI를 `spawnIsolated`(`runIsolated`의 장기 실행판)로 띄운다. 같은 프로파일을 쓰고, 하드링크 검사와 메모리 감시도 같다.
- **읽기·쓰기:** 연결 폴더만 쓴다. 폴더는 **연결과 사용자마다** 따로 있다(`data/runtimes/<연결 id>/<사용자 id>`). 그래서 가족이 같은 API 키를 써도 세션·캐시·대화 기록이 다른 사람의 샌드박스 안에 놓이지 않는다(리뷰 #80).
- **실행:** CLI 바이너리 하나만 쓰고, 자식 프로세스는 만들 수 없다.
- **네트워크:** 루프백만 쓴다(`{ loopbackPorts: [MCP 포트, 송신 프록시 포트] }`). 인터넷은 서버 안의 **송신 프록시**(`isolation/egress.ts`, `HTTPS_PROXY`)로만 나간다.
  - 프록시는 `CONNECT <허용 호스트>:443`만 받는다. 지금 허용 호스트는 `api.anthropic.com`뿐이다.
  - 이름은 프록시가 직접 해석한다. 결과에 루프백·사설·링크 로컬·메타데이터 주소가 하나라도 있으면 거부한다.
  - 평문 HTTP 프록시는 하지 않는다.
  - 처음 설계한 "TCP 443 전체 + DNS" 규칙은 루프백·사설망의 443까지 열기 때문에 버렸다(리뷰 #80).
  - CLI 안에서는 DNS와 trustd 없이도 TLS가 동작한다(실 CLI로 확인).
- **프롬프트:** `verbatimPrompts: true`로 넘긴다. 이게 없으면 CLI가 `@파일`을 풀어 파일 내용을 세션에 붙이고(리뷰 #80, 실 CLI로 재현), 슬래시 명령도 실행한다. 실 CLI 시험으로 막혔는지 확인한다.
- **도구 승인 훅:** 그 run의 도구 이름 `mcp__agentlee__<이름>`과 **정확히 일치**해야 하고, SDK가 알려 준 출처가 `{ name: "agentlee", source: "dynamic" }`이어야 허용한다.
  - 접두사만 보면 `agentlee__extra` 같은 계정 커넥터를 통과시킬 수 있다.
  - 출처가 없는 호출은 거부한다.
- **fork 없이 동작함을 확인했다**(0.3.312, 2026-11-11). 가짜 API 키로 실행하면 프록시를 거쳐 API의 401(`authentication_failed`)까지 간다. 연결 폴더에 키 원문은 없다. 이 시험은 macOS 테스트로 남겼다.
- CLI는 `TMPDIR`과 상관없이 `/tmp/claude-<uid>`를 만들려 한다. 그래서 `CLAUDE_CODE_TMPDIR`을 연결 폴더 안으로 지정한다.
- **서버만 쓰는 세션 정보:** CLI가 쓸 수 있는 폴더 밖의 `<연결 폴더>-meta/<세션>.json`에 둔다. 담는 것은 두 가지다.
  - 세션을 시작할 때의 시스템 프롬프트(이전 대화 포함). 이어갈 때 같은 것을 보낸다.
  - 이미 보고한 누적 비용. 이어갈 때 턴별 비용만 보고하는 데 쓴다.

## Codex app-server를 샌드박스에서 실행 (#16)
- `@openai/codex` **0.165.0**의 플랫폼 바이너리(`codex app-server --strict-config --listen stdio://`)를 세션마다 하나 `spawnIsolated`로 띄운다. PATH의 `codex`나 사용자 `~/.codex`는 쓰지 않는다.
- **폴더:** 연결 × 사용자마다 `data/runtimes/<연결 id>/<사용자 id>/`. 안에 `codex-home`(CODEX_HOME: 우리 `config.toml`·모델 카탈로그·thread 기록·상태 DB), `home`, `work`(cwd), `tmp`.
  - **읽기:** 이 폴더와 CA 묶음(`/private/etc/ssl/cert.pem`)만.
  - **쓰기:** `codex-home`과 `tmp`만. `work`·`home`에는 쓸 수 없다(아래 "스킬 파일" 참고).
  - 서버만 쓰는 thread 정보(시작 지시문·이전 대화)는 폴더 밖 `<연결 폴더>-meta/<thread id>.json`.
- **실행:** 바이너리 하나. 자식 프로세스는 만들 수 없다.
  - **fork 없이 동작함을 확인했다**(0.165.0, 2026-11-11). 단 기본 설정 그대로는 아니다. 내장 카탈로그는 MCP 호출을 JavaScript `exec`로만 하게 하고, `exec`는 `codex-code-mode-host`를 **자식 프로세스로** 띄운다(샌드박스에서 `Operation not permitted`).
  - 그래서 **우리 모델 카탈로그**를 쓴다(`codexModelCatalog`). 이것은 시작할 때 고정 바이너리의 `codex debug models --bundled`를 샌드박스 안(네트워크 없음)에서 실행해 만든다. 모델은 우리가 제공하는 것만 남기고 다음 값을 덮어쓴다.
    - `tool_mode: "direct"`: MCP 도구를 일반 함수 도구로 만든다.
    - `multi_agent_version: "disabled"`: 하위 에이전트 도구를 없앤다.
    - `apply_patch`·실험 도구·도구 검색을 없앤다.
  - 이 카탈로그에서는 `code_mode_host`를 끈다.
  - 원격 code-mode host(`--code-mode-host`)를 따로 샌드박스에 띄우는 방법도 동작했다(`grpc+stdio` + 서버 중계). 하지만 프로세스와 노출 도구(JS 실행·apply_patch·view_image)만 늘어서 쓰지 않는다.
- **네트워크:** 루프백만 쓴다(`{ loopbackPorts: [MCP 포트, 송신 프록시 포트] }`).
  - 인터넷은 Codex 전용 송신 프록시(`HTTPS_PROXY`)로만 나간다. 허용 호스트는 `api.openai.com`뿐이다(API 키 경로에서 실측). 런타임마다 프록시를 따로 두므로 Claude CLI는 OpenAI에, Codex는 Anthropic에 닿지 못한다.
  - TLS 루트는 `CODEX_CA_CERTIFICATE`로 준다. 샌드박스 안에서는 플랫폼 검증기가 trustd에 닿지 못하기 때문이다.
  - ChatGPT 로그인(#18)은 `chatgpt.com` 등이 더 필요하다. #18에서 실측한 뒤 추가한다.
- **자격 증명:**
  - API 키는 환경 변수·인자·디스크 어디에도 두지 않는다. app-server 시작 뒤 stdin의 `account/login/start {type:"apiKey"}`로만 넘긴다.
  - `cli_auth_credentials_store = "ephemeral"`이라 메모리에만 있다(`auth.json` 없음, 시험으로 확인).
  - run의 MCP 토큰은 `bearer_token_env_var`가 가리키는 환경 변수로만 넘긴다. 실행 뒤 연결 폴더에 둘 다 원문이 없음을 시험한다.
  - `shell_snapshot`은 끈다. 사용자 셸을 띄워 환경 변수를 파일로 남기기 때문이다.
- **설정(`codexConfigToml`)**: `--strict-config`로 읽는다(모르는 키·기능 이름이면 시작 실패, 업그레이드 때 바로 드러남).
  - **끄는 기능:** 셸·exec·플러그인·앱·브라우저·컴퓨터 사용·메모리·웹 검색·하위 에이전트·sleep·goals·이미지 보기·이미지 생성·도구 제안·hooks·스킬 검색·멘션·code-mode host 등(`CODEX_DISABLED_FEATURES`).
  - **지시문:** `AGENTS.md`(`project_doc_max_bytes = 0`)·스킬 지시·환경 정보·권한 지시·협업 모드 지시를 넣지 않는다. 기본 지시문은 우리 시스템 프롬프트로 대신한다(`baseInstructions`).
  - `config.toml`은 연결의 모든 세션에 같다. 한 사용자의 세션이 동시에 돌 수 있어서, 파일은 한 번에 바꿔 쓴다(rename).
  - run마다 다른 것(모델, 우리 MCP 서버)은 그 프로세스의 `-c` 인자로 준다(`codexRunConfig`).
  - 같은 폴더의 app-server 두 개가 새 CODEX_HOME을 동시에 초기화하면 하나가 실패한다(`failed to initialize sqlite state runtime`, 0.165.0에서 관측). 그래서 한 폴더의 세션은 하나씩 연다. 열린 뒤에는 함께 돈다.
  - **MCP:** 우리 서버만 `url` + `bearer_token_env_var`로 연결한다. `enabled_tools`는 run의 도구, `default_tools_approval_mode = "approve"`, `required = true`. 토큰은 인자에 넣지 않는다.
  - 실험한 결과, 모델에게 가는 도구는 MCP 리소스 도우미 셋과 run의 우리 도구뿐이다(macOS 시험이 요청 본문으로 확인).
- **들어오는 것도 검사한다(fail closed):** 다음이 오면 `turn/interrupt` 후 `runtime_policy`로 끝낸다.
  - 그 run의 우리 도구(`server = agentlee`, 허용된 이름)가 아닌 도구 호출. 다른 MCP 서버, 같은 이름을 쓴 다른 서버, `codex` 내장 리소스 도구, 명령·파일 변경·하위 에이전트·웹 검색 항목이 모두 해당한다.
  - 다른 thread의 알림
  - app-server가 우리에게 보내는 요청(승인·사용자 입력·elicitation 등). 요청은 즉시 거절한다.
  - 우리 것이 아닌 MCP 서버의 알림(`mcpServer/startupStatus/updated`·`oauthLogin/completed`). 계정 커넥터처럼 늦게 붙는 경우까지 막는다(리뷰 #80·#82).
  - 고정 프로토콜에 없는 알림, 그 형태가 틀린 알림, 프로세스·명령 출력 알림
- **검사 시점:** 모든 메시지를 언제 오든 같은 규칙으로 검사한다. 항목(item)의 종류·서버·도구 검사도 턴 안에서만이 아니라 여는 중과 턴 사이에도 한다(리뷰 #82 2차).
  - 세션을 여는 중에 걸리면 세션을 열지 않는다.
  - 턴 중이면 그 턴을 즉시 중단한다.
  - 턴 사이면 프로세스를 닫는다. 다음 턴은 `runtime_policy`로 실패한다.
- **thread 판정:** 알림마다 thread id가 있는 자리가 다르다. 그래서 고정 바이너리의 `generate-ts` 바인딩에서 뽑은 표(`runtime/codex-protocol.ts`)로 읽는다.
  - `params.threadId`에 있는 알림, `null`이면 프로세스 전체에 대한 것인 알림, `params.thread.id`에 있는 알림(`thread/started`), thread가 없는 알림으로 나눈다.
  - `null`(전역)은 허용한다. 우리 것이 아닌 thread id는 거부한다. 재개는 첫 메시지부터 재개할 thread id로 검사한다. 새 thread는 thread/start 응답 전에 본 id도 응답의 우리 id와 같아야 한다(두 경로 모두 마지막에 같은 검사).
  - macOS 시험이 바인딩을 다시 만들어 표와 비교한다(업그레이드 때 표 갱신).
- **스킬 파일:** 0.165.0은 프롬프트의 `$이름`을 보고 SKILL.md를 읽어 붙인다. 스킬을 꺼도 그렇다. 찾는 곳은 `CODEX_HOME/skills`, `HOME/.agents/skills`, cwd의 `.agents/skills`·`.codex/skills`이다. `CODEX_HOME/AGENTS.md`도 읽힌다.
  - 그래서 세션을 열 때마다 이 파일·폴더를 지운다. 그 밖의 파일은 같은 사용자의 다른 세션이 쓰고 있을 수 있어 건드리지 않는다.
  - 프로세스는 `work`·`home`에 쓸 수 없다. `codex-home`에는 쓸 수 있지만 파일을 쓰는 도구가 없다. 서버도 거기에 파일을 쓰지 않는다.
  - 남는 경로는 세션이 열려 있는 동안 서버 밖의 누군가(이 Mac의 사용자)가 그 폴더에 SKILL.md를 넣는 경우뿐이다. 이는 하드링크 판단과 같은 이유로 격리 대상 밖으로 본다.
  - `@파일`·`/명령`·`!명령`은 글자 그대로 간다(실바이너리 시험으로 확인).
