# 스킬 목록 (#21, PRD §7)

PRD §7의 스킬을 하나씩 살펴 실제 진입점, 입출력, 의존성, 비밀, 허용 인자를 적은 표다. 코드의 기준은 `packages/mcp-tools/src/skills.ts`(`SKILL_SPECS`·`SKILL_CATALOGUE`)다. 실행 방식은 `docs/decisions/isolation.md` "공통 MCP 스킬 실행기 (#21)"에 있다.

- 확인한 곳: `~/.agents/skills/<이름>`(대부분 `~/Dev/skills/<이름>`으로 가는 심볼릭 링크), `~/.claude/skills`. 2026-11-11에 읽기만 했다. 스킬 폴더는 고치지 않았고, 비밀 값은 옮기지 않았다.
- 도구 이름은 `skill_<스킬 이름>`이다(런타임에서는 `mcp__agentlee__skill_<이름>`). 금융 판정(`isFinanceTool`)과 같은 이름을 쓴다.
- **상태**
  - **구현**: 래퍼가 있다. `pnpm skills:install` 뒤 서버가 도구로 제공한다.
  - **예정**: 이 실행기로는 아직 못 돌린다. 이유와 담당 이슈를 적었다.
  - **문서형**: 라이브러리 사용 안내만 있고 실행할 프로그램이 없다. 프로세스로 띄우지 않고 우리 MCP 서버의 **서버 함수**로 만든다.

## 요약

| 스킬 | 금융 | 상태 | 진입점 | 의존성 | 비밀 | 네트워크 |
|---|---|---|---|---|---|---|
| `kr-stock-skill` | 예 | **구현** (네이버 종목·지수, Alpha Vantage 시세) | `scripts/kr_stock.py` | python 표준 라이브러리(래핑한 명령). FinanceDataReader·pykrx 명령은 venv 필요 | `ALPHAVANTAGE_API_KEY`(선택, `alpha-quote`만) | `m.stock.naver.com`, `www.alphavantage.co` |
| `us-stock-skill` | 예 | 예정 #30 | `scripts/us_stock.py` | 스킬 venv(yfinance, matplotlib) | 없음 | Yahoo Finance(여러 호스트) |
| `market-disclosure-monitor` | 예 | 예정 #30 | `scripts/market_monitor.py` 외 워커(`sec_delta_worker.py` 등) | python, 로컬 SQLite(DART는 `dart-investment-monitor`의 DB를 읽는다), LLM 워커 | `OPENROUTER_API_KEY`, `OPENFIGI_API_KEY`(선택), `TELEGRAM_*`, `SEC_USER_AGENT` (PRD의 "OpenDART 키"는 DART 모니터 쪽) | `www.sec.gov`, `data.sec.gov`, `api.openfigi.com`, `query1.finance.yahoo.com`, OpenRouter, Telegram |
| `dart-investment-monitor` | 예 | 예정 #30 | `scripts/dart_monitor.py` | python 표준 라이브러리 + `dart_monitor_lib`, 로컬 SQLite(쓰기), `fcntl` 잠금 | `OPENDART_API_KEY`, `TELEGRAM_*`, LLM 워커 키 | `opendart.fss.or.kr`, `dart.fss.or.kr`, `api.telegram.org`, `query1.finance.yahoo.com` |
| `news-search-skill` | 아니오 | 예정 (#50에서 미룸) | `scripts/news_search.py` | 스킬 venv(google-genai, PyYAML) | `GEMINI_API_KEY` | Gemini API |
| `google-news-search-skill` | 아니오 | **구현** (#50: 결과를 출처로 등록, `web_search` 제공자) | `scripts/google_news_search.py` | python 표준 라이브러리 | 없음 | `news.google.com` |
| `realtime-lookup-skill` | 아니오 | 예정 (#50에서 미룸 — 뉴스 경로는 `web_search`+`web_fetch`로 대체) | `realtime_lookup_skill.py` → `simpleclaw.skills.realtime_lookup` | 스킬 폴더 밖 패키지(`simpleclaw`, 설치 안 됨) | 확인 필요 | Google News RSS, 기사 원문, Naver Sports |
| `summarize` | 아니오 | 예정 (#50: URL은 `web_fetch`로 대체, 유튜브는 미룸) | Homebrew `summarize` CLI 0.10.0(node) | 외부 CLI, LLM 제공자 | `OPENAI_API_KEY`·`GEMINI_API_KEY` 등 중 하나, 선택 `FIRECRAWL_API_KEY` | URL·유튜브·LLM API |
| `pdf` | 아니오 | 문서형 #48·#49 | (안내 문서 + 보조 스크립트) | pypdf·pdfplumber 등 | 없음 | 없음 |
| `docx` | 아니오 | 문서형 #48·#49 | (안내 문서 + `scripts/office/*`) | python-docx, LibreOffice(`soffice`) | 없음 | 없음 |
| `xlsx` | 아니오 | 문서형 #48·#49 | (안내 문서 + `recalc.py`) | openpyxl, LibreOffice | 없음 | 없음 |
| `pptx` | 아니오 | 문서형 #48·#49 | (안내 문서 + `scripts/*`) | python-pptx, pptxgenjs, LibreOffice | 없음 | 없음 |
| `python-scratchpad` | 아니오 | 예정 (대화 작업 폴더 #22 뒤) | `scripts/python_scratchpad.py` | python 표준 라이브러리 | 없음 | 없음(스스로도 막음) |
| HWP 추출기(신규) | 아니오 | #23 | 공통 MCP 서버의 파일 도구로 새로 만든다 | — | — | — |

v1 제외(PRD §7): `gmail-skill`, `google-calendar-skill`, `google-contacts-skill`, `google-docs-skill`, `agent-browser`, `computer-use`, `orca-cli`, `implementation-skill`. 정의가 없으므로 설치도, 사용자별 허용도 할 수 없다(`unknown_skill`).

## 구현한 스킬

### `google-news-search-skill` (일반)
- **진입점:** `scripts/google_news_search.py`(이 파일 하나만 서버 스킬 폴더로 복사).
- **입력**(도구 스키마, 정의에 없는 키는 거부):

  | 필드 | 형식 | 인자 |
  |---|---|---|
  | `query` | 1–200자, `SAFE_TEXT`(제어 문자, 셸 메타문자 세미콜론·파이프·앰퍼샌드·달러·백틱·꺾쇠·역슬래시 거부, `-`로 시작 불가) | `--query=<값>` |
  | `lookbackDays` | 정수 1–30 (기본 1) | `--lookback-days=<n>` |
  | `site` | 도메인 형식 | `--site=<값>` |
  | `locale` | `ko-KR` · `en-US` | `--locale=<값>` |
  | `sort` | `published` · `relevance` | `--sort=<값>` |
  | `maxResults` | 정수 1–20 (기본 10) | `--max-results=<n>` |

  항상 `--timeout=15 --format=json`을 붙인다. 원래 스크립트의 `--additional-query`·`--fallback-query`·`--exact`·`--hl/--gl/--ceid`·`--after/--before`는 열지 않았다.
- **출력:** `{ ok, query, url, sort, items: [{ rank, title, link, source, source_url, published_at, age_hours, query }], attempts, … }`. 모든 시도가 실패하면 종료 코드 1과 `{ ok: false, error, … }`(결과로 그대로 넘긴다).
- **네트워크:** `news.google.com:443`만(이 스킬 전용 송신 프록시).
- **확인:** 실제 스킬로 샌드박스 + 프록시 경유 실행 성공(`SKILLS_LIVE=1`, 2026-11-11).
- **출처(#50):** 성공한 결과의 `items`마다 `kind = "search"` 출처를 만들고 항목에 `sourceId`를 넣는다(링크·제목이 없는 항목은 `sourceId` 없음). 정의의 `searchHits`가 항목을 고른다.
- **`web_search` 제공자(#50):** `WEB_SEARCH_PROVIDERS`에 `google-news`가 있으면 `web_search`가 이 스킬을 `{ query, maxResults, lookbackDays: 30, sort: "relevance" }`로 부른다. 링크는 Google 중계 주소라 `web_fetch`로 원문이 열리지 않는다(실측 `web_no_text`). 그래서 기본 순서에서 DuckDuckGo 다음이다. `docs/decisions/isolation.md` "웹 검색·가져오기 (#50)".

### `kr-stock-skill` (금융)
- **진입점:** `scripts/kr_stock.py`(이 파일만 복사. 같은 폴더의 `config.json`에는 Alpha Vantage 키가 들어 있어 복사하지 않는다).
- **입력:** `command`(`stock` · `index` · `alpha-quote`), `code`(영숫자·점 1–12자). 명령과 맞지 않는 코드는 거부한다.

  | command | code | 인자 |
  |---|---|---|
  | `stock` | 6자리 숫자 | `naver-stock --code=<코드> --json` |
  | `index` | `KOSPI` · `KOSDAQ` | `naver-index --code=<코드> --json` |
  | `alpha-quote` | 대문자 티커 | `alpha-quote --symbol=<티커> --json` (키는 인자가 아니라 환경 변수로만) |

- **출력:** 네이버 스냅샷 `{ status: "available"|…, source: "Naver m.stock", code, name, market, value, delta, delta_pct, market_status, local_traded_at, delay_time_name, url, total_info, … }`. 조회 실패면 종료 코드 1과 `status`가 `available`이 아닌 JSON. Alpha Vantage는 `{ provider, symbol, raw }`.
- **비밀:** `ALPHAVANTAGE_API_KEY` — `alpha-quote` 호출의 프로세스에만 넣는다. 없으면 `skill_unconfigured`.
- **네트워크:** `m.stock.naver.com`, `www.alphavantage.co`(이 스킬 전용 프록시).
- **래핑하지 않은 명령:** `search`·`quote`·`daily`·`listing`·`fx`·`market-summary`. FinanceDataReader·pykrx가 필요하다. 스킬의 venv는 지금 없는 Xcode python 3.9를 가리켜 깨져 있다. venv 실행 방식과 함께 #30에서 다룬다.
- **확인:** 실제 스킬로 삼성전자(005930)·KOSPI 스냅샷 성공(`SKILLS_LIVE=1`, 2026-11-11). `alpha-quote`는 키가 없어 실호출을 건너뛰었다(`skill_unconfigured` 확인).

### `selftest` (내장 검증 스킬)
- 저장소에 들어 있다(`packages/mcp-tools/skills/selftest/main.mjs`, node).
- 연결 테스트(FR-11.5)용이라 모든 활성 사용자가 쓸 수 있다. 사용자별 허용 대상이 아니다.

## 웹 도구 (#50, 스킬이 아님)
`web_search`·`web_fetch`는 스킬이 아니라 우리 MCP 서버의 서버 도구다(`skill_` 접두사 없음, 사용자별 허용 대상 아님, 모든 활성 사용자). 샌드박스 node 작업자가 공개 주소만 허용하는 송신 프록시로 가져온다. 실행 방식·SSRF 시험·제공자 선택은 `docs/decisions/isolation.md` "웹 검색·가져오기 (#50)", 운영은 `docs/ops.md` §17.

## 예정 스킬 — 이유
- **`us-stock-skill`:** 스킬 venv(pip 패키지)가 필요하다. 이 실행기는 지금 `-S`(site-packages 없음)로 표준 라이브러리만 쓴다. 남은 일(#30):
  - 서버 폴더에 고정 버전 venv를 만드는 설치 단계
  - venv 경로를 읽기 허용에 넣기
  - yfinance(curl_cffi)가 프록시 환경 변수를 따르는지 실측
- **`news-search-skill` (#50에서 미룸):** 진입점이 `google-genai`·`PyYAML`을 import한다(스킬 venv). #21 제약(독립 실행형 python, `-I -S`, 표준 라이브러리, 고정 사본) 안에서는 실행할 수 없다. 하는 일은 Gemini `generateContent` + Google 검색 grounding 한 번이라, 고를 수 있는 길은 둘이다.
  - 고정 버전 venv 실행 단계(#30과 같은 일)를 만든 뒤 그대로 돌리기
  - REST 한 번을 node 작업자로 다시 쓰기(호스트 `generativelanguage.googleapis.com`만 허용하는 프록시, `GEMINI_API_KEY`는 그 프로세스 환경 변수로만)

  둘 다 **키로 실호출을 확인할 수 없어서**(이 Mac의 `.env`에 `GEMINI_API_KEY`가 없음, 스킬 폴더의 키는 옮기지 않는다) 만들지 않았다. 그동안 출처 있는 조사는 `web_search` → `web_fetch`로 한다. grounding 결과의 링크는 `vertexaisearch.cloud.google.com` 중계 주소라, 만들 때 `web_fetch`로 원문이 열리는지도 함께 확인해야 한다.
- **`market-disclosure-monitor`, `dart-investment-monitor`:** 조회 도구가 아니라 상태를 가진 모니터다. 로컬 SQLite에 쓰고, LLM 워커·Telegram 알림이 있다. 읽기 전용 조회 래퍼와 예약(#33) 연계를 #30에서 정한다. OpenDART 키는 `OPENDART_API_KEY`로 이미 받을 수 있다(`SKILL_SECRET_NAMES`).
- **`realtime-lookup-skill` (#50에서 미룸):** 진입점이 스킬 폴더 밖 `simpleclaw` 패키지를 import한다. 그 패키지는 이 Mac의 python에 설치돼 있지 않고, 스킬 폴더에 없으니 고정 사본으로 만들 수도 없다. 이 스킬의 뉴스 경로(Google News RSS로 후보 → 언론사 원문을 `web_fetch` 정책으로 읽기)는 이제 `web_search`·`skill_google-news-search-skill` → `web_fetch`가 그대로 한다. 남는 것은 구조화 조회(KBO 경기 결과는 Naver Sports 일정 API JSON, 날씨)다. 각각 전용 호스트·입력 스키마를 가진 작은 조회 도구로 따로 만든다(후속 이슈).
- **`summarize` (#50: URL은 대체, 유튜브는 미룸):** 외부 CLI(Homebrew node 앱)이고 자식 프로세스를 쓴다. 샌드박스는 fork를 막으므로 그대로는 못 돌린다.
  - **URL 요약:** 별도 서버 함수를 두지 않는다. 요약은 LLM의 일이고, 대화하는 런타임이 이미 그 LLM이다. `web_fetch`가 본문을 출처로 저장하고 발췌를 주면 런타임이 요약하고, 그 출처로 인용할 수 있다. 두 번째 LLM 키도 필요 없다.
  - **유튜브 요약:** 자막을 가져와야 한다. 공식 Data API는 남의 영상 자막을 내려받지 못하고(소유자 OAuth 필요), 비공식 경로(watch 페이지의 `captionTracks`·innertube)는 자주 바뀌고 동의 페이지·봇 확인이 있다. 믿을 만한 방법을 정할 때까지 미룬다(후속 이슈). 그동안 유튜브 링크는 `web_fetch`로 열어도 자막은 얻지 못한다.
- **`python-scratchpad`:** 모델이 쓴 코드를 실행한다. 표준 라이브러리만 쓰고 자체 AST 검사도 있어, 샌드박스(fork 금지·네트워크 없음) 안에서는 돌릴 수 있다. 다만 쓰기 가능한 작업 폴더가 대화마다 필요하다. 대화 파일 폴더(#22) 뒤에 붙인다.

## 문서형 스킬
`pdf`·`docx`·`xlsx`·`pptx`는 "이 라이브러리를 이렇게 써라"라는 안내다. 보조 스크립트도 런타임이 셸로 실행하라는 전제다. 우리 런타임에는 셸이 없다(PRD NFR 격리). 그래서 공통 MCP 서버의 파일 도구(서버 함수)로 만든다.
- 읽기·추출: #48
- 만들기: #49

LibreOffice가 필요한 기능(재계산·변환)은 자식 프로세스 문제를 그 이슈에서 따로 정한다.

## 스킬 추가 절차
`docs/ops.md` §15를 본다. 요약:
1. `skills.ts`에 정의(`SkillSpec`)를 추가한다. 복사할 파일, 입력 스키마, 인자 빌더, 호스트, 비밀을 적는다.
2. `SKILL_CATALOGUE` 상태를 `implemented`로 바꾼다.
3. 이 문서에 행을 추가한다.
4. 시험을 추가한다: 인자 거부, 금융 판정 일치.
