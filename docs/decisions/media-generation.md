# 결정 기록 — 미디어 생성 (OpenRouter 이미지·음성·음악·영상, #238)

- 날짜: 2026-11-24
- 작성: Dev agent (Claude Opus 5.5), 계획: #238 본문, 사용자 결정(2026-11-24 댓글)
- 관련: `docs/ops.md` 51절(운영)·46절(음성 전사 외부 대체), `apps/server/src/media/`
- 범위: **1단계** — 관리자 설정과 공통 기반. **2단계** — 이미지·음성 동기 도구와 채팅 재생(§6–§8). 3단계(영상·음악 비동기 작업)는 후속 PR.

## 1. 설정 모양
- 한 JSON 행(`settings.media.settings`, `MediaSettings` — `packages/shared/src/media.ts`): `kinds.{image,speech,music,video}.{enabled, model}`, `dailyCostLimitUsd`, `perRunLimits.{종류}`, `videoDefaultSec`. 2·3단계 도구는 `app.media.settings.get()`으로 읽는다. 종류를 하나 더하려면 `MEDIA_KINDS`·카탈로그 URL·기본값에 넣는다.
- 기본값: 모두 꺼짐·모델 없음(호출마다 비용), 하루 $50(사용자 결정), 실행당 이미지 4·음성 3·음악 1·영상 1(이슈), 영상 8초(사용자 결정). 음악은 처음부터 다른 종류와 같은 자리에 둔다(사용자 결정 "기본 포함") — 호출 방식은 3단계에서 가짜 서버로 먼저 확인한다.
- 켜려면 모델이 있어야 한다(형식 검사). 새로 켜거나 새 모델을 고르면(꺼진 종류도) 그 종류의 목록을 **그 자리에서 다시 받아** 확인한 뒤 저장한다 — 목록에 없는 모델을 저장하지 않기 위해서다. 모델을 둔 채 끄기, 선택 해제, 한도 변경은 OpenRouter 없이 된다(장애 중에도 끌 수 있어야 한다).

## 2. 카탈로그 출처
| 종류 | 출처 | 근거 |
|---|---|---|
| 이미지 | `/api/v1/images/models` | 공식 문서(이미지 생성): `supported_parameters` 기술자, 가격은 엔드포인트 기록 |
| 음성 | `/api/v1/audio/speech/models` | 공식 문서(TTS): 출력 모달리티의 `supported_parameters` |
| 영상 | `/api/v1/videos/models` | 공식 문서(영상 생성): `supported_durations`·`pricing_skus` |
| 음악 | `/api/v1/models?output_modalities=audio` | 전용 목록이 문서에 없음. Lyria(`google/lyria-3-*`)는 일반 모델 목록에 출력 `audio`로 있다 — 출력에 `audio`가 없는 항목은 버린다 |

응답은 너그럽게 읽는다(모양이 다른 항목은 건너뛰고 추측하지 않는다). 가격은 목록에 있을 때만 보이고 없으면 "목록에 없음".

**가격 위치 (2단계에서 고침, OpenRouter 공개 OpenAPI 명세 `openrouter.ai/docs/openapi/openapi.yaml`·TTS 안내 문서, 2026-11-24).** 배포 뒤 실제 키로 열어 보니 이미지(71)·음성(38)·음악(4) 목록이 모두 "가격: 목록에 없음"이었다. 명세로 확인한 까닭과 고친 방법:
- 이미지: `ImageModelListItem.endpoints`는 배열이 아니라 **문자열**(`"/api/v1/images/models/<author>/<slug>/endpoints"`)이다. 가격은 그 URL의 `ImageModelEndpointsResponse.endpoints[].pricing: ImagePricingEntry[]`(`{billable: output_image|input_image|input_text|…, unit: image|megapixel|token|request, cost_usd: number, variant?}`)에만 있다. → 모델마다 그 기록을 읽는다(URL은 응답의 문자열이 아니라 id로 서버가 만든다, `author/slug` 모양만). 출력 이미지 줄이 있으면 그것만 보인다. 71개면 71번 읽기라 한 번에 6개·전체 20초로 묶고, 저장 전 재확인은 목록만 받는다.
- 음성: `SpeechModelResponse`·`SpeechModelEndpoint`에는 가격 필드가 **아예 없다**. TTS 문서: "per-character or per-second cost … via the Models API, where per-second models report their rate under `pricing.completion`". → `GET /models?output_modalities=speech`(`output_modalities`에 `speech` 값이 있다)의 `pricing`을 id로 맞춘다. `prompt`는 글자당, `completion`은 초당으로 표시한다.
- 음악: 일반 모델 목록의 `pricing`(`PublicPricing`: `prompt`·`completion`·`request`·`audio_output` 등 십진 문자열)을 읽는 것은 1단계와 같다. 다만 **Lyria의 곡당 가격**($0.08/song, 모델 페이지)은 명세의 어느 가격 필드에도 문서화돼 있지 않다 — 실제 응답에서 0이 아닌 값이 있으면 보이고, 모두 `"0"`이면 여전히 "목록에 없음"이다. 실제 키로 Lyria 항목의 `pricing`을 한 번 확인해야 한다(3단계 전 확인 과제).
- 표시: 아주 작은 단가가 `$6e-7`처럼 지수로 나오지 않게 소수로(유효 숫자 6자리).

**음악 목록의 음성 대화 모델 (1단계 이월).** `output_modalities=audio`에는 Lyria 같은 음악 모델과 GPT Audio 같은 음성 대화 모델이 섞인다. 명세의 `Model.supported_voices`(목소리 목록 또는 null)가 문서화된 구분점이다 — 목소리를 내놓는 모델은 대화용이다. 그런 모델은 빼지 않고(관리자가 정한다) "음성 대화 모델(음악 생성용 아님)"이라 표시하고 목록 끝에 둔다. 확정 판별은 아니다(음악 모델이 언젠가 목소리를 내놓으면 잘못 표시된다).

## 3. 키
- 관리자 키(암호화 저장) → `.env` `OPENROUTER_API_KEY` 순서, 요청마다 결정(`OpenRouterKeys`). 음성 전사 외부 대체도 같은 결정을 쓴다 — 키를 두 곳에서 따로 관리하지 않게.
- 저장 전 `/api/v1/key` 확인, 화면에는 끝 4자리와 남은 한도만. Cloudflare Access 토큰 등록(#36)과 같은 방식(호출 뒤 저장 직전 관리자 재확인, 쓰기는 한 번에 하나). 키와 확인 결과는 한 트랜잭션, 삭제는 한 문장(리뷰 1차) — 반쯤 바뀐 상태로 음성 전사의 과금 키가 바뀌지 않게.
- `.env` 키의 확인 결과는 저장하지 않고 프로세스 메모리에 그 키의 지문(SHA-256, 메모리에만)과 함께 둔다 — 운영자가 `.env` 키를 바꾸면 이전 잔액을 보여 주지 않는다. 카탈로그 캐시도 키 지문·키 변경 세대에 묶는다.

## 4. 비용과 사용량
- `usage_records` purpose `media`(텍스트 enum이라 마이그레이션 없음), runtime `openrouter`, `auth_type = api_key`, `priced_cost_micros` = OpenRouter가 알려 준 비용(가격표 없음). 그래서 기존 합계·오늘 비용 알림·월 예상에 그대로 들어간다. 생성마다 한 행(`<runId>#media:<callId>`), 같은 생성을 다시 쓰면 덮어쓴다.
- 하루 예산 `MediaBudget.remaining/allows`는 그 사람의 그날(서비스 시간대) `media` 행만 센다. 비용을 모르는 생성은 합에 넣지 않고 따로 센다 — 2단계에서 생성 직후 `/api/v1/generation?id=`로 비용을 채운다.

## 5. 청소년 계정과 요청 정책
- 숨기지 않는다(사용자 결정). 대신 모델이 moderation 값을 내놓으면 청소년 계정은 가장 엄격한 값을 보낸다(`moderationFor`). 값이 없으면 제공자 기본값. 정책은 고정(관리자 스위치 없음).
- 모든 요청에 `provider.data_collection: "deny"`(덮어쓸 수 없음), 나가는 글은 `carriesSecret` 검사. 영상은 ZDR이 지원되지 않아 `data_collection: deny`만 가능하다(이슈 본문).

## 6. 도구 (2단계)
- `image_generate`·`speech_generate`는 MCP 서버의 자체 도구(`packages/mcp-tools/src/media.ts`)라 Claude·Codex 런타임 모두 같은 도구 목록으로 본다. 스킬 권한이 아니라 **관리자의 종류 스위치**로 켜진다(켜짐 + 모델 + 키). 청소년 계정에도 보인다(사용자 결정). 예약 실행(스킬 범위가 있는 실행)에는 주지 않는다 — "사용자가 요청하지 않으면 부르지 않는다"를 서버가 지킬 수 있는 유일한 자리다.
- 동기 호출: 이미지·음성은 수십 초 안에 끝나 깊이 조사 같은 job이 필요 없다. 시간 한도 이미지 180초·음성 120초, Codex의 MCP 도구 시간 한도(`tool_timeout_sec`)를 늘리는 목록에 넣었다.
- 모델 정보(비율·목소리·moderation·response_format)는 **호출마다** 그 모델의 기록을 한 번 읽는다(관리자 화면의 캐시를 쓰지 않는다 — 도구 호출이 화면 캐시의 수명이나 키 세대에 묶이지 않게). 읽지 못하면 모르는 채 보내고 제공자가 판단한다.
- 청소년 moderation: 이미지 요청 명세(`ImageGenerationRequest`)에는 `moderation` 필드가 없다(채팅의 이미지 생성 서버 도구 설정에만 `auto|low`). 그래서 **모델의 `supported_parameters`에 `moderation`이 있을 때만** 그 값 중 가장 엄격한 것을 최상위 매개변수로 보낸다(`supported_parameters`는 "그 엔드포인트가 받는 매개변수"). 없는 모델에는 보내지 않는다 — 제공자 기본값과 OpenRouter의 CSAM 검사가 적용된다.
- 음성: `mp3`만 저장한다. PCM만 내는 모델(HeyGen, Gemini TTS)은 거부한다 — PCM을 WAV로 감싸는 것은 쉽지만 표본율이 모델마다 달라(24kHz, 44.1kHz) 문서로 확정되지 않았다. 필요하면 후속.
- 목소리 복제 없음: 도구 입력에 참고 음성이 없고, 요청에 `input_references`를 넣지 않는다.

## 7. 예산과 진행 중 예약 (1단계 이월)
- 같은 사람의 생성이 동시에 진행될 때 둘 다 "남은 예산 있음"을 보고 한도를 넘는 문제를, **예상 비용 예약**으로 막았다: 호출은 예상 비용(이미지: 모델 기록의 장당 출력 가격 중 가장 싼 값)을 사용자별 메모리 합에 더하고, 예산 확인은 오늘 쓴 비용 + 예약 합 + 이번 예상으로 한다. 끝나면(성공·실패) 예약을 빼고 실제 비용은 사용량 행으로 들어간다.
- 한계: 음성은 엔드포인트별 가격이 없어(일반 모델 목록의 글자당 가격뿐, 호출마다 그 큰 목록을 읽지 않는다) 예상 0 — 동시에 여러 음성 호출이 마지막 남은 예산을 함께 넘을 수 있다(음성 한 번은 보통 1센트 미만). 예약은 프로세스 메모리라 재시작 시 사라진다(그때 진행 중 호출도 끝난다). 실제 비용이 예상보다 크면(해상도별 가격 등) 한도를 조금 넘을 수 있다 — 한도는 "다음 호출을 막는" 선이다.

## 8. 채팅 표시와 파일
- 생성 파일은 `files.addGenerated`로 실행의 답에 묶이고, 기존 `file_ref` 칩 흐름(`generatedFiles`)으로 답에 붙는다. 화면은 답의 `file_ref` 중 이름이 이미지·음성인 것을 미리보기·재생기로 보인다(사용자 첨부는 그대로 칩만).
- `INLINE_KINDS`에 webp·m4a·mp3·wav를, `FILE_CSP`에 `media-src 'self'`를 더했다. 나머지(`sandbox`, `default-src 'none'`, 스크립트 없음)는 그대로다. 앱 페이지의 CSP는 `default-src 'self'`라 `<audio src>`(같은 출처)가 이미 허용된다.
- WebP를 파일 종류에 더했다(이미지 모델이 자주 낸다). 업로드도 받는다(내용 서명 검사). 저장 종류는 응답이 주장하는 `media_type`이 아니라 바이트 서명으로 정한다.
