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
- **스킬:** 허용 목록에 있는 것만 `skill_<이름>` 도구로 보인다. 실행은 `runIsolated`로 한다. #43에는 검증용 `selftest` 하나였다. 허용 목록·사용자별 스킬은 아래 "공통 MCP 스킬 실행기 (#21)"를 본다.
  - 읽기: 스킬 폴더와 node 실행 파일만(설치 폴더는 읽지 못함 — 시스템 라이브러리만 쓰는 공식 빌드 node 필요, 아니면 `skill_failed`로 막힘)
  - 쓰기·네트워크·자식 프로세스·환경 변수: 없음
  - 입력은 실행 전에 검증한다.
  - macOS가 아니면 `skill_unavailable`로 거부한다.
- 샌드박스 프로파일은 허용 경로 **상위 폴더들의 메타데이터(stat)** 를 읽게 한다. 내용과 목록은 읽지 못한다. node가 스크립트 경로를 `realpath`로 풀 때 상위 폴더를 하나씩 stat하기 때문이다.

## Claude Code CLI를 샌드박스에서 실행 (#15)
- SDK의 `spawnClaudeCodeProcess`로 CLI를 `spawnIsolated`(`runIsolated`의 장기 실행판)로 띄운다. 같은 프로파일을 쓰고, 하드링크 검사와 메모리 감시도 같다.
- **읽기·쓰기:** 연결 폴더만 쓴다. 폴더는 **연결과 사용자마다** 따로 있다(`data/runtimes/<연결 id>/<사용자 id>`). 그래서 가족이 같은 API 키를 써도 세션·캐시·대화 기록이 다른 사람의 샌드박스 안에 놓이지 않는다(리뷰 #80).
  - 연결 id는 앱이 관리하는 연결(#17)의 UUID다. 런타임 세션은 그 연결 폴더에 있으므로 **같은 연결의 run만** 세션을 이어 쓴다. 연결을 해제하면 세션을 무효화하고 폴더를 지운다.
  - 어댑터는 run마다 연결을 다시 확인한다(해제·만료·정책 변경·주인 확인). Claude 구독은 그 순간에도 주인이 관리자일 때만 넘긴다.
  - **Claude 구독(#18):** 관리자의 `claude setup-token` 장기 토큰은 `CLAUDE_CODE_OAUTH_TOKEN` 환경 변수로만 넘긴다(API 키와 같은 자리, 인자·파일 없음). 호스트는 API 키와 같은 `api.anthropic.com`이라 송신 허용은 그대로다. 실제 토큰으로의 확인은 `docs/evidence/subscription/checklist.md`.
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
  - **ChatGPT 로그인(#18)**: 세션은 별도 프록시로 `chatgpt.com`만 허용한다(가짜 토큰으로 실측: 모델 목록·작업 공간 확인·응답이 모두 `chatgpt.com`). 디바이스 코드 로그인 과정은 또 다른 프록시로 `auth.openai.com`·`chatgpt.com`만(실측: 코드 발급은 `auth.openai.com`뿐). 근거는 `runtime-capabilities.md` 2.5절.
- **자격 증명:**
  - API 키는 환경 변수·인자·디스크 어디에도 두지 않는다. app-server 시작 뒤 stdin의 `account/login/start {type:"apiKey"}`로만 넘긴다.
  - `cli_auth_credentials_store = "ephemeral"`이라 메모리에만 있다(`auth.json` 없음, 시험으로 확인).
  - ChatGPT 로그인(#18)도 같다: 액세스 토큰만 stdin의 `account/login/start {type:"chatgptAuthTokens"}`로 넘기고 메모리에만 둔다(이 요청 때문에 ChatGPT 세션만 `experimentalApi: true`). 리프레시 토큰은 프로세스에 들어가지 않는다. 프로세스가 새 토큰을 달라고 하면(`account/chatgptAuthTokens/refresh`) 서버가 갱신해 액세스 토큰만 돌려준다. 이 서버 요청 하나만 받고, 다른 요청은 전처럼 거절·차단한다.
  - **로그인 과정**(`runtime/codex-login.ts`): 로그인마다 app-server를 하나, 같은 샌드박스(그 로그인 폴더만 읽기, `codex-home`·`tmp`만 쓰기, 자식 프로세스 없음, 루프백 프록시만)로 띄운다. app-server에는 토큰을 꺼내는 요청이 없어 이 과정만 `cli_auth_credentials_store = "file"`이다. 로그인이 끝나면 서버가 `auth.json`을 바로 읽고 0으로 덮어쓴 뒤 지우고, 프로세스를 끝낸 다음 로그인 폴더를 통째로 지운다(성공·실패·취소·시간 초과 모두). 토큰이 디스크에 있는 시간은 완료 알림부터 읽기까지 몇 ms다. 그동안 그 폴더를 읽을 수 있는 것은 서버와 그 로그인 프로세스뿐이다(폴더 `0700`). 그 사이 서버가 죽으면 다음 시작 때 남은 로그인 폴더를 지우고, 서버가 폴더에 적어 둔 신원(`login.pid`: 폴더 이름·pid·프로세스 그룹·시작 시각·명령줄)이 모두 맞는 프로세스만 끝낸다(`cleanupLeftoverLogins`). 프로세스가 쓸 수 있는 폴더라, 서버는 거기서 **어떤 링크도 따라가지 않는다**(`runtime/login-files.ts`): 모든 경로 단계 `lstat`, `O_NOFOLLOW`로 열고 descriptor의 `fstat`(일반 파일·링크 1개·크기·같은 inode)과 상위 폴더가 그대로인지 확인한 뒤에만 읽거나 덮어쓴다. 링크·하드 링크는 그 이름만 지운다. 파일은 `O_NONBLOCK`도 함께 열어, 확인 뒤 FIFO로 바뀐 이름이 열기에서 이벤트 루프를 막지 못한다(타입은 descriptor로 바로 확인).
  - **격리 후 삭제(리뷰 #91 3차):** Node에는 openat·fdopendir가 없어 경로로 하는 트리 삭제는 확인과 사용 사이에 하위 폴더가 링크로 바뀌는 경합을 막을 수 없다. 그래서 로그인 폴더는 먼저 통째로 `DATA_DIR/runtimes/.quarantine/`(서버 전용 `0700`, 같은 파일 시스템)으로 `rename`한 뒤에만 그 안에서 지운다. 근거: sandbox-exec 프로필의 쓰기 규칙은 경로 규칙(`(allow file-write* (subpath "<로그인 폴더>/codex-home"))`, `tmp`)이고, 로그인 폴더 자체와 그 상위·격리 폴더는 어떤 프로필에도 쓰기로 들어가지 않는다(`buildProfile`로 만든 프로필을 시험이 확인). 폴더가 옮겨지면 살아 있는 작성자도 그 안에 파일·링크·폴더를 더 만들 수 없다 — macOS 실 샌드박스 시험: 작업 폴더를 `codex-home`에 둔 프로세스가 옮기기 전에는 쓰고, 옮긴 뒤에는 파일·심볼릭 링크·폴더 생성이 모두 거부된다. 옮기기 전에 심어 둔 링크는 걷기에서 링크만 지운다. 시작할 때의 잔존 정리와 로그인 종료 정리 둘 다 이 경로를 쓰고, 시작할 때는 격리 폴더에 남은 것도 지운다. 로그인 중(프로세스가 살아 있는 동안) 토큰 파일은 descriptor로 0을 덮어쓰기만 하고 이름은 지우지 않는다 — 이름은 폴더와 함께 격리 뒤에 지운다. 남는 위험은 `docs/ops.md` 11절.
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
  - app-server가 우리에게 보내는 요청(승인·사용자 입력·elicitation 등). 요청은 즉시 거절한다. 예외는 ChatGPT 세션의 `account/chatgptAuthTokens/refresh` 하나(위 "자격 증명").
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

## 공통 MCP 스킬 실행기 (#21)
목록과 스킬별 사실은 `docs/skills.md`에 있다. 여기서는 실행 방식만 적는다.

- **허용 목록 = 코드의 정의:** `packages/mcp-tools/src/skills.ts`의 `SKILL_SPECS`(지금 `google-news-search-skill`·`kr-stock-skill`)와 내장 `selftest`만 도구가 된다.
  - 정의에는 복사할 파일, 입력 스키마, 인자 빌더, 접속 호스트, 비밀이 들어 있다.
  - 정의가 없는 스킬(PRD 제외 스킬 포함)은 설치도, 사용자별 허용도 할 수 없다.
- **서버 전용 스킬 폴더 `<DATA_DIR>/skills/<이름>/`:** `pnpm skills:install`이 관리자 스킬 폴더(`SKILL_SOURCES`, 기본 `~/.agents/skills:~/.claude/skills`)에서 정의에 적힌 파일만 **복사**한다.
  - **링크하지 않는다.** 링크하면 샌드박스가 관리자의 실제 폴더를 읽어야 한다. 그 폴더에는 `config.json`(API 키)·`.env`·venv·백업이 같이 있다.
  - 원본 파일은 이런 경우 거부한다: 스킬 폴더 아래 경로에 심볼릭 링크가 있음(`realpath` 비교), 하드링크(링크 수 > 1), 일반 파일이 아님, 4MB 초과.
  - 경로 검사 뒤 여는 것도 링크를 따라가지 않는다: macOS `O_NOFOLLOW_ANY`(경로의 **어느** 구성요소든 심볼릭 링크면 실패, `openInside`와 같은 방식). 검사와 열기 사이에 상위 폴더를 링크로 바꿔도 거부된다(리뷰 #85, 시험). macOS가 아닌 CI에서는 `O_NOFOLLOW` 뒤 `/proc/self/fd`의 실제 경로가 검사한 경로와 같아야 한다.
  - 연 디스크립터를 다시 확인한다: 일반 파일, 링크 1개, 크기, 그리고 지금 그 경로의 inode와 같음.
  - 복사본은 읽기 전용이다. 해시를 적은 `.agentlee-skill.json`과 함께 임시 폴더에 쓴 뒤 rename 한 번으로 바꾼다.
  - 정의의 파일 이름은 `..`·절대 경로·역슬래시를 거부한다(`checkSpec`).
- **서버 시작 때 검사(`loadInstalledSkills`):** 다음을 모두 만족하는 스킬만 제공한다. 하나라도 어긋나면 `broken`이고 도구로 보이지 않는다.
  - 폴더가 심볼릭 링크가 아님
  - 목록에 없는 파일이 없음(누가 넣은 키 파일도 스킬이 읽을 수 있기 때문)
  - 파일마다 심볼릭 링크·하드링크가 아니고 해시가 같음

  실행할 때는 `runIsolated`가 하드링크를 다시 검사한다.
- **고정 사본(리뷰 #85):** 시작할 때 검사를 통과한 내용(검사하며 읽은 바이트 그대로)을 `<DATA_DIR>/skills/.pinned/<매니페스트 해시>/`에 쓴다. 파일과 폴더는 읽기 전용이다. 스킬은 **이 고정 사본에서만** 실행한다.
  - 설치 폴더를 나중에 바꿔도 실행되는 것은 바뀌지 않는다. 다시 설치하면 재시작 때 새 해시의 사본이 생기고, 쓰지 않는 사본은 지운다.
  - 실행 직전마다 고정 사본을 다시 확인한다(`verifyPinned`): 폴더 inode, 정확한 항목 목록, 파일마다 일반 파일·링크 1개, inode·크기·mtime. 하나라도 다르면 전체 해시로 비교하고, 내용이 다르면 `skill_changed`로 실행하지 않는다.
  - **남는 것:** 확인과 실행 사이의 짧은 틈에 고정 사본을 바꾸는 경우는 막지 못한다. `sandbox-exec`가 경로로 판정하기 때문이다. 이렇게 할 수 있는 것은 서버 계정으로 `DATA_DIR`에 쓸 수 있는 주체뿐이다. 즉 Mac의 사용자·관리자이고, 위 하드링크 판단과 같이 격리 대상 밖이다. 샌드박스 프로세스는 이 폴더에 쓸 수 없고(쓰기 허용 없음), 서버는 시작할 때만 쓴다.
- **인자:** 모델이 준 글자는 인자가 되지 않는다.
  - 입력은 엄격한 스키마로 검사한다. 정의에 없는 키는 거부한다(`z.strictObject`, MCP 서버와 서비스 두 곳).
  - 인자는 정의의 `args()`가 고정된 모양으로 만든다. 값마다 `--flag=값` 한 요소다. 그래서 `--query=--format=markdown`도 값일 뿐 플래그가 되지 않는다.
  - 자유 글은 `SAFE_TEXT`로 검사한다: 제어 문자, 셸 메타문자(세미콜론·파이프·앰퍼샌드·달러·백틱·꺾쇠·역슬래시), `-`로 시작하는 값을 거부한다.
  - 명령과 맞지 않는 값(예: `stock`에 `KOSPI`)은 `skill_bad_input`이다. 셸은 어디에도 없다(`spawn` 인자 배열).
- **python 스킬:**
  - 샌드박스는 fork를 막는다. Homebrew·python.org 같은 **framework 빌드는 못 쓴다.** `bin/python3.x`가 `Python.app`을 posix_spawn으로 다시 띄우기 때문이다(실측 거부). 확장 모듈도 다른 Homebrew 폴더의 libssl 등을 읽는다.
  - 그래서 **독립 실행형 빌드**(python-build-standalone, `uv python install 3.12`)를 `SKILL_PYTHON`으로 지정한다.
    - 그 설치 폴더 하나만 `trusted` 읽기로 연다.
    - 실행은 `python -I -S -B <entry> <인자>`다. 환경 변수·사용자 site·스크립트 폴더·site-packages를 쓰지 않는다. 표준 라이브러리만 쓴다.
  - 실측(macOS 27, cpython 3.11.14 standalone)했다:
    - fork `PermissionError`
    - 폴더 밖 읽기·홈 목록·쓰기·직접 접속 거부
    - 프록시 CONNECT는 허용 호스트만 200, 나머지 403
    - 실제 두 스킬 HTTPS 성공
  - framework 빌드, 홈 폴더 전체를 포함하는 설치 폴더, `bin/python3…`가 아닌 경로는 `pythonRuntime`이 거부한다. 그러면 python 스킬은 제공하지 않는다(`needs_python`).
  - venv(pip 패키지)가 필요한 스킬은 아직 돌리지 않는다(#30·#50). **자식 프로세스가 꼭 필요한 스킬**(`summarize` 등)은 샌드박스를 풀지 않고 서버 함수로 대체한다.
- **네트워크:** 호스트가 있는 스킬은 **스킬마다 따로** 송신 프록시(`EgressService`)를 쓴다. 각 프록시는 그 스킬의 호스트만 허용한다.
  - 샌드박스는 그 프록시의 루프백 포트 하나만 연다. 호스트가 없으면 네트워크가 없다.
  - TLS 루트는 `SSL_CERT_FILE=/private/etc/ssl/cert.pem`(trusted 읽기)으로 준다.
  - 그래서 뉴스 스킬은 증권 사이트에, 증권 스킬은 뉴스 사이트에 닿지 못한다(시험).
- **비밀:**
  - `.env`의 `SKILL_SECRET_NAMES`(지금 `ALPHAVANTAGE_API_KEY`·`OPENDART_API_KEY`·`GEMINI_API_KEY`)만 읽는다.
  - 그 비밀을 선언한 스킬의 프로세스 환경에만, 그 호출에 필요할 때만(`when`) 넣는다. 예: `kr-stock-skill`의 `alpha-quote` 호출에만 Alpha Vantage 키가 들어간다.
  - 인자에는 절대 넣지 않는다(`ps`에 보이기 때문). 없으면 `skill_unconfigured`다.
  - 결과에서 비밀을 가린다. stderr는 버리고, 로그에는 남지 않는다.
    - 먼저 stdout 원문에서 비밀 값을 `[redacted]`로 바꾼다.
    - JSON으로 읽은 뒤 **모든 문자열 값과 객체 키**를 재귀적으로 다시 가린다. `\u0041…`나 `\"` 같은 JSON 이스케이프는 원문에 없던 비밀을 만들 수 있다(리뷰 #85).
    - 그래도 결과에 비밀이 남아 있으면 결과를 버린다(`skill_bad_output`). JSON이 아닌 출력은 처음부터 내용 없이 거부한다.
  - 관리자 화면에서 암호화 저장하는 것은 #35에서 한다.
- **사용자별 스킬(FR-1.6):** `users.permissions.skills`(`"all"` 또는 §7 이름 목록, 0001 마이그레이션의 열)로 정한다. API는 `PUT /api/admin/users/:id/skills`다. `selftest`는 연결 테스트용이라 항상 켜져 있다.
  - run의 도구 목록은 사용자마다 계산한다(`McpService.toolNamesFor`). 런타임은 그 목록만 허용한다: Claude는 PreToolUse 훅, Codex는 `enabled_tools`와 들어오는 항목 검사.
  - MCP 서버는 요청마다 토큰 사용자의 허용 스킬만 등록한다. 목록에 없는 도구 호출은 "not found"다.
  - 서비스가 호출마다 허용을 다시 확인한다(`skill_not_allowed`). 그래서 실행 중에 관리자가 권한을 바꾸면 바로 반영된다.
- **동시 실행:** 전체 4개, run당 2개(#43 그대로)다. 스킬별 시간 한도는 정의의 `timeoutMs`(네트워크 스킬 40초)다. 출력 256KB, 메모리 256MB다.
- **로그(#46):** 호출마다 `skill.finished`를 남긴다. 필드는 도구 이름(서버가 등록한 이름), `ok`/`error`, `skillCode`(정해진 `skill_*` 코드), 소요 시간, ID뿐이다. 입력·출력·stderr는 남기지 않는다.
- **두 런타임에서 같은 결과(D7):** `apps/server/test/skills-contract.test.ts`가 확인한다.
  - 대본 런타임이 어댑터가 만든 설정(Claude `mcpServers`+훅, Codex `-c mcp_servers.agentlee` + 환경 변수 토큰)으로 우리 MCP 서버를 실제로 호출한다.
  - Claude Code와 Codex의 도구 결과가 같은지 비교한다.
  - 실제 런타임 녹화는 자격 증명이 필요해 미뤘다(`test/record-*.ts`).

## 웹 검색·가져오기 (#50)
MCP 도구 `web_search(query)`·`web_fetch(url)`이다(`packages/mcp-tools/src/web.ts`, 서버 쪽 `apps/server/src/web/`). 모든 활성 사용자가 쓴다(스킬별 허용 대상이 아니다).

- **실행 위치:** 페이지 가져오기·HTML 해석·검색 결과 해석은 **샌드박스 node 작업자**(`packages/mcp-tools/web/worker.mjs`)가 한다. 서버 프로세스 안에서 `safeFetch`로 하지 않은 이유: 남의 HTML을 해석하는 코드(정규식, 압축 해제, 문자셋)가 서버 메모리·비밀과 같은 곳에서 돌지 않게 하려는 것이다. 작업자가 터지거나 멈춰도 시간·출력·메모리 한도로 끝난다.
  - 읽기: 작업자 폴더와 node 실행 파일만. 쓰기·자식 프로세스: 없음.
  - 환경 변수: `AGENTLEE_WEB_WORKER=1`, `AGENTLEE_PROXY=<프록시 주소>` 둘뿐이다. 앱의 쿠키·세션·API 키는 작업자에 존재하지 않으므로 보낼 수도 없다. 요청 헤더는 고정값(user-agent·accept·accept-language·accept-encoding)뿐이다(시험이 받은 헤더 목록을 확인).
  - 네트워크: 루프백 포트 하나(웹 송신 프록시)만. 프록시를 거치지 않는 접속은 커널이 막는다(macOS 시험).
  - 한도를 넘으면 그 사유(`web_too_large`)를 먼저 정해 두고 소켓·스트림을 닫는다. 닫으면서 생기는 오류가 사유를 `web_unreachable`로 바꾸지 못한다.
  - 한도: 본문 3MB — **받은 바이트와 압축 해제 뒤 바이트를 따로 센다**(리뷰 #88 1차: gzip 헤더에 3MB를 넣은 청크 응답 시험, gzip 폭탄 시험). 어느 쪽이든 넘으면 응답·해제 스트림을 모두 닫는다. 저장 글자 40만 자, 리다이렉트 5번, 작업 전체 20초, 프로세스 30초·출력 4MB·메모리 256MB. 동시 실행은 스킬과 같은 자리(전체 4, run당 2)를 쓴다.
- **웹 송신 프록시(`EgressService({ allow: "public", ports: [80, 443] })`):** #15의 프록시와 같은 코드에 "공개 주소 모드"를 더했다.
  - 허용 목록 대신 **주소로** 판정한다. 이름은 프록시가 직접 해석하고, 답에 루프백·사설·링크 로컬·CGNAT·메타데이터·예약 주소가 **하나라도** 있으면 거부한다. 연결은 검사한 그 주소로 한다(이름을 다시 해석하지 않음 — DNS rebinding이 끼어들 틈이 없다).
  - 업스트림이 정상으로 닫혀도 클라이언트 쪽에 아직 보내지 못한 바이트가 있으면 다 보낸 뒤(최대 30초) 닫는다. 예전에는 바로 끊어서 느린 클라이언트가 응답 끝부분을 잃었다(Linux CI에서 `web_unreachable`로 드러남, 결정적 시험: 가짜 업스트림이 16MB·끝·닫힘을 연달아 보냄). 런타임용 프록시(#15)도 같은 코드라 함께 고쳐졌다. 업스트림 오류는 그대로 바로 끊는다.
  - 포트는 80·443만. 평문 http도 `CONNECT host:80` 터널 안에서 작업자가 직접 말한다. 그래서 프록시는 절대 URI 요청(평문 HTTP 프록시)을 받지 않는다(지금도 405).
  - CONNECT 대상은 LDH 이름, 정규 점 표기 IPv4, 꺾쇠 IPv6만 받는다. 마지막 라벨이 숫자·16진수인 이름(`2130706433`, `0x7f.1`, `0177.0.0.1`)은 다른 표기의 주소라 거부한다.
  - `localhost`(하위 이름 포함)·`.local`·`.internal`·`.home.arpa`·`.lan` 등과 점 없는 이름은 해석하기 전에 거부한다(추가 방어).
  - **IPv6 판정(리뷰 #88 1차, `isBlockedAddress` — 서버 사전 검사·송신 프록시·`safeFetch` 공통):** 허용 목록 방식이다. 전역 유니캐스트 `2000::/3`만 허용하고, 그 안의 특수 대역(IANA 특수 목적 주소 등록부)을 뺀다: `2001::/23`(Teredo `2001::/32` 등 IETF 프로토콜 할당 전체), `2001:db8::/32`, `2002::/16`(6to4 — 내장 IPv4를 보지 않고 거부), `3fff::/20`, `5f00::/16`. 그래서 `::`, `::1`, IPv4 호환 `::a.b.c.d`, `100::/64`, 로컬 NAT64 `64:ff9b:1::/48`(RFC 8215 — 무엇으로 변환되든 거부), `fc00::/7`, `fec0::/10`, `fe80::/10`, `ff00::/8`은 모두 거부된다. 내장 IPv4로 판정하는 것은 IPv4 대응 `::ffff:0:0/96`과 NAT64 표준 접두사 `64:ff9b::/96`(정확히 /96, RFC 6052) 둘뿐이다. 경계값 시험이 `isolation.test.ts`에 있다.
- **TLS:** 인증서는 **대상**(이름 또는 IP)으로 검증한다. 터널 소켓의 상대는 프록시(127.0.0.1)라서 `host`를 주지 않으면 그 주소로 검증된다(리뷰 #88 1차, IP SAN 인증서 시험). SNI는 이름일 때만 보낸다. 핸드셰이크도 작업의 남은 시간 안에서 끝나야 하고, 멈추면 소켓을 닫고 `web_timeout`이다(멈춘 핸드셰이크 시험).
- **리다이렉트:** 작업자가 직접 따라간다. 매번 URL을 다시 검사(http/https, 인증 정보 없음, 포트 80/443)하고 **새 CONNECT**를 연다. 그래서 프록시가 매 홉의 이름을 다시 해석하고 다시 검사한다.
- **서버 사전 검사(`checkUrl`):** 프로세스를 띄우기 전에 거부한다. 스킴, 인증 정보, 포트, 주소 리터럴(WHATWG 파서가 10진·8진·16진·축약 IPv4와 IPv4 대응 IPv6를 정규형으로 바꾼 뒤 `isBlockedAddress`), 위의 사설 이름, URL 2048자.
- **시험(SSRF fixture, `apps/server/test/web.test.ts`):** 다음이 모두 거부된다. 서버 검사만, 프록시만(서버 검사 없이 작업자 직접), 도구 호출 세 층에서 각각 확인한다.
  - `http://127.0.0.1:3000`, `http://169.254.169.254`, 사설 IP·사설 이름으로 리다이렉트, DNS rebinding 흉내(첫 해석은 공개, 다음은 127.0.0.1), 공개+사설이 섞인 답
  - IPv6 루프백 `[::1]`, IPv4 대응 `[::ffff:127.0.0.1]`·`[::ffff:7f00:1]`, 링크 로컬·ULA·`[::]`
  - 10진 `2130706433`, 8진 `017700000001`·`0177.0.0.1`, 16진 `0x7f000001`·`0x7f.0.0.1`, `127.1`, `0`
  - `localhost`·`LOCALHOST.`·`api.localhost`·`.local`·`.internal`, 점 없는 이름
  - `file:`·`ftp:`·`gopher:`·`data:`·`javascript:`, 인증 정보가 든 URL, 80/443 밖의 포트
  - 시험의 이름 해석·업스트림 연결은 가짜다. 공개 주소(93.184.216.34)만 시험 서버로 잇고, 다른 주소로 연결을 시도하면 `leaks`에 남아 시험이 실패한다.
- **변이 시험(2026-11-11):** 다음을 하나씩 망가뜨리면 시험이 실패함을 확인했다. 프록시 주소 검사 제거·첫 답만 검사·이름으로 다시 연결·다른 IPv4 표기 허용·사설 이름 검사 제거·포트 제한 제거, 서버 주소 리터럴 검사 제거·스킴 검사 제거, 작업자 리다이렉트가 프록시 우회·본문 크기 세기 제거·쿠키 헤더 추가·홉 스킴 검사 제거, 발췌를 `<external_content>`로 감싸지 않음·본문 전체를 모델에 줌, 출처 저장의 소유자 검사 제거.
  - 리뷰 #88 2차 뒤 추가(마지막 재측정을 끈 채): 원문 길이로 계산, JSON 이스케이프 미반영, 태그 무력화 미반영, 쉼표 미반영, 상한 제거, 채택하지 않은 결과도 저장. 모두 시험이 잡았다. 마지막 재측정만 끄면 통과한다(결과별 계산이 정확하므로 — 재측정은 안전장치).
  - 리뷰 #88 1차 뒤 추가: `2000::/3` 허용 목록 제거, NAT64를 /32로 판정(이전 방식), 특수 대역 제거, IPv4 대응 판정 제거, 받은 바이트 세기 제거, TLS 대상 `host` 제거, 핸드셰이크 시간 제한 제거, 검색 출력 제목 제한 제거, 검색 전체 한도 제거, 발췌 대신 본문 전체를 `content`에. 모두 시험이 잡았다.
- **결과:** 가져온 페이지는 `sources`(0010 마이그레이션)에 대화·사용자·run과 함께 저장한다: URL, 최종 URL, 제목, 사이트, 게시일(페이지 메타·JSON-LD·`<time>`에서, 있을 때), 가져온 시각, 본문 해시(SHA-256), 본문(읽을 수 있는 글자). 모델에게는 출처 id·제목·사이트·URL·게시일과 **처음 1만 자 발췌**를 `<external_content>` 블록으로 준다. 본문 전체는 주지 않는다. #25의 `cite`는 출처 id로 인용하고 저장된 본문에서 구절을 확인한다(`SourceStore.get(대화, id)` — 다른 대화의 id는 없음).
  - 검색 결과는 한 번 정규화·제한한 값(제목 300자, 사이트 120자, 스니펫 600자, ISO 날짜)을 **저장과 출력에 함께** 쓴다. 한 번의 `web_search` 답은 **모델이 받는 MCP 글자 그대로**(답 전체의 `JSON.stringify`) 1만 2천 자(`SEARCH_OUTPUT_CHARS`)를 넘지 않는다. 길이는 원문이 아니라 직렬화 기준으로 잰다: 결과마다 무력화(`defuseExternal`)한 줄과 `results` 항목의 JSON 이스케이프 뒤 길이를 정확히 더하고(따옴표·역슬래시 2배, 제어 문자 6배, 태그 무력화 +3), 다음 결과가 넘게 되면 거기서 멈춘다. 다 만든 답을 한 번 더 재서 넘으면 끝에서부터 뺀다(안전장치). 넘게 되는 결과는 빼고 저장하지도 않는다(리뷰 #88 1·2차, 따옴표·제어 문자·태그 흉내 결과의 경계값 시험).
  - 같은 대화에서 같은 URL·같은 본문을 다시 가져오면 처음 id를 쓴다. 검색 결과도 같은 링크면 같은 id다.
  - 출처를 쓰기 전에 그 대화의 주인이 토큰의 사용자인지 다시 확인한다.
- **본문 추출:** 의존성 없이 작업자 안에서 한다. `script`·`style`·`noscript`·`svg`·`iframe` 등과 주석을 버리고, `<article>`(없으면 `<main>`)의 가장 긴 것을 고른 뒤 `nav`·`footer`·`aside`·`form`·`header`를 뺀다. 블록 태그는 줄바꿈, 나머지 태그는 지우고 엔티티를 푼다. 문자셋은 헤더 → `<meta charset>` → UTF-8 순서(EUC-KR 시험).
  - 받는 형식: `text/html`, `application/xhtml+xml`, `text/plain`, `text/markdown`, `application/json`(`+json` 포함). **PDF는 거부한다**(`web_unsupported_type`). 의존성 없이 PDF 글자를 뽑는 방법은 싸지 않다. 파일 도구(#48)의 PDF 추출을 붙일 때 다시 본다.
  - 글자가 없는 페이지(스크립트로만 그리는 페이지)는 `web_no_text`이고 저장하지 않는다.
- **오류 코드(`WEB_CODES`):** `web_bad_url`, `web_blocked`, `web_unreachable`, `web_timeout`, `web_tls`, `web_too_large`, `web_too_many_redirects`, `web_unsupported_type`, `web_http_error`, `web_bad_content`, `web_no_text`, `web_search_blocked`, `web_search_unavailable`, `web_unavailable`(샌드박스 없음 — macOS가 아니면 이것으로 거부), `web_limit`, `web_failed`, `web_busy`, `web_not_allowed`, `web_bad_input`.
- **로그(#46):** 호출마다 `web.finished` 하나. 필드는 도구 이름, `ok`/`error`, `webCode`, 소요 시간, ID뿐이다. **URL·호스트·검색어·본문은 남기지 않는다.** 호스트도 뺀 이유: 이름은 모델(또는 모델이 읽은 페이지)이 고르므로 하위 도메인 라벨에 무엇이든(비밀 포함) 실을 수 있다. 정해진 코드만 남긴다.
- **검색 제공자(`WEB_SEARCH_PROVIDERS`, 순서대로 시도):**
  - `duckduckgo`(기본 1순위): `html.duckduckgo.com/html/` 결과 페이지를 작업자가 읽는다. 그 호스트만 허용하는 **별도** 송신 프록시를 쓴다(검색 작업자는 다른 사이트에 닿지 못한다). 키가 없고 기사 원문 링크를 준다.
    - **이용 약관 주의:** 공식 API가 아니다. 자동화된 사용은 DuckDuckGo가 허용하는 용도가 아닐 수 있다. 가족 몇 명의 적은 호출을 전제로 했다. 같은 Mac에서 연달아 부르면 봇 확인 페이지가 온다(2026-11-11 실측: 두 번째 질의에서 확인 페이지, 세 번째는 정상). 그 페이지는 `web_search_blocked`로 바꾸고 다음 제공자로 넘어간다. 약관이 걱정되면 `.env`에 `WEB_SEARCH_PROVIDERS=google-news`로 끈다.
  - `google-news`(2순위): 설치된 `google-news-search-skill`(RSS, 지난 30일, 관련도순)을 같은 샌드박스 경로로 부른다. RSS는 피드 리더용 공개 채널이다. **단점:** 뉴스만 나오고, 링크가 `news.google.com/rss/articles/…` 중계 주소라 `web_fetch`로 열면 원문이 아니라 빈 Google 페이지가 온다(실측: `web_no_text`). 그래서 1순위가 아니다. 스킬이 설치되지 않았거나 python이 없으면 이 제공자는 빠진다.
  - 키가 필요한 공식 API(Brave Search 등)는 넣지 않았다. 키로 실호출을 확인할 수 없었기 때문이다. `SearchProvider` 하나(검색어 → 결과 목록)를 더하면 된다: 호스트 전용 프록시 + 키는 그 작업자 환경 변수로만(스킬 비밀과 같은 방식).
  - 제공자가 하나도 없으면 `web_search`는 도구 목록에 없다. `web_fetch`는 항상 있다.
- **검색 결과도 출처다:** `web_search` 결과와 `google-news-search-skill` 결과(스킬로 직접 부른 것 포함)는 `kind = "search"` 출처로 저장하고 결과마다 `sourceId`를 붙인다. 본문이 없으므로 인용 검증의 근거가 아니다. 인용하려면 그 링크를 `web_fetch`해서 `page` 출처를 만든다.
- **API:** `GET /api/conversations/:id/sources` — 대화 주인만(공유와 상관없이: 자원 종류 `conversation-sources`의 공유 목록은 늘 비어 있다. 공유본의 출처는 #29의 고정 목록으로 따로 보인다). 본문은 주지 않는다(글자 수만).
- **남은 것:** 두 런타임의 실제 녹화(자격 증명 필요, #21과 같음), 실 런타임이 이 도구로 프롬프트 주입 평가(`docs/ops.md` §14.4)를 도는 것.

## 금융 도구 (#30)
MCP 도구 `kr_quote`·`kr_index`·`kr_history`·`kr_search`·`kr_etf`·`fx_usdkrw`·`us_*`(9개)·`dart_disclosures`·`sec_8k`·`sec_form4`·`sec_13f`이다(`packages/mcp-tools/src/finance.ts`, 서버 쪽 `apps/server/src/finance/`). 운영은 `docs/ops.md` §19.

- **스킬을 직접 돌리지 않는 이유:** `us-stock-skill`은 스킬 venv(yfinance·curl_cffi·pandas)가 있어야 하고, 두 공시 스킬은 로컬 SQLite에 쓰고 LLM 워커·Telegram을 부르는 상태 있는 모니터다. #21 실행기(독립 실행형 python `-I -S`, 표준 라이브러리, 고정 사본, fork 금지)로는 돌릴 수 없다. 그래서 스킬이 읽는 **같은 데이터 원천**(네이버 증권, Yahoo Finance, OpenDART, SEC EDGAR)을 서버 함수로 읽는다(`docs/skills.md`의 "자식 프로세스·venv가 필요하면 서버 함수로" 원칙). 사용자별 허용은 원래 스킬 이름으로 한다(도구마다 `skill`).
- **실행 위치:** 웹 도구의 **샌드박스 node 작업자**(`web/worker.mjs`)에 `raw` 작업을 더했다. 서버가 검증한 입력으로 **정확한 URL**을 만들고(`providers.ts`의 `plan`), 작업자는 GET만 하고 본문 글자를 돌려준다. 해석(JSON, 숫자, 시각)은 서버의 순수 함수(`parse`)가 한다 — 녹화·합성 응답으로 스냅샷 시험을 하기 위해서다. JSON 해석뿐이고 남의 HTML을 해석하지 않는다.
  - 한 작업은 최대 4단계, 단계마다 3MB, 리다이렉트 2번. 작업 안에서만 쿠키 상자를 쓰고(Yahoo 세션 쿠키), `capture` 단계(Yahoo crumb)는 뒤 URL의 `{crumb}`에만 들어간다. 쿠키·crumb는 작업자 밖으로 나오지 않는다(시험).
  - **반사된 세션 값(리뷰 #93 1·2차):** 작업 중 본 **모든** 세션 값 — 보낸 쿠키, 응답이 새로 설정해 바꾼 쿠키의 이전 값과 새 값, 캡처한 crumb — 을 기억해 두고(작업당 최대 200개), 데이터 본문을 돌려주기 전에 `[redacted]`로 바꾼다(`scrubBody`). 길이와 상관없이 지운다.
    - 철자: 그대로, JSON 이스케이프, `\uXXXX`(JSON은 먼저 정규형으로 다시 쓴다), URL 인코딩(`%2F`·`%2f` 대소문자 모두).
    - **통째 토큰만** 바꾼다: 앞뒤에 영문자·숫자가 없을 때. 그래서 `xyz` 같은 짧은 crumb가 `xyzzy`나 `abcxyz` 속을 자르지 않는다(양방향 시험).
    - **JSON은 문자열 값만** 바꾸고 키는 건드리지 않는다(리뷰 #93 3차: crumb `raw`가 Yahoo의 `{"raw": …}` 키를 바꿔 숫자가 조용히 `null`이 되던 문제). 숫자·리터럴이 세션 값과 통째로 같거나(쿠키 `1`과 가격 `1`), 키에 8자 이상 세션 값이 들어 있으면 응답을 거부한다(`web_bad_content` → `finance_bad_response`) — 데이터를 바꾸지도, 값을 흘리지도 않고 닫힌 쪽으로 실패한다. 서버는 해석이 안 되는 본문을 늘 `finance_bad_response`로 거부한다.
    - **판정 기준(다음 리뷰용):** 이 값들은 Yahoo가 익명 방문자에게 주는 세션 쿠키·crumb다. 사용자 자격 증명이 아니고 사용자가 넣는 값도 아니며, 계정이나 가족 데이터에 닿지 못한다. 그래서 막는 범위는 "작업자가 받은 값을 그대로(또는 위 표준 인코딩으로) 모델에게 되돌려 주는 것"까지다. **Base64·부분 문자열·그 밖의 변형 반사는 범위 밖**이다 — 그런 응답은 원천 서버가 일부러 만들어야 나오고, 새어도 익명 세션 하나다. 설정된 비밀(`OPENDART_API_KEY`·`SEC_USER_AGENT`)은 이와 별개로 서버가 결과 전체에서 길이와 상관없이 지운다(`redactValue`).
  - **매 홉 HTTPS(리뷰 #93 1차):** `raw` 작업은 첫 요청과 모든 리다이렉트가 `https:`여야 한다(`httpsOnly`). `http://허용호스트:443/`로의 리다이렉트는 프록시의 호스트·포트 검사를 통과하므로, 작업자가 보내기 전에 `web_blocked`로 거부한다(SEC 연락처 헤더·쿠키가 평문으로 나가지 않음). 일반 `web_fetch`는 그대로 http도 받는다.
  - 요청 헤더는 고정값 + 단계가 정한 `user-agent`·`accept`만(SEC는 `SEC_USER_AGENT`).
- **도구별 송신 프록시(정확한 호스트 허용 목록, 443만):** 도구마다 `EgressService({ allow: tool.hosts })`를 따로 연다(`finance:<도구>` 키). 다른 도구의 호스트에도 닿지 못한다.

  | 도구 | 호스트 |
  |---|---|
  | `kr_quote`·`kr_index`·`kr_history`·`kr_etf` | `m.stock.naver.com` |
  | `kr_search` | `ac.stock.naver.com` |
  | `fx_usdkrw`·`us_quote`·`us_index`·`us_history`·`us_technicals` | `query1.finance.yahoo.com` |
  | `us_company`·`us_financials`·`us_earnings`·`us_valuation`·`us_screener` | `fc.yahoo.com`(세션 쿠키), `query1.finance.yahoo.com` |
  | `dart_disclosures` | `opendart.fss.or.kr` |
  | `sec_8k`·`sec_form4`·`sec_13f` | `www.sec.gov`(티커 → CIK 목록), `data.sec.gov` |

  - 확인한 곳: 2026-11-11 이 Mac에서 각 엔드포인트를 한 번씩 호출해 응답 모양을 봤다(키가 필요한 OpenDART 제외). 기록은 저장소에 넣지 않았다. 합성 fixture는 그 모양을 따른다.
  - 서버도 실행 전에 계획의 모든 URL이 그 도구 호스트의 https 기본 포트인지 확인한다(`allowed`, 이중 방어 — 하위 도메인·접미 일치 거부).
  - 시험: 도구마다 프록시 허용 목록이 정확히 `tool.hosts`인지, 그 프록시가 `query2.finance.yahoo.com`·`finance.yahoo.com`·`…yahoo.com.evil.test`·다른 도구의 호스트·80 포트·IP 리터럴을 403으로 막는지(`finance.test.ts` "finance egress").
- **비밀:** `OPENDART_API_KEY`(DART URL의 `crtfc_key`), `SEC_USER_AGENT`(SEC 연락처 헤더). 작업 JSON(stdin)으로만 작업자에 간다. 작업자는 URL을 돌려주지 않고, 결과는 설정된 비밀 값으로 길이와 상관없이 한 번 더 지운다(`redactValue` — `SEC_USER_AGENT`는 5자도 된다). 없으면 그 도구만 `finance_unconfigured`.
- **남의 글:** 공시 제목·회사 이름·회사 소개는 `<external_content>` 블록에 넣는다(닫는 태그 흉내는 무력화 — 시험). 항목 목록에는 번호·코드·날짜·링크만 있다.
- **로그:** 호출마다 `finance.finished`(도구, `ok`/`error`, `financeCode`, 소요 시간, ID). 종목·URL·숫자는 남지 않는다.
- **리뷰 #93 1차 뒤 변이 시험(2026-11-11):** 20개를 하나씩 넣어 모두 시험이 잡았다 — 반사 값 지우기 제거·JSON 정규화 제거·crumb 빼고 지우기·짧은 비밀 건너뛰기(8자 이상만), raw 홉 https 강제 제거·첫 홉만 검사, 장이 닫히면 무조건 종가·장 밖 장중 값의 지연 표시 제거·원천 종가 표시 무시·네이버/Yahoo 종가 표시 전달 제거, 답변 전체를 한 맥락으로·값의 출처 대신 아무 출처·장중 시각 검사 제거·다른 문단 머리말 인정, 후속 맥락을 바로 앞 답변만·창 없이 전체 대화, 복구 경로 메모 제거, 식별자 제외 제거·결과의 코드·이름 제외 제거.
- **리뷰 #93 3차 뒤 변이 시험(2026-11-11):** 13개를 하나씩 넣어 모두 시험이 잡았다 — ETF 이름이 아무 글자나 먹기·ETF 숫자의 단위 검사 제거·ETF 접미어 제외, 복합 금액 합치기 제거·첫 부분의 정밀도·공백 아닌 틈 합치기·큰 단위 뒤 합치기·K/M/B/T와 합치기·천만 같은 묶음 단위 무시, JSON 키 다시 지우기·숫자/리터럴 충돌 통과·긴 토큰 키 통과·문자열 값 안 지우기.
- **리뷰 #93 2차 뒤 변이 시험(2026-11-11):** 16개를 하나씩 넣어 모두 시험이 잡았다 — 바뀐 쿠키 값 잊기·지금 쿠키 상자만 보기·짧은 값 건너뛰기·통째 토큰 경계 없애기·`%xx` 대소문자 구분, 시장 상태로 종가 확정, 식별자를 부분 문자열로 지우기·단위 뒤 무시·통화 기호 앞 무시·지수 이름 숫자 경계 없애기, 단위 배수 무시·정밀도 무시, 금융 결과 저장 안 함·기록에서 빠진 답변 포함·뒤 메시지 포함·다른 대화 포함.
- **변이 시험(2026-11-11):** 22개 변이를 하나씩 넣어 모두 시험이 잡았다 — 기록 검사 끔·시간대 없는 asOf 허용·tool_meta 표시 제거, 답변의 출처·기준 시각 검사 끔, 면책 비움·실행 관리자 첨부 제거·후속 답변 검사 제거, 아들 숨김 제거·사용자별 도구 거름 제거·호출 시 재확인 제거, 모든 금융 도구가 프록시 하나를 공유·계획 호스트 검사 제거·접미 일치 허용·호스트 목록 확장·호스트 목록 틀림, KRX 성탄절 누락·미국 조기 폐장 누락·주말을 거래일로·휴장 중 값에 원래 시각·오늘이면 무조건 장중.

## 아티팩트 서빙 (#27)
에이전트가 만든 HTML·SVG·차트·표·문서·코드를 버전과 함께 저장하고, **실제로 동작하면서** 앱의 쿠키·API·화면에 닿지 못하게 서빙한다(PRD FR-6.5). 코드는 `apps/server/src/artifacts/`(저장 `store.ts`, 서빙 `serve.ts`, 경로 `routes.ts`), 도구 정의는 `packages/mcp-tools/src/artifacts.ts`, 화면은 `apps/web/src/pages/ArtifactPage.tsx`.

- **만들기:** MCP 도구 `artifact_create`·`artifact_update`(모든 활성 사용자). 누구의·어느 대화의 아티팩트인지는 **run 토큰의 범위**에서만 정해진다(입력에 사용자·대화 필드가 없고, 모르는 필드는 거부). 저장 전에 그 대화의 주인이 토큰의 사용자인지 다시 확인한다. `artifact_update`는 토큰의 대화에 있는 아티팩트만 찾는다(다른 대화의 id는 `artifact_not_found`).
  - 종류: `html`·`svg`·`markdown`·`code`(본문 글자), `chart`(데이터 명세 — 서버가 SVG로 그린다, 스크립트 없음), `table`(열·행 — HTML 표, CSV 내려받기), `document`(생성 파일 참조 `fileId`·이름·형식만. 미리보기는 #49·#22 뒤).
  - 한도: 한 버전 512KB(UTF-8 바이트, 서버가 잼), 제목 200자, 아티팩트당 버전 100개, 대화당 아티팩트 200개, 차트 라벨 500·계열 10, 표 열 50·행 5000·칸 1000자.
  - 오류 코드: `artifact_bad_input`, `artifact_too_large`, `artifact_not_found`, `artifact_not_allowed`, `artifact_limit`. 입력 모양이 틀리면 MCP SDK의 스키마 검사가 먼저 거부한다(서버가 한 번 더 검사).
  - 로그: 호출마다 `artifact.finished`(도구 이름, `ok`/`error`, `artifactCode`, 소요 시간, ID). **제목·본문은 남기지 않는다**(시험: 본문·제목 문자열이 로그에 없음).
- **저장(0011 마이그레이션):** `artifacts`(사용자·대화·메시지·run, 종류, 제목, 최신 버전)와 `artifact_versions`(버전 번호, 제목, 코드 언어, 본문, SHA-256, 바이트 수, run, 복원 원본). 코드 언어는 **버전마다** 저장한다: 내려받기 이름, 되돌리기, 같은 내용 판정이 그 버전의 값을 쓴다(언어만 바꾼 고치기도 새 버전, 리뷰 #92 1차). **버전 행은 바뀌지 않는다** — 수정·되돌리기는 새 행을 넣고, DB 트리거가 `UPDATE`를 거부한다. 같은 본문·제목으로 다시 고치면 새 버전을 만들지 않는다. 대화나 사용자를 지우면 함께 지워진다(FK cascade, 시험). 메시지 행이 사라지면 `message_id`만 비운다.
- **되돌리기:** `POST /api/artifacts/:id/revert {version}` = 그 버전의 제목·본문을 복사한 새 버전(`revertedFrom`). 주인만.
- **읽기 API(주인만, 공유는 #29):** `GET /api/conversations/:id/artifacts`, `GET /api/artifacts/:id`(버전 목록, 본문 없음), `GET /api/artifacts/:id/versions/:version`(본문 JSON — 앱이 렌더링하지 않는다).
- **화면 `/a/:id`:** 앱 페이지(SPA). 서버가 먼저 권한을 검사한다 — 남은 403, 로그인 안 함은 401, 없는 id는 404이고 몸은 앱 셸(로그인·오류 화면)이다. 본문은 `<iframe sandbox="allow-scripts">`로만 보인다(`allow-same-origin`·`allow-top-navigation`·`allow-popups`·`allow-forms` 없음).
- **원본 `/a/:id/v/:ver/raw`:** 같은 권한 검사(남 403). 응답 헤더:
  - `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src <인라인 스크립트 sha256…> https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'; base-uri 'none'`(정책 A)
  - HTML이면 **두 번째 `Content-Security-Policy` 헤더**(정책 B): `script-src 'unsafe-inline' https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js`. 브라우저는 받은 정책을 모두 적용한다(교집합). 이유(리뷰 #92 1차): CSP3에서 해시 소스는 `integrity`가 그 해시인 **외부** 스크립트도 허용한다. 그래서 A만 있으면 `<script src="https://아무데나/x.js" integrity="sha256-<인라인 스크립트의 해시>">`가 (그 호스트가 같은 본문과 CORS를 주면) 실행된다. B에는 해시가 없어 외부 스크립트는 CDN URL과 맞아야만 하고, 인라인은 B가 더 제한하지 않는다 — A가 해시를 요구하고 이벤트 속성을 막는다. B에 해시를 넣으면 `'unsafe-inline'`이 꺼지면서 B가 같은 구멍을 다시 연다(단위 시험이 B에 해시가 없음을 확인). 헤더 두 줄은 실제 소켓에서 확인한다.
  - `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`, `Permissions-Policy`(카메라·마이크·위치 등 끔).
  - 앱의 `onSend` 훅은 CSP가 이미 있는 응답에는 앱 CSP를 덮어쓰지 않는다(운영 모드에서도 원본은 위 CSP — 시험).
  - 종류별: html은 `text/html`(스크립트 해시), svg는 `image/svg+xml`(**스크립트 허용 없음** `script-src 'none'` — 대화형은 html로), chart·표는 서버가 그린 HTML(스크립트 없음), markdown·code는 `text/plain`. document는 원본이 아직 없어 404.
  - 내려받기 `/a/:id/v/:ver/download`: 원본 파일(html·svg·md·코드), 차트는 SVG, 표는 CSV(UTF-8 BOM, `= + - @`로 시작하는 칸은 `'`를 붙여 수식 실행 방지). `Content-Disposition: attachment`(파일 이름은 제목을 코드 포인트 100개로 자르고 외톨이 서로게이트는 U+FFFD — 이모지가 경계에 걸려도 500이 나지 않음) + 같은 샌드박스 CSP.
- **iframe이 쿠키를 들고 원본을 불러오는 방법:** iframe의 `src`는 같은 출처의 원본 주소다. 문서가 불투명 출처가 되는 것은 **응답을 받은 뒤**(iframe `sandbox` 속성과 CSP `sandbox`)이고, 요청 자체는 부모(앱 페이지, 같은 사이트)가 시작한 탐색이라 `SameSite=Lax` 세션 쿠키가 실린다. 그래서 원본도 보통 경로처럼 권한을 검사할 수 있다. 쿠키 자체는 `HttpOnly`라 원래도 스크립트가 못 읽지만, 시험은 일부러 HttpOnly가 아닌 쿠키(`al_probe`)를 넣고 앱 페이지는 읽고 아티팩트는 못 읽음을 확인한다. 아티팩트 안에서 같은 출처로 다시 탐색하는 요청(불투명 출처가 시작)은 교차 사이트로 취급될 수 있어 쿠키가 안 실릴 수 있다 — 그래도 열리는 것은 그 사용자의 다른 원본뿐이고, 역시 샌드박스다.
- **원본을 최상위 창으로 열어도:** CSP `sandbox`는 최상위 문서에도 적용된다. 출처는 `null`, `document.cookie`·`localStorage`는 SecurityError, `fetch('/api/…')`는 `connect-src`로 막힌다(시험). 그래서 링크로 원본을 직접 열게 해도 앱을 공격하는 페이지가 되지 못한다. `frame-ancestors 'self'`라 다른 사이트에 끼워 넣을 수도 없다.
- **인라인 스크립트:** 서빙할 때마다 서버가 각 인라인 `<script>`의 SHA-256을 계산해 `script-src`에 넣는다(생성 HTML이 그대로 동작). 찾기(`findScripts`)는 HTML 토크나이저를 따른다: 주석 건너뜀, 따옴표 속 `>`, 대소문자, `</script` 뒤 공백·`/`·`>`, 닫히지 않은 스크립트. 해시 전 줄바꿈 정규화(CRLF·CR → LF)와 NUL → U+FFFD(파서와 같게). 브라우저와 다르게 읽는 드문 경우(`<!--<script>` 이중 이스케이프, SVG 안의 `<script>`, `<textarea>` 속 글자)는 해시가 맞지 않아 **그 스크립트가 막힐 뿐**이다 — 어긋남이 다른 것을 허용하지는 않는다. 해시는 문서당 256개까지.
  - 해시가 아티팩트 작성자(모델)를 제한하는 장치는 아니다: 문서에 든 스크립트는 다 돌 수 있다. 보안 경계는 불투명 출처 + `connect-src 'none'` + 외부 스크립트 허용 목록이다.
  - **인라인 이벤트 속성(`onclick=` 등)과 `javascript:` URL은 실행되지 않는다**('unsafe-inline'·'unsafe-hashes' 없음, 시험: 클릭해도 실행 안 되고 `script-src-attr` 위반). 생성 HTML은 `addEventListener`를 쓴다(도구 설명에 적음).
- **허용 CDN(`CDN_ALLOW_LIST`):** 버전·경로를 고정한 정확한 URL만(경로가 `/`로 끝나지 않는 CSP 소스는 정확히 그 경로만 맞는다). 지금은 Chart.js 4.4.1 하나(`https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js`). 서빙할 때 그 URL의 `<script src>`에 SRI `integrity`(sha384)와 `crossorigin="anonymous"`를 넣는다(작성자가 이미 넣은 integrity는 그대로). 다른 호스트(`evil.example.com`), 같은 호스트의 다른 버전(`chart.js@4.4.0`)은 막힌다(시험). 추가 방법은 `docs/ops.md` §18.
- **서비스 워커:** `/a/<id>/v/…`는 가로채지 않는다(오프라인 셸이 원본 자리에 나오지 않게).
- **시험:**
  - Playwright(`e2e/artifacts.spec.ts`, FakeRuntime `/artifact` 명령 → 실제 MCP `artifact_create` 호출): 자체 포함 캔버스·SVG 차트가 **실제로 그려짐**(캔버스 픽셀 `rgb(47,111,176)`, SVG 막대 4개)을 먼저 확인한 뒤 같은 문서에서 출처 `null`, `document.cookie` SecurityError, `localStorage` SecurityError, `parent.document` SecurityError, `top.location` 변경 SecurityError(주소 그대로), `fetch('/api/conversations')` TypeError(`connect-src` 위반, 서버로 나간 요청 없음), 허용 밖 CDN 2개 `script-src-elem` 위반, 인라인 `onclick` 미실행. 비허용 호스트(`page.route`로 같은 본문 + CORS를 줌)의 스크립트에 허용된 인라인 스크립트의 해시를 `integrity`로 붙여도 실행되지 않고 요청도 나가지 않는다. 최상위로 연 원본도 같다. 아들 계정은 `/a/:id`·원본·내려받기·API 모두 403(화면은 "권한이 없어요"). 되돌리기 화면 흐름.
  - CDN 실제 로드(`E2E_NETWORK=1`일 때만 — CI가 네트워크에 기대지 않게): Chart.js가 SRI 검사를 지나 로드되고 막대를 그린다(2026-11-11 로컬 통과). 네트워크 없이도 도는 시험이 SRI 주입과 `script-src`의 https 소스가 정확히 그 URL 하나임을 확인한다.
  - 단위·통합(`apps/server/test/artifacts.test.ts`): 스크립트 찾기 경계값, CSP 문자열 전체, SRI 주입, CSV, 저장 범위·한도·불변·cascade, MCP 경로(다른 대화 토큰, 남의 대화, 모르는 필드, 바이트 한도), 헤더(테스트·운영 모드), 권한 행렬 7행.
- **변이 시험(2026-11-11):** 하나씩 망가뜨리면 시험이 실패함을 확인했다. 저장의 대화 주인 검사 제거, 고치기의 대화 범위 검사 제거, 자원 로더가 모두에게 공유, 원본 경로를 `noResource`로, `onSend`가 원본 CSP를 덮어씀, 줄바꿈 정규화 제거, 주석 건너뛰기 제거, CSV 수식 방지 제거, 불변 트리거 제거, 바이트 대신 글자 수로 한도, SRI 주입 제거, 차트 값 개수 검사 제거, CSP `sandbox` 제거(최상위 시험이 잡음 — iframe 시험은 iframe 속성만으로도 통과: 두 겹이 따로 막는다는 뜻), `connect-src 'self'`, 인라인 해시 없음(차트가 안 그려짐), CDN을 호스트 전체로, `allow-top-navigation` 추가, iframe에 `allow-same-origin` 추가, iframe `sandbox` 속성 제거.
  - 리뷰 #92 1차 뒤 추가: 정책 B 제거(단위 시험과 e2e — 비허용 호스트의 같은 본문·같은 해시 SRI 스크립트가 실행되어 `hits`가 2가 됨, 즉 시험 경로가 실제로 서빙됨을 보여 줌), 내려받기가 아티팩트 언어 사용, 되돌리기가 최신 언어 사용, 같은 내용 판정에서 언어 무시, 파일 이름을 UTF-16 단위로 자름, 외톨이 서로게이트 치환 제거. 모두 시험이 잡았다.
- **남은 위험·미룬 것:**
  - 아티팩트가 **자기 프레임**을 외부 주소로 탐색하는 것은 막지 못한다(CSP에 탐색 제한이 없다 — `navigate-to`는 브라우저가 지원하지 않음). 새 창(`allow-popups` 없음)·최상위 창은 막힌다. 이때 나갈 수 있는 것은 아티팩트 자신의 내용과 그 안에서 사용자가 입력한 것뿐이다(쿠키·API·대화 내용은 아님). 모델이 대화 내용을 아티팩트에 넣게 만드는 프롬프트 주입은 #20 평가(`artifact_create → 숨은 지시 게시`)가 다룬다.
  - `document` 미리보기(pdf.js, DOCX·PPTX·XLSX의 PDF 변환)는 #49·#22. 지금은 참조만 저장하고 화면은 "준비 중".
  - 아티팩트 패널·메시지 안 카드(`artifact_ref` 부분)는 #28, PNG·PDF 내려받기는 #51(아래 절), 공유는 #29(자원 로더의 `sharedWith`), 목록 화면은 #28·#52.

## 아티팩트 내보내기 (#51)
차트를 PNG로, HTML·문서를 PDF로 내려받는다(PRD FR-6.4, FR-7.5의 "저장"). 남이 만든 HTML을 서버가 직접 그리는 일이라, 렌더러는 **아티팩트 서빙(#27)과 같은 문서를 #42의 격리 위에서** 연다. 코드: `apps/server/src/artifacts/browser.ts`(브라우저 찾기·스위치·실행기·DevTools 파이프), `export.ts`(렌더러·한도·종류별 형식), 경로는 `routes.ts`, 화면은 `apps/web/src/pages/ArtifactPage.tsx`.

- **브라우저:** Playwright가 이미 쓰는 **Chrome Headless Shell**(저장소의 `@playwright/test` 1.65.0이 고정한 빌드, 지금 158.0.8127.18 / rev 1254)을 그대로 쓴다. **새 런타임 의존성은 없다**(Playwright 라이브러리도 서버가 불러오지 않는다 — DevTools 프로토콜을 파이프로 직접 말한다). 실행 파일은 `EXPORT_BROWSER`(절대 경로)가 있으면 그것, 없으면 Playwright 캐시(`PLAYWRIGHT_BROWSERS_PATH` 또는 플랫폼 기본 위치)에서 설치가 끝난(`INSTALLATION_COMPLETE`) 가장 새 `chromium_headless_shell-<rev>`. 없으면 내보내기는 `export_unavailable`(503)이다. 설치는 `docs/ops.md` §18.4.
  - 헤드리스 셸은 폴더 하나에 든 단일 실행 파일이라 샌드박스에서 "읽기 전용 프로그램 폴더"(`trusted`)로 열기 쉽다. 전체 Chromium(.app 번들과 도우미 앱)보다 작고 단순하다.
- **프로세스 하나, 렌더 하나:** 내보내기마다 새 브라우저 프로세스를 띄우고 끝나면 프로세스 그룹째 끝낸다(`Browser.close` 뒤 2초 안에 안 끝나면 SIGKILL).
  - `--single-process --no-zygote`: 렌더러·GPU·네트워크 도우미 프로세스가 없다. 그래서 #42의 **fork 금지 프로파일을 그대로** 쓸 수 있고, 메모리 한도가 브라우저 전체에 걸린다. Chrome 자체 샌드박스는 끈다(`--no-sandbox`) — 우리 샌드박스 안에서 돌고, macOS는 seatbelt 프로파일을 겹칠 수 없다.
  - 조종은 `--remote-debugging-pipe`(fd 3 입력, fd 4 출력). **포트를 열지 않는다** — 다른 로컬 프로세스가 붙을 수 없다. `spawnIsolated`에 `extraPipes`를 더했다(파이프 2개).
  - 2026-11-11 macOS 27.0.1에서 확인: `(deny default)` + `system.sb` + 읽기 = 브라우저 폴더, 쓰기 = 렌더 폴더, fork 없음, 네트워크 = 프록시 포트 하나로 PNG·PDF가 나온다. 한글 글꼴도 `system.sb`가 여는 시스템 글꼴로 그려진다(샘플 PNG·PDF 확인).
- **앱 쿠키·세션 없음:**
  - 렌더마다 새 빈 프로필 폴더(`mkdtemp` → `profile`·`home`·`tmp`, 0700)를 쓰고 끝나면 지운다. 환경 변수는 `HOME`·`TMPDIR` 둘뿐이다(서버 환경을 물려받지 않음).
  - 문서는 **앱 주소로 열지 않는다.** 가짜 주소 `https://artifact.invalid/`로 탐색하고 그 요청을 DevTools `Fetch.fulfillRequest`로 채운다. 본문과 헤더는 서빙과 같다(`serveVersion` — HTML은 정책 A·B 두 CSP, 그 밖은 스크립트 없는 CSP). 그래서 렌더러 안의 문서도 불투명 출처(`self.origin === "null"`), `connect-src 'none'`, 스크립트 해시·정확한 CDN URL이다. markdown·코드는 서빙이 `text/plain`이라 제목 + `<pre>`(이스케이프) 페이지로 인쇄한다.
  - 경로 처리기는 렌더러에 **저장된 버전(본문·제목·종류)만** 넘긴다. 요청·쿠키·세션은 넘어가지 않는다(시험: 작업 객체의 키가 `doc·format·scripts`뿐이고 세션 토큰이 없음).
- **네트워크 — 세 겹, 각각 따로 막는다:**
  1. **브라우저 안 요청 가로채기**(`Fetch.enable`, 모든 URL): 문서 주소는 한 번만 채우고, `CDN_ALLOW_LIST`의 **정확한 URL**만 계속 보내고, 나머지는 `BlockedByClient`로 실패시킨다. CSP가 막지 못하는 유일한 것 — **문서가 자기 프레임을 다른 주소로 탐색**하는 것(#27 "남은 위험") — 도 여기서 막힌다(시험: `location.href = "http://127.0.0.1:<port>/api/nav"`가 가로채기 목록에 있고 앱 서버에 닿지 않음).
  2. **송신 프록시**(#42 `EgressService`, 허용 목록 = `CDN_ALLOW_LIST`의 호스트 = `cdn.jsdelivr.net`, 포트 443): 브라우저는 `--proxy-server`로 모든 요청을 여기로 보낸다. `--proxy-bypass-list=<-loopback>`으로 Chrome의 기본 루프백 예외를 없앴다(없으면 `127.0.0.1`·`localhost`는 프록시를 건너뛴다 — 변이 시험으로 확인). 프록시는 평문 HTTP 프록시 요청을 405로, 허용 목록 밖 CONNECT를 403으로 거절하고, 허용 호스트도 답이 루프백·사설·링크 로컬·메타데이터면 거부한다. WebRTC는 `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`(프록시를 거치지 않는 UDP 금지).
  3. **macOS 프로세스 샌드박스**(`sandboxedLauncher` = `spawnIsolated`): 네트워크는 프록시의 루프백 포트 하나뿐. 브라우저 안의 두 겹이 다 뚫려도 커널이 거부한다(시험: CSP·가로채기·프록시 스위치를 모두 끄고 샌드박스만 남겨도 앱 서버에 요청 0).
  - CSP(#27)는 네 번째 겹이다. Chrome의 "로컬 네트워크 접근" 규칙도 공개 문서의 루프백 하위 요청을 막지만, 우리 경계로 세지 않는다.
- **DevTools 파이프도 공격면이다(리뷰 #95 1차):** 브라우저 전체가 `--single-process --no-sandbox`로 돈다 — 아티팩트를 그리는 렌더러 코드와 파이프(fd 4)를 쓰는 코드가 **같은 프로세스**이고 Chrome 자체 샌드박스도 없다. 렌더러의 네이티브 취약점 하나면 공격자가 fd 4로 서버에 아무 바이트나 보낼 수 있다(커널 샌드박스는 그 프로세스의 파일·네트워크를 막을 뿐, 이미 열린 파이프는 막지 않는다). 그래서 서버는 파이프에서 오는 모든 것을 적대적인 입력으로 다룬다(`browser.ts` `CdpPipe`, `export.ts`):
  - 메시지마다 모양 검사(`parseMessage`): JSON 객체, `id`는 양의 정수, `method`·`sessionId`는 문자열, `params`·`result`는 객체, 응답(id)과 이벤트(method) 중 정확히 하나. 아니면 연결을 닫는다(`protocol`). 보낸 적 없는 id의 응답도 같다. 메시지 하나는 48MB까지.
  - 쓰는 응답·이벤트는 zod로 검사한다(`Target.createTarget`·`attachToTarget`의 id, PNG·PDF의 base64 `data`, `getLayoutMetrics`의 크기, `Fetch.requestPaused`의 `requestId`·`request.url`·`resourceType`). 맞지 않으면 그 렌더만 `export_failed`.
  - 이벤트 처리기에서 난 예외도 연결을 닫는 것으로 끝난다(`dispatch`의 try). 파이프의 모든 Promise는 만들 때 처리기를 붙인다(`quiet`) — 탐색 응답 전에 브라우저가 죽어도 unhandled rejection으로 서버가 끝나지 않는다(리뷰 P1: `Page.loadEventFired` 대기와 `Page.navigate`를 `Promise.all`로 함께 기다림).
  - 프로토콜 오류·크기 초과·실패한 렌더는 브라우저에 닫으라고 묻지 않고 **바로 프로세스 그룹을 SIGKILL**한다. 렌더 폴더는 늘 지운다.
  - 시험: 별도 Node 프로세스(`test/fixtures/export/host.ts`)가 가짜 브라우저(`fake-browser.mjs`)로 탐색 응답 전 종료, 깨진 JSON, `null`, 배열, 문자열 id, 모르는 id, 객체가 아닌 `result`, 틀린 응답 모양, 잘못된 `Fetch.requestPaused` params, 48MB 넘는 응답, 무응답을 차례로 보낸다. 호스트는 끝까지 살아 있고(종료 코드 0, stderr 없음), 각 렌더는 정해진 코드로 끝나며 1초 안에(무응답은 시간 한도에서) 브라우저 프로세스가 없고 렌더 폴더가 남지 않는다.
- **`system.sb`가 여는 IPC:** 프로파일은 `(import "system.sb")`로 OS 기본 동작(동적 라이브러리, 글꼴, 로캘)을 연다. 여기에는 표준 Mach/XPC 서비스 조회와 syslog(로그) 같은 **IPC도 들어 있다**. 그러니 "디버깅 포트가 없다"가 "IPC가 전혀 없다"는 뜻은 아니다. 뜻하는 바:
  - 침해된 렌더러는 시스템이 모든 샌드박스 프로세스에 열어 둔 서비스(글꼴 서버, 알림 센터, 로그 등)에 말할 수 있다. 그 서비스들의 취약점은 우리 경계 밖의 위험이다(macOS가 자기 샌드박스 앱에 같은 것을 허용한다).
  - 우리 앱 서버와의 통로는 열린 파이프 두 개뿐이다(위 검사). 우리 서버는 Mach/XPC 서비스를 내지 않는다.
  - DNS: 시스템 해석기(mDNSResponder)로 가는 길도 막혀 있다 — 같은 정책의 프로세스에서 `dns.lookup`이 실패한다(macOS 시험). 그래서 이름을 해석하게 해서 정보를 흘리는 길(DNS 유출)도 없다. Chrome은 프록시가 이름을 해석하므로 스스로 해석할 일이 없다.
  - 네트워크 엔드포인트(TCP·UDP)는 프록시 포트 하나만 열린다(시험). 더 좁히려면(`mach-lookup` 목록 지정) `system.sb`를 쓰지 않는 손으로 쓴 프로파일이 필요하다 — Chrome이 필요한 서비스가 버전마다 바뀌어 지금은 하지 않는다.
- **한도(`RENDER_LIMITS`):** 렌더 전체 20초(넘으면 프로세스 그룹 SIGKILL → `export_timeout` 504), 메모리 768MB(브라우저 프로세스 RSS를 250ms마다 `ps`로 측정 — 넘거나 **측정이 안 되면** 종료 → `export_limit` 413, fail closed), DevTools 응답 하나 48MB·파일 32MB(`export_limit`), 동시에 2개 + 대기 4개(넘으면 `export_busy` 503, `Retry-After: 5`). HTML은 불러온 뒤 스크립트(차트 애니메이션)에 1.2초를 준다. 그 밖의 종류는 스크립트 실행을 끈다(`Emulation.setScriptExecutionDisabled`). PNG는 폭 800 CSS px·배율 2, 높이는 내용 높이(최대 6000px), PDF는 A4·배경 인쇄·밝은 색 구성표.
- **형식(`ARTIFACT_EXPORTS`, shared):** PNG — chart·svg·html, PDF — html·chart·table·markdown·code. document(생성 파일 참조)는 #49·#22에서 파일 자체의 변환과 함께(지금 404).
- **경로(주인만, #27과 같은 자원 검사):** `GET /a/:id/v/:version/png`, `GET /a/:id/v/:version/pdf`. 남·관리자 403, 비로그인 401, 없는 버전·지원하지 않는 형식 404(렌더러를 부르지 않는다). 응답은 내려받기와 같은 헤더(`Content-Disposition: attachment`, 샌드박스 CSP, `no-store`, `nosniff`). 권한 행렬에 2행 추가.
- **차트는 클라이언트 캡처 먼저:** 화면의 PNG 버튼은 차트면 브라우저에서 먼저 그린다 — 주인만 받는 SVG 내려받기(서버가 그린 SVG, 스크립트 없음)를 `fetch`해서 `<img>`(blob URL) → 캔버스(배율 2, 흰 배경) → `toBlob`. 샌드박스 iframe은 건드리지 않는다. 실패하면(내려받기 실패, 이미지 해석 실패 등) 서버 렌더(`/png`)를 부른다. 그 밖의 PNG·PDF는 서버 렌더다. 실패하면 화면에 "만들지 못했어요"를 보이고 오류 응답을 파일로 저장하지 않는다. 받은 것이 파일인지는 **정확히 200 + 기대한 Content-Type**(`image/svg+xml`·`image/png`·`application/pdf`)으로 판단하고, 리다이렉트는 따라가지 않는다(`redirect: "manual"`). 그래서 게이트·세션이 만료되어 로그인 페이지(302 → 200 HTML)가 와도 그것을 .png·.pdf로 저장하지 않는다(리뷰 #95 1차, e2e: 게이트로 302, 200 로그인 HTML, 실제 세션 종료 401 — 셋 다 오류 문구, 내려받기 0).
- **로그:** 내보내기마다 `artifact.exported` 하나 — `userId`, `exportFormat`(`png`/`pdf`), `exportCode`(`export_ok`·`export_unavailable`·`export_busy`·`export_timeout`·`export_limit`·`export_failed`), 소요 시간. 제목·본문·URL은 남기지 않는다(시험).
- **Linux(CI):** sandbox-exec가 없어 운영 실행기는 거부한다(`export_unavailable`, 시험). 대신 **운영 실행기의 정책은 Linux CI에서도 검사한다**(리뷰 #95 1차): `rendererSandbox`(운영 실행기가 `spawnIsolated`에 넘기는 값, 순수 함수)가 네트워크 = 프록시 루프백 포트 하나, 읽기 = 브라우저 폴더, 쓰기 = 렌더 폴더, 넘긴 환경 변수만, 파이프 2개인지와, `buildProfile`이 만든 프로파일 문자열(deny default, `process-fork` 없음, 네트워크 줄은 그 포트 하나, 쓰기 줄은 렌더 폴더 하나, 실행은 브라우저 하나, `(allow network*)`·`mach-lookup` 추가 없음)을 확인한다. `network: "all"`이나 쓰기 경로 넓히기는 Linux에서도 실패한다. 커널이 실제로 막는지는 macOS 시험(이 Mac의 `pnpm test`에서 늘 돈다)이 확인한다. macOS CI 러너는 두지 않았다(비용·저장소 설정 결정). 웹 작업자(#50)와 같은 방식으로, 시험은 Linux에서 같은 브라우저를 샌드박스 없이(`unsandboxedLauncher`, 시험 전용) 돌려 브라우저 안의 겹(가로채기·프록시·CSP)·쿠키 격리·시간·메모리·크기 한도를 확인하고, 커널 겹은 macOS 시험이 확인한다. CI의 `test` 작업이 헤드리스 셸을 설치한다(`playwright install --with-deps --only-shell chromium`). CI에서 브라우저가 없으면 시험 파일이 실패한다(건너뛰지 않음). Linux 결과는 `node:22-bookworm` 컨테이너에서 같은 명령으로 확인했다(2026-11-11, 리뷰 #95 1차 뒤: 25 통과·macOS 전용 5 건너뜀).
- **시험(`apps/server/test/artifact-export.test.ts`, 실제 헤드리스 셸):**
  - 샘플: 차트 PNG(1600px 폭, 내용 높이), HTML 문서 PDF(인라인 스크립트가 그린 줄 포함), 표·markdown·코드 PDF, SVG PNG.
  - **앱·사설 IP 차단(완료 기준):** 한 문서가 `http://127.0.0.1:<시험 서버 포트>/api/…`를 stylesheet·prefetch·script·img·iframe·fetch(credentials)·sendBeacon·WebSocket·**자기 탐색**으로, `10.0.0.1`·`192.168.1.1`·`169.254.169.254`·`localhost`·`[::1]`·공개 호스트(`example.org`)를 요청한다. 시험 서버가 받은 요청 0, 프록시의 이름 해석 0, 업스트림 연결 0(PNG·PDF 모두).
  - 겹마다 따로: 대조(모든 겹을 끄고 샌드박스 없이 → 앱 서버가 탐색 요청을 받음, 즉 시험이 실제로 닿을 수 있음), CSP만(탐색은 통과 — 다른 겹이 필요한 이유), 가로채기만, 프록시만(루프백 포함), macOS 샌드박스만. 각각 요청 0.
  - 허용 CDN: 정확한 Chart.js URL만 프록시로 가고(이름 해석은 `cdn.jsdelivr.net`뿐), 같은 호스트의 다른 버전은 가로채기에서 막힌다.
  - 쿠키·세션: 렌더마다 다른 새 빈 프로필, 환경 변수 2개, 끝나면 폴더 없음, 쿠키 저장소 비어 있음(문서가 쿠키를 심으려 해도), 문서 주소는 가짜 주소, 출처 `null`.
  - 시간(무한 루프 → 3초 한도에서 `export_timeout`, 프로세스 없음), 메모리(20MB 한도 → `export_limit`, 측정 불가 → `export_limit`), 응답·파일 크기, 동시 1 + 대기 1에서 세 번째는 `export_busy`이고 한 번에 하나만 실행.
  - 경로: 주인만(남·관리자·공유 대상 403, 비로그인 401 — 거절된 요청은 렌더러에 닿지 않음), 종류별 형식 404, 실패 코드별 상태, 로그에 제목 없음, 시험 환경 기본값은 `export_unavailable`.
  - e2e(`e2e/artifacts.spec.ts`): 차트 PNG 버튼 → 클라이언트 캡처로 PNG 파일(서버 `/png` 호출 없음), SVG 내려받기를 막으면 서버 렌더로 넘어감(macOS: PNG 파일, Linux: 503 → 오류 문구). HTML 문서 PDF(macOS: `%PDF-` 파일 — e2e 서버가 실제 샌드박스 렌더러로 만든다), 아들 계정은 `/png`·`/pdf` 403.
- **리뷰 #95 1차 뒤 더한 시험:**
  - 모든 플랫폼: 파이프 메시지 모양 경계값, 호스트 생존(위), 운영 실행기 정책·프로파일(위). 브라우저: WebRTC가 UDP를 내보내지 못함(대조: 정책 스위치를 빼고 샌드박스 없이 돌리면 시험 UDP 수신기가 STUN을 받음), `--disable-quic`, 리다이렉트는 홉마다 다시 검사(허용한 첫 주소가 앱으로 302 → 첫 홉만 나가고 대상은 가로채기에서 막힘), `data:` iframe·`blob:` 작업자·`file:` iframe·`file:` 탐색이 앱에 닿지 못하고 로컬 파일도 읽지 못함.
  - macOS 커널(운영 실행기, 브라우저 안의 겹을 모두 끈 채): 양성 대조로 문서가 먼저 그려짐, DevTools로 직접 `file://`을 열게 해도 샌드박스 밖 파일을 못 읽음(대조: 샌드박스 없이는 읽음), WebRTC 정책 스위치를 빼도 UDP 0, 같은 정책의 프로세스로 직접 재 보면 프록시 포트 TCP만 되고(양성 대조) 다른 TCP·로컬 UDP·공개 DNS UDP·이름 해석은 모두 실패.
- **변이 시험(2026-11-11, macOS):** 하나씩 망가뜨리면 시험이 실패함을 확인했다(15개 모두): 가로채기가 모두 통과, `--proxy-server` 제거, `<-loopback>` 제거(루프백이 프록시를 건너뜀), 프록시를 공개 주소 모드로, 샌드박스 네트워크 `all`, 서버 환경 상속, 렌더 사이 공유 프로필, 렌더 폴더 남김, CSP 헤더 안 보냄(출처 `null` 확인이 잡음), 시간 한도 제거, 메모리 비교 제거, 측정 불가 허용, 응답 크기 무제한, 경로를 `noResource`로(권한 행렬·경로 시험), 렌더러에 요청 쿠키 전달.
- **변이 시험(리뷰 #95 1차 뒤, 2026-11-11, macOS):** 모두 시험이 잡았다. `quiet` 제거(처리기 없는 전송이 unhandled rejection), `quiet` 제거 + 탐색·load를 차례로 기다림(리뷰가 지적한 그 코드 — 호스트 프로세스가 죽음), `parseMessage`가 아무 JSON이나 받음, 모르는 응답 id 무시(무응답 → 시간 초과로 드러남), 응답 zod 검사 생략, 프로토콜 오류 때 죽이지 않고 닫기를 요청(1초 안 종료 검사가 잡음), 운영 실행기 네트워크 `all`(Linux에서도 정책·프로파일 시험이 잡음), 쓰기 경로를 임시 폴더 전체로, `--disable-quic` 제거, 화면의 파일 판정을 `res.ok`로 + 리다이렉트 따라감(e2e).
  - 이벤트 처리기 예외의 try만 빼면 통과한다 — 바깥(`data` 처리기의 try)이 같은 일을 하는 두 번째 겹이라서다. 두 겹을 함께 빼면 호스트 생존 시험이 실패한다(확인).
- **남은 것:**
  - 문서(`document`) 종류의 PDF·미리보기는 생성 파일(#49)·파일 변환(#22)과 함께.
  - Chart.js처럼 CDN 스크립트를 쓰는 HTML의 실제 CDN 로드는 네트워크가 있을 때만 확인된다(시험의 프록시는 가짜 연결). 운영 Mac에서 수동 확인: `docs/ops.md` §18.4.
  - 서비스 사용자(LaunchDaemon)가 개발 계정과 다르면 Playwright 캐시 위치가 다르다 — `EXPORT_BROWSER`를 설정한다(ops.md).

## 인용 검증 (#25)
`cite`·`sources_list`는 프로세스를 띄우지 않는 서버 도구다(`apps/server/src/citations/`, 도구 정의 `packages/mcp-tools/src/web.ts`). 네트워크에 나가지 않는다 — #50이 저장한 본문만 읽는다. 운영은 `docs/ops.md` §22.

- **범위는 토큰에서만:** 사용자·대화·실행은 실행 토큰(`McpTokens`)의 것이다. 입력은 `{sourceId, snippet}`뿐이고 엄격 스키마라 다른 필드는 거부된다. 출처는 **토큰의 대화**에서만 찾고(`sources.conversation_id`), 그 행의 사용자가 토큰의 사용자이고 대화의 주인도 토큰의 사용자여야 한다(주인이 아니면 `cite_not_allowed`로 아무것도 저장하지 않음). 아니면 `unknown_source`이며, 그 id는 `citations`에 남기지 않고 결과·메모에 제목·URL·구절을 싣지 않는다 — 다른 대화·다른 사용자의 출처가 있는지조차 드러나지 않는다(없는 id와 같은 답).
- **검증은 서버 기록으로:** 실행 끝의 `citation_note`는 런타임이 보고한 도구 결과가 아니라 서버의 `citations` 행으로 만든다. 런타임이 "verified"라고 적은 가짜 결과를 내도 메모에는 반영되지 않고, 어떤 `cite`도 만들지 않은 `[n]`은 `unknown_source`다.
- **일치 규칙:** 정규화(NFC + 전각 ASCII·`…` 접기 — NFKC 없음, 따옴표·대시 통일, 보이지 않는 문자 제거, 공백 묶음, 소문자, HTML 개체. 각주 번호 빼기·줄 끝 하이픈 잇기는 없다(리뷰 #97 3·4차에서 제거). 애매하면 정규화하지 않는다 — 리뷰 #97 2·3차) 뒤 구절 전체가 그대로 있어야 한다. 유사도·일부 일치·조각 잇기는 없다. 일치는 토큰 중간에서 시작하거나 끝나지 않는다 — 앞·뒤 원문 글자가 `\p{L}`·`\p{N}`·`\p{M}`(수식 문자·위/아래 첨자 포함)이면 거부, 끝에서는 닫힌 조사 목록(`KOREAN_PARTICLES`·`COMBINING_PARTICLES`) 뒤 토큰 경계만 허용(리뷰 #97 5차 — "한글 뒤 한글"과 "문장 부호로 끝나는 인용" 예외 대체), 구분자·부호 뒤 숫자 안 시작(`1.32%`·`1,234`·`-32%`)도 거부(리뷰 #97 4차: 숫자·라틴 전용 규칙을 일반 규칙 하나로). 8자 미만은 증거가 못 된다.
- **남의 글:** `sources_list`의 제목은 `<external_content>` 블록 안에만 있다. 화면은 제목·사이트·구절을 글자로만 그리고(React 텍스트, HTML 해석 없음), 링크는 http(s) 주소만 만든다(`javascript:`·`data:` 등은 링크가 아님), 새 창 `noopener noreferrer`.
- **이벤트 루프:** 대조는 동기 코드다. 한 줄 정규화(글자별 캐시) + 본문 해시별 결과 캐시(본문 일치 확인)로 본문 한도 40만 자에서 첫 확인 25–35ms라 작업자 스레드로 옮기지 않았다. 시험이 한도에서 시간과 캐시 적중을 본다(리뷰 #97 1차: 전에는 2.5초).
- **로그:** `citation.finished`(도구, `ok`/`error`, `citeCode`, 소요 시간, ID). 출처 id·구절·본문·URL은 남지 않는다(시험).
- **FakeRuntime 모드의 가짜 페이지:** `FAKE_RUNTIME=1`일 때만 `https://fixture.agentlee.test/…`의 세 페이지와 검색어 하나를 서버 안에서 답한다(`fixtureWebWorker`). 그 밖의 주소는 평소의 샌드박스 작업자로 간다. 실제 운영(실런타임)에는 들어가지 않는다.
- **변이 시험(2026-11-11):** 36개를 하나씩 넣어 모두 시험이 잡았다 — 출처를 대화 조건 없이 찾기·출처 사용자 확인 제거·대화 주인 확인 제거·모르는 출처의 id 보관, 공백 묶기·따옴표·NFKC·소문자 정규화 각각 제거, 앞 60%만 맞으면 확인·시작 단어 경계 제거·숫자 끝 경계 제거·최소 길이 제거·"…" 조각 잇기 허용, 메모가 cite 없는 `[n]`을 빼기·문단 누락 검사 제거·도구 이름 접두어 무시·실패를 verified로 보고, 제목·머리말·면책 제외 각각 제거·콜론 줄은 모두 머리말·면책 길이 제한 제거·목록 항목 검사 제거·코드 속 `[n]` 세기, 복구한 실행에 메모 안 붙임, 자료 조사 모드를 지침에 안 넘김·조립에서 research 빼기, 화면에서 `fetch_failed`·`snippet_not_found`·모르는 상태 값을 정상으로·표시의 ⚠️ 제거·목록의 경고 표시 제거·문단 표시 제거·"일부 내용에 출처 표시 없음" 제거·`javascript:` 링크 허용·실패 문구를 "원문 구절 확인"으로.
- **리뷰 #97 1차 뒤 변이 시험(2026-11-11):** 새로 25개를 하나씩 넣어 모두 시험이 잡았다(타입 검사 1개 포함) — `pushNote`가 아무 부분이나 받기(타입 오류), 소수·천 단위·부호 시작 규칙 제거·부호만 빼기, 표시만 있는 답변에 메모 안 붙임·도구 없을 때 모든 `[n]` 세기·`a[1].length` 세기·줄 끝 `x = a[1]` 세기·인라인 코드 속 `[n]` 세기·화면이 서버 위치 대신 모든 `[n]`을 인용으로, 면책에 숫자 허용·이어지는 절 허용·다른 문장 허용·`※`만으로 면책, 캐시가 키만 믿기·캐시 없음, 진행 안내를 어디서나·숫자 있는 안내·안내 제외 없음·두 문장 안내, HTML 개체 안 풀기·줄 끝 하이픈 안 잇기·줄 안 하이픈도 잇기·숫자 사이 하이픈 잇기, 대괄호 각주·위 첨자 각주 남기기. 처음 36개도 바뀐 코드에 맞춰 다시 돌려 모두 잡혔다.
- **리뷰 #97 2차 뒤 변이 시험(2026-11-11):** 새로 17개를 하나씩 넣어 모두 시험이 잡았다 — 위 첨자 늘 빼기·라틴 글자 뒤에서 빼기·숫자 뒤에서 빼기·낱말 끝 확인 없음, 숫자 사이·숫자 뒤·숫자 앞 `[n]` 빼기, 하이픈 앞 공백 허용·빈 줄 넘어 잇기·줄바꿈 앞 공백 허용·HTML 개체 하이픈 잇기, ASCII 빠른 경로가 결합 문자 무시, 줄 끝 표시에 뒤 공백 불허, 안내 문장 앞부분 일치·옛 "시작만 맞으면" 규칙·안내 한 문장만 있으면 면책, 진행 안내의 연결 어미 무시. 1차·처음 변이 시험도 다시 돌려 모두 잡혔다(바뀐 규칙에 맞춰 대상 조정).
- **리뷰 #97 3차(2026-11-11):** 잘못된 "확인" 두 가지를 규칙을 다듬는 대신 정규화를 빼서 막았다 — NFKC를 NFC + 명시적 접기로 바꿈(`10²만` ≠ `102만`, `(10)²` ≠ `(10)`, `H₂O` ≠ `H2O`), 줄 끝 하이픈 잇기를 없앰(`x−↵y` ≠ `xy`, `re-↵sign` ≠ `resign`; 2차의 하이픈 변이 시험 항목도 함께 뺐다). 줄 끝 `[n]`은 식 안의 배열 접근일 때만 뺀다(영문 문장 끝 `year[1]`·`Ultra[1]`은 표시). 진행 안내에 사실을 담는 절(…음을·…다는·…라는)이 있으면 검사. 변이 시험 14개(NFKC 되돌리기·NFC 없음·전각 접기 없음·`…` 접기 없음, 위 첨자를 부호 뒤·숫자 뒤에서 빼기·한글 뒤에서도 안 빼기, 줄 끝 하이픈 다시 잇기, 식 판정 늘 거짓·옛 "이름 뒤면 제외"·`.`/`]` 규칙 제거·연산자 규칙 제거·연쇄 규칙 제거, 사실 절 규칙 제거)를 하나씩 넣어 모두 잡았고, 앞 세 차례 변이 시험도 다시 돌려 모두 잡혔다. 공백 폭 접기는 `\s`가 이미 다루어 뺐다(변이가 살아남아 중복을 확인).
- **리뷰 #97 4차(2026-11-11):** 휴리스틱을 더하지 않고 뺐다 — 각주 번호(`[n]`·위 첨자) 빼기를 없앰(`arr[1]` ≠ `arr[2]`), 시작·끝 경계를 "토큰 중간 금지" 하나로(`32m²`·`(10)²`·`H₂O` 앞에서 끝나는 인용 거부), 배열 접근 판정을 코드 안이거나 이름 바로 앞이 `=`·`(`·`.`·`[`·`]`일 때로 좁힘(`Windows, Linux[1]`·`GPT-4o[1]`·`S&P500[1]`은 표시). 변이 시험 16개(각주·위 첨자 빼기 되살리기, 시작 토큰 검사 없음·옛 글자/숫자 시작 규칙, 끝 토큰 검사 없음·옛 숫자/라틴 끝 규칙, 토큰에서 수식·첨자 빼기·결합 문자 빼기, 한글 조사 예외 없음·문장 부호 예외 없음·소수점 뒤 규칙 없음, 쉼표를 식으로·하이픈/`&`를 식으로·`=`/`(` 규칙 없음·`.`/`[`/`]` 규칙 없음·연쇄 규칙 없음)를 하나씩 넣어 모두 잡았다. 앞 차례 변이 시험은 각주·위 첨자 항목을 빼고 다시 돌려 모두 잡혔다(옛 경계 항목은 이번 항목으로 대체).
- **리뷰 #97 5차(2026-11-11):** 열린 예외 "한글 끝 뒤 한글"을 닫힌 규칙 하나로 바꿨다 — 일치가 글자·숫자·결합 문자 앞에서 끝나면, 원문이 목록의 조사·서술격 조사로 이어지고 그 뒤가 토큰 경계일 때만 허용(인용 끝 글자와 무관: `32%로`·`32m²로`·`GPT-4o이며`·`Node.js입니다` 확인, `유효하지`·`사용불가`·`32%로써` 거부). 문장 부호 예외는 없앴다. 배열 접근 판정에서 점을 뺐다(`Node.js[1]`·`Python 3.12[1]`·`example.com[1]`은 표시, 줄 끝 `obj.items[1]`도 표시 — 드문 과잉 경고). 변이 시험 12개(옛 한글-한글 규칙·한글 끝에서만 조사·끝 검사 없음·문장 부호 예외 되살리기·조사 뒤 경계 없음·는/도/만 결합 없음·목록에 `하` 추가·`로`/`입니다`/`이며` 빼기, 점을 식으로·`[`를 식에서 빼기)를 하나씩 넣어 모두 잡았다(`하` 추가는 "목록 밖 음절 + 경계" 시험을 더한 뒤). 앞 차례도 다시 돌려 모두 잡혔다(바뀐 끝 규칙 항목은 이번 항목으로 대체, 소수 끝 규칙은 시험을 더해 잡음).
- **리뷰 #97 6차(2026-11-11):** 조사 목록의 회귀 두 가지 — 숫자(또는 숫자 + `.`/`,`)로 끝난 인용 뒤의 수 단위(십 백 천 만 억 조 경)는 조사로 보지 않는다(`10만 달러` 속 `10` 거부, 단어 뒤 `만`은 그대로 조사), 과거형 서술격 조사(였다·이었다·였습니다·이었습니다·였어요·이었어요·였고·이었고·였으며·이었으며·였던·이었던·였는데·이었는데)와 `인데`를 목록에 더함(`반도체였다`·`수출이었다`·`정부였습니다`·`32%였다`·`Node.js였습니다` 확인). 뒤의 토큰 경계 요구는 그대로. 변이 시험 12개 중 11개를 잡았다; `억`을 수 단위에서 빼는 변이만 살아남는데, `억`·`조`·`천` 등은 조사 목록에 없어 어차피 거부되므로 관찰할 수 있는 차이가 없는 동등 변이다(목록은 방어용으로 둔다). 앞 차례 변이 시험도 다시 돌려 모두 잡혔다.

