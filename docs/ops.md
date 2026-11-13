# 운영 문서

집 Mac에서 Agent Lee를 운영하는 절차. 이 문서에는 인증 정보 값(API 토큰, 터널 토큰, AUD 태그 등)을 적지 않는다.

구성: `브라우저 → Cloudflare(Access) → Tunnel(cloudflared, LaunchDaemon) → 127.0.0.1:3000 Agent Lee(LaunchDaemon)`. 앱은 루프백에만 바인딩하고(`HOST`가 루프백이 아니면 시작 거부) 밖에서는 Tunnel로만 들어온다(PRD D4).

## 1. 데이터와 키의 위치

| 대상 | 기본 위치 | 설정 | 백업 |
|---|---|---|---|
| 데이터 디렉토리 (DB, 파일, 아티팩트, 런타임 홈) | `<repo>/data` | `DATA_DIR` | 아래 행별로 (#37, 21절) |
| SQLite DB | `<DATA_DIR>/agentlee.db` (WAL) | — | 포함(`VACUUM INTO` 스냅샷) |
| 업로드 파일 (#22) | `<DATA_DIR>/files/<사용자 id>/<대화 id>/<파일 id>` — 이름은 서버가 만든 id뿐(사용자 파일 이름은 DB `files.name`에만), 폴더 700·파일 600. 받는 중인 파일은 `<DATA_DIR>/uploads-tmp/` | 24절 | `files/` 포함(DB와 같은 시점, 21.2절) · `uploads-tmp/` 제외 |
| 그 밖의 파일 저장소 | `<DATA_DIR>/artifacts/`, `sources/` (지금은 아티팩트·출처가 DB에 있어 비어 있음) | — | 포함(DB와 같은 시점, 21.2절) |
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
- **구독 한도(FR-9.2)**: 구독 연결이 한도에 걸리면 응답은 `usage_limit`으로 끝나고 대화에 `subscription_limit` 안내 "지금 이 런타임은 한도에 걸렸어요 — 다른 런타임으로 바꿔서 이어갈 수 있어요."가 뜬다. 안내의 `switchTo`에는 지금 쓸 수 있는 다른 런타임이 들어 있다(실제 전환은 칩에서, #19). 한도는 만료가 아니라 연결은 그대로 `passed`다(대신 `connection_limits`에 한도가 적혀 그동안 새 대화는 그 모델로 시작하지 않는다 — 23절). 구독 사용량은 비용 없이 토큰만 기록한다(`usage_records.cost_usd` NULL).
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
- 실행 기록 `runs.instructions`에 쓴 템플릿 버전이 남는다(예: `common@3,youth@2`). #25에서 `common@2`·`research@2`로, 리뷰 #97 22차에서 `common@3`(숫자가 든 구절은 절째로 인용)으로 올렸다.
- 런타임 세션은 시작할 때의 지침을 그대로 쓰므로, `runtime_sessions.instructions_hash`가 지금 조립한 지침과 같을 때만 이어 쓴다. 날짜가 바뀌거나, 모드·계정 표시·템플릿이 바뀌면 다음 실행은 새 세션으로 시작한다(대화 기록은 서버가 다시 넘긴다).

### 14.2 계정·모드 설정
- 아들 계정 표시: 만들 때 `POST /api/admin/users` 본문에 `"youth": true`, 나중에 바꿀 때 `PUT /api/admin/users/<id>/youth` `{"youth": true}`(관리자만). 관리자 화면(#35) 전까지는 이 API로 한다. 이미 만든 아들 계정은 한 번 켠다.
- 자료 조사 모드: 대화 화면 위쪽의 **🔎 자료 조사** 버튼(대화별, 켜지면 "🔎 자료 조사 켜짐" — #25 `apps/web/src/citations/ResearchToggle.tsx`). API로는 `PATCH /api/conversations/<id>` `{"researchMode": true}`(대화 주인). 다음 답변부터 `research` 섹션이 들어간다(지침이 바뀌므로 새 런타임 세션).

### 14.3 지침 바꾸기
1. 해당 `.md`의 본문을 고친다.
2. 머리글의 `version:`을 1 올린다(내용이 바뀌면 항상). 머리글 형식(`---` / `id: <파일 이름>` / `version: <n>` / `---`)이 틀리면 서버가 시작하지 않는다.
3. `pnpm -s vitest run apps/server/test/instructions.test.ts -u`로 스냅샷을 갱신하고, 바뀐 스냅샷과 버전 기대값(`common@3` 등 — `instructions.test.ts`, `citation-runs.test.ts`)을 PR에서 함께 검토한다.
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

### 18.5 패널·카드·목록 (#28)
방식과 근거는 `docs/decisions/isolation.md` "아티팩트 패널·목록 (#28)"에 있다. 설정할 것은 없다(새 표·마이그레이션 없음).
- **대화 속 카드:** 에이전트가 아티팩트를 만들거나 고치면 그 답변에 카드("v1 만듦"·"v2 새 버전")가 붙는다. 카드는 서버가 **그 run이 실제로 저장한 버전**(`artifact_versions.run_id`)으로 만든다 — 같은 내용으로 고쳐 새 버전이 없거나 도구가 실패하면 카드도 없다.
- **오른쪽 패널:** 이 화면에서 보낸 요청의 답변이 아티팩트를 만들면 **저절로** 열린다(다른 아티팩트를 직접 열어 두었으면 그대로 둔다). 카드를 눌러도 열린다. 주소는 `/c/<대화>?artifact=<id>&v=<버전>`(`v`가 없으면 최신 — 다음 수정이 오면 저절로 따라간다). 링크로 열고, 새로 고쳐도 그대로이고, ✕·Esc로 닫는다. HTML·차트·표 아티팩트는 안을 누른 뒤에도 Esc가 된다(원본 끝에 붙는 작은 스크립트가 알린다 — HTML은 문서가 닫히지 않은 주석·`<textarea>`로 끝나거나 인라인 스크립트가 256개를 넘으면 안 될 수 있다). SVG·마크다운·코드는 안을 누른 뒤에는 Esc가 닿지 않는다 — Tab으로 나와 ✕로 닫는다. 버전 선택, 되돌리기(새 버전으로 복사), 원본 내려받기(html은 HTML 파일), 차트·표는 **HTML**도(`/a/<id>/v/<버전>/download?format=html`, 서버가 그린 페이지·스크립트 없음), PNG·PDF. 모두 `attachment`. 화면 폭 900px 이하(휴대폰)에서는 패널이 화면 전체를 덮고 대화는 닫을 때까지 조작되지 않는다.
- **목록 화면 `/artifacts`:** "내가 만든 것" — 내 모든 대화의 아티팩트, 최근에 바뀐 것부터(`GET /api/artifacts`, 50개씩 "더 보기"). 누르면 그 대화에서 패널로 열린다. "공유받은 것"은 가족 공유(#52) 전까지 빈 화면이다.
- **권한:** 패널·카드·목록은 #27과 같은 경로·검사를 쓴다(만든 사람만, 관리자도 못 본다). 남의 아티팩트 id로 패널을 열면 "이 아티팩트를 볼 권한이 없어요"만 보인다.
- **확인:** `E2E_PORT=3112 pnpm e2e e2e/artifact-panel.spec.ts`(데스크톱·모바일: 저절로 열림, 수정 요청 → v2 → v1 보기 → 되돌리기, iframe 안에서 Esc, 휴대폰 전체 화면, 목록, 다른 가족 거부). FakeRuntime `/artifact-slow <종류> <제목>`은 만든 뒤 4초 더 답한다(흐르는 중인 run을 다른 화면에서 볼 때 시험용), `pnpm test apps/server/test/artifacts.test.ts`("artifact panel, cards and list").

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
- 허용하지 않은 모델은 그 사람의 모든 선택기에서 빠진다: 설정의 기본값 선택기는 `GET /api/runtimes`(허용된 것만), 칩(#19)은 그중 지금 답할 수 있는 것만(`GET /api/runtimes/usable`, 23절)을 읽는다. 서버도 막는다: 그 모델로 보내기·고치기·다시 생성은 403 `model_not_allowed`, 기본값으로 저장도 403(아래).
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
| `files/`·`artifacts/`·`sources/` | 데이터 폴더의 파일 저장소. `files/`는 업로드 파일(#22, 24절) — DB가 가리키는 파일이 하나라도 없으면 백업이 실패한다(`FILE_REFERENCES`). 아티팩트·출처는 지금 DB에 있어 비어 있다 |
| `manifest.json` | 형식 버전, 시각, 스키마 버전(적용된 마이그레이션 수·마지막 시각), 파일마다 크기·SHA-256, 키 확인 값(마스터 키로 암호화한 고정 문구 — 키 자체가 아님) |

| 빠짐 | 이유 |
|---|---|
| 마스터 키 | 키는 `DATA_DIR` 밖에 있고(서버가 강제) 백업 코드는 키 파일을 읽지 않는다. 키와 백업이 함께 있으면 암호화가 의미 없다 — 3절의 따로 보관 절차 |
| `runtimes/` | CLI 세션·캐시는 서버 기록(대화)에서 다시 만들어진다(복원하면 모든 런타임 세션을 무효로 표시해 다음 턴이 새 세션으로 시작). 로그인 중 폴더에는 제공자 토큰 파일(`auth.json`)이 평문으로 잠깐 있을 수 있어 넣으면 "인증 정보는 암호화 상태" 원칙이 깨진다. `.quarantine`은 지우는 중인 로그인 폴더다 |
| `skills/` | 허용 목록 스킬의 복사본일 뿐이다. 복원 뒤 `pnpm skills:install`이 원본에서 다시 복사하며 파일마다 해시를 확인한다(백업본을 믿을 이유가 없다) |
| 임시 폴더 | 실행 중인 프로세스의 것. 업로드 받는 중 폴더 `uploads-tmp/`는 검사 전의 파일이라 넣지 않는다(서버 시작 때 비운다). 내보내기 렌더러의 임시 폴더는 시스템 임시 폴더에 있다. 데이터 폴더 잠금(`.data.lock.db`)은 데이터 폴더 밖, 옆에 있다(21.4절) |
| `.env` | 레포의 설정 파일. 스킬 비밀 등은 비밀번호 관리자에 따로 둔다(백업 대상 아님) |

- 백업 폴더 `BACKUP_DIR`(기본 `~/agentlee-backups`)은 `DATA_DIR` 밖이어야 한다(복원이 `DATA_DIR`을 통째로 바꾸므로), 레포 밖이어야 한다(실수로 커밋되지 않게), 마스터 키를 품으면 안 된다 — 어기면 시작을 거부한다. 폴더는 700, 백업 폴더도 700, 파일은 모두 600이다(느슨하면 백업할 때 다시 조인다).
- 디스크 고장에 대비하려면 `BACKUP_DIR`을 Time Machine이나 외장 디스크에 함께 복사한다. 키는 같은 곳에 두지 않는다(3절).

### 21.2 같은 시점 (일관 기준점)
- DB는 `VACUUM INTO`로 복사한다: 한 문장·한 읽기 트랜잭션이라 그 순간의 DB 그대로다(다른 연결이 쓰는 중이어도). 새로 쓰는 파일이라 지운 행이 빈 페이지에 남지 않는다 — 지운 대화가 이후 백업에 남지 않는 이유(온라인 백업 API는 페이지를 그대로 복사해 지운 내용이 남을 수 있어 쓰지 않았다).
- 파일은 **짧은 쓰기 잠금**으로 맞춘다(`FileWriteLock`, `app.fileWrites`). 파일 저장소에 쓰는 코드는 행과 파일을 한 `fileWrites.write()` 안에서 함께 쓴다. 백업은 잠금을 잡고(진행 중인 쓰기가 끝나길 기다리고, 새 쓰기는 기다리게 하고) DB 스냅샷 → 파일 복사를 한 뒤 놓는다. 지금 가족 규모에서 잠금은 몇 초 이하이고 쓰는 쪽은 기다릴 뿐 실패하지 않는다. DB 쓰기는 잠그지 않는다(스냅샷이 이미 한 시점이라).
- 내용 해시 경로(불변 저장)를 택하지 않은 이유: 같은 효과를 잠금 하나로 얻는다. 업로드(#22, 24절)는 파일을 잠금 밖의 `uploads-tmp/`로 받고 검사한 뒤, 잠금 안에서는 이름 바꾸기와 행 넣기만 한다 — 50MB 파일을 받는 동안 백업을 붙잡지 않고, 백업 중에는 저장 직전에서 기다릴 뿐이다. 업로드 파일은 id로 한 번 쓰고 바꾸지 않는다(사실상 불변). **새 파일 저장소를 만들면** `BACKUP_FILE_ROOTS`(`apps/server/src/backup/backup.ts`)에 넣고 쓰기를 `fileWrites.write()`로 감싼다.
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
  - `cite {sourceId, snippet}` — 서버가 그 출처의 **저장된 본문**(§17.2)에서 구절을 찾는다. 원칙: 애매하면 정규화하지 않는다(잘못된 "찾지 못함"은 ⚠️로 보이지만 잘못된 "확인"은 안 된다).
    - 정규화: Unicode NFC(글자 묶음 단위 — 풀어 쓴 한글·악센트도 같음), 전각 ASCII → ASCII, `…` → `...`, 따옴표 문장 부호를 하나로, 대시 문장 부호(‐ ‑ ‒ – — ―)를 `-`로, 물결 `∼` `〜` `～`와 분수 빗금 `⁄`를 `~` `/`로, 보이지 않는 문자 제거, 공백 묶음을 한 칸으로, 흔한 HTML 개체 풀기. **하지 않는 것**: NFKC(위·아래 첨자, `①`), 대소문자 접기, 줄 끝 하이픈 잇기, 각주 번호 빼기, 프라임·백틱·`´`·빼기 부호 `−` 접기, 숫자 바로 뒤(공백 허용) 따옴표 접기(단위 `12'`·`12"`).
    - 그 뒤 **구절 전체가 그대로** 있어야 한다(유사도·일부 일치·"…"로 이은 조각 없음). 정규화 후 8자 미만은 `cite_snippet_too_short`. 짝 따옴표로 감싼 인용은 먼저 따옴표째로, 없으면 뺀 꼴로 찾는다.
    - 경계: 일치는 공백·문장 부호·괄호·따옴표·글의 처음과 끝에서만 시작하고 끝난다(낱말 중간이나 `-` `/` `~` `%` 같은 기호에 붙은 곳은 아님). 끝에서는 닫힌 조사 목록(`KOREAN_PARTICLES`·`COMBINING_PARTICLES` — `만`은 수 단위라 목록에 없다)이 이어지고 그 뒤가 토큰 경계면 된다(`수출이`, `반도체였다`). 십·백·천·만·억·조로 끝난 일치 뒤 일~구(`백이 명`)는 한 수라 거부.
    - **숫자 가장자리 = 절 경계**(리뷰 #97 22차, 6–21차의 숫자 경계 규칙을 대신함): 일치의 처음 두 토큰에 숫자가 있으면 그 일치는 절의 처음(글 처음, 줄바꿈 뒤, 문장·절 부호나 여는 괄호·따옴표 뒤 — 공백 허용)에서 시작해야 하고, 그 앞에 (공백·줄바꿈·통화 기호 너머) 부호 `-` `−` `+`가 있으면 안 된다. 마지막 두 토큰에 숫자가 있으면 절의 끝(문장·절 부호 `. , ! ? ; :`, 닫는 괄호·따옴표, `…`, 줄바꿈, 글 끝 — 공백 허용, 또는 일치 자체가 그 부호로 끝남)에서 끝나야 한다. 절 경계·부호·숫자 연속은 엔티티를 해석한 본문에서 본다 — `&minus;`는 부호, `&thinsp;`·`&nbsp;`는 공백, 엔티티 끝의 `;`는 경계가 아니다(모르는 엔티티는 글자 그대로라 그 `;`는 진짜 `;`; 리뷰 #97 25차). 숫자 속 부호는 절 경계가 아니다 — 숫자 사이의 부호(`3.5`, `1,234`, `3:1`), 양쪽에 숫자가 있는 `.`·`,`·`:`(공백 허용 — HTML 추출의 `1, 234 억`·`1. 5 mg`, 날짜 `2026. 11. 12.`), 숫자 바로 앞의 `.`(앞 0 없는 소수 `.5%`·`.25 mg`), 숫자 뒤 따옴표(단위)(리뷰 #97 23차). 날짜 마지막 수 뒤 `.`는 뒤에 숫자가 없어 경계로 남아, 날짜 전체 인용은 확인된다. 그래서 `3, 4명`처럼 공백 둔 쉼표 사이 숫자도 숫자 하나로 보아 그 사이에서 끊지 않는다. 그래서 단위·배수·범위·`/` 복합 단위·퍼센트포인트·과학적 표기·`2시간 반` 같은 숫자 절단이 모두 거부된다.
  - **받아들인 한계**((i)를 빼면 모두 잘못된 "찾지 못함" = ⚠️일 뿐, 잘못된 "확인"은 없다): (b) 영문 대소문자는 구분한다 — 원문과 같은 대소문자로 인용해야 확인된다. (c) 백·천·조로 끝나는 낱말 뒤 조사 `이`(`공백이`의 `공백`)는 수(`백이`)와 구분하지 못해 거부된다. (d) 숫자 바로 뒤 따옴표는 단위로 보아 그대로 비교하므로, 따옴표로 묶은 수(`"100"이라고`)의 닫는 따옴표는 원문과 같은 모양이어야 하고, 그 따옴표는 절 끝으로 세지 않는다. (h) 숫자가 든 인용은 그 숫자가 속한 절(문장 부호·줄바꿈까지)을 통째로 인용해야 확인된다 — `수출 증가율은 32%`처럼 절 중간에서 끊으면(`…32%로 집계됐다.`) ⚠️. 숫자 없는 인용도 `만` 앞에서는 끝날 수 없다(`만`은 조사 목록에 없다 — `만`까지 포함하면 확인). (i) HTML에서 소수점과 숫자가 다른 요소로 나뉘어 공백이 생긴 경우('. 5%')는 문장 끝과 구분할 수 없어 소수로 보지 않는다 — 이 한 가지는 잘못된 "확인"(`5%`부터의 인용)이 될 수 있다. `…했다. 3명이…`처럼 마침표 뒤 숫자로 시작하는 새 문장 인용을 살리려는 선택이다(리뷰 #97 24차, 코디네이터 결정).
  - 영어 등 라틴 글자 뒤에 결합 문자가 오면(NFD `café`) 빠른 경로를 거치지 않고 NFC로 묶는다.
  - 속도: 한 번에 한 줄로 정규화하고(글자별 캐시), 페이지의 정규화 결과를 본문 해시로 4개까지 기억한다(본문이 같을 때만). 본문 한도(40만 자)에서 첫 확인 25–35ms, 같은 페이지 다시 확인은 1ms 미만(이 Mac). 중복·개수 한도는 대조 전에 보고, DB 트랜잭션은 번호 매기기와 저장만 감싼다.
  - 결과(`status`): `verified` · `snippet_not_found`(본문에 없음) · `fetch_failed`(본문이 없는 출처 — 검색 결과, 못 읽은 페이지) · `unknown_source`(이 대화·이 사용자의 출처가 아님, 지어낸 id). 번호(`[n]`)는 답변마다 1부터, 같은 출처·같은 구절은 같은 번호(같음은 `citations.snippet_key` — 정규화한 구절의 SHA-256, 평문은 저장하지 않음(정규화가 전각을 접어 저장 구절에 없는 비밀을 만들 수 있으므로, 23차). 시작 때 모든 행의 키를 저장된 구절에서 다시 계산해 다른 것을 바꾼다 — 저장된 키 모양은 보지 않는다(옛 평문 키가 `sha256:`으로 시작할 수 있으므로, 24차). 앞의 같은 구절이 확인되지 않았으면 다시 대조해, 이번에 확인되면 **같은 번호를 유지한 채** 확인으로 바꾼다 — 답변 속 `[n]`이 그대로 맞도록; 리뷰 #97 15차). 답변당 50개.
  - `sources_list {}` — 이 대화의 출처 목록(id, 종류, 사이트, 날짜, URL, 본문 유무). 앞 답변에서 가져온 페이지를 다시 인용할 때. 제목은 `<external_content>` 블록 안에만.
  - 범위(누구·어느 대화·어느 실행)는 **실행 토큰**에서만 온다. 다른 대화·다른 사용자의 `sourceId`는 `unknown_source`이고 그 id는 저장하지 않는다. 같은 대화의 기존 출처는 인용할 때마다 저장된 본문으로 다시 확인한다.
- 실행이 끝나면(완료·중지·실패, 서버 재시작 복구 포함 — 금융 출력기와 같은 `attachNoteTo`) 웹 도구(`web_search`·`web_fetch`·`sources_list`·`cite`·`skill_google-news-search-skill`)를 썼거나 인용을 남긴 답변에 서버가 `citation_note` 부분을 붙인다(`apps/server/src/citations/checker.ts`). 런타임이 쓰거나 고칠 수 없다.
  - 웹 도구도 인용도 없는데 **문장 끝에 `[n]`**이 있는 답변(인용인 척)에도 붙는다: 그 표시는 모두 `unknown_source`, 문단 검사는 하지 않는다. 문장 끝 = 문장 부호 바로 앞(`a[1].length`는 아님)이나 뒤, 또는 줄 끝(뒤에 공백이 있어도). 줄 끝에서 빼는 것은 배열 접근뿐이다: `]` 바로 뒤(`m[0][1]`), 또는 이름 바로 뒤이고 그 이름 바로 앞이 `[`·`]`, 또는 `=`(`+=`·`==` 포함)·`(`(공백 허용)일 때(`x = a[1]`, `f(a[1]`, `arr[idx[1]`). 점·쉼표·하이픈·`&`는 식으로 보지 않는다 — `Node.js[1]`, `Python 3.12[1]`, `example.com[1]`, `Windows, Linux[1]`, `GPT-4o[1]`, `S&P500[1]`은 표시다. 문장 끝의 `obj.items[1]`도 표시로 본다(드문 과잉 경고 — 리뷰 #97 4·5차). 코드 블록·인라인 코드·`[n](링크)`는 표시가 아니다.
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

## 23. 기본값과 칩 — 대화별 런타임·모델 (#19)
PRD D3, FR-3.5, FR-12. 새 대화는 아무것도 고르지 않고 바로 시작하고, 칩으로 그 대화만 바꾼다.

### 23.1 새 대화가 무엇으로 시작하나
- **기본값**: 본인 설정 → 관리자의 처음 값(20.2절) → 서비스 기본값 Claude Code · `claude-opus-5-5` 순(#35). 이 값을 **대화를 만들 때** 대화에 적어 둔다(`conversations.runtime/model/effort/use_shared`, 0017). 그 뒤 기본값을 바꿔도 이미 있는 대화는 그대로다(FR-12.5) — 다음 새 대화부터 적용된다.
- **쓸 수 있다** = 런의 검사(`RunAccess.resolve`)를 그대로 통과하고, 연결이 필요한 런타임이면 그 사람이 쓸 수 있는 `passed` 연결이 있고(시험 안 한 연결·남의 개인 연결·끊긴 연결은 안 셈), 그 연결(개인 우선, FR-11.3)이 **사용 한도에 걸려 있지 않다**.
- **대체 순서(FR-12.6)** — 기본 런타임·모델을 쓸 수 없을 때:
  1. 같은 런타임에서 허용된 모델 중 모델 목록(20.3절, 어댑터 순서) 첫 번째
  2. 다른 런타임(Claude Code → Codex 순)의 그 사람 기본 모델, 없거나 안 되면 그 런타임의 허용된 첫 모델
  3. 아무것도 없으면 새 대화 화면 대신 “쓸 수 있는 런타임이 없어요 — 관리자에게 문의하세요” 화면. 이때 만들어진 대화(API)는 설정 없이 남고, 첫 메시지를 보낼 때 다시 계산한다.
  - 추론 강도만 막혔으면 대체가 아니다: 같은 모델로, 허용된 추론 강도(모델 기본값 → 첫 허용값)로 시작한다.
  - **사용 한도(FR-9.2)**: 답이 `usage_limit`으로 끝나면 그 연결에 한도를 범위별로 적는다(`connection_limits`, 0018: 연결·범위·끝나는 시각·기록 시각). `limitFor`(connections/service.ts)가 정한다:
    - **구독**: 범위는 연결 전체(`all`). Claude SDK가 모델별 창(`rateLimitType` `seven_day_opus`·`seven_day_sonnet`)이라고 하면 그 모델 계열만(`family:opus`). 끝나는 시각은 플랜의 해제 시각(`resetsAt`, 1분 뒤~7일 사이로 자름), 없으면 **5시간**(`SUBSCRIPTION_COOLDOWN_MS`, Claude 구독의 가장 짧은 창).
    - **API 키**: 범위는 그 답의 모델만(`model:<id>` — API 제한은 모델별·분 단위). 끝나는 시각은 해제 시각이나 공급자의 `retry-after`(1초 이상, 런타임이 알려 줄 때 — 지금 SDK·Codex는 주지 않는다), 없으면 **1분**(`API_KEY_COOLDOWN_MS`). 공용 키가 잠깐 막혀도 가족 전체가 오래 못 쓰지 않게 공급자가 말한 만큼만 막는다.
    - 그동안 새 대화는 **그 범위에 드는 모델**로 그 연결에서 시작하지 않고 위 순서로 대체한다(같은 런타임의 다음 모델이 먼저: Opus 창이면 Sonnet). 안내 끝에 “(사용 한도 · ○시 이후 다시 쓸 수 있어요)”가 붙고 설정 화면도 원인과 시각을 말한다.
    - **끝나는 때**: 끝나는 시각이 지나거나, **한도를 기록한 뒤에 시작한** 답이 그 범위의 모델로 끝까지 나오거나(먼저 시작해 늦게 끝난 답, 다른 모델의 답은 근거가 아니다), 기록 뒤에 시작한 연결 테스트가 그 범위의 모델로 통과하거나, 새 키·새 로그인을 넣으면. 이미 그 연결을 쓰던 대화는 그대로 보낼 수 있다(공용 전환은 11절처럼 물어본다). 연결 상태는 `passed` 그대로다. 다른 후보가 없으면 그동안 새 대화 화면은 “쓸 수 있는 런타임이 없어요”다.
- **안내 한 번**: 대체로 시작한 대화에는 `fallbackNotice`가 붙는다. 대화 화면은 `POST /api/conversations/<id>/fallback-notice/consume`으로 **안내를 가져간 경우에만** 칩 옆에 “기본값을 쓸 수 없어 ○○로 시작했어요”를 띄운다. 서버는 읽기와 지우기를 한 트랜잭션으로 해서 탭 여러 개·동시 요청 중 하나만 받는다(나머지는 `null`). 요청이 실패하면 아무것도 띄우지 않고 안내는 다음 화면을 위해 남는다. 화면은 캐시의 안내 칸만 지운다(늦게 온 응답이 새 칩 설정을 덮지 않게). 칩으로 바꿔도 지워진다.
- **설정 화면**: 기본값 섹션에 지금 새 대화가 무엇으로 시작하는지 안내한다(`GET /api/settings/defaults`의 `start`·`fallback`) — 대체 중이면 “기본값(…)을 지금 쓸 수 없어 새 대화는 ○○로 시작해요”, 아무것도 없으면 관리자 문의 안내. 권한이 바뀌어 저장된 값이 막힌 경우의 기존 안내(`unavailable`)도 그대로다.

### 23.2 칩
- 입력창 옆 칩(`Claude Code · Opus 5.5`)을 누르면 런타임·모델·추론 강도와(개인·공용 연결이 둘 다 있을 때) “공용으로 쓰기”를 고른다. 목록은 `GET /api/runtimes/usable` — 허용된 런타임·모델·추론 강도 중 `passed` 연결이 있는 것만(연결이 필요 없는 FakeRuntime은 그대로). 연결마다 지금 걸린 한도(`limits: [{scope, until}]`)가 있어, 한도에 걸린 모델은 “(한도 · ○시까지)”로 보이고 고를 수 없으며, 모든 모델이 한도인 런타임도 고를 수 없다(서버도 다른 런타임·모델·연결로 옮길 때 403 `connection_limited`). 런타임만 고르면 기본 모델이 한도일 때 한도 아닌 첫 모델로 간다. 개인 연결만 한도면 “공용으로 쓰기”로 바꾼다. 이미 그 모델인 대화의 추론 강도는 바꿀 수 있다.
- 바꾸기: `PUT /api/conversations/<id>/settings` `{runtime?, model?, effort?, useShared?}`. **다음 메시지부터** 적용된다 — 지금 쓰고 있는 답은 시작한 설정 그대로다. 그 대화에만 적용되고 기본값은 바뀌지 않는다.
  - 런타임만 바꾸면 그 런타임의 내 기본 모델·추론 강도(없거나 막혔으면 허용된 첫 모델), 모델만 바꾸면 그 모델의 기본 추론 강도(내 기본 모델이면 저장한 추론 강도). 다른 런타임으로 가면 “공용으로 쓰기”는 꺼진다.
  - 허용되지 않은 런타임·모델·추론 강도(모델이 받지 않는 값 포함), 연결 없는 런타임, 공용 연결 없는 “공용으로 쓰기”: 403 + 런 검사와 같은 코드(`runtime_not_allowed`·`model_not_allowed`·`effort_not_allowed`·`connection_not_allowed`), 한도에 걸린 연결로 옮기기: 403 `connection_limited`. 아무것도 바뀌지 않는다. 남의 대화는 그 전에 403 `forbidden`. 메시지 하나에만 쓰는 선택(보내기 본문의 `runtime/model/effort`, #17)도 그대로 있고 같은 검사를 받는다.
  - 새 대화 화면에서 칩을 바꾸면 서버가 같은 규칙으로 결과를 계산해 보여 주고(`POST /api/settings/preview` `{base, change}`, 저장 안 함, 같은 403 — 한도 걸린 기본 모델이면 한도 아닌 첫 모델), 대화를 만들 때 그 값을 함께 보낸다(`POST /api/conversations` `{settings}`, 같은 검사). 화면에는 자체 계산이 없다. 바꾼 순서대로 하나씩 미리보고, 미리보기가 아직 오는 중에 보내면 **결과를 기다렸다가** 그 값으로 만든다(`ChipChoice`). 미리보기가 실패했으면 그 오류를 입력창 아래에 보이고 보내지 않는다 — 다시 보내면 칩에 보이는 마지막 값으로 간다.
  - “공용으로 쓰기”만 바꾸다 그 연결이 지금 모델에 한도면 403 `connection_limited`이고 아무것도 바뀌지 않는다(모델·추론 강도를 몰래 바꾸지 않는다). 한도 아닌 첫 모델로 가는 것은 런타임을 실제로 바꿀 때뿐이다.
- **구분선**: 답을 쓰기 직전, 그 답의 런타임·모델·추론 강도가 바로 앞 답과 다르면 그 자리에 `── 여기부터 Codex · GPT-6 Luna ──`(시스템 메시지의 `divider` 파트)를 기록한다. 바꿨다가 보내기 전에 되돌리면 구분선이 없고, 여러 번 바꿔도 하나다. 수정·다시 생성으로 턴을 바꾸면 마지막 남은 답 뒤의 구분선(바뀐 턴의 것, 그 바로 앞 것 포함)을 다시 맞춘다: 지금 답하는 쪽을 이미 가리키는 것 하나만 남기고 나머지는 기록에서 뺀다(다른 잘린 메시지처럼 보관). 그래서 다시 생성을 반복해도 구분선은 하나, 되돌린 뒤 고치면 남은 구분선이 없다. 추론 강도만 바뀌면 “· 추론 low”가 붙는다. 바꾼 뒤 “다시 생성”은 새 설정으로 답하고 구분선은 그 답 바로 앞에 들어간다(“다른 런타임으로 이어가기” 버튼은 칩을 연다).
- 앞 대화 내용을 새 런타임에 넘기는 방식(요약 + 최근 메시지)은 #45다. 지금은 런타임이 바뀌면 새 세션에 기록 전체가 들어간다.

### 23.3 확인 방법
- 자동: `apps/server/test/chat-settings.test.ts`(대체 순서·한도 대체와 해제·안내 한 번(동시 소비)·칩 목록·다음 메시지부터·수정/다시 생성 구분선·기존 대화 불변·403·남의 대화 `forbidden`), `apps/web/test/chip.test.ts`, `e2e/runtime-chip.spec.ts`(수용 기준 7).
- e2e 서버(`FAKE_RUNTIME=1`)의 FakeRuntime “Claude Code”에는 Fake Large·Fake Small과 서비스 기본값 `claude-opus-5-5`(Opus 5.5)가 있다.

## 24. 파일 업로드 (#22)
PRD FR-4.1·4.2·4.6. 방식과 근거는 `docs/decisions/isolation.md` "파일 업로드 (#22)"에 있다. 내용 추출은 #48, HWP는 #23, 파일 뷰어는 #24.

### 24.1 무엇을 받나
- **형식(FR-4.2)**: PDF, HWP(5.0)·HWPX, DOCX, XLSX, CSV, PPTX, TXT·MD, PNG·JPG(JPEG). 그 밖은 받지 않는다 — 특히 SVG·HTML·XML(활성 콘텐츠), 압축 파일, 실행 파일, 옛 Office(DOC·XLS·PPT), GIF·WebP. 목록은 `packages/shared/src/files.ts`의 `FILE_KINDS` 하나다(화면의 파일 선택기와 서버가 같은 것을 쓴다).
- **한도(FR-4.6)**: 파일당 50MB(Cloudflare 무료 플랜 요청 한도 100MB 안), 대화당 20개(보낸 것·아직 입력창에 있는 것 모두). 화면이 올리기 전에 검사해 칩에 바로 알려 준다. 서버가 다시 검사한다:
  - 크기: `Content-Length`가 50MB를 넘으면 본문을 받기 전에 413. 길이를 밝히지 않은 요청(chunked)은 받으면서 세다가 50MB를 넘는 순간 읽기를 멈추고 413을 보낸 뒤 연결을 닫는다. 본문은 메모리에 모으지 않고 `uploads-tmp/`의 임시 파일로 바로 쓴다(그 파일도 50MB를 넘지 않는다).
  - 개수: 받기 전에 한 번(빠른 거절), 그리고 행을 넣는 문장 자체가 `개수 < 20`일 때만 넣는다(한 SQL 문) — 동시에 21개를 올려도 20개만 남는다(시험).
  - 형식: 확장자로 고른 형식과 **내용(매직 바이트)** 이 같아야 한다. 확장자를 바꾼 파일(PNG를 `.pdf`로, 실행 파일을 `.txt`로, HTML을 `.md`로)은 415 `file_type_mismatch`. 이 판별은 최선일 뿐이다(두 형식을 겸한 파일은 지날 수 있다) — 무엇이든 항상 내려받기로만 나가므로(24.3절) 브라우저에서 실행되지 않는다.
- **취소**: 입력창 칩의 ✕는 업로드 id로 서버에서 취소한다(`DELETE /api/uploads/:uploadId`) — 올리는 중이든, 저장됐든, 아직 서버에 닿지 않았든. 취소한 업로드는 저장되지 않거나 지워지고, 메시지에 실리지 않는다. 아직 서버에 닿지 않은 업로드의 취소는 DB `upload_cancellations`에 6시간 남아(재시작에도) 늦게 온 업로드를 거절한다. 한 사람이 쌓을 수 있는 것은 100개까지(429 `too_many_cancels`)이고, 지난 기록은 서버가 시작할 때와 10분마다 지운다.
- **오류 코드**: 413 `file_too_large`, 409 `too_many_files`, 415 `file_type_unsupported`·`file_type_mismatch`, 400 `file_empty`·`invalid_request`, 보낸 파일 지우기·취소 409 `file_attached`, 취소된 업로드 409 `upload_cancelled`, 메시지에 없는 파일을 붙임 400 `invalid_attachment`.

### 24.2 어디에, 어떻게
- 바이트: `files/<사용자 id>/<대화 id>/<파일 id>`(모두 서버가 만든 id). 사용자가 붙인 파일 이름은 경로에 쓰지 않는다 — DB `files.name`에만 있고, 보여 줄 때와 내려받을 때(`Content-Disposition`)만 쓴다.
- 행: DB `files`·`upload_cancellations` 표(0019 마이그레이션) — 주인·대화·보낸 메시지(`message_id`, 입력창에 있는 동안 비어 있음)·이름·서버가 판별한 형식과 MIME·크기·SHA-256.
- **파일 바이트는 받은 그대로 저장한다**: 가족이 직접 올린 자기 문서라 알려진 비밀 값 가림(1절)을 바이트에 하지 않는다 — 고치면 원본이 깨지고(PDF·DOCX 서명·압축), 내려받은 파일이 올린 파일과 달라진다. 파일 이름은 쓸 때 가리고, 비밀이 나중에 등록되면 재가림도 한다(`secrets/columns.ts`의 `files.name`). 파일을 내려줄 때도 바이트는 그대로다(응답 가림은 텍스트 응답에만 — 파일은 스트림이라 지나간다).
- **쓰기 잠금(#37)**: 저장소에 파일을 넣고·지우는 일은 모두 `app.fileWrites.write()` 안에서 그 행과 함께, 동기로 한다. 백업이 잠금을 잡고 있으면 업로드(받기는 끝났어도 저장 직전)와 대화 지우기는 기다린다(시험). 순서: 검사한 임시 파일을 제자리로 옮긴 다음 행을 넣는다 — 그 사이에 죽으면 행 없는 파일이 남고(다음 시작에 정리), 파일 없는 행은 생기지 않는다.
- **지우기**: 대화를 지우면 그 대화의 행(외래 키 cascade)과 파일·빈 폴더가 함께 지워진다. 사용자 행이 지워지면(앱에는 사용자 삭제가 없다 — 비활성화만) 행은 cascade로 가고, 파일은 다음 시작의 정리가 지운다. 입력창 칩의 ✕는 아직 보내지 않은 파일을 서버에서도 지운다(올리는 중에 빼면 끝나는 즉시 지운다). 보내지 않은 파일은 새로고침해도 칩으로 다시 보인다. 보낸 메시지를 고쳐 다시 보내도 첨부는 그대로 따라간다.
- **링크**: `files/` 아래의 사용자·대화 폴더가 심볼릭 링크면 서버는 그 안을 읽지도, 쓰지도, 지우지도 않는다(읽기 404, 업로드 500). 저장소 폴더를 다른 디스크로 옮기려면 링크가 아니라 `DATA_DIR` 전체를 옮긴다.
- **시작할 때 정리**: 서버가 시작하면(열린 DB 파일이 데이터 폴더의 `agentlee.db` 그 자체일 때만 — 다른 DB로 가는 링크면 `file.sweep_skipped`를 남기고 건너뜀) 잠금 안에서 `uploads-tmp/`를 비우고, 행이 없는 저장소 파일을 지운다. 지우는 것은 서버가 붙이는 이름(`<사용자>/<대화>/<UUID>`)뿐이고 그 밖의 파일은 건드리지 않는다. 지운 수는 `file.swept`(개수만).

### 24.3 내려주기
- `GET /api/files/:id/content` — 올린 사람만(관리자도 403, 로그인 전 401, 권한 행렬). 항상 `Content-Disposition: attachment`(ASCII 대체 이름 + RFC 5987 `filename*`, 아티팩트 내려받기와 같은 이름 정리), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'; …`, `Cache-Control: no-store`, `Cross-Origin-Resource-Policy: same-origin`. MIME은 서버가 판별한 형식의 것이다(브라우저가 보낸 값은 쓰지 않음).
- `?inline=1`은 PNG·JPG만 화면에 보이게 한다. 그 밖은 붙여도 내려받기다. SVG·HTML·XML은 받는 형식이 아니고, 위장한 것도 판별이 대부분 거르지만, 거르지 못한 것이 있어도 인라인으로 나가지 않는다.
- 저장소 파일이나 그 위의 사용자·대화 폴더가 링크로 바뀌었거나 크기가 행과 다르면 404(링크를 따라가지 않는다).

### 24.4 로그와 확인
- 로그: 업로드마다 `file.uploaded`(결과 `fileCode` = `file_ok`·`file_aborted`·위 오류 코드, 소요 시간, 사용자·대화 ID). **파일 이름·내용·크기는 남기지 않는다**(시험).
- 시험: `pnpm test apps/server/test/files.test.ts`(형식 판별 표, 51MB(길이 밝힘·chunked), 21번째·동시 21개, 위장 확장자, 남의 파일 403, 헤더, 백업 포함·참조 검사, 쓰기 잠금, 지우기·시작 정리), `E2E_PORT=3111 pnpm e2e e2e/files.spec.ts`(첨부 버튼·끌어다 놓기·붙여넣기, 업로드 전 거절, 실패 칩, 새 대화, 남의 파일 403).

## 25. 예약 엔진 (#33)
PRD FR-8.2·8.6·8.7, 수용 기준 5. 엔진만 — 예약 화면은 #55, 실제 런타임 실행(전용 대화에 결과·푸시)은 #56이다.

### 25.1 무엇이 어디에 있나
- 표(0020 마이그레이션): `schedules`(이름, 프롬프트, 유형 `once|daily|weekdays|weekly|cron`, `date`·`time`·`weekdays`·`cron`, 시간대(기본 `Asia/Seoul`), 스킬, 알림(기본 켬), 런타임·모델·추론 강도·공용 연결, 일시정지, 주인, 결과 대화(#56), `next_run_at`)와 `schedule_runs`(실행 하나 = 행 하나).
- **실행 키**(`schedule_runs.run_key`, 유니크): 정규 회차·놓친 회차는 `<예약 id>@<예정 시각 ms>`, 바로 실행은 `<예약 id>@manual:<누른 시각 ms>`. 같은 회차는 누가(재시작한 서버, 두 번째 타이머, 늦게 깬 타이머) 넣어도 행이 하나다(`insert … on conflict do nothing`). 바로 실행은 회차의 키를 쓰지도 빼앗지도 않는다.
- **상태**: `pending` → `running` → `succeeded`/`failed`, 또는 곧바로 `skipped`. `attempts`는 시작 횟수(죽은 시작 포함), `started_at`(이번 시도 시작)·`retry_at`·`result_saved_at`·`notified_at`·`finished_at`이 모두 남는다(수용 기준 5의 예정·시작·결과 저장 시각). 실패·건너뜀 이유는 고정 코드 `error_code`: `overlap`(앞 실행이 안 끝남), `superseded`(재시작 뒤 더 최근 회차로 대체), `interrupted`(서버가 실행 중에 멈춤), `handler_error`, `run_failed`, `runtime_unavailable`, `not_allowed`, `timeout`(`SCHEDULE_RUN_CODES`).
- 이름·프롬프트는 사용자 글이라 저장할 때 알려진 비밀을 가리고(`scrubKnown`), 나중에 등록된 비밀은 백그라운드 재가림이 다시 가린다(`secrets/columns.ts`). 나머지 칸은 검증된 값이다(시각 `HH:MM`, 날짜, cron은 숫자와 `* , - /`만, 시간대 이름, 카탈로그의 스킬·모델).

### 25.2 일정 계산과 서머타임
- 다음 회차는 `Intl`만으로 계산한다(`apps/server/src/schedules/time.ts`, cron 라이브러리 없음). cron은 5칸(분 시 일 월 요일), `*`·목록·범위·`/단계`, 요일 7 = 일요일. 일·요일은 vixie cron 규칙(`DOM_STAR`/`DOW_STAR`): 두 칸 모두 `*`로 시작하지 않으면 둘 중 하나만 맞아도 되고(`0 0 1-7 * 1` = 1–7일 또는 월요일), 하나라도 `*`로 시작하면(`*/n` 포함) 둘 다 맞아야 한다 — 계산한 값은 그대로 쓴다(`0 0 */2 * *` = 1·3·5…일, `0 0 * * */2` = 일·화·목·토, `0 0 */2 * 1` = 홀수 날인 월요일, `0 0 */1 * 1` = 월요일). 이름(`MON`, `JAN`)과 `@daily` 같은 줄임은 받지 않는다(400 `cron_invalid`). 맞는 날이 8년 안에 없으면 400 `schedule_never`, 지난 한 번 예약은 400 `schedule_in_past`, 없는 날짜(`2027-02-29`, `2027-02-30`, `2027-04-31` — 월별 일수·윤년 확인, 다른 날로 바꾸지 않음)는 400 `invalid_request`(서버 쪽 확인은 `invalid_date`), 모르는 시간대는 400 `invalid_time_zone`.
- 회차는 현지 날짜·시각으로 하나씩 세고 각각을 한 순간으로 바꾼다(#3 결정, FR-8.7):
  - **없는 현지 시각**(봄, America/New_York 3월 둘째 일요일 02:00–02:59): 바로 다음 유효한 순간 = 03:00 EDT에 **1회**. 그 틈에 여러 회차가 있으면(`*/20 2 * * *`) 모두 같은 순간이 되어 실행 키로 하나가 된다.
  - **두 번 있는 현지 시각**(가을, 11월 첫째 일요일 01:00–01:59): **첫 번째**(EDT)에만 1회. 두 번째 01:30(EST)은 회차로 세지 않는다.
- `next_run_at`이 엔진의 영속 상태다: 아직 실행으로 바꾸지 않은 다음 정규 회차. 일시정지하면 비우고, 다시 켜면 그때부터의 다음 회차로 정한다(정지 중의 회차는 따라잡지 않는다 — 원하지 않은 것이니 놓친 것이 아니다).

### 25.3 타이머·놓친 실행·겹침·바로 실행
- 서버 안 타이머 하나(`ScheduleEngine`, launchd 작업 없음). 가장 이른 할 일(다음 회차·재시도)까지 자되 **1분보다 오래 자지 않고** 깨서 DB를 다시 본다 — 긴 타이머의 어긋남, Mac 잠자기, 시계 변경이 있어도 회차는 늦어도 1분 안에 시작된다. 정상 가동 중의 시작 오차는 수 ms다(측정은 25.5절).
- **놓친 실행(FR-8.7)**: 깨어날 때마다(서버 시작 포함) 예약마다 `next_run_at` 이후 지금까지 온 회차 중 **가장 최근 것 하나만** 실행으로 만들고 다음 회차로 넘어간다. 늦게(1분 넘게) 만든 것은 `trigger = missed`. 그 사이의 회차는 행을 만들지 않는다(몰아서 실행하지 않음).
- **겹침**: 같은 예약의 실행이 아직 안 끝났으면(`running`, 또는 시작·재시도를 기다리는 `pending`) 새 회차는 `skipped`·`overlap`으로 기록만 한다.
- **바로 실행**: 자기 실행 키로 곧바로 `pending` → 엔진이 바로 집는다. 안 끝난 실행이 있으면 409 `schedule_busy`(행을 만들지 않음).

### 25.4 재시도와 크래시 복구 — 핸들러 계약
- 실행은 핸들러(`ScheduleHandler`, `schedules/engine.ts`)의 세 단계로 나뉘고, 엔진은 단계가 끝날 때마다 행에 적는다:
  1. `execute` — 시도마다 한 번. 시작(`claim`: `pending`→`running`, `attempts + 1`)이 먼저 디스크에 적힌 뒤 부른다. 결과는 `outcome`에 적는다.
  2. `saveResult` — 결과(실패면 이유)를 사용자에게 남긴다. **실행 id마다 멱등**이어야 한다.
  3. `notify` — 알림 발행(예약의 알림이 꺼져 있으면 부르지 않음). **실행 id마다 멱등**.
- **재시도(FR-8.6)**: 첫 시도가 실패하면 **2분 뒤 한 번**(`retry_at = 실패 시각 + 2분`). 결과 저장과 알림은 마지막 시도의 것만 한다. 두 번 다 실패하면 `failed`, 실패 이유 저장과 실패 알림.
- **크래시 복구**(서버 시작 시 `ScheduleStore.recover`): 
  - `execute` 중에 죽음(`running`, `outcome` 없음) → 그 시작도 시도 1회로 센다. 남은 시도가 있으면 **재시작 2분 뒤** 재시도, 없으면 `failed`·`interrupted`로 정하고 결과 저장·알림을 이어서 한다.
  - 결과 저장 전에 죽음(`outcome` 있음, `result_saved_at` 없음) → 다시 실행하지 않고 `saveResult`부터.
  - 알림 전에 죽음(`result_saved_at` 있음, `notified_at` 없음) → `notify`만.
  - 핸들러가 저장·발행은 했는데 엔진이 적기 전에 죽으면 그 단계가 한 번 더 불린다 — 그래서 두 단계는 멱등이어야 한다(#56의 실제 핸들러는 실행 id로 메시지·알림을 찾아 이미 있으면 그대로 돌려준다).
  - `pending`으로 남은 실행(시작 전에 죽음, 재시도 대기 — 방금 복구한 것 포함)보다 새 회차가 이미 왔으면 옛 것은 `skipped`·`superseded`(가장 최근 회차만 실행). 예: 재시도를 기다리던 중 서버가 이틀 꺼져 있었으면 옛 재시도 대신 오늘 회차 1회.
- 저장·알림 단계가 예외를 던지면 실행은 그대로 두고 2분 뒤(또는 다음 시작 때) 그 단계부터 다시 한다.
- 엔진은 각 단계 **전후마다**(모든 `await` 뒤) 멈춤·잠금 보유를 다시 확인한다. 끈 뒤나 잠금을 잃은 뒤에 돌아온 단계는 아무것도 적지 않고 다음 단계도 부르지 않는다 — 행은 그대로 남아 다음 시작이 이어서 한다(그래서 닫힌 DB를 건드리지 않는다). 잠금을 잃은 것을 알게 되면 엔진도 멈춘다.
- 서버를 끌 때(`preClose`) 엔진은 새 실행을 멈추고 진행 중인 실행에 중지 신호(`signal`)를 보낸 뒤 5초까지 기다린다. 끝나지 않은 것은 다음 시작의 복구가 처리한다(위 규칙).

### 25.5 데이터 잠금·수명·복원
- 엔진은 **데이터 폴더 잠금을 가진 서버에서만** 돈다: `index.ts`가 `openStorageForWrite`로 잡은 잠금을 `buildApp`에 넘기고(`dataLock.held()`), 엔진은 시작할 때와 깰 때마다 확인해 잠금이 없으면 멈춘다(`schedule.engine_stopped`·`storage_not_owned`). 시험·`pnpm db:migrate`·복원 명령은 엔진을 띄우지 않는다. 앱이 준비되면(`onReady`) 시작, 닫힐 때(`preClose`, DB를 닫기 전) 멈춘다.
- 핸들러는 #56의 실제 핸들러(`RuntimeScheduleHandler`, 32절)다 — 운영 서버도 `FAKE_RUNTIME=1`(e2e·개발, FakeRuntime으로 돈다)도 같다. 기록만 하는 `FakeScheduleHandler`는 엔진 단위 시험용으로만 남았다.
- **복원(21.4절)**: 서버를 멈추고 하므로 엔진도 멈춰 있다. 복원한 DB의 `next_run_at`은 백업 시점 그대로라, 복원 뒤 시작하면 예약마다 놓친 회차 중 가장 최근 것 1회가 실행된다(위 규칙). 백업 때 `running`이던 실행은 크래시처럼 복구된다. 0020 이전 백업은 복원 때 이 마이그레이션이 적용된다(빈 표).
- API(최소, 화면은 #55): `GET·POST /api/schedules`(본인 것만), `GET·PATCH(일시정지·알림)·DELETE /api/schedules/:id`, `GET /api/schedules/:id/runs`, `POST /api/schedules/:id/run`(바로 실행). 프롬프트는 주인의 내용이라 **주인만** — 관리자도 403(FR-1.5, 권한 행렬). 만들 때 런타임·모델·추론 강도를 안 주면 만든 사람의 기본값(FR-12.6 대체 순서 포함, 23절), 주면 칩과 같은 검사(403 `runtime_not_allowed` 등). 쓸 수 있는 런타임이 없으면 409 `no_usable_runtime`, 허용 안 된 스킬은 403 `skill_not_allowed`.
- 로그: `schedule.run_started`(예약·실행 id, `scheduleTrigger`, 시도, 늦은 정도 `lateMs`), `schedule.run_finished`(`scheduleCode`, `scheduleStatus` = `succeeded`/`failed`/`retrying`), `schedule.run_skipped`(`overlap`), `schedule.step_failed`(`scheduleStep` = `save`/`notify`), `schedule.recovered`(개수), `schedule.engine_stopped`. 이름·프롬프트·결과는 남지 않는다.

### 25.6 확인 방법
- 자동(가짜 시계, `apps/server/test/schedules.test.ts`): 다섯 유형 일주일, 놓친 회차 3개 → 1회(가장 최근), 5분 전 정지·10분 뒤 시작 → 1회, 실패 → 정확히 2분 뒤 재시도, 두 번 실패, 크래시 시점별(시작 직후·재시도 시작 직후·결과 저장 전·저장 후 기록 전·알림 전·발행 후 기록 전) 복구, 겹침 건너뜀(실행 중·재시도 대기 중), 바로 실행의 별도 키, 실행 키 유일, 일시정지, 잠금 없음 → 실행 안 함, America/New_York 서머타임 시작·종료일(없는 시각·두 번 있는 시각), 시작 오차(모든 실행 0 ≤ 시작 − 예정 ≤ 1분; 실제 시계로 1분 회차 하나 — 1초 미만). 계산만: `schedules-time.test.ts`.
- 7일 실측(정규 회차 ±1분, 휴대폰 수신)은 #56·#57에서 실제 핸들러로 한다(수용 기준 5 절차 1·3).

## 26. 파일 추출·위치 색인 (#48)
PRD FR-4.2·4.3·4.5, 수용 기준 2·11. 방식과 근거는 `docs/decisions/isolation.md` "파일 추출·위치 색인 (#48)". HWP·HWPX는 34절(#23), 파일 뷰어는 #24.

### 26.1 무엇이 일어나나
- 업로드가 저장되면 서버가 그 파일의 글자를 **위치(locator)와 함께** 뽑는다 — 백그라운드에서 한 번에 한 파일, 샌드박스 안의 별도 node 프로세스(그 파일 하나만 읽고, 쓰기·네트워크·자식 프로세스 없음). 결과는 DB `file_extracts`·`file_segments`(0024 마이그레이션). 파일을 지우면(입력창 ✕, 대화 삭제) 함께 지워진다.
- 형식과 위치: PDF는 쪽(+ 줄 상자), 스캔본 PDF·사진은 OCR 단어 상자, DOCX는 문단 번호·표 번호와 행, XLSX는 시트와 칸(`B2`), CSV는 행과 칸, PPTX는 슬라이드, TXT·MD는 줄, HWP·HWPX는 문단 번호·표 번호와 행·각주(34절).
- 한도: 파일당 글자 2백만 자, PDF 500쪽, OCR 30쪽, 그림 4천만 화소, Office 압축 해제 항목당 64MB·합계 256MB, 추출 시간 60초(OCR이 필요할 수 있는 PDF·사진은 300초), 메모리 768MB(같은 경우 1.5GB). 넘으면 잘라서(`truncated`) 또는 실패 코드로 남긴다.
- 거부(파일은 저장되지만 읽지 않는다): zip 폭탄(`extract_too_large`), 경로 탈출(`extract_path_escape`), DTD·외부 엔티티(`extract_xml_forbidden`), 손상(`extract_zip_invalid`·`extract_xml_invalid`·`extract_invalid`), 암호 PDF·HWP·HWPX(`extract_encrypted`), 배포용 HWP(`extract_distribution`), HWP zlib 폭탄·순환하는 섹터 체인(34절). 코드와 화면 문구는 `packages/shared/src/locators.ts`의 `EXTRACT_CODES`·`EXTRACT_CODE_TEXT`.
- 서버를 끄면 실행 중인 추출은 멈추고 그 파일은 `pending`으로 남아 다음 시작에 다시 한다(파일마다 3번까지). 추출기 버전(`EXTRACTOR_VERSION`)이 바뀌면 시작할 때 모든 파일을 다시 뽑는다.

### 26.2 OCR — 설치할 것 없음
- OCR은 **tesseract.js 7.0.0**(WebAssembly)과 고정된 npm 언어 데이터 **`@tesseract.js-data/kor`·`eng` 1.0.0**으로 한다. `pnpm install`이 함께 설치하므로 **Homebrew·시스템 tesseract를 설치하지 않는다**. 실행 중에 아무것도 내려받지 않는다(언어 데이터는 처음 쓸 때 `DATA_DIR/ocr-lang/`에 해시 확인 뒤 복사 — 백업 대상 아님, 지워도 다시 만든다).
- 끄기: `.env`에 `EXTRACT_OCR=off`. 그러면 사진은 `ocr_unavailable`("이 서버에서는 사진 속 글자를 읽을 수 없어요"), 스캔본 PDF는 글자 없이 `ocr: "unavailable"`. 패키지가 빠진 설치(예: `--prod`로 일부만)도 같은 결과다 — 다시 `pnpm install --frozen-lockfile`.
- 정확도: 인쇄된 한글·영문은 잘 읽는다. 손글씨, 많이 기울어진 사진, 아주 작은 글자는 약하다.
- 추출기는 언제나 샌드박스에서 돈다. 예외는 시험 머신의 `ISOLATION_IN_PROCESS_FOR_TESTS=1`뿐이다(샌드박스가 없는 CI에서 추출기를 서버 프로세스 안에서 돌림). 이 스위치는 NODE_ENV=production과 함께면 서버가 시작을 거부한다 — 가족 서버의 `.env`에는 절대 넣지 않는다. FAKE_RUNTIME=1만으로는 샌드박스를 벗어나지 않는다.
- e2e(`pnpm e2e`)는 운영 모드라 추출이 macOS에서만 된다. Linux에서는 `e2e/file-citations.spec.ts`를 이유와 함께 건너뛰고, 같은 시나리오를 `apps/server/test/file-tools.test.ts`가 돌린다.

### 26.3 쓰는 곳
- 파일 도구(두 런타임 공통, 공통 MCP 서버): `file_list`, `file_read(fileId, from, to, sheet)`, `file_search(query)`, `file_cite(fileId, snippet, page)`. 그 실행의 대화에 올린 그 사용자의 파일만 읽는다(남의 파일·다른 대화 파일은 `file_not_found`). 글자는 `<external_content>` 블록 안으로만 런타임에 간다.
- 인용: `file_cite`는 웹 인용과 같은 번호·같은 검사를 쓰고, 답 아래 출처 목록에 "report.pdf · 12쪽"처럼 파일 이름과 위치가 붙는다. 구절이 파일에 없으면 ⚠️.
- API: `GET /api/files/:id/extract?from=&limit=` — 상태와 위치가 붙은 글자(원본과 같은 권한 — 주인, 그리고 #29 공유 투영에 그 파일이 든 공유 대상).
- 실행이 읽는 파일: **활성 메시지에 실어 보낸 파일만**이다. 입력창에만 있는 파일, 수정·다시 생성으로 잘린 메시지의 파일은 도구에 보이지 않는다(원본은 주인이 파일 경로로 계속 볼 수 있다).
- XLSX 시트는 모델에게 `sheet-<n>`("2번째 시트")으로만 보인다. 시트 이름은 파일 글자라 `<external_content>` 안에만 있다. 긴 내용은 `file_read`의 `next.cursor`로 이어 읽는다(한 단위 안에서도, 다음 시트로도).

### 26.4 로그와 확인
- 로그: `file.extracted`(`extractCode`, 소요 시간, 파일·대화·사용자 ID), `file.extract_resumed`(개수), `file.tool_finished`(도구, `fileToolCode`). 파일 이름·글자·검색어는 남기지 않는다.
- 뽑은 글자는 알려진 비밀 값을 가려 저장하고(자르지 않은 전체 글자를 먼저 가린 뒤에만 긴 단위를 20만 자로 잘라 저장), 도구가 읽을 때마다 그때 아는 비밀로 다시 가린다(원본 바이트는 그대로, 24.2절). 새 비밀이 등록되면, 잘라 저장한 단위가 있는 파일은 원본에서 다시 추출하며 그동안은 `pending`이다(아무것도 내주지 않음). 서버가 시작할 때도 그런 파일은 다시 추출한다. 줄 상자·칸 위치는 바뀐 길이를 따라 옮긴다. 비밀이 두 줄·칸에 걸쳐 위치를 지킬 수 없으면 그 단위는 쪽·행 위치만 남고 줄 번호는 주장하지 않는다.
- 시험: `pnpm test apps/server/test/extract.test.ts`(형식별 fixture·기대 locator, zip 폭탄·XXE·billion laughs·zip slip·경로 탈출 거부, 샌드박스에서 남의 파일 못 읽음, OCR — OCR이 없으면 이유를 밝히고 건너뜀), `apps/server/test/file-tools.test.ts`(업로드 → 추출 → API 권한, 도구 범위, "12쪽 요약"을 FakeRuntime·Claude·Codex 재생에서), `E2E_PORT=3114 pnpm e2e e2e/file-citations.spec.ts`. fixture를 다시 만들려면 `python3 -I fixtures/extract/make-fixtures.py`(Pillow·macOS `cupsfilter` 필요, 시험은 커밋된 파일을 쓴다). HWP·HWPX는 `apps/server/test/hwp.test.ts`와 `make-hwp-fixtures.py`(34절).

### 26.5 받아들인 한계 — 비밀 가림
- 스캔 쪽의 원래 글자(8자 미만)와 그 쪽 그림을 OCR한 글자는 **서로 다른 층**으로 저장된다(원래 글자 먼저, OCR 글자는 Tesseract가 읽은 순서 그대로). 한 비밀 값이 두 층에 나뉘어 있으면(일부는 글자, 일부는 그림) 하나의 값으로 알아보지 못한다 — "임의 구분자로 나뉜 값"과 같은 범위 밖. 두 층의 경계에서 잘린 값의 앞부분은 가린다.
- OCR이 줄을 잘못 묶거나 단 순서를 틀리게 읽으면 그 순서대로 저장된다(서버가 다시 정렬하지 않음).

## 27. 맥락 빌더·세션 일치 검사·자동 요약 — 대화 중 런타임 전환 (#45)
대화의 원본은 서버가 가진다(PRD D8). 런타임 세션은 그 원본을 처리하는 작업 단위다. 그래서 런타임·모델·연결을 바꾸거나, 수정·재생성한 뒤에도 런타임은 서버 원본과 같은 맥락으로 답한다.

### 27.1 이어가기(resume) 조건
- 다음 조건을 **모두** 만족하는 세션만 이어간다(`runtime_sessions`). 하나라도 어긋나면 새 세션을 열고 맥락을 다시 만들어 넘긴다.
  - 같은 런타임
  - 같은 연결(세션은 그 연결의 폴더에 산다, §11)
  - 세션이 반영한 위치가 지금 대화와 같다: `conversation_revision`이 현재 revision이고, `last_message_id`가 지금 기록의 마지막 메시지다. 서버가 쓴 구분선(전환·요약)은 런타임이 받는 내용이 아니라서 위치에 들어가지 않는다.
  - 시작할 때의 지침(`instructions_hash`, §14)과 요약(`summary_id`)이 지금과 같다. 새 요약이 생겼다는 것은 맥락이 한도에 닿았다는 뜻이라 새 세션으로 간다.
  - 잘린 맥락으로 시작한 세션이 아니다(`trimmed`, 27.3).
- 수정·재생성은 revision을 올리고 그 대화의 세션을 모두 무효로 한다(전과 같음).
- **같은 런타임 안에서 모델만 바꿈**: 런타임이 세션 안 모델 변경을 지원하면(`canSwitchModelInSession`, Claude·Codex 모두 지원) 그 세션을 이어가 `setModel`로 바꾸고 `runtime_sessions.model`을 갱신한다. 지원하지 않으면 새 세션.

### 27.2 새 세션에 넘기는 것
- 서버 기록의 **공개 파트만**(텍스트). `reasoning`은 어떤 경우에도 넘기지 않는다. 알려진 비밀은 넘기기 직전에 다시 가린다(#78).
- 길면 **요약 + 그 뒤의 메시지**. 요약이 덮는 메시지는 넘기지 않는다.
- 참조 목록(외부 콘텐츠 블록 `conversation-references` 안, 글자로만): 지금 기록에 있는 메시지(와 이번 메시지)에 붙은 업로드 파일(#22 — 수정·재생성으로 잘린 메시지의 파일, 보내지 않은 업로드는 빠진다), 이 대화의 아티팩트(#27, 최신 버전), 답변이 인용한 출처(서버가 확인한 인용 노트, #25). 종류마다 최근 30개. 런타임이 그 파일·아티팩트를 실제로 열 수 있는지는 #53.
- 두 런타임이 같은 형식(`renderPriorContext`, `apps/server/src/runtime/context.ts`)으로 받는다. Claude는 시스템 프롬프트 뒤에, Codex는 developer instructions로.

### 27.3 자동 요약
- 새 세션이 받을 맥락(요약 + 그 뒤 메시지 + **이번 메시지** + 예비분)이 모델 맥락 한도의 일정 비율에 닿으면 요약한다. 보내기·수정은 구분선 자리에서 이번 메시지까지 세어 정하고, 실행 직전에 실제 메시지로 다시 정한다(앞에서 아니라고 했어도 요약할 수 있다 — 그때는 구분선 없이).
  - 토큰은 넉넉하게 어림한다: UTF-8 바이트 ÷ 3(한글 한 글자 1토큰), 메시지마다 8토큰, 예비분 8000토큰(지침·참조·이번 입력).
  - 맥락 한도: Claude 모델 200,000, Codex 모델 258,400(보수적 기본값, `CLAUDE_MODELS`·`CODEX_MODELS`의 `contextWindow`). 실제 값이 확인되면 여기서 고친다.
- 설정(`.env`, 서버 재시작 후 반영):
  - `CONTEXT_SUMMARY_RATIO`: 비율, 0.3~0.95, 기본 0.7
  - `CONTEXT_RECENT_MESSAGES`: 요약하지 않고 그대로 두는 최근 메시지 수(텍스트가 있는 것), 2~50, 기본 6
- 요약은 그 run의 연결에서 런타임의 **싼 모델**(Claude Haiku 5.5, Codex GPT-6 Luna — `cheap`)로 쓴다. 사용자가 그 모델을 쓸 수 없으면(권한, §20.2) run의 모델로 쓴다. 도구 없이, 요약 지침(`summary@1`)으로 세션 하나를 열었다 닫는다.
- 사용량은 같은 run의 별도 attempt로 `purpose = summary`, 요약 모델 이름으로 기록된다(§16). 이어서 답변이 다음 attempt(`chat`)다.
- 저장: `conversation_summaries`(덮는 마지막 메시지와 그 seq, 덮는 메시지 id들의 해시, 요약 글, 쓴 런타임·모델·run). 요약 글은 모델 출력이라 저장·읽기 때 알려진 비밀을 가리고, 나중에 등록된 비밀도 백그라운드 재검사가 지운다.
- 재사용: 덮는 메시지가 그대로인 가장 새 요약을 계속 쓴다. 다시 한도에 닿으면 앞 요약 + 그 뒤 메시지로 새 요약을 쓴다. 덮는 범위 안의 메시지를 수정·재생성하면 그 요약은 쓰지 않는다.
- 화면: 새 요약을 쓴 답 앞에 "앞부분을 요약했어요" 구분선. 요약이 있는 대화를 다른 런타임으로 바꾸면 전환 구분선 끝에 "· 앞부분은 요약해서 넘겼어요".
- 요약이 실패해도 답은 막지 않는다: 구분선을 거두고, 비율 아래로 들어가는 최근 메시지만 **새 세션**에 넘긴다(같은 런타임이어도 전체 기록을 가진 세션은 무효로 하고 이어가지 않는다). 다음 메시지에서 다시 요약을 시도한다.
- 넘기기 직전 마지막 검사(이번 메시지는 **절대 자르지 않는다**):
  - 요약 + 그 뒤 메시지 + 이번 메시지가 맥락 한도를 넘으면 앞쪽 메시지를 빼고 비율 아래로 들어가는 최근 메시지만 새 세션에 넘긴다.
  - 그래도 요약 + 이번 메시지가 한도를 넘으면 요약 없이, 들어가는 최근 메시지만 넘긴다.
  - 이번 메시지 하나(와 예비분)만으로 한도를 넘으면 아무것도 보내지 않고 run이 `context_too_large`로 실패한다. 화면: "메시지가 너무 길어서 이 모델에 보낼 수 없어요. 나눠서 보내 주세요."
- 잘린 맥락으로 연 세션은 `runtime_sessions.trimmed`로 표시되고 **다시 이어가지 않는다**. 비율 설정을 바꾸고 재시작하거나 더 큰 한도의 모델로 바꿔도, 전체 기록을 갖지 않은 세션이 전체 기록인 척 이어지지 않는다.
- 요약 구분선은 run에 기록된다(`runs.summary_divider_id`). 요약을 저장하지 못하고 끝난 run(실패, 시작 전 중지, 재시작 뒤 복구)은 끝날 때 그 구분선을 기록에서 뺀다.

### 27.4 로그와 확인
- 로그: `context.summarized`(사용자·대화·run ID, 런타임, attempt, 접은 메시지 수, 토큰, 소요 시간), `context.summary_failed`(`errorCode = summary_failed`). 요약 글과 메시지 내용은 남기지 않는다.
- 시험: `pnpm test apps/server/test/context.test.ts`(FakeRuntime — 조건 각각, 모델만 변경, 참조, 요약 임계·재사용·구분선·실패·모델 권한·비밀), `apps/server/test/context-replay.test.ts`(Claude·Codex 녹화 재생 — 왕복, 수정 후 재전송, 재생성, 연결 변경, 모델만 변경, 요약 이후 재개). 각 run에서 런타임이 받은 맥락이 저장된 행으로만 계산한 서버 원본과 같은지 본다.
- 실런타임 확인(수용 기준 8)과 전환 후 첫 토큰 측정은 `docs/evidence/context/checklist.md`.

## 28. 예약 화면과 대화에서 예약 만들기 (#55)
PRD FR-8.1·8.2·8.5, FR-12.2. 엔진은 25절, 실제 실행(전용 대화에 결과·알림)은 32절(#56)이다.

### 28.1 예약 화면 (`/schedules`)
- 사이드바 “⏰ 예약”. 내 예약만 보인다(관리자도 남의 것은 403 — 프롬프트는 주인의 내용). 각 예약: 이름, 일정(`매일 08:00`, `평일(월–금)`, `매주 월·수`, `한 번 · 날짜`, `cron …`)과 시간대, 다음 실행(예약의 시간대로), 런타임·모델, 스킬, 켜짐/일시정지·알림 끔 표시.
- 동작: **일시정지/다시 켜기**(정지 중의 회차는 따라잡지 않는다, 25.2절), **바로 실행**(안 끝난 실행이 있으면 “앞 실행이 아직 끝나지 않았어요”, 409 `schedule_busy`), **수정**(`/schedules/<id>?edit=1`), **삭제**(한 번 더 묻는다), **실행 이력**(`/schedules/<id>`: 예정 시각·종류(정시·놓친 실행·바로 실행)·결과(대기·실행 중·성공·실패·건너뜀 + 이유)·시도 횟수·비용). 실행 중이면 2초마다 다시 읽는다.
- **비용**: 그 실행 id(또는 핸들러의 `output_ref` — #56이 여는 대화 런의 id)로 기록된 사용량 중 가격이 매겨진 것(`usage_records.priced_cost_micros`, API 키 연결만, 23·#32)의 합을 USD로. 구독 연결·사용량 없음·가격 없음은 “—”. #56의 핸들러는 사용량을 그 실행 id나 `output_ref`로 기록해야 비용이 보인다.

### 28.2 만들기·수정 폼
- 칸: 이름, 실행할 프롬프트, 일정 유형(한 번/매일/평일/매주/cron 식)과 유형별 입력(날짜·시각·요일·cron 다섯 칸), 시간대(기본 Asia/Seoul), 스킬(내가 쓸 수 있는 것만 — `GET /api/schedules/options`, 만들기와 같은 검사), 알림(기본 켬), 런타임·모델.
- **다음 실행 미리보기**: 입력이 0.25초 멈추면 서버가 계산한 다음 세 번(`POST /api/schedules/preview` `{timing, timeZone}` → `{next}`, 저장 안 함). 화면은 cron을 계산하지 않는다. 안 되는 일정은 만들기와 같은 400 코드를 그 자리에 보인다(`cron_invalid`, `schedule_in_past`, `schedule_never`, `invalid_time_zone`).
- **런타임·모델(FR-8.2, FR-12.2)**: 새 예약은 만든 사람의 기본값(23절 대체 순서 포함)으로 시작하고 “내 기본값”이라고 표시한다. 바꾸려면 칩(23.2절과 같은 것)을 쓴다 — 목록은 허용되고 지금 쓸 수 있는 런타임·모델·추론 강도뿐이고, 바꿀 때마다 서버가 결과를 미리 계산한다(`POST /api/settings/preview`, `ChipChoice`). **저장은 항상 칩의 선택이 정해진 뒤에 나간다**(`saveSchedule`, review #108): 미리보기가 아직 오는 중이면 기다리고, 실패했으면 그 오류를 보이고 아무 요청도 보내지 않는다(칩이 보이는 것과 다른 기본값으로 저장되는 일이 없다). 칩을 안 건드리면 런타임·모델을 보내지 않고 서버가 기본값을 넣는다. 서버는 보낸 값을 칩과 같은 규칙으로 다시 검사한다: 허용 안 된 모델은 만들기·수정 모두 **403 `model_not_allowed`**(런타임·추론 강도도 같은 코드 규칙)이고 아무것도 바뀌지 않는다(같이 보낸 이름도).
- 스킬 목록 = 지금 쓸 수 있는 스킬 ∪ 이 예약에 이미 있는 스킬. 권한이 빠진 스킬은 “사용할 수 없어요”로 체크된 채 보이고, 체크를 풀어 뺄 수 있으며 뺀 뒤에는 다시 고를 수 없다(남겨 두고 스킬을 바꾸면 403 `skill_not_allowed`).
- 수정(`PATCH /api/schedules/:id`): 바뀐 칸만 보낸다. 일정이나 시간대가 바뀌면 다음 실행을 지금부터 다시 정한다(일시정지 중이면 비워 둔 채 일정만 검사). 이름·프롬프트는 만들 때처럼 알려진 비밀을 가려 저장한다.

### 28.3 대화에서 만들기 — `schedule_create`와 확인 카드
- 우리 MCP 서버의 도구 `schedule_create`(두 런타임 모두의 허용 목록에 들어간다, 43·#27과 같은 방식). 입력: 이름, 프롬프트, 일정, 시간대(기본 서울), 스킬, 알림. **런타임·모델은 입력이 아니다**(만든 사람의 기본값).
- 도구는 **제안만** 한다: 만들기와 같은 검사(엄격한 입력, 카탈로그에 있고 그 사람이 쓸 수 있는 스킬, 다음 회차가 있는 일정, 토큰의 대화가 그 사람 것)를 통과하면 `schedule_proposals`(0022)에 `proposed`로 저장하고 `{proposalId, nextRunAt, note}`를 답한다(“아직 안 만들었다 — 카드를 확인하라고 말하라”). 거절 코드: `schedule_bad_input`, `schedule_not_allowed`, `skill_not_allowed`, `cron_invalid`, `schedule_in_past`, `schedule_never`, `invalid_time_zone`, `invalid_date`. 로그 `schedule.proposed`(도구·상태·시간, 실패면 `scheduleCode`). 이름·프롬프트는 저장할 때 가리고 재가림 대상이다.
- 답 아래 **확인 카드**(그 도구 줄 바로 아래): 이름·일정·다음 실행·런타임·모델(“내 기본값”)·할 일·스킬·알림과 **예약 만들기**·**취소**. 카드 내용은 서버에 저장된 제안(`GET /api/schedule-proposals/:id`)이다 — 런타임이 보여 준 글이 아니다.
- 카드(`GET`)에는 `version` — 제안 내용과 그때 정해지는 런타임·모델·추론 강도의 해시 — 이 있다. 확인은 그 `version`을 보내고(`{version}`, 없으면 400), 서버가 지금 다시 계산한 것과 다르면(그사이 기본값을 바꿨거나 관리자가 허용 범위를 좁혀 대체가 달라짐) **409 `proposal_changed` + 지금의 카드**를 돌려주고 아무것도 만들지 않는다. 화면은 카드를 새 내용으로 바꾸고 “바뀌어 새로 고쳤어요 — 확인하고 다시 눌러 주세요”를 보인다. 같으면 카드에 보인 설정 그대로 만든다(review #108).
- **예약 만들기** = 주인 본인 세션의 요청(`POST /api/schedule-proposals/:id/confirm`)이 `POST /api/schedules`와 같은 검사(스킬, 그때의 기본값 — 쓸 수 있는 런타임이 없으면 409 `no_usable_runtime`, 제안은 그대로)로 예약을 만든다. 한 트랜잭션에서 `proposed`→`confirmed`와 예약 id를 적으므로 두 번(탭 두 개·새로 고침) 눌러도 예약은 하나다(두 번째는 200, 같은 예약). **취소** = `dismissed`(그 뒤 확인은 409 `proposal_dismissed`, 만든 뒤 취소는 409 `proposal_confirmed`).
- 권한: 제안은 주인만 보고 확인·취소한다(관리자·공유받은 사람·남 = 403, 권한 행렬). 공유된 대화에서 남이 보면 카드는 “불러오지 못했어요”만 보인다.
- `FAKE_RUNTIME=1`의 FakeRuntime은 “매일/평일 (아침·저녁…) N시 (M분) … 브리핑·예약·알려·정리”를 이 도구의 실제 호출로 바꾼다(e2e “매일 아침 8시 관심 종목 브리핑”).

### 28.4 확인 방법
- 자동: `apps/server/test/schedule-ui.test.ts`(기본값, 허용 안 된 모델 만들기·수정 403, 수정 모든 칸·일정 검사·가림, 미리보기, 옵션, 비용, 도구 → 카드 → 주인 확인만 생성·한 번만, 취소, 확인 때의 기본값, 도구 거절), `apps/server/test/helpers/permission-matrix.ts`(제안 경로 주인만), `apps/web/test/schedules.test.ts`, `e2e/schedules.spec.ts`(대화 → 카드 → 만들기 → 예약 화면, 폼 미리보기·일시정지·바로 실행 이력·수정·삭제, 403).
- review #108: `apps/web/test/schedule-form.test.ts`(미리보기 지연·실패 때 요청 없음, 스킬 행), `schedule-ui.test.ts`(기본값·정책 변경 → 409 `proposal_changed`, 권한 빠진 스킬 빼고 저장), e2e 3개(느린 미리보기, 바뀐 카드, 빠진 스킬).
- 변이 시험(PR 본문): 제안 주인 검사 제거 → 권한 시험 실패, 허용 안 된 모델 검사 우회 → 403 시험 실패, 도구가 바로 예약을 만들게 → “확인 전 생성 없음” 시험 실패.

## 29. 문서 생성 — DOCX·XLSX·PPTX·PDF (#49)
PRD FR-4.4(HWP 대신 DOCX·PDF)·FR-4.7(에이전트가 만든 파일 내려받기)·FR-5.6(보고서의 참고문헌 블록). 방식과 근거는 `docs/decisions/isolation.md` "문서 생성 (#49)".

### 29.1 무엇을 하나
- 공통 MCP 도구 `doc_create {kind, title, subtitle?, author?, fileName?, blocks}` — 두 런타임 모두 같은 도구(`mcp__agentlee__doc_create`). 런타임 내장 셸·파일 쓰기는 막혀 있으므로(#42) 보고서·표·발표 자료는 이 도구로만 만든다.
- `kind`: `docx`(Word 보고서), `xlsx`(첫 시트 "문서"에 제목·글, 표마다 자기 시트 — 머리 행 굵게·고정·필터, 숫자는 숫자 칸, `=`로 시작하는 글도 **글자 칸**(수식이 되지 않음)), `pptx`(16:9, 제목 슬라이드 → 제목(heading)마다 슬라이드, 길면 "(계속)" 슬라이드, 표·그림은 자기 슬라이드, 표가 길면 머리 행을 반복하며 다음 슬라이드로), `pdf`(A4, 쪽 번호 "— n —", 한글 글꼴 내장).
- `hwp`·`hwpx`는 만들지 않는다(FR-4.4): 도구가 `doc_hwp_unsupported`와 안내 문구(`DOC_HWP_HINT` — "DOCX(한글에서도 열려요)나 PDF로")를 돌려준다.
- 블록: `heading`(1~3단계), `paragraph`, `list`(번호 여부), `table`(머리·행 — 칸은 글·숫자·빈칸, 행 길이 = 머리 길이), `image`(**이 대화의 PNG·JPG 파일 id만** — URL은 받지 않고 아무것도 가져오지 않는다), `references`(참고문헌, `[n]` 번호).
- 결과: 대화의 파일(#22)로 저장되고 `{fileId, name, kind, mediaType, bytes, url, document, checks}`를 돌려준다. `document`는 그대로 `artifact_create kind=document`에 넘길 수 있다(#27 — 아티팩트 패널에 그 파일의 내려받기가 보인다, 미리보기는 #24). 답 아래에는 서버가 그 run이 만든 파일마다 내려받기 칩(`file_ref`)을 붙인다(런타임의 보고가 아니라 저장된 행 기준).
- 내려받기: #22의 원본 경로 `GET /api/files/:id/content` 그대로 — 만든 사람만, 항상 `attachment`, nosniff, 샌드박스 CSP(§24.3). 파일 이름은 제목(또는 `fileName`)에 형식의 확장자를 붙인 것(경로 문자·제어 문자 제거, 120자).

### 29.2 생성 파일과 대화·맥락의 연결 (결정)
- 생성 파일의 `files` 행은 **그 run의 답변 메시지**(`runs.assistant_message_id`)에 `message_id`로 연결되고 `upload_id`는 비어 있다(업로드와 구별). 그래서:
  - 입력창 파일이 아니다: 다른 메시지에 첨부할 수 없고(400 `invalid_attachment`), ✕로 지울 수 없다(409 `file_attached`). 대화를 지우면 함께 지워진다.
  - 맥락(#45): 새 세션의 참조 목록은 "지금 기록에 있는 메시지에 붙은 파일"이므로, 그 답이 기록에 있는 동안 다음 턴(런타임 전환 포함)이 `file:<id>`로 그 파일을 안다. 그 답을 다시 생성하거나 앞 메시지를 고쳐 답이 기록에서 빠지면 그 파일도 참조에서 빠진다(파일과 내려받기는 남는다).
  - 마이그레이션은 필요 없었다(기존 열로 충분 — 새 DB 글자 열 없음). `files.name`은 이미 분류된 열이고 쓰는 곳에 `addGenerated`를 더했다(`secrets/columns.ts`).
- 대화당 파일 20개 한도(§24.1)에 업로드와 함께 센다 — 행을 넣는 같은 한 문장의 조건으로(`doc_too_many_files`). 사용자별 용량 한도는 아직 없다(업로드에도 없음).

### 29.3 한도 (`DOC_LIMITS`, `packages/shared/src/docgen.ts`)
- 요청(MCP 요청 자체 1MB 안): 블록 300, 글 한 덩이 1만 자, 문서 전체 글 30만 자, 목록 항목 200, 표 30개·열 30·행 1,000·칸 1,000자·모든 표의 칸 합 2만, 그림 10장(한 장 10MB, 합 25MB, 그림 크기 4천만 화소·한 변 2만 화소 — 작은 파일이 큰 그림일 수 있어 머리만 읽어 거절), 참고문헌 200.
- 결과 파일 25MB(업로드 한도 50MB 아래). 넘으면 `doc_output_too_large`, 저장하지 않는다.
- **하드 보장은 샌드박스의 한도다:** 작업자는 60초·메모리 768MB 안에서만 돈다. 넘는 입력은 깨끗이 실패한다 — 메모리는 `doc_limit`, 시간은 `doc_timeout`(파일은 저장되지 않음). 아래 상한은 그 실패를 **드물게** 만드는 것일 뿐 보장이 아니다(입력 모양에 따라 측정과 다를 수 있다). 시간 상한은 따로 두지 않는다 — 칸이 아주 많은 PDF 표(30열 × 665행의 짧은 칸)는 바쁜 기계에서 60초를 넘어 `doc_timeout`이 되며, 이것은 받아들인 한계다.
- **분량 상한(리뷰 #110 2·3·4차)** — 작업자의 최대 메모리(RSS, `/usr/bin/time -l`, node 22, 이 Mac)를 재서 형식마다 정했다. 넘으면 만들기 전(PPTX는 배치 중, 파일을 쓰기 전)에 `doc_too_large`. 그림은 **놓인 횟수마다** 센다(같은 그림을 두 번 놓으면 두 번 넣거나 두 번 푼다).
  - **PPTX**: 500장, 분량 40,000(문단·줄 1, 표 칸 3, 슬라이드 25, 그림 1KB마다 1). 상한 바로 아래 최악: 그림 25MB + 표 567MB, 표만 487MB, 글 460장 약 200MB.
  - **DOCX**: 분량 120,000(줄 1 — 표 칸 안의 줄도 — 칸 3, 그림 1KB마다 0.1). 최악: 줄 115,000개 442MB, 줄바꿈 칸 표 447MB, 그림 10번 + 표 541MB. (상한 전: 30문단 × 9,999줄 896MB — Codex 측정 1,007MB.)
  - **XLSX**: 분량 34,000(그림 1KB마다 1, 칸 0.25, 줄 0.02). 최악: 9MB 그림 3번 + 30열 × 666행 표 483MB. (상한 전: 9MB 그림 10번 1,066MB.)
  - **PDF**: 1,000쪽, 푸는 그림(투명도·tRNS·16비트·인터레이스 PNG)의 화소 합 2,000만(놓인 횟수마다), 분량 450(단위 ≈ 1MB). 그림은 형식을 가른다(리뷰 #110 5차): **JPEG**는 압축된 바이트 그대로 넣으므로(풀지 않음) 놓일 때마다 **MB당 16**(실측 MB당 약 10–15MB — 5.53MB 사진 1장 163MB, 3장 268MB, 6번 423MB, 10번 651MB); **PNG**는 크기보다 빨리 커지므로 MB당 20 + MB² × 2(9MB RGB PNG 하나 431MB, 2.4MB짜리는 장당 약 50MB). 줄 0.0005, 칸 0.007. 상한 바로 아래 최악: JPEG 5.53MB 4장 + 1번 더(27.6MB) 450MB, 10MB JPEG 2장 + 5.5MB 434MB, PNG 9MB + 2.4MB 469MB, PNG 섞어 10장 449MB, 표·긴 글 약 220MB. 5.5MB 사진 3장 보고서는 만들어진다(268MB). 쪽은 버퍼하지 않고 다음 쪽이 시작되면 내보낸다(전에는 180쪽 표 847MB, 지금 216MB). 쪽 번호는 각 쪽이 시작될 때 "— n —".
- 생성 작업자: 60초, 메모리 768MB, 출력(base64) 약 33.4MB. 동시 실행은 스킬과 같은 슬롯(전체 4, run당 2 — 넘으면 `doc_busy`).

### 29.4 검사와 비밀
- **알려진 비밀(1절, 라운드 23–27):** 요청의 모든 글자(제목·부제·작성자·블록·칸·참고문헌)와 파일 이름에서 **만들기 전에** 가린다(`[숨김]`). 비밀과 같은 숫자 칸도 `[숨김]` 글자가 된다. 그 시점에 서버가 아는 비밀만 가린다 — 파일이 만들어진 뒤 등록된 비밀은 이미 만든 파일 바이트에서 지우지 않는다(업로드 파일과 같은 원칙, §24.2. 이름 열은 재가림 대상). 블록 경계를 넘어 이어 붙은 비밀(두 칸에 나눠 쓴 값)은 잡지 못한다(아티팩트와 같은 한계).
- **XML에 넣을 수 없는 글자:** 모든 글자 칸은 XML 1.0 문자만 받는다 — 탭·줄바꿈·CR 밖의 C0 제어 문자, DEL, 짝 없는 서로게이트, U+FFFE·U+FFFF는 입력에서 거절(`doc_bad_input`, 바꾸지 않음).
- **배치에서 잃는 글자 없음(리뷰 #110 1·4차):** PDF 표는 서버가 직접 그린다 — 열 너비를 같게 하고 열이 많으면 글자를 줄이며, 칸의 글을 내장 글꼴의 실제 폭으로 줄 단위로 나눈 뒤(자소 묶음 사이에서만, 열보다 0.5pt 좁게) **그 줄을 한 줄씩 줄바꿈 없이** 그린다(pdfkit이 다시 줄을 나누지 않는다). 한 행에 담기지 않는 칸은 줄 경계에서 잘라 이어지는 행(머리 행도)으로, 남은 쪽에 안 들어가는 행은 다음 쪽으로. 자소 묶음 하나가 열보다 넓으면 `doc_too_large`. PPTX는 정한 글자 범위 안에서 넘치지 않게 배치한다(리뷰 #110 2·3·4차 — 4차가 마지막 배치 규칙, 남은 부정확은 받아들인 한계). 글자는 **자소 묶음(grapheme)** 단위로 자른다("é"=e+결합 부호, ZWJ 가족 이모지, 국기, 한글 자모 조합은 절대 나뉘지 않음 — PDF 표의 줄·조각도 같다). 폭(`apps/server/docgen/widths.mjs`, 표 하나):
  - **코드 포인트 하나**: 1em — 한글 음절·자모, 한자, 가나, 라틴(기본·확장), 그리스·키릴 문자, 숫자, 흔한 문장 부호·기호(범위로 적힘). 단 내장 글꼴 Gothic A1(보통·굵게)이 1em보다 넓게 그리는 글자(… ㈜ ㎏ % → ① ■ 등 94개 범위, fontkit으로 잼)는 2em. 그 밖은 2em, 탭 4em.
  - **자소 묶음**: 코드 포인트 폭의 합. 다만 결합 부호(Mn·Me)는 0.5em씩, NFC로 음절 하나가 되는 한글 자모 조합은 1em, ZWJ·U+FE0F 이모지 묶음은 2em, 혼자 있는 폭 없는 문자(ZWSP·ZWNJ·ZWJ·U+FEFF)는 0. 예: `Ỏ`(O+U+0309) 1.5em(실측 1.103), `ᄀ가` 2em(실측 1.961), 국기 4em.
  - **거절(`doc_unsupported_text`, PPTX만)**: ‰ ‱(U+2030–2031), ⸺ ⸻(U+2E3A–2E3B), 아랍어 표현형 A·B(U+FB50–FDFF — ﷽ U+FDFD 포함, U+FE70–FEFE), 2em보다 넓게 그려지는 단위 기호(㎒ ㎫ ㎮ ㎯ ㏆). U+FEFF(BOM·폭 없는 공백)는 거절하지 않는다 — 붙여 넣은 한국어 글의 BOM도 그대로 받는다. 도구는 고정 안내(`DOC_UNSUPPORTED_TEXT_HINT`)를 함께 준다. DOCX·XLSX·PDF는 거절하지 않는다(Word·Excel은 다시 흘리고, PDF는 내장 글꼴의 실제 폭으로 배치).
  - 파일에 줄 간격(글자 크기 × 1.25, `a:lnSpc`)·상자 여백·표 열 너비·칸 여백을 명시한다. 문단·목록 항목은 본문 상자 높이 안에서 줄 경계로 잘라 "(계속)" 슬라이드로 잇는다(영문·이모지가 슬라이드를 더 쓰는 것은 받아들인다). 표는 pptxgenjs의 자동 나누기를 쓰지 않고 직접 나눈다: 열 너비가 같고, 한 열에 두 글자가 들어가는 가장 큰 크기(12→8pt, 8pt 밑으로는 줄이지 않음 — 그래도 안 되면 `doc_too_large`), 칸은 그 열 너비로 줄을 나눠 남은 높이만큼 담고 나머지는 이어지는 행·다음 슬라이드로, 머리 행은 슬라이드마다 반복하며 높이도 센다(머리 행이 본문 높이의 절반을 넘으면 `doc_too_large`). 시험은 생성기와 따로 만든 검사기(`apps/server/test/helpers/pptx-fit.ts` — 같은 폭 규칙을 유니코드 속성으로 따로 구현)로 슬라이드 XML을 다시 읽어 모든 상자·표가 들어가는지, 열마다 글자가 순서대로 다 있는지, 나눈 자리가 자소 묶음 경계인지 본다. 1em으로 세는 모든 코드 포인트를 내장 글꼴(보통·굵게)로 재어 1em 이하인지, 글꼴이 2em보다 넓게 그리는 글자가 모두 거절 목록에 있는지도 본다. 번호 목록은 번호를 글자로 써서 이어진 슬라이드에서도 번호가 이어진다. 내용 없는 제목·마지막 제목도 자기 슬라이드를 갖고, 제목 상자에 안 들어가는 긴 제목은 본문 첫 줄로 간다.
- **다시 열기:** (1) 작업자가 만든 파일을 다시 연다 — Office는 ZIP의 **모든 XML 부분(.xml·.rels)을 XML 1.0으로 파싱**(saxes — 잘못된 글자·깨진 구조는 거절)하고 본문 부분(`word/document.xml`·`xl/workbook.xml`·`ppt/presentation.xml`·첫 슬라이드)이 있고 제목 글이 있는지, DOCX는 표 개수, XLSX는 시트 개수(1 + 표 수)가 맞는지. PDF는 `%PDF-` 머리·`%%EOF`·쪽 1개 이상. (2) 서버가 업로드와 같은 형식 판별(`contentMatches`)을 한다. 둘 중 하나라도 실패하면 `doc_invalid`, 저장하지 않는다.
- **오류 코드**(모델에게 `{ error }`, 로그 `docCode`): `doc_bad_input`, `doc_too_large`, `doc_hwp_unsupported`, `doc_image_not_found`(없음·남의 것·다른 대화·보내지 않음·기록에서 빠진 메시지·해시 불일치 — 모두 같은 답), `doc_image_unsupported`(PNG·JPG 아님), `doc_image_too_large`, `doc_output_too_large`, `doc_too_many_files`, `doc_invalid`, `doc_failed`, `doc_timeout`, `doc_limit`, `doc_busy`, `doc_unavailable`(샌드박스 없음 — macOS가 아닌 곳), `doc_not_allowed`.

### 29.5 의존성 (정확한 버전 고정, 2026-11-12 기준 2주 넘게 지난 배포)
| 패키지 | 버전 | 배포일 | 라이선스 | 쓰임 |
|---|---|---|---|---|
| `docx` | 9.15.0 | 2026-10-27 | MIT | DOCX |
| `exceljs` | 4.4.0 | 2023-10-19 | MIT | XLSX |
| `pptxgenjs` | 4.0.1 | 2025-06-26 | MIT | PPTX |
| `pdfkit` | 0.20.2 | 2026-08-30 | MIT | PDF |
| `@expo-google-fonts/gothic-a1` | 0.4.1 | 2025-09-12 | MIT(패키지) + **SIL OFL 1.1**(글꼴, `LICENSE_FONT`, © HanYang I&C) | PDF 한글 글꼴(Gothic A1 Regular·Bold, 쓰인 글자만 내장) |
| `jszip` | 3.10.2 | 2026-09-08 | MIT 또는 GPL-3.0 (MIT 선택) | 작업자의 다시 열기(ZIP), 시험 — 작업자가 쓰므로 `dependencies`(리뷰 #110 1차) |
| `saxes` | 5.0.1 (exceljs의 기존 하위 의존성) | 2020-04-10 | ISC | 작업자의 다시 열기: 모든 XML 부분을 XML 1.0으로 파싱 |
| `pdfjs-dist` (devDependency) | 6.4.299 | 2026-10-03 | Apache-2.0 | 시험에서만 PDF 글자 추출(#48과 같은 고정) |
- 하위 의존성 중 2주가 안 된 배포는 `pnpm.overrides`로 고정했다: `@types/node` 22.20.5(`docx`가 26.x를 끌어와 vite 피어가 바뀌던 것), `brace-expansion@1` 1.1.21, `brace-expansion@2` 2.1.7, `@swc/helpers` 0.5.23, `tslib` 2.8.1. `@napi-rs/canvas`(pdfjs-dist의 선택 의존성, 네이티브)는 `ignoredOptionalDependencies`.
- NanumGothic(`@expo-google-fonts/nanum-gothic`)을 먼저 썼으나 fontkit 2.0.4가 그 글꼴의 공백 글리프를 읽다 실패해(빈 글리프 처리) Gothic A1으로 바꿨다.

### 29.6 로그와 확인
- 로그: `doc.finished`(도구 이름, 요청 형식 `docKind`, 결과 `docCode` = `doc_ok` 또는 위 코드, 소요 시간, 사용자·대화·run ID). **제목·블록·파일 이름·내용은 남기지 않는다**(시험).
- 시험: `pnpm test apps/server/test/docgen.test.ts` — 네 형식 fixture(생성 → 각자의 판독기로 열기 → 제목·표·문단·그림 일치: DOCX/PPTX는 ZIP의 글 요소, XLSX는 exceljs로 읽기, PDF는 pdf.js 글자 추출), 긴 내용(여러 쪽·계속 슬라이드), 그림 머리 검사, 작업자 다시 열기, macOS 샌드박스 실행(네 형식), 실행 경로(FakeRuntime `/doc <kind>` — 파일·칩·아티팩트·내려받기·주인만·맥락 참조), HWP 안내, 로그, 한도·그림 소유·비밀·결과 검사·범위·20개 한도, **두 런타임 녹화 재생**(Claude·Codex가 우리 MCP 서버로 `doc_create`·`artifact_create`를 실제 호출 → 네 형식 내려받아 열림).
- e2e: `E2E_PORT=3117 pnpm e2e e2e/docgen.spec.ts` — "이 내용을 DOCX 보고서로"(`/doc docx`) → 답의 칩으로 브라우저 내려받기 → 파일을 열어 제목·문단·표 확인, 같은 답의 문서 아티팩트 패널에 같은 파일 내려받기. PDF 한글 글자, HWP 안내. 데스크톱·모바일.
- **샌드박스 밖 실행은 시험 전용 스위치로만:** `ISOLATION_IN_PROCESS_FOR_TESTS=1`(개발·시험 전용)일 때만 생성 작업자를 서버 프로세스 안에서 돌린다(`docRunnerKind` — macOS 샌드박스가 없는 기계에서 개발·단위 시험용). **`NODE_ENV=production`이면 `loadConfig`가 이 값을 거부해 서버가 뜨지 않고**, 실행 시점에도 production이면 무조건 샌드박스다. `FAKE_RUNTIME=1`만으로는 바뀌지 않는다(리뷰 #110 1차: 예전에는 FAKE_RUNTIME이면 프로세스 안 실행이었고 production+FAKE_RUNTIME 설정이 받아들여져 60초·768MB 한도가 사라졌다). 같은 스위치를 파일 추출(#48)도 쓴다. 단위 시험은 실행기를 직접 넣는다(`buildApp({ docs: { runner } })`).
- e2e(Playwright)는 production 빌드라 macOS에서는 실제 샌드박스로 만들고, 샌드박스가 없는 Linux CI에서는 `e2e/docgen.spec.ts`를 건너뛴다(그 시나리오는 단위 시험이 모든 플랫폼에서 FakeRuntime·두 런타임 재생으로 덮는다).
- 실런타임 확인: 실제 Claude·Codex 연결에서 "이 내용을 DOCX 보고서로"를 보내 칩으로 내려받아 Word·한글·미리보기에서 열리는지 본다(자동 시험은 녹화 재생).

## 30. 금융 표·차트 아티팩트·관심 종목 (#31)
PRD FR-7.3·7.5·7.6·7.7, 수용 기준 4·11, M4 완료 기준. 금융 도구 자체는 19절, 아티팩트 서빙·패널은 18절. 방식과 근거는 `docs/decisions/isolation.md` "금융 표·차트 (#31)".

### 30.1 `finance_chart` — 같은 데이터로 표와 차트
- 우리 MCP 서버의 도구 `finance_chart`(두 런타임 모두). 입력: `symbols`(한·미 섞어 1–5개, `005930`·`AAPL`), `chart`(`compare` 수익률 % — 여러 종목 기본, `line` 가격 — 한 종목 기본, `candle` 한 종목 OHLC, `financials` 미국 재무 막대), `range`(`1mo`·`3mo`·`6mo`·`1y`, 기본 6개월), `currency`(한·미를 섞을 때 먼저 보일 기준, 기본 원화), `metric`·`period`(재무), `title`.
- 하는 일: 금융 도구(`kr_history`·`us_history`·`fx_usdkrw`·`us_financials`)로 데이터를 읽고(도구마다 19절의 송신 프록시·권한 검사 그대로), **한 번 계산**해서 같은 숫자를 표 행과 차트 계열에 넣고, 그 대화에 `table` 아티팩트(HTML 표, CSV 내려받기)와 `chart` 아티팩트를 만든다(`apps/server/src/finance/chart.ts`). 그래서 차트 끝점은 언제나 표의 값이다(시험 "chart end points = table values").
- 답변에는 서버가 붙인다: 아티팩트 카드 2개, **표 부분**(`table` 파트 — 표 아티팩트의 그 버전을 그대로, 열 머리를 눌러 정렬, 긴 표는 답 안에서 스크롤), 금융 메모(19.3, 출처·기준 시각·면책). 표 부분은 런타임이 보고한 글이 아니라 **그 run이 저장한 표 아티팩트**에서 만든다(`runs.ts` `syncFinanceTables`). 부분은 보이는 버전(`artifactVersion`)을 적어 두고, 같은 run이 뒤에 새 버전을 저장하면(`artifact_update`) 카드처럼 그 자리에서 바뀐다(리뷰 #111). 다른 run의 수정은 이 답변을 건드리지 않는다.
- 표 열: 날짜, 종목, 시장, 통화, 시가·고가·저가·종가, 수익률(%) — 한·미를 섞으면 USD/KRW, 종가(KRW), 종가(USD), 수익률 원화·달러 기준(%), **환율 출처·기준 시각** — 그리고 **출처**, **기준 시각**(모든 행). 재무는 회계 기간, 종목, 항목, 값, 통화, 출처, 기준 시각.
- 차트: 계열은 종목, 아래에 출처(종목마다 "AAPL: Yahoo Finance · 2026-05-14 ~ 2026-11-13 16:00 ET 종가")와 환율 메모. 마우스를 올리면 그 날짜의 모든 종목 값(툴팁), **기준** 전환(원화 기준 ↔ 달러 기준), **확대**(전체 · 3개월 · 1개월). 전환은 라디오 버튼과 CSS뿐이라 스크립트가 없다(18절 CSP 그대로, 새 CDN·새 스크립트 없음). 내려받기 SVG·PNG·PDF는 첫 기준·전체 기간이고 출처·환율 메모가 그림 아래에 들어간다.
- 작업자 한도: 샌드박스 작업자는 한 작업에 4단계까지 받는다(`worker.mjs` `RAW_LIMITS`, 서버 `RAW_JOB_LIMITS` — 시험이 같은지 본다). 단계가 더 많은 계획(1년 KRX = 60행 × 5쪽)은 세션 단계가 없을 때 여러 작업으로 나눠 순서대로 합친다(리뷰 #111). 합성 작업자도 같은 한도로 거절한다.
- 한계: 캔들은 한 종목만, 재무 막대는 미국 종목만(한국 재무 도구 없음 — 한국 종목이면 `finance_bad_input`), 수익률은 기간 첫 거래일 종가 대비이고 확대해도 다시 기준을 잡지 않는다(같은 값의 일부를 크게 볼 뿐).

### 30.2 환율 (원화·달러 기준)
- 원천: 이미 있던 `fx_usdkrw`(Yahoo Finance `KRW=X`, `kr-stock-skill` 권한, FR-7.3)에 `range`를 주면 일별 종가 행(`rows`)도 준다. 새 원천·새 호스트는 없다.
- 환산 규칙: 각 종가를 **그 종가의 현지 날짜 이하의 가장 최근 USD/KRW 일별 종가**로 환산한다(원화는 원 단위 반올림, 달러는 센트). 그날 이전 환율이 없으면 빈 칸(추정하지 않는다). 쓰인 환율과 그 기준 시각("Yahoo Finance · 2026-11-13 17:00 ET 종가")은 행마다 표에, 최근 환율은 차트 아래에 적힌다. Yahoo의 FX 일봉은 UTC 날짜라, 끝난 날의 종가는 그날 17:00 ET(FX 하루의 끝)로, 마지막 봉은 시세의 시각(19.2 규칙)으로 표시한다.
- 한·미가 섞이지 않고 통화도 요청하지 않으면 환율을 부르지 않는다(기준 전환도 없음).

### 30.3 관심 종목 (`/watchlist`)
- 사이드바 "⭐ 관심 종목". 내 목록만(한·미 함께, 50개까지). 한국 종목은 이름·코드로 찾고(`kr_search`, 네이버 증권), 미국 종목은 티커를 그대로 넣는다(미국 이름 검색 도구는 없다). 추가·제거.
- API: `GET /api/watchlist`(내 목록 + 쓸 수 있는 시장 `markets`), `POST /api/watchlist {market, symbol, name?}`(중복 409 `watchlist_duplicate`, 50개 넘으면 409 `watchlist_full`, 시장·형식이 안 맞거나 알려진 비밀이면 400 `watchlist_bad_symbol`), `GET /api/watchlist/search?q=`, `GET`·`DELETE /api/watchlist/:id`. **주인만** — 관리자도 남의 항목은 403(예약과 같은 원칙, 권한 행렬).
- DB: `watchlist_items`(0023 마이그레이션; 사용자를 지우면 함께 지워짐). `name`은 검색에서 고른 표시 이름(제3자 글)이라 저장할 때 알려진 비밀을 가리고 재가림 대상이다(`secrets/columns.ts`).
- **종목 코드와 알려진 비밀(리뷰 #111):** 종목 코드는 가리면 코드가 아니게 되므로 그대로 저장한다. 그래서 저장 전 검사가 하나다: 시장 형식(한국 6자리, 미국 티커 **7자 이하** — 시장 규칙이 아니라 관심 종목만의 의도적인 상한으로, 알려진 비밀의 최소 길이 8보다 짧게 잡았다. Nasdaq은 8자 기호도 허용하므로 드문 8자 종목은 관심 종목에 담을 수 없다(금융 도구로는 조회된다))과 알려진 비밀(그대로든 공통 인코딩이든 — 공통 판정기 `scrubKnown`)을 **둘 다 늘 검사**하고, 어느 쪽이 걸려도 같은 **400 `watchlist_bad_symbol`**이다(응답 본문·경로 같음 — 로그인한 가족이 비밀 후보를 넣어 보고 알아낼 수 없게). 검색도 같은 검사를 통과한 티커만 결과로 돌려준다. 저장한 뒤에 비밀로 등록된 코드(다른 경로로 들어온 행 등)는 백그라운드 재가림이 **그 행을 지운다**(`rescrub.ts` `removeOn`). 이름 칸은 지금처럼 가린다.
- **재가림과 파일의 흔적(리뷰 #111, #78 공통):** DB 연결은 늘 `secure_delete = ON`이다(지우거나 덮어쓴 칸을 0으로). 재가림이 행을 가리거나 지우면 **같은 트랜잭션에서** `settings`에 `secrets.file_cleanup_pending` 표시를 남기고, 끝에 (`auto_vacuum = INCREMENTAL`이면 `incremental_vacuum` 뒤) `wal_checkpoint(TRUNCATE)`로 옛 값이 남은 WAL 프레임을 비우고 DB 파일의 그 쪽을 새 내용으로 덮는다. 성공한 뒤에만 표시를 지운다. 다른 연결(예: `sqlite3` 셸)이 옛 스냅샷을 읽고 있으면 기다리지 않고(바쁨 대기 0 — 서버가 멈추거나 백업·복원의 데이터 잠금과 엉키지 않게) 로그 `secrets.rescrub_checkpoint_busy`를 남기고 백오프로 다시 시도하며, 그동안 `idle()`은 끝나지 않는다. **서버가 그 사이 다시 켜져도** 표시가 남아 있으면 시작할 때 이어서 한다.
- **한 번의 압축(리뷰 #111 3–5차):** `secure_delete` 전에 쓴 내용이 남긴 빈 공간(짧게 고친 긴 제목, 지운 행)은 위 설정만으로는 지워지지 않아 한 번 `VACUUM`(살아 있는 행만으로 파일을 다시 씀)하고 파일을 `auto_vacuum = INCREMENTAL`로 바꾼다. 상태는 `settings`의 `storage.secure_delete_compacted`에 남는다:
  - 없음·`needed` — `VACUUM`을 해야 한다(아직 안 함, 실패, 도중에 죽음). `VACUUM` 직전에 `needed`와 `secrets.file_cleanup_pending`을 함께 남긴다.
  - `vacuumed` — `VACUUM`이 끝났다. 다시 쓴 쪽은 `wal_checkpoint(TRUNCATE)`가 성공해야 파일의 옛 쪽을 덮는다.
  - `1` — 끝: `VACUUM`이 끝났고 **그 뒤** TRUNCATE checkpoint가 성공했다. checkpoint 성공만으로는(`needed`일 때) 끝난 것이 되지 않는다.
  - 서버가 시작할 때(데이터 폴더 잠금을 잡은 채, `buildApp` 안에서, 요청·백업 전 — 백업의 `VACUUM INTO`와 같은 연결이라 겹치지 않음) 먼저 해 본다. checkpoint가 다른 연결 때문에 바쁘거나 `VACUUM`이 실패하면 **실행 중인 서버의 재가림 고리**가 이어서 한다: checkpoint는 재가림의 백오프로, `VACUUM`은 1분부터 두 배씩 최대 1시간 간격으로 다시 한다. 그동안 `idle()`은 끝나지 않고, 다시 시작해도 상태가 남아 있어 이어진다. 로그 `storage.compacted`(걸린 시간, `done`/`running`).
  - 100MB 시험 DB에서 약 0.5초, 499MB에서 약 2.1초(리뷰 측정). 그 뒤 재가림은 전체 `VACUUM` 없이 `incremental_vacuum`으로 빈 쪽만 돌려준다(그 공간은 이미 0).
  - **빈 디스크 공간:** `VACUUM`은 DB 파일 크기의 **최대 약 2배**의 여유 공간이 필요하다(임시 사본 + WAL). 모자라면(`SQLITE_FULL`·`ENOSPC`) 서버는 **그대로 켜지고**, 시도마다 한 번 `storage.compact_failed`(오류 종류만)를 남기며, 상태는 `needed`로 남아 위 간격으로 다시 한다 — 공간을 비우면 다음 시도에서 끝난다(서버를 다시 시작하지 않아도 됨). 끝날 때까지는 옛 빈 공간에 예전 값이 남아 있을 수 있다.
- **금융 송신 가드(리뷰 #111 2·3차):** 금융 도구의 모든 송신 단계(URL·헤더)를 보내기 전에 공통 판정기로 본다 — 알려진 비밀이 그대로·인코딩으로·끝이 잘린 채 들어 있으면 작업을 만들지 않고 `finance_bad_input`. 설정 비밀은 **제자리에서만** 허용한다: OpenDART 키는 `dart_disclosures`가 OpenDART 호스트로 보내는 `crtfc_key` 매개변수로만, SEC 연락처는 `sec_*` 도구가 SEC 호스트로 보내는 `user-agent` 헤더로만. 다른 도구·호스트·칸에 나오면 거절한다 — 16자 이상 일부라도, 그대로든 URL 인코딩이든, 그리고 URL 구성 요소·헤더 값의 base64·base64url·hex·퍼센트 토큰을 한 번 풀어 본 글(전송 이스케이프 한 겹 포함, 공통 판정기와 같은 인코딩 범위)에서도(리뷰 #111 5차: 키를 반으로 나눠 base64로 보내는 경우). **가드의 범위(리뷰 #111 6차, 결정):** **한 요청 안에서** (1) 알려진 비밀 전체가 공통 인코딩 중 하나로 들어 있거나 (2) 설정 비밀의 16자 이상 연속 구간이 그대로·풀어 본 글에 들어 있으면 거절한다. 여러 요청에 16자보다 짧은 조각으로 나눠 보내 바깥에서 다시 합치는 것은 **범위 밖**이다 — 그렇게 하려면 보내는 쪽이 이미 그 값을 알아야 하는데 모델은 알려진 비밀을 받지 않으므로(결과·맥락에서 지워짐) 보호된 곳에서 보호되지 않은 곳으로 옮겨지는 것이 없고, 조각은 1자까지 줄일 수 있어 막을 경계도 없다. 관심 종목 검색어에 비밀이 들어 있으면 **보통 검색과 똑같은 길**(같은 처리 칸, 같은 작업자 호출과 오류 처리)로 고정된 미끼 검색어(`agentlee decoy no match`)를 보내고 결과는 버린다 — 바쁨(429)·연결 실패(502)까지 같은 모양의 다른 검색어와 응답이 같다.
- 대화에서 "내 관심 종목" → `watchlist_get`(토큰 사용자의 목록만, 이름은 `<external_content>` 블록). 금융 지침(`finance@3`)이 이 도구와 `finance_chart`를 쓰라고 한다.

### 30.4 누가 쓰나 (19.4와 같은 규칙)
- `finance_chart`·`watchlist_get`은 `kr-stock-skill`이나 `us-stock-skill` 중 하나라도 쓸 수 있는 사용자에게만 보인다. 청소년 계정(금융 숨김, 19.4)·서버 허용 목록(#35)에서 둘 다 꺼진 경우에는 목록에도 없고 불러도 `finance_not_allowed`.
- 호출할 때 부분마다 다시 검사한다: 한국 종목 → `kr-stock-skill`, 미국 종목 → `us-stock-skill`, 환율 → `kr-stock-skill`. `watchlist_get`은 쓸 수 있는 시장의 종목만 준다. 관심 종목 화면도 같은 검사(`markets`가 비면 "이 계정은 금융 기능을 쓸 수 없어요").

### 30.5 확인 방법
- `pnpm vitest run apps/server/test/finance-chart.test.ts`(한 데이터 → 표·차트, 차트 끝점 = 표 값(두 기준·가격·캔들·재무), 행마다 출처·기준 시각, 환율 날짜 규칙, 기준 전환·확대·툴팁, 이스케이프), `apps/server/test/finance-chart-runs.test.ts`(**M4 완료 기준**: "AAPL, 005930 6개월 비교 차트"를 Claude Code·Codex 녹화 프로토콜 재생(#25/#48 방식, 실제 `finance_chart` 호출)과 FakeRuntime으로 — 표·차트 아티팩트, 표 부분, 출처·기준 시각, 면책; 숨김 계정·허용 목록·부분 권한; 관심 종목 API).
- `E2E_PORT=3118 pnpm e2e e2e/finance-chart.spec.ts`(데스크톱·모바일: 표 부분 정렬, 카드 2개, 메모, 패널의 차트 기준·확대 전환과 툴팁, 관심 종목 검색·추가·제거, 청소년 계정 안내).
- **합성 데이터:** 실제 녹화는 사용자의 `OPENDART_API_KEY`·`SEC_USER_AGENT`와 네트워크 실행(19.5)을 기다린다. 그때까지 시험과 `FAKE_RUNTIME=1` 서버는 `apps/server/src/runtime/fake-finance.ts`의 **합성 일별 시세**(AAPL·NVDA·MSFT·005930·000660·KRW=X, 고정 시드 랜덤 워크)로 금융 도구의 URL에 답한다. `FAKE_RUNTIME=1`에서는 이 URL 말고는 금융 요청이 모두 `finance_unreachable`이다(합성 숫자가 실제 숫자와 섞이지 않고 네트워크로 나가지 않는다). 운영 서버(`FAKE_RUNTIME` 없음)는 이 파일을 쓰지 않는다.
- 실데이터 확인(운영 Mac, 네트워크): 실제 런타임으로 "AAPL, 005930 6개월 비교 차트"를 보내고 표·차트의 마지막 종가가 네이버 증권·Yahoo Finance 화면의 그날 종가와 같은지, 표의 환율 열이 Yahoo `KRW=X` 일별 종가와 같은지 본다. 네이버 가격 API를 60행씩 여러 쪽으로 부르는 부분(6개월 = 3쪽)은 실제 응답으로 아직 확인하지 않았다 — 처음 실행 때 행 수(약 120)를 확인한다.

## 31. 참고문헌 내보내기 — APA·MLA·학교용 (#26)
PRD FR-5.6. 대화의 답에서 인용한 출처를 보고서용 참고문헌으로 정리해 복사하거나 `.txt`·`.docx`로 내려받는다(아들의 과제용). 마이그레이션 없음(기존 `messages`·`sources` 열로 충분).

### 31.1 무엇을 모으나
- **기록에 있는 답의 인용만:** 활성(`active`) 답 메시지의 서버 `citation_note`(#25 — 인용 행으로 서버가 만든 부분, 런타임이 쓸 수 없음)에 있는 항목. 다시 생성했거나 앞 메시지를 고쳐 기록에서 빠진 답의 출처는 빠진다. 아무 `cite`도 만들지 않은 `[n]`(`unknown_source`)은 출처가 없으므로 빠진다.
- 웹 출처는 그 대화의 `sources` 행(id **와** 대화로 찾음 — 다른 대화의 행은 읽지 않는다)으로 보완한다: 리디렉션 뒤 주소(`final_url`), 제목·사이트, 접속일(`fetched_at`을 **사용자의 시간대** 날짜로 — 알림 설정의 `time_zone`(FR-12.8), 없으면 Asia/Seoul). 행이 없으면 노트의 제목·사이트·주소 그대로(접속일 없음).
- **중복 제거(리뷰 #115 1·2차):** 웹은 문서 하나에 한 항목. 주소 키에는 스킴·호스트·포트·경로·쿼리가 그대로 들어간다 — 같은 문서임이 확실한 것만 맞춘다(호스트 대소문자, 기본 포트, `#조각`). `http`/`https`, `www.`, 끝 `/`, 추적 매개변수가 다른 주소는 **다른 문서로 본다**. 가져온 행의 문서는 **도착한 곳**이다(`final_url`, 리디렉션이 없으면 `url`). 시작 주소는 인용된 행들이 그것을 **정확히 한 곳**으로 보낼 때만 그 문서로 이어진다 — `/latest → /nov-12`와 `/latest → /nov-13`은 두 문서로 남고(각자의 상태), `/latest`만 적힌 검색 결과는 `/latest` 그대로다. **리디렉션 없이 바로 가져온 페이지도 자기 주소의 도착지로 센다**(리뷰 #115 3차): `/latest`를 직접 가져온 것(12일 본문)과 `/latest → /nov-13`(13일 본문)은 두 문서다. 검색 결과(가져온 본문 없음)는 단서일 뿐 도착지가 되지 않는다. 사슬(`a → b → c`)은 **저장된(인용된) 행만** 따라간다: 아무 인용 행도 가져오지 않은 중간 단계는 찾아보지 않는다(알려진 한계). 같은 페이지를 두 번 가져온 것도 한 출처다. 항목은 검증된 페이지 행 → 페이지 행 → 첫 행 순으로 고른 행에서 쓴다. 출력 주소에서는 조각과 사용자 이름·비밀번호를 뺀다.
- **파일 출처(#48, PR #107 이후):** #107의 노트 항목 모양(`sourceId`·`url` 없음, `title` = 파일 이름, `site` = 쪽·시트 표시, 검증된 구절만 표시가 있음)을 따로 떨어진 경로에서 읽는다(`isFileEntry`, `collect.ts`). 파일 하나에 한 항목(항목에 `fileId`가 있으면 그것으로, 없으면 이름으로 구별), 인용한 곳은 처음 인용한 순서로 모은다(최대 20개). #107의 코드에 기대지 않으며, 시험은 그 모양의 fixture 행으로 한다.
- **검증:** 출처의 인용 중 하나라도 `verified`면 검증된 출처(페이지에 그 구절이 정말 있었다). 하나도 없으면 "검증 실패 출처" — 화면에 ⚠️와 이유(`CITATION_STATUS_TEXT`)로 보이고, **기본으로 빠진다.** "검증 실패 출처 포함"을 켜면 들어간다(⚠️ 표시 유지).
- 한 번에 최대 200개(`REFERENCE_LIMITS.entries`, 문서 생성의 참고문헌 한도). 넘으면 처음 인용한 200개와 "처음 200개만" 안내.

### 31.2 형식 (`packages/shared/src/references.ts`, 형식마다 스냅샷 시험)
- 저장된 출처에는 저자가 없다 — 그래서 모든 웹 항목은 그 형식의 **저자 없는 형태**다: APA 7은 제목이 저자 자리(§9.12), MLA 9은 제목으로 시작. 저자가 있으면 **받은 그대로** 쓴다 — 이름을 뒤집거나 줄이지 않는다(한국 이름 "홍길동"은 그대로; 로마자 이름도 성·이름을 믿을 만하게 나눌 수 없어 뒤집지 않는다).
- **제목 대소문자는 바꾸지 않는다(결정, 리뷰 #115 1차):** APA의 sentence case도 MLA의 title case도 자동으로 하지 않는다 — 고유명사 정보가 없어 어느 쪽이든 이름을 망가뜨린다. 한국어·영어 제목 모두 출처에 쓰인 그대로다(알려진 한계: APA는 원래 sentence case를 요구하므로 필요하면 복사 후 고쳐 쓴다).
- **APA 7:** `제목. (2026, November 10). 사이트. URL`. 날짜가 없으면 `(n.d.)`. 사이트 이름이 저자·제목과 같으면 뺀다(§9.13). **"Retrieved …, from"은 쓰지 않는다(결정, 리뷰 #115 1차):** APA는 계속 바뀌도록 만든 페이지에만 검색일을 쓰는데(§9.16) 출처가 그런지 알 수 있는 정보가 없다 — 날짜가 있든 없든 빼며, 이것은 알려진 한계다(학교용은 접속일을 늘 쓴다).
- **MLA 9:** `"제목." 사이트, 10 Nov. 2026, 주소(https:// 뺌). Accessed 13 Nov. 2026.` 월은 MLA 약어(May·June·July는 그대로). 제목은 바꾸지 않는다. 날짜 없으면 날짜 칸을 뺀다.
- **학교용 간단 형식:** `1. 저자 미상, 「제목」, 사이트, 2026. 11. 10., URL (접속일: 2026. 11. 13.)` — 저자·제목·사이트·날짜·URL·접속일 여섯 칸, 없는 칸은 "저자 미상"·"사이트 미상"·"날짜 없음"으로 적는다. 처음 인용한 순서로 번호.
- 파일: APA `이름 [Unpublished document; 3쪽, 5쪽]. (n.d.).`, MLA `이름. Unpublished document, 3쪽, 5쪽.`, 학교용 `이름 (업로드한 파일, 3쪽, 5쪽)`.
- 날짜: APA·MLA는 영어 표기(그 형식의 규칙), 학교용은 한국식 `2026. 11. 10.`. **발행일은 출처가 적은 날짜 그대로**(리뷰 #115 1차): 쓰인 날짜(`2026`·`2026-11`·`2026-11-10`)는 그대로, 시각이 있으면 그 시각이 적힌 **자기 오프셋의** 날짜(`2026-11-09T23:30:00-05:00` → 11월 9일 — 다른 시간대로 옮기지 않는다). 실제 달력에 없는 날(`2026-02-31`, 윤년 아닌 해의 2월 29일)·이상한 해·그 밖의 값은 날짜 없음. 접속일만 사용자의 시간대로 바꾼다.
- 순서: APA·MLA는 가나다·알파벳순, **한글 항목 먼저**(첫 글자가 한글인 항목 — "10월 …"도 한글) 그다음 나머지. 앞 따옴표·괄호와 영어 관사(A·An·The)는 무시. 학교용은 처음 인용한 순서.
- 평문에는 기울임이 없다: APA·MLA가 기울임으로 쓰는 제목·사이트 이름도 모든 출력에서 보통 글자다(알려진 한계).

### 31.3 출력과 비밀
- **평문 처리:** 모든 칸은 한 줄의 평문 — 제어 문자(C0·C1, 줄바꿈·탭은 공백), 양방향 제어 문자(U+202A–202E, U+2066–2069, LRM·RLM·ALM), 보이지 않는 공백(ZWSP·WJ·BOM·SHY), 비문자(U+FFFE·FFFF)를 지우고 짝 없는 서로게이트는 U+FFFD, 공백을 하나로. 복사·`.txt`에 그대로 쓰고, `.docx`는 #49의 `paragraph` 블록(평문 글자만 — HTML·마크업 없음)으로 넘긴다. 주소는 http(s)만(그 밖은 주소 없이), 사용자 이름·비밀번호·조각을 뺀다.
- **알려진 비밀:** 제목·사이트·주소·파일 이름·쪽 표시·대화 제목을 **형식에 넣기 전에** `scrubKnown`으로 가리고(평문 처리 전과 후 — 보이지 않는 문자로 나뉜 비밀이 합쳐져도 잡는다, 칸 한도에서 잘린 비밀 앞부분도 칸 끝에서 가린다), 만든 줄을 한 번 더 가린다. `.docx` 응답은 바이너리라 응답 안전망(`registerResponseScrub`)이 보지 않으므로 이 단계가 유일한 보장이다(시험: 문서 XML·ZIP 바이트에 비밀 없음). 파일 이름에는 대화 제목이 들어가지 않는다(아래).
- **내려받기 파일 이름(결정, 리뷰 #115 6차):** 이름은 대화 제목으로 만들지 않고 **서버가 정한다** — `참고문헌-<형식>-<YYYY-MM-DD>.<확장자>`(형식 APA·MLA·학교용, 날짜는 사용자 시간대의 접속일), 예: `참고문헌-APA-2026-11-13.docx`. ASCII 대체 이름은 `references-<APA|MLA|school>-<날짜>.<확장자>`. 제목을 자르고 바꾸고(`/` → `_`) 잘라 붙인 파일 이름은 검사가 볼 수 없는 비밀 조각을 계속 만들었다(1·2·5·6차). 제목은 문서 안(부제)에만 있고, 그곳은 원래 행에서 다시 만들기와 XML 검사가 덮는다. 잘리는 것이 없으므로 최종 헤더와 두 이름을 완전한 값으로(`tail: false`) 한 번 확인하고, 걸리면(이름 자체를 누가 등록한 경우) 이름 없이 `attachment`만 보낸다.
- **만든 파일의 검사(리뷰 #115 1·2차):** 작업자가 끝나면 지금의 비밀 목록으로 두 가지를 본다 — (1) 작업자가 도는 동안 새로 등록된 값: 입력 글을 다시 가린다. (2) XML로 쓰면서 **생기는** 값(`&` → `&amp;`, `<` → `&lt;` — `sk-a&b` 제목이 문서 XML에서는 등록된 `sk-a&amp;b`): 서버가 `.docx`(ZIP)를 다시 열어 **모든 XML 부분**(`.xml`·`.rels`)의 원문, 글자 내용(작업자 검사기의 `xmlText` — 태그 제거·엔터티 풀기), 풀어 낸 속성 값을 확인한다(`readParts`·`partsHoldSecret`, `references/docx-check.ts`; 압축된 바이트는 검색하지 않는다). **순서(리뷰 #115 3차):** 비동기 단계(모든 부분 읽기)를 먼저 다 마친 뒤, 입력 다시 가리기와 모든 부분 검사를 그 순간의 목록으로 한 번에(동기) 하고 목록 상태를 기록한다 — 뒤 부분을 읽는 동안 등록된 값도 앞 부분에서 찾는다. 보내기 직전 목록 상태가 바뀌었으면 읽어 둔 부분을 다시(동기) 검사하고 걸리면 `references_retry`. **완전한 값만 비교한다(`tail: false`):** 완성된 XML·글자·속성 값의 끝이 등록된 값의 앞 글자와 같은 것은 누출이 아니다(작업자의 고정 글꼴 `Malgun Gothic`과 등록된 `Malgun Gothic-…`). 잘린 비밀 앞부분 가리기는 칸 한도로 정말 잘리는 곳(입력 칸·파일 이름)에만 쓴다. 걸리면 그 파일을 버리고, 이스케이프한 모양에 비밀이 든 입력 글을 가려(`maskEscaped`) 한 번 다시 만든다. 다시 걸리거나 어느 입력 글로도 설명되지 않는 걸림이면 503 `references_retry`(`Retry-After: 1`) — 파일은 주지 않는다. 열 수 없는 ZIP도 걸림으로 본다.
- **잘린 칸의 다시 검사(리뷰 #115 4차):** 작업자가 도는 동안 등록된 값이 칸 한도에서 **잘린** 칸에 있으면(대화 제목은 100자에서 잘린 뒤 " · APA 7"이 붙는다) 완성된 줄에서는 잘린 자리를 알 수 없다. 그래서 마지막 비동기 단계 뒤에 **원래 행**(대화 제목, 출처 제목·사이트·주소)에서 문서를 다시 만든다 — `cleanText`·`cleanUrl`이 실제 칸 한도에서 잘린 비밀 앞부분까지 지금의 목록으로 가린다. 다시 만든 것이 달라졌으면 한 번 다시 만들고(그 사이 또 달라지면, 또는 항목이 없어졌으면 `references_retry`), 보내기 직전 상태 비교에서도 다시 만들어 본다.
- **보장 범위(결정, 리뷰 #115 4차):** 서버가 **경로의 마지막 검사 시점(보내기 직전)에 아는 값**은 파일에 들어가지 않는다. 그 뒤 — 응답 훅(`onSend`)과 소켓 쓰기 사이 — 에 등록된 값, 즉 내보내기가 오가는 도중 그 시점 이후 등록된 값은 범위 밖이다(어디에 마지막 검사를 두어도 소켓 쓰기까지의 틈은 남고, 알려진 값 등록은 관리자 설정·연결처럼 드물다).

### 31.4 API·권한·화면
- `GET /api/conversations/:id/references?style=apa|mla|school&includeUnverified=0|1` → `{ style, includeUnverified, items[{id, kind, verified, status, included, text}], text, excluded, truncated }`. `text`가 복사하는 내용(포함된 항목, 줄마다 하나). `id`는 해시(주소가 아님).
- `GET /api/conversations/:id/references/download?style=…&format=txt|docx&includeUnverified=…` → `attachment`(`참고문헌-APA-<사용자 시간대 날짜>.txt` — 위 파일 이름 규칙), `nosniff`·`no-store`. 넣을 항목이 없으면 409 `references_empty`. `.docx`는 앱의 #49 문서 작업자(production은 언제나 macOS 샌드박스, `ISOLATION_IN_PROCESS_FOR_TESTS`는 시험·개발 전용, FAKE_RUNTIME으로 바뀌지 않음, §29.6)로 만든다 — 제목 "참고문헌", 부제 "대화 제목 · 형식", 항목마다 문단. 작업자가 다시 열어 검사하고 서버는 ZIP 머리를 본다. 실패는 503 `references_unavailable`. 대화 파일로 저장하지 않는다(20개 한도에 세지 않음).
- **작업자 자리(리뷰 #115 1차):** 문서 작업자 실행은 모두 하나의 조정기(`DocSlots`, `apps/server/src/docgen/slots.ts`)를 지난다 — `doc_create`와 참고문헌 `.docx`가 함께 **서버 전체 2개, 사용자당 1개**. 넘으면 기다리지 않고 바로 거절한다: 내보내기는 503 `references_busy`(`Retry-After: 5`), `doc_create`는 `doc_busy`. 한 사용자가 자리를 잡고 있어도 다른 사용자는 막히지 않는다.
- **권한:** 자원 `conversation-references` — `conversation` 자원의 로더를 그대로 쓴다(주인과 #29 공유 대상). 공유 대상의 내보내기는 그 사람의 공유 투영(§33)에 든 메시지와 그 메시지가 인용한 출처로만 만든다 — 스냅샷 경계 뒤나 철회된 공유의 인용은 나오지 않는다(시험 `shares.test.ts`). 그 밖(다른 가족·관리자)은 403, 로그인 없으면 401, 없는 대화 404. 권한 행렬 2행. 내보내기에는 대화 메시지(인용 노트)가 이미 보여 주는 것 밖에는 접속일만 더해진다.
- 로그: `references.exported`(사용자·대화 ID, 항목 수, 소요 시간, `.docx`면 `docKind`·`docCode`). 항목·제목·주소는 남기지 않는다(시험).
- **화면:** 대화 상단 "📚 참고문헌"(좁은 화면은 📚만, 접근 이름 "참고문헌") → 모달 대화상자(`<dialog>` — 포커스 가둠, Esc·바깥 누르기·✕로 닫고 단추로 포커스 복귀): 형식 고르기(라디오 — APA 7·MLA 9·학교용), "검증 실패 출처 포함"(체크 상자, 기본 꺼짐), 항목 목록(포함 항목, 빠진 실패 출처는 이유와 함께 따로), ⧉ 복사·.txt 내려받기·.docx 내려받기, 결과 안내(`role=status`, 오류는 `alert`).
- 형식이나 토글을 바꾸면 새 목록이 올 때까지 앞 목록을 보여 주되(`keepPreviousData`), **복사·내려받기는 꺼 둔다** — 응답의 형식·포함 여부가 지금 고른 것과 같고 자리 표시 데이터가 아닐 때만 켠다(리뷰 #115 1차: 바꾼 직후 누르면 앞 형식이 복사되던 것).

### 31.5 확인
- 시험: `pnpm test packages/shared/test/references.test.ts apps/server/test/references.test.ts` — 형식별 스냅샷(같은 출처 묶음을 APA·MLA·학교용으로, 그리고 API 응답으로), 중복 제거(주소 변형·검증 우선·처음 인용 순서), 기록 밖 답 제외, 다른 대화 행 미사용, 파일 출처 fixture, 평문·주소·날짜 규칙, 기본 제외·토글, 400·409, 권한(403·401·404), `.txt` 머리·내용, `.docx`(작업자로 만들어 열어 항목 비교, 로그), 작업자 실패·동시 한도, 비밀(목록·`.docx` XML·바이트·파일 이름). 권한 행렬은 `permissions.test.ts`.
- 변이 시험(되돌림 확인): 기본 포함으로 바꿈·토글 무시·자원 검사 빼기·`usage` 동작·모든 가림 빼기·칸 가림만 빼기·주소 중복 제거 빼기·검증 우선 빼기·비활성 메시지 포함·다른 대화 행 읽기·파일을 이름으로만, 그리고 리뷰 #115 1차 수정마다: 최종 파일 이름 확인 빼기·작업자 뒤 다시 가림 빼기·주소 키를 느슨하게(끝 `/`·`www.`·스킴 무시)·리디렉션 합치기 빼기·사용자당 자리 빼기·`doc_create`가 자리를 안 지남·복사/내려받기 비활성 조건 빼기(e2e)·발행일을 서울 시간으로·접속일을 사용자 시간대 대신 서울로·달력 검사 빼기·APA "Retrieved" 되살리기·자동 대소문자 되살리기. 2차: 대체 이름 확인 빼기·파일 XML 검사 빼기·이스케이프 입력 가리기 빼기·속성 값만 빼기·원문만 빼기·두 도착지 합치기·저장된 사슬 안 따라가기 — 모두 잡힌다. 입력 다시 가리기만 빼는 변이는 살아남는다: 늦게 등록된 값도 파일 XML 검사가 잡기 때문이다(겹친 방어). 3차: 부분을 읽으며 바로 검사(교차)·완전한 값에 tail 비교·직접 가져온 페이지를 도착지에서 빼기·검색 결과를 도착지로 세기·원문/속성/전체 XML 검사 빼기 — 모두 잡힌다. 살아남는 둘은 같은 이유로 등가다: 입력 다시 가리기를 읽기 앞으로 옮기기(파일 XML 검사가 같은 값을 잡음), 보내기 직전 상태 비교 빼기(지금은 검사와 보내기 사이에 비동기 단계가 없음 — 앞으로의 변경 대비). 4차: 원래 행에서 다시 만들기 빼기·잘린 문서를 다시 가리기로 대신하기 — 둘 다 101자 제목 시험이 잡는다. 6차: 이름을 고정 이름으로 바꾸면서 5차의 이름 검사(잘린 자리·다시 만들기)는 빠졌다 — 제목을 이름에 다시 넣기(헤더에 안전하게 인코딩해도)·최종 헤더 확인 빼기 둘 다 잡힌다.
- e2e: `E2E_PORT=3119 pnpm e2e e2e/references.spec.ts` — 프로젝트마다 **새 청소년 계정**(데스크톱·모바일이 동시에 돌고 `.docx`는 사용자당 하나라서 계정을 나눈다)이 `/cite conflict`·`/cite insufficient`로 답을 받고 📚 → APA 기본·실패 출처 표시·제외 → 복사(클립보드 확인, 데스크톱 Chromium) → 토글 → MLA로 바꾸는 동안 목록 응답을 붙잡아 두고 복사·내려받기가 꺼져 있는지 → MLA·학교용 → `.txt` 내려받기 이름(`참고문헌-학교용-<날짜>.txt`)·내용 일치 → `.docx`(이름 `참고문헌-학교용-<날짜>.docx`, macOS만 — 샌드박스, docgen.spec.ts와 같음) 열어 항목 일치 → Esc로 닫고 포커스 복귀 → 엄마 계정은 403.

## 32. 예약 실행 — 전용 대화·결과·실패·알림 (#56)
PRD FR-8.3·8.4·8.6, FR-11.8. 엔진(25절)의 핸들러 계약 위에서, 예약 실행 하나가 그 예약 **전용 대화**의 한 차례(turn)가 된다. 코드: `apps/server/src/schedules/handler.ts`.

### 32.1 전용 대화와 실행
- 예약마다 대화 하나(`conversations.kind = schedule`, 주인 = 예약 주인, 제목 = 예약 이름, `schedules.conversation_id`). 첫 실행 때 만들고, 주인이 지웠거나 저장된 대화가 그 주인의 예약 대화가 아니면(남의 대화, 보통 대화) **새로 만든다** — 남의 대화나 보통 대화에는 쓰지 않는다. 관리자·남은 다른 대화처럼 403(권한 행렬).
- 실행 = 주인이 그 대화에 프롬프트를 보낸 것과 같다: `RunManager.begin`(맥락 빌더·요약 #45, `inputText` = 프롬프트), 예약의 런타임·모델·추론 강도·공용 연결을 **그 주인의 명시적 선택으로 다시 검사**(허용이 줄었으면 `not_allowed`로 실패, 아무것도 실행하지 않음 — 예약이 만든 사람의 지금 권한보다 더 쓰는 일은 없다), 도구는 주인에게 허용된 것만(#21). 공용 연결 여부(`useShared`)도 늘 예약의 값을 명시해 보낸다 — 대화가 예전에 "공용으로 쓰기"였어도 개인으로 바꾼 예약은 개인 연결로 돈다(review #116). 연결 경고(32.3)는 실행과 **같은 요청**(`scheduleRequest`)으로 검사하므로 둘의 판단이 같다.
- **스킬(FR-8.2)**: 예약에서 고른 스킬만 그 실행에서 쓴다 — 고른 것 ∩ 지금 주인이 쓸 수 있는 것(권한 #21, 서버 허용 목록 #35). 도구 목록과 MCP 토큰(`McpScope.skills`)에 함께 실리고, MCP 서버는 목록을 만들 때와 **호출할 때마다** 다시 본다(금융 도구 `finance_not_allowed`, 스킬 `skill_not_allowed`). 아무것도 고르지 않으면 스킬·금융 도구가 하나도 없다(검증용 `selftest` 포함 — 웹·아티팩트·문서·예약 제안 같은 기본 도구는 그대로). 만든 뒤 권한이 빠진 스킬은 실행 때 빠진다. 답에는 모든 답과 같은 금융 출력 검사(#30 금융 노트·표, #31)와 인용 검사(#25)가 붙는다. 사용량은 주인 것으로 `purpose = schedule`(#44), 비용은 실행 이력에 보인다(28.1절 — 그 실행의 모든 시도가 연 대화 런의 합).
- 시도 하나 = 대화 런 하나. 첫 시도는 프롬프트를 사용자 메시지로 올리고, **재시도(2분 뒤 한 번)는 그 답을 다시 생성**한다(실패한 답은 이전 버전으로 남음). 주인이 그 사이 같은 대화에 글을 썼으면 재시도는 새 메시지로 올린다(주인의 글을 자르지 않는다). 주인이 그 대화에서 다른 답을 받는 중이면 그 시도는 실패(재시도에서 다시).
- 한 시도의 대화 런은 20분 안에 끝나야 한다(넘으면 중지하고 `timeout`).

### 32.2 결과·실패·"새 결과"
- 성공: 그 답 메시지가 결과(`schedule_runs.result_ref`). 실패(재시도까지): 대화에 실패 메시지 "**예약 실행 실패** — 이유."(재시도했으면 "2분 뒤 한 번 더 시도했지만 실패했어요."). 이유는 코드별 고정 글(런타임 오류 원문은 쓰지 않음): 연결 없음·로그인 만료·권한 바뀜·사용 한도·너무 긴 프롬프트·시간 초과·중단·대화 사용 중·응답 오류.
- 이력 코드(`error_code`): `runtime_unavailable`(런타임·연결 없음, 로그인 만료), `not_allowed`(권한), `interrupted`(서버 재시작·중지), `timeout`, `run_failed`(그 밖).
- 결과(또는 실패 메시지)를 남길 때 대화에 **"새 결과"** 표시(`conversations.new_result_at`, 대화가 목록 위로). 사이드바 대화 이름 옆 "새 결과" 배지, 주인이 그 대화를 열면 사라진다(`POST /api/conversations/:id/result-seen`, 주인만). 사이드바 목록은 화면이 보이는 동안 1분마다, 화면이 다시 보이거나 포커스를 받을 때, 푸시가 올 때, 예약 상세의 실행이 결과를 남겼을 때 다시 읽는다 — 푸시나 그 예약의 알림이 꺼져 있어도 1분 안에 뜬다.

### 32.3 알림
- 실행이 끝나면(예약의 알림이 켜져 있을 때) 한 번: 성공 `schedule_succeeded` — 제목 = 예약 이름, 본문 = 결과의 첫 두 줄(34·13.5 규칙으로 자름); 실패 `schedule_failed` — "실행 실패 — 이유". 링크 = 결과 메시지(`/c/<대화>#m-<메시지>`). 화면은 그 메시지가 처음 불러온 메시지(대화 화면은 한 번에 100개를 부른다 — API 기본값은 50개)에 없으면 이전 페이지를 차례로 불러 찾은 뒤 그 메시지로 이동한다. 페이지를 못 불러오면(500, 권한이 빠져 403 등) 또는 20페이지를 넘으면 더 부르지 않고 "결과 메시지를 찾지 못했어요 · 다시 시도"를 보인다. 결과 대화가 이미 열려 있을 때 결과가 오면, 열린 화면이 자기 대화를 1분마다(보이는 동안) 다시 읽어 "새 결과"를 보는 순간 메시지·실행도 다시 읽는다 — 사이드바가 검색 중이거나 그 대화가 목록에 없어도. "새 결과"는 **그 결과 메시지 자체**(`conversations.new_result_message_id`, API `newResultMessageId`)가 오류 없이 불러와져 화면에 있을 때만 지운다(불러오기 실패·링크의 메시지를 못 찾음 → 남는다). `POST …/result-seen {messageId}`는 그 메시지가 아직 표시 대상일 때만 지운다(그사이 온 더 새 결과는 남음). 결과 링크로 연 화면도(주소의 `#m-…`는 남는다) 링크가 그 메시지를 **한 번 찾은 뒤에는** — 그 뒤 그 메시지가 다시 생성·수정으로 빠지거나 첫 페이지 밖으로 밀려도 — 보통 화면처럼 다음 결과를 받는다(링크가 바뀔 때마다 — 다른 해시, 해시를 지움, 같은 해시를 나중에 다시 — 새 링크로 보고 찾기·스크롤·멈춤 상태를 처음부터 한다) — 링크가 찾는 중이거나 그 결과에서 멈춘 동안만 갱신을 맡는다. 결과 메시지가 기록에서 빠지면(다시 생성, 앞 메시지 수정) 같은 트랜잭션에서 **그 결과의** "새 결과"도 지운다(사용자가 그 대화를 고치는 중이니 본 것; 더 새 결과는 남음). 결과 저장이 실패해 재시도·재시작 복구로 나중에 저장될 때 그 답이 이미 기록에서 빠져 있으면, 실행의 결과 참조로는 남기되 "새 결과"로 표시하지 않고, 그 알림의 링크도 메시지(`#m-…`) 없이 대화로 간다(다른 결과의 표시도 건드리지 않음). 보내기·수정·재생성은 진행 중인 `active-run` 읽기를 취소하고, 그 전에 보낸 읽기의 늦은 답("실행 없음")이 방금 시작한 실행을 덮지 못한다(review #116). 알림함 항목은 그 대화를 읽을 수 있을 때만 보인다.
- **연결이 끊긴 예약(FR-11.8)**: 1분마다 다음 실행이 1시간 안에 오는 예약을 실행과 같은 검사(`scheduleUsable` — 런타임·모델 허용, 연결이 필요한 런타임이면 쓸 수 있는 연결)로 보고, 안 되면 주인에게 `schedule_warning` 하나 — 제목 = 예약 이름, 본문 "오전 9:00 실행 전에 확인해 주세요 — ○○ 연결을 쓸 수 없어요. / 다시 연결하거나 예약의 런타임을 바꿔 주세요.", 링크 = 예약 화면. 시각은 서버의 로캘·ICU와 상관없이 "오전/오후 h:mm"으로 직접 만든다. **회차마다 한 번**(다시 시작해도). 엔진처럼 데이터 폴더 잠금을 가진 서버에서만 돈다.

### 32.4 정확히 한 번 — 크래시 복구
- 시도의 메시지와 시도 기록(`schedule_attempts`: 실행·시도 번호·대화·사용자/답 메시지·대화 런)은 `begin`의 한 트랜잭션에서 함께 쓰인다. 대화 런의 멱등 키는 `schedule:<실행 id>:<시도>` — 같은 시도는 몇 번 불려도 대화 런이 하나다.
- 실행 도중 서버가 죽으면: 그 대화 런은 다음 시작에서 `server_restart`로 끝나고(이어 하지 않음), 엔진 복구(25.4절)가 그 시작을 시도 1회로 센다 → 남은 시도가 있으면 재시도(답을 다시 생성), 없으면 `interrupted` 실패. **시도보다 많은 런타임 차례는 없다**(최대 2).
- 결과·실패 메시지·"새 결과"·`schedule_results`(실행마다 한 행)는 한 트랜잭션 — 저장한 뒤 엔진이 적기 전에 죽어도 다시 불린 `saveResult`가 그 행을 찾아 그대로 돌려준다.
- 알림은 `notifications.dedupe_key`(유니크): 실행 알림 `schedule-run:<실행 id>`, 경고 `schedule-warning:<예약 id>@<회차 ms>`. 같은 키로 다시 발행하면 첫 알림을 돌려준다.
- DB: 0025 마이그레이션(`schedule_attempts`, `schedule_results`, `conversations.new_result_at`·`new_result_message_id`, `notifications.dedupe_key`). 새 글자 칸은 모두 id·서버가 만든 키다(`secrets/columns.ts`).

### 32.5 알려진 비밀(#78)
- 결과 글은 다른 답처럼 저장·응답 때 가려진다. 알림 본문은 결과 글을 **자르기 전에** 다시 가리고(자른 끝에 비밀의 앞부분만 남으면 나중 검사가 못 알아보므로), 발행할 때 제목·본문·링크를 다시 가린다. 실패 이유는 고정 글이다. 대화 제목(예약 이름)은 만들 때 가린다.

### 32.6 확인 방법
- `pnpm vitest run apps/server/test/schedule-run.test.ts`(FakeRuntime): 성공(대화·메시지·결과 참조·사용량·비용·알림 제목·두 줄 본문·링크·"새 결과"·관리자 403), 매 실행 새 메시지와 금융 노트, 재시도 후 실패(사용자 메시지 1개·답 재생성·실패 메시지·실패 알림 1개·두 시도 비용), 실패 후 재시도 성공, 권한 줄어듦 → `not_allowed`, 남의 대화·보통 대화에 쓰지 않음, 시간 초과, 같은 시도 두 번 → 런 1개, 크래시(실행 중·결과 저장 전/후·알림 전/후) 각각 → 메시지·결과·알림 1개, 경고(1시간 전, 회차마다 1번, 일시정지·쓸 수 있는 예약은 없음), 알려진 비밀(나중에 등록된 것 포함). 권한 행렬(`result-seen` 주인만), e2e `e2e/schedules.spec.ts`(바로 실행 → 사이드바 "새 결과" → 열면 사라짐; 알림 끔·푸시 없음·다른 대화에서 1분 뒤 "새 결과"; 결과 뒤 51차례가 쌓여도 알림 링크가 그 메시지로). review #116: 공용→개인 전환 시 개인 연결·공용 권한 회수 시 경고와 실행이 같은 판단, 스킬 범위(목록·호출), 로캘과 무관한 시각.
- 실런타임·실기기 확인(수용 기준 5 절차 1·3): 운영 Mac에서 실제 런타임으로 매일 회차 예약을 7일 돌려 정시 ±1분, 결과 대화, 휴대폰 푸시(제목·두 줄·눌러서 그 메시지로)를 본다. 연결을 끊어 둔 예약은 1시간 전 경고가 휴대폰에 오는지 본다.

## 33. 가족 공유 — 공유 투영·불변 범위·즉시 철회 (#29)
PRD FR-14.1~14.3·14.4·14.7, FR-6.3, 수용 기준 6, #3 부분 공유 결정. 방식·경로 목록·새 경로 규칙은 `docs/decisions/sharing.md`. 공유 화면 전체(대화 메뉴의 "가족에게 공유", 열람 확인, "이어서 대화하기", 사이드바 묶음)는 #52(§36).

### 33.1 무엇을 하나
- 대화(예약 결과 대화 포함)나 아티팩트를 **가족 전체** 또는 **고른 가족 계정**에게 읽기 전용으로 공유한다. 가족 밖 공개 링크는 없다.
- **live**: 원래 대화에 새 메시지가 쌓이면 공유본에도 보인다.
- **snapshot**("이 메시지까지"): 경계 메시지까지의 메시지와 그 메시지들이 가져온 파일·아티팩트 버전·인용 출처만 공유할 때 고정한다. 그 뒤에 생기거나 바뀐 것은 403이다.
- 공유받은 사람에게는 `reasoning` 파트와 도구 원본 결과가 어디로도 가지 않는다. 메시지, run 이벤트 SSE, 공유 화면, 검색 모두 같다. 도구 이름·입력은 보인다.
- 주인 계정을 비활성화하면 그 사람의 공유는 아무에게도 닿지 않는다(403, 열린 스트림 종료). 해제된 것은 아니므로 계정을 다시 활성화하면 돌아온다. 지금은 앱에 다시 활성화하는 기능이 없고, DB에서 `users.active = 1`로 바꾼다.
- `document` 아티팩트를 공유하면 그 버전들이 가리키는 생성 파일만 함께 내려받을 수 있다(snapshot이면 스냅샷 버전의 파일만). 대화 공유에서도 투영에 든 문서 버전의 파일이 열린다. 되돌리기로 만든 버전의 파일도 마찬가지다.
- 해제·대상 변경은 즉시 적용된다. 다음 요청부터 403이고, 열린 SSE(공유 화면의 공유 스트림, 진행 중인 답의 run 스트림)는 바로 닫힌다. 이미 내려받은 파일과 포크 사본은 되돌리지 않으며, 화면에 그렇게 안내한다.

### 33.2 API
- `POST /api/conversations/:id/shares {target, mode, boundaryMessageId?}`, `POST /api/artifacts/:id/shares {target, mode}` → 201 `Share`. 주인만 할 수 있다.
  - `target`: `{audience:"family"}` 또는 `{audience:"users", userIds:[계정 id]}`.
  - 이메일·다른 키, 빈 `userIds`는 400이다. 없거나 비활성인 계정, 자기 자신은 400 `invalid_share_target`이다.
  - snapshot은 `boundaryMessageId`가 꼭 있어야 한다. 그 대화의 활성 메시지가 아니면 400 `share_boundary_not_found`, 답을 쓰는 중이면 409 `share_run_in_progress`이다.
- 주인만:
  - `GET /api/conversations/:id/shares`, `GET /api/artifacts/:id/shares`
  - `GET /api/shares/:id`
  - `PATCH /api/shares/:id {target}` (대상 변경)
  - `DELETE /api/shares/:id` (해제 — 행은 남고 `revokedAt`이 채워진다)
- 공유받은 사람(주인은 미리보기):
  - `GET /api/shares/:id/view`: 투영된 메시지·파일·아티팩트(보이는 버전)·출처.
  - `GET /api/shares/:id/events`: SSE. `ready`를 보낸 뒤 공유가 닿는 동안 열려 있고, 끊기면 `revoked`를 보내고 닫힌다.
  - `GET /api/artifacts/:id/access?version=n`: 아티팩트 화면(`/a/:id`, 패널)이 따르는 SSE. `n`은 화면에 보이는 버전이다. 주인은 `owner`를 받고 바로 끝난다.
    - 공유받은 사람은 아티팩트를 더는 볼 수 없게 되면 `revoked`를 받는다. 화면은 프레임과 캐시를 지운 뒤 철회 안내를 보인다. 공유 화면에서 연 경우와 새 탭으로 연 경우 모두 그렇다.
    - 여러 공유 중 하나만 꺼져서 화면의 버전이 빠지면(예: snapshot v1 + live v2에서 live만 해제) `scope {versions}`를 받는다. 화면은 그 버전과 캐시를 버리고 남은 버전을 다시 읽는다.
- 목록:
  - `GET /api/shared-with-me?q=`: 나에게 공유된 것. 검색은 제목과 투영된 메시지 글에서만 찾는다.
  - `GET /api/share-targets`: 공유할 수 있는 가족 계정의 id와 이름(이메일 없음).
- 기존 읽기 경로는 공유받은 사람에게 투영된 것만 준다. 투영 밖은 403이다. 대상 경로: 대화, 메시지, 메시지 버전, 진행 중인 run, run, run 이벤트, 대화의 파일 목록, 파일, 파일 원본, 아티팩트 목록, 아티팩트, 버전, `/a/:id`, raw, download, png, pdf, 출처 목록.
- 쓰기 API는 공유받은 사람에게 모두 403이다. `RunManager`도 주인이 아닌 run을 거부한다.

### 33.3 화면 (최소)
- 사이드바 "👪 가족 공유"(`/shared`)에 세 부분이 있다.
  - "나에게 공유된 것": 검색, 그리고 누가 언제 공유했는지.
  - "가족에게 공유": 대화, live 또는 "이 메시지까지"와 경계 메시지, 가족 전체 또는 계정 체크. 처음에는 아무도 고르지 않은 상태이고, 0명이면 안내가 나오며 저장할 수 없다.
  - "내가 공유한 것": 대상 바꾸기, 공유 끄기, 철회 안내 문구.
- `/shared/:id`는 읽기 전용 공유 화면이다. 답의 아티팩트 카드를 누르면 `/a/:id`가 열린다. live는 5초마다 새로 읽는다. 공유 스트림이 `revoked`로 닫히면 화면이 "공유가 꺼졌거나 더 이상 나에게 공유되지 않아요"로 바뀐다.

### 33.4 DB (0026 마이그레이션)
0024는 #107, 0025는 #116이 쓴다. 이 셋을 합칠 때는 `_journal.json`의 순서를 0024 → 0025 → 0026으로 맞춘다. `when`은 이 순서로 커진다.
- `shares`: 항목 종류·id, 주인, 대화, `audience`, `mode`, 경계 메시지, `created_at`·`updated_at`·`revoked_at`.
  - 대화에 외래 키(cascade)가 걸려 있어 대화를 지우면 공유도 지워지고, 열린 공유 스트림은 닫힌다.
- `share_targets`: `users` 공유의 고른 계정. 계정을 지우면 함께 지워진다.
- `share_snapshots`: snapshot의 불변 목록. 행 종류는 다음과 같다.
  - `message`: id, revision
  - `file`: id, sha256
  - `artifact_version`: 아티팩트 id, 버전
  - `citation`: id, 구절 해시
  - `source`: id, 본문 해시
  - 트리거가 UPDATE를 거부한다.
- 세 표의 글 칸은 모두 id·고정 값·해시뿐이라 비밀 가림이 필요 없다(`secrets/columns.ts`에 분류). 공유된 글은 원래 행에서 읽고, 원래 행은 지금처럼 저장·응답할 때 가려진다.

### 33.5 확인 방법
- `pnpm vitest run apps/server/test/shares.test.ts`. 다음을 확인한다.
  - snapshot 403: 경계 뒤 메시지; 공유 전에 경계 뒤 메시지로 올린 파일, 만든 v2, 인용한 출처; 되돌리기 사본; 공유 후 업로드·새 버전·수정본.
  - 같은 데이터로 조회·raw·다운로드·내보내기·검색·`bundle`(포크·내보내기 입력)이 투영과 같은지.
  - live의 새 메시지, reasoning·원본 결과 제외(API와 SSE).
  - 해제·대상 변경 직후 모든 URL 403과 열린 SSE 종료.
  - 이메일 거부, 쓰기·run·MCP 거부, 아티팩트 공유.
- `apps/server/test/permissions.test.ts`: 권한 행렬. 모든 리소스 경로에 "shared"(live 공유 대상) 열이 있고, 새 공유 경로 9개의 행이 있다.
- `E2E_PORT=3121 pnpm e2e e2e/shares.spec.ts`(데스크톱·모바일, 프로젝트마다 새 계정): `/shared`에서 공유하고, 공유받은 사람이 읽기 전용으로 열고, 쓰기는 403이다. 공유를 끄면 열린 화면이 바로 닫히고 URL이 403이다. snapshot 경계와 이메일 거부도 확인한다.

## 34. HWP·HWPX 추출 — 표·문단 위치, 암호·배포용 거부 (#23)
PRD FR-4.4, 수용 기준 2. 방식·후보 비교·한계는 `docs/decisions/hwp.md`. 파이프라인(샌드박스 작업자, 저장, 비밀 가림, 도구)은 26절 그대로다.

### 34.1 무엇을 하나
- 올린 한글 파일을 다른 형식처럼 백그라운드에서 읽는다. **HWP 5.0**(바이너리)과 **HWPX**(XML) 모두 직접 파싱한다 — 새 패키지도, 설치할 프로그램(한컴오피스·LibreOffice·Python)도 없다.
- 인용 위치(쪽 정보가 파일에 없으므로 쪽은 없다):
  - 본문 문단: "과제안내.hwp · 12번째 문단"(문서 전체에서 비지 않은 문단을 1부터).
  - 표: "과제안내.hwp · 3번째 표 · 2행"(본문에 바로 든 표를 1부터, 행 하나가 단위, 칸까지 맞으면 "· 2열"). 병합 셀은 첫 행·첫 열에 한 번 나온다.
  - 단위는 읽는 순서대로 나온다. 문단 안의 각주·표·빠지는 부분 앞뒤로 문단이 나뉘며, 나뉜 조각의 인용에는 글자 범위가 없다(문단 번호는 같다).
  - 각주·미주: "· 2번째 문단 · 각주 1", "· 1번째 표 · 3행 · 각주 2", "· 미주 1" — 번호는 문서가 저장한 번호(없으면 번호 없이 붙은 자리만).
  - 셀 주소·병합이 표 크기와 맞지 않는 표(손상·이상한 작성기)는 "· 3번째 표"까지만(행·열을 주장하지 않음).
  - 표 안의 표·글상자·표 캡션의 글은 그것을 담은 칸·문단의 그 자리에 붙는다. 머리말·꼬리말·숨은 설명은 저장하지 않는다. 서버는 그 글을 남기는 글과 함께 읽는 순서대로 알려진 비밀로 가린 뒤 버린다. 그래서 둘에 나뉜 비밀도 한 값으로 가려진다(결정 기록 "비밀 가림"). 그 옆 단위는 틈이 있는 단위로 저장된다. 비밀이 새로 등록되면 그 파일은 다시 추출된다(그동안 `pending`). HWPX `hp:switch`는 `default`만 읽는다. switch·default는 투명해서, 그 안의 글은 바깥의 칸·각주·머리말에 그대로 속한다. `case`(다른 프로그램용 대체 내용)는 읽지도 저장하지도 않는다. 비밀의 일부가 `case`에만 있는 경우는 그림 속 글자처럼 범위 밖이다(결정 기록 "대체 내용").
- **읽지 않는 문서**(파일은 저장되고 보낼 수 있다, 글자는 없음): 암호·DRM·공인인증서 암호화 HWP, 암호 HWPX → `extract_encrypted`("암호가 걸린 파일이라 읽을 수 없어요"); 배포용(편집 제한) HWP → `extract_distribution`("배포용(편집 제한) 문서라 읽을 수 없어요"); HWP 5가 아닌 버전 → `extract_unsupported`. 첨부 칩이 올린 직후 그 문구를 보여 주고(추출이 끝날 때까지 1초부터 최대 15초 간격으로 계속 읽음 — 새로고침한 뒤 되살아난 칩도), 모델도 같은 코드·문구를 받는다.
- 거부(26절과 같은 원칙): zlib 폭탄(구역당 풀린 크기 64MB·합계 256MB → `extract_too_large`), 순환하거나 파일 밖을 가리키는 섹터 체인·디렉터리, 스트림 밖 레코드(`extract_invalid`), HWPX의 DTD(`extract_xml_forbidden`), 패키지 밖 경로(`extract_path_escape`), 깨진 ZIP(`extract_zip_invalid`).
- 추출기 버전이 `extract-11`이 되어, 이 버전으로 처음 시작할 때 **모든 파일을 다시 뽑는다**(파일 수만큼 시간이 걸리고, 그동안 해당 파일은 `pending`). 지금까지 `extract_unsupported`였던 HWP·HWPX가 이때 읽힌다. DB 마이그레이션은 없다.

### 34.2 확인
- 시험: `pnpm test apps/server/test/hwp.test.ts`(fixture별 기대 단위·locator — 두 형식에 같은 기대값, 빼는 구조(머리말·꼬리말·숨은 설명)마다 읽는 순서의 그 자리에 숨은 단위(앞·뒤·각주 앞·표 앞 × 종류 × 두 형식), 숨은 글 한도, 저장된 각주 번호, 표 크기와 맞지 않는 셀 주소, 암호·배포용·속성 비트별 거부, zlib 폭탄의 `maxOutputLength`, CFB 손상·순환, 레코드 크기·중첩, HWPX DTD·경로 탈출, 한도에서 `truncated`·`endsEarly`, macOS 샌드박스 실행), `apps/server/test/file-tools.test.ts`의 HWP 묶음(업로드 → 추출 → API, `file_read`·`file_cite` 라벨과 답의 인용 노트 "sample.hwp · 1번째 표 · 3행 · 3열", 암호·배포용 고정 코드, HWPX 표 칸·각주의 비밀 가림, 빼는 구조 × 앞·뒤·각주 앞·표 앞 24가지에서 비밀의 어느 쪽도 DB·API·`file_read`에 없음 — 나중에 등록한 비밀은 다시 추출로, 나뉜 문단의 두 구절 인용은 글자 범위 없이 같은 문단), `apps/web/test/extract-watch.test.ts`(칩 문구), `apps/server/test/instructions.test.ts`(INJ-4가 HWP를 추출한 글로 돈다).
- fixture 다시 만들기: `python3 -I fixtures/extract/make-hwp-fixtures.py`(표준 라이브러리만, 같은 바이트가 나온다). `fixtures/acceptance/injection/doc-injection.hwp`도 함께 `doc-injection.md`에서 만든다.
- 손으로: 한글로 표·각주가 있는 문서를 HWP와 HWPX로 각각 저장해 올리고 "표 내용 정리해줘" → 답의 출처가 "… · N번째 표 · R행"으로 붙는지. 같은 문서를 "배포용 문서로 저장"·"문서 암호"로 저장해 올리면 칩에 바로 "… 읽을 수 없어요"가 나오는지.

### 34.3 받아들인 한계
- fixture는 형식 문서대로 직접 쓴 파일이다. 한글이 만든 실제 파일에서 다르게 보이는 점이 있으면 알려 달라(`file.extracted`의 `extractCode`가 `extract_invalid`인 HWP — 파일 내용은 로그에 남지 않는다).
- HWPX 배포용은 별도 표식을 확인하지 못해, 걸리더라도 `extract_encrypted`로 나온다.
- **실제 한글이 만든 파일과의 호환성은 아직 확인하지 않았다** — 34.2의 손 확인이 그 확인이다. 쪽 번호는 없다(안정적인 쪽 매핑을 구현하지 않음).
- 주입 평가 INJ-4(`pnpm -s injection-eval`)는 HWP를 샌드박스 추출기로 읽는다 — macOS가 아닌 곳에서는 그 사례가 `error`(`material_unavailable`)로 나온다(통과로 치지 않음).

## 35. 계산·데이터 가공 도구 — python_run (#47)
PRD §7 `python-scratchpad`, NFR 격리. 방식과 근거는 `docs/decisions/isolation.md` "계산 도구 python_run (#47)".

### 35.1 무엇을 하나
- 공통 MCP 도구 `python_run {code, files?}` — 두 런타임 모두 같은 도구(`mcp__agentlee__python_run`). 사용자별 허용은 스킬 이름 `python-scratchpad`(§15.4, 금융 스킬 아님). 서버 허용 스위치(§20)로 끌 수 있다. 예약(#56)의 스킬 범위에 없으면 그 실행에서는 빠진다.
- **전용 계정으로만 실행, 기본 꺼짐(`PYTHON_RUN`·`PYTHON_RUN_USER` — 리뷰 #121 1·2차):** macOS 샌드박스는 **같은 UID**의 다른 프로세스 시작 환경을 `KERN_PROCARGS2`로 읽는 것을 막지 못한다(§35.3). 그래서 python 코드는 서버와 **다른 UID**의 전용·비권한 계정으로 돌린다 — 그러면 서버·런타임의 환경에 닿지 못한다. `PYTHON_RUN=1`은 `PYTHON_RUN_USER`(그 계정)가 설정되고, 루트 소유 런처가 설치돼 있고, **시작 자가 검사**(권위 있는 검사, `python/selfcheck.ts` — 리뷰 #121 7·8차)가 이 기계에서 그 계정으로 다음을 모두 통과해야만 켜진다. (1) 런처 `probe`: 자식이 서버와 다른 UID이고, 그 샌드박스 안에서 서버 UID 형제 프로세스의 `KERN_PROCARGS2`를 못 읽음. 출력은 **정확히 한 줄** `uid=<u32> procargs=<blocked|readable|error control|error sibling|error marker|error errno=<n>>`(#130 1차부터 `kern.argmax` 크기 버퍼로 실제로 읽는다 — 자기 표식 `AGENTLEE_PROBE_SELF=1`이 양성 대조, "readable"은 형제 표식 `AGENTLEE_SELFCHECK=`가 실제로 보일 때만; 판정 규칙은 §41.1과 같다)이고 종료 코드 0이어야 한다 — 앞뒤 글자·두 번째 판정·빈 줄·비정상 종료는 모두 거부. (2) **실제 작업을 보통 경로 그대로**: 같은 작업 폴더 생성(`.tmp` 포함), 호출과 똑같이 만든 서버 소유 0600 입력 복사본, 같은 실행기(`sudo … launcher run` — 그 계정으로 런처 신뢰 검사, `.ctl`·실행 기록·stdin 준비, 고정 환경 `HOME`·`TMPDIR`·스레드 제한, 메모리·시간 감시, 샌드박스 프로필). 고정 스크립트가 그 입력을 pandas로 읽고 numpy·pandas를 설정된 패키지에서 import해 출력 파일을 쓴다. 서버는 그 출력을 실제 호출과 같은 수집 함수로 읽고(내용 확인), 그 파일의 소유자가 그 계정인지 확인한 뒤, 런처 `clean`으로 정리한다. 어느 단계든 실패하면 — 예외를 던져도(예: 잘못된 `TMPDIR`) — 실패한 단계 이름(`probe`·`workdir`·`input`·`run`·`report`·`output`·`cleanup`)과 함께 도구가 꺼진다(`needs_account`). 정리(임시 폴더·런처 `clean`·작업 폴더)는 단계마다 따로 시도하고 실패는 `python.self_check_cleanup_failed`로 남길 뿐 던지지 않는다(작업 폴더가 남으면 검사 실패). **자가 검사는 서버 시작을 막지 않는다**(리뷰 #121 9차): 작업 한도(30초)가 시작 훅 제한(10초)보다 길 수 있으므로, 서버가 준비된 뒤 백그라운드에서 돌고, 끝날 때까지 도구는 없고 상태는 `needs_account`(이유 `checking: …`), 통과한 뒤에야 제공된다. 종료 때는 진행 중인 검사를 **중단**한다(리뷰 #121 10차): 중단 신호가 probe와 작업 실행기에 전달되고(실행기는 기존 reap 경로로 런처 작업을 끝낸다), 그 뒤로는 새 단계가 시작되지 않으며, 서버는 정리(작업 폴더·임시 폴더·런처 `clean`)가 끝날 때까지 최대 10초 기다린 뒤 닫힌다. 중단된 검사는 통과로 치지 않는다(이유 `self-check stopped: shutting down`). **probe도 `run`처럼** 자식을 커널 신원으로 `.ctl/<id>/leader`에 기록한 뒤 풀어 주고 감시하며, 자체 벽시계 제한(8초, 넘으면 종료 코드 124)이 있어 혼자서 오래 남지 못한다(리뷰 #121 11차). 서버는 중단·시간 초과 때 sudo에 신호를 보내지 않고(sudo는 SIGKILL을 전달하지 못하고 계정 쪽 자식이 파이프를 쥐고 있을 수 있다) 런처 `reap <id>`로 그 자식을 끝내고, 자기 쪽 파이프를 닫은 뒤 바로 결과를 내어 정리(형제 프로세스 종료, 런처 `clean`으로 probe 작업 폴더·기록 삭제, 서버 쪽 삭제)가 이어지게 한다. 하나라도 아니면 도구는 **아예 제공되지 않는다**(실패 시 닫힘). 설정은 §35.2.
- 호출마다 새 작업 폴더 `<DATA_DIR>/scratch/<사용자>/<대화>/<호출 id>/`를 만든다. `files`(이 대화의 fileId, 최대 10개)는 저장소의 검사된 열기로 읽어 SHA-256을 확인한 뒤 그 폴더에 파일 이름으로 복사한다. 코드에서는 `FILES["<fileId>"]`가 로컬 이름이다. 다른 사용자·다른 대화·보내지 않은 파일·기록에서 빠진 메시지의 파일·해시가 다른 파일은 모두 `python_file_not_found`.
- 끝나면 작업 폴더의 **새로 생기거나 바뀐** `.csv`·`.txt`·`.md` 파일(최대 5개, 각 10MB, UTF-8)을 대화 파일로 저장한다. 그 run의 답 메시지에 연결되고(§29.2와 같은 규칙) 답 아래 내려받기 칩이 붙는다. 다른 형식·링크(심볼릭·하드링크)·너무 큰 파일·깊은 폴더(3단계 넘게)·숨김 항목(`.`으로 시작, 임시 폴더 `.tmp` 포함)은 저장하지 않고 `skipped[{name, reason}]`로 알린다. 대화당 20개 한도에 걸리면 `conversation_full`. 작업 폴더는 호출이 끝나면 지우고, 서버 시작 때 `scratch/` 전체를 지운다. 호출 사이에 남는 것은 없다 — 다음 호출에 저장된 파일 id를 다시 넘긴다.
- 결과: `{status: "ok"|"error", exitCode, stdout, stdoutTruncated, stdoutChars, stderr, stderrTruncated, error?: {type, traceback}, files, skipped, outputFile?}`. 코드가 예외를 내거나 0이 아닌 코드로 끝나면 도구 오류가 아니라 `status: "error"`(모델이 고칠 수 있게). stdout은 앞 8,000자, stderr·traceback은 끝 4,000자. 잘린 stdout은 interpreter가 보관한 전체(최대 20만 자)를 `python-output.txt` 대화 파일(`outputFile`)로 저장한다. stdout·stderr·traceback은 `<external_content>` 블록에 담긴다(파일에서 온 글일 수 있음). 작업 폴더 경로는 `.`, 패키지 폴더는 `<packages>`, python 설치 폴더는 `<python>`, 데이터 폴더는 `<data>`로 바꿔 보인다.

### 35.2 설치 (한 번 — 관리자, `sudo` 필요)
런처는 호출자(서버)가 준 경로를 믿지 않는다. 작업(run/probe/reap/clean/verify)과 **작업 id(UUID)**만 받고, 인터프리터·runner.py·패키지·scratch는 **루트 소유 설정 파일**에서 읽는다. 그래서 런처·설정·runner·인터프리터 트리·패키지 트리는 모두 **루트 소유, 비(非)루트 변경 불가**여야 한다. 런처는 실행마다 (1) 각 경로의 **조상 전체**(`/`까지 — 루트 소유, 그룹·기타 쓰기 없음, 심볼릭 링크 없음, 쓰기 계열 ACL 허용 항목 없음)와 (2) 두 트리의 **모든 노드**(lstat로 소유자·모드, 트리마다 한 번 엄격 파싱한 `ls -leRA`로 모든 ACL 항목 — 노드 수까지 대조)를 확인하고, 하나라도 아니거나 stat·opendir·ls가 실패하면 거부한다. 거부되는 ACL 허용 권한: `write`·`delete`·`append`·`writeattr`·`writeextattr`·`writesecurity`·`chown`·`add_file`·`add_subdirectory`·`delete_child`(누구에게든). `deny` 항목은 괜찮다(예: 홈의 `group:everyone deny delete`). 홈 아래 uv 경로는 전용 계정이 통과하지 못하므로, 프로그램 일체를 루트 소유 위치로 복사한다.

먼저 인터프리터와 패키지(서버용, `pnpm python:install`), 그 다음 루트 소유 복사:
```
uv python install 3.12
uv python find 3.12            # 출력된 경로를 .env의 SKILL_PYTHON=에 넣는다 (python 스킬과 같은 값, §15.1)
pnpm python:install            # requirements.lock의 패키지를 <DATA_DIR>/python-packages/<lock 해시>-py3.12/에 설치

# 루트 소유 프로그램 트리 (전용 계정이 읽기만, 아무도 못 고침). uv 인터프리터 경로는 심볼릭 링크일 수 있으니
# 실제 경로를 풀어(`python -c base_prefix`) 독립 트리로 복사한다(`ditto`는 링크를 따라 복사). 재설치 시 중첩을
# 막으려 먼저 지운다. 루트 소유 디렉터리 안이면 전용 계정이 내용을 못 바꾼다.
sudo rm -rf /usr/local/lib/agentlee-python
sudo mkdir -p /usr/local/lib/agentlee-python /usr/local/etc /usr/local/libexec
REAL_PY="$("$(uv python find 3.12)" -c 'import sys;print(sys.base_prefix)')"
sudo ditto "$REAL_PY" /usr/local/lib/agentlee-python/interpreter
sudo ditto "$(ls -d <DATA_DIR>/python-packages/*-py3.12)" /usr/local/lib/agentlee-python/packages
sudo cp apps/server/scratchpad/runner.py /usr/local/lib/agentlee-python/runner.py
sudo chown -R root:wheel /usr/local/lib/agentlee-python
sudo chmod -R -N /usr/local/lib/agentlee-python          # ditto가 보존한 ACL을 모두 지운다(런처는 쓰기 ACL이 하나라도 있으면 거부)
sudo chmod -R a+rX,go-w /usr/local/lib/agentlee-python   # 루트만 쓰기, 모두 읽기·검색(a+rX)
```
전용 계정·런처·설정·sudoers·scratch(모두 `sudo`, 서버는 하지 않는다 — 관리자가 한 번):
```
# 1) 숨은 비권한 계정 (로그인 불가, 홈 없음). 짧은 이름 예: _agentleepy, .env의 PYTHON_RUN_USER=에 넣는다.
#    서버 계정과 다른 UID여야 한다.
sudo sysadminctl -addUser _agentleepy -fullName "Agent Lee python_run" -home /var/empty -shell /usr/bin/false
sudo dscl . -create /Users/_agentleepy IsHidden 1

# 2) 런처: ops/python/agentlee-python-run 를 고정 경로에 루트 소유로 설치
sudo install -o root -g wheel -m 0755 ops/python/agentlee-python-run /usr/local/libexec/agentlee-python-run
sudo chmod -N /usr/local/libexec/agentlee-python-run

# 3) 설정: 런처가 읽는 루트 소유 파일. 값은 모두 루트 소유 경로여야 한다(런처가 재확인).
#    형식은 정확히: `키=값` 네 줄(interpreter·runner·packages·scratch), 각 한 번. 공백·주석·빈 줄·다른 키·중복 키는
#    거부된다(앞뒤 공백도 다듬지 않는다). 경로는 실제(정규) 경로 — 심볼릭 링크 성분·`//`·끝 `/` 금지.
sudo tee /usr/local/etc/agentlee-python.conf >/dev/null <<CONF
interpreter=/usr/local/lib/agentlee-python/interpreter
runner=/usr/local/lib/agentlee-python/runner.py
packages=/usr/local/lib/agentlee-python/packages
scratch=<DATA_DIR>/scratch
CONF
sudo chown root:wheel /usr/local/etc/agentlee-python.conf
sudo chmod 0644 /usr/local/etc/agentlee-python.conf
sudo chmod -N /usr/local/etc/agentlee-python.conf

# 4) sudoers: 서버 계정이 그 런처만, 그 계정으로만, 암호 없이 (visudo -f 로 편집)
sudo visudo -f /etc/sudoers.d/agentlee-python
#   내용 한 줄 (서버 계정이 'agentlee'라고 가정):
#   agentlee ALL=(_agentleepy) NOPASSWD: /usr/local/libexec/agentlee-python-run

# 5) scratch 교환: 전용 그룹 + 상속 ACL로, 그 계정이 자기 작업 폴더만 쓰고 서버는 결과를 읽게 한다.
sudo dseditgroup -o create agentleepy-scratch
sudo dseditgroup -o edit -a _agentleepy -t user agentleepy-scratch
sudo dseditgroup -o edit -a agentlee    -t user agentleepy-scratch
mkdir -p <DATA_DIR>/scratch
sudo chgrp agentleepy-scratch <DATA_DIR>/scratch
sudo chmod 070 <DATA_DIR>/scratch     # 그룹만 (서버·계정)
sudo /bin/chmod +a "group:agentleepy-scratch allow list,add_file,add_subdirectory,delete_child,search,readattr,writeattr,file_inherit,directory_inherit" <DATA_DIR>/scratch
# 6) 계정이 scratch까지 **통과(search, o+x)**할 수 있어야 한다. DATA_DIR과 그 위 조상이 0700이면 막힌다:
#    조상에 전용 계정(또는 그룹)의 search ACL만 더한다(읽기 금지). 예:
sudo /bin/chmod +a "group:agentleepy-scratch allow search" <DATA_DIR>
#    홈(예: /Users/agentlee, 보통 0750)처럼 막힌 조상이 더 있으면 그 각각에도 같은 search 항목을 더한다.
#    어느 조상이 막혔는지는 `pnpm python:setup-check`의 "scratch traversal" 줄이 알려 준다(그 계정·그 그룹의 search만 센다).
#    DATA_DIR의 다른 내용(파일·DB·대화 폴더)에는 읽기 권한을 주지 않는다 — scratch만.
```
확인:
```
pnpm python:setup-check        # sudo 없이 진단만: 런처의 읽기 전용 `verify <계정>`을 직접 실행(run과 같은 신뢰 검사 —
                               # 조상·트리 전체·ACL·설정 형식, + 계정의 scratch 통과·쓰기) + scratch == DATA_DIR/scratch
pnpm python:check              # 권위 있는 검사: 서버 시작 때와 같은 자가 검사(probe + 실제 작업 한 번) + 샌드박스에서 numpy·pandas, 합계 5050, "network: blocked"
pnpm skills:status             # python_run: available | disabled | needs_python | not_installed | needs_account
# 전용 계정 교차 UID 시험(런처·sudoers·ACL 설치 후):
TEST_PYTHON_RUN_USER=_agentleepy TEST_PYTHON_PACKAGES=$(ls -d <DATA_DIR>/python-packages/*-py3.12) \
  pnpm vitest run apps/server/test/python.test.ts
```
- `pnpm python:check`가 `account self-check: ok (uid <계정 uid>, KERN_PROCARGS2 blocked; a real job read its input, imported numpy + pandas and wrote its output)`를 찍어야 한다. 그 뒤 서버를 다시 시작한다(자가 검사는 **시작 때 한 번** 돌고 결과를 기억 — 계정·런처·설정·sudoers를 바꾸면 재시작).
- 패키지는 시스템이나 python 자체에 설치하지 않는다. `pip --target`으로 데이터 폴더 안에만 설치하고(그 뒤 루트 위치로 복사), 네트워크(PyPI)는 `pnpm python:install`만 쓴다. 버전·해시 고정(`--require-hashes --no-deps --only-binary=:all:`).
- 고정 패키지(`apps/server/scratchpad/requirements.lock`, 2026-11-13 기준 배포 2주 넘음): numpy 2.5.4(2026-10-10), pandas 3.1.0(2026-10-22), python-dateutil 2.9.0.post0, six 1.17.0, tzdata 2026.5. macOS arm64 CPython 3.12 휠만.
- **격리 메모:** scratch의 ACL은 **모든 작업 폴더에 상속**된다(서버·계정이 어느 작업 폴더든 접근). 그래서 작업(대화) 사이 격리는 이 ACL이 아니라 **작업마다 다른 샌드박스 프로필**(그 작업 폴더만 허용)에 달려 있다.
- lock을 바꾸면 폴더 이름이 바뀐다 → `pnpm python:install` 재실행 후 루트 위치로 다시 복사. 옛 폴더는 남으니 필요하면 지운다(읽기 전용이면 `chmod -R u+w` 뒤).
- 상태(관리자 스킬 탭·`GET /api/admin/skills`의 `python-scratchpad`): `available`, `disabled`(`PYTHON_RUN`≠1), `needs_python`(SKILL_PYTHON 문제), `not_installed`(패키지 폴더 없음), `needs_account`(`PYTHON_RUN_USER` 없음 또는 자가 검사 실패). `available`이 아니면 도구는 제공되지 않는다.
- **운영 런처에는 우회 분기가 없다**(리뷰 #121 4·5차): 설정 경로·소유자 검사·메모리 한도는 고정 상수(`CONF_PATH`·`OWNER_ALLOW_SELF=0`·`MEM_LIMIT_KB=786432`)이고 이를 바꾸는 환경 변수도 없다(시작하자마자 `%ENV` 전체를 `PATH`·`LC_ALL`만으로 교체 — 모든 작업). 프로젝트 시험은 **별도 사본**(이 세 상수 줄만 치환 — 시험이 차이가 정확히 그 줄들인지 확인)을 만들어 자기 계정에서 돌린다 — 운영 바이트에는 그 분기가 없고, 시험이 그 사실(우회 문자열·`setrlimit`·`comm=` 부재, 셸 없음)을 확인한다.
- **`verify <계정>`은 참고용(advisory)이다**(리뷰 #121 7차): ACL의 일부 경우(예: 일반 파일의 `only_inherit` 표시, 대상 계정의 `readsecurity` 거부 — 후속 이슈)를 놓칠 수 있다. **권위 있는 판정은 그 계정으로 도는 자가 검사**(서버 시작 때, `pnpm python:check`)이고, 그것이 실패하면 verify가 통과해도 도구는 꺼진 채다. 출력 첫 줄이 `advisory …`로 이를 알리고, `pnpm python:check`는 자가 검사가 실패했는데 verify는 통과하면 그 불일치를 분명히 출력한다. uid·gid는 도구마다 표기가 달라(`dsmemberutil`은 nobody를 `-2`, `getpwnam`·`id`는 `4294967294`) 모두 범위를 확인한 뒤 부호 없는 32비트로 맞춰 비교한다.
- **`verify <계정>`**(리뷰 #121 5차): sudo 없이 서버 계정으로 직접 실행하는 읽기 전용 작업. 설정을 읽고 `run`과 **같은 검사 목록**을 돌려 `check <이름> ok|fail <이유>`·`scratch <경로>`·`result ok|fail` 줄로 보고한다(종료 0/1). 접근 판정은 **진단을 돌린 서버 계정이 아니라 대상 계정** 기준이다(리뷰 #121 6차): 런처는 sudo 뒤 그 계정으로 돌며 런처 자신·설정·runner·인터프리터·패키지를 연다. 그래서 `check account program access`가 그 경로들의 모든 조상 `search`, 런처 `read`·`execute`, 설정·runner `read`, 인터프리터 `read`·`execute`, 두 트리의 모든 디렉터리 `search`·`list`와 모든 파일 `read`를 그 계정으로 평가한다(트리 검사 때 본 노드 목록을 쓰고, 목록에 ACL 줄이 있던 디렉터리의 노드만 `ls -led`로 다시 읽는다). `check scratch traversal`·`check scratch write`는 scratch까지의 `search`와 scratch의 `add_subdirectory`. 평가 규칙: ACL 항목을 순서대로 보며 그 권한을 명시하고 그 계정에 해당하는 **첫 항목**이 결정(`deny`면 막힘). `only_inherit` 항목은 자식에게만 적용되므로 그 노드 판정에서는 건너뛴다. 주체는 `user:`/`group:` 뒤의 이름·숫자 id, 또는 이름을 못 찾을 때 `ls`가 출력하는 **UUID**(접두어가 있거나 없거나) — UUID는 `dsmemberutil getid -X`로 uid/gid로 바꿔 그 계정·그 그룹(`id -G`)과 비교하고, **해석하지 못하는 주체는 무관이 아니라 진단 실패**다(그 권한을 명시한 항목일 때). ACL이 결정하지 않으면 소유자 → 그룹 → 기타 중 그 계정이 속하는 **하나의** 클래스의 POSIX 비트(아래 클래스로 넘어가지 않음). `pnpm python:setup-check`는 자기 규칙 없이 이 보고만 쓴다(실패 시 닫음 — 이해 못 하는 줄·검사 0개·`result ok` 없음이면 실패). 통과해도 참고일 뿐이며 다음 단계는 `pnpm python:check`.

### 35.3 격리와 한도 (`PYTHON_LIMITS`, `packages/shared/src/python.ts`)
- **전용 계정으로 실행(리뷰 #121 2·3·4차):** 운영에서 서버는 샌드박스를 직접 띄우지 않는다. `sudo -n -u <계정> /usr/local/libexec/agentlee-python-run run <작업 id> <시간제한>`만 띄운다 — **인터프리터·runner·패키지·scratch는 호출자가 주지 않고 런처(Perl, `perl -T`)가 루트 소유 설정(`/usr/local/etc/agentlee-python.conf`)에서 읽는다.** 런처·설정·runner의 **조상 전체**와 인터프리터·패키지 **트리의 모든 노드**가 루트 소유·비루트 쓰기 불가이고 쓰기 계열 ACL 허용 항목이 없는지 확인하고(§35.2), 아니면 거부한다. `reap`·`clean`은 프로그램을 실행하지 않으므로 런처·설정·runner의 조상 검사까지만 한다. 작업 id는 **정확한 UUID 패턴**(개행·NUL 등 거부, 다중 행 주입 불가)이고 SBPL에 넣는 모든 경로는 안전 문자만 통과시킨 값이다. 작업 폴더는 `<scratch>/<id>`(심볼릭 성분 거부). 런처가 그 계정으로 내려가 자식을 **세션 리더로 만든 뒤**(`setsid`) **스스로 프로필을 만들어** `sandbox-exec` + python을 exec한다. run-control은 샌드박스가 쓸 수 없는 `<scratch>/.ctl/<id>/leader`에 `pid uid 시작초 시작µs`로 적는다 — 값은 **커널**(`sysctl(KERN_PROC, KERN_PROC_PID, pid)`의 `kinfo_proc`: 실·유효 uid, `p_starttime`)에서 읽고(argv와 무관 — python이 `argv[0]`을 바꿔도 그대로), 자식은 이 기록이 원자적으로(임시 파일→rename) 써진 **뒤에야** 파이프로 풀려나 python을 exec한다(런처가 먼저 죽으면 EOF → 실행 안 함). 시간 초과·중단 시 런처의 `reap`(sudo)은 기록의 uid가 자신(그 계정)이고, 지금 그 pid의 커널 uid·시작 시각(µs까지)이 기록과 같을 때만 그 pid와 그 그룹(런처가 세션 리더로 만들었으므로 pgid = 그 pid)을 죽인다. 기록이 없거나·못 읽거나·형식이 다르거나·신원이 다르거나(pid 재사용)·커널 조회 자체가 실패하면 **거부**(종료 65, 이유 출력 — 아무것도 확인하지 못했으니 죽이지도 않음)하고, 커널이 "그런 프로세스 없음"(빈 응답)이라고 할 때만 할 일 없이 0. 서버는 reap이 0이 아니면 그 실행이 아직 열려 있는 동안 0.5초 간격으로 최대 3번 다시 부르고(`REAP_RETRIES` — 예: 기록 직전의 경합), 그래도 안 되면 런처 자신의 벽시계 제한이 끝낸다. 이전의 `ps -o comm=`(= argv[0], 사용자 변경 가능)·초 단위 `lstart`·기록 없으면 검사 면제는 모두 없앴다. 런처 자신도 **250ms마다** 자식의 벽시계 시간과 **상주 메모리**(`ps -o rss=`)를 본다(자식 종료는 SIGCHLD로 바로 깨어남 — 빠른 작업이 지연되지 않음). 시간 초과면 SIGKILL 후 **종료 코드 124**와 `.ctl/<id>/status=timeout`(→ `python_timeout`), 메모리가 768MB를 넘거나 **잴 수 없으면**(자식이 아직 살아 있는데 `ps` 실패) SIGKILL 후 **종료 코드 125**와 `status=memory`/`memory-unmeasured`(→ `python_memory_limit`). 감시 실패를 묵살하지 않는다(4차의 `POSIX::setrlimit`은 `/usr/bin/perl` 5.34에 없어 조용히 실패했다). 남는 한계: 코드가 `os._exit(124|125)`로 끝나면 같은 코드로 분류된다(그래도 실패 코드일 뿐 결과가 새지는 않는다). 작업 폴더 정리는 런처 `clean`(그 계정)으로 하고 서버가 뒤를 받친다. 어떤 폴더·어떤 파일인지는 여전히 서버가 정한다.

- **파일 플래그 변경 금지(`noFlagChanges`, 리뷰 #121 1차):** 프로필에 `(deny file-write-flags)`를 더해 `chflags`(예: `uchg`)를 막는다. **권한 변경(`chmod`)은 허용**한다 — `file-write-mode`까지 막으면 `shutil.copy`/`copytree` 등이 깨지기 때문이다(리뷰 #121 4차). 코드가 작업 폴더 모드를 0으로 만들어도 정리는 런처 `clean`(그 계정)이 위에서 아래로 모드를 복구하며 지우고, 못 지우면 실패를 돌려준다. 서버의 `removeTree`가 뒤를 받치고, 시작 sweep 실패는 서버 시작을 막지 않는다(`python.sweep_failed` 경고만).
- **작업 폴더 측정은 실패 시 닫는다(리뷰 #121 1차):** 200ms마다 재는 중 어떤 폴더·항목을 **읽지 못하면**(코드가 권한을 없앰) 측정이 불완전하므로 그 실행을 `python_workdir_blocked`로 멈춘다(예전에는 못 읽는 폴더를 빈 것으로 세어 한도를 우회할 수 있었다). 측정이 예외를 던져도(읽은 뒤 삭제·권한 변경 경합) 타이머 콜백에서 잡아 그 실행만 멈춘다 — 서버는 영향받지 않는다.
- **샌드박스 밖 실행 경로는 없다.** `ISOLATION_IN_PROCESS_FOR_TESTS`·`FAKE_RUNTIME`도 바꾸지 않는다. macOS가 아니거나 샌드박스를 못 띄우면 `python_unavailable`. 단위 시험은 실행기를 직접 넣는다(`buildApp({ python: { runner, state } })`).
- **KERN_PROCARGS2 — 왜 다른 UID인가(리뷰 #121 1·2차):** `system.sb`가 모든 `sysctl-read`를 허용하고, macOS는 **같은 UID**의 다른 프로세스에 대해 `KERN_PROCARGS2`로 그 프로세스의 인자와 **시작 시 환경 변수**를 돌려준다. 같은 UID로 돌리면 python 코드가 서버·런타임의 환경을 읽을 수 있다(1차에서 실기 확인). sysctl 이름 규칙으로는 분리되지 않았다(`(deny sysctl-read)`는 numpy `os.uname()`을 깨고, `hw.`·`kern.ostype` 허용 목록으로도 procargs가 다시 열렸다 — macOS 27.0). 그래서 2차 결정대로 **다른 UID의 전용 계정**으로 돌린다: XNU는 다른 UID·비권한 프로세스에는 대상의 procargs를 주지 않는다. 시작 자가 검사가 바로 이것을 증명하고(다른 uid + 읽기 차단), 증명 못 하면 도구는 꺼진다. 노출 대상 정정: Claude는 API 키·OAuth 토큰을 **시작 환경**에 둔다(`runtime/claude.ts`), Codex는 자격 증명을 **stdin RPC**로 주고 환경에는 MCP bearer 토큰만 둔다(`runtime/codex.ts`·`runtime/lockdown.ts`). python_run 출력은 가림·등록 비밀 검사를 거치지만, 손상된 작업자가 임의 변환·분할로 정보를 돌려보낼 수 있으므로 가림이 격리 경계는 아니다 — 경계는 UID 분리다.
- 한도: 30초(벽시계) + CPU 30초(`RLIMIT_CPU`), 메모리 768MB(250ms마다 측정 — 운영은 런처가, 시험용 같은 UID 경로는 서버가), 파일 하나 20MB(`RLIMIT_FSIZE` — 넘는 쓰기는 python 안에서 `OSError`), 작업 폴더는 입력 복사본 + 100MB·항목 1,000개(200ms마다 측정, 넘으면 종료), stdout·stderr 각 20만 자 보관(나머지는 개수만), 프로세스 출력 약 2.6MB, 코드 5만 자, 입력 파일 10개·합 100MB.
- 동시 실행: 서버 전체 2개, 사용자당 1개(`PYTHON_SLOTS`) — 넘으면 바로 `python_busy`(대기열 없음). 스킬과 같은 MCP 슬롯(전체 4, run당 2)도 함께 쓴다.

### 35.4 비밀
- 알려진 비밀(§1, 라운드 23–27)은 돌아오는 모든 것에서 가린다: stdout·stderr·traceback은 **전체를 먼저 가린 뒤 자른다**(가림의 꼬리 규칙이 interpreter의 20만 자 보관 한도에서 잘린 비밀의 앞부분도 가린다 — 8자 이상이면). 원문·JSON/파이썬 이스케이프·퍼센트·base64·hex 형태 모두(§1). 저장하는 텍스트 파일 내용과 이름도 저장 전에 가린다. 결과 전체를 마지막으로 한 번 더 가린다.
- 그래서 저장 형식을 텍스트(CSV·TXT·MD)로 제한했다 — XLSX·PNG 같은 이진 형식은 서버가 그 안의 비밀을 볼 수 없다.
- 남는 한계: 저장한 뒤 등록된 비밀은 이미 저장된 파일 바이트에서 지우지 않는다(업로드·생성 문서와 같은 원칙, §24.2·§29.4). 코드가 비밀을 쪼개 여러 파일에 나눠 쓰면 각각은 잡지 못한다.

### 35.5 오류 코드와 로그
- 도구 오류(`{ error }`, 로그 `pythonCode`): `python_not_allowed`(권한·범위 — 대화 주인이 아님, run이 그 대화 것이 아님), `python_bad_input`, `python_file_not_found`, `python_files_too_large`, `python_busy`, `python_timeout`(벽시계·CPU), `python_memory_limit`, `python_output_limit`, `python_disk_limit`, `python_workdir_blocked`(작업 폴더를 재지 못함 — 코드가 일부를 못 읽게 만듦, 닫음), `python_failed`(보고가 깨짐 — `os._exit` 등), `python_unavailable`(샌드박스 없음), `python_not_installed`(§35.2). 끝까지 돈 호출은 로그에 `python_ok` 또는 `python_error`(코드가 예외).
- 로그: `python.finished`(도구 이름, `pythonCode`, 소요 시간, 사용자·대화·run ID). **코드·출력·파일 id·파일 이름은 남기지 않는다**(시험). 실패는 관리자 "최근 오류"에 도구 이름과 코드로 남는다.

### 35.6 확인 방법
- `pnpm vitest run apps/server/test/python.test.ts` — 도구·권한(목록에서 빠지면 호출 불가, 예약 범위, **기본 꺼짐**, 전용 계정 게이트 — `available`일 때만 제공), 런처 sudo 명령·인자 검증·작업 폴더 범위, 자가 검사 논리(주입 프로브: 다른 uid + 읽기 차단일 때만 통과), 과잉 가림 없음(온전한 텍스트의 `tail:false`, 캡처에서 잘린 꼬리만 꼬리 규칙), 측정 실패·경합 시 그 실행만 멈춤, 입력 거절, 상태 코드, 실행 경로(FakeRuntime `/python sum <fileId>` → 복사·`FILES`·출력 CSV 저장·답 칩·주인만 내려받기·다음 호출 입력), 입력 범위(다른 대화·다른 사용자·보내지 않은 파일·해시 불일치), 출력 규칙(형식·링크·크기·개수·깊이·숨김·바뀌지 않은 입력·20개 한도), 오류 보고, 실행기 실패 코드와 작업 폴더 삭제, 슬롯, 로그, 비밀(자르기 경계에 걸친 비밀, base64·hex, 파일 내용·이름), 환경 변수, 샌드박스 정책, **두 런타임 녹화 재생**(Claude·Codex가 우리 MCP 서버로 `python_run`을 실제 호출 → 결과 파일 칩).
- **실제 샌드박스(macOS, 독립 실행형 python — `TEST_SKILL_PYTHON` 또는 uv로 찾음, 없으면 건너뜀):** 다른 대화의 작업 폴더·저장 파일·DB·홈·밖 폴더 읽기 실패, 밖 쓰기·fork 실패, 네트워크(외부·루프백·우리 MCP 포트·DNS) 차단, **무한 루프가 시간 한도로 `python_timeout`**, 메모리·파일 크기·폴더 크기 한도, 큰 출력, fd 1 직접 쓰기, 예외·종료 코드, **`chflags` 불가와 `removeTree`의 플래그 복구**. pandas 시험은 `TEST_PYTHON_PACKAGES=<DATA_DIR>/python-packages/<폴더>`를 주면 돈다:
  ```
  TEST_PYTHON_PACKAGES=$(ls -d ./data/python-packages/*-py3.12) pnpm vitest run apps/server/test/python.test.ts
  ```
- **런처 완화 사본 시험**(`the launcher (relaxed test copy, own user)`, macOS + 독립 실행형 python 3.12일 때 자동): 운영 파일에서 세 상수 줄만 바꾼 사본을 임시 설치(인터프리터는 APFS 복제 `cp -cR`, `chmod -R go-w`·`-N`)에 놓고 자기 계정으로 돌린다 — `verify` 통과와 보고 형식, 작업 실행과 커널 신원 기록, **트리 깊은 파일의 `everyone allow write` ACL·그룹 쓰기 파일·그룹 쓰기 조상·조상의 `add_file` ACL은 run(64)·verify 모두 거부**(`deny` 항목은 통과), 설정의 후행 공백·중복·미지 키·`packages` 누락·주석·빈 줄 거부, **메모리 감시**(작은 한도에서 400MB 할당 → 125·`status=memory` → `python_memory_limit`; 한도 아래는 정상), 시간 초과 → 124, **`argv[0]`을 바꾼 코드도 reap이 죽임**(ps `comm`이 바뀐 것을 확인한 뒤), 시작 시각이 다른 살아 있는 pid·기록 없음·형식 오류는 거부(65, 대상 생존 확인), run·probe가 호출자 환경(합성 비밀·`PATH`·`PERL5OPT`)을 python에 넘기지 않음, **verify가 대상 계정 기준**(모두가 통과할 수 있는 임시 위치에서 `nobody`를 대상으로: 진단 계정 소유 `0700` 프로그램 조상·그 계정이 못 읽는 트리 파일·그 계정에 대한 `deny list` ACL은 실패, 진단 계정 자신은 통과).
- **ACL 판정 단위 시험**(`the launcher's account ACL evaluation (unit)`): 운영 런처 파일의 dispatch 표시 줄 위(함수만)를 라이브러리로 읽어(운영 파일에 시험 분기 없음) `ls -le` ACL 줄을 직접 넣는다 — UUID 주체(계정·그 그룹·그 그룹 아닌 그룹·다른 사용자·해석 불가 → 실패, 그 권한과 무관한 해석 불가 항목은 무시, 사용자 UUID가 group으로 표시되면 실패), `only_inherit` allow/deny는 그 노드에 적용 안 됨, 첫 해당 항목이 결정(deny 먼저/allow 먼저), POSIX 클래스(아래로 넘어가지 않음). 그 밖에 `perl -Tc`, 적대적 작업 id 거부, clean(중첩 `000` 폴더)은 이전 차수에서 확인. sudo 계정 전환·교차 UID 종료는 이 환경에서 미검증(실계정 필요).
- **전용 계정 교차 UID 시험**(`TEST_PYTHON_RUN_USER=<계정>`을 주고, 런처·sudoers·scratch ACL이 설치돼 있을 때만; 없으면 건너뜀): 계정 자가 검사가 통과하고(다른 uid·KERN_PROCARGS2 차단), 실제 python_run에서 서버 UID 형제 프로세스의 시작 환경 읽기가 **차단됨**을 확인한다. 런처 동작은 아래 완화 사본 시험이 같은 UID로 검증한다(UID 하강은 sudo가, 실기에서 확인).
- Linux CI에는 sandbox-exec·독립 실행형 python·그 계정이 없어 실제 샌드박스·계정 묶음은 건너뛰고, 나머지(런처 인자 검증, 게이트, 자가 검사 논리 — 주입 프로브)는 시험용 실행기로 모든 플랫폼에서 돈다. e2e는 만들지 않았다(브라우저 쪽은 #49의 내려받기 칩과 같은 경로라 새 화면이 없다).
- 실런타임 확인: 실제 Claude·Codex 연결에서 CSV를 올리고 "이 표의 합계를 계산해 CSV로"를 보내 칩으로 내려받는다.

## 36. 공유 화면·포크·열람 확인·가족 공유 묶음 (#52)
PRD FR-2.4, FR-8.8, FR-14.3~14.6. 투영·경로 규칙은 §33과 `docs/decisions/sharing.md`를 따른다. 공유받은 사람에게 가는 것은 이 절의 경로에서도 모두 `SharePolicy.project`의 결과뿐이다.

### 36.1 화면
- **가족에게 공유 대화상자**: 대화 메뉴(⋯, 사이드바·대화 상단 모두)의 "가족에게 공유"와 아티팩트 화면(`/a/:id`, 패널)의 "👪 가족에게 공유"(주인에게만 — 접근 SSE가 `owner`라고 할 때)에서 연다.
  - 항목 이름·종류, 지금 상태(“비공개” 또는 “공유 중 — 누구”), 켜진 공유마다 범위·대상·**열람 확인**(대상마다 “✓ 열어봄 · 시각” 또는 “아직 안 열어봄”), 대상 바꾸기, 공유 끄기와 `SHARE_REVOKE_NOTICE`.
  - 새 공유: 대화는 "대화 전체"(live) 또는 "이 메시지까지"(snapshot, 경계 메시지 선택). 아티팩트는 live만 고른다(범위 선택이 없다). 대상은 처음에 아무도 고르지 않은 상태다(§33과 같은 규칙).
- **사이드바 "가족 공유" 묶음**: 나에게 공유된 항목(최대 20개)마다 제목, 공유한 사람·시각, 처음 열기 전까지 "새로". 1분마다와 화면에 돌아올 때 다시 읽는다. 아래 링크가 `/shared`(전체 목록·검색·내가 공유한 것)로 간다.
- **공유 화면 `/shared/:id`**: 누가 언제 공유했는지, 읽기 전용. 공유받은 사람에게는 "이어서 대화하기"(아티팩트 공유는 "내 것으로 복사해서 고치기")와 `SHARE_FORK_NOTICE`가 보인다. 예약 결과 대화의 공유이면 "새 결과가 생기면 알림 받기" 체크가 있다. 주인의 미리보기(`own: true`)에는 둘 다 없다.
- 관리 컨트롤(대화 ⋯ 메뉴, "가족에게 공유", 자료 조사 토글)은 서버가 확인한 주인에게만 보인다(`Conversation.owned` — `GET /api/conversations/:id`는 공유받은 사람에게 `false`). 공유받은 대화를 `/c/:id`로 바로 열어도 메뉴가 없다.
- "이 메시지까지" 경계 선택은 메시지를 페이지로 읽고 "이전 메시지 더 불러오기"로 오래된 메시지까지 고를 수 있다. 공유 목록을 읽지 못하면 "공유 상태를 확인할 수 없어요"라고 하고 "비공개"라고 하지 않는다.
- 대화상자 안의 키는 대화상자에서 멈춘다. Esc는 대화상자만 닫고 둘러싼 서랍(모바일 사이드바)이나 패널은 닫지 않는다.
- 포크로 만든 대화(`kind = fork`)는 맨 위에 "가족이 공유한 내용을 복사한 내 대화예요" 안내가 있다.

### 36.2 API
- `POST /api/shares/:id/fork` → 201 `{conversation}`. 공유가 닿는 사람만(행렬의 shared 열). 주인은 400 `share_own_item`, 닿지 않거나 그사이 꺼졌으면 403.
  - 복사하는 것은 `SharePolicy.forkSource(share, p)` — `bundle(share, p)`와, 그 아티팩트의 **보이는 버전**의 내용, 투영에 든 파일의 행(바이트용)뿐이다. 투영과 묶음은 파일 쓰기 잠금과 트랜잭션 **안에서** 다시 읽는다. 잠금을 기다리는 사이 해제되면 403이고 아무것도 남지 않는다.
  - 새 대화: 포크한 사람의 것, `kind = fork`, `forkedFrom` = 공유 id, 제목은 원래 제목(가림 적용), 설정은 그 사람의 기본값(FR-12.6 대체 포함 — 새 대화와 같다).
  - 메시지: 투영된 파트만(reasoning 없음, `tool_result.output` 없음). 쓰는 중(`pending`·`streaming`)인 메시지는 빼고, `connection_id`는 복사하지 않는다. 런타임 세션·run·요약·MCP 토큰·연결·비밀은 아무것도 따라가지 않는다. 파트의 파일·아티팩트·버전·출처 id는 사본의 id로 바꾸고, 사본에 없는 것을 가리키는 파트(카드·칩)는 뺀다. `citation_ref`는 원래 run의 인용 행을 가리키므로 뺀다(서버가 만드는 곳은 없다). `citation_note`의 출처 id·파일 위치도 사본으로 바꾼다.
  - 파일: 바이트를 새 경로(`files/<포크한 사람>/<새 대화>/<새 id>`)로 **복사**한다(링크가 아니다). 크기·sha256을 다시 확인하고, 다르거나 읽을 수 없으면 그 파일은 빠진다. 업로드 id 없이, 원래 메시지의 사본에 붙는다(그 메시지가 사본에 없는 문서 파일은 마지막 메시지에 — 보내지 않은 첨부로 남지 않게). 추출(#48)은 사본 바이트에서 다시 한다.
  - 아티팩트: 보이는 버전만, 1…n으로 다시 번호를 매긴다. `document` 버전은 사본 파일을 가리키게 고치고, 파일이 사본에 없으면 그 버전은 뺀다. 아티팩트 공유의 포크는 메시지가 없으므로 "공유받은 「…」을(를) 내 대화로 복사했어요" 답 하나에 카드를 단다.
  - 출처: 공유 화면이 보여 준 `Source`만(페이지 본문은 공유받은 사람에게 가지 않으므로 복사하지 않는다 — `body`·`body_hash` null). `run_id`는 포크 id다.
  - 가림(#78): 복사하는 글은 모두 저장 때 다시 가린다(메시지 `scrubParts`, 제목·파일 이름 `scrubKnown`, 버전 `scrubContent`, 출처 `scrubKnownDeep`). 원래 행이 저장된 뒤 등록된 비밀도 사본에 들어가지 않는다.
  - 한 트랜잭션·한 잠금 안에서 전부 되거나 전부 안 된다. 실패하면 복사한 바이트도 지운다.
- `PUT /api/shares/:id/subscription {notifyResults}` → 200. 예약 결과 대화(`kind = schedule`)의 대화 공유를 받은 사람만. 주인 400 `share_own_item`, 다른 항목 400 `share_not_schedule_result`.
  - 알림의 모든 칸은 공유에서만 만든다(리뷰 #119): 제목은 공유받은 사람의 목록에 보이는 공유 제목(`incoming`), 본문은 공유용 고정 문구, 주소·참조는 공유. 주인의 예약 이름(이름을 바꾼 뒤의 것 포함)·결과 요약·실패 이유는 쓰지 않는다.
  - 예약 실행이 결과(또는 실패)를 남기면, 주인 알림 뒤에 그 공유를 받고 "알림 받기"를 켠 사람 중 **지금 투영에 그 메시지가 있는 사람**에게만 알린다(`shares/notify.ts`). snapshot은 경계 뒤 결과를 알리지 않는다. 주소는 `/shared/<공유 id>`, 참조는 공유(`share`)라서 알림함이 읽을 때마다 다시 검사한다(공유가 꺼지면 알림도 사라진다). 본문은 공유용 고정 문구다(FR-13.5). 한 사람에게 실행마다 한 번(`schedule-run:<id>:shared:<계정>`).
- `GET /api/shares/:id/view`: 공유받은 사람이 열 때마다 `share_views`에 기록한다(처음 시각은 그대로, 마지막 시각만 바뀐다). 주인의 미리보기와 거부된 요청은 기록하지 않는다. 응답에 `viewer`(예약 결과 공유면 `{notifyResults}`, 아니면 null)와 `own`이 더해졌다.
- `Share.views`: 열어 본 계정·처음·마지막 시각(주인만 본다). `IncomingShare.viewedAt`: 내가 처음 연 시각(null이면 "새로").
- 공유 알림(`share_received`, #34)은 #29 그대로 공유·대상 변경 때 새로 닿는 사람에게 간다.

### 36.3 저장 (마이그레이션 0027)
- `share_views` (share, user, first/last_viewed_at), `share_subscriptions` (share, user, notify_results). 공유·계정과 함께 지워진다.
- `forks` (id, 포크한 사람, 사본 대화, 공유 id, 원래 대화·항목 종류·id, 시각)와 `fork_items` (fork, 종류 `message|file|artifact|source`, 원래 id, 사본 id). 사본 대화와 함께 지워지고, 원래 쪽은 외래 키 없는 id라 원래 대화를 지워도 남는다. #54의 삭제 연쇄는 `fork_items`(인덱스 `item_type, source_id`)로 원래 항목의 사본을 찾을 수 있고, 사본은 다른 대화의 새 행·새 파일이므로 원래 대화의 삭제가 건드리지 않는다("포크 사본은 남음").
- 네 표의 글 칸은 id·고정 값뿐이다(`secrets/columns.ts`).

### 36.4 알려진 한계
- 포크를 다시 공유하면 사본 아티팩트는 투영에 들지 않는다. 투영 규칙(§33)은 run이 쓴 버전만 메시지와 잇는데, 사본에는 run이 없다. 덜 보이는 쪽(실패 시 닫힘)이다.
- 포크는 동기 복사라 큰 파일이 많으면 그동안 서버가 바쁘다(가족 규모 기준으로 둠). 대화 하나의 파일 수 한도(`FILE_LIMITS.perConversation`)는 원래 대화와 같다.
- `/a/:id`를 공유받은 사람이 직접 열었을 때는 포크 버튼이 없다(공유 id를 모른다). 공유 화면에서 포크한다.

### 36.5 확인 방법
- `pnpm -C apps/server exec vitest run test/shares.test.ts`: 포크가 투영과 정확히 같은지(snapshot 경계 뒤 메시지·파일·버전·출처 없음, reasoning·원본 결과 없음, 새 id·포크한 사람 소유·별도 바이트, 출처 본문 없음, `fork_items`), 원래 대화를 지워도 남는지, 주인 400·남 403·해제 뒤 403(대화가 생기지 않음), 늦게 등록된 비밀이 사본에 없는지, 아티팩트 공유 포크(문서 파일 사본), `remapParts`, 열람 기록(주인 미리보기·거부는 기록 안 함), 예약 결과 알림(켠 사람만, 공유 본문, 실행마다 한 번, snapshot 경계 뒤 없음, 해제 뒤 없음).
- `apps/server/test/permissions.test.ts`: `POST /api/shares/:id/fork`, `PUT /api/shares/:id/subscription` 행.
- `pnpm -C apps/web exec vitest run test/shares.test.ts`: 열람 확인 표시, 0명은 가족 전체가 아님.
- `E2E_PORT=3103 pnpm e2e e2e/share-screens.spec.ts`(데스크톱·모바일, 테스트마다 새 계정): 대화 메뉴에서 공유 → 받은 사람 사이드바에 "새로"와 공유한 사람 → 열면 주인 화면에 "열어봄" → 이어서 대화하기 → 원래 대화 삭제 뒤에도 포크 유지. 아티팩트 화면에서 공유 → 받은 사람이 복사.

## 37. 파일 뷰어와 파일 인용 딥링크 (#24)
PRD FR-4.5, 수용 기준 2·11. 추출·위치는 §26(#48)·§34(#23), 공유 투영은 §33(#29).

### 37.1 무엇이 보이나
- 확인된 파일 인용(“report.pdf · 12쪽”)은 답 아래 출처 목록의 파일 이름·위치, 그리고 `[n]`을 눌러(탭) 연 미리보기의 “파일에서 보기”가 링크다(hover 없이 열린다). 보낸 파일 칩(`file_ref`)에는 내려받기 옆에 “보기”가 붙는다.
- 주소: `/c/:대화id/files/:파일id?loc=<locator JSON>`. 새로 고침·붙여넣기로 열어도 같다. 휴대폰에서는 화면 전체를 쓴다. “← 대화로”는 온 곳으로 돌아간다.
- 처음 창은 그 위치 앞 20개 단위부터 100개. “앞부분/뒷부분 더 보기”는 처음 창에서 시작하는 별도 조회로 글자만 더 불러오고(앞 창은 다음 창이 시작하는 곳에서 끝난다, `to`), 위치 판정·강조는 처음 창(그 자체로 한 조회 — 다시 불러와도 그대로)의 것을 쓴다. 한 칸이 각주로 나뉘면 그 칸의 조각을 차례대로 모두 그리고, 열 정보를 잃은 조각이 있으면 그 행은 글자 그대로 차례대로 그린다(보낸 글자를 빼지 않음). 뷰어를 떠나면 파일 글자는 캐시에 남기지 않고 진행 중인 요청은 취소한다(조회는 방문마다 따로 — 이전 방문의 늦은 응답도 읽히지 않음, 다시 열면 그때의 가림으로 새로 읽음), 이번에 열지 않은 앞/뒤 창은 보이지 않는다. 더 불러오기가 실패하면 버튼은 “다시 시도”로 남고 이유를 보여 준다.
- 보여 주는 것은 **추출한 글자**(§26 — 알려진 비밀은 `[숨김]`)를 형식별로 배치한 것이다: PDF 쪽(줄 상자 지도 + 글자), 스캔 쪽·사진(OCR 단어 상자 지도, 사진은 원본 그림 위에 상자), HWP·HWPX·DOCX 문단·표(행·열 격자, 각주는 표 아래), XLSX·CSV 시트(열 문자·행 번호), PPTX 슬라이드, TXT·MD 줄 번호. 글자는 언제나 글자로만 그린다.
- PDF 원본을 브라우저에서 그리지 않는다(pdf.js를 앱 화면에서 돌리지 않음 — 원본 픽셀은 가릴 수 없고, 파일 해석 코드를 앱 출처에서 실행하지 않는다). 쪽 지도는 저장된 상자로만 그린다(쪽 크기는 저장되지 않아 A4 비율로). 원본은 “원본 내려받기”로(§24의 CSP·첨부 그대로).

### 37.2 강조 규칙 — 확신할 수 있는 것만
`GET /api/files/:id/view?loc=&from=&limit=`가 위치를 풀어 `target`으로 알려 준다(`packages/shared/src/file-view.ts`).
- `exact`: 그 구절을 노란색으로, 쪽이면 상자도. 조건 — locator의 범위가 단위 글자 안에 있고, 단위가 세부 위치를 잃지 않았고(`approximate` 아님, HWP 나뉜 조각 아님), **보는 사람이 볼 수 있는 인용**(주인: 그 대화의 인용, 공유받은 사람: 자기 투영의 인용)이 바로 이 locator를 줬으며, 그 인용을 확인할 때의 단위 글자(구절 끝까지)의 해시(`textHash`, 인용 기록에만 저장 — 모델·답 노트에는 없음)가 지금 글자와 같고 구절도 그대로일 때. 인용 뒤 등록된 비밀로 앞 글자가 바뀌면, 같은 문장이 다른 자리로 밀려와도 그 범위를 주장하지 않는다. 그 파일의 저장 글자가 바뀌면(새 비밀의 백그라운드 재가림, 재추출) 그 파일 인용의 해시는 지운다 — 이제 알려진 비밀 위에서 계산된 해시가 DB에 남아 값을 맞혀 보는 데 쓰이지 않게. 그 인용은 이후 `unit`(확인되지 않음)으로 열린다.
- `unit`: 그 위치(쪽·문단·표의 행·슬라이드·줄 묶음) 전체를 파란 테두리로, 이름 붙은 줄·칸은 밑줄로. 이유를 화면에 쓴다: 범위 없음, 비밀 가림으로 세부 위치 잃음, 나뉜 문단·행, 확인되지 않은 범위(인용 뒤 새로 등록된 비밀로 글자가 바뀐 경우 포함), 범위가 글자와 안 맞음.
- 비밀 가림으로 줄 표시를 잃은 TXT·MD 줄 묶음: 지금 보이는 줄 수 안의 줄만 그 묶음으로 본다(가린 비밀이 줄바꿈을 삼켰을 수 있어 그 너머는 알 수 없음 → 강조 없음).
- `stale`(다른 바이트의 locator)·`not_found`(그런 단위 없음, 다른 파일)·`unreadable`(읽는 중·실패): 아무것도 강조하지 않고 이유를 쓴다. 읽는 중이면 3초마다 다시 본다.

### 37.3 권한
- 새 경로 `GET /api/files/:id/view`는 원본·`/extract`와 같은 검사다: 주인, 그리고 #29 투영에 그 파일이 든 공유 대상만. 남·관리자 403, 로그인 전 401. 공유받은 사람에게는 투영 밖의 인용이 범위를 “확인”해 주지 않는다(투영 밖 답의 존재를 알 수 없게).
- 마이그레이션 없음.

### 37.4 확인 방법
- `pnpm vitest run apps/server/test/file-viewer.test.ts`: 12쪽 구절 `exact`+상자, HWP 3번째 표 2행 `exact`+칸, 스캔 PDF 상자(OCR 없으면 건너뜀), 범위 없음·만든 범위·범위 밖·다른 바이트·없는 표·다른 파일, 인용 뒤 등록된 비밀(응답에 비밀 없음, 범위 주장 안 함), 공유받은 사람·남·관리자·보내지 않은 파일, 인용 전에 끝나는 snapshot.
- `apps/server/test/file-tools.test.ts` “수용 기준 2”: PDF 1 + HWP 1 비교(`/file-compare`)를 Claude·Codex 녹화 재생으로 — 같은 인용 노트, 둘 다 뷰어에서 `exact`.
- `pnpm vitest run apps/web/test/file-viewer.test.ts`: 링크 주소·배치·강조·파일 글자는 글자로.
- `E2E_PORT=3101 pnpm e2e e2e/file-viewer.spec.ts`(데스크톱·모바일, macOS — §26.2와 같은 이유로 그 밖에서는 건너뜀): PDF 인용 → 12쪽 구절, HWP 인용 → 3번째 표 2행, 공유받은 가족도 같은 위치, 남은 “열 수 없어요”, 다른 바이트 → 강조 없음; 스캔 PDF → 상자.
- fixture `fixtures/extract/assignment.hwp`(과제안내.hwp, 표 3개)는 `python3 -I fixtures/extract/make-hwp-fixtures.py`로 다시 만든다.

### 37.5 받아들인 한계
- 포크한 대화(#52)의 인용은 원래 대화의 인용 기록을 가져오지 않아 뷰어에서 `unit`(“확인되지 않음”)으로 열린다.
- 쪽 지도의 비율은 A4로 가정한다(상자의 상대 위치는 정확).

## 38. 삭제 연쇄 — 파일·추출물·아티팩트·공유·세션 (#54)
PRD NFR 개인정보("사용자가 대화를 지우면 파일·아티팩트·공유도 함께 지운다, 포크 사본은 남는다"), FR-2.1. 대화를 지우면(`DELETE /api/conversations/:id`, 주인만 — 새 경로는 없다) 그 대화의 내용은 DB와 `DATA_DIR` 어디에도, 서버 메모리의 캐시에도 남지 않는다. 백업(`BACKUP_DIR`, 데이터 폴더 밖)과의 관계는 38.4. 코드는 `apps/server/src/conversations/purge.ts`(`ConversationPurge`).

### 38.1 무엇이 어떻게 지워지나
| 대상 | 어떻게 |
|---|---|
| 대화, 메시지(수정 전 버전 포함), run과 스트림 이벤트, 요약(`conversation_summaries`), 런타임 세션 행 | 외래 키 연쇄 삭제 |
| 업로드 원본·생성 문서 파일(#22·#49): 행과 `files/<user>/<conversation>/` | 행은 외래 키. 바이트는 커밋 직후 지우고(서버가 준 이름만, 링크는 따라가지 않고 링크로만 지움), 같은 트랜잭션에서 쓴 `conversation_files` 작업이 **남은 파일이 없는 것을 다시 확인할 때까지** 재시도한다(권한 문제 등으로 못 지우면 작업이 남는다). 작업이 남아 있는 동안 백업은 그 폴더를 복사하지 않는다(`deletedFolders`, 38.4) |
| 추출 글·위치 색인(`file_extracts`·`file_segments`, #48·#23) | 파일과 함께(외래 키). 메모리의 가린 글 캐시도 비운다(`FileExtracts.evict`) |
| 아티팩트와 **모든 버전**(#27·#28) | 외래 키. `artifact_versions_immutable` 트리거는 UPDATE만 거부하므로 연쇄 DELETE는 된다 |
| 웹 출처·인용·금융 결과·예약 제안 | 외래 키. 출처는 대화마다 따로 저장되어 다른 대화가 같은 행을 참조하는 캐시가 없다(이슈의 "다른 대화가 참조하지 않으면" 조건이 늘 참). 인용 검사의 메모리 캐시(정규화한 페이지 본문, 본문 해시로 찾음 — `citations/verify.ts`)에서도 그 대화 출처의 해시를 지운다. 포크의 출처는 본문 없는 새 행이다 |
| 공유(대화 공유와 그 대화의 아티팩트 공유)·대상·스냅샷·열람 기록·결과 알림 구독 | `shares.conversation_id` 외래 키에서 연쇄. **스냅샷 불변 트리거**(`share_snapshots_immutable`)는 `BEFORE UPDATE`만 막는다 — 스냅샷을 바꾸는 길은 없고, 부모 공유가 지워질 때의 연쇄 DELETE는 막지 않도록 일부러 그렇게 두었다(트리거를 끄거나 우회하는 코드는 없다). 커밋 직후 권한 변경 이벤트(`resource-access-changed`, scope = 대화)로 열린 스트림(공유 이벤트 SSE, 접근 SSE, run 이벤트)이 바로 닫히고, 다음 요청은 404/403이다 |
| 알림(#34): 주인의 예약 결과 알림(본문에 답 요약이 있다), 공유받은 사람의 "가족이 공유했어요"·공유 결과 알림 | 삭제 트랜잭션 **안에서**, 받은 사람과 무관하게: 참조(`ref_id`)가 그 대화·그 대화의 공유·아티팩트·파일·run인 것, 주소가 `/c/<대화>`·`/shared/<그 공유>`인 것 |
| 런타임 쪽 세션 상태(Claude 세션 파일, Codex 스레드) — 대화의 세션, 그 대화의 **요약용 일회성 세션**, 행이 저장되기 전에 서버가 죽은 세션 | 38.2·38.3 |
| DB 파일·WAL에 남은 지운 행의 바이트 | `secure_delete`(쓸 때 빈 공간을 0으로)에 더해 삭제 트랜잭션이 정리 표시(`secrets.file_cleanup_pending`)를 남기고, 커밋 뒤 백그라운드 정리(`StoredRescrub`)가 `wal_checkpoint(TRUNCATE)`를 한다. 막히면 백오프로 다시, 다음 시작에도 표시에서 이어 한다 |
| 실행 중인 run | 같은 트랜잭션에서 멈춘다(`RunManager` — MCP 토큰 폐기, 스트림 종료, 런타임 프로세스 종료). 그 run이 늦게 보내는 것은 버려지고, 세션 상태는 프로세스가 **실제로** 끝난 뒤에 지운다(38.3) |

**남는 것** — 그 대화의 내용(질문·답·파일·출처 본문·요약·결과 글)은 없고, 다음 행들이 그 대화를 가리키던 **id와 숫자·시각·고정 코드**만 갖고 남는다:
- `usage_records`: run id·대화 id, 런타임·모델·연결, 토큰 수·비용·시각 (비용·한도 계산, #32·#44)
- `error_log`: 오류 코드·분류·route 패턴·id·시각 (#46)
- `schedule_attempts`·`schedule_results`: 예약 실행 id, 대화·메시지·run id, 시각 (예약 실행 이력과 비용, #55·#56)
- `forks`·`fork_items`의 원래 쪽 id (포크의 출처 기록 — 원래 대화가 지워지면 가리키는 곳이 없는 id)

**예약 자체는 남는다**: 예약 정의(`schedules`의 이름·프롬프트·시각 규칙)는 그 대화의 내용이 아니라 사용자가 만든 예약이다. 결과 대화를 지우면 `schedules.conversation_id`만 비고, 다음 실행이 새 결과 대화를 만든다. 예약을 없애려면 예약을 삭제한다(§28).

**포크**(#52)는 포크한 사람의 대화다: 메시지·파일 바이트(복사본)·아티팩트·출처가 그 사람의 새 행·새 파일이라 원래 대화의 삭제가 건드리지 않는다. 포크한 사람이 포크를 지우면 같은 규칙으로 지워진다.

### 38.2 런타임 세션 상태 (`RuntimeAdapter.forget`·`storedSessions`)
세션은 연결 폴더 `runtimes/<연결 id>/<사용자 id>/`(§11)에 있다. **지우기(`forget`)와 세션 시작(`start` — Codex는 시작 전에 지침 파일을 지우고, 둘 다 폴더를 만들고 메모를 쓴다) 모두** `runtimes/`·연결 폴더·사용자 폴더·`-meta` 폴더와 런타임이 쓰는 모든 하위 폴더(Claude `config`·`home`·`work`·`tmp`, Codex `codex-home`·`home`·`work`·`tmp`)를 `lstat`으로 먼저 확인한다. **어느 하나라도 링크(또는 폴더가 아님)면 아무것도 지우거나 쓰지 않고 실패**한다 — 지우기는 작업이 남고(로그 `conversation.forget_failed`), 시작은 run 실패. 일치하는 이름만, 링크는 링크로만 지운다.
- **Claude Code**: `config/projects/<작업 폴더>/<id>.jsonl`(대화 기록)과 `<id>/`(도구 결과·하위 에이전트), 그 밖에 config 폴더 안에서 세션 id로 시작하는 항목(todos, file-history, session-env, debug — 3단계까지), 우리 메모 `<사용자 id>-meta/<id>.json`(시작 프롬프트와 넘긴 맥락 — 세션을 열 때 **가장 먼저** 쓴다). 확인: SDK 0.3.312의 CLI는 대화 내용을 세션 파일에만 쓴다(`history.jsonl`은 SDK 모드에서 쓰지 않음).
- **Codex**(0.165.0): 파일만 지우면 SQLite 상태(`state_5.sqlite`의 스레드 목록 — 첫 메시지·미리보기, `thread_history_1.sqlite`의 항목 기록)가 남는다. 그래서 그 폴더의 app-server를 **네트워크 없이(`network: "none"`), 인증 정보 없이** 샌드박스에서 잠깐 띄워 `thread/delete {threadId}`를 부른다(그 폴더의 세션 시작 대기열을 함께 쓴다). **성공, 또는 "그런 스레드 없음"(-32600 `no rollout found for thread id …` — 실제 바이너리에서 확인한 답)만 끝난 것으로 본다.** 다른 모든 오류(내부 오류 -32603, 시간 초과, 프로세스 종료)는 실패이고, 이때는 파일도 지우지 않은 채 작업이 남아 재시도된다. 삭제 뒤에도 지운 행의 바이트가 WAL과 빈 칸에 남는 것을 실제 바이너리에서 확인했으므로(Codex SQLite에는 `secure_delete`가 없다) 각 저장소를 `VACUUM`하고 `wal_checkpoint(TRUNCATE)`한다(다른 app-server가 쓰는 중이면 busy → 재시도). 마지막으로 `sessions/`·`archived_sessions/`에 남은 `*-<id>.jsonl`과 우리 메모를 지운다.
- `storedSessions(dir)`: 그 폴더에 상태가 있는 세션 id(Claude: `config/projects/*/`의 기록과 메모, Codex: rollout과 메모). 시작 때의 대조(38.3)가 쓴다.
- **세션 id는 생기는 즉시 알린다**(`StartContext.sessionStarted`, 메모를 쓰기 전): Claude는 id를 만든 순간, Codex는 `thread/start`의 답을 받은 순간. 그 뒤 `start()`가 실패하면(예: 다른 스레드 알림으로 `runtime_policy`) run 관리자가 그 세션을 바로 지우기 작업으로 넘기고, 이미 떠 있던 프로세스(Codex app-server)는 실제로 끝날 때까지 그 대화의 "조용함"에 포함한다(실패한 시작이 기다리기를 멈춰도). 어댑터는 이 프로세스에서 **지금 살아 있는** 세션 id를 기억한다(`startedHere` — 새 세션은 id가 생긴 때부터, 이어 쓰는 세션(resume)은 열 때부터, 그 세션의 프로세스가 모두 끝날 때까지. 실패한 시작은 그 프로세스가 끝날 때까지). 끝난 세션은 행이 없으면 대조에서 고아로 잡힌다.
- **닫힘 확인**: `close()`는 프로세스 종료를 정해진 시간(강제 종료 후 최대 2초)까지만 기다리고, 그때까지 끝나지 않았으면 `ExitUnconfirmedError`로 실패한다. `exited()`는 실제로 끝났을 때 풀린다. run 관리자의 "조용함"(`quiet`)은 대화의 모든 세션(본 세션·요약 세션·삭제 뒤 열린 세션)의 `exited()`까지 기다리므로, 끝나지 않은 프로세스가 있으면 작업은 끝나지 않고 재시도된다.
- FakeRuntime은 메모리에만 있어 할 일이 없다. 연결이 끊겨 폴더째 지워진 세션(§11)도 할 일이 없다.

### 38.3 순서와 충돌 안전
1. **삭제 트랜잭션 하나**(커밋 전에는 아무것도 안 지워지고, 커밋 후에는 API로 닿는 것이 없다): run 멈춤 → 세션 행마다 `runtime_session` 작업, 업로드 폴더의 `conversation_files` 작업(`deletion_jobs`, id만) → 알림 삭제 → 메모리 캐시(추출 글, 정규화한 페이지 본문) 비움 → 정리 표시 → 대화 행 삭제(외래 키 연쇄).
2. **커밋 직후**: 권한 변경 이벤트(열린 스트림 닫기), 업로드 폴더 삭제(파일 쓰기 잠금 안), WAL 정리 요청, 작업 시작.
3. **작업**: 먼저 그 대화의 run이 **모두 실제로 멈췄는지**(세션 열기와 어댑터의 `close()`가 끝남 — run 종료를 기다리는 2초 상한과 별개) 최대 10초 기다린다. 그때까지 안 멈췄으면 끝나지 않은 것으로 보고 재시도한다(제한 시간은 성공이 아니다). 그다음 `forget`, 또는 업로드 폴더를 지우고 남은 파일이 없는지 확인. 확인되면 행 삭제, 아니면 `attempts`·`next_at`(30초부터 두 배씩, 최대 1시간)으로 계속 재시도한다(로그 `conversation.forget_failed` — 런타임·시도 횟수·오류 종류만). 서버가 준비되면(`onReady`) 남은 작업을 이어 한다.
4. **행이 없는 세션**: run 관리자가 넘긴다(`forgetSession`) — 대화 요약의 일회성 세션(이어 쓰지 않으므로 요약이 성공하든 실패하든 닫자마자), 세션 행을 저장하지 못한 세션(여는 중에 대화가 지워졌거나, 대화는 있어도 행 쓰기가 실패한 경우 — 이어 쓰지 않으므로 이유와 상관없이), 그리고 id가 생긴 뒤 `start()`가 실패한 세션. 이 작업도 그 대화의 run이 모두 실제로 멈춘 뒤에 돈다.
5. **시작 때 대조**(`reconcile`, 이 데이터 폴더 자신의 DB일 때만, 무엇이든 세션을 열기 전에): 모든 연결 폴더에서 `storedSessions`가 알려 준 세션 중 그 연결의 `runtime_sessions` 행이 없는 것을 작업으로 만든다. 세션을 연 뒤(Claude는 열면서 바로 메모에 맥락을 쓴다) 행을 저장하기 전, 또는 4번의 작업을 쓰기 전에 서버가 죽은 경우가 여기서 잡힌다. 연결 테스트의 세션도 행이 없으므로 같이 지워진다(내용 없음, 다시 쓰지 않음). **폴더마다 따로** 본다: 읽지 못한 폴더(권한 등)는 그 폴더만 건너뛰고 나머지는 계속 보며, 그 패스를 "미완료"로 표시(`settings`의 `deletion.reconcile_incomplete`)하고 백오프로(30초부터 최대 1시간) 모든 폴더를 읽는 패스가 될 때까지 다시 한다. 서버가 도는 중의 재시도는 지금 살아 있는 세션(`startedHere`)을 고아로 보지 않는다. 그리고 대조가 만든 작업은 **지우기 직전에 다시 확인한다**(`stillOrphan`, 어댑터의 순서 안에서 — Codex는 그 폴더의 세션 열기·이어 쓰기가 끝난 뒤): 그사이 그 세션을 `runtime_sessions` 행이 갖게 됐으면(예: 대조가 열리는 중인 스레드의 rollout을 봤고, 그 뒤 시작이 끝나 행이 저장됨) 아무것도 지우지 않고 작업만 버린다. 행은 없지만 지금 살아 있으면 지우지 않고 **작업을 남겨** 나중에 다시 한다(버리지 않는다). 같은 세션에 대화가 만든 작업(대화 삭제, run이 넘긴 세션)이 오면 앞서 대조가 만든 작업은 그 대화의 작업으로 **바뀌고**(같은 세션 행 하나 — 무시되지 않는다) 곧바로 돌 차례가 되며, 더는 고아 재확인을 받지 않고 대화의 run이 실제로 멈춘 뒤 지운다.
6. **작업의 결과를 저장하지 못할 때**(DB 쓰기 실패): 그 작업의 백오프를 메모리에 두고 이번 차례를 멈춘다 — 실패하는 DB에서 같은 작업을 곧바로 되풀이하지 않는다. 메모리에 보류된 작업은 조회에서부터 빠지므로(보류된 작업이 한 차례 분량을 채워 뒤의 작업을 막지 않는다), 다음 차례는 DB의 `next_at`과 보류가 풀리는 시각 중 이른 쪽에 돈다.

| 어디서 죽나 | 다음 시작에서 |
|---|---|
| 트랜잭션 커밋 전 | 대화가 그대로 있다(아무것도 지워지지 않음). 다시 지우면 된다 |
| 커밋 뒤, 업로드 폴더를 지우기 전·도중 | `conversation_files` 작업이 남아 있다 → 이어 한다(시작 sweep도 행 없는 파일을 지운다, §24). 그사이 백업은 그 폴더를 건너뛴다 |
| 커밋 뒤, WAL 정리 전 | 정리 표시가 남아 있다 → 백그라운드 정리가 checkpoint |
| 커밋 뒤, 세션 상태를 지우기 전·도중 | `runtime_session` 작업이 남아 있다 → 이어 한다(`forget`은 여러 번 불러도 된다) |
| 세션을 연 뒤 행 저장 전, 요약 세션을 닫은 뒤 작업을 쓰기 전, 실패한 시작을 넘기기 전 | 시작 때 대조가 찾아 작업으로 만든다(읽지 못한 폴더는 다시 읽힐 때까지 재시도) |

- 받아들인 한계(이론상): 링크 검사(`lstat`)와 실제 사용 사이에 다른 프로세스가 경로를 링크로 바꾸는 경쟁(TOCTOU)은 막지 않는다. 서버의 어떤 경로도 이 폴더들을 링크로 바꾸지 않으며, 데이터 폴더는 서버 계정 전용(700)이다.
- 남는 틈(받아들인 한계): Codex가 `thread/start`에 답한 뒤 우리 메모를 쓰기 전(같은 흐름의 바로 다음 줄)에 서버가 죽고 rollout도 아직 없으면, 그 스레드는 어떤 이름으로도 보이지 않아 대조가 찾지 못한다. 그 연결을 끊으면 폴더째 지워진다. 디스크는 copy-on-write라 지운 블록이 바로 덮어써진다는 보장이 없다 — FileVault를 켜 둔다(§11과 같음).

### 38.4 백업과의 관계
- **암호화 범위**: 백업은 DB와 파일의 사본이다. 백업 전체를 암호화하지는 않는다 — 연결 키·토큰, VAPID 개인 키 같은 **인증 정보 열만** 마스터 키로 암호화되어 있고(§3·§21.1), 대화·파일 내용은 평문이다. 그래서 백업 폴더(`BACKUP_DIR`, 데이터 폴더·레포 밖)는 서버 계정만 읽게(폴더 700, 파일 600) 두고 디스크는 FileVault로 암호화한다.
- 지운 뒤 만드는 백업에는 없다: DB는 `VACUUM INTO`(살아 있는 행만 새 파일로, §21.2), 파일은 그때 있는 것만, 그리고 `conversation_files` 작업이 아직 남은 업로드 폴더는 **복사하지 않는다**(`deletedFolders`). 런타임 폴더(`runtimes/`)는 원래 백업에 들어가지 않는다(§21.1).
- **이미 만든 백업에는 남는다 — 보관 7일**: 정리(prune)는 백업을 시도할 때(매일)와 서버가 시작할 때 돈다. 그래서 **서버가 돌고 있고 정리가 성공하는 동안에는** 지운 뒤 7일, 다음 정리 시각까지 최대 8일 안에 모든 백업에서 사라진다. 서버가 오래 멈춰 있으면 그동안 정리가 돌지 않아 더 오래 남고, 다시 시작할 때 7일이 지난 것이 지워진다. 정리가 실패하면(디스크 오류·권한) 그 백업은 다음 시도까지 남는다 — 알림은 가지 않고 로그(`backup.pruned`, error 수준)에만 남으므로, 관리자 화면 백업 탭의 목록에 7일이 지난 백업이 보이면 `BACKUP_DIR`을 직접 확인해 지운다. 서버 밖에서 기한을 강제하지는 않는다.
- 그 사이 **복원하면 지운 대화가 돌아온다** — 복원은 그 시점으로 되돌리는 것이기 때문이다(삭제 상태를 따로 보존하지 않는다. 복원은 런타임 세션을 모두 무효로 표시한다). 복원했다면 그 뒤에 지운 대화를 다시 지운다. 복원이 옆에 남긴 옛 데이터 폴더(§21.4)는 확인한 뒤 직접 지운다.

### 38.5 범위
- 이 이슈는 **대화 삭제**의 연쇄다. 보내지 않은 파일 하나(✕)는 §24 그대로(행과 바이트, 추출 글은 외래 키). 공유 하나 끄기는 §33(공유 행은 남고 꺼짐).
- **계정 삭제는 없다**(#72는 비활성화만 — 데이터는 남고 공유는 멈춘다, §33). 계정 삭제를 만들 때는 대화마다 이 연쇄를 거쳐야 한다(외래 키만으로는 디스크 파일·세션 상태·알림이 남는다).
- 이미 내려받은 파일과 포크 사본은 되돌리지 않는다(`SHARE_REVOKE_NOTICE`).

### 38.6 저장 (마이그레이션 0028)
- `deletion_jobs` (id, 종류 `runtime_session`·`conversation_files`, 대화 id(대조·일회성 세션은 빈 값), 사용자 id, 런타임·연결 id·세션 id(세션 작업), 시도 횟수, 다음 시각, 만든 시각). 외래 키가 없다(대화·연결·계정이 먼저 없어질 수 있다). 글 칸은 id·고정 값뿐이다(`secrets/columns.ts`).
- 로그: `conversation.deleted`(대화 id, 남은 작업 수), `conversation.session_forgotten`(재시도 끝에 된 것), `conversation.forget_failed`, `conversation.sessions_reconciled`(시작 때 찾은 수). 경로·내용은 없다.

### 38.7 확인 방법
- `pnpm -C apps/server exec vitest run test/delete-cascade.test.ts`(실제 DB 파일): 두 턴·파일 두 개(추출 글)·아티팩트 두 버전·출처·요약·세션 파일·스냅샷 공유·열람 기록·포크·알림을 만든 뒤 지우면, 스냅샷 밖의 표지 글이 **모든 표의 모든 행과 `DATA_DIR`의 모든 파일 바이트(DB 파일·WAL 포함)**에 없고, 알림(받은 사람 무관)·세션 파일·업로드 폴더가 없으며, 다른 대화는 그대로이고 포크는 남는다. 포크를 지우면 나머지도 없다. 그 밖에: 실행 중 삭제, 커밋 뒤 죽었을 때 다음 시작이 이어 함, 실패한 `forget`의 재시도, 링크된 연결 폴더(작업이 남음), 지우지 못한 업로드 폴더(작업이 남고 백업에 안 들어가며 풀리면 확인 후 끝남), 인용 캐시 비움, run이 실제로 멈출 때까지 작업이 끝나지 않음, 행 저장 전 죽은 세션을 시작 때 대조가 지움.
- `test/codex.test.ts` "forget (#54)": 녹화 재생(`thread/delete`, 네트워크 없음·키 없음, VACUUM으로 SQLite에서 사라짐, 링크된 CODEX_HOME·`home`·`work`·`tmp`에서 멈춤(바깥 `AGENTS.md`가 그대로), 내부 오류는 실패이고 파일도 남음, "없음"만 끝남, `storedSessions`)와 **macOS 실제 바이너리**(진짜 턴 두 개 → 하나를 지우면 그 글이 CODEX_HOME 어디에도 없고, 다른 스레드는 그대로 이어지며, 다시 지우면 "없음"으로 끝남).
- `test/claude.test.ts` "forget (#54)": 세션 id 이름의 항목만, 링크는 링크로만, 링크된 연결·config·`-meta` 폴더에서 멈춤, `storedSessions`(메모만 있는 세션 포함), 시작이 메모 전에 id를 알림·링크된 폴더에서 시작 거부.
- `test/codex.test.ts`(2차): `thread/start` 뒤 다른 스레드 알림으로 실패한 시작이 id를 먼저 알리고 그 메모를 `forget`이 지움, 링크된 연결 폴더·`home`·`work`·`tmp`·`codex-home`에서 시작 거부(바깥 `AGENTS.md` 그대로, 프로세스 없음), 종료가 늦으면 `close()`가 `ExitUnconfirmedError`이고 `exited()`는 실제 종료 때.
- `test/runs.test.ts`(2차): id가 생긴 뒤 실패한 시작이 넘어감, 프로세스가 실제로 끝나기 전에는 `quiet`가 거짓. (3차) 대화가 있어도 세션 행 쓰기가 실패하면(트리거로 재현) 넘어감, 실패한 시작의 프로세스가 끝날 때까지 `quiet`가 거짓. `codex.test.ts`·`claude.test.ts`(3차): 살아 있는 동안만 `startedHere`(Codex 실패한 시작은 늦게 끝나는 프로세스가 끝난 뒤 해제, Claude는 닫은 뒤 해제). `delete-cascade.test.ts`(3차): 보류된 20개 뒤의 21번째 작업이 돌고, 보류된 것은 다시 돌지 않음. (5차) `delete-cascade.test.ts`의 Codex 시험(재생 app-server): 대조 작업이 있는 스레드를 저장·닫기·이어 쓰기한 뒤 대화를 지우면 작업은 그 대화의 것 하나가 되고, 프로세스가 끝나기 전에는 지우지 않다가 끝난 뒤 `thread/delete` 한 번으로 파일이 사라짐. 행 없이 살아 있는 세션의 대조 작업은 남아 있다가 세션이 끝나면 지워짐. (4차) `codex.test.ts`: 대조가 열리는 중인 스레드를 본 뒤 시작·행 저장·닫기·(이어 쓰기)가 이어지면 그 작업은 `thread/delete` 없이 버려지고 파일이 남으며, 행도 없고 살아 있지도 않을 때만 지움. `delete-cascade.test.ts`: 행이 생긴 세션의 대조 작업은 버려지고 파일이 남음. `test/delete-cascade.test.ts`(2차): 읽지 못한 폴더 하나가 다른 폴더의 대조를 막지 않고, 미완료 표시 뒤 재시도로 끝나며 이 프로세스가 연 세션은 건드리지 않음, 결과를 저장하지 못하는 DB에서 작업이 백오프대로만 다시 돎.
- `test/context.test.ts`: 요약의 일회성 세션이 성공·실패 모두 닫힌 뒤 넘어간다. `test/runs.test.ts`: 여는 중에 지워진 세션이 넘어간다.
- 변이 확인: WAL 정리, 시작 때 대조, 캐시 비움, 업로드 폴더 확인, 백업 제외, run 멈춤 확인, 요약 세션 넘기기, Codex "없음" 판정을 각각 빼면 해당 시험이 실패한다.
- `E2E_PORT=3102 pnpm e2e e2e/delete-cascade.spec.ts`(데스크톱·모바일, 테스트마다 새 계정): 파일을 붙여 묻고, 공유해 받은 사람이 연 뒤 주인이 사이드바 메뉴로 삭제 → 받은 사람의 공유 화면이 해제 안내로 바뀌고, API는 404/403, 알림함에서 사라지고, `.e2e/data` 아래 어떤 파일에도 그 글이 없다.

## 41. 샌드박스 작업자를 전용 macOS 계정으로 — 추출기·문서 생성기·내보내기 브라우저 (#122)
방식과 근거는 `docs/decisions/isolation.md` "샌드박스 작업자 전용 계정 (#122)". python_run(§35)과 같은 이유다: macOS 샌드박스는 **같은 UID**의 다른 프로세스 시작 환경(`KERN_PROCARGS2`)을 읽는 것을 막지 못하고, Claude 런타임은 API 키·OAuth 토큰을, 런타임 환경은 MCP bearer 토큰을 시작 환경에 둔다. 추출기(`extract/worker.mjs`, 올린 파일 파싱)·문서 생성기(`docgen/worker.mjs`)·내보내기 브라우저(헤드리스 셸, 아티팩트 문서)는 신뢰할 수 없는 바이트를 다루므로, 작업자가 뚫리면 같은 UID에서는 그 환경을 읽을 수 있다. 그래서 이 셋을 서버·런타임·python 계정과 **다른 UID**의 전용 계정으로 돌린다.

### 41.1 동작
- **전용 계정 하나, python과 따로:** `WORKER_RUN_USER`(예: `_agentleewk`). `PYTHON_RUN_USER`와 같으면 서버가 시작을 거부한다 — python은 모델이 쓴 코드를, 작업자는 다른 가족의 파일을 다루므로 UID·scratch ACL을 나누지 않는다.
- **루트 소유 런처** `/usr/local/libexec/agentlee-worker-run`(`ops/workers/agentlee-worker-run`, Perl `-T`): python 런처(§35.2·35.3)의 신뢰 검사(조상 체인·트리 전체·ACL·설정 형식)·커널 신원 실행 기록·`reap`·`clean`·`verify` 함수를 **바이트 그대로** 쓰고(시험이 비교), 종류별 고정 프로그램을 더했다. 서버가 넘기는 것은 작업(`run`·`probe`·`reap`·`clean`·`verify`), 종류(`extract`·`ocr`·`docgen`·`render`), 작업 id(UUID), 시간제한(종류별 상한: 60·300·60·60초), `render`의 egress 프록시 루프백 포트뿐이다. node·작업자 프로그램·라이브러리·OCR 데이터·브라우저·scratch는 **루트 소유 설정**(`/usr/local/etc/agentlee-worker.conf`)에서 읽는다. 어떤 프로그램을 어떤 인자·환경·샌드박스 프로필로 돌릴지는 런처에 고정돼 있다 — 브라우저 스위치는 `browserArgs`와, 프로필은 `buildProfile`(지금의 같은 UID 샌드박스)과 **한 글자도 다르지 않다**(시험).
- **입력·출력의 UID 경계:** 작업마다 `<DATA_DIR>/worker-scratch/<작업 id>/`를 서버가 만든다(서버 소유 0700, scratch의 상속 ACL로 계정이 쓴다). 추출은 저장 파일을 링크 따라가지 않고 열어(하드링크 거부 — `nlink === 1`) 새 0600 서버 소유 사본으로 복사하고 크기·SHA-256을 행과 대조한다(다르면 `extract_changed`). 추출기 프로필은 그 작업 폴더와 프로그램 트리만 읽고 아무것도 쓰지 못한다. 문서 생성기는 작업 폴더도 못 읽는다(stdin만 — 런처가 계정으로 작업 폴더에 받아 둔 뒤 fd로 넘긴다). 결과는 지금처럼 stdout의 JSON 하나다. 브라우저는 작업 폴더의 `home`·`tmp`·`profile`만 쓰고, 디버깅 파이프(fd 3·4)는 런처가 자기 stdin/stdout과 **중계**한다(sudo는 0~2번만 넘긴다). 작업 뒤에는 런처 `clean`(계정으로, 모드 복구 후 삭제) → 서버의 `removeTree` 순으로 지우고, 서버 시작 때 남은 작업 폴더·`.ctl` 기록을 같은 순서로 지운다(루트와 `.ctl` 폴더는 ACL 때문에 남긴다).
- **작업자 코드는 매니페스트에서만:** 계정으로 돌 때 런처는 `AGENTLEE_WORKER_APP=<app 트리>`를 준다. 작업자는 그때 라이브러리 경로·pdf.js 데이터·글꼴·OCR 폴더를 그 트리의 `manifest.json`(상대 경로, `..`·절대 경로 거부)에서만 읽고 작업이 준 경로·한도는 버린다 — 서버(또는 서버 UID의 어떤 프로세스)가 계정으로 임의 코드를 import시키지 못한다.
- **멈춤·한도:** 시간·상주 메모리는 런처가 250ms마다 본다(추출 768MB/60초, OCR 1536MB/300초, 문서 768MB/60초, 렌더 768MB — 서버의 기존 수치). 넘으면 종료 코드 124(시간)·125(메모리) → 기존 코드(`extract_timeout`/`extract_limit`, `doc_timeout`/`doc_limit`, `export_timeout`/`export_limit`). 서버는 다른 UID를 신호로 죽일 수 없으므로 출력 한도·중단·렌더 시간 초과에서는 런처 `reap <작업 id>`(커널 uid·시작 시각 확인, 실패 시 0.5초 간격 3번 재시도)로 멈춘다. 렌더는 서버 타이머(20초)가 먼저, 런처 한도(25초)가 뒤를 받친다.
- **Chromium `--single-process --no-sandbox`:** 그대로다. macOS는 seatbelt 프로필을 겹칠 수 없어 Chrome 자체 샌드박스는 계속 끄고, 경계는 우리 seatbelt 프로필(프록시 포트만, 쓰기는 그 렌더 폴더만, fork 없음) **더하기 다른 UID**다. 렌더러가 뚫려 네이티브 코드를 얻어도 그 프로세스는 `_agentleewk`이라 서버·런타임 프로세스의 `KERN_PROCARGS2`를 읽지 못하고(커널이 거부), 신호도 보낼 수 없고(다른 UID, 같은 샌드박스만), 서버 소유 파일도 못 연다. 같은 계정의 다른 작업(동시 추출)은 작업마다 다른 프로필(자기 폴더만)이 막는다 — scratch ACL은 모든 작업 폴더에 상속되므로 작업 사이 격리는 ACL이 아니라 프로필에 달려 있다(python과 같음).
- **실패 시 닫힘 + 기존 동작 유지:** 종류마다 **시작 자가 검사**(권위 있는 검사, `workers/selfcheck.ts`)가 이 기계에서 통과한 뒤에만 그 종류를 계정으로 돌린다. 검사: (0) `bundle` — 설치된 번들의 지문(매니페스트 + 작업자 파일 전체의 SHA-256)이 이 서버 체크아웃의 것과 같은지(`git pull`·lock 갱신 뒤 다시 설치하지 않으면 실패), (1) `probe` — 그 종류의 프로필 그대로(프로그램만 `/usr/bin/perl` — node에는 sysctl이 없다) 계정으로, 서버 UID 형제 프로세스(환경에 합성 비밀)의 `KERN_PROCARGS2`를 `kern.argmax` 크기 버퍼로 **실제로 읽어** 막히는지(자기 프로세스 읽기와 자기 표식이 양성 대조, "읽힘"은 형제 표식이 실제로 보일 때만), 커널이 그 형제를 서버 UID로 여전히 보이고 서버의 그 자식이 아직 살아 있는지(사라진 pid·좀비는 "막힘"이 아니다), 자기 UID가 서버와 다른지, (2) `run` — 보통 경로 그대로의 실제 작업(추출: 서버 소유 텍스트 파일을 `extract`와 `ocr` 종류로 각각, 문서: DOCX 하나, 렌더: 페이지 하나를 PNG로 — 프록시·중계 파이프·고정 스위치 포함)과 결과 내용 확인, (3) `identity` — 각 작업의 실행 기록(`.ctl/<id>/leader`)이 probe의 UID를 적었고 그 UID 소유인지. 셋 다 서버가 준비된 뒤 백그라운드에서 차례로 돈다(시작을 막지 않음). **통과 전·실패·미설정이면 그 종류는 지금의 같은 UID 샌드박스로 계속 돈다** — 추출·문서·내보내기가 계정을 설치하지 않은 집에서 깨지지 않는다. 대신 관리자 화면 **시스템 상태 → 샌드박스 작업자 격리**에 종류마다 `계정 격리 안 됨 — 같은 UID 샌드박스만`과 이유(미설정·검사 중·실패 단계·중단)가 빨간 배지로 나오고, 로그에 `worker.same_uid`(종류 목록) 경고, 실패는 `worker.self_check_failed`(종류·단계)가 남는다(`GET /api/admin/system`의 `workers` — 코드만, 메시지 없음). 통과한 종류는 `전용 계정으로 격리`. 종료 때 진행 중인 검사는 중단되고(통과로 치지 않음) 최대 10초 정리를 기다린다.
- **신뢰 트리의 링크(리뷰 #130 1차):** 트리 안의 심볼릭 링크는 모두 실제 경로가 **같은 트리 안의 존재하는 경로**여야 한다(밖을 가리키거나 끊긴 링크는 거부 — 번들러는 pnpm의 끊긴 선택 의존성 링크를 지운다). node·브라우저·작업자 진입 파일·매니페스트 같은 파생 경로는 `/`까지 조상 전체(링크 없음·루트 소유·그룹/기타 쓰기 없음·쓰기 ACL 없음)를 검사한다.
- **번들 지문(리뷰 #130 1차):** `app`(매니페스트 경로·작업자 파일·전이 라이브러리 id(버전)·OCR 데이터), `node`(버전·실행 파일), `browser`(헤드리스 셸 실행 파일) 셋으로 나눠 SHA-256을 남기고, 추출·문서는 `app`+`node`, 렌더는 `browser`가 서버 것과 같아야 한다.
- **verify는 참고용**(§35.2와 같은 규칙과 한계 — 대상 계정 기준의 ACL 평가). 판정은 자가 검사다.

### 41.2 설치 (한 번 — 관리자, `sudo` 필요. 서버는 sudo를 쓰지 않는다)
서버 계정을 `agentlee`, 데이터 폴더를 `<DATA_DIR>`(절대 실제 경로)로 가정한다.
```
# 0) 헤드리스 셸(내보내기와 같은 것)이 있어야 번들이 만들어진다
pnpm exec playwright install --only-shell chromium

# 1) 번들 — node 실행 파일, 작업자 프로그램과 고정 라이브러리(pnpm 폴더 그대로, 링크는 번들 안만), OCR 데이터,
#    헤드리스 셸, manifest.json(상대 경로 + 지문). sudo 없음. 새 폴더를 준다.
pnpm workers:bundle /tmp/agentlee-workers-bundle

# 2) 루트 소유로 설치 (전용 계정은 읽기만, 아무도 못 고침). 재설치 때는 먼저 지운다.
sudo rm -rf /usr/local/lib/agentlee-workers
sudo mkdir -p /usr/local/lib /usr/local/etc /usr/local/libexec
sudo ditto /tmp/agentlee-workers-bundle /usr/local/lib/agentlee-workers
sudo chown -R root:wheel /usr/local/lib/agentlee-workers
sudo find /usr/local/lib/agentlee-workers ! -type l -exec chmod -N {} +   # ACL 전부 제거(링크 제외 — 쓰기 ACL 하나면 런처가 거부)
sudo chmod -R a+rX,go-w /usr/local/lib/agentlee-workers                  # 루트만 쓰기, 모두 읽기·검색
rm -rf /tmp/agentlee-workers-bundle

# 3) 숨은 비권한 계정 (로그인 불가, 홈 없음). python 계정(_agentleepy)·서버 계정과 다른 UID여야 한다.
sudo sysadminctl -addUser _agentleewk -fullName "Agent Lee workers" -home /var/empty -shell /usr/bin/false
sudo dscl . -create /Users/_agentleewk IsHidden 1

# 4) 런처
sudo install -o root -g wheel -m 0755 ops/workers/agentlee-worker-run /usr/local/libexec/agentlee-worker-run
sudo chmod -N /usr/local/libexec/agentlee-worker-run

# 5) 설정: 정확히 네 줄(node·app·browser·scratch), 각 한 번, 공백·주석·빈 줄 금지, 실제(정규) 경로.
sudo tee /usr/local/etc/agentlee-worker.conf >/dev/null <<CONF
node=/usr/local/lib/agentlee-workers/node
app=/usr/local/lib/agentlee-workers/app
browser=/usr/local/lib/agentlee-workers/browser
scratch=<DATA_DIR>/worker-scratch
CONF
sudo chown root:wheel /usr/local/etc/agentlee-worker.conf
sudo chmod 0644 /usr/local/etc/agentlee-worker.conf
sudo chmod -N /usr/local/etc/agentlee-worker.conf

# 6) sudoers: 서버 계정이 그 런처만, 그 계정으로만, 암호 없이 (visudo -f 로 편집)
sudo visudo -f /etc/sudoers.d/agentlee-workers
#   내용 한 줄:
#   agentlee ALL=(_agentleewk) NOPASSWD: /usr/local/libexec/agentlee-worker-run

# 7) worker-scratch 교환: 전용 그룹 + 상속 ACL (python의 scratch와 별개)
sudo dseditgroup -o create agentleewk-scratch
sudo dseditgroup -o edit -a _agentleewk -t user agentleewk-scratch
sudo dseditgroup -o edit -a agentlee    -t user agentleewk-scratch
mkdir -p <DATA_DIR>/worker-scratch
sudo chgrp agentleewk-scratch <DATA_DIR>/worker-scratch
sudo chmod 070 <DATA_DIR>/worker-scratch
sudo /bin/chmod +a "group:agentleewk-scratch allow list,add_file,add_subdirectory,delete_child,search,readattr,writeattr,file_inherit,directory_inherit" <DATA_DIR>/worker-scratch

# 8) 계정이 worker-scratch까지 통과(search)할 수 있게: 막힌 조상마다 그 그룹의 search만 (읽기 금지)
sudo /bin/chmod +a "group:agentleewk-scratch allow search" <DATA_DIR>
#    홈(예: /Users/agentlee)처럼 막힌 조상이 더 있으면 각각에 같은 항목. 어느 것인지는 setup-check의 "scratch traversal" 줄.

# 9) .env
#    WORKER_RUN_USER=_agentleewk
```
확인:
```
pnpm workers:setup-check   # sudo 없이 진단만: 런처의 읽기 전용 verify(run과 같은 신뢰 검사, 대상 계정 기준 접근) + scratch == DATA_DIR/worker-scratch
pnpm workers:check         # 권위 있는 검사: 서버 시작 때와 같은 종류별 자가 검사(bundle·probe·run·identity)
# 교차 UID 시험(설치 후):
TEST_WORKER_RUN_USER=_agentleewk pnpm vitest run apps/server/test/workers.test.ts
```
- `pnpm workers:check`가 `extract: ok (uid <계정 uid>, KERN_PROCARGS2 blocked; …)`·`docgen: ok …`·`render: ok …`를 찍어야 한다. 그 뒤 **서버를 다시 시작**한다(검사는 시작 때 한 번 돌고 결과를 기억). 관리자 → 시스템 상태 → 샌드박스 작업자 격리의 세 줄이 모두 `전용 계정으로 격리`여야 한다.
- **업데이트 때마다(작업자 코드·lock·node 변경 — 사실상 `git pull`마다) 1)·2)를 다시** 한다. 안 하면 `bundle` 단계가 실패해 그 종류들은 같은 UID 샌드박스로 돌아가고 상태가 `자가 검사 실패 (bundle)`로 바뀐다(옛 작업자 코드를 계정으로 돌리지 않는다).
- 되돌리기: `.env`에서 `WORKER_RUN_USER`를 지우고 재시작하면 세 작업자 모두 같은 UID 샌드박스(상태: 미설정)로 돈다.

### 41.3 확인 방법
- `pnpm vitest run apps/server/test/workers.test.ts` — 모든 플랫폼: 런처 인자(종류·UUID·종류별 시간 상한·render만 포트), probe 판정의 엄격한 한 줄, 실행 기록의 형식·소유자, 같은 계정 설정 거부, **운영 런처 바이트**(고정 설정 경로·`OWNER_ALLOW_SELF=0`·메모리 상수·`-T`·`%ENV` 교체·셸 없음·`exec`는 `sandbox-exec` 목록형만)와 **python 런처와 같은 함수 28개가 바이트 그대로**, perl로 불러 비교한 **종류별 프로필 == `buildProfile`**(probe 프로필 포함)·**브라우저 스위치 == `browserArgs`**, 작업자의 매니페스트 경로(작업의 경로·한도 무시, `..`·절대 경로 거부), 대역 런처로 계정 경로(추출: 0600 서버 소유 사본·인자·작업 폴더 삭제·`ocr` 종류 선택·해시 불일치/하드링크는 실행 안 함, 문서: 경로 없는 stdin, 124/125/출력 한도/중단 → reap, 렌더: 포트 인자·`home`/`tmp`/`profile`·125 → `export_limit`), 게이트 상태(미설정·통과·실패 단계·예외·건너뜀·중단), 관리자 시스템 상태의 `workers`(메시지 없음), 시작 sweep.
- macOS(자동): 운영 파일에서 상수 줄만 바꾼 **완화 사본**(자기 계정)을 실제 번들(APFS 복제)에 붙여 — verify 통과, 추출(텍스트·PDF·스캔 PDF OCR)과 문서 4형식, 호출자가 넣은 모듈 경로 무시, 자가 검사의 run·identity 단계와 bundle 지문, probe(같은 UID는 readable, 루트 프로세스는 blocked, 사라진 pid는 error), 중계 파이프로 PNG 렌더, 렌더 시간 초과 124와 `status=timeout`, reap로 실행 중 브라우저 종료, 메모리 한도 125 → `doc_limit`, 잘못된 인자·트리의 그룹 쓰기 파일 거부(64), 다른 작업 폴더 읽기 실패.
- 실계정(`TEST_WORKER_RUN_USER`): 세 종류 자가 검사가 다른 UID·`KERN_PROCARGS2` 차단으로 통과. 이 환경(개발 기계)에서는 계정·sudo가 없어 미실행 — 설치 후 위 명령으로 확인한다.
- e2e(`e2e/admin.spec.ts`): 계정 미설정에서 시스템 상태의 세 작업자가 `계정 격리 안 됨`과 41절 안내를 보인다.
