# 운영 문서

집 Mac에서 Agent Lee를 운영하는 절차. 이 문서에는 인증 정보 값(API 토큰, 터널 토큰, AUD 태그 등)을 적지 않는다.

구성: `브라우저 → Cloudflare(Access) → Tunnel(cloudflared, LaunchDaemon) → 127.0.0.1:3000 Agent Lee(LaunchDaemon)`. 앱은 루프백에만 바인딩하고(`HOST`가 루프백이 아니면 시작 거부) 밖에서는 Tunnel로만 들어온다(PRD D4).

## 1. 데이터와 키의 위치

| 대상 | 기본 위치 | 설정 | 백업 |
|---|---|---|---|
| 데이터 디렉토리 (DB, 파일, 아티팩트, 런타임 홈) | `<repo>/data` | `DATA_DIR` | 포함 (#37) |
| SQLite DB | `<DATA_DIR>/agentlee.db` (WAL) | — | 포함 |
| 암호화 마스터 키 | `~/.agentlee/master.key` | `MASTER_KEY_PATH` | **포함하지 않음** — 아래 3절 |
| 웹 푸시 VAPID 키 (#34) | DB `settings` 표: `push.vapid.public`(평문), `push.vapid.private`(마스터 키로 암호화) | 처음 시작할 때 자동 생성 | DB와 함께 포함(개인 키는 암호문) — 11절 |

- `DATA_DIR`과 `MASTER_KEY_PATH`의 상대 경로는 레포 루트 기준이다.
- 서버는 `MASTER_KEY_PATH`가 `DATA_DIR` 안에 있으면 시작을 거부한다.

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
- **복원 절차**: 새 기기에 `~/.agentlee/master.key`를 만들고 사본 내용을 넣은 뒤 `chmod 600`. 이어서 백업을 복원한다(#37).
- **교체(로테이션)**: v1에서는 지원하지 않는다. 키가 유출되면 모든 연결을 해제하고 새 키를 만든 뒤 다시 등록한다.

## 4. 확인 기록

확인할 때마다 날짜와 결과를 적는다. 값(토큰·쿠키)은 적지 않는다.

- [ ] 재부팅 후 사용자 로그인 전에 LaunchDaemon 서비스가 마스터 키를 읽고 시작하는지 — 5.4절 절차. (Access 설정 뒤 앱 데몬을 설치하고 확인)
- [ ] `cloudflared` 데몬이 재부팅 후 사용자 로그인 없이 연결되는지
- [ ] `lsof -nP -iTCP:3000 -sTCP:LISTEN`이 `127.0.0.1:3000`만 표시하는지
- [ ] 실제 도메인 SSE 3분 측정 통과 — 8절, 결과 JSON을 #8에 첨부
- [ ] 휴대폰 LTE에서 Access 코드 로그인 → 빈 앱 화면, 허용 안 된 이메일은 Access에서 거부
- [ ] 가동률 7일 측정 합격 — 9.3절, `pnpm -s uptime report` 출력을 #46에 첨부 (Access 설정 후)

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
  - 허용 필드: `level` `time` `pid` `hostname` `msg` `reqId` `req{method,url=라우트 패턴,reqId}` `res{statusCode}` `responseTime` `err{type,code,statusCode}` `userId` `conversationId` `runId` `runtime` `tool` `durationMs` `status` `errorCode` `category` `costUsd` `inputTokens` `outputTokens` `dropped`, 알림(#34): `notificationKind` `count` `devices` `httpStatus`.
  - `msg`는 정해진 이벤트 이름만: `run.finished`(실행 1건: 소요·상태·오류 코드·비용·토큰), `tool.finished`(도구 호출 1건: 도구명·소요·ok/error), `request.error`, `web.build_missing`, `error`, 알림(#34) `push.sent`·`push.unsent`(보낸 알림 수·받은 기기 수)·`push.failed`(푸시 서비스 상태 코드·오류 코드)·`push.cancelled`(전송 직전 권한 재검사로 취소)·`push.subscription_gone`(404/410으로 기기 삭제), Fastify의 `incoming request`·`request completed`·`Server listening at http://127.0.0.1:3000`. 그 밖의 문장은 `redacted`로 바뀐다.
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

- `GET /api/admin/errors?limit=50&source=run|tool|http` (관리자만, 최대 200건). 항목: 시각·출처·오류 코드·분류·사용자/대화/실행 ID·런타임·도구명·라우트 패턴·상태 코드. 로그와 같은 정책이라 오류 문장은 없다. DB `error_log` 테이블에 최근 1000건·30일까지 둔다(1시간마다 정리, 조회도 30일 이내만). 화면은 #35.

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

## 11. Claude Code 연결 (임시 — 앱 안 연결 관리 #17 전까지)
`.env`에만 넣는다. 저장소·로그·디스크에 남지 않는다. 런타임 프로세스에는 환경 변수로만 넘긴다.

- `CLAUDE_OAUTH_TOKEN`
  - 관리자 본인 Claude 구독 토큰이다. 터미널에서 `claude setup-token`을 실행해 받는다.
  - **관리자 본인 대화에만** 쓰인다(PRD D2). 관리자 계정 이메일이 `ADMIN_EMAIL`과 같아야 한다.
- `CLAUDE_API_KEY`
  - Anthropic API 키(`sk-ant-…`)다.
  - 가족 모두가 쓴다. 관리자도 구독 토큰이 없으면 이 키를 쓴다.
- CLI 폴더는 연결과 사용자마다 따로 둔다: `DATA_DIR/runtimes/<연결 id>/<사용자 id>/`. 안에는 `config`(세션·설정), `home`, `work`, `tmp`가 있다.
  - CLI는 이 폴더만 읽고 쓴다(샌드박스).
  - 서버만 쓰는 세션 정보(시작 시스템 프롬프트, 누적 비용)는 폴더 밖 `<…>-meta/`에 둔다.
- 네트워크는 루프백만 쓴다: 우리 MCP 포트와 서버 안의 송신 프록시.
  - 인터넷은 프록시(`HTTPS_PROXY`)로만 나간다. 프록시는 `api.anthropic.com:443`의 CONNECT만 통과시키고, 사설·루프백 주소는 거부한다.
  - 터널은 최대 64개까지 열고, 5분 동안 오가는 데이터가 없으면 닫는다.
- 자식 프로세스는 만들 수 없다. 프롬프트는 쓴 그대로 넘긴다(`@파일`·슬래시 명령을 해석하지 않는다).
- 녹화 갱신: CI는 녹화된 응답을 재생한다. SDK 버전을 올렸거나 동작이 바뀌었다고 의심되면 다시 녹화한다.
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
| `daily_cost` (관리자) | 오늘 비용, 기준 | #32 |
| `system_warning` (관리자) | 서버가 쓴 짧은 고정 문구 | #35 |

### 12.4 시험 방법

- 자동: `pnpm test`(`apps/server/test/notifications.test.ts` — 가짜 푸시 서비스·가짜 시계로 방해 금지 묶음, 재시작 복구, 권한 재검사, 404/410, 로그아웃·비활성화, 엔드포인트 검사, 로그 비노출), `pnpm e2e`(`e2e/notifications.spec.ts` — 권한 요청은 버튼에서만, 차단 상태, 기기 등록·로그아웃 해제, 알림함·배지, 딥링크).
- 수동(PC): 운영 빌드(`pnpm build && pnpm start`)를 `http://localhost:3000`으로 열고 로그인 → 설정 → 알림 → "이 기기에서 알림 켜기" → 허용 → "테스트 알림". 개발 모드(`pnpm dev`)는 서비스 워커를 등록하지 않아 "지원 안 됨"으로 보인다.
- 실기기(Android Chrome, iPhone 홈 화면 앱): `docs/evidence/push/checklist.md`를 따라 하고 결과를 그 파일에 적는다. 휴대폰은 HTTPS가 필요하므로 `https://chat.2prostream.com`으로 접속한다.
- 문제 확인: `jq -c 'select(.msg|startswith("push."))' /Library/Logs/agentlee/server.log` — 보낸 수, 받은 기기 수, 실패 상태 코드만 나온다.
