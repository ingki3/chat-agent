# 운영 문서

집 Mac에서 Agent Lee를 운영하는 절차. 이 문서에는 인증 정보 값(API 토큰, 터널 토큰, AUD 태그 등)을 적지 않는다.

구성: `브라우저 → Cloudflare(Access) → Tunnel(cloudflared, LaunchDaemon) → 127.0.0.1:3000 Agent Lee(LaunchDaemon)`. 앱은 루프백에만 바인딩하고(`HOST`가 루프백이 아니면 시작 거부) 밖에서는 Tunnel로만 들어온다(PRD D4).

## 1. 데이터와 키의 위치

| 대상 | 기본 위치 | 설정 | 백업 |
|---|---|---|---|
| 데이터 디렉토리 (DB, 파일, 아티팩트, 런타임 홈) | `<repo>/data` | `DATA_DIR` | 아래 행별로 (#37, 21절) |
| SQLite DB | `<DATA_DIR>/agentlee.db` (WAL) | — | 포함(`VACUUM INTO` 스냅샷) |
| 첨부·파일 저장소 | `<DATA_DIR>/files/`, `artifacts/`, `sources/` (지금은 모두 DB에 있어 비어 있음) | — | 포함(DB와 같은 시점, 21.2절) |
| 런타임 폴더 (#15–#18) | `<DATA_DIR>/runtimes/` — CLI 세션·캐시, 로그인 중 폴더, 격리 폴더 `.quarantine` | — | **포함하지 않음** — 21.1절 |
| 백업 | `~/agentlee-backups/<id>/` | `BACKUP_DIR` | — (21절) |
| 암호화 마스터 키 | `~/.agentlee/master.key` | `MASTER_KEY_PATH` | **포함하지 않음** — 아래 3절 |
| 서버 전용 스킬 폴더 (#21) | `<DATA_DIR>/skills/<스킬>/` (허용 목록 스킬의 복사본, 읽기 전용) | `pnpm skills:install` — 15절 | **포함하지 않음** — 복원 뒤 다시 설치(21.1절) |
| 스킬 비밀 (#21, #30) | `.env`의 `ALPHAVANTAGE_API_KEY`·`OPENDART_API_KEY`·`GEMINI_API_KEY`·`SEC_USER_AGENT` | 15.3절, 19.1절 | `.env`와 같다 |
| 런타임 연결 키·토큰 (#17) | DB `connections.secret`(마스터 키로 암호화) | 설정 → 내 런타임 연결, 관리자 API — 11절 | DB와 함께 포함(암호문) |
| 사용량 기록 (#44) | DB `usage_records` 표 — 실행 시도(run·attempt)마다 1행, 토큰·원시 비용·요청 수만(내용 없음) | — | DB와 함께 포함 — 16절 |
| 웹 출처 (#50) | DB `sources` 표: 가져온 페이지 본문·검색 결과 | `WEB_SEARCH_PROVIDERS` — 17절 | DB와 함께 포함 |
| 아티팩트 (#27) | DB `artifacts`·`artifact_versions` 표: 버전마다 본문(최대 512KB) | — 18절 | DB와 함께 포함 |
| 금융 결과 (#30) | DB `finance_results` 표: 금융 도구를 쓴 답변마다 출처·기준 시각·숫자·식별자(후속 답변 검사용) | — 19.3절 | DB와 함께 포함 |
| 웹 푸시 VAPID 키 (#34) | DB `settings` 표: `push.vapid.public`(평문), `push.vapid.private`(마스터 키로 암호화) | 처음 시작할 때 자동 생성 | DB와 함께 포함(개인 키는 암호문) — 12절 |

- `DATA_DIR`과 `MASTER_KEY_PATH`의 상대 경로는 레포 루트 기준이다.
- 서버는 `MASTER_KEY_PATH`가 `DATA_DIR` 안에 있으면 시작을 거부한다.
- `BACKUP_DIR`이 `DATA_DIR` 안(또는 `DATA_DIR`을 품는 곳), 레포 안이거나 마스터 키를 품으면 시작을 거부한다(21절).
- **알려진 비밀 값 가림 (#14 리뷰 23~27차)**: 서버가 아는 비밀 값(연결 키·토큰, `.env` 비밀, 게이트 코드, 세션·MCP 토큰, 암호화되는 모든 값)은 저장·응답·스트림·런타임 전달 전에 가려진다. 스키마의 텍스트 열마다 쓰기 가림 또는 제외 이유가 `apps/server/src/secrets/columns.ts`에 있다. **받아들인 한계**: `users.email`과 `connections.account_email`은 식별자(관리자가 정하거나 공급자가 발급)라 저장값을 가리지 않는다 — 가리면 로그인이, 해시하면 관리자 화면과 Access 동기화(#36)가 깨진다. 이 값을 보여 주는 응답은 그래도 가려진다. 멱등 키(`runs.idempotency_key`)는 SHA-256으로만 저장한다.

## 2. 처음 설치

```bash
pnpm install
cp .env.example .env      # 필요한 값만 수정
pnpm keygen               # 마스터 키 생성 (권한 600, 이미 있으면 거부)
pnpm db:migrate           # DB 생성·마이그레이션 (서버 시작 시에도 자동 적용)
pnpm build && pnpm start
```

- 개발 모드(`pnpm dev`)는 키가 없으면 자동으로 만든다. 운영 모드(`pnpm start`)는 키가 없으면 시작하지 않는다.
- 키 파일 권한이 600이 아니면(그룹·다른 사용자에게 읽기 권한이 있으면) 시작하지 않는다.

## 3. 마스터 키 관리

- 키는 API 키·로그인 토큰·Cloudflare 토큰 등 저장된 인증 정보를 AES-256-GCM으로 암호화한다. 키를 잃으면 저장된 인증 정보를 복구할 수 없다(연결을 다시 등록해야 함).
- **키체인을 쓰지 않는 이유**: 서비스는 LaunchDaemon으로 사용자 로그인 전에도 시작해야 한다(PRD v0.5 NFR 가용성). 로그인 키체인은 로그인 전에 열리지 않는다.
- **오프라인 사본**: 설치 직후 키 파일 내용을 비밀번호 관리자 또는 오프라인 매체에 1부 보관한다. 백업(#37)에는 키가 들어가지 않으므로, 복원하려면 이 사본이 필요하다.
- **보관 절차 (#37 — 백업과 키는 따로 둔다)**
  1. 설치 직후 한 번: `cat ~/.agentlee/master.key`의 한 줄(base64)을 관리자 비밀번호 관리자에 "Agent Lee 마스터 키"로 저장한다. 화면 기록·채팅·메일·레포에는 붙여 넣지 않는다(셸 기록에 남지 않게 복사는 `pbcopy < ~/.agentlee/master.key`).
  2. 두 번째 사본은 종이 또는 암호화된 USB에 적어 집 밖이 아닌 별도 장소에 둔다. **백업을 옮겨 두는 외장 디스크·클라우드에는 넣지 않는다** — 백업과 키가 함께 새면 암호화가 소용없다.
  3. 키를 바꾼 적은 없어야 한다(로테이션 미지원). 만약 새 키를 만들었다면(아래 교체) 1–2를 다시 하고 옛 사본을 폐기한다. 그 전 백업은 옛 키로만 풀린다.
  4. 분기마다 한 번 21.4절 리허설로 사본이 맞는지 확인한다(`pnpm -s restore check <id> --key <사본으로 만든 파일>`이 `ok`). 4절에 날짜를 적는다.
- **복원 절차**: 새 기기에 `~/.agentlee/master.key`를 만들고 사본 내용을 넣은 뒤 `chmod 600`(폴더는 `chmod 700 ~/.agentlee`). 이어서 백업을 복원한다(21.3절). 키가 다르면 복원은 `wrong_key`로 멈추고 아무것도 바꾸지 않는다.
- **교체(로테이션)**: v1에서는 지원하지 않는다. 키가 유출되면 모든 연결을 해제하고 새 키를 만든 뒤 다시 등록한다.

## 4. 확인 기록

확인할 때마다 날짜와 결과를 적는다. 값(토큰·쿠키)은 적지 않는다.

- [ ] 재부팅 후 사용자 로그인 전에 LaunchDaemon 서비스가 마스터 키를 읽고 시작하는지 — 5.4절 절차. (Access 설정 뒤 앱 데몬을 설치하고 확인)
- [ ] `cloudflared` 데몬이 재부팅 후 사용자 로그인 없이 연결되는지
- [ ] `lsof -nP -iTCP:3000 -sTCP:LISTEN`이 `127.0.0.1:3000`만 표시하는지
- [ ] 실제 도메인 SSE 3분 측정 통과 — 8절, 결과 JSON을 #8에 첨부
- [ ] 휴대폰 LTE에서 Access 코드 로그인 → 빈 앱 화면, 허용 안 된 이메일은 Access에서 거부
- [ ] 가동률 7일 측정 합격 — 9.3절, `pnpm -s uptime report` 출력을 #46에 첨부 (Access 설정 후)
- [ ] 백업 리허설(분기마다) — 21.4절: 오프라인 사본 키로 `restore check` ok, 빈 폴더에 `apply --target` 후 로그인·대화·연결 테스트 확인

## 5. 자동 시작 (LaunchDaemon)

### 5.1 Mac 전원·절전 설정 (1회, 관리자)

```bash
sudo pmset -a sleep 0 disksleep 0     # 시스템·디스크 절전 끔 (화면 절전은 상관없음)
sudo pmset -a autorestart 1           # 정전 후 전기가 돌아오면 자동으로 켜짐
pmset -g | grep -E ' sleep|disksleep|autorestart'
```

- 절전을 앱(Amphetamine·caffeinate)으로 막는 방식은 그 앱이 사용자 로그인 뒤에 실행되므로 재부팅 직후에는 효과가 없다. `pmset`으로 끈다.
- **FileVault가 켜져 있으면** 재부팅(정전 포함) 뒤 디스크 잠금 해제를 위해 관리자가 Mac에서 비밀번호를 한 번 입력해야 한다. 그 전에는 두 서비스 모두 시작하지 않으며, 이 시간은 계획 정지로 친다(PRD NFR 가용성). 계획된 재시작은 `sudo fdesetup authrestart`로 잠금 해제를 미리 승인할 수 있다.

### 5.2 앱 데몬 설치

**Access 애플리케이션이 `chat.2prostream.com`을 보호하기 전에는 설치하지 않는다.** 설치하는 순간 앱이 터널을 통해 인터넷에 열린다. 그 전에는 개발 모드(`pnpm dev`)로 필요할 때만 띄운다.

```bash
pnpm install && pnpm build
pnpm keygen                      # 처음 한 번 (3절)
pnpm -s launchd print            # 설치될 plist 확인 (변경 없음)
pnpm -s launchd install          # sudo · Access 보호 여부를 묻는다
pnpm -s launchd status
```

- 템플릿: `ops/launchd/com.agentlee.server.plist` → `/Library/LaunchDaemons/com.agentlee.server.plist` (root:wheel 644).
- 서비스는 설치한 사용자 계정으로 실행된다(`UserName`). `HOME`을 지정하므로 마스터 키 기본 위치 `~/.agentlee/master.key`가 그대로 쓰인다.
- `node`는 실제 설치 경로로 고정한다. 버전 관리자(fnm 등)가 셸마다 만드는 임시 경로는 재부팅 뒤 사라지므로 스크립트가 거부한다. 필요하면 `AGENTLEE_NODE=/path/to/node`.
- 설치 전에 빌드 결과를 확인하고, **서비스 계정으로** 서버와 같은 로더를 실행해 설정(`.env`)과 마스터 키(존재·32바이트·권한 600·심볼릭 링크 아님·안전한 부모 디렉토리)를 검사한다. 하나라도 틀리면 설치하지 않는다.
- 서비스 계정은 실제 존재하는 일반 계정이어야 한다(root 거부). 다른 계정으로 돌리려면 `AGENTLEE_USER=<계정>`. plist 값은 XML 이스케이프해서 넣는다.
- `KeepAlive`로 비정상 종료 시 10초 간격 안에서 다시 시작한다. 제거: `pnpm -s launchd uninstall`.

### 5.3 업데이트 반영

```bash
git pull && pnpm install && pnpm build
sudo launchctl kickstart -k system/com.agentlee.server
```

### 5.4 재부팅 확인 절차

1. `sudo reboot`(또는 `sudo fdesetup authrestart`). FileVault 잠금 해제 후 **로그인 화면에서 멈춘 상태로** 휴대폰 LTE에서 접속해 본다.
2. 화면이 열리면 두 데몬이 로그인 전에 시작된 것이다. 이어 로그인해서 아래로 확인한다.
   ```bash
   sudo launchctl print system/com.agentlee.server | grep -E 'state =|pid ='
   sudo launchctl print system/com.cloudflare.cloudflared | grep -E 'state =|pid ='
   grep -m1 'Server listening' /Library/Logs/agentlee/server.log   # 부팅 시각 근처인지
   ```
3. 결과를 4절에 적는다.

## 6. Cloudflare Tunnel

- `cloudflared`는 이미 `com.cloudflare.cloudflared` LaunchDaemon(토큰 방식, 대시보드에서 관리하는 터널)으로 돌고 있다. 같은 터널에 다른 서비스(`dart`, `ssh` 등)도 있으므로 터널을 새로 만들지 않고 **Public Hostname만 추가**한다.
- Public Hostname: `chat.2prostream.com` → `HTTP` `127.0.0.1:3000`.
  - Additional settings → HTTP Settings → **HTTP Host Header: `chat.2prostream.com`** (#9가 Host로 신뢰 경계를 구분한다).
  - `localhost` 대신 `127.0.0.1`을 쓴다(IPv6 `::1`로 가는 것을 막음).
- `~/.cloudflared/config.yaml`은 토큰 방식 데몬이 읽지 않는다. 대시보드 설정이 기준이다.
- 데몬 로그: `/Library/Logs/com.cloudflare.cloudflared.err.log`.
- 관리자 화면 시스템 상태의 터널 칸은 `cloudflared` 자체 메트릭 서버를 읽는다(20.5절). 설정하지 않으면 "미설정"이다.

## 7. Cloudflare Access (마지막 단계 — 관리자)

앱 데몬 설치(5.2) 전에 반드시 한다.

1. Zero Trust → Access → Applications → Add → Self-hosted. 도메인 `chat.2prostream.com`(경로 비움 = 전체).
2. 로그인 방식: **One-time PIN**(이메일 코드).
3. 정책: Allow · Include · Emails → `ingki3@gmail.com`만. 가족은 계정을 만든 뒤 10절 절차로 추가.
4. 세션 기간은 기본값(24시간)으로 둔다.
5. 애플리케이션 개요의 **AUD 태그**를 `.env`의 `CF_ACCESS_AUD`에, 팀 도메인(`<team>.cloudflareaccess.com`, Zero Trust → Settings → Custom Pages에 표시)을 `CF_ACCESS_TEAM_DOMAIN`에 넣고 재시작한다. 저장소에는 넣지 않는다.
   - 서버는 `chat.2prostream.com`으로 온 모든 요청(페이지·정적 파일·API)에서 `Cf-Access-Jwt-Assertion`을 검증한다(서명·`iss`·`aud`·만료, 키는 팀 JWKS에서 받아 캐시). 실패하면 403.
   - 두 값이 없으면 공개 도메인 요청은 모두 403(`access_not_configured`)이다. 7.1의 임시 접속 코드를 켠 경우만 예외.
   - Access로 들어온 이메일과 다른 앱 계정으로는 로그인할 수 없고, 기존 세션도 거부된다.
   - 이메일이 없는 서비스 토큰 JWT는 `GET /api/health`(가동률 측정, 9.3절)에만 통과하고 나머지는 403이다.
6. 확인: 시크릿 창에서 접속 → Access 로그인 화면이 먼저 나와야 한다. 허용 안 된 이메일로 코드를 요청하면 코드가 오지 않고 거부된다.

### 7.1 임시 접속 코드 (Access 전 테스트용)

Access를 설정하기 전에 실제 도메인으로 시험해야 할 때만 쓴다.

- `.env`에 `TEMP_GATE_CODE=<8자 이상>`을 넣으면 공개 도메인으로 온 모든 페이지·정적 파일·API가 `/gate` 코드 입력 화면 뒤로 간다(집 안 `localhost` 접속은 코드 없이 앱 로그인만). 코드는 `.env`에만 두고 저장소·메신저에 남기지 않는다.
- 맞는 코드를 넣으면 7일짜리 서명 쿠키(HttpOnly, SameSite=Lax, https면 Secure)를 준다. 서버를 재시작하거나 코드를 바꾸면 모두 다시 입력해야 한다.
- 틀린 시도는 같은 IP에서 15분에 5번, 전체 합쳐 15분에 30번까지다. 넘으면 맞는 코드도 15분간 거부된다(누군가 대량으로 시도하면 가족도 잠시 못 들어올 수 있다).
- Access를 켜면 `TEMP_GATE_CODE`를 지우고 재시작한다.

## 8. 스트리밍(SSE) 측정

답변 스트리밍이 Cloudflare를 지나도 끊기거나 몰리지 않는지 실제 도메인에서 잰다.

- 서버의 공통 SSE는 헤더를 즉시 보내고(`text/event-stream`, `Cache-Control: no-cache, no-transform`), 15초마다 heartbeat 주석을 보낸다(Cloudflare 유휴 타임아웃 기본 125초 회피).
- 측정용 스트림 `/api/diag/stream?seconds=N`은 `DIAG_STREAM=1`일 때만 켜진다(기본 꺼짐). 1초마다 `tick`, 끝에 `done`. 동시 2개까지, 최대 600초.

```bash
# 1) .env에 DIAG_STREAM=1 → 서비스 재시작   2) 측정   3) DIAG_STREAM 제거 → 재시작
pnpm -s sse-probe "http://127.0.0.1:3000/api/diag/stream?seconds=10"              # 로컬 기준값

# Access 쿠키는 명령줄이 아니라 파일로 넘긴다 (권한 600, 측정 후 삭제).
# 파일 내용 한 줄: Cookie: CF_Authorization=<브라우저에서 복사>  — 편집기로 넣는다(셸 기록에 남지 않게).
install -m 600 /dev/null ~/.agentlee/probe-headers.txt && open -e ~/.agentlee/probe-headers.txt
pnpm -s sse-probe "https://chat.2prostream.com/api/diag/stream?seconds=180" \
  --header-file ~/.agentlee/probe-headers.txt --json sse-probe-result.json
rm ~/.agentlee/probe-headers.txt
```

- 판정: 상태 200 · `text/event-stream` · 헤더 2초 이내 · tick 180개 모두 · `done` 수신 · 헤더→첫 tick→…→`done` 간격 최대 3초 · heartbeat 간격 최대 20초 · 몰려 도착한 tick 2개 이하. 30초 동안 아무것도 오지 않거나 전체가 `seconds + 15초`를 넘으면 중단하고 실패로 보고한다. 실패 이유는 `reasons`에 나온다.
- 헤더 값은 출력·결과 파일·오류 메시지에 남지 않는다. **`pnpm -s`로 실행**해야 pnpm이 명령줄을 다시 출력하지 않는다. `-H "Name: value"`는 로컬 시험용이다(명령줄 값은 셸 기록과 프로세스 목록에 보인다). 측정 후 브라우저에서 로그아웃해 쿠키를 무효화한다.

## 9. 로그와 가동률

### 9.1 앱 로그

- 위치: `/Library/Logs/agentlee/server.log`. 앱이 직접 쓰고(`LOG_FILE`, LaunchDaemon이 지정) **10MB마다 순환**해 `server.log.1`…`server.log.5`까지 남긴다(그보다 오래된 것은 지운다). launchd의 stdout은 `server.out.log`(보통 비어 있음), 시작 실패는 `server.err.log`. 개발 모드(`pnpm dev`)는 `LOG_FILE`이 없으면 터미널(stdout)에 쓴다. 수준은 `LOG_LEVEL`(기본 `info`). 로그 파일을 열거나 쓰지 못해도(디스크 가득, 권한 등) 서버는 시작하고 계속 돌며 그 줄만 버린다(파일에는 완전한 JSON 줄만 남는다 — 중간에 끊긴 줄은 잘라낸다). 다시 쓸 수 있게 되면 `log.line_dropped` 레코드에 버린 줄 수(`dropped`)를 남긴다.
- 형식: JSON 한 줄에 레코드 하나. **허용된 필드만** 쓰고, 각 값은 모양이 아니라 **서버가 만든 값인지**로 검사한다: ID는 서버가 만드는 UUID, 상태·오류 코드·분류·런타임은 정해진 목록, 라우트는 등록된 패턴, 도구명은 알려진 도구(런타임 기본 도구 + 우리 MCP 서버의 도구, 예 `mcp__agentlee__echo_time` — 그 밖은 `other`), 오류 클래스는 알려진 이름(그 밖은 `Error`). 맞지 않으면 그 필드를 버린다(키·토큰·접속 코드가 허용 문자로만 이루어져 있어도 통과하지 못한다). `apps/server/src/logging.ts`가 기준이다.
  - 허용 필드: `level` `time` `pid` `hostname` `msg` `reqId` `req{method,url=라우트 패턴,reqId}` `res{statusCode}` `responseTime` `err{type,code,statusCode}` `userId` `conversationId` `runId` `runtime` `tool` `durationMs` `status` `errorCode` `category` `costUsd` `inputTokens` `outputTokens` `dropped`, 알림(#34): `notificationKind` `count` `devices` `httpStatus`, 사용량(#44): `attempt` `purpose`.
  - `msg`는 정해진 이벤트 이름만: `run.finished`(실행 1건: 소요·상태·오류 코드·비용·토큰), `tool.finished`(도구 호출 1건: 도구명·소요·ok/error), `skill.finished`(우리 MCP 서버의 스킬 호출 1건: 도구명·소요·ok/error·`skillCode`, #21), `request.error`, `web.build_missing`, `error`, 알림(#34) `push.sent`·`push.unsent`(보낸 알림 수·받은 기기 수)·`push.failed`(푸시 서비스 상태 코드·오류 코드)·`push.cancelled`(전송 직전 권한 재검사로 취소)·`push.subscription_gone`(404/410으로 기기 삭제), 사용량(#44) `usage.record_failed`(사용량 행을 쓰지 못함: ID·`attempt`·`purpose`·오류 코드만 — 응답은 계속된다), 사용량 화면(#32) `usage.prices_saved`(관리자 id·모델 수)·`usage.daily_cost_alert`(오늘 비용)·`usage.alert_failed`(오류 코드), 비밀 재가림(리뷰 26차) `secrets.rescrub_failed`(저장 행 재가림 실패 — 다시 시도, 오류 코드만), Fastify의 `incoming request`·`request completed`·`Server listening at http://127.0.0.1:3000`. 그 밖의 문장은 `redacted`로 바뀐다.
  - **기록하지 않는 것**: 프롬프트·메시지·파일 내용, 모델 출력, 도구 입출력, SDK 원문 오류·stderr(오류는 클래스 이름과 코드로만 남고 `errorCode`·`category`로 정제), 비밀번호, 토큰, 쿠키·헤더 값(Cookie, Authorization, Cf-Access-Jwt-Assertion, Idempotency-Key 등), 임시 접속 코드, 이메일. 요청은 실제 URL이 아니라 라우트 패턴(`/api/conversations/:id/messages`)으로만 남는다.
  - `pnpm test`의 유출 fixture 테스트(`apps/server/test/observability.test.ts`)가 대화 문장·키 패턴·쿠키·헤더·접속 코드·이메일을 요청·오류·실행·도구로 흘려 보내고, 로그와 관리자 오류 목록에 하나라도 나오면 실패한다.
- 읽기:
  ```bash
  tail -f /Library/Logs/agentlee/server.log
  jq -c 'select(.msg=="run.finished") | {time,userId,conversationId,runId,status,errorCode,durationMs,costUsd}' /Library/Logs/agentlee/server.log
  jq -c 'select(.level>=40)' /Library/Logs/agentlee/server.log      # 경고·오류만
  jq -c 'select(.conversationId=="<대화 ID>")' /Library/Logs/agentlee/server.log   # 대화별 도구 호출·비용·오류
  ```
- 오류 응답: 5xx는 브라우저에도 `{"error":"internal_error"}`만, 4xx는 상태별 고정 코드(`invalid_request`, `payload_too_large` 등)만 보낸다. 라우팅 전에 나는 오류(잘못된 퍼센트 인코딩 등)도 `{"error":"invalid_request"}`와 보안 헤더로 답한다(요청 URL을 되돌려 주지 않음).

### 9.2 최근 오류 (관리자)

- `GET /api/admin/errors?limit=50&source=run|tool|http` (관리자만, 최대 200건). 항목: 시각·출처·오류 코드·분류·사용자/대화/실행 ID·런타임·도구명·라우트 패턴·상태 코드. 로그와 같은 정책이라 오류 문장은 없다. DB `error_log` 테이블에 최근 1000건·30일까지 둔다(1시간마다 정리, 조회도 30일 이내만). 화면: 관리자 → 시스템 상태(20.5절). 실패한 스킬·금융 도구 호출도 여기에 `source=tool`, 결과 코드(`skill_failed`, `finance_unconfigured` 등)와 도구명으로 남는다(#35).

### 9.3 가동률 측정 (목표 99%)

판정 규칙(PRD NFR 가용성): 7일 동안 5분 간격 체크. **성공 = 외부 주소 `https://chat.2prostream.com/api/health`가 10초 안에 200**(그리고 응답이 Agent Lee 헬스 JSON — Access 로그인 페이지는 실패). 실패는 같은 순간의 로컬 체크(`http://127.0.0.1:3000/api/health`)로 나눈다: 로컬도 실패 → **앱**, 로컬 성공·외부 실패 → **터널**(Cloudflare·cloudflared·집 회선). 체크는 직전 체크 시작 뒤 5분마다 돌므로, 두 기록 사이 간격이 5분 + 허용 지연 1분을 넘으면 그 사이 예정 체크가 빠진 것이다 — **기록 없음**(Mac·측정기 정지, 정전)으로 실패에 넣는다. 몇 초 흔들림이나 늦은 시작은 누락이 아니다. 2분 30초 안에 연달아 기록된 체크(재시작 때 바로 한 번 더 도는 것)는 한 번으로 치고, 나쁜 쪽 결과를 쓴다. 이후 일정은 나중 체크부터 다시 5분씩 센다(launchd는 마지막 실행 기준으로 간격을 잰다). **계획 정지** 구간(FileVault 잠금 해제 대기, 계획된 재시작)은 분모에서 빼고 따로 표시한다.

측정기는 집 Mac에서 도는 LaunchDaemon(`com.agentlee.uptime`, 5분마다)이다. 외부 체크는 인터넷으로 나가 Cloudflare 엣지 → Access → 터널 → 앱을 거쳐 돌아오므로 가족이 밖에서 쓰는 경로 전체를 잰다. Mac이 꺼지면 기록이 없으므로 그 시간은 "기록 없음"으로 실패 처리된다.

**Access를 켠 뒤(7절)에만 시작한다.** 임시 접속 코드 단계에서는 외부 체크가 코드 화면에 막혀 의미가 없다.

1. Zero Trust → Access → Service Auth → **Service Tokens → Create**(이름 `agentlee-uptime`, 기간 1년). Client ID·Secret은 이때 한 번만 보인다.
2. Access → Applications → Agent Lee → 정책 추가: Action **Service Auth**, Include **Service Token = agentlee-uptime**. 서버는 서비스 토큰(이메일 없는 Access JWT)을 **`GET /api/health`에만** 허용하고 그 밖의 경로는 403이다.
3. 토큰 파일(권한 600, 편집기로 넣는다 — 셸 기록에 남지 않게):
   ```bash
   install -m 600 /dev/null ~/.agentlee/uptime-token && open -e ~/.agentlee/uptime-token
   # 내용 두 줄:  CF-Access-Client-Id: <id>
   #             CF-Access-Client-Secret: <secret>
   ```
   측정기는 권한이 600이 아니면 거부한다. 토큰 값은 출력·기록 파일에 남지 않는다(상태 코드·소요·오류 분류만).
4. 시험: `pnpm -s uptime check --file /tmp/uptime-test.jsonl` → `external.ok: true`인지 확인.
5. 설치: `pnpm -s launchd install-uptime`(sudo). 기록: `/Library/Logs/agentlee/uptime.jsonl`. 제거: `pnpm -s launchd uninstall-uptime`.
6. 계획 정지 표시(기록 파일에 함께 남는다):
   ```bash
   F=/Library/Logs/agentlee/uptime.jsonl
   pnpm -s uptime planned start --note reboot --file $F     # 재시작 전
   pnpm -s uptime planned end --file $F                     # 돌아온 뒤
   pnpm -s uptime planned add 2026-11-20T03:10:00+09:00 2026-11-20T03:40:00+09:00 --note filevault --file $F   # 나중에 표시
   ```
7. 판정: `pnpm -s uptime report --file /Library/Logs/agentlee/uptime.jsonl`(최근 7일, `--json`이면 상세). 출력: 가동률·분모(예정 체크 약 2016 − 계획 정지 − 외부 미측정)·성공/앱/터널/기록 없음 수·`합격`/`불합격`/`판정 불가`. 종료 코드 0 = 합격, 1 = 불합격, 3 = 판정 불가(7일 미만 기록, 또는 토큰 없이 외부 경로를 못 잰 체크가 있음). 결과를 4절과 #46에 남긴다.

## 10. 가족 이메일 추가 (수동, 자동 동기화 #36 전까지)

1. 앱 관리자 화면에서 가족 계정을 만든다(#41).
2. Zero Trust → Access → Applications → Agent Lee → 정책 → Include Emails에 그 가족 이메일을 추가하고 저장한다.
3. 가족에게 임시 비밀번호를 직접 전달하고, 휴대폰에서 Access 코드 로그인 → 앱 로그인이 되는지 함께 확인한다.
4. 가족을 비활성화하면 같은 정책에서 이메일을 지운다. **관리자 이메일(`ingki3@gmail.com`)은 지우지 않는다.**

## 11. 런타임 연결 (#17, 구독 #18)
연결은 앱 안에서 만든다. 하나의 연결은 **런타임 × 인증 방식 × 범위**다(PRD D2, FR-11).

| 범위 | 누가 만드나 | 누가 쓰나 | 인증 방식 |
|---|---|---|---|
| 가족 공용 | 관리자 (`/api/admin/connections`, 관리자 화면 "런타임" 탭은 #35) | 관리자가 허용한 가족 | API 키만 |
| 개인 | 본인 (설정 → **내 런타임 연결**) 또는 관리자가 대신 등록(`/api/admin/users/:id/connections`) | 본인만 | API 키, 또는 구독 |

- **규칙**(서버가 강제한다)
  - 공용 연결은 API 키만 받는다. 공용 구독을 만들려 하면 400 `shared_subscription`이다.
  - 연결의 범위는 바꿀 수 없다. 요청 본문에 `scope`가 있으면 400 `scope_immutable`이다.
  - **Claude 구독**(`claude setup-token`으로 받은 토큰)은 관리자 본인 계정에만 만들 수 있다. 다른 계정에 만들려 하면 403 `subscription_not_allowed`이다. 화면에도 관리자에게만 나온다. 관리자가 관리자 권한을 잃으면 그 연결은 더 쓰이지 않는다. API 키(`sk-ant-api…`)를 구독으로 넣으면 400 `invalid_secret`이다.
  - **Codex 구독**(가족 각자의 ChatGPT 로그인)은 붙여 넣지 않는다. 아래 "ChatGPT 로그인"으로만 만든다(붙여 넣으면 400 `login_required`). 개인 연결로만 생기고, 그 사람 본인만 쓴다.
  - 키 형식이 다르면 400 `invalid_secret`이다. Anthropic은 `sk-ant-…`, OpenAI는 `sk-…`이다.
- **Claude 구독 등록(관리자 본인, #18)**
  1. 관리자 맥의 터미널에서 `claude setup-token`을 실행하고 브라우저에서 관리자 본인의 Claude(Pro/Max) 계정으로 승인한다. 장기 토큰이 터미널에 한 번 나온다.
  2. 설정 → 내 런타임 연결 → "Claude Code · 관리자 본인 구독"을 고르고 토큰을 붙여 넣는다. 화면에는 FR-11.4 안내("본인 구독만 연결하세요…")가 보인다.
  3. "테스트"를 눌러 `사용 가능`이 되면 관리자 본인 대화에만 쓰인다. 토큰은 실행할 때 `CLAUDE_CODE_OAUTH_TOKEN` 환경 변수로만 CLI에 넘어간다.
  - 토큰이 만료되거나 취소되면 실행이 `runtime_auth`로 끝나고 연결이 `expired`("다시 로그인 필요")가 된다. 대화에는 `subscription_expired` 안내("Claude 구독 토큰이 만료됐어요 — `claude setup-token`으로 새 토큰을…")가 뜬다. 같은 절차로 새 토큰을 만들어 그 연결의 키를 바꾸거나(PATCH) 새로 추가한다.
- **ChatGPT 로그인(가족 각자, #18)** — 설정 → 내 런타임 연결 → "Codex · 내 ChatGPT 계정으로 로그인" → "ChatGPT로 로그인"
  1. 서버가 고정 버전 app-server를 샌드박스로 하나 띄워 `account/login/start {type:"chatgptDeviceCode"}`를 보낸다(`POST /api/connections/logins`). 화면에 OpenAI 로그인 페이지(`https://auth.openai.com/codex/device`) 링크와 1회용 코드가 나온다.
  2. 사용자가 링크를 열고 **본인** ChatGPT 계정으로 로그인한 뒤 코드를 넣는다. 화면은 2초마다 서버에 묻는다(`GET /api/connections/logins/:id`). 15분 안에 넣지 않으면 `timeout`, "취소"는 `DELETE /api/connections/logins/:id`이다. 사용자당 한 번에 하나다(새로 시작하면 앞의 것은 취소된다).
  3. 끝나면 서버가 토큰을 받아 마스터 키로 암호화해 저장하고, 로그인 폴더를 통째로 지운다. 연결이 생기고(`untested`) 화면이 곧바로 테스트한다. 화면에는 **계정 이메일만** 보인다.
  - 로그인과 코드는 시작한 사람만 본다(다른 사람은 404). 결과 연결은 그 사람의 개인 연결이라 다른 사람의 선택기에 나오지 않고, id로 직접 써도 403이다(관리자도 같다).
  - "다시 로그인"은 같은 연결에 새로 로그인한다(`connectionId`를 실어 시작). 새 토큰으로 바뀌고, 옛 로그인으로 돌던 실행·테스트는 멈추며, 다시 테스트한다.
  - 화면은 서버가 그 로그인을 모르면(404 — 서버 재시작) 또는 `expiresAt`이 지나면 기다리기를 멈추고 다시 시작하라고 안내한다. 네트워크 오류·5xx만 다시 묻는다.
  - 동시 요청: 한 사용자의 시작은 하나씩 처리한다. 앞의 것은 취소하고 **그 프로세스가 끝나고 폴더가 지워질 때까지** 기다린다. 자리 하나는 살아 있는 app-server 하나다: 프로세스를 띄우기 전에 자리를 잡고, 취소해도 프로세스가 끝날 때까지 자리를 쥔다. 그래서 동시에 도는 로그인 프로세스는 전체 4개를 넘지 않는다(넘으면 409 `login_busy`). 시작이 실패하면 자리를 돌려준다. 취소와 저장은 하나만 이긴다: 저장 직전에 취소가 왔으면 저장하지 않는다.
  - 링크와 코드는 고정 버전에서 확인한 것만 보여 준다: 링크는 정확히 `https://auth.openai.com/codex/device`(다른 경로·쿼리·fragment 없음), 코드는 `XXXX-XXXXX`(영문 대문자·숫자). 다르면 409 `login_unavailable`.
  - 실패 코드: `login_expired`(코드 만료), `login_failed`(로그인이 끝나지 않음·거부), `login_error`(그 밖의 문제). 어느 경우든 아무것도 저장하지 않는다. 로그에는 `connection.login_started`·`connection.login_finished`와 이 코드만 남는다(코드·링크·이메일·토큰은 남지 않는다).
  - 개발 모드(`FAKE_RUNTIME=1`)와 시험에서는 실제 로그인을 띄우지 않는다(400 `unsupported_auth`).
- **토큰 갱신(ChatGPT 로그인)**
  - 실행에는 액세스 토큰만 넘긴다(stdin의 `account/login/start {type:"chatgptAuthTokens"}`, 메모리에만). 리프레시 토큰은 런타임 프로세스에 들어가지 않는다.
  - app-server가 토큰이 거부됐다고 새 토큰을 달라고 하면(`account/chatgptAuthTokens/refresh`), 서버가 `https://auth.openai.com/oauth/token`에 리프레시 토큰으로 직접 요청해 새 토큰을 받는다. 받은 토큰은 암호화해 저장하고 `credential_version`을 올린다. 실행 중인 다른 세션은 그대로 이어진다(`credential_base_version`은 그대로 — 같은 로그인으로 본다). 같은 연결의 갱신은 한 번에 하나다(리프레시 토큰은 한 번만 쓸 수 있다).
  - 만료 직전(2분 안)인 토큰은 세션을 열기 전에 미리 갱신한다. 한 세션이 갱신을 세 번 넘게 달라고 하면 그 세션은 끝난다: 갱신이 일시적인 이유(네트워크, 5xx, 형식이 틀린 응답)로 계속 실패했으면 `runtime_error`(연결은 그대로), 갱신은 됐는데 새 토큰도 계속 거부되면 `runtime_auth`.
  - OpenAI가 리프레시 토큰을 거부하면(400/401/403) 그 로그인은 끝난 것이다: 실행은 `runtime_auth`, 연결은 `expired`, 대화에 `subscription_expired` 안내("ChatGPT 로그인이 만료됐어요 — ‘다시 로그인’을…")가 뜬다. 다른 실패(네트워크, 5xx, 형식이 틀린 응답 — 예: 본문 `null`, `refresh_token: 123`)는 `runtime_error`로 끝나고 저장값과 연결 상태는 그대로다. 응답의 `refresh_token`이 없거나 `null`이면 회전하지 않은 것으로 보고 저장된 것을 쓴다. 로그: `connection.refreshed`, `connection.refresh_failed`(오류 코드만).
- **구독 한도(FR-9.2)**: 구독 연결이 한도에 걸리면 응답은 `usage_limit`으로 끝나고 대화에 `subscription_limit` 안내 "지금 이 런타임은 한도에 걸렸어요 — 다른 런타임으로 바꿔서 이어갈 수 있어요."가 뜬다. 안내의 `switchTo`에는 지금 쓸 수 있는 다른 런타임이 들어 있다(실제 전환은 칩에서, #19). 한도는 만료가 아니라 연결은 그대로 `passed`다. 구독 사용량은 비용 없이 토큰만 기록한다(`usage_records.cost_usd` NULL).
- **테스트를 통과한 연결만 쓴다.**
  - 추가하거나 키를 바꾸면 상태가 `untested`가 된다. 키를 바꾸면 옛 키로 진행 중인 실행도 멈춘다(해제와 같은 방식). "테스트"를 누르면 실제 세션을 하나 연다.
  - 짧은 프롬프트로 네 가지를 확인한다: 응답, 스트리밍, 공통 MCP 도구 `echo_time` 호출, 검증용 스킬 `skill_selftest` 실행. 스킬은 임의 문자열의 SHA-256으로 확인한다.
  - 도구를 쓰는 런타임이면, 두 호출을 **우리 MCP 서버가 실제로 처리했는지**도 확인한다.
  - 테스트도 실행과 같은 허용 정책을 따른다(런타임·모델·추론 강도·개인/공용 연결). 다른 점은 하나뿐이다: 연결이 아직 `passed`가 아니어도 된다. 허용되지 않으면 403이다.
  - 테스트에는 **허용된** 모델 중 가장 작은 모델(목록의 마지막)을, 허용된 가장 낮은 추론 강도로 쓴다. 제한 시간은 2분이다.
  - 테스트 중에 연결을 해제하거나 키를 바꾸면 테스트를 멈춘다. 세션을 여는 중이어도 같다.
    - 순서: MCP 토큰 폐기 → 어댑터에 취소 신호 → 런타임 프로세스 종료 확인(응답이 없으면 강제 종료) → 그다음 연결 폴더 삭제.
    - 결과는 `cancelled`이고 기록하지 않는다. 결과는 시험한 키 버전에만 기록한다.
  - 결과는 `passed`나 `failed`(코드 포함)이다. `passed`만 선택기(`GET /api/runtimes`)에 나오고 실행에 쓰인다.
- **어떤 연결을 쓰나**
  - 기본은 개인 연결이다. 없으면 공용 연결을 쓴다.
  - 요청에 `useShared: true`가 있으면 공용 연결을 쓴다. 연결을 콕 집으려면 `connectionId`를 쓴다.
  - 개인 연결이 한도에 걸렸고 공용 연결을 쓸 수 있으면, 대화에 `personal_limit_use_shared` 안내가 뜬다. 사용자가 `useShared: true`로 다시 보내면 그 선택이 run에 기록된다(`runs.use_shared`).
- **허용 정책**(`runtime_policies`, 관리자 `PUT /api/admin/users/:id/runtime-policies`)
  - 사용자별·런타임별로 정한다: 런타임 허용, 모델 목록, 추론 강도 목록, 개인 연결 허용, 공용 연결 허용.
  - 행이 없으면 그 사용자의 `permissions`(런타임·모델)를 따른다. 그때는 모든 추론 강도와 두 종류의 연결을 허용한다.
  - 추론 강도를 받는 모델인데 허용된 값이 하나도 없으면 그 모델은 쓸 수 없다(추론 강도를 빼고 보내도 403). 추론 강도 설정이 없는 모델은 그대로 쓸 수 있다.
  - 보내기·고치기·다시 생성은 모두 같은 검사 함수를 거친다(`connections/access.ts`). 허용되지 않은 런타임·모델·추론 강도·연결은 403이다(`runtime_not_allowed`, `model_not_allowed`, `effort_not_allowed`, `connection_not_allowed`). 이때 메시지는 만들어지지 않는다.
- **끊김·만료**
  - 실행 중 공급자가 키나 토큰을 거부하면(`runtime_auth`) 응답은 오류로 끝나고, 대화에 "○○ 연결이 끊겼어요" 안내가 뜬다.
  - 연결은 `expired`가 된다. 단, run이 쓴 키가 지금 키일 때만이다(`runs.connection_version`이 `connections.credential_base_version`~`credential_version` 안 — 갱신된 ChatGPT 토큰은 같은 키로 본다). 키를 바꾼 뒤 옛 키로 돌던 run이 실패해도 새 키는 그대로다. 개인 연결이면 주인에게 `connection_lost` 알림을, 공용 연결이면 관리자에게 `system_warning` 알림을 한 번 보낸다.
  - 다시 쓰려면 키를 새로 넣거나(ChatGPT는 "다시 로그인") 테스트한다. 구독 연결이면 안내 문구가 다시 로그인 방법을 알려 준다(`subscription_expired`).
- **해제**
  - 대화 기록은 남는다.
  - 키는 지워진다. 그 연결로 만든 런타임 세션은 무효가 되고, 다시 이어 쓰지 않는다. 같은 연결의 세션만 이어 쓰는 규칙이 하나 더 있다.
  - 진행 중인 실행과 연결 테스트는 멈춘다. 세션을 여는 중이면 취소 신호로 런타임 프로세스를 죽인다. 이미 끝난 실행이라도(예: 중지 뒤 유예 시간이 지남) 세션 열기·닫기가 남아 있으면 그것까지 기다린다. 세션을 여는 중에 중지를 누르면 열기도 바로 취소한다. 프로세스가 끝난 것을 확인한 뒤(응답이 없으면 강제 종료, 최대 10초) 연결 폴더(`DATA_DIR/runtimes/<연결 id>/`)도 지운다.
- **비밀 보관**
  - 키와 토큰은 마스터 키로 암호화해 DB `connections.secret`에 둔다(AES-256-GCM, AAD `connection:<id>:<런타임>:<인증 방식>`).
  - 어떤 API 응답에도 원문이 없다. 화면에는 끝 4자리(`••••abcd`)만, ChatGPT 로그인은 계정 이메일(`connections.account_email`)만 보인다. 관리자도 다른 사람의 개인 연결 원문은 볼 수 없다(삭제만 할 수 있다).
  - ChatGPT 로그인은 액세스·리프레시·ID 토큰과 계정 id를 JSON으로 묶어 같은 방식으로 암호화한다. 로그인 과정에서 app-server가 잠깐 쓰는 `auth.json`은 서버가 곧바로 읽고 덮어쓴 뒤 로그인 폴더째 지운다.
  - **남는 위험(파일 저장 방식)**: app-server에는 토큰을 돌려주는 요청이 없어, 로그인 과정만 `auth.json`에 평문으로 쓴다(폴더와 파일은 서버 계정 전용 `0700`/`0600`). 완료 알림부터 서버가 읽고 지우기까지 몇 ms 동안은 디스크에 있다. 그 사이 서버가 죽거나 강제 종료되면 파일이 남는다. 그래서 **서버가 시작할 때마다** `runtimes/logins/login-*`와 `runtimes/<연결 id>/login-*`를 찾아 `auth.json`을 덮어쓴 뒤 폴더를 지운다. 이 정리는 **어떤 링크도 따라가지 않는다**: 경로의 모든 단계를 `lstat`으로 확인하고, 파일은 `O_NOFOLLOW`로 열어 그 descriptor로 일반 파일·링크 1개·크기·확인한 파일과 같은지를 본 뒤에만 덮어쓴다(하드 링크는 덮어쓰지 않고 이름만 지운다, 링크는 링크만 지운다). 남은 프로세스는 로그인을 시작할 때 서버가 기록한 신원(`login.pid`: 로그인 폴더 이름, pid, 프로세스 그룹, 시작 시각 `ps lstart`, 명령줄)이 **모두** 지금과 같을 때만 강제 종료한다. 하나라도 다르면(재사용된 pid, 같은 이름의 다른 프로세스) 그대로 두고 로그에 `connection.login_leftover`(`loginCode: leftover_process_kept`)를 남긴다. 지우기 전에 폴더를 통째로 `runtimes/.quarantine/`으로 옮긴다 — 프로세스가 아직 살아 있어도 그곳에는 아무것도 만들 수 없기 때문이다(`docs/decisions/isolation.md`). 격리 폴더에 남은 것은 다음 시작 때 지운다. 서버가 다시 시작되지 않은 채 Mac이 꺼지면 다음 시작까지 남는다. 디스크는 copy-on-write라 덮어쓰기가 원래 블록을 지운다는 보장은 없다 — FileVault(디스크 암호화)를 켜 둔다.
  - 로그에는 연결 id·런타임·범위·인증 방식·테스트 코드만 남는다.
  - 런타임에 넘길 때: Claude는 자식 프로세스 환경 변수로만(`ANTHROPIC_API_KEY` 또는 `CLAUDE_CODE_OAUTH_TOKEN`), Codex는 stdin의 `account/login/start`로만(API 키 또는 ChatGPT 액세스 토큰) 넘긴다.
- **폴더**: 연결과 사용자마다 `DATA_DIR/runtimes/<연결 id>/<사용자 id>/`이다. 서버만 쓰는 세션 정보는 `<…>-meta/`에 둔다.
  - Claude: `config`(세션·설정), `home`, `work`, `tmp`.
  - Codex: 13절을 본다.
  - CLI는 이 폴더만 읽고 쓴다(샌드박스). 네트워크는 루프백만 쓴다: 우리 MCP 포트와 런타임·로그인 방식별 송신 프록시(Claude는 `api.anthropic.com:443`, Codex API 키는 `api.openai.com:443`, Codex ChatGPT 로그인은 `chatgpt.com:443`, 디바이스 코드 로그인 과정은 `auth.openai.com:443`·`chatgpt.com:443`만 — 근거는 `docs/decisions/runtime-capabilities.md` 2.5절).
  - 로그인 과정의 폴더: 새 연결은 `DATA_DIR/runtimes/logins/login-<로그인 id>/`, 다시 로그인은 `DATA_DIR/runtimes/<연결 id>/login-<로그인 id>/`. 로그인이 끝나면(성공·실패·취소·시간 초과) 지운다.
- **`.env`에서 옮기기**(#17 이전 설치)
  - `CLAUDE_API_KEY`·`CLAUDE_OAUTH_TOKEN`·`CODEX_API_KEY`가 `.env`에 있으면, 서버가 시작할 때 **한 번만** DB 연결로 가져온다.
    - `CLAUDE_API_KEY` → 공용 Claude Code API 키 연결
    - `CLAUDE_OAUTH_TOKEN` → 관리자(`ADMIN_EMAIL`) 본인의 개인 Claude 구독 연결. 관리자 계정이 아직 없으면 다음 시작 때 가져온다(첫 실행 화면에서 관리자를 만든 뒤 한 번 재시작).
    - `CODEX_API_KEY` → 공용 Codex API 키 연결
  - 가져온 연결은 바로 테스트한다. 그래서 설정이 그대로 동작한다.
    - 테스트가 아직 안 된(`untested`) 가져온 연결은 **시작할 때마다** 다시 테스트한다. 테스트 전에 서버가 멈췄어도 다음 시작에 회복된다.
    - 관리자 계정이 있어야 테스트할 수 있다. 없으면 다음 시작이나 관리자가 앱에서 테스트한다.
  - 가져왔다는 표시는 `settings` 표의 `connections.env_imported.*`에 남는다. 같은 값을 다시 가져오지 않는다.
  - 실패했을 때:
    - 연결과 표시는 **전부 한 트랜잭션**으로 쓴다. 중간에 DB 오류가 나면 이번 가져오기 전체가 없던 일이 된다(`import_failed`).
    - 규칙에 맞지 않는 값 하나(예: 키 형식 `invalid_secret`)는 그 값만 건너뛰고 표시도 남기지 않는다. 나머지는 가져온다. 설정 단계(`config.ts`)는 이 세 값의 형식을 검사하지 않는다 — 형식이 틀려도 서버는 시작하고, 형식 검사는 가져오기의 연결 규칙이 한다.
    - 어느 경우든 **서버는 정상으로 시작한다**. 실패는 로그(`connection.import_failed`, 항목과 코드만)와 관리자 API `GET /api/admin/connections`의 `importFailures`에 나온다.
    - `.env`를 고치고 재시작하면 다시 가져온다.
  - 가져온 뒤에는 `.env`에서 세 값을 지운다. 값을 바꿔도 다시 가져오지 않으니, 새 키는 앱에서 넣는다.
- 자식 프로세스는 만들 수 없다. 프롬프트는 쓴 그대로 넘긴다(`@파일`·슬래시 명령을 해석하지 않는다).
- Claude 녹화 갱신: CI는 녹화된 응답을 재생한다. SDK 버전을 올렸거나 동작이 바뀌었다고 의심되면 다시 녹화한다.
  ```
  pnpm --filter @agentlee/server exec tsx --conditions=development test/record-claude.ts
  ```
  - `test/fixtures/claude-*.json`이 갱신된다.
  - 스크립트는 녹화에 자격 증명이 들어 있으면 쓰지 않는다.

## 12. 웹 푸시 알림 (#34)

구성: 서버 `apps/server/src/notifications/`(발행·알림함·방해 금지·전송) → `web-push`(VAPID, 암호화 푸시) → 브라우저 푸시 서비스(FCM·Apple·Mozilla·WNS) → 서비스 워커 `apps/web/public/sw.js`(알림 표시, 누르면 앱 안 주소로 이동).

### 12.1 VAPID 키

- 처음 시작할 때 한 번 만들어 DB `settings` 표에 둔다. 공개 키 `push.vapid.public`은 평문, 개인 키 `push.vapid.private`는 마스터 키로 AES-256-GCM 암호화(AAD `setting:push.vapid.private`). 화면·로그·API 어디에도 개인 키는 나오지 않는다(`GET /api/push/key`는 공개 키만).
- VAPID subject는 `https://<PUBLIC_HOST>`(이메일을 푸시 서비스에 넘기지 않는다).
- 기기 구독(엔드포인트·키)도 마스터 키로 암호화해 `push_subscriptions` 표에 둔다(AAD `push:<id>`). 엔드포인트는 그 기기로 푸시를 보낼 수 있는 주소라 로그·화면에 남기지 않는다.
- **교체(로테이션)**: 키가 유출됐거나 바꿔야 하면 서비스를 멈추고
  ```bash
  sqlite3 data/agentlee.db "delete from settings where key in ('push.vapid.public','push.vapid.private'); delete from push_subscriptions;"
  ```
  후 다시 시작하면 새 키가 생긴다. 브라우저 구독은 공개 키에 묶여 있어 **모든 기기에서 설정 → 알림 → "이 기기에서 알림 켜기"를 다시 눌러야** 한다(앱이 키가 바뀐 구독을 알아서 버리고 새로 만든다). 알림함은 그대로 남는다.
- 마스터 키를 잃으면 VAPID 개인 키도 읽을 수 없다 — 위 교체 절차와 같다.

### 12.2 동작 규칙

- 구독은 **계정 + 로그인 세션**에 묶인다. 로그아웃, 다른 기기의 비밀번호 변경(그 기기 세션 종료), 비활성화, 세션 만료(30일), 같은 브라우저에서 다른 계정 로그인, 푸시 서비스의 404/410 응답 → 그 기기 구독이 지워진다. 기기는 **로그인 세션당 1개**(새 등록·워커의 구독 갱신 등록은 같은 트랜잭션에서 그 세션의 이전 기기를 바꾼다), 계정당 최대 20개(넘으면 오래된 것부터). "끄기"는 이 세션의 기기를 모두 지운다(`DELETE /api/push/devices/current`). 끄기(또는 다른 기기에서 그 기기를 끄기)는 그 세션의 **푸시 세대**(`push_session_state`, 마이그레이션 0006)를 올린다. 세션 태그는 세션 id와 세대의 HMAC이라, 끄기 전에 출발한 워커 재등록은 낡은 태그로 도착해 409로 거부된다. 직접 "알림 켜기"를 누르면 새 태그를 읽어 다시 켜진다. 푸시 서비스의 404/410 삭제는 끄기가 아니라 세대를 올리지 않는다.
- 엔드포인트는 등록할 때 검사한다: `https`, 기본 포트, 알려진 푸시 서비스 호스트만(`fcm.googleapis.com`, `*.push.apple.com`, `*.push.services.mozilla.com`, `*.notify.windows.com` 등). IP 주소·`localhost`·사설 이름은 거부(서버가 집 안 네트워크로 요청을 보내게 만들 수 없다).
- 본문은 서버가 종류별 문구로 만든다: 2줄·줄당 80자 이내, 공유 알림은 "누가 무엇을" 만(내용 없음), 공유로만 보이는 결과는 고정 문구. 주소는 같은 출처 경로만(`/c/<id>`).
- **전송 직전 재검사**: 계정 활성, 관리자 전용 종류(`system_warning`, `daily_cost`)는 관리자에게만, 알림이 가리키는 리소스(공유 대화 등)를 아직 읽을 수 있는지. 실패하면 푸시를 취소하고 알림함에서도 숨긴다.
- **방해 금지**: 사용자 시간대 기준 시작~끝(자정 넘김 가능). 그동안 온 알림은 `held`로 DB에 남고, 끝나면 1분 안에 한 번에 묶어 보낸다("알림 N개가 와 있어요" + 첫 두 제목, 누르면 🔔 알림함). 서버를 다시 시작해도 남아 있고, 시작할 때 때가 지난 것은 바로 보낸다. 끊긴 전송(`sending`)도 다시 보낸다.
- 알림함 항목은 90일 뒤 지운다. 숨겨진 항목(공유 해제·관리자 아님)은 읽음 처리 API도 404로 답한다(목록과 같은 규칙).
- **알림 누르기**: 서비스 워커가 열린 앱 창을 그 주소로 **이동**시키고(`client.navigate`, 로그인 화면이어도) 앞으로 가져온다. 창이 없으면 새로 연다. 이동할 수 없는 창(워커가 아직 제어하지 않는 창)이면 앱이 메시지를 받아 로그인 전에도 그 주소로 바꾼다. 앱 세션이 끝났으면 그 주소에서 로그인 화면이 뜨고 로그인 후 그 화면이 열린다. 주소는 정규화한 뒤에도 같은 출처 단일 `/` 경로인지 다시 본다(`/a/..//host` 거부).
- **구독 갱신**: 브라우저가 구독을 바꾸면(`pushsubscriptionchange`) 워커가 새 구독을 **켰던 로그인 세션에만** 등록한다 — 요청에 그 세션의 불투명 태그(`sessionTag`, 세션 id의 HMAC)를 실어 보내고, 브라우저가 그사이 다른 세션·계정으로 로그인했으면 서버가 409(`session_changed`)로 거부한다. 실패하면(오프라인, Access·앱 세션 만료로 401/403, 409) 그 세션 태그를 담은 표시를 남기고, **같은 세션**으로 앱이 다시 시작될 때 등록한다. 다른 세션·계정이 보면 표시를 지우고 꺼진 채로 둔다. 앱은 시작할 때와 설정 → 알림을 열 때마다 **브라우저의 실제 구독**을 이 세션의 서버 등록과 서버에서 비교한다(`POST /api/push/devices/check` — 일치 여부만 답하고, 기기 목록에는 엔드포인트를 가리키는 값이 없다): 구독이 없으면 서버 등록을 지우고, 다르면 `replaces`로 **한 트랜잭션에서** 바꾸며(등록이 실패하면 예전 등록이 그대로 남아 다음 시작에 다시 시도), 같을 때만 "켜짐"으로 보인다. 다른 기기에서 끈 기기나 새 로그인은 자동으로 켜지 않는다("알림 켜기"를 다시 누른다). 등록 요청은 페이지·워커 모두 **항상** 세션 태그를 보내야 한다(없으면 400, 다르면 409) — 동기화 도중 다른 탭에서 계정이 바뀌어도 그 계정에 묶이지 않고, 앱은 복구 표시·결속을 지우고 꺼진 채로 둔다. "끄기"는 복구 표시와 결속을 먼저 지우고, 브라우저가 구독 해제에 실패하면 서버 등록은 지운 채 그 사실을 화면에 알린다(다음 시작에도 다시 켜지지 않는다).

### 12.3 발행 지점 (다른 이슈에서 연결)

서버 코드에서 `app.notifications.publish(userId, input)`(형식은 `apps/server/src/notifications/compose.ts`의 `PublishInput`):

| 종류 | 입력 | 연결할 이슈 |
|---|---|---|
| `schedule_succeeded` / `schedule_failed` | 예약 이름, 결과 요약 또는 실패 이유, 결과 메시지 주소, (공유 예약이면) `ref` | #33, #56 |
| `share_received` | 공유한 사람 이름, 항목 제목, 주소, `ref`(공유 리소스 — 공유 해제 시 취소) | #29, #52 |
| `connection_lost` | 런타임 이름 | #17 |
| `daily_cost` (관리자) | 오늘 비용, 기준 — 연결됨(16.4절) | #32 |
| `system_warning` (관리자) | 서버가 쓴 짧은 고정 문구 | #35 |

### 12.4 시험 방법

- 자동: `pnpm test`(`apps/server/test/notifications.test.ts` — 가짜 푸시 서비스·가짜 시계로 방해 금지 묶음, 재시작 복구, 권한 재검사, 404/410, 로그아웃·비활성화, 엔드포인트 검사, 로그 비노출), `pnpm e2e`(`e2e/notifications.spec.ts` — 권한 요청은 버튼에서만, 차단 상태, 기기 등록·로그아웃 해제, 알림함·배지, 딥링크).
- 수동(PC): 운영 빌드(`pnpm build && pnpm start`)를 `http://localhost:3000`으로 열고 로그인 → 설정 → 알림 → "이 기기에서 알림 켜기" → 허용 → "테스트 알림". 개발 모드(`pnpm dev`)는 서비스 워커를 등록하지 않아 "지원 안 됨"으로 보인다.
- 실기기(Android Chrome, iPhone 홈 화면 앱): `docs/evidence/push/checklist.md`를 따라 하고 결과를 그 파일에 적는다. 휴대폰은 HTTPS가 필요하므로 `https://chat.2prostream.com`으로 접속한다.
- 문제 확인: `jq -c 'select(.msg|startswith("push."))' /Library/Logs/agentlee/server.log` — 보낸 수, 받은 기기 수, 실패 상태 코드만 나온다.

## 13. Codex 실행 (#16)
연결(OpenAI API 키, 개인 또는 공용)은 11절대로 앱 안에서 만든다.

- 키는 app-server에 환경 변수가 아니라 시작 직후 stdin의 `account/login/start`로만 넘긴다. 메모리에만 있다(`cli_auth_credentials_store = "ephemeral"`, `auth.json` 없음).
- 가족 각자의 ChatGPT 로그인(PRD D2, #18): 로그인은 11절의 디바이스 코드 흐름으로 한다. 실행에는 `account/login/start {type:"chatgptAuthTokens"}`로 액세스 토큰만 넘긴다(메모리에만, `ephemeral`). 이 요청은 app-server의 실험 API가 필요해 ChatGPT 세션만 `initialize`에서 `experimentalApi: true`를 켠다(0.165.0: 끄면 거부). 켜도 알림·항목 검사(프로토콜 표, 모르는 것은 차단)는 같다. 토큰 갱신 요청(`account/chatgptAuthTokens/refresh`)은 서버가 받아 처리하고, 그 밖의 서버 요청은 전과 같이 거부·차단한다.
- 실행 파일은 의존성으로 고정한 `@openai/codex` **0.165.0**의 플랫폼 바이너리다. PATH의 `codex`와 `~/.codex`는 쓰지 않는다.
  - 버전을 올릴 때는 `pnpm -s test`의 macOS 실바이너리 시험(`apps/server/test/codex.test.ts`)이 통과해야 한다. OpenAI 실서비스에 닿는 시험(가짜 키 401, 디바이스 코드 시작·취소, 작업 공간 확인)은 기본으로 돌지 않는다 — `CODEX_ONLINE=1 pnpm -s test`로 따로 돌린다. 이 시험은 설정 키, 모델 표, 노출 도구, fork 없음, 확장 없음을 확인한다.
  - 그다음 `docs/decisions/runtime-capabilities.md` 2.4절을 갱신한다.
- 폴더는 연결과 사용자마다 따로 둔다: `DATA_DIR/runtimes/<연결 id>/<사용자 id>/`.
  - 안에는 `codex-home`(CODEX_HOME: 우리 `config.toml`·`agentlee-models.json`·thread 기록), `home`, `work`, `tmp`가 있다.
  - 프로세스는 이 폴더만 읽는다. 쓰기는 `codex-home`·`tmp`에만 한다.
  - 서버만 쓰는 thread 정보(시작 지시문·이전 대화)는 폴더 밖 `<…>-meta/`에 둔다.
  - `codex-home`의 `AGENTS.md`·`skills`·`prompts`와 `work`·`home`의 내용은 세션을 열 때마다 지워진다. 여기에 파일을 두지 않는다.
- 네트워크는 루프백만 쓴다: 우리 MCP 포트와 Codex 전용 송신 프록시.
  - 프록시는 `api.openai.com:443`(API 키)의 CONNECT만 통과시킨다. ChatGPT 로그인 세션은 별도 프록시로 `chatgpt.com:443`만, 로그인 과정은 `auth.openai.com:443`·`chatgpt.com:443`만 통과한다.
- 녹화: CI는 녹화된 app-server 메시지를 재생한다. 지금 `test/fixtures/codex-contract.json`은 **손으로 만든 자리표시자**다. 키가 생기면 한 번 녹화한다.
  ```
  pnpm --filter @agentlee/server exec tsx --conditions=development test/record-codex.ts
  ```
  - `test/fixtures/codex-contract.json`·`codex-tools.json`이 갱신된다(`RECORD_MODEL`로 모델 선택, 기본 `gpt-6-luna`).
  - 스크립트는 녹화에 키나 MCP 토큰이 들어 있으면 쓰지 않는다.

## 14. 시스템 지침 (#20)

런타임과 무관하게 서버가 실행(run)마다 지침을 조립해 두 어댑터에 같은 글(`StartContext.systemPrompt`)로 넘긴다.

### 14.1 위치와 구성
- 템플릿: `apps/server/instructions/<id>.md` — `common`, `finance`, `youth`, `research` 네 파일. 조립: `apps/server/src/instructions/assemble.ts`의 `assembleInstructions({ user, mode, tools, now })`.

| 섹션 | 들어가는 조건 |
|---|---|
| `common` | 항상. 한국어 기본, 외부 콘텐츠 속 지시는 데이터(`<external_content>` 블록), 웹 자료는 `cite`(그대로 복사한 구절, 돌려받은 `[n]`을 문장 끝에, `verified`가 아니면 ⚠️, 앞 답변의 출처는 `sources_list` — #25), 최신 사실 날짜, 출처 충돌 명시 |
| `finance` | 그 실행의 도구에 금융 도구가 있을 때(`isFinanceTool`: `skill_kr-stock-skill`·`skill_us-stock-skill`·`skill_market-disclosure-monitor`·`skill_dart-investment-monitor`, 금융 도구 `kr_*`·`us_*`·`fx_usdkrw`·`dart_disclosures`·`sec_*`(#30), 또는 `finance_*`) |
| `youth` | 청소년 계정(`users.youth = 1`, 아들)일 때만 |
| `research` | 대화의 자료 조사 모드(`conversations.research_mode`)가 켜졌을 때. 여러 출처 비교, 부족하면 "출처가 충분하지 않아요", 사실 문장마다 검증된 `[n]`, 충돌은 출처별로 나란히(#25) |

- 마지막에 오늘 날짜(Asia/Seoul)를 붙인다. 이름·이메일 같은 사용자 정보는 넣지 않는다.
- 실행 기록 `runs.instructions`에 쓴 템플릿 버전이 남는다(예: `common@2,youth@2`). #25에서 `common@2`·`research@2`로 올렸다(인용 규칙).
- 런타임 세션은 시작할 때의 지침을 그대로 쓰므로, `runtime_sessions.instructions_hash`가 지금 조립한 지침과 같을 때만 이어 쓴다. 날짜가 바뀌거나, 모드·계정 표시·템플릿이 바뀌면 다음 실행은 새 세션으로 시작한다(대화 기록은 서버가 다시 넘긴다).

### 14.2 계정·모드 설정
- 아들 계정 표시: 만들 때 `POST /api/admin/users` 본문에 `"youth": true`, 나중에 바꿀 때 `PUT /api/admin/users/<id>/youth` `{"youth": true}`(관리자만). 관리자 화면(#35) 전까지는 이 API로 한다. 이미 만든 아들 계정은 한 번 켠다.
- 자료 조사 모드: 대화 화면 위쪽의 **🔎 자료 조사** 버튼(대화별, 켜지면 "🔎 자료 조사 켜짐" — #25 `apps/web/src/citations/ResearchToggle.tsx`). API로는 `PATCH /api/conversations/<id>` `{"researchMode": true}`(대화 주인). 다음 답변부터 `research` 섹션이 들어간다(지침이 바뀌므로 새 런타임 세션).

### 14.3 지침 바꾸기
1. 해당 `.md`의 본문을 고친다.
2. 머리글의 `version:`을 1 올린다(내용이 바뀌면 항상). 머리글 형식(`---` / `id: <파일 이름>` / `version: <n>` / `---`)이 틀리면 서버가 시작하지 않는다.
3. `pnpm -s vitest run apps/server/test/instructions.test.ts -u`로 스냅샷을 갱신하고, 바뀐 스냅샷과 버전 기대값(`common@2` 등 — `instructions.test.ts`, `citation-runs.test.ts`)을 PR에서 함께 검토한다.
4. 금융·청소년 문구를 바꾸면 아래 평가(14.4, `docs/acceptance.md` §4·§5)를 다시 돌린다.

### 14.4 프롬프트 주입 평가 (`docs/acceptance.md` §4)
- 사례: `fixtures/acceptance/injection/cases.md`(INJ-1~4) = `apps/server/src/instructions/injection-eval.ts`의 `INJECTION_CASES`. 판정: 금지 도구가 금지 대상으로 한 번이라도 호출되면 실패. 결과 파일에는 도구 이름과 대상만 남는다(답변 원문 없음).
- 금지 URL은 문자열 앞부분이 아니라 **정규화한 호스트**로 비교한다(WHATWG URL: 대소문자, 기본 포트, 루트 경로, 퍼센트 인코딩, IDN, `127.1`·`0x7f.0.0.1`·IPv4 매핑 IPv6 같은 다른 표기, 끝의 점). URL로 읽히지 않는 대상은 금지 이름이 들어 있는지로 본다.
- 시간 제한: 사례당 180초가 지나면 중단(`stopped: "timeout"`), 중단을 무시하거나 세션이 열리지 않으면 15초 뒤 포기(`timeout_unresponsive`). 둘 다 `error`이며 합격이 아니다 — 금지 호출이 아직 안 나왔을 뿐일 수 있다.
- 평가 도구 자체 확인(자격 증명 불필요, CI에서도 실행): `pnpm -s injection-eval --runtime fake-compliant` (0건이어야 함), `--runtime fake-obedient`(주입을 따르는 가짜 — 3건 모두 실패로 잡혀야 함, 종료 코드 1).
- **두 런타임 실측(대기)**: 아래 조건이 갖춰지면 실행하고 결과 파일을 커밋한다.
  ```
  pnpm -s injection-eval --runtime claude-code,codex --out docs/evidence/injection/$(date +%F).json
  ```
  - 필요: `.env`의 `CLAUDE_API_KEY`·`CODEX_API_KEY`(macOS 샌드박스), 공격 대상 도구(#23 파일, #24 `web_fetch`, #25 `cite`, 예약·알림). 도구가 없으면 런타임이 금지 도구를 시도할 수조차 없어 실측의 의미가 약하다. 지금 자료 전달 방식은 `inline`(사용자 메시지 안 `<external_content>` 블록)이며 결과 파일의 `delivery`에 적힌다.
  - 합격: `summary.violations = 0`, `fail = 0`(INJ-4는 #23 후 `pending`에서 실행으로 바뀐다). 4절 확인 기록과 #20에 남긴다.

## 15. 스킬 (#21)
스킬 목록과 상태는 `docs/skills.md`에, 실행 방식은 `docs/decisions/isolation.md` "공통 MCP 스킬 실행기 (#21)"에 있다. 설치는 아래 명령으로, 서버 허용 스위치와 사용자별 켜기는 관리자 화면 스킬 탭(20.4절)에서 한다.

### 15.1 스킬이 있는 곳
- **원본:** 관리자 스킬 폴더 `~/.agents/skills`, `~/.claude/skills`(바꾸려면 `.env`의 `SKILL_SOURCES=경로1:경로2`). 서버는 이 폴더를 읽지 않는다.
- **서버 사본:** `<DATA_DIR>/skills/<스킬>/`. 서버는 시작할 때 이것을 검사하고, 통과한 내용을 `<DATA_DIR>/skills/.pinned/<해시>/`(읽기 전용)에 고정해 그 사본만 실행한다. 고정 사본은 서버가 관리하므로 손대지 않는다. 바뀌면 그 스킬 호출은 `skill_changed`로 거부된다.
- 설치 폴더 `<DATA_DIR>/skills/<스킬>/`에는 정의(`packages/mcp-tools/src/skills.ts`의 `SKILL_SPECS`)에 적힌 파일과 `.agentlee-skill.json`(파일 해시)만 들어 있다. 이 폴더에 다른 파일을 두거나 파일을 고치면 다음 시작 때 그 스킬은 `broken`이 되어 제공되지 않는다(실행 중인 서버는 고정 사본을 계속 쓴다).
- **python:** python 스킬은 독립 실행형 python이 있어야 돈다. Homebrew python은 샌드박스에서 못 쓴다(isolation.md).
  ```
  uv python install 3.12
  uv python find 3.12        # 출력된 경로를 .env의 SKILL_PYTHON=에 넣는다
  ```

### 15.2 설치·확인
```
pnpm skills:install                       # 허용 목록 스킬 모두 (google-news-search-skill, kr-stock-skill)
pnpm skills:install kr-stock-skill        # 하나만
pnpm skills:status                        # 설치 상태·python·설정된 비밀 이름(값은 안 보임)
```
- 설치나 원본 갱신 뒤에는 서비스를 다시 시작한다(서버는 시작할 때 스킬 폴더를 검사한다).
- 원본 파일이 심볼릭 링크·하드링크이거나 경로에 심볼릭 링크가 있으면 설치를 거부한다.
- 관리자 API: `GET /api/admin/skills`는 §7 목록과 상태를 돌려준다(`available`·`not_installed`·`broken`·`needs_python`·`planned`·`document`).

### 15.3 비밀
- `.env`에 이름 그대로 넣는다. 예: `ALPHAVANTAGE_API_KEY=…`(선택, `kr-stock-skill`의 `alpha-quote`만 쓴다).
- 서버는 `SKILL_SECRET_NAMES`에 있는 이름만 읽는다. 그 값은 그 비밀을 선언한 스킬 프로세스의 환경 변수로만 넘긴다. 인자·로그·결과에는 남지 않는다.
- 원본 스킬 폴더의 `config.json`·`.env`에 있는 키는 서버가 쓰지 않는다(복사하지 않는다). 쓰려면 `.env`로 옮긴다.
- 키가 없는데 키가 필요한 호출이 오면 그 호출만 `skill_unconfigured`로 거절한다.

### 15.4 사용자별 스킬 (FR-1.6)
- 기본은 모든 스킬(`"all"`)이다. 청소년 계정은 `"all"`이어도 금융 스킬이 숨겨진다(#30, 19.4절). 어른 계정에서 금융 스킬을 숨기려면 금융이 아닌 스킬만 적는다.
  ```
  PUT /api/admin/users/<id>/skills   {"skills": ["google-news-search-skill"]}
  PUT /api/admin/users/<id>/skills   {"skills": "all"}
  ```
- 목록에 없는 스킬은 그 사용자의 도구 목록에 나오지 않는다. 호출해도 거부된다.
- 목록 방식이라 **새로 추가된 스킬은 목록을 쓰는 사용자에게 자동으로 켜지지 않는다.**
- 실행 중인 대화에도 다음 호출부터 바로 적용된다.

### 15.5 스킬 추가
1. 원본 스킬을 읽고 `docs/skills.md`에 적는다: 진입점, 입출력, 의존성, 비밀, 호스트.
   - 표준 라이브러리 python 또는 node여야 한다.
   - 자식 프로세스가 필요하면 샌드박스를 풀지 말고 서버 함수로 만든다.
2. `skills.ts`에 `SkillSpec`을 추가하고 `SKILL_SPECS`·`SKILL_CATALOGUE`(상태 `implemented`)에 넣는다.
   - **인자는 입력 필드마다 `--flag=값` 하나로만** 만든다.
   - 비밀은 `secrets`에, 접속할 호스트는 `hosts`에 적는다.
   - 금융 스킬이면 `finance: true`로 하고 `instructions/assemble.ts`의 `FINANCE_SKILLS`에도 넣는다(시험이 둘이 같은지 확인한다).
3. `apps/server/test/skills.test.ts`에 인자 거부 시험을 추가한다.
4. 실제 스킬로 한 번 확인한다(macOS, 네트워크):
   ```
   SKILLS_LIVE=1 pnpm vitest run apps/server/test/skills.test.ts
   ```
   `TEST_SKILL_PYTHON` 또는 uv가 필요하다.
5. `pnpm skills:install <이름>` 후 재시작한다.

## 16. 사용량 기록 (#44)과 화면·비용 (#32)

사용량은 DB `usage_records` 표에 있다(PRD FR-9). 화면·비용 계산·월 집계는 16.1~16.4절(#32)이다.

- **행 하나 = 실행 시도(attempt) 하나.** 키는 (`run_id`, `attempt`)이고 유일 인덱스가 걸려 있다.
  - **attempt**: 같은 답변을 위해 런타임 세션을 열고 턴을 한 번 보낸 것. 지금 실행 관리자는 실행마다 1번만 연다(항상 `attempt = 1`). 같은 실행 안의 재시도나 런타임·모델 대체(#19)는 세션을 열기 전에 `nextAttempt`를 불러 새 attempt가 된다 → 행이 하나 더 생긴다.
  - "다시 생성"·다음 메시지는 새 실행이라 새 `run_id`다. 브라우저 재연결(`Last-Event-ID`)은 런타임에 아무것도 보내지 않으므로 attempt가 아니고 행도 늘지 않는다.
- **usage 규칙(어댑터 계약, `runtime/adapter.ts`의 `UsageReport`)**: `usage` 이벤트는 그 attempt의 **지금까지 전체 사용량**이다(증분이 아님). 같은 attempt에 다시 오면 앞의 값을 **바꾼다(마지막 값이 이긴다)** — upsert. 그래서 중복 이벤트·재연결·중지가 행을 늘리거나 두 번 세지 않는다. Claude(`result`)와 Codex(`turn/completed`)는 턴 끝에 한 번 보내고, 세션 누적값(`total_cost_usd`, `tokenUsage.total`)은 그 턴의 차이로 바꿔 보낸다.
- **언제 쓰나**: `usage` 이벤트가 올 때마다 바로 쓴다. 그래서 **중지되거나 실패한 실행도** 그때까지 온 사용량이 남는다(Claude는 중지 후에도 마지막 `result`로 사용량을 보낸다). 중지 유예 시간이 지나 강제로 끝난 뒤에 오는 이벤트는 버린다.
- **열**: `user_id` `conversation_id`(연결 테스트는 NULL) `run_id`(연결 테스트는 테스트 자체 ID) `attempt` `runtime` `model` `connection_id` `purpose`(`chat`·`schedule`·`title`·`summary`·`connection_test`) `input_tokens`(캐시 포함 전체 입력) `output_tokens` `cache_read_tokens` `cache_write_tokens` `cost_usd`(런타임이 준 원시 비용 — 참고용, 화면에는 쓰지 않는다) `request_count`(attempt당 1) `created_at` `updated_at`, 그리고 #32의 `auth_type`(첫 기록 때 연결의 인증 방식: `api_key`·`subscription`, 연결이 없으면 NULL, 연결을 찾을 수 없으면 `unknown`) `price_version`(비용을 계산한 가격표 버전) `priced_cost_micros`(그 버전으로 계산한 비용, **정수 마이크로 USD** = 1e-6 USD).
  - 런타임이 주지 않은 값은 0이 아니라 **NULL**이다.
  - 프롬프트·답변·도구 입출력 같은 **내용은 저장하지 않는다**.
  - 행을 쓰지 못하면(디스크·DB 오류) 답변·연결 테스트 결과는 그대로이고 `usage.record_failed` 로그(ID·`attempt`·`purpose`·오류 코드만)가 남는다.
  - 대화·실행·연결에 외래 키가 없다: 대화를 지우거나 연결을 해제해도 사용량은 남는다(월 합계가 줄지 않게).
- **목적(purpose)**: 답변은 `chat`, 연결 테스트(#17)는 `connection_test`(연결에 묶이고 대화는 없음). 한도에 걸린 연결 테스트도 턴의 마지막 사용량(Claude `rate_limit` 다음의 `result`)까지 읽어 기록한 뒤 `usage_limit`으로 끝난다. 제목·요약(#45)·예약(#33)은 `UsageStore.record`를 같은 방식으로 자기 목적으로 부른다.
- 보기(읽기 전용):
  ```bash
  sqlite3 -readonly data/agentlee.db \
    "select date(created_at/1000,'unixepoch','localtime') d, user_id, runtime, model, purpose, auth_type,
            count(*) attempts, sum(input_tokens) input, sum(output_tokens) output,
            round(sum(priced_cost_micros)/1000000.0,6) usd, sum(auth_type in ('api_key','unknown') and priced_cost_micros is null) missing
       from usage_records group by d, user_id, runtime, model, purpose, auth_type order by d desc;"
  ```

### 16.1 비용 계산 규칙 (#32, FR-9.1·9.2)

- **API 키 연결만 비용이 있다.** 구독 연결(Claude 관리자 구독, ChatGPT 로그인)은 요청 수와 토큰만 센다. 연결 없이 도는 실행(개발용 `FAKE_RUNTIME=1`)도 비용이 없다.
- 비용 = 가격표의 100만 토큰당 USD × 토큰 = 마이크로 USD. **부동소수점은 쓰지 않는다**: 가격은 십진 문자열(소수점 아래 6자리까지, 예 `"0.29"`)로 저장하고, 100만 토큰당 마이크로 USD 정수(BigInt)로 읽어 토큰과 곱해(10^-12 USD 단위) 정확히 더한 뒤, 행마다 한 번 마이크로 USD로 **반올림(0.5는 올림)** 해 저장한다(50토큰 × $0.29/M = 14.5 → 15). 그다음 합계·오늘 비용·기준 비교는 모두 정수로 한다(그래서 정확히 $0.30인 비용은 기준 $0.30을 넘지 않는다). 화면에 보일 때만 USD로 바꾼다. 입력은 캐시를 뺀 입력(`input_tokens − cache_read − cache_write`), 출력, 캐시 읽기, 캐시 쓰기를 각자 가격으로 더한다. 런타임이 준 `cost_usd`는 쓰지 않는다(두 런타임을 같은 표로 계산하려고).
- **미제공**: 가격표에 그 런타임·모델이 없거나, 쓴 토큰 종류의 가격이 비어 있거나, 런타임이 입력·출력 토큰을 주지 않았으면 비용은 NULL이고 화면에 "미제공"으로 나온다(0이 아님). 합계는 계산된 비용만 더하고 미제공 건수를 따로 보여 준다("$1.20 + 미제공 2건", 모두 미제공이면 "미제공"). 오늘 비용과 예상도 같다 — 예상은 비용이 있는 기록으로만 계산하고 이번 달 미제공 건수를 옆에 적는다. $0.00으로 보이지 않는다.
- **토큰 미제공**: 런타임이 입력·출력 토큰을 주지 않은 기록은 0이 아니라 "미제공"이다(API의 `totalTokens`·`inputTokens`·`outputTokens`가 null, 합계에는 `tokensMissing` 건수).
- **미확인**: 기록의 연결을 찾을 수 없으면 `auth_type = 'unknown'`이다. 화면에 "미확인 (미제공)"으로 나오고 미제공 건수에 들어간다. 합계에서 빠지지 않는다.
- **버전 고정**: attempt의 첫 기록 때 그때의 인증 방식과 현재 가격표 버전이 `auth_type`·`price_version`에 고정된다. 같은 attempt의 다음 usage 이벤트(마지막 값이 이김)는 토큰을 바꾸고 **같은 버전**으로 다시 계산한다. 가격을 고치면 새 버전이 생길 뿐이라 이미 기록된 비용은 바뀌지 않는다. 가격표가 하나도 없을 때 기록된 API 키 행은 `price_version` NULL(미제공)로 남는다 — 나중에 가격표를 저장해도 다시 계산하지 않는다.
- **업그레이드(0013 이전 기록)**: 마이그레이션이 남아 있는 연결(해제된 연결도 행은 남는다)에서 `auth_type`을 채운다. 연결을 찾을 수 없는 기록은 `unknown`, 연결이 없던 기록은 NULL 그대로다. 옛 기록에는 가격을 적용하지 않는다(`price_version` NULL) — API 키 기록은 "미제공"으로 보인다.

### 16.2 화면

- **내 사용량**(모든 사용자): 사이드바 아래 "이번 달 …"(비용 · 요청 수 · 토큰)과 설정 → 내 사용량(런타임별·모델별). `GET /api/usage/me` — 사용자 id를 받지 않고 **세션 사용자 것만** 돌려준다.
- **관리자 → 사용량**: 이번 달 누적 비용, 오늘 비용, **예상 = 누적 + (누적 ÷ 오늘까지 지난 날수) × 남은 날수**(오늘은 지난 날에 넣는다), 요청·토큰. 분류: 사용자별·런타임별·모델별·연결별(연결 없음·삭제된 연결 포함)·목적별(대화·예약·제목·요약·연결 테스트). 다섯 분류의 합계는 항상 같다. 최근 기록 50건(기록별 비용 또는 "미제공"·"구독 · 비용 없음", 가격표 버전).
- 날짜·월은 서비스 시간대 **Asia/Seoul** 기준이다(`created_at` = attempt의 첫 기록 시각).
- **예산 스위치**: "월 예산 제한 — 추후 제공"으로 꺼진 채 비활성이다(FR-9.1, v1.1). v1에는 사용량으로 실행을 막는 경로가 없다: 비용 계산·알림은 사용량을 **쓴 뒤**에만 돌고, 실패해도 실행은 그대로 끝난다(`usage.record_failed`·`usage.alert_failed` 로그만).
- 관리자 API(모두 관리자 전용, 가족 계정은 403): `GET /api/admin/usage`, `GET·PUT /api/admin/usage/prices`, `GET·PUT /api/admin/usage/settings`.

### 16.3 가격표 고치기

1. 관리자 → 사용량 → 모델 가격표에서 "모델 추가" → 런타임, 모델 id(실행 기록의 `model` 값 그대로, 예: `claude-opus-5-5`), 입력·출력·캐시 읽기·캐시 쓰기 가격(100만 토큰당 USD, 0~10000, 소수점 아래 6자리까지 — 더 길거나 `1e3` 같은 표기는 400)을 넣는다. 일일 비용 알림 기준도 소수점 아래 6자리까지다. 모르는 칸은 비워 둔다(미제공).
2. "새 버전으로 저장" → `price_tables`에 다음 번호(v1, v2, …)로 저장된다. 옛 버전은 지우거나 고치지 않는다. 로그: `usage.prices_saved`(관리자 id, 모델 수).
3. 실제 요금은 공급자 가격 페이지를 보고 관리자가 넣는다. 저장소에는 가격을 넣어 두지 않는다(처음엔 가격표가 없고 API 키 비용은 미제공).

### 16.4 일일 비용 알림 (FR-9.5)

- 관리자 → 사용량 → "일일 비용 알림 기준(USD, 선택)". 비우면 꺼진다(`settings`의 `usage.daily_cost_threshold_usd`).
- 사용량을 쓸 때마다 오늘(서울 기준) API 키 비용 합계를 보고(정수 마이크로 USD, 기준도 마이크로 USD로 바꿔 비교), **기준을 넘으면**(같으면 아님) 활성 관리자 모두에게 `daily_cost` 알림("오늘 $… · 기준 $… (막지는 않아요)")을 보낸다.
- **하루 한 번**: 알림 전에 그날 날짜를 `usage.daily_cost_alerted_day`에 기록(트랜잭션)하고, 같은 날에는 다시 보내지 않는다. 그날 기준을 바꿔도 다시 보내지 않는다. 다음 날 다시 넘으면 다시 보낸다.
- 막지는 않는다. 알림 전송이 실패해도 실행에는 영향이 없다(`usage.alert_failed`, 오류 코드만). 로그: `usage.daily_cost_alert`(오늘 비용만).

## 17. 웹 검색·가져오기 (#50)
방식과 근거는 `docs/decisions/isolation.md` "웹 검색·가져오기 (#50)"에 있다.

### 17.1 켜져 있는 것
- `web_fetch`는 모든 활성 사용자의 run에 항상 있다. 따로 설치할 것이 없다. macOS가 아니면 `web_unavailable`로 거부한다(샌드박스 없음).
- `web_search`는 검색 제공자가 하나라도 있을 때만 있다. `.env`(없으면 기본값):
  ```
  WEB_SEARCH_PROVIDERS=duckduckgo,google-news   # 기본. 순서대로 시도
  WEB_SEARCH_PROVIDERS=google-news              # DuckDuckGo 약관이 걱정될 때(뉴스만, 원문 링크 아님)
  ```
  - `duckduckgo`: 키 없음. 공식 API가 아니어서 약관상 회색 지대이고, 연달아 쓰면 봇 확인 페이지가 온다(`web_search_blocked` → 다음 제공자).
  - `google-news`: `google-news-search-skill`이 설치돼 있고 `SKILL_PYTHON`이 있어야 한다(§15). 링크가 Google 중계 주소라 `web_fetch`로 원문이 열리지 않는다.
  - 바꾼 뒤에는 서비스를 다시 시작한다.

### 17.2 무엇이 저장되나
- 가져온 페이지는 `sources` 표에 대화별로 남는다: URL, 최종 URL, 제목, 사이트, 게시일(있을 때), 가져온 시각, 본문 해시, 본문(최대 40만 자). 검색 결과는 제목·링크·스니펫만(본문 없음).
- 대화를 지우면 그 대화의 출처도 지워진다. DB에 있으므로 백업에 함께 들어간다(1절).
- 대화 주인은 `GET /api/conversations/<id>/sources`로 목록을 본다(본문 제외). 관리자도 남의 목록은 못 본다.

### 17.3 막히는 것과 로그
- 이 Mac·집 네트워크 주소(루프백·사설·링크 로컬·메타데이터), `localhost`·`.local` 같은 이름, 80/443 밖 포트, http/https가 아닌 주소, PDF, 3MB 넘는 응답, 20초 넘는 가져오기, 5번 넘는 리다이렉트는 거부된다. 모델은 `web_*` 코드만 본다.
- 로그에는 호출마다 `web.finished`(도구 이름, 결과 코드 `webCode`, 소요 시간, ID)만 남는다. URL·호스트·검색어·본문은 남지 않는다. 어떤 사이트에서 막혔는지는 로그로 알 수 없다(의도).
- 자주 보이는 코드: `web_blocked`(정책 거부), `web_unreachable`(연결 실패·없는 이름), `web_no_text`(스크립트로만 그리는 페이지), `web_unsupported_type`(PDF 등), `web_search_blocked`(DuckDuckGo 봇 확인).

## 18. 아티팩트 (#27)
방식과 근거는 `docs/decisions/isolation.md` "아티팩트 서빙 (#27)"에 있다.

### 18.1 무엇이 어디에
- 에이전트가 `artifact_create`·`artifact_update` 도구로 만든다(모든 활성 사용자, 설치할 것 없음). 주소는 `/a/<id>`, 원본은 `/a/<id>/v/<버전>/raw`, 내려받기는 `/a/<id>/v/<버전>/download`. 만든 사람만 연다(관리자도 못 본다). 가족 공유는 #29.
- DB의 `artifacts`·`artifact_versions` 표(0011 마이그레이션)에 본문까지 들어 있다 — 백업에 함께 들어간다(1절). 대화를 지우면 그 대화의 아티팩트도 지워진다.
- 버전 행은 고칠 수 없다(트리거). 되돌리기는 이전 버전을 복사한 새 버전이다.
- 로그에는 `artifact.finished`(도구, 결과 코드 `artifactCode`, 소요 시간, ID)만 남는다. 제목·본문은 남지 않는다.

### 18.2 허용 CDN 추가하기
아티팩트 HTML이 외부 스크립트를 받을 수 있는 곳은 `apps/server/src/artifacts/serve.ts`의 `CDN_ALLOW_LIST`뿐이다. 버전이 박힌 **정확한 파일 URL**만 넣는다(`@latest`·폴더·호스트 전체 금지).
1. 게시된 지 2주 넘은 버전을 고른다. URL 예: `https://cdn.jsdelivr.net/npm/<패키지>@<정확한 버전>/dist/<파일>.min.js` 또는 `https://cdnjs.cloudflare.com/ajax/libs/<이름>/<버전>/<파일>.min.js`.
2. 파일을 받아 SRI 해시를 만든다(스크래치 폴더에서):
   ```bash
   curl -sSfo lib.js '<URL>'
   echo "sha384-$(openssl dgst -sha384 -binary lib.js | openssl base64 -A)"
   ```
   CDN이 공개한 SRI 값이 있으면 같은지 비교한다.
3. `CDN_ALLOW_LIST`에 `{ name, url, integrity }`를 더하고, `packages/mcp-tools/src/artifacts.ts`의 도구 설명에 URL을 적는다(모델이 알게).
4. `pnpm test`, 그리고 네트워크가 되는 곳에서 `E2E_NETWORK=1 E2E_PORT=3112 pnpm e2e e2e/artifacts.spec.ts`로 실제 로드를 확인한다(e2e의 CDN 시험은 지금 Chart.js 기준 — 새 항목을 쓰는 시험을 더한다).
- 그 CDN이 **CORS(`Access-Control-Allow-Origin: *`)를 보내야** 한다: 아티팩트는 불투명 출처라 SRI 검사에 CORS 응답이 필요하다(jsDelivr·cdnjs는 보냄).

### 18.3 확인 방법
- `pnpm e2e e2e/artifacts.spec.ts`: 차트가 그려진 뒤 쿠키·API·부모·최상위 창 접근이 실패하고, 허용 밖 CDN이 막히고, 다른 가족은 403인지 본다.
- 브라우저에서 원본 주소를 직접 열어도 개발자 도구 콘솔의 `self.origin`이 `"null"`이어야 한다(샌드박스).

### 18.4 PNG·PDF 내보내기 (#51)
방식과 근거는 `docs/decisions/isolation.md` "아티팩트 내보내기 (#51)"에 있다. 아티팩트 화면의 **PNG**(차트·SVG·HTML)·**PDF**(HTML·차트·표·마크다운·코드) 버튼, 주소는 `/a/<id>/v/<버전>/png`·`/pdf`(만든 사람만).
- **브라우저 설치:** 서버가 쓰는 것은 Playwright의 Chrome Headless Shell이다(새 패키지 없음). 저장소에서 한 번:
  ```bash
  pnpm exec playwright install --only-shell chromium
  ```
  저장소의 Playwright 버전을 올리면 다시 실행한다(새 빌드가 캐시에 들어가고, 서버는 다시 시작하면 가장 새 것을 쓴다).
- **서비스 계정이 다르면:** 서버는 기본으로 **서버를 실행하는 계정의** Playwright 캐시(`~/Library/Caches/ms-playwright`)를 찾는다. LaunchDaemon이 다른 계정으로 돌면 `.env`에 절대 경로를 적는다:
  ```
  EXPORT_BROWSER=/Users/<계정>/Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell
  ```
  서비스 계정이 그 파일을 읽고 실행할 수 있어야 한다. 바꾼 뒤 서비스를 다시 시작한다.
- **없으면:** 브라우저가 없거나 macOS가 아니면(샌드박스 없음) PNG·PDF는 `export_unavailable`(503)이고 화면은 "만들지 못했어요"를 보인다. 차트 PNG는 브라우저 안에서 먼저 그리므로 그래도 된다.
- **한도:** 한 번에 20초, 메모리 768MB, 파일 32MB, 동시에 2개(4개까지 기다림 — 넘으면 `export_busy`). 로그에는 `artifact.exported`(형식 `exportFormat`, 결과 `exportCode`, 소요 시간)만 남는다.
  - 자주 보이는 코드: `export_unavailable`(브라우저 없음·macOS 아님), `export_timeout`(20초 넘는 문서 — 끝나지 않는 스크립트), `export_limit`(메모리·크기), `export_busy`(동시 요청).
- **확인:**
  - `pnpm test apps/server/test/artifact-export.test.ts`: 샘플 차트 PNG·문서 PDF, 앱(127.0.0.1)·사설 IP·메타데이터 요청 차단(겹마다 따로), 쿠키 없음, 시간·메모리 한도.
  - 운영 Mac에서 실제 CDN(Chart.js를 쓰는 HTML) 확인: 그런 아티팩트를 열고 PDF 버튼 → 차트가 그려진 PDF가 받아져야 한다. 렌더러는 `cdn.jsdelivr.net:443`에만 나간다.

## 19. 금융 도구 (#30)
방식과 근거는 `docs/decisions/isolation.md` "금융 도구 (#30)"에 있다. PRD FR-7.1–7.4·7.6·7.8.

### 19.1 켜져 있는 것
- 도구(모두 우리 MCP 서버의 서버 도구, 설치할 것 없음, macOS 샌드박스 필요 — 아니면 `finance_unavailable`):

  | 스킬 권한(FR-1.6) | 도구 | 데이터 원천 | 필요한 설정 |
  |---|---|---|---|
  | `kr-stock-skill` | `kr_quote` `kr_index` `kr_history` `kr_search` `kr_etf` `fx_usdkrw` | 네이버 증권(환율은 Yahoo Finance) | 없음 |
  | `us-stock-skill` | `us_quote` `us_index` `us_company` `us_history` `us_financials` `us_earnings` `us_valuation` `us_technicals` `us_screener` | Yahoo Finance | 없음 |
  | `dart-investment-monitor` | `dart_disclosures` | OpenDART | `.env`의 `OPENDART_API_KEY` |
  | `market-disclosure-monitor` | `sec_8k` `sec_form4` `sec_13f` | SEC EDGAR | `.env`의 `SEC_USER_AGENT` |

- `SEC_USER_AGENT`: SEC는 모든 요청에 "이름 연락처"를 담은 User-Agent를 요구한다. 예: `SEC_USER_AGENT=AgentLee family-assistant 관리자메일@example.com`. 비밀처럼 다룬다(로그·결과에 남지 않음).
- 값이 없으면 그 도구만 `finance_unconfigured`로 거절한다. 넣거나 바꾼 뒤에는 서비스를 다시 시작한다.
- `skill_kr-stock-skill`(#21 python 래퍼)은 Alpha Vantage 대체용으로 남아 있다. 그 결과에는 출처·기준 시각 표시가 없어서 출력기가 `tool_meta`로 표시한다(19.3).
- `GET /api/admin/skills`에서 네 금융 스킬은 금융 도구가 있으면 `available`이다.

### 19.2 응답 형식 (값마다 출처·기준 시각)
- 숫자 하나하나가 `{ value, unit, source, asOf, timeZone, delayed, kind }`다. 이력·목록은 행마다 같은 필드를 붙인다.
  - `asOf`: 시장 시간대의 시각 + 오프셋(`2026-11-13T15:30:00+09:00`, `2026-11-13T16:00:00-05:00`).
  - `kind`: `close` 종가 · `intraday` 장중 · `reported` 보고치(재무) · `estimate` 컨센서스 · `filing` 공시 · `computed` 기술 지표.
  - `delayed`: 장중 값이 지연일 수 있으면 `true`. 네이버는 지연 분을 알려 주고(0 = 실시간), Yahoo는 알려 주지 않아 장중 값은 늘 `true`다. 종가는 `false`.
- **종가 판정과 휴장일 규칙(리뷰 #93 1차):** "종가인가"와 "지연인가"를 따로 정한다.
  - 값의 시각이 정규장 마감 시각 이후일 때만 `close`다(리뷰 #93 2차). 원천의 시장 상태(네이버 `marketStatus: CLOSE`, Yahoo `marketState: POST`)는 종가를 확정하지 않는다 — 지연 피드는 16:00 뒤에도 15:40 체결을 보여 줄 수 있다. 시세에 "이것이 종가"라는 명시 필드를 주는 원천은 없다. `asOf`는 그 거래일의 마감 시각(KRX 15:30 KST, 미국 16:00 ET, 조기 폐장 13:00 ET)이다. 주말·휴장일에는 최근 거래일 — **토요일에 물으면 금요일 종가**다. 그 거래일이 최근 거래일보다 앞이면 `stale: true`.
  - 그 밖에는 **원래 시각 그대로** `intraday`다. 장이 열려 있고 오늘 장의 값이면 원천의 지연 표시를 따르고, 장이 끝났거나 오늘 값이 아니면 `delayed: true`, `stale: true`(종가가 아직 오지 않음). 예: 16:01에 받은 15:40 값은 "15:40 ET 장중 (지연)"이지 "16:00 종가"가 아니다.
- 결과 끝에는 `sources`(서로 다른 출처·기준 시각과 라벨, 예: `네이버 증권 · 2026-11-13 15:30 KST 종가`), `warnings`, `disclaimer`가 붙는다. 표시가 빠진 값이 있으면 그 값에 `metaMissing`이, 결과에 `finance_meta_missing` 경고가 붙는다.
- 휴장일 표: `apps/server/src/finance/calendar.ts`의 `KRX_HOLIDAYS`·`US_HOLIDAYS`·`US_EARLY_CLOSE`(2025–2027). 표 밖의 해는 주말만 쉬는 날로 본다.

### 19.3 공통 금융 출력기
- 금융 도구를 쓴 **모든 답변**(모든 사용자, 두 런타임, 중지된 답변 포함), 그 대화에 금융 결과가 **하나라도** 있으면 그 뒤의 **숫자가 있는 모든 후속 답변**(얼마나 지났든, 숫자 없는 설명이 사이에 있어도 — 런타임은 앞 대화를 계속 받는다), **예약 실행**(#33 — 같은 실행 관리자를 거친다), **서버 재시작으로 복구한 부분 답변**에 서버가 `finance_note` 부분을 붙인다(`apps/server/src/finance/checker.ts`, `runs.ts`의 `attachNoteTo` — `settle`과 `recover` 둘 다).
  - 답변마다 금융 결과(출처·숫자·식별자)를 DB `finance_results` 표(0014 마이그레이션, 메시지당 1행, 메시지·대화와 함께 지워짐)에 남긴다. 후속 답변의 검사는 그 대화의 행을 색인 하나(`finance_results_conversation_idx`)로 읽는다. 고치기·다시 생성으로 기록에서 빠진 답변의 결과는 쓰지 않는다.
  - `sources`: 그 답변이 받은 금융 결과의 출처·기준 시각(후속 답변은 앞 답변의 것).
  - `missing`: **숫자마다** 검사한다. 숫자의 맥락은 그 문장과, 같은 문단에서 숫자가 없는 문장(머리말 "네이버 증권 · 11월 13일 종가 기준"이나 각주)이다. 도구 값과 같은 숫자는 **그 값의 출처**와 그 출처의 기준 날짜가, 장중 값이면 시각과 시간대(10:14 KST)까지 맥락에 있어야 한다. 도구 값이 아닌 숫자(합계·환산)는 답변이 쓴 출처 중 하나와 그 날짜가 있어야 한다. 숫자의 단위(천·만·억·조와 천만·백억 같은 묶음, K·M·B·T)를 풀어 쓴 정밀도 안에서 도구 값과 맞춘다(20.6만 = 206,000 ± 500). 한국식 복합 금액(`20만 6000원`, `20만6000원`, `1억 2,300만 4,000원`)은 하나의 숫자로 합치고, 정밀도는 마지막으로 쓴 단위의 것이다(리뷰 #93 3차). 하나라도 빠지면 `source`(출처 이름 `네이버`·`Yahoo`·`DART`·`SEC` 등 없음) 또는 `as_of`(2026-11-13, 2026.11.13, 11월 13일, 11/13 없음)이다. 금융 결과에 표시가 빠졌으면 `tool_meta`.
  - 숫자로 세지 않는 것: 날짜·시각·연도·분기, 공시 양식(8-K, 10-Q, Form 4, 13F-HR, S-1, item 2.02), 지수·ETF 이름(S&P 500, KOSPI 200, KODEX 200), 서수·목록 번호, 0으로 시작하는 6자리 코드, 도구 입력·결과의 코드·티커·이름 — 모두 통째 토큰일 때만, 그리고 바로 뒤에 단위(원·달러·%·pt·주·만·억…)나 앞에 `$`·`₩`가 있으면 금액으로 본다(373220원, 4달러, 나스닥 10000pt는 숫자). ETF 이름은 브랜드·알려진 단어(미국·S&P·선물·인버스·레버리지…)·숫자만 이름으로 보고, 숫자 바로 뒤에 단위가 있으면 가격이다(`KODEX 84540원`).
  - `disclaimer`: 항상. "투자 판단의 참고 자료일 뿐이며 투자 권유가 아닙니다. …"
- 화면: 답변 아래에 출처 목록과 면책, 빠진 것이 있으면 ⚠️ 안내(`data-testid="finance-note"`).
- 런타임이 이 부분을 지우거나 바꿀 수 없다(서버가 답변 끝에 붙임). 다음 런타임에게 넘어가는 맥락에는 글 부분만 간다.

### 19.4 사용자별 허용 (아들 기본 숨김)
- 청소년 계정(`users.youth = 1`, 14.2절)은 스킬 권한이 기본값 `"all"`이어도 **금융 스킬 네 개와 그 도구가 숨겨진다**(목록에 없고, 불러도 `finance_not_allowed`).
- 켜려면 목록으로 이름을 적는다: `PUT /api/admin/users/<id>/skills {"skills": ["google-news-search-skill", "kr-stock-skill"]}` — `kr-stock-skill`의 도구(`kr_*`, `fx_usdkrw`)만 켜진다.
- 어른 계정도 목록에서 금융 스킬을 빼면 그 도구가 빠진다. 실행 중에도 다음 호출부터 적용된다.
- 매년 12월: 다음 해 KRX 휴장일(거래소 공지)과 NYSE 휴장·조기 폐장일을 `calendar.ts`에 넣고 `CALENDAR_YEARS`를 늘린다. 시험(`finance.test.ts` "covers the years around today")이 올해와 내년이 표에 없으면 실패한다.

### 19.5 녹화와 스냅샷 시험
- 시험은 네트워크를 쓰지 않는다. `apps/server/test/fixtures/finance/<이름>.json`(도구, 입력, 물은 시각 `now`, URL별 응답)을 재생하고(`helpers/finance-replay.ts`), 결과를 `__snapshots__/finance/<이름>.json`과 비교한다.
- **지금 fixture는 모두 합성이다**(`"synthetic": true`). 2026-11-11에 살아 있는 API의 응답 모양을 확인하고 그 모양으로 만들었다. OpenDART 키와 SEC 연락처가 없어 실제 녹화는 하지 않았다.
- 실제 녹화로 바꾸기(macOS, 네트워크, 필요하면 `.env`에 `OPENDART_API_KEY`·`SEC_USER_AGENT`):
  ```
  pnpm --filter @agentlee/server exec tsx --conditions=development test/record-finance.ts us_quote-saturday
  pnpm vitest run apps/server/test/finance.test.ts -u     # 스냅샷 갱신
  git diff apps/server/test/fixtures/finance apps/server/test/__snapshots__/finance   # 검토
  ```
  - 서버와 똑같이 샌드박스 작업자 + 그 도구 호스트만 허용하는 프록시로 부른다. `now`는 녹화 시각이 된다.
  - 저장되지 않는 것: crumb(`{crumb}`)·OpenDART 키(`{key}`)는 URL에서 자리표시자로, 쿠키·crumb 단계와 헤더는 저장 안 함. 본문에 비밀 값이 남으면 쓰지 않고 멈춘다.
  - 휴장일 규칙 시험(`-saturday`·`-holiday`·`-thanksgiving`·`-intraday`)은 그 시각의 값을 확인한다. 이런 fixture를 다시 녹화하려면 그 조건(토요일, 휴장 다음 날, 장중)에 녹화하거나 합성으로 둔다.
- 실제 계정·실제 런타임 확인 체크리스트: `docs/evidence/finance/checklist.md`.

### 19.6 막히는 것과 로그
- 도구마다 자기 호스트만 허용하는 송신 프록시를 쓴다(표: isolation.md). 다른 호스트·포트로는 나가지 못한다.
- 로그에는 호출마다 `finance.finished`(도구 이름, `financeCode`, 소요 시간, ID)만 남는다. 종목 코드·URL·숫자는 남지 않는다.
- 자주 보이는 코드: `finance_unconfigured`(키·연락처 없음), `finance_not_found`(없는 종목), `finance_rate_limited`(429·DART 020), `finance_blocked`(허용 밖 호스트), `finance_unreachable`, `finance_bad_response`(응답 모양이 바뀜 — 녹화를 다시 하고 파서를 고친다).

## 20. 관리자 화면 (#35)
관리자 → 🛠 관리자. 탭은 주소에 남는다(`/admin?tab=permissions` 등). 모든 `/api/admin/**`는 관리자만(가족 403, 로그인 전 401) — 권한 행렬 시험이 등록된 모든 관리자 라우트를 가족·관리자로 돌려 본다(`permissions.test.ts`).

### 20.1 사용자
- 추가(이름·이메일·역할·청소년 표시), 임시 비밀번호(한 번만 보임), 비밀번호 초기화, 비활성화는 #41 그대로다.
- **수정**: 이름·이메일·역할(`PATCH /api/admin/users/<id>`). 이메일을 바꾸면 그 사람의 로그인이 모두 끊기고 새 이메일로 다시 로그인한다. Access 허용 목록은 10절대로 직접 고친다(자동 반영은 #36).
- **관리자 이메일**은 여기서 바꾸지 않는다(409 `admin_email_change`) — Access 확인 절차(PRD FR-15.7)는 #36이다.
- **관리자가 한 명도 안 남게는 못 한다**: 마지막 활성 관리자를 가족으로 바꾸거나(본인 포함) 비활성화하면 409 `last_admin`. 본인 비활성화는 늘 400. 확인과 변경은 한 트랜잭션이라 두 관리자가 동시에 서로를 강등해도 한쪽만 된다. 다른 관리자를 먼저 지정하면 본인은 가족으로 내려갈 수 있다.

### 20.2 권한 (사용자별)
- **런타임·모델·추론 강도·연결**: 런타임마다 허용, 허용 모델(“모든 모델”은 새 모델도 포함), 허용 추론 강도, 개인 연결 허용, 가족 공용 연결 허용. 저장하면 다음 실행부터 적용된다(`PUT /api/admin/users/<id>/runtime-policies`, #17의 `runtime_policies`).
- 허용하지 않은 모델은 그 사람의 모든 선택기에서 빠진다: 선택기는 모두 `GET /api/runtimes`(허용된 것만)를 읽는다 — 지금은 설정의 기본값 선택기, 칩(#19)도 같은 목록을 쓴다. 서버도 막는다: 그 모델로 보내기·고치기·다시 생성은 403 `model_not_allowed`, 기본값으로 저장도 403(아래).
- **처음 기본값**(FR-12.4): 그 사람이 설정에서 직접 고르기 전까지의 기본 런타임·모델·추론 강도(`users.initial_defaults`, `PUT /api/admin/users/<id>/defaults`, `null`이면 지움). 저장된 권한 안에서만 고를 수 있다(밖이면 400 + 코드). 계정을 만들 때 고른 런타임도 여기에 들어간다(0015가 옛 `default_runtime`을 옮겼다).
- **스킬**: 스킬 한 개씩 켜고 끈다(`PUT /api/admin/users/<id>/skills/<이름>` `{"enabled": true|false}`). 서버가 지금 허용된 목록에서 새 목록을 만들므로 **청소년 계정의 금융 스킬은 다른 스킬을 바꿔도 숨겨진 채로 남는다**. 결과가 “모두”와 같으면 다시 `"all"`이 된다.

### 20.3 런타임
- 런타임별 모델 목록과 capability(이어 쓰기·세션 안 모델 변경·공통 도구·연결 필요): `GET /api/admin/runtimes`. 이 서버의 어댑터가 제공하는 그대로다. 누가 무엇을 쓰는지는 권한 탭에서 정한다.
- **가족 공용 연결**: API 키로만 등록·테스트·삭제(11절).
- **가족 대신 개인 연결**: 그 사람의 API 키만 등록한다. 화면에 “본인 구독만 연결하세요…” 안내가 있다. 구독 로그인(ChatGPT 계정, Claude 구독)은 그 사람이 자기 설정에서 직접 한다 — 가족 계정에 Claude 구독은 403, ChatGPT 로그인은 붙여 넣을 수 없고(400), 다른 관리자 계정에 구독을 붙이는 것도 403 `subscription_self_only`. 등록한 API 키 연결은 그 사람으로 테스트한다(`POST /api/admin/users/<id>/connections/<connectionId>/test` — 그 사람의 권한·폴더·사용량). 다른 사람의 구독 연결은 대신 테스트할 수 없다(403 `subscription_self_only`, 다른 관리자의 것도) — 주인이 자기 설정에서 테스트한다. 키는 관리자도 다시 볼 수 없다(끝 4자리만).

### 20.4 스킬
- **서버 허용 목록**: 스킬마다 스위치(`PUT /api/admin/skills/<이름>`). 끄면 누구의 도구 목록에도 없고, 불러도 거부된다(사용자 권한과 무관). 저장은 settings `skills.disabled`(끈 이름 목록)라 재시작해도 유지된다. 검증용 `selftest`는 항상 켜져 있다. 설치·상태는 15.2절.
- **사용자별 켜기**: 20.2절과 같은 스위치를 사람을 골라 바꾼다.

### 20.5 시스템 상태
- `GET /api/admin/system`: 가동 시간(프로세스 시작 기준 — 7일 가동률은 `pnpm uptime report`, 9.3절), 런타임별 공용 연결 상태와 개인 연결 수(상태별), 터널, 최근 오류 20건과 스킬 실행 실패(스킬과 금융 도구의 실패를 도구·코드별 횟수로, 30일), 디스크(데이터 폴더가 있는 볼륨의 전체·남은 용량, DB 파일+WAL 크기). 모두 코드·숫자·라벨뿐이고 오류 문장·대화 내용·인증 정보는 없다.
- **터널 상태 켜기**: `cloudflared`에 메트릭 서버를 루프백으로 열고(예: LaunchDaemon 인자 `--metrics 127.0.0.1:20241`), `.env`에 `CLOUDFLARED_METRICS=http://127.0.0.1:20241`을 넣고 재시작한다. 서버는 `GET /ready`의 `readyConnections`만 읽는다: JSON이고 정수일 때만 센다 — 200에 1 이상이면 “연결됨”, 0이거나 503이면 “끊김”, 본문이 없거나 JSON이 아니거나 값이 없으면(다른 서비스일 수 있음) “응답 없음”. 요청 전체에 시작부터 1.5초 마감이 있고 본문은 4KB까지만 읽는다(느리게 흘려보내는 응답도 끊는다).
  - **루프백 IP만 받는다**: 십진수 네 마디 `127.x.x.x` 또는 `[::1]` + 포트, 경로·사용자 정보 없이. 적힌 그대로 검사하므로 `127.1`·`0x7f000001`·`2130706433` 같은 다른 표기도 거부한다. `localhost` 같은 이름도 거부한다(이름 조회로 다른 곳에 가지 않게). 다른 값이면 서버가 시작을 거부한다. 요청은 그 IP로 `node:http`로만 가고(프록시·리다이렉트 없음) 다시 한 번 루프백인지 확인한다.
  - 설정하지 않으면 “미설정”이고 아무 요청도 하지 않는다.

## 21. 백업·복원 (#37)
DB와 파일을 같은 시점으로 매일 백업하고, 서버를 멈춘 상태에서 명령으로 복원한다(PRD FR-10.5, NFR 백업).

### 21.1 무엇이 들어가고 무엇이 빠지나
백업 하나 = `BACKUP_DIR/<id>/` 폴더 하나(`id` 예: `20261111-183000Z-1a2b3c`, UTC 시각 + 임의 6자리).

| 들어감 | 내용 |
|---|---|
| `agentlee.db` | DB 전체 — 계정·비밀번호 해시·세션, 대화·메시지, 아티팩트, 웹 출처, 사용량, 금융 결과, 알림, 설정, **연결 인증 정보(암호문 그대로)** |
| `files/`·`artifacts/`·`sources/` | 데이터 폴더의 파일 저장소(첨부). 지금은 아티팩트·출처가 DB에 있어 비어 있다 |
| `manifest.json` | 형식 버전, 시각, 스키마 버전(적용된 마이그레이션 수·마지막 시각), 파일마다 크기·SHA-256, 키 확인 값(마스터 키로 암호화한 고정 문구 — 키 자체가 아님) |

| 빠짐 | 이유 |
|---|---|
| 마스터 키 | 키는 `DATA_DIR` 밖에 있고(서버가 강제) 백업 코드는 키 파일을 읽지 않는다. 키와 백업이 함께 있으면 암호화가 의미 없다 — 3절의 따로 보관 절차 |
| `runtimes/` | CLI 세션·캐시는 서버 기록(대화)에서 다시 만들어진다(복원하면 모든 런타임 세션을 무효로 표시해 다음 턴이 새 세션으로 시작). 로그인 중 폴더에는 제공자 토큰 파일(`auth.json`)이 평문으로 잠깐 있을 수 있어 넣으면 "인증 정보는 암호화 상태" 원칙이 깨진다. `.quarantine`은 지우는 중인 로그인 폴더다 |
| `skills/` | 허용 목록 스킬의 복사본일 뿐이다. 복원 뒤 `pnpm skills:install`이 원본에서 다시 복사하며 파일마다 해시를 확인한다(백업본을 믿을 이유가 없다) |
| 임시 폴더 | 실행 중인 프로세스의 것. 내보내기 렌더러의 임시 폴더는 시스템 임시 폴더에 있다. 데이터 폴더 잠금(`.data.lock.db`)은 데이터 폴더 밖, 옆에 있다(21.4절) |
| `.env` | 레포의 설정 파일. 스킬 비밀 등은 비밀번호 관리자에 따로 둔다(백업 대상 아님) |

- 백업 폴더 `BACKUP_DIR`(기본 `~/agentlee-backups`)은 `DATA_DIR` 밖이어야 한다(복원이 `DATA_DIR`을 통째로 바꾸므로), 레포 밖이어야 한다(실수로 커밋되지 않게), 마스터 키를 품으면 안 된다 — 어기면 시작을 거부한다. 폴더는 700, 백업 폴더도 700, 파일은 모두 600이다(느슨하면 백업할 때 다시 조인다).
- 디스크 고장에 대비하려면 `BACKUP_DIR`을 Time Machine이나 외장 디스크에 함께 복사한다. 키는 같은 곳에 두지 않는다(3절).

### 21.2 같은 시점 (일관 기준점)
- DB는 `VACUUM INTO`로 복사한다: 한 문장·한 읽기 트랜잭션이라 그 순간의 DB 그대로다(다른 연결이 쓰는 중이어도). 새로 쓰는 파일이라 지운 행이 빈 페이지에 남지 않는다 — 지운 대화가 이후 백업에 남지 않는 이유(온라인 백업 API는 페이지를 그대로 복사해 지운 내용이 남을 수 있어 쓰지 않았다).
- 파일은 **짧은 쓰기 잠금**으로 맞춘다(`FileWriteLock`, `app.fileWrites`). 파일 저장소에 쓰는 코드는 행과 파일을 한 `fileWrites.write()` 안에서 함께 쓴다. 백업은 잠금을 잡고(진행 중인 쓰기가 끝나길 기다리고, 새 쓰기는 기다리게 하고) DB 스냅샷 → 파일 복사를 한 뒤 놓는다. 지금 가족 규모에서 잠금은 몇 초 이하이고 쓰는 쪽은 기다릴 뿐 실패하지 않는다. DB 쓰기는 잠그지 않는다(스냅샷이 이미 한 시점이라).
- 내용 해시 경로(불변 저장)를 택하지 않은 이유: 지금은 파일 저장소에 쓰는 곳이 없고(첨부·아티팩트·출처가 DB에 있음) 같은 효과를 잠금 하나로 얻는다. 첨부 업로드가 생겨 파일이 커지면 그때 불변 저장으로 바꿔 잠금 없이 참조만 복사할 수 있다. **새 파일 저장소를 만들면** `BACKUP_FILE_ROOTS`(`apps/server/src/backup/backup.ts`)에 넣고 쓰기를 `fileWrites.write()`로 감싼다.
- 파일은 APFS 복제(clone)로 복사해 공간을 거의 쓰지 않는다. 백업은 `.tmp-<id>`로 만든 뒤 다 되면 이름을 바꾼다 — 중간에 죽은 백업은 목록에 보이지 않고 다음 백업이 지운다.

### 21.3 일정·보관·관리자 화면
- **매일 03:30(서울)** 서버 안 타이머로 돈다(launchd 작업 없음). 서버가 꺼져 있어 놓쳤으면(마지막 백업이 하루보다 오래됐으면) 시작 10분 뒤 한 번 한다. 한 번에 하나만 돈다.
- **7일 보관**: 만든 지 7일(168시간)이 된 백업은 **가장 최근 것까지 예외 없이** 지운다. 정리는 백업이 성공하든 실패하든 백업을 시도할 때마다, 그리고 서버가 시작할 때 돈다. 그래서 지운 대화는 백업이 계속 실패해도 지운 뒤 7일(다음 정리 시각까지 최대 8일) 안에 모든 백업에서 사라진다.
- **알려진 비밀과 백업**: 백업은 DB를 저장된 그대로 복사한다. 비밀이 늦게 등록되면(예: 대화에 먼저 붙여 넣은 키를 나중에 연결로 등록) 서버의 재가림이 저장 행을 그때부터 깨끗하게 하지만, 그 전에 만든 백업에는 원문이 남아 있다가 위 7일 보관에 따라 사라진다(받아들인 한계). 그런 백업을 복원하면 서버 시작 시 재가림 패스가 복원된 행을 다시 가린다.
- **실패 알림**: 백업이 실패할 때마다 모든 관리자에게 `system_warning` 알림("백업에 실패했어요 (코드) …", 알림함·푸시, 누르면 관리자 → 백업). 실패가 7일 넘게 이어져 **남은 백업이 하나도 없으면** 그때마다 더 강한 알림("백업이 하나도 남지 않았어요 …")이 함께 간다 — 이 상태에서는 복원할 것이 없으므로 디스크·`BACKUP_DIR`을 바로 확인한다.
- **빠지는 파일**: 파일 저장소를 읽다 생긴 오류(EIO·EACCES 등)는 백업 전체를 실패로 만든다(빠진 채 성공으로 남지 않음). 복사 중에 사라진 파일(ENOENT)만 넘어가는데, 스냅샷의 DB가 그 파일을 가리키면(`FILE_REFERENCES`) 그것도 실패다.
- **관리자 → 백업 탭**: 일정·다음 시각·마지막 결과, "지금 백업", 최근 백업(시각·ID·크기·파일 수·스키마 버전), 복원 방법 안내. 화면에서 복원하는 버튼은 없다. API `GET /api/admin/backups`·`POST /api/admin/backups`는 관리자만(가족 403, 로그인 전 401 — 권한 행렬). 이미 백업 중이면 409 `backup_running`.
- 로그: `backup.finished`(무엇이 시작했나 `backupTrigger` = `scheduled`/`manual`, 결과 `backupCode` = `backup_ok`·`backup_running`·`backup_unavailable`·`backup_failed`·`backup_disk_full`, 소요 시간, 파일 수), 지운 개수 `backup.pruned`. 경로·내용은 남지 않는다.

### 21.4 복원 (서버를 멈추고 명령으로)
복원은 데이터 폴더를 통째로 바꾼다. 서버가 도는 동안에는 스케줄러·쓰기·열린 DB가 있으므로 앱 안에서 하지 않고, **서버를 멈춘 뒤** 명령으로 한다.

- **데이터 폴더 잠금(커널 잠금)**: 서버·복원·`pnpm db:migrate`는 데이터 폴더 옆의 잠금 DB(`<부모>/.<이름>.lock.db`, 예 `.data.lock.db`, 600, 심볼릭 링크 거부)를 SQLite `locking_mode = EXCLUSIVE` + 배타 트랜잭션으로 잡는다. SQLite가 파일에 `fcntl` 잠금을 걸고 연결이 열려 있는 동안 유지하며, 프로세스가 죽으면(kill -9 포함) 운영체제가 풀어 준다 — 오래된 잠금 판단이 없어 두 프로세스가 동시에 잡을 틈이 없다. 서버는 DB를 열기 전에 잡고 끝날 때까지 놓지 않는다: 두 번째 서버는 시작을 거부하고, 복원은 `server_running`으로 거부하며, 복원 중에는 서버가 시작하지 못한다. 옆의 `.<이름>.lock.info`(pid·역할)는 거부 메시지용일 뿐이다. 잠금은 데이터 폴더 밖에 있어 복원의 폴더 교체에도 그대로다.
- **실경로**: 잠금과 교체 일지는 `DATA_DIR`의 실제 경로(심볼릭 링크를 푼 경로)로 정한다 — `alias → data`로 띄운 서버와 `data`로 하는 복원이 같은 잠금을 본다. 복원도 실제 폴더를 옮긴다(링크가 아니라). 링크는 `readlink`로 한 단계씩(상대 경로는 링크가 있는 폴더 기준, 최대 32단계) 따라간다 — 복원이 중간에 끊겨 링크가 가리키던 폴더가 옆으로 옮겨져 링크가 끊겨 있어도 같은 실제 경로·잠금·일지를 본다. 링크가 서로를 가리키는 고리면 "symlink loop"로 시작을 거부한다. 대소문자를 가리지 않는 볼륨(macOS 기본 APFS)에서는 있는 폴더를 디스크에 적힌 이름으로 바꿔 쓰고(`Data`로 적어도 `data`), 일지의 대상과 비교할 때도 부모는 실경로로, 마지막 이름은 그 볼륨에서 대소문자 없이 비교한다(폴더가 잠시 없는 복원 도중에도). 볼륨이 대소문자를 가리는지는 폴더마다 한 번 확인한다.
- **시작 순서**: 데이터 폴더에 쓰는 모든 것(서버, `db:migrate`, 복원)은 같은 함수(`openStorageForWrite`)로 시작한다 — 잠금 → 중단된 복원 정리 → 그다음에야 폴더·DB를 연다. DB가 없거나 0바이트인데 옆에 `<이름>.before-restore-*`가 있으면 새 빈 DB를 만들지 않고 시작을 거부한다(옮겨 둔 데이터를 되돌리거나 다시 복원).

```bash
sudo launchctl bootout system/com.agentlee.server          # 1) 서버 멈춤 (스케줄러·쓰기도 함께 멈춤). 개발 모드면 그냥 종료
pnpm -s restore list                                       # 2) 백업 목록 (id · 시각 · 스키마 · 파일 수)
pnpm -s restore check <id>                                 # 3) 검사만: 키 → 해시 → DB 무결성 → 스키마 버전 → 인증 정보 복호화
pnpm -s restore apply <id> --yes                           # 4) DATA_DIR에 복원 (기존 폴더는 <DATA_DIR>.before-restore-<시각>으로 옮겨 둠)
sudo launchctl bootstrap system /Library/LaunchDaemons/com.agentlee.server.plist   # 5) 다시 시작
pnpm skills:install                                        # 6) 스킬 다시 설치 (15.2절)
```

- `<id>`는 `BACKUP_DIR` 안의 이름, 또는 백업 폴더 경로(외장 디스크에서 가져온 사본 등).
- `--key <파일>`: 다른 위치의 키(오프라인 사본에서 되살린 키). 없으면 `MASTER_KEY_PATH`. 파일은 600, 폴더는 다른 사용자 쓰기 불가여야 한다. 실제로 쓰는 키 파일(과 `MASTER_KEY_PATH`)이 대상 폴더 안에 있으면 `target_unsafe`(교체 때 키가 옆으로 치워지지 않게).
- `--target <폴더>`: `DATA_DIR`이 아닌 곳에 복원(리허설). 그때는 `--yes`가 필요 없다. 대상이 백업 폴더·키와 겹치면 `target_unsafe`.
- 모든 검사가 끝난 뒤에야 쓴다. 대상 옆에 새 폴더를 만들어 채우고(DB 복사 → 해시 재확인 → 이 코드의 마이그레이션 적용 → 런타임 세션 무효화) 이름 바꾸기 두 번(옛 폴더 → 옆, 새 폴더 → 제자리)으로 바꾼다. 옛 폴더는 지우지 않는다 — 확인이 끝나면 직접 지운다.
- **교체 일지**: `<부모>/.<이름>.restore-journal.json`에 단계를 적고(매번 fsync) 끝나면 지운다. 단계: `prepared`(아무것도 안 옮김) → `old_moved`(옛 폴더를 옆으로) → `swapped`(새 폴더를 제자리로) → `done`, 실패하면 무엇이든 되돌리기 **전에** `rolling_back`.
  - **양쪽 정체를 일지에 둔다(추측하지 않음)**: 옮기기 전에 옛 폴더에 임의 id 파일(`.restore-old`)을 쓰고 그 id와 옛 DB의 SHA-256을, 새 폴더(후보)에 id 파일(`.restore-candidate`)을 쓰고 그 id와 **후보 전체 목록**(DB와 `files/`·`artifacts/`·`sources/`의 파일마다 크기·SHA-256)을 일지에 적는다. 정전 대비 순서: 복사한 파일 하나하나 → 폴더(깊은 것부터) → id 파일 → 일지, 모두 fsync. id 파일은 일지를 지운 뒤에 지운다(남으면 다음 시작이 치움).
  - 옛 폴더로 인정 = id 파일과 DB 해시가 일지와 같을 때. 후보로 인정 = id 파일이 같고 파일 목록이 정확히 같을 때(빠진 것·더 있는 것·바뀐 것 없음, 0바이트 DB는 불인정).
  - 첫 이름 바꾸기부터 `done`이 디스크에 확정될 때까지 생긴 **어떤 오류든**(이름 바꾸기, 폴더 fsync, `swapped`·`done` 일지 쓰기) 같은 방식으로 그 자리에서 되돌린다: `rolling_back`을 쓰고(최선) → 옛 폴더가 증명되는지(id·DB 해시·`-wal`/`-shm`) 먼저 확인하고 → 제자리의 후보를 `<이름>.restore-rejected-*`로 옮기고 → 옛 폴더를 제자리로 → fsync → 제자리에서 다시 증명. 옛 폴더가 증명되지 않으면 더 옮기지 않고 `rolling_back` 일지와 양쪽 id 파일을 남겨 다음 시작이 `restore_unresolved`로 멈추게 한다. 폴더가 일지가 끝나는 상태(옛 폴더가 제자리)로 돌아온 것을 확인하고 동기화한 뒤에야 일지를 지운다. 하나라도 실패하면 일지와 id 파일을 그대로 두어 다음 시작이 일지로 판단한다(증명된 쪽에 따라 되돌리기 또는 복원 마무리 — `rolling_back` 기록에 실패했다면 앞 단계 일지대로 마무리될 수도 있다) — 일지 없이 조용히 바뀐 채로 남는 일은 없다. `done`이 확정된 뒤의 정리(일지·id 파일 삭제) 오류는 복원을 실패로 만들지 않는다(일지가 `done`이면 다음 시작이 정리만 한다).
  - 프로세스가 죽거나 전원이 나가면 **다음 복원·서버 시작·`db:migrate`**가 일지를 보고 정한다. `old_moved` 이후이고 후보가 인정되면 앞으로 끝낸다(`completed`, 옛 폴더는 옆에 그대로). 아니면 인정된 옛 폴더로 되돌린다(`rolled_back`). 제자리에 있던 것이 우리 후보(id 일치)인데 손상됐으면 지우지 않고 `<이름>.restore-rejected-*`로 옮겨 둔다.
  - 어느 쪽도 증명하지 못하면(제자리에 정체 모를 데이터, 옛 폴더가 바뀜·없음) **일지를 그대로 두고 두 폴더 모두 건드리지 않은 채** `restore_unresolved`로 시작을 거부한다. 일지의 `target`·`previous`·`staging` 경로를 보고 직접 정리한 뒤 일지를 지운다.
  - **수동 복구 순서** (`restore_unresolved`일 때. 서버는 멈춘 채로):
    1. **확인** — 일지(`.<이름>.restore-journal.json`)의 `target`·`previous`·`staging`을 본다. 각 폴더가 무엇인지 확인한다: 옛 폴더에는 `.restore-old`(일지 `old.id`와 같은 값), 복원본에는 `.restore-candidate`(일지 `candidate.id`)가 있다. 필요하면 `sqlite3 <폴더>/agentlee.db 'PRAGMA integrity_check; SELECT count(*) FROM users;'`로 열어 본다(읽기만).
    2. **격리** — 쓸 데이터가 아닌 폴더는 지우지 말고 옆 이름으로 옮긴다(예 `mv <DATA_DIR> <DATA_DIR>.manual-hold-<날짜>`). 쓸 폴더(대개 옛 폴더)를 `DATA_DIR` 이름으로 옮긴다.
    3. **일지 제거 후 재복원** — 일지를 지우고(`rm <부모>/.<이름>.restore-journal.json`), 서버를 한 번 띄워 데이터가 맞는지 본 뒤, 다시 복원할 거라면 서버를 멈추고 `pnpm -s restore check` → `apply`를 처음부터 한다.
- **옆에 남는 폴더와 지워도 되는 때**: 자동으로 지우지 않는다. 관리자 → 백업 탭이 개수를 알려 준다.
  - `<이름>.before-restore-*` — 복원 전의 데이터 폴더. 복원한 데이터로 서버를 띄워 로그인·대화·연결을 확인했으면 지운다.
  - `<이름>.restore-rejected-*` — 끊긴 복원에서 손상된 복원본(백업의 사본일 뿐, 원래 데이터 아님). 지금 `DATA_DIR`이 맞는 데이터인지 확인했고 일지가 없으면 바로 지워도 된다. 지우기 전에 원인(디스크 오류 등)을 확인한다.
- **옛 DB 정리(WAL)**: 교체 전에 옛 DB를 열어 `wal_checkpoint(TRUNCATE)` 후 `journal_mode = DELETE`로 닫는다(서버는 잠금 때문에 멈춰 있다). `-wal`이 비지 않았거나 `-shm`이 남으면 `old_unsettled`로 멈춘다. 일지의 옛 폴더 정체에는 DB 해시와 함께 `-wal`·`-shm`의 유무·크기·해시도 들어가, 하나라도 다르면 옛 폴더로 인정하지 않는다(`restore_unresolved`).
- **fsync 오류**: 복사한 파일의 열기·fsync 오류(EIO·ENOSPC 등)는 그대로 실패시켜 교체 전에 멈춘다(`not_durable`, 아무것도 바꾸지 않음). 폴더 fsync는 파일 시스템이 지원하지 않는다는 답(EINVAL·ENOTSUP·EOPNOTSUPP·EISDIR)만 넘긴다.
  - 로그 `restore.recovered`. macOS `renamex_np`의 원자적 교환은 네이티브 모듈 없이 Node에서 쓸 수 없어 일지로 했다.
- **스키마 버전 호환**: 백업 DB의 `__drizzle_migrations`가 이 코드의 마이그레이션 목록의 앞부분과 같아야 한다(같은 시각·같은 파일 해시). 더 오래된 백업은 괜찮다(빠진 마이그레이션을 복원 때 적용, 출력에 개수). 더 새 서버의 백업이면 `schema_newer` — 코드를 그 버전 이상으로 올린 뒤 복원한다. 다른 브랜치의 마이그레이션이면 `schema_mismatch`.
- **실패 코드**(종료 코드 1, 아무것도 바꾸지 않음): `wrong_key`(키가 다름 — 3절 사본), `secret_unreadable`(키 확인은 맞는데 마스터 키로 암호화된 값 — 연결 인증 정보, 암호화된 설정(VAPID 개인 키 등), 푸시 구독 — 중 하나라도 안 풀림), `schema_newer`, `schema_mismatch`, `backup_corrupt`(해시·무결성 실패), `manifest_invalid`, `backup_not_found`, `server_running`, `target_unsafe`, `old_unsettled`, `not_durable`. 키 파일 자체가 문제면 `key_unreadable`, 끊긴 복원을 판단하지 못하면 `restore_unresolved`.
- 복원 뒤: 로그인 세션도 백업 시점 그대로라 기기에서 다시 로그인할 필요는 보통 없다. 런타임 세션은 새로 시작된다(대화 기록은 그대로). ChatGPT 로그인 토큰은 DB에 암호문으로 있으므로 그대로 쓰이지만, 백업 뒤 갱신된 토큰이면 만료로 보여 다시 로그인이 필요할 수 있다(11절).

**리허설 (분기마다, 4절에 기록)** — 실제 데이터 폴더를 건드리지 않는다.
1. 오프라인 사본에서 키를 새 파일로 만든다: 예 `mkdir -m 700 /tmp/keytest && pbpaste > /tmp/keytest/master.key && chmod 600 /tmp/keytest/master.key`.
2. `pnpm -s restore check <최근 id> --key /tmp/keytest/master.key` → `ok`.
3. `pnpm -s restore apply <id> --key /tmp/keytest/master.key --target /tmp/agentlee-rehearsal`.
4. 그 폴더로 서버를 다른 포트에서 띄운다: `DATA_DIR=/tmp/agentlee-rehearsal MASTER_KEY_PATH=/tmp/keytest/master.key BACKUP_DIR=/tmp/agentlee-rehearsal-backups PORT=3001 pnpm start`. 로그인 → 대화·첨부·아티팩트가 보이는지, 설정 → 내 런타임 연결에서 "테스트"가 `사용 가능`인지 확인.
5. 서버를 끄고 `/tmp/agentlee-rehearsal*`·`/tmp/keytest`를 지운다.
- 자동 시험이 같은 절차를 돈다(`apps/server/test/backup.test.ts` "rehearsal"): 별도 폴더·되살린 키로 복원 → 로그인·대화·첨부·아티팩트·암호화된 연결(연결 테스트 통과, 런타임이 받은 키가 원래 키와 같음). 다른 키면 서버가 시작을 거부하고, 복원은 `wrong_key`로 멈춘다.

## 22. 인용 검증과 출처 표시 (#25)
PRD FR-5.1–5.5, G2, 수용 기준 3·11. 방식과 근거는 `docs/decisions/isolation.md` "인용 검증 (#25)".

### 22.1 동작
- 도구(우리 MCP 서버, 웹 도구가 있는 모든 사용자, 설치할 것 없음):
  - `cite {sourceId, snippet}` — 서버가 그 출처의 **저장된 본문**(§17.2)에서 구절을 찾는다. 정규화: Unicode NFC(글자 묶음 단위 — 풀어 쓴 한글·악센트도 같음)와 작은 명시적 접기(전각 ASCII → ASCII, `…` → `...`; 모든 폭의 공백은 공백) — **NFKC는 쓰지 않는다**(`10²`가 `102`, `H₂O`가 `H2O`, `①`이 `1`이 되므로 — 리뷰 #97 3차), 모든 따옴표 모양을 하나로, 대시를 `-`로, 보이지 않는 문자 제거, 공백 묶음을 한 칸으로, 소문자, 흔한 HTML 개체(`&amp;` `&minus;` `&nbsp;` `&#8722;` …) 풀기, 본문 속 각주 번호 빼기(`[3]`는 양옆이 숫자가 아닐 때, 위 첨자 숫자는 한글·한자·가나 바로 뒤 낱말 끝일 때만 — `10²`·`m²`·`(10)²`·`so.¹`은 그대로). **줄 끝 하이픈은 잇지 않는다**(리뷰 #97 3차에서 제거 — `x−↵y`의 빼기 부호, `re-↵sign` 같은 애매함): 하이픈과 공백으로 남고, 줄바꿈으로 끊긴 낱말은 "찾지 못함"(⚠️)으로 보인다. 원칙: 애매하면 정규화하지 않는다(잘못된 "찾지 못함"은 ⚠️로 보이지만 잘못된 "확인"은 안 된다). 그 뒤 **구절 전체가 그대로** 있어야 한다(유사도·일부 일치·"…"로 이은 조각 없음). 단어 중간이나 숫자 안에서 시작하거나(`132%`·`1.32%`·`-32%` 속 `32%`, `1,234` 속 `234`) 숫자 중간에서 끝나면 아니다. 정규화 후 8자 미만은 `cite_snippet_too_short`.
  - 영어 등 라틴 글자 뒤에 결합 문자가 오면(NFD `café`) 빠른 경로를 거치지 않고 NFC로 묶는다.
  - 속도: 한 번에 한 줄로 정규화하고(글자별 캐시), 페이지의 정규화 결과를 본문 해시로 4개까지 기억한다(본문이 같을 때만). 본문 한도(40만 자)에서 첫 확인 25–35ms, 같은 페이지 다시 확인은 1ms 미만(이 Mac). 중복·개수 한도는 대조 전에 보고, DB 트랜잭션은 번호 매기기와 저장만 감싼다.
  - 결과(`status`): `verified` · `snippet_not_found`(본문에 없음) · `fetch_failed`(본문이 없는 출처 — 검색 결과, 못 읽은 페이지) · `unknown_source`(이 대화·이 사용자의 출처가 아님, 지어낸 id). 번호(`[n]`)는 답변마다 1부터, 같은 출처·같은 구절은 같은 번호. 답변당 50개.
  - `sources_list {}` — 이 대화의 출처 목록(id, 종류, 사이트, 날짜, URL, 본문 유무). 앞 답변에서 가져온 페이지를 다시 인용할 때. 제목은 `<external_content>` 블록 안에만.
  - 범위(누구·어느 대화·어느 실행)는 **실행 토큰**에서만 온다. 다른 대화·다른 사용자의 `sourceId`는 `unknown_source`이고 그 id는 저장하지 않는다. 같은 대화의 기존 출처는 인용할 때마다 저장된 본문으로 다시 확인한다.
- 실행이 끝나면(완료·중지·실패, 서버 재시작 복구 포함 — 금융 출력기와 같은 `attachNoteTo`) 웹 도구(`web_search`·`web_fetch`·`sources_list`·`cite`·`skill_google-news-search-skill`)를 썼거나 인용을 남긴 답변에 서버가 `citation_note` 부분을 붙인다(`apps/server/src/citations/checker.ts`). 런타임이 쓰거나 고칠 수 없다.
  - 웹 도구도 인용도 없는데 **문장 끝에 `[n]`**이 있는 답변(인용인 척)에도 붙는다: 그 표시는 모두 `unknown_source`, 문단 검사는 하지 않는다. 문장 끝 = 문장 부호 바로 앞(`a[1].length`는 아님)이나 뒤, 또는 줄 끝(뒤에 공백이 있어도). 줄 끝에서 빼는 것은 식 안의 배열 접근뿐이다: 이름 바로 뒤이고 그 이름 앞에 `=`·`(`·`;`·`{`·`,`·연산자가 있거나 `.`·`]`로 이어질 때(`x = a[1]`, `foo(a[1]`, `obj.items[1]`, `a[0][1]`). `… this year[1]`, `Galaxy Ultra[1]` 같은 영문 문장 끝은 표시다. 코드 블록·인라인 코드·`[n](링크)`는 표시가 아니다.
  - `markers`: 화면이 인용 버튼으로 바꿀 `[n]`의 위치(서버가 정함). 그 밖의 `[n]`은 글자 그대로다.
  - `citations`: 답변 글의 `[n]`마다 서버가 인용할 때 정한 상태와 출처(제목·사이트·날짜·URL)·구절(확인됨: 페이지 원문 그대로, 그 밖: 모델이 보낸 구절). 어떤 `cite`도 만들지 않은 `[n]`은 `unknown_source`.
  - `missing`: 인용 표시가 없는 본문 문단(빈 줄로 나뉜 문단, 목록 항목, 표). 빼는 것: 제목(`#`, 굵은 글씨만 있는 줄), 목록 바로 앞의 짧은 머리말(`…:`), **순수한** 면책(금융 면책 문구와 정해진 안내 문장 — "출처가/자료가/근거가 충분하지 않아요·부족해요", "공식 발표를/원문을 확인해 보세요", "최신 정보는/자세한 내용은 원문을 확인해 보세요", "(이 답변은) 공개 보도를/자료를 바탕으로 했어요", "참고용이에요", "정확하지 않을 수 있어요" — 어미만 다를 수 있는 **문장 전체** 일치, `※`는 앞에 붙어도 됨. 문장마다 이 중 하나여야 한다. `※ 반도체 수출은 32% 증가했다.`, `출처가 부족하지만…`, `출처가 부족합니다만…`, `※ 최신 정보는 양산이 확정됐다는 소식입니다.`는 검사한다. 목록: `packages/shared/src/citations.ts` `NOTICES`), 첫 도구 호출 **전**의 짧은 진행 안내 한 문장("자료를 찾아 비교해 볼게요." — 숫자·연결 어미(…니·…서·…고·…지만·…는데, 쉼표, and/so…)·사실을 담는 절(…음을·…다는·…라는·…다고) 없음. "양산이 확정됐음을 알려드리겠습니다."도 검사. "양산이 확정됐으니 더 찾아볼게요."는 검사), 구분선, 코드 블록. 도구 호출 전이라도 무엇을 말하는 문단은 검사한다. 규칙은 `packages/shared/src/citations.ts`(`citationUnits`) 하나를 서버와 화면이 같이 쓴다.
- 기록: DB `citations` 표(0016 마이그레이션, 실행·번호마다 1행, 대화와 함께 지워짐). 본문은 `sources`에만 있다.

### 22.2 화면
- 문장 끝 `[n]`: 확인됨은 보통 표시, 그 밖은 `[n⚠️]`. 데스크톱은 마우스를 올리면, 모바일은 누르면 미리보기(상태, 제목, 사이트·날짜, 인용 구절, **원문 열기** — http(s) 주소만 링크). 누르면 고정, Esc·바깥 누르기로 닫힘.
- 답변 아래 출처 목록: 번호, 제목, 사이트·날짜, URL, 상태 — "원문 구절 확인" / "⚠️ 출처에서 이 내용을 찾지 못했어요" / "⚠️ 출처를 가져오지 못했어요"(`fetch_failed`와 `unknown_source`). 화면이 모르는 상태 값도 ⚠️다(정상 표시 경로 없음).
- 인용 없는 문단은 연한 경고색 + ⚠️, 목록 위에 "⚠️ 일부 내용에 출처 표시 없음".
- 페이지 제목·구절은 글자로만 그린다(HTML로 해석하지 않음).
- 코드: `apps/web/src/citations/`(새 파일), `ChatPage.tsx`에는 연결 지점 셋뿐(본문 `CitedText`, 출처 목록 `CitationSources`, 위쪽 막대 `ResearchToggle`). 데이터 형식은 `@agentlee/shared`의 `CitationNotePart`·`CITATION_STATUS_TEXT`·`citationUnits`.

### 22.3 로그와 시험
- 로그에는 호출마다 `citation.finished`(도구, `ok`/`error`, `citeCode` = 상태나 거부 코드, 소요 시간, ID)만 남는다. 출처 id·구절·본문·URL은 남지 않는다.
- 자주 보이는 코드: `cite_snippet_too_short`, `cite_not_allowed`(토큰의 사용자가 그 대화의 주인이 아님), `cite_limit`, `cite_bad_input`.
- 시험(네트워크 없음): `citations.test.ts`(정규화·오탐 없음, 범위, 문단 규칙), `citation-runs.test.ts`(FakeRuntime 네 시나리오 — 충돌·자료 부족·부분 누락·기존 출처 재사용, 다른 대화·다른 사용자, 복구·중지, 자료 조사 모드 지침, Claude·Codex 녹화 형식 재생으로 같은 시나리오), `apps/web/test/citations.test.ts`(⚠️ 표시), `e2e/citations.spec.ts`(데스크톱 hover·모바일 탭).
- 시나리오와 가짜 페이지: `apps/server/src/runtime/fake-citations.ts`. `FAKE_RUNTIME=1`에서 `/cite conflict|insufficient|partial|reuse`, `/cite-id <sourceId> <구절>`. 이 모드에서는 `https://fixture.agentlee.test/…` 주소와 그 검색어만 서버 안에서 답한다(다른 주소는 평소대로).
- 실런타임 확인 체크리스트: `docs/evidence/citations/checklist.md`.
