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

## 금융 표·차트 (#31)
`finance_chart`·`watchlist_get`(`packages/mcp-tools/src/finance.ts` `FINANCE_COMPOSED_TOOLS`, 서버 `apps/server/src/finance/chart.ts`·`apps/server/src/watchlist/`). 운영은 `docs/ops.md` §30.

- **새 송신 경로 없음:** `finance_chart`는 데이터를 기존 금융 도구(`kr_history`·`us_history`·`fx_usdkrw`·`us_financials`)의 `FinanceService.run`으로만 읽는다 — 도구마다 위 표의 자기 프록시·호스트 그대로. 부분마다 권한을 다시 본다(한국 종목 `kr-stock-skill`, 미국 `us-stock-skill`, 환율 `kr-stock-skill`). 한 호출이 처리 칸 하나(`withSlot`)를 쓴다.
- **아티팩트는 서버가 만든 데이터:** 표는 `TableData`, 차트는 `ChartSpec`(검증 후 정규 JSON)로 저장되고, 보일 때 서버가 HTML·SVG로 그린다(#27과 같은 경로, 같은 CSP — `sandbox allow-scripts`, `script-src`는 비었거나 Esc 다리 해시 하나). **차트의 기준 전환·확대는 라디오 버튼과 CSS뿐**이고 툴팁은 SVG `<title>`이다 — 새 스크립트·새 CDN·새 의존성이 없다. 그래서 스크립트가 꺼진 내보내기(#51)에서도 첫 기준·전체 기간 그림이 그대로 나온다.
- **이스케이프:** 제목·축 이름·날짜 라벨·계열 이름·기준 이름·출처·메모·단위·툴팁 글이 모두 `escapeHtml`을 거친다. 요소 id·CSS 선택자는 데이터가 아니라 순번(`cv0`, `cz1`)으로 만든다(시험: `finance-chart.test.ts` "every text of a chart is escaped").
- **표 부분:** 답변의 `table` 파트는 런타임이 보고한 결과가 아니라 **그 run이 저장한 표 아티팩트 버전**에서 서버가 만든다(`runs.ts` `syncFinanceTables` — 도구 결과는 어느 아티팩트인지만 가리키고, 그 run의 `refsOfRun`에 있어야 한다). 화면은 React 글자로만 그린다.
- **관심 종목:** 주인만(관리자도 403, 권한 행렬). `watchlist_get`은 토큰의 사용자 것만, 쓸 수 있는 시장의 것만 주고, 이름(검색에서 온 제3자 글)은 `<external_content>` 블록에 넣는다. 저장할 때 알려진 비밀을 가리고 재가림 대상이다. 종목 코드는 가릴 수 없으므로 알려진 비밀이 든 코드는 저장 전에 거절한다 — 형식이 틀린 코드와 **같은** 400 `watchlist_bad_symbol`(두 검사를 늘 함께 실행, 비밀 여부를 묻는 수단이 되지 않게). 관심 종목의 미국 티커는 의도적으로 7자 이하로 묶어(드문 8자 기호는 담지 못함) 최소 8자인 알려진 비밀이 될 수 없다. 재가림은 늘 켠 `secure_delete`, 바뀐 뒤의 `wal_checkpoint(TRUNCATE)`(기다리지 않고 재시도, 재시작해도 DB에 남긴 표시로 이어서), 시작 때 한 번의 `VACUUM`(그 전의 빈 공간)으로 WAL·DB 쪽에 옛 값을 남기지 않는다. 금융 도구의 송신 URL·헤더는 보내기 전에 알려진 비밀을 검사하고, 설정 비밀(OpenDART 키·SEC 연락처)은 제 도구·호스트·칸에서만 허용한다. 관심 종목 검색어에 비밀이 있으면 같은 길로 미끼 검색어를 보내 응답이 구별되지 않게 한다(리뷰 #111). 나중에 비밀로 등록된 행은 재가림이 `secure_delete`로 지운다(리뷰 #111).
- **합성 데이터의 경계:** `FAKE_RUNTIME=1`에서만 `fixtureFinanceWorker`가 금융 도구의 URL에 합성 시세로 답하고, 그 밖의 금융 URL은 모두 거절한다(네트워크로 나가지 않고, 합성과 실제 숫자가 섞이지 않는다). 운영 서버는 쓰지 않는다.

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
  - 종류별: html은 `text/html`(스크립트 해시, 끝에 Esc 다리 스크립트 — #28 절), svg는 `image/svg+xml`(**스크립트 허용 없음** `script-src 'none'` — 대화형은 html로), chart·표는 서버가 그린 HTML(스크립트 없음 — 앱의 프레임으로 갈 때만 Esc 다리 하나, `script-src`가 그 해시뿐, #28 절), markdown·code는 `text/plain`. document는 원본이 아직 없어 404.
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
  - 아티팩트 패널·메시지 안 카드(`artifact_ref` 부분)·목록 화면은 #28(아래 "아티팩트 패널·목록" 절), PNG·PDF 내려받기는 #51(아래 절), 공유는 #29(자원 로더의 `sharedWith`), 공유받은 목록은 #52.

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

## 아티팩트 패널·목록 (#28)
대화 옆 패널에서 아티팩트를 보고 버전을 고르고(PRD FR-6.1·6.2), 내 아티팩트를 한곳에서 다시 연다(FR-6.6). 격리는 #27 그대로다 — 패널은 **같은 보기 코드**를 쓴다. 코드: 화면 `apps/web/src/artifacts/viewer.tsx`(iframe·버전·내려받기, `/a/:id`와 패널이 같이 씀)·`ArtifactPanel.tsx`(패널·카드)·`pages/ArtifactsPage.tsx`(목록), 서버 `artifacts/store.ts`(`listByUser`·`refsOfRun`)·`routes.ts`, 카드 부착은 `runtime/runs.ts` `syncArtifactRefs`.

- **iframe은 한 곳에서만 정의한다:** `ArtifactBody`(viewer.tsx)의 `<iframe sandbox={ARTIFACT_SANDBOX}>`, `ARTIFACT_SANDBOX = "allow-scripts"`(`allow-same-origin` 없음). 버전마다 새 iframe(`key`)이라 한 버전의 문서가 다음 버전으로 이어지지 않는다. 원본은 여전히 `/a/:id/v/:ver/raw`(정책 A·B 두 CSP, #27)에서만 온다 — 패널이 본문을 받아 `srcdoc`로 넣는 일은 없다.
- **카드(`artifact_ref`)는 서버가 저장된 버전에서 만든다:** 런타임이 보낸 도구 결과(`artifactId` 등)는 믿지 않는다. 도구 호출이 끝날 때마다(`tool_end`)와 run이 끝날 때(복구 포함) `refsOfRun(대화, run)` — 그 대화의 아티팩트 중 **이 run의 토큰으로 쓰인 버전**(`artifact_versions.run_id`)만, 아티팩트마다 가장 새 버전 — 을 읽어 답변 부분에 넣고 `part_update`로 흘린다. 같은 아티팩트를 한 run이 여러 번 고치면 카드 하나가 새 버전으로 바뀐다. 그래서 런타임이 가짜 도구 결과를 지어내도 카드는 생기지 않고, 남의 대화·다른 run의 버전도 붙지 않는다(시험). 카드가 아티팩트를 불러올 때도 `GET /api/artifacts/:id`(주인만)를 거친다.
- **패널 상태는 주소에:** `/c/<대화>?artifact=<id>&v=<버전>`. 패널은 채팅 화면에서만 열린다(`/c/:id`). 버전을 고르면 `v`만 바뀌고(기록 대체), 되돌리기·최신을 고르면 `v`가 빠져 최신을 따라간다. 주소의 id는 그냥 입력값이다 — 권한은 서버 경로가 정한다(남의 id → 403 → "권한이 없어요", iframe 없음, e2e).
- **휴대폰:** 900px 이하에서 패널은 `position: fixed; inset: 0`인 `role="dialog" aria-modal`이고 그동안 `<main>`은 `inert`다. 열면 패널 제목으로 초점이 간다. Esc·✕로 닫는다.
- **저절로 열기(리뷰 #104 1차, FR-6.1 "바로 보인다"):** **이 탭에서 시작한 run**(보내기·고치기·다시 생성·새 대화 — 메모리의 집합, 새로 고치면 비어 있다)이 흐르는 동안 처음 이름을 대는 아티팩트를 패널에 연다(`v` 없음 = 최신을 따라감). 주소는 **대체**(기록을 늘리지 않음, e2e가 `history.length`로 확인). 사용자가 카드로 다른 아티팩트를 열어 둔 상태면 바꾸지 않는다 — 바꿔도 되는 것은 비어 있는 패널이나 답변이 스스로 연 패널뿐이다. 다른 곳에서 시작했거나 다시 불러온 run의 부분(스트림 재생)으로는 열지 않는다(e2e: API로 시작한 `/artifact-slow`를 흐르는 중에 열어도 카드만 있고 패널 없음). 어느 아티팩트를 이미 다뤘는지(열었든 사용자가 닫았든)는 run마다 **탭 전체**에 둔다(리뷰 2차): 흐르는 중에 패널을 닫고 다른 화면에 갔다 돌아와 스트림이 재생되어도 다시 열지 않는다(e2e). 옆 열로 열 때는 입력창의 초점을 빼앗지 않고, 휴대폰(대화 상자)일 때는 패널로 옮긴다.
- **초점 되돌리기:** 마지막으로 연 것(누른 카드, 저절로 열렸으면 그때 초점이 있던 곳)을 기억해 **실제로 닫을 때만**(✕·Esc) 패널이 사라진 뒤 그리로 돌려준다(그래야 휴대폰에서 `inert`가 풀린 뒤다). 다른 화면으로 가서 사라질 때는 건드리지 않는다.
- **iframe 안에서 Esc(리뷰 #104 1차):** 프레임 안의 키 입력은 부모로 오지 않는다. 샌드박스는 그대로 두고 **메시지 하나**로 잇는다. 앱의 프레임에 보내는 `/raw`의 **HTML 문서**에만 서버가 끝에 인라인 스크립트 `ESCAPE_BRIDGE`(`serve.ts`)를 붙인다 — Esc(그리고 문서가 `preventDefault`하지 않았을 때)에 `parent.postMessage({type:"agentlee:escape"},"*")`만 한다(`"*"`는 받는 쪽 출처를 고정하지 않는다는 뜻이고 — 불투명 출처라 부모 출처를 적을 수 없다 — 방송이 아니다: 직접 부모 창 하나로만 간다).
  - **html:** 다른 인라인 스크립트처럼 해시가 정책 A에 들어가고 정책 B는 그대로다(`'unsafe-inline'` + CDN). doctype 앞이 아니라 **문서 끝**에 붙여 quirks 모드가 되지 않는다. **최선 노력이다(리뷰 2차):** 작성자 문서가 닫히지 않은 주석(`<!--`)·`<textarea>`·`<script>` 등으로 끝나면 다리가 그 안의 글자가 되어 돌지 않고, 문서에 인라인 스크립트가 256개를 넘으면 다리의 해시가 빠져 막힌다. 그런 문서에서는 프레임 안을 누른 뒤 Esc가 듣지 않는다 — ✕는 언제나 Tab으로 닿는다. 어느 경우에도 허용되는 것이 늘지는 않는다(해시는 문서에 실제로 있는 글자만 덮는다).
  - **차트·표(선택지 A, 리뷰 2차):** 서버가 그린 HTML 페이지라 같은 다리를 붙이고, 그 페이지의 `script-src`는 `'none'` 대신 **다리의 해시 하나**(`ESCAPE_BRIDGE_HASH`)다. 페이지 안 글자는 모두 서버가 이스케이프하므로 다리가 언제나 돈다. `?format=html` 내려받기와 PDF 렌더러 문서는 그대로 스크립트가 없다(시험).
  - **svg·마크다운·코드(선택지 B):** `image/svg+xml`·`text/plain`으로 서빙한다 — HTML로 감싸려면 원본 경로의 형식(최상위로 열기, 내려받기와 같은 바이트)을 바꿔야 해서 하지 않았다. 이 프레임을 누른 뒤에는 Esc가 부모에 닿지 않는다. 대신 Tab으로 프레임을 나와 ✕(키보드로 닿음)로 닫는다. 알려진 제약으로 둔다.
  - 내려받기·PNG/PDF 내보내기 문서에는 다리가 없다. 앱은 **지금 보이는 패널 iframe의 `contentWindow`에서 온, 키가 `type` 하나뿐인 `{type: ARTIFACT_ESCAPE_MESSAGE}`**만 받고, 할 수 있는 일은 패널 닫기뿐이다(앱 페이지 자신이 보낸 같은 메시지, 키가 더 있는 것, 다른 type은 무시 — e2e). 문서 스크립트는 원래 `postMessage`를 쓸 수 있으므로 새 능력이 생기지 않는다: 문서가 자기 패널을 닫을 수 있게 될 뿐이다.
- **목록 `GET /api/artifacts`(로그인한 본인만, `noResource` — id가 없어 남의 것을 가리킬 수 없다):** `artifacts.user_id = 나` **그리고** 그 대화의 주인 = 나. 최근에 바뀐 것부터 `(updatedAt, id)` 키셋 페이지(커서는 `<숫자>:<id>` 형식만, 아니면 400). 본문은 싣지 않는다(시험). 읽을 때 알려진 비밀은 지운다(#78, 대화 제목 포함). `user_id` 인덱스는 없다 — 가족 규모(대화당 200개 한도)에서 전체 훑기로 충분하고, 마이그레이션을 피했다. 커지면 `(user_id, updated_at)` 인덱스를 더한다.
- **HTML 내려받기 `?format=html`:** 차트·표만(원본이 HTML이 아닌 종류). 본문은 원본 서빙과 같은 서버가 그린 페이지(스크립트 없음), 헤더는 내려받기와 같다(`attachment`, 샌드박스 CSP, `nosniff`, `no-store`). 다른 종류·다른 형식 값은 404. 같은 경로라 권한 행렬의 내려받기 행이 그대로 덮는다.
- **권한 행렬:** 새 자원 경로는 없다(`GET /api/artifacts`는 id가 없는 본인 목록 — `conversations` 목록과 같은 방식). 본인만 보는지는 `artifacts.test.ts`가 가족 네 계정(주인·공유·관리자·남)과 비로그인으로 확인한다.
- **시험:**
  - 단위·통합(`apps/server/test/artifacts.test.ts` "artifact panel, cards and list (#28)"): 도구가 저장한 뒤 `tool_end` 전에 중지한 답변과 재시작 복구된 답변에도 카드(소켓 없음), Esc 다리(HTML 원본에만, 문서 끝, 정책 A 해시, 내려받기·SVG에는 없음), 실제 MCP 경로의 run이 만든 카드(도구 결과 바로 뒤, `part_update`로 흐름), 수정 → v2 카드, 같은 내용·실패한 호출 → 카드 없음, 다른 대화의 run 버전이 안 붙음, `refsOfRun` 순서·범위, 목록의 본인 한정·정렬·페이지·잘못된 커서 400, HTML 내려받기 헤더·종류·형식·권한.
  - Playwright(`e2e/artifact-panel.spec.ts`, 데스크톱·모바일): 대화에서 `/artifact` → v1 카드 → 패널(데스크톱은 세 번째 열·HTML 파일 내려받기, 휴대폰은 화면 전체·`main` inert) → `/artifact-update` → v2 카드·패널이 v2로 → v1 선택 시 v1 본문 → 되돌리기 → v3(v1 복원)·v1 본문, v1 카드는 v1을 염, 주소로 다시 열기. 목록: 두 대화의 아티팩트가 최근 순, 누르면 그 대화의 패널, 공유받은 것 빈 화면, 아들은 목록에 없고 엄마의 id로 패널을 열면 권한 없음·iframe 없음.
- **리뷰 #104 1차 뒤 변이 시험:** 저절로 열기 끔, 사용자가 연 패널을 새 아티팩트가 빼앗음, 이 탭이 시작하지 않은 run(재생)에도 엶, 주소를 대체하지 않고 쌓음, 다리 스크립트를 붙이지 않음(단위·e2e), 다리의 출처 검사 제거, 모양 검사 제거, 카드가 연 사람을 기억하지 않음(첫 opener로 돌아감), run 끝의 카드 동기화 제거(중지·재시작 복구 단위 시험). 모두 시험이 잡았다(2026-11-12).
- **리뷰 #104 2차 뒤 변이 시험:** 차트·표 페이지에 다리를 붙이지 않음(단위·e2e — 표 프레임 안 Esc), 다룬 아티팩트 기억을 화면마다 새로(e2e — 닫고 나갔다 돌아오기), run 끝의 카드 동기화 제거(`runTools` 없이 도는 중지·복구 시험이 여전히 잡음). 모두 시험이 잡았다.
- **변이 시험(2026-11-12):** 하나씩 망가뜨리면 시험이 실패함을 확인했다. 목록의 본인 조건 제거(단위), `GET /api/artifacts/:id`를 `noResource`로(권한 행렬·e2e — 아들의 패널에 iframe이 생김), iframe에 `allow-same-origin` 추가(e2e 10개), 버전 선택과 상관없이 최신 원본을 보여 줌(e2e), 되돌리기가 새 버전을 만들지 않음(단위·e2e), 패널이 휴대폰에서도 전체 화면이 아님(`fullScreen={false}`, e2e), 전체 화면 CSS의 `position: fixed` 제거(e2e), `tool_end`에서 카드 부착 안 함(단위), 카드 부착을 아예 안 함(단위).

## 인용 검증 (#25)
`cite`·`sources_list`는 프로세스를 띄우지 않는 서버 도구다(`apps/server/src/citations/`, 도구 정의 `packages/mcp-tools/src/web.ts`). 네트워크에 나가지 않는다 — #50이 저장한 본문만 읽는다. 운영은 `docs/ops.md` §22.

- **범위는 토큰에서만:** 사용자·대화·실행은 실행 토큰(`McpTokens`)의 것이다. 입력은 `{sourceId, snippet}`뿐이고 엄격 스키마라 다른 필드는 거부된다. 출처는 **토큰의 대화**에서만 찾고(`sources.conversation_id`), 그 행의 사용자가 토큰의 사용자이고 대화의 주인도 토큰의 사용자여야 한다(주인이 아니면 `cite_not_allowed`로 아무것도 저장하지 않음). 아니면 `unknown_source`이며, 그 id는 `citations`에 남기지 않고 결과·메모에 제목·URL·구절을 싣지 않는다 — 다른 대화·다른 사용자의 출처가 있는지조차 드러나지 않는다(없는 id와 같은 답).
- **검증은 서버 기록으로:** 실행 끝의 `citation_note`는 런타임이 보고한 도구 결과가 아니라 서버의 `citations` 행으로 만든다. 런타임이 "verified"라고 적은 가짜 결과를 내도 메모에는 반영되지 않고, 어떤 `cite`도 만들지 않은 `[n]`은 `unknown_source`다.
- **일치 규칙:** 정규화(NFC, 전각 ASCII·`…`·물결·분수 빗금 접기, 따옴표·대시 문장 부호 통일, 보이지 않는 문자 제거, 공백 묶음, HTML 개체 — NFKC·대소문자 접기·하이픈 잇기·각주 빼기 없음, 숫자 뒤 따옴표는 단위로 그대로) 뒤 구절 전체가 그대로 있어야 한다. 유사도·일부 일치·조각 잇기는 없다. 일치는 공백·문장 부호·괄호·따옴표·글 처음/끝에서만 시작·끝나고, 끝에서는 닫힌 조사 목록을 허용한다. **숫자 가장자리**(처음·마지막 두 토큰에 숫자)는 절 경계여야 한다(리뷰 #97 22차 — 아래). 8자 미만은 증거가 못 된다.
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
- **리뷰 #97 7차(2026-11-11):** 한글 수사로 끝나는 인용도 수로 본다(끝의 수사 묶음 일 이 삼 사 오 육 칠 팔 구 십 백 천 만 억 조 영 공이 낱말 첫머리일 때만 — `수출이`는 아님) → `천만`·`십만`·`삼만` 앞에서 끝나는 인용 거부. 숫자 뒤 `만`('오직')은 수 단위와 구분할 수 없어 늘 거부하는 것을 받아들인 한계로 문서화하고 시험으로 고정했다(`Python 3.12만`·`HTTP/2만`·`포트 443만`). 변이 시험 5개(한글 수사 판정 없음·낱말 첫머리 확인 없음·`천`/`삼` 빼기·끝 한 글자만 보기)를 하나씩 넣어 모두 잡았다. 첫 구현의 "인용 전체가 수사일 때 원문 앞 글자 확인"은 시작 경계 규칙이 이미 보장해 관찰할 수 없는 동등 변이였으므로 그 매개변수를 없앴다. `억` 빼기 변이는 6차와 같은 이유로 동등하다.
- **리뷰 #97 8차(2026-11-11):** 근본 원인을 없앴다 — 조사 목록에서 수 단위이기도 한 것은 `만`뿐이었고, 6·7차의 수 단위·한글 수사 규칙은 모두 그것을 우회하려던 것이었다. `만`과 `+만` 결합을 목록에서 빼고 수 단위 규칙·한글 수사 판정을 지웠다. 이제 인용은 '만' 바로 앞에서 끝날 수 없고('만'까지 포함하면 확인), 어느 수 단위도 조사가 아니므로 `10`·`천`·`수천`·`이십`을 단위 앞에서 자른 인용은 닫힌 조사 규칙만으로 거부된다. `전기 공사`·`일`·`이사`가 `만` 앞에서 거부되는 것은 받아들인 한계다. 변이 시험: `만`을 목록에 되돌리기·`+만` 결합 되돌리기·`+는`/`+도` 결합 각각 빼기·`+는/도` 결합 전체 빼기·`하` 추가 — 모두 잡혔다(`+만` 결합은 "미국 + 까지만" 시험을 더한 뒤). 6·7차 변이 항목은 지운 코드를 겨눈 것이라 없앴다.
- **리뷰 #97 9차(2026-11-11):** "일치가 수를 반으로 자른다"를 수 이어짐 규칙 하나로 막았다(시작·끝): 경계를 사이에 둔 `숫자 구분자 숫자`(`.` `,` `/` `:` `-` `~`)를 거부 — 기존 소수·천 단위 규칙을 여기에 합치고 부호(`-32%`)는 그대로 둔다. 한글 수사는 십 백 천 만 억 조로 끝난 일치 뒤 일~구(`백이 명`, `십이 도`)를 거부, 앞쪽 대칭은 시작 토큰 규칙이 이미 막으므로 코드를 더하지 않았다(시험으로 고정). `공백이`처럼 백·천·조로 끝나는 낱말 뒤 조사 `이`의 과잉 거부는 받아들인 한계. 변이 시험 13개(끝 구분자 규칙 없음·구분자 뒤 숫자 확인 없음·시작 구분자 규칙 없음·구분자 앞 숫자 확인 없음·부호 규칙 없음, 구분자에서 `/` `:` `~` `.` `-` 각각 빼기, 한글 수사 규칙 없음·`백` 빼기·`이` 빼기)를 하나씩 넣어 모두 잡았다("구분자 앞 숫자 확인 없음"은 `결과:3명` 시험을 더한 뒤).
- **리뷰 #97 10차(2026-11-11):** 대소문자 접기를 없앴다(검증과 중복 키 모두) — `500MW`/`500mW`, `100Mbps`/`100MBps`, `CO`/`Co`가 같아지던 잘못된 "확인"을 막는다. `Exports`/`exports` 차이는 이제 "찾지 못함"(⚠️), 받아들인 한계. 변이 시험 3개(글자 묶음 소문자화 되살리기·ASCII 빠른 경로 소문자화 되살리기·중복 키만 소문자화)를 하나씩 넣어 모두 잡았다. 처음 변이 시험의 "소문자 접기 제거" 항목은 이제 코드가 없어 뺐다.
- **리뷰 #97 11차(2026-11-11):** 따옴표 접기 목록에서 프라임(`′` `″`)을 뺐고, 목록을 다시 보아 순수한 따옴표·대시 문장 부호가 아닌 것(백틱 `` ` ``, 양음 부호 `´`, 빼기 부호 `−`)도 뺐다 — `12′`/`12″`, `30′`/`30″`, `f′`/`f″`가 같아지던 잘못된 "확인"과 중복 키 공유를 막는다. 물결 `∼`(U+223C)·`〜`(U+301C)를 `~`로 접고, 수 이어짐 규칙에서 분수·비율·범위 표시(`/` `:` `-` `−` `~`)는 앞뒤 공백을 허용(`10 ~ 20`, `1 / 2`), `.` `,`는 붙어 있을 때만. 빼기 부호는 부호·범위 표시로 따로 넣었다. 변이 시험 13개(프라임·`´`·백틱 다시 접기, 빼기 부호 다시 접기, 물결 접기 없음·`〜` 빼기, 끝·시작의 공백 허용 없음, `.` `,`에도 공백 허용(끝·시작), 빼기 부호를 구분자에서 빼기(끝·시작)·부호에서 빼기)를 모두 잡았고, 9차 구분자 변이도 새 식에 맞춰 다시 겨눠 모두 잡혔다(시작 쪽 `-` 빼기는 `10 - 20` 시험을 더한 뒤).
- **리뷰 #97 12차(2026-11-11):** 숫자 바로 뒤 따옴표는 단위(피트·인치·분·초)라 원문·인용 모두 접지 않는다 — ASCII 빠른 경로, 글자 묶음, HTML 개체 세 곳(`12'`/`12"`, `30’`/`30”`, 중복 키 분리). 그 결과 따옴표로 묶은 수의 닫는 따옴표는 같은 모양이어야 한다(ops §22 한계 (d)). 부호 규칙은 공백 너머도 본다(`- 5%`, `− 5도`, `- 5 ~ 5도`, HTML `<span>-</span>5%`). 시작 쪽 `-`·`−`는 이제 부호 규칙이 숫자 앞 여부와 상관없이 막으므로 범위 규칙의 시작 식에서 뺐다(11차 "시작 쪽 빼기 부호" 변이가 동등해진 것으로 확인). 변이 시험 8개(세 곳 각각 다시 접기, 공백 너머 없음, `−`·`+`·`-` 각각 빼기, 부호 규칙 없음)를 모두 잡았다(HTML 개체 쪽은 `12&rdquo;` 시험을 더한 뒤). 이번에 origin/dev 31715be(#99 백업·복원 §21) 위로 다시 쌓으며 인용 절을 §22로 옮겼다.
- **리뷰 #97 13차(2026-11-11):** 단위 따옴표 두 가지 — (1) 인용을 정규화할 때 양끝 따옴표를 빼던 것이 숫자 뒤 단위 `"`까지 지워 `…12"`가 `…12'`에 맞던 것: 숫자 옆 따옴표는 반대쪽 끝에 짝이 있을 때만 빼고(감싼 따옴표), 수가 단위 따옴표 앞에서 끝나는 일치도 거부한다(그래서 짝으로 뺀 `"…12"`도 `12'` 앞에서 끝나지 못한다). (2) 단위 판정을 "숫자 + 공백* + 따옴표"로 넓혔다(HTML `<span>12</span>'` → `12 '`), 세 곳 모두와 중복 키에 같은 함수. 변이 시험 7개(공백 불허·옛 양끝 제거·짝 규칙 없음·숫자 뒤 닫는 따옴표 제거·숫자 앞 여는 따옴표 제거·단위 따옴표 앞 끝 규칙 없음·그 규칙의 공백 불허)를 모두 잡았다(여는 따옴표 항목은 중복 키 시험을 더한 뒤). 12차 변이도 다시 돌려 모두 잡혔다.
- **리뷰 #97 14차(2026-11-11):** (1) 통화 기호 바로 뒤 숫자로 시작하는 일치에도 부호·수 이어짐 시작 규칙을 적용(`-$100 million`의 `$100…`, `- $5 million`, HTML로 갈라진 `-↵$5`). (2) 숫자로 끝나는 일치는 공백 너머 배수 앞에서도 끝나지 않는다 — 닫힌 목록(한글 수 단위, `thousand` `million` `billion` `trillion`, 낱말 하나인 `K` `M` `B` `bn` `mn`, 대소문자 그대로): HTML `<strong>10</strong>만` → `10 만`. (3) 13차의 회귀(따옴표째 보낸 `“…100”` 거부)를 고쳤다 — 짝 따옴표로 감싼 인용은 먼저 따옴표째로 찾고, 없을 때만 뺀 꼴(단위 끝 규칙 적용)로 찾는다. P3: 숫자와 단위 따옴표 사이의 보이지 않는 문자를 건너뛴다. 변이 시험 13개(통화 시작 없음·숫자 없는 통화도 시작·`₩` 빼기, 배수 규칙 없음·공백 불허·한글 단위/영어 낱말/약자 각각 빼기·약자 낱말 끝 확인 없음·대소문자 무시, 따옴표째 대조 없음·뺀 꼴로 되돌아가기 없음, 보이지 않는 문자 건너뛰기 없음)를 모두 잡았다("숫자 없는 통화" 항목은 `-€ 기호` 시험을 더한 뒤). 12·13차 변이도 다시 겨눠 모두 잡혔다.
- **리뷰 #97 15차(2026-11-11):** (1) 시작 쪽 특례를 거슬러 걷기 하나로 바꿨다 — 숫자나 (뒤에 숫자가 오는) 통화 기호로 시작하는 일치는 공백·통화 기호를 건너뛴 뒤 부호나 `숫자 + 범위·분수 표시`가 있으면 거부, `.` `,`는 바로 붙었을 때만(`-$100`·`-$ 100`·`- $100`·`-€5`, 통화 기호를 뺀 `100 million…`도). (2) 공백 너머 한글 배수는 낱말 전체가 수 단위(+`원`, +목록 조사)일 때만 — `조식`·`조기`·`경로에`·`백화점` 앞 가격 인용이 다시 확인되고, `1 억원입니다`·`10 만`은 여전히 거부. 붙은 수 단위는 끝 토큰 규칙이 이미 막으므로 영어 배수 식에서 뺐다(변이가 살아남아 중복 확인). (3) 중복 키는 확인된 항목에만 쓴다 — 앞의 같은 구절이 확인되지 않았으면 다시 대조하고, 확인되면 같은 번호를 유지한 채 그 항목을 확인으로 바꾼다(답변의 `[n]`이 그대로 맞도록; 실패한 재시도는 항목을 바꾸지 않음). 변이 시험 18개를 넣어 17개를 잡았다 — 거슬러 걷기의 통화·공백·전체, 부호, 범위 표시의 숫자 확인·공백, 소수 표시의 붙음·전체, 통화 시작의 숫자·공백, 공백 너머 한글 배수의 옛 첫 글자 규칙·`원`·조사·경계·전체, 옛 중복 규칙, 재검증 갱신 없음. 남은 하나("트랜잭션 안의 재확인이 확인 항목을 깎아내림")는 확인 항목이 트랜잭션 전에 이미 돌아가므로 닿을 수 없는 동등 변이다. 12·14차 부호·배수 변이도 다시 겨눠 모두 잡혔다.
- **리뷰 #97 16차(2026-11-11):** 15차의 "낱말 전체가 수 단위" 규칙이 `1 억원대`·`10 만원대로`·`1 만여 명`·`3 만명으로`를 놓쳤다 — 일반 낱말과 수량 표현을 가르려는 쳇바퀴라 판단해(코디네이터 결정) 14차의 첫 글자 규칙으로 되돌렸다: 숫자로 끝난 일치 뒤(공백 허용) 낱말이 십 백 천 만 억 조 경으로 시작하면 거부. `조식`·`경로`·`백화점` 같은 일반 낱말 앞 가격의 과잉 거부는 받아들인 한계 (e)(그 낱말까지 인용하면 확인). 범위 표시 뒤 통화 기호 반복(`$100-$200`, `€100 ~ €200`, `$10–$20`)도 수 이어짐으로 본다. 변이 시험 9개(한글 배수 규칙 없음·공백 불허·15차 낱말 전체 규칙·`만`/`조` 빼기, 반복 통화 없음·통화 뒤 공백 불허·`€` 빼기·숫자 없는 통화도 범위)를 모두 잡았다.
- **리뷰 #97 17차(2026-11-12):** 단위가 붙은 범위(`3%~5%`, `10만원~20만원`, `10°C~20°C`, `3% ~ 5%`)를 한쪽에서 자르던 것을 토큰 기준 규칙 하나로 막았다 — 끝: 일치의 마지막 토큰에 숫자가 있고 원문이 `[공백] 범위 표시 [공백] [통화] [공백] 숫자`로 이어지면 거부. 시작: 첫 토큰에 숫자가 있으면 공백·통화 기호를 거슬러 건너뛰고, 범위 표시(`~` `/` `:`, `-` `−`) 앞(공백 허용) 토큰에 숫자가 있으면 거부. 숫자 끝·시작에만 보던 범위 검사를 대신하며, 부호 거슬러 걷기와 `.` `,` 붙음 규칙은 수로 시작하는 일치에만 그대로 둔다. 변이 시험 14개(끝: 옛 숫자 끝 규칙·규칙 없음·끝 토큰 대신 전체·뒤 숫자 확인 없음·공백 불허·`~` 빼기; 시작: 첫 토큰 확인 없음·앞 토큰 숫자 확인 없음·앞 토큰을 한 글자로·전체로·표시 앞 공백 불허; 부호·소수 표시를 수 아닌 시작에도; 끝 소수 규칙 없음)를 모두 잡았다(전체/부호/소수 항목은 가장자리 토큰 시험을 더한 뒤). 15차 거슬러 걷기 변이도 다시 겨눠 모두 잡혔다.
- **리뷰 #97 18차(2026-11-12):** 띄어 쓴 단위(`10만 원~20만 원`, `1억 원 ~ 2억 원`, `$10 million ~ $20 million`)와 뒤 값의 부호(`-10~-5`, `-5%~+5%`)가 17차 토큰 규칙을 비껴갔다 — 창을 3토큰으로 넓혔다: 끝은 마지막 3토큰에 숫자 + `[공백] 범위 표시 [공백] [부호] [통화] [공백] 숫자`, 시작은 첫 3토큰에 숫자 + (공백·통화를 건너뛴) 범위 표시나 부호 + 그 앞 3토큰 안의 숫자. 시작 쪽의 뒤 값 부호는 부호도 표시로 세므로 따로 단계를 두지 않았다(처음 넣은 단계의 변이가 동등해 없앰). 과잉 거부는 받아들인 한계 (f)(`3% 증가 - 5% 감소`). 변이 시험 10개(창 1·2·4·무한, 끝 창 1, 시작 창 1, 표시 앞 창 1, 끝 뒤 값 부호 없음, 부호를 표시로 세지 않음, 표시 앞 공백 건너뛰기 없음)를 모두 잡았고(창 2·4와 표시 앞 공백은 창 경계 시험을 더한 뒤), 17차 변이도 다시 겨눠 모두 잡혔다.
- **리뷰 #97 19차(2026-11-12):** 과학적 표기·거듭제곱을 한 수로 본다 — `×` `*` `^` `·`(U+00B7)를 수 이어짐·범위 규칙의 표시(시작·끝, 공백 허용, 3토큰 창)에 더했다(`3×10⁸`, `3 × 10⁸`, `3*10^8`, `10^9`). 숫자 바로 뒤 위 첨자(`10⁸`)는 위 첨자가 `\p{N}`이라 끝 토큰 규칙이 이미 막고, `1e9`·`1E9`·`1.5e-3`은 `e`가 글자라 토큰 규칙이, 지수의 부호는 범위·부호 규칙이 이미 막는다(시험으로 고정, 코드 추가 없음). 대조: 표기 전체와 `3 × 4 = 12` 전체는 확인. 변이 시험 9개(끝·시작에서 `×` `*` `^` `·` 각각 빼기, 위 첨자를 토큰에서 빼기)를 모두 잡았다(시작 쪽 `^`·`·`는 시작 쪽 시험을 더한 뒤).
- **리뷰 #97 20차(2026-11-12):** 특례 대신 일반 규칙 둘 — (1) 단위·통화 기호(`%` `‰` `‱` `°` `℃` `℉` `′` `″`, 통화)는 수 옆에서 토큰 글자: 수로 끝난 일치는 그 기호 앞에서, 수로 시작하는 일치는 그 기호 뒤에서 끊기지 않는다(`3%`의 `3`, `$100`의 `100 million…` — 15차 대조 하나를 거부로 뒤집음). (2) 인접 수 토큰: 일치의 가장자리 토큰에 숫자가 있고 공백 너머 이웃 토큰에도 숫자가 있으면 거부(`1억 2,000만원`, `1 1/2컵`, `오후 3시 30분`) — 받아들인 한계 (g)(`2024년 3월` 같은 별개의 수도). 앞 토큰이 쉼표·마침표·쌍점 등으로 끝나면 떨어진 것으로 본다(`3, 4명`, `3. 4였다고`가 그대로 확인되도록 — 끝 쪽도 같음). 픽스처 본문 `10일 10월`은 (g)에 걸리므로 `10일 발표에서 10월`로 바꿨다(시나리오 인용은 그대로). P3: 분수 빗금 `⁄`를 `/`로 접는다. 변이 시험 15개(끝·시작 단위 기호 규칙 없음, `%` `℃` `‰` `$` 각각 빼기, 끝·시작 인접 토큰 규칙 없음, 문장 부호 떼기 없음(시작·끝), 한 자리 토큰 놓침, 가장자리 대신 전체(끝·시작), 이웃 토큰 숫자 확인 없음, 빗금 접기 없음)를 모두 잡았다(시작 쪽 전체 항목은 깊은 수 시험을 더한 뒤).
- **리뷰 #97 21차(2026-11-12):** 같은 규칙 묶음을 좁게 넓혔다 — (1) `/` 복합 단위: 숫자가 든 마지막 토큰 바로 뒤 `/` + 글자면 거부(`100km/h`, `3,000원/시간`, `15km/L`), 시작 쪽은 숫자가 든 토큰 + `/` 바로 뒤에서 글자로 시작하는 일치를 거부(`/h…`는 시작 토큰 규칙이 이미 막음). (2) 단위 기호는 공백 하나 너머도(`3 %`). (3) 인접 수 토큰을 2단계로: 이웃이 숫자 없는 낱말 하나(문장 부호로 끝나지 않음) 다음 숫자 든 낱말이어도, 또는 일치 안의 마지막 두 토큰이 `수 + 낱말`이고 다음이 수여도 거부 — 시작 쪽도 대칭(`2 hours 30 minutes`의 어느 쪽 절단도). 한계 (g)를 "사이 낱말 하나 포함"으로 넓혔고, 그 때문에 픽스처 본문(`10일 발표에서 10월` → `10일 낸 자료에서 10월`)과 몇 시험 인용(`32% 늘어난` 앞 끊기)을 (g)에 걸리지 않게 바꿨다. (4) 퍼센트포인트: `%`로 끝난 뒤 닫힌 목록 낱말이면 거부. 변이 시험 17개(복합 단위 끝·끝의 글자 확인·시작·시작의 숫자 토큰 확인, 공백 둔 단위 기호·`%`·`℃` 빼기, 2단계 앞·뒤·일치 안 끝·일치 안 시작, 2단계 문장 부호 무시·낱말 둘 허용, 퍼센트포인트 규칙 없음·`포인트` 빼기·경계 없음·아무 수 뒤에도)를 모두 잡았다(대조 시험을 더한 뒤 넷). 이번에 origin/dev e6cd7bf(#100, 충돌 없음) 위로 다시 쌓았다.
- **리뷰 #97 22차(2026-11-12):** 10여 차례 숫자 경계 변형(단위·배수·범위·`/`·퍼센트포인트·과학적 표기·인접 수 토큰, 22차의 `100 km/h`·`0.25% 포인트씩`·`2시간 반`)을 쫓은 끝에(코디네이터 결정) 숫자 가장자리 규칙 하나로 바꿨다 — 처음 두 토큰에 숫자가 있으면 절의 처음에서 시작해야 하고(부호 거슬러 걷기는 줄바꿈·통화 기호 너머로 유지), 마지막 두 토큰에 숫자가 있으면 절의 끝에서 끝나야 한다. 숫자 사이 부호(`3.5`, `1,234`, `3 : 1`)와 숫자 뒤 따옴표는 절 경계가 아니다. 그에 따라 숫자 전용 규칙(단위 기호, 배수, 범위·분수, `/` 복합 단위, 퍼센트포인트, 인접 수 토큰)을 지웠고, 기호에 붙은 시작·끝을 일반 토큰 경계로 막는다. 받아들인 한계는 (b)–(d)와 새 (h)("숫자가 든 인용은 그 숫자가 속한 절을 통째로")로 줄였다. 지침 `common@3`에 "숫자가 든 구절은 절째로 인용" 규칙을 더했다. 6–22차 Codex 숫자 사례를 표 하나로 모아 모두 거부, 절 전체 대조는 확인. 변이 시험 27개를 넣어 처음 23개를 잡았고, 살아남은 넷(부호·통화 시작을 숫자 가장자리로 따로 셈 — 뒤 숫자가 처음 두 토큰에 들어 있어 동등, 일치 자신의 여는 부호 — 따옴표를 뺀 꼴로 다시 찾으므로 동등)은 코드에서 빼고, 공백 뒤 닫는 부호 항목은 시험을 더해 잡았다. 앞 차례의 비숫자 변이(조사 목록 `로`·`이며`, 물결 `〜`, 부호 `−`·`+`, 최소 길이, 유사 일치, `…` 조각)도 다시 겨눠 모두 잡혔다. 픽스처 첫 인용은 문장 전체로 바꿨다.
- **리뷰 #97 23차(2026-11-12):** 22차 사례는 모두 닫혔다는 확인. 숫자 속 부호를 넓혔다 — 숫자 바로 앞 `.`(앞 0 없는 소수 `.5%`), 양쪽에 숫자가 있는 `.`·`,`(공백 허용 — HTML 추출로 생긴 `1, 234 억`·`1. 5 mg`과 날짜 `2026. 11. 12.`)는 절 경계가 아니다. 대가로 `3, 4명` 같은 공백 둔 쉼표 사이에서는 끊지 못한다(앞 시험 7개를 거부로 바꿈). `citations.snippet_key`는 정규화 구절의 SHA-256(`sha256:` 접두)으로 저장한다 — 정규화가 전각을 접어 저장된 구절에 없던 알려진 비밀 평문을 키에 만들고 재가림도 놓쳤기 때문. 해시 전 행은 시작 때 한 번 변환. 변이 시험: 소수점 규칙·공백 쉼표·공백 점·둘 다·평문 키·시작 변환·재가림 재계산·접두 빼기 8개 모두 잡힘.
- **리뷰 #97 24차(2026-11-12):** 시작 때 키 변환이 `sha256:` 접두(LIKE라 대소문자 무시)로 시작하는 키를 건너뛰어, 정규화 결과가 그 접두로 시작하는 옛 평문 키에 비밀이 남았다(P1). 접두 검사를 빼고 모든 행의 키를 구절에서 다시 계산해 다른 것만 바꾼다(재가림과 같은 방식). 변이 시험 3개(접두 필터 복원, 대소문자 구분 접두 필터, 갱신 빼기) 모두 잡힘. 공백 둔 앞 0 없는 소수(`. 5%`, HTML `<span>.</span>5%`)는 고치지 않고 한계 (i)로 받아들였다(코디네이터 결정) — `. <숫자>`를 경계에서 빼면 `…했다. 3명이…` 같은 흔한 새 문장 인용이 거부된다. 그 대조를 시험으로 고정.
- **리뷰 #97 25차(2026-11-12):** 경계·부호 검사가 엔티티 해석 전 본문을 보아, `&minus; 5%`의 부호를 놓치고 `1&thinsp;234만원`·`1.&thinsp;5%`의 엔티티 끝 `;`를 절 경계로 셌다(P2). 엔티티만 해석한(줄바꿈 등 나머지는 그대로) 본문과 원래 위치 → 해석 위치 표(`decodeWithMap`, 정규화와 함께 캐시)를 만들어 절 시작·끝·부호·숫자 연속을 모두 그 위에서 본다. 엔티티는 해석된 한 글자, 모르는 엔티티는 글자 그대로. 변이 시험 5개(시작 둘 다·`startsClause`만·`signBefore`만·`endsClause`만 원문으로, 해석 없음) 모두 잡힘 — `signBefore`만 원문으로 돌린 변이는 처음에 살아남아 줄바꿈 너머 엔티티 부호 사례(`&minus;\n5%`)를 더해 잡았다.

## 파일 업로드 (#22)
가족이 올린 파일을 받아 저장하고 원본을 돌려준다(PRD FR-4.1·4.2·4.6). 코드는 `apps/server/src/files/`(판별 `detect.ts`, 저장 `store.ts`, 경로 `routes.ts`, 백업 참조 `references.ts`), 형식 목록·한도는 `packages/shared/src/files.ts`, 화면은 `apps/web/src/chat/Attachments.tsx`. 운영 절차는 `docs/ops.md` 24절.

- **새 의존성 없음:** multipart 대신 **요청 본문 = 파일 바이트**(`application/octet-stream`), 이름은 `X-File-Name`(퍼센트 인코딩 UTF-8)으로 받는다. 업로드 경로만 자기 스코프에서 본문 파서를 "스트림을 그대로 넘김"으로 바꾸고(Fastify 본문 한도는 이 경로에 쓰이지 않는다) 핸들러가 스트림을 임시 파일로 쓴다. 매직 바이트 판별도 직접 한다 — 지원 형식마다 고정 서명이 있고, ZIP 계열 넷은 중앙 디렉터리의 항목 이름으로 가른다.
- **받는 순서:** 권한 검사(대화 주인, #10 — 남의 대화는 본문을 읽기 전에 403) → 본문 형식(`application/octet-stream`) → 이름·확장자(지원 목록 밖이면 415) → `Content-Length` > 50MB면 413(본문을 받기 전) → 대화의 파일 수 ≥ 20이면 409(빠른 거절) → `uploads-tmp/<UUID>.part`(새로 만듦 `wx`, 600)로 스트리밍하면서 세고 SHA-256 → 50MB를 넘는 조각이 오면 쓰기 전에 멈추고 413 + `Connection: close` → fsync → 내용 판별 → (잠금 안) 제자리로 이름 바꾸기 → `INSERT … SELECT … WHERE (SELECT count(*) …) < 20`(한 문장이라 동시 업로드가 마지막 자리를 함께 차지할 수 없음) → 못 넣었으면 파일을 지우고 409. 임시 파일은 어떤 경우에도 지운다.
- **형식 판별(`contentMatches`):** 확장자가 주장한 형식과 내용이 같아야 한다. **최선의 판별이지 보안 경계가 아니다**: 한 파일이 두 형식일 수 있다(PDF 머리 뒤의 HTML, SVG를 품은 DOCX, PDF 안의 JavaScript). 그런 내용이 실행되지 않게 하는 것은 서빙 방식(항상 내려받기·nosniff·샌드박스 CSP, 아래)이다.
  - PDF: 파일 맨 앞(오프셋 0)이 `%PDF-` (리뷰 #102: 앞 1024바이트 어디든 허용하면 `%PDF-`를 품은 HTML이 통과했다) · PNG: 8바이트 서명 · JPG: `FF D8 FF`
  - HWP(5.0): OLE 복합 파일이고 디렉터리(128바이트 정렬 항목)에 `FileHeader` 스트림이 있음 — Word `.doc`(OLE, `WordDocument`)는 거부
  - DOCX·XLSX·PPTX: ZIP이고 `[Content_Types].xml`과 `word/document.xml`·`xl/workbook.xml`·`ppt/presentation.xml` · HWPX: ZIP이고 `mimetype`·`Contents/content.hpf`. ZIP64·손상된 중앙 디렉터리는 거부. 그래서 DOCX라고 한 XLSX, 그냥 ZIP도 거부된다.
  - TXT·MD·CSV: 파일 어디에도 NUL이 없고(바이너리·UTF-16 거부), 알려진 바이너리 서명으로 시작하지 않고(실행 파일·압축·이미지·PDF), BOM·공백·HTML 주석(`<!-- -->`) 뒤 — 길이에 상관없이 파일 끝까지 건너뛴다(리뷰 #102: 8KB 넘는 공백이나 앞의 주석으로 숨길 수 있었다) — 가 `<!doctype`·`<html`·`<svg`·`<?xml`·`<script` 같은 마크업이 아님. 문서 중간의 HTML(마크다운의 `<b>`, 태그 설명)은 막지 않는다. 8비트 인코딩은 무엇이든 받는다(Excel의 CP949 CSV).
  - 받는 형식 목록에 SVG·HTML·XML이 없고, 그런 내용을 다른 확장자로 위장한 파일은 위 판별로 **대부분** 걸러진다(최선). 걸러지지 않은 것도 인라인으로 나가지 않는다.
- **경로:** `files/<사용자 id>/<대화 id>/<파일 id>`, 셋 다 서버가 만든 id(`assertSafeId`). 사용자 파일 이름은 경로·로그에 쓰지 않는다. 이름은 마지막 경로 조각만, NFC, 제어·양방향 재정렬 문자(U+202E 등) 제거, 200자(확장자 유지), 알려진 비밀 값 가림.
- **링크를 따라가지 않는다(리뷰 #102):** `O_NOFOLLOW`는 마지막 이름만 지킨다 — 사용자·대화 폴더를 바깥 폴더의 링크로 바꾸면 바깥 파일이 서빙되고, 대화 삭제가 바깥 파일을 지웠다(리뷰가 재현). 그래서 저장소의 모든 읽기·쓰기·지우기는 `FileStore.storeDir`를 거친다: `files/` → `<사용자>` → `<대화>`를 하나씩 `lstat`해 모두 링크가 아닌 진짜 폴더일 때만 쓴다(쓰기는 빠진 단계를 700으로 만들고 다시 확인). 링크면 읽기 404, 쓰기 500(아무것도 쓰지 않음), 지우기·정리는 건드리지 않고 넘어간다. 그 폴더 안의 링크(파일 자리)는 링크 자체만 지운다. 열기는 `O_NOFOLLOW | O_NONBLOCK` 뒤 fd의 `fstat`(일반 파일·행의 크기)과 이름의 `lstat`이 같은 inode인지, 폴더 검사를 다시 해도 같은지 확인한다(검사와 열기 사이 교체를 좁힌다). 저장소에 쓰는 것은 서버뿐이라(샌드박스 프로세스의 쓰기 폴더가 아님) 이것으로 충분하다고 본다. macOS `O_NOFOLLOW_ANY`는 CI(Linux)에 없어 쓰지 않았다.
- **원본 서빙(`GET /api/files/:id/content`):** 자원 종류 `file`(올린 사람만 — 관리자도 내용은 못 봄, 공유는 #29). 위 검사를 지난 fd로만 스트림을 보낸다(아니면 404). 헤더는 아티팩트 원본(#27)과 같은 `RAW_HEADERS`(nosniff·no-store·CORP same-origin·Permissions-Policy) + `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'` + 항상 `Content-Disposition: attachment`(#27의 `attachment()` 이름 정리). `?inline=1`은 PNG·JPG만 `inline`. MIME은 판별한 형식의 것. HEAD 자동 경로는 없다(본문 없는 요청이 파일을 열지 않게).
- **바이트는 그대로:** 알려진 비밀 값 가림(라운드 23–27)은 파일 바이트에 하지 않는다. 사용자가 올린 자기 문서이고, 고치면 원본이 깨진다(서명·압축). 응답 가림(`secrets/http.ts`)도 스트림은 지나간다. 이름(`files.name`)은 쓸 때 가리고 재가림 대상이다(`secrets/columns.ts`). 내용이 런타임에 들어갈 때(#48 추출)의 처리는 그 이슈에서 정한다.
- **백업(#37):** 파일 쓰기·지우기는 모두 `app.fileWrites.write()` 안에서 행과 함께 동기로 한다. `files/`는 처음부터 `BACKUP_FILE_ROOTS`에 있고, `FILE_REFERENCES`에 `uploadedFileReferences`(모든 `files` 행의 경로)를 넣었다 — 행은 있는데 파일이 없으면 백업이 실패한다(시험). `uploads-tmp/`는 백업 뿌리가 아니다(검사 전 파일).
- **지우기:** 대화 삭제는 경로가 잠금을 잡고 `ConversationStore.delete` → 커밋 뒤 `onDeleted` 훅이 그 대화 폴더의 우리 파일과 빈 폴더를 지운다. 사용자 행 삭제(앱에는 없음)·지우다 실패한 파일·이름 바꾸기와 행 넣기 사이의 강제 종료로 남은 파일은 서버 시작 때 잠금 안에서 정리한다(데이터 폴더 자신의 DB일 때만 — 다른 DB로 뜬 앱이 이 폴더를 판단하지 않게. 리뷰 #102: 판단은 **열린 DB 파일 자체**의 실경로가 `<DATA_DIR 실경로>/agentlee.db`와 같은지로 한다 — `agentlee.db`가 다른 DB로 가는 링크면 정리하지 않고 `file.sweep_skipped`를 남긴다). 서버가 붙인 이름(UUID)만 지운다.
- **메시지에 붙이기:** `POST /api/conversations/:id/messages {text, fileIds}` — 그 대화의, 아직 보내지 않은 파일만. 메시지를 만드는 트랜잭션 안에서 `file_ref` 파트를 붙이고 `message_id`를 조건부로 채운다(이미 보냈거나 다른 대화의 파일이면 400 `invalid_attachment`, 아무것도 만들지 않음). 런타임은 아직 파일을 보지 않는다(추출 #48). **고치기**(수정 후 다시 보내기)는 글자만 바꾼다: 원래 메시지의 `file_ref` 파트를 새 버전에 옮기고, 파일의 `message_id`도 같은 트랜잭션에서 새 버전으로 옮긴다(리뷰 #102 2차). 고치기 요청으로 첨부를 바꾸지는 않는다. 다시 생성은 사용자 메시지를 다시 만들지 않아 해당 없음.
- **임시 파일:** fsync가 실패해도(ENOSPC 등) 그 fd는 `finally`에서 닫고 임시 파일을 지운다(리뷰 #102: 열린 fd가 지운 파일의 공간을 붙잡았다). 시험이 ENOSPC를 주입해 열린 fd 수와 임시 폴더를 확인한다.
- **화면(리뷰 #102):** 올리는 중에 ✕로 뺀 칩은 요청을 끊지 않고(끊은 요청도 서버에 저장됐을 수 있고, 그러면 id를 잃는다) 끝나는 즉시 그 파일을 DELETE한다. 보내지 않은 파일은 새로고침·다른 기기에서도 칩으로 돌아온다(대화의 파일 목록에서 `messageId`가 없는 것) — 빼거나 보낼 수 있다. 뺀 파일은 서버가 지운 순간부터 20개 개수에서 빠진다(리뷰 #102 2차: 복원한 칩을 빼도 자리가 비지 않았다). 보내기가 끝나면 그 요청에 실린 파일의 칩만 지운다 — 보내는 동안 더한 파일은 보내지 않은 칩으로 남는다(리뷰 #102 3차, e2e·변이 시험). 업로드가 끝날 때마다 그 대화의 파일 목록을 다시 받는다 — 새 대화에서 첫 보내기로 대화 화면으로 넘어간 뒤 끝난 업로드도 거기서 칩으로 보인다. 새 대화 만들기가 실패하면 다음 파일·보내기가 다시 만든다(리뷰 #102 4차, e2e·변이 시험). 올리는 중에 뺀 파일은 끝나면 먼저 DELETE하고, 그 뒤에만 목록을 다시 받는다. 이 세션에서 빼거나 지운 파일 id는 모든 입력창이 함께 보는 집합에 남아, 지우기가 끝나기 전에 읽은 목록에서도 칩으로 돌아오지 않고 보내기에 실리지 않는다. 그래도 보내기가 `invalid_attachment`로 거절되면 서버 목록을 다시 받아 없는·이미 보낸 파일의 칩을 뺀다(리뷰 #102 5차, e2e). 변이: 목록 다시 받기를 DELETE 앞으로 옮기는 것만으로는 시험이 통과한다(공유 집합이 막음) — 집합 검사까지 빼면 리뷰 순서 시험이 실패하고, 집합 검사만 빼도 "지우기 진행 중" 시험이 실패하며, 거절 뒤 정리를 빼면 그 시험이 실패한다.
- **업로드 id로 서버 측 취소(리뷰 #102 6차):** 화면 쪽 기록만으로는 업로드·취소·목록 읽기·보내기의 순서 경합을 다 막지 못했다(응답이 늦게 오면 새 화면이 목록에서 B를 복원해 보내 버림). 그래서 클라이언트가 업로드 전에 UUID(`X-Upload-Id`)를 만들어 함께 보내고, 서버는 그것을 행의 `upload_id`(사용자마다 유일)에 둔다. 취소는 `DELETE /api/uploads/:uploadId` — 아직 오지 않았거나 받는 중이면 취소로 기록해(DB `upload_cancellations`, 6시간 — 리뷰 #102 7차: 메모리는 재시작에 사라졌다) 저장 직전(잠금 안, 같은 동기 단계)에 버리고 409 `upload_cancelled`, 이미 저장됐고 보내지 않았으면 행과 파일을 지운다, 메시지에 붙었으면 409 `file_attached`. 보내기는 취소된 업로드의 파일을 400 `invalid_attachment`로 거절한다. 화면은 취소한 업로드 id를 세션 집합에 두고(업로드 시작부터 안다) 목록 복원·보내기에서 뺀다. 남의 업로드 id는 호출자의 파일 안에서만 찾으므로 아무것도 지우지 못한다. 변이: 서버 측 취소 제거, 화면이 파일 id로만 취소, 보내기의 취소 검사 제거 — 모두 시험이 실패한다(e2e "review order 6"·서버 시험).
- **취소 기록(리뷰 #102 7차):** `upload_cancellations(user_id, upload_id, created_at)`, 기본 키 `(user_id, upload_id)`, `created_at` 색인. 업로드가 와서 거절되면(받기 전이든 저장 직전이든) 그 기록은 지운다(해결). 저장된 업로드를 취소하면 행을 지우고 기록을 남기지 않는다. 사용자마다 해결 안 된 취소는 100개까지(넘으면 429 `too_many_cancels`), 6시간 지난 기록은 서버 시작과 10분마다 `created_at` 색인으로 지운다(취소 요청과 무관). 모든 문장은 기본 키나 색인을 쓴다 — 시험이 문장마다 쿼리 계획을 확인한다(`CANCEL_SQL`). 화면은 새 대화 만들기를 기다리는 동안 뺀 파일을 아예 올리지 않는다. 변이: 메모리에만 기록(재시작 시험), 만들기 뒤 확인 제거(e2e), 상한 제거, 만료 타이머 제거, 해결 시 지우기 제거, 사용자 키 없이 세기(계획 시험) — 모두 시험이 실패한다.
- **로그:** `file.uploaded`(`fileCode` 고정 코드, 소요 시간, ID), `file.swept`(개수), `file.sweep_skipped`. 이름·내용·크기 없음(시험).
- **변이 시험(2026-11-12):** 하나씩 망가뜨리면 시험이 실패함을 확인했다(`apps/server/test/files.test.ts`). 스트리밍 중 크기 검사 제거(chunked 51MB 시험), `Content-Length` 사전 검사 제거(길이만 밝히고 본문을 안 보내는 요청이 답을 못 받음), 개수 조건을 항상 참으로(동시 21개 시험), 경로의 내용 판별 무시, PDF 서명 검사를 항상 참으로, 원본 경로를 `noResource`로, 파일 로더가 모두에게 공유, `?inline=1`을 모든 형식에 허용, `FILE_REFERENCES`를 비움, 저장의 쓰기 잠금 제거, 대화 삭제 경로의 쓰기 잠금 제거, 대화 삭제 훅 제거. 백업 참조 질의의 "표가 없는 옛 스키마" 처리를 빼면 옛 스키마 복원 시험(`backup.test.ts`)이 실패한다.
- **변이 시험(리뷰 #102 반영, 2026-11-12):** 폴더 검사를 `stat`(링크를 따라감)으로, 대화 삭제·저장에서 폴더 검사 제거(상위 폴더 링크 시험 — 사용자·대화 폴더 각각), DB 판단을 부모 폴더 비교로(링크된 `agentlee.db` 시험), fsync의 `finally` 닫기 제거(ENOSPC 주입 — fd 수), 마크업 검사를 앞부분만으로, `%PDF-`를 앞 1024바이트 어디든으로, 올리는 중 뺀 칩의 DELETE 제거·서버 목록에서 칩 복원 제거(e2e). 2차: 고치기가 `file_ref`를 버림, 고치기가 파일 연결을 옮기지 않음, 지운 칩을 계속 셈(e2e). 모두 시험이 실패했다. 읽기의 두 겹(열기 전 폴더 검사, 연 뒤 재검사)은 하나만 빼면 다른 하나가 막아 시험이 통과하고, 둘 다 빼면 실패한다.
- **남은 것:** 내용 추출·OCR(#48), HWP 추출(#23), 파일 뷰어·인용 위치(#24), 가족 공유(#29), 에이전트가 만든 파일 내려받기(#49).

## 문서 생성 (#49)
에이전트가 보고서·표·발표 자료를 실제 파일(DOCX·XLSX·PPTX·PDF)로 만든다(PRD FR-4.4·4.7·5.6). 도구 정의는 `packages/mcp-tools/src/docgen.ts`, 입력 형식·한도는 `packages/shared/src/docgen.ts`, 서버는 `apps/server/src/docgen/`(검사·저장 `service.ts`, 실행 `runner.ts`), 생성 작업자는 `apps/server/docgen/*.mjs`. 운영 절차는 `docs/ops.md` 29절.

- **왜 도구인가:** 런타임의 내장 셸·파일 쓰기는 막혀 있다(#42). 모델이 코드나 마크업을 써서 파일을 만들게 하지 않고, **구조화된 블록**(제목·문단·목록·표·그림·참고문헌)만 받아 서버가 정한 라이브러리로 만든다. 모델 입력은 글자로만 들어간다 — 서식·스크립트·외부 참조·수식을 만들 길이 없다(XLSX의 `=`로 시작하는 글도 글자 칸, 시험).
- **샌드박스 작업자:** 만들기는 `runIsolated`(#42)로 띄운 node 프로세스에서 한다 — 읽기는 작업자 폴더, 고정한 패키지 폴더(pnpm `.pnpm/<id>/node_modules`, 의존성을 따라 모음), 글꼴 패키지뿐(프로그램 폴더 = `trusted`, 가족 데이터 없음: `read: []`), 쓰기 없음, 네트워크 없음, 자식 프로세스 없음, 환경은 플래그 하나. 60초·768MB·출력 상한. 그림은 서버가 저장소의 검사된 열기로 읽어 stdin으로 넘긴다(작업자는 데이터 폴더를 못 읽는다). 그림 해독(PDF의 PNG 풀기)은 이 프로세스 안에서만 일어나고, 그 전에 머리만 읽어 크기를 막는다(4천만 화소). macOS가 아니면 `doc_unavailable` — 운영은 macOS다. 같은 작업자를 서버 프로세스에서 돌리는 것은 production이 거부하는 시험 전용 스위치 `ISOLATION_IN_PROCESS_FOR_TESTS`뿐이다(아래 "실행 위치").
- **그림은 이 대화의 자기 파일만:** 파일 id가 같은 사용자·같은 대화의 PNG·JPG이고, 메시지와 함께 보냈고 그 메시지가 지금 기록에 있으며, 저장된 SHA-256과 바이트가 같아야 한다. 아니면 모두 같은 `doc_image_not_found`(다른 사람·다른 대화의 파일이 있는지 알려 주지 않는다). URL은 형식부터 거절된다(파일 id는 UUID) — 아무것도 가져오지 않는다. 아티팩트(차트 SVG 등)는 그림으로 넣지 않는다(래스터화가 필요 — 남은 것).
- **범위:** 사용자·대화·run은 run 토큰에서만 온다. 토큰의 사용자가 대화의 주인이고, run이 그 대화의 것이며 답 메시지가 있어야 한다(아니면 `doc_not_allowed`). 파일은 그 답에 연결된다(아래).
- **비밀:** 요청의 모든 글자와 파일 이름에서 알려진 비밀을 만들기 전에 가린 뒤 형식을 다시 검사한다(가림이 길이·칸 형식을 바꿀 수 있음). 만든 뒤 등록된 비밀은 파일 바이트에서 지우지 않는다(업로드와 같은 원칙). 로그에는 형식과 고정 코드만.
- **다시 열기 두 번:** 작업자가 ZIP을 풀어 본문 부분·제목·표/시트 수를 확인하고(PDF는 머리·끝·쪽), 서버가 업로드와 같은 `contentMatches`를 한다. 크기 25MB 상한. 실패하면 저장하지 않는다.
- **저장:** `FileStore.addGenerated` — 업로드와 같은 경로·쓰기 잠금(#37)·한 문장 조건부 INSERT(대화당 20개), `message_id` = run의 답 메시지, `upload_id` 없음. 백업은 기존 `FILE_REFERENCES`(모든 `files` 행)로 그대로 덮인다. 마이그레이션·새 글자 열 없음.
- **맥락과의 연결(#45 결정):** 생성 파일은 만든 답에 붙는다. 새 세션의 참조 목록은 "기록에 있는 메시지의 파일"이므로 그 답이 기록에 있는 동안 다음 턴이 그 파일을 안다. 업로드처럼 사용자 메시지에 붙이거나 run id 열을 새로 만드는 안도 있었지만, 답에 붙이면 (1) 입력창 파일 흐름(첨부·✕·취소)과 섞이지 않고, (2) 재생성·수정으로 답이 빠지면 참조도 같이 빠지며, (3) 답의 내려받기 칩(`file_ref`, 실행 끝에 서버가 행 기준으로 붙임)과 같은 연결을 쓴다.
- **HWP:** 만들지 않는다(FR-4.4) — `doc_hwp_unsupported` + 고정 안내 문구(`hint`). MCP 서버의 도구 오류에 고정 문구 `hint`를 실을 수 있게 했다(입력·파일 내용은 절대 아님).
- **의존성 보안 메모 — brace-expansion(GHSA-6jwq-xf8q-xcwh):** 고정한 `brace-expansion` 1.1.21·2.1.7(`pnpm.overrides`)은 이 권고(2026-11-11 공개)에 해당한다. 고친 1.1.22·2.1.8도 2026-11-11 배포라 "배포 2주 이상" 규칙에 걸려 지금은 올리지 않는다. 이 패키지는 exceljs → archiver·unzipper → glob·readdir-glob 경로로만 들어오고, 그 안의 고정된 내부 패턴에만 쓰인다 — 사용자·모델 입력이 패턴으로 가는 길은 없다(작업자는 파일을 쓰거나 globbing하지 않는다). 2026-11-25 이후 올리는 일은 #112.
- **실행 위치(리뷰 #110 1차):** 운영은 항상 샌드박스. 프로세스 안 실행은 시험 전용 스위치 `ISOLATION_IN_PROCESS_FOR_TESTS`로만 하고, production 설정은 그 스위치를 거부한다(`loadConfig`) — `FAKE_RUNTIME`은 실행 위치를 바꾸지 않는다. 시험이 production+FAKE_RUNTIME, production+스위치(거부), 개발·시험+스위치 조합을 확인한다.
- **변이 시험(2026-11-12, `apps/server/test/docgen.test.ts`):** 하나씩 망가뜨리면 시험이 실패함을 확인했다 — 글 합·칸 합 한도, 표·그림 개수 한도, 행 길이 검사, 결과 크기 상한, 그림 화소 상한, 대화당 20개 조건(생성 INSERT), 그림의 기록-속(활성) 메시지 검사, 그림 해시 검사, 요청 비밀 가림, 생성 파일 이름 비밀 가림, 서버 `contentMatches`, 작업자의 제목 확인, 작업자의 DOCX 표 개수 확인, 대화 주인 검사, HWP 거절, XLSX의 `=` 글을 수식으로, 답의 `file_ref` 붙이기(20개 모두 실패). 그림 검사는 두 겹이라 하나만 빼면 다른 겹이 막아 통과한다: 사용자·대화 검사 ↔ 메시지-대화 조인, 보내지 않음 검사 ↔ 활성 검사, 서비스의 PNG·JPG 검사 ↔ 작업자의 머리 검사 — 각 쌍을 함께 빼면 시험이 실패한다.
- **변이 시험(리뷰 #110 1차, `apps/server/test/docgen-layout.test.ts`):** 실행기 선택이 FAKE_RUNTIME을 봄, 실행 시점 production 검사 제거, `loadConfig`의 production 거부 제거, PDF 칸 나누기 제거(30열×1,000자·499줄 시험 — 나누기가 없으면 pdfkit이 행을 자르려 해 `doc_too_large`로 거절되고, 거절 검사까지 빼면 글자 수가 모자람), PPTX 문단 안 자르기 제거, 줄바꿈 문단 간격 셈 제거, 내용 없는 제목·마지막 제목 슬라이드 제거, U+FFFE·U+FFFF 허용, 짝 없는 서로게이트 허용, XML 부분 파싱 제거, jszip을 devDependencies로 — 모두 시험이 실패했다. PDF의 "pdfkit이 행을 자르면 거절" 검사는 나누기와 두 겹이라 그것만 빼면 통과한다(위 쌍으로 확인).
- **PPTX 배치(리뷰 #110 2차):** 어림을 그만두고 상한으로 바꿨다 — 모든 글자 1em(탭 4em), 줄 간격·여백·열 너비를 파일에 명시, 표 칸도 직접 열 너비로 나눠 이어지는 행·슬라이드로(머리 행 반복·높이 포함), 8pt 밑으로 줄이지 않고 안 되면 `doc_too_large`. PPTX 500장·PDF 1,000쪽 상한. 시험의 검사기(`test/helpers/pptx-fit.ts`)는 생성기 코드를 쓰지 않고 슬라이드 XML만 읽어 같은 1em 규칙으로 다시 배치한다. 작업자 오류 코드 목록(`WORKER_CODES`)에 `doc_too_large`를 넣고, 작업자 파일에 있는 코드와 같은지 시험이 본다.
- **변이 시험(리뷰 #110 2차):** 생성기 글자 폭을 0.6em으로 되돌림(독립 검사기가 W 7,800자·혼합 글·표에서 잡음), 탭을 1em으로, 표 칸 자르기 제거, 머리 행 높이 안 셈, 8pt 밑 허용, 머리 행 절반 거절 제거, 파일에 쓰는 줄 간격을 센 것보다 크게, 열 너비를 다르게 씀, 500장 상한 제거, 1,000쪽 상한 제거, 서비스 목록에서 `doc_too_large` 제거 — 11개 모두 시험이 실패했다.
- **PPTX 폭 — 정한 범위만 보장(리뷰 #110 3차 결정):** 정확한 글꼴 폭을 쫓는 대신 범위를 정했다. 자소 묶음 단위로 세고 자르며(Intl.Segmenter), 1em(한글·한자·가나·라틴·그리스·키릴·숫자·흔한 문장 부호와 기호 — 내장 글꼴이 1em보다 넓게 그리는 글자는 뺌) / 2em(그 밖 모두, 이모지 포함) / 탭 4em, 매우 넓은 글리프가 알려진 블록(‰ ‱, ⸺ ⸻, 아랍어 표현형 합자, 2em 넘는 단위 기호)은 `doc_unsupported_text`로 거절. 표는 `apps/server/docgen/widths.mjs` 하나. **받아들인 한계:** 보는 쪽 프로그램이 글꼴을 바꿔 그리면(대체 글꼴), 1em 범위 밖이라 2em으로 세는 자소 묶음(이모지·드문 기호·다른 문자)은 그 2em보다 넓게 그려져 넘칠 수 있다. 1em 범위의 글자도 맑은 고딕·Gothic A1과 아주 다른 글꼴로 바뀌면 같은 일이 생길 수 있다.
- **메모리 상한(리뷰 #110 3차):** 잰 결과 PPTX 메모리는 장 수가 아니라 분량(문단·표 칸·그림 바이트)을 따르고, PDF는 모든 쪽을 버퍼하던 것(`bufferPages`)과 pdfkit이 푸는 그림 화소가 컸다. PPTX는 500장 + 분량 40,000, PDF는 쪽 버퍼를 끄고 1,000쪽 + 푸는 화소 2,000만으로 — 상한 안 최악이 약 570MB(측정은 ops §29.3).
- **변이 시험(리뷰 #110 3차):** PPTX를 코드 포인트로 자르기, PDF 줄을 코드 포인트로 자르기, 2em 부류를 1em으로, 거절 블록 검사 제거, 내장 글꼴 기준 제외 목록 제거, 장·분량·쪽·푸는 화소 상한 올리기 — 9개 모두 시험이 실패했다(분량 상한을 올리면 30열 줄바꿈 표가 만들어지며 시험 프로세스가 메모리·시간으로 중단되어 실패). 쪽 버퍼 끄기는 메모리만 바꾸므로 시험이 아닌 측정(ops §29.3)으로 확인했다.
- **마지막 배치 규칙(리뷰 #110 4차):** 자소 묶음의 폭은 코드 포인트 폭의 합(결합 부호 0.5em, 음절이 되는 자모 1em, 이모지 ZWJ·VS16 묶음 2em, 혼자인 폭 없는 문자 0). U+FEFF는 거절하지 않는다. PDF 표는 서버가 줄을 나눈 그대로 한 줄씩 그린다(pdfkit의 표·줄바꿈을 쓰지 않음 — 그 줄바꿈이 자모·ZWJ 묶음을 갈랐다). 독립 검사기는 1em 예외를 내장 글꼴 측정으로 스스로 구한다. 분량 상한을 DOCX·XLSX·PDF에도 두고(줄·칸·그림을 놓인 횟수마다), PDF의 푸는 화소도 놓인 횟수마다 센다. **받아들인 한계:** 위 규칙으로도 남는 부정확(보는 쪽의 대체 글꼴, 측정과 다른 입력 모양의 메모리) — 하드 보장은 샌드박스의 60초·768MB이고, 넘으면 `doc_timeout`·`doc_limit`으로 실패한다.
- **변이 시험(리뷰 #110 4차):** 여러 코드 포인트 묶음을 첫 코드 포인트로 세기, 결합 부호 0em, 혼자인 폭 없는 문자 2em, PDF 푸는 화소를 그림마다 한 번, 분량에서 그림을 한 번만, PDF 줄을 pdfkit이 다시 나누게, PDF 줄을 코드 포인트로 자르기, 열보다 넓은 자소 묶음 거절 제거, U+FEFF 다시 거절, 검사기의 측정 예외 제거, DOCX 분량 상한 제거 — 11개 모두 시험이 실패했다.
- **PDF 그림 비용(리뷰 #110 5차):** JPEG는 pdfkit이 풀지 않고 압축 바이트를 그대로 넣으므로 놓일 때마다 크기에 비례(MB당 16)로 센다 — PNG 식(MB당 20 + MB² × 2)과 푸는 화소 상한은 PNG에만. 5.5MB 사진 3장 보고서가 다시 만들어진다(시험). 변이: JPEG에 PNG 식을 다시 쓰면 그 시험이 실패한다.
- **남은 것:** 미리보기(#24), 참고문헌 내보내기 화면(#26 — 여기서는 문서 안의 참고문헌 블록만), 아티팩트(차트) 그림 넣기, 이미 만든 파일의 나중 비밀 재가림, 실런타임 수동 확인.
