# 운영 문서

집 Mac에서 Agent Lee를 운영하는 절차. 이 문서에는 인증 정보 값(API 토큰, 터널 토큰, AUD 태그 등)을 적지 않는다.

구성: `브라우저 → Cloudflare(Access) → Tunnel(cloudflared, LaunchDaemon) → 127.0.0.1:3000 Agent Lee(LaunchDaemon)`. 앱은 루프백에만 바인딩하고(`HOST`가 루프백이 아니면 시작 거부) 밖에서는 Tunnel로만 들어온다(PRD D4).

## 1. 데이터와 키의 위치

| 대상 | 기본 위치 | 설정 | 백업 |
|---|---|---|---|
| 데이터 디렉토리 (DB, 파일, 아티팩트, 런타임 홈) | `<repo>/data` | `DATA_DIR` | 포함 (#37) |
| SQLite DB | `<DATA_DIR>/agentlee.db` (WAL) | — | 포함 |
| 암호화 마스터 키 | `~/.agentlee/master.key` | `MASTER_KEY_PATH` | **포함하지 않음** — 아래 3절 |

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

- 앱 로그: `/Library/Logs/agentlee/server.log`(JSON 한 줄씩, 허용된 필드만 기록 — 대화 내용·인증 정보 없음), 시작 실패는 `server.err.log`.
  ```bash
  tail -f /Library/Logs/agentlee/server.log
  ```
- 로그 파일 순환은 #46(관측성)에서 정한다. 그 전에는 크기를 가끔 확인한다(`ls -lh /Library/Logs/agentlee`).
- **가동률 측정**(목표 99%): 집 밖의 외부 헬스 체크가 5분 간격으로 `https://chat.2prostream.com/api/health`를 확인한다. Access 뒤에 있으므로 헬스 체크용 Access 서비스 토큰을 따로 발급하거나 Cloudflare Health Checks를 쓴다. 7일간 성공 비율로 계산하고, FileVault 잠금 해제 대기 시간은 뺀다. 구성은 #46에서 확정한다.

## 10. 가족 이메일 추가 (수동, 자동 동기화 #36 전까지)

1. 앱 관리자 화면에서 가족 계정을 만든다(#41).
2. Zero Trust → Access → Applications → Agent Lee → 정책 → Include Emails에 그 가족 이메일을 추가하고 저장한다.
3. 가족에게 임시 비밀번호를 직접 전달하고, 휴대폰에서 Access 코드 로그인 → 앱 로그인이 되는지 함께 확인한다.
4. 가족을 비활성화하면 같은 정책에서 이메일을 지운다. **관리자 이메일(`ingki3@gmail.com`)은 지우지 않는다.**
