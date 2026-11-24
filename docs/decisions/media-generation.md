# 결정 기록 — 미디어 생성 (OpenRouter 이미지·음성·음악·영상, #238)

- 날짜: 2026-11-24
- 작성: Dev agent (Claude Opus 5.5), 계획: #238 본문, 사용자 결정(2026-11-24 댓글)
- 관련: `docs/ops.md` 51절(운영)·46절(음성 전사 외부 대체), `apps/server/src/media/`
- 범위: **1단계** — 관리자 설정과 공통 기반. 2단계(이미지·음성 동기 도구)·3단계(영상·음악 비동기 작업)는 후속 PR.

## 1. 설정 모양
- 한 JSON 행(`settings.media.settings`, `MediaSettings` — `packages/shared/src/media.ts`): `kinds.{image,speech,music,video}.{enabled, model}`, `dailyCostLimitUsd`, `perRunLimits.{종류}`, `videoDefaultSec`. 2·3단계 도구는 `app.media.settings.get()`으로 읽는다. 종류를 하나 더하려면 `MEDIA_KINDS`·카탈로그 URL·기본값에 넣는다.
- 기본값: 모두 꺼짐·모델 없음(호출마다 비용), 하루 $50(사용자 결정), 실행당 이미지 4·음성 3·음악 1·영상 1(이슈), 영상 8초(사용자 결정). 음악은 처음부터 다른 종류와 같은 자리에 둔다(사용자 결정 "기본 포함") — 호출 방식은 3단계에서 가짜 서버로 먼저 확인한다.
- 켜려면 모델이 있어야 한다(형식 검사). 새로 켜거나 모델을 바꾸면 그 종류의 목록을 **그 자리에서 다시 받아** 확인한 뒤 저장한다 — 목록에서 사라진 모델을 저장하지 않기 위해서다. 끄기와 한도 변경은 OpenRouter 없이 된다(장애 중에도 끌 수 있어야 한다).

## 2. 카탈로그 출처
| 종류 | 출처 | 근거 |
|---|---|---|
| 이미지 | `/api/v1/images/models` | 공식 문서(이미지 생성): `supported_parameters` 기술자, 가격은 엔드포인트 기록 |
| 음성 | `/api/v1/audio/speech/models` | 공식 문서(TTS): 출력 모달리티의 `supported_parameters` |
| 영상 | `/api/v1/videos/models` | 공식 문서(영상 생성): `supported_durations`·`pricing_skus` |
| 음악 | `/api/v1/models?output_modalities=audio` | 전용 목록이 문서에 없음. Lyria(`google/lyria-3-*`)는 일반 모델 목록에 출력 `audio`로 있다 — 출력에 `audio`가 없는 항목은 버린다 |

응답은 너그럽게 읽는다(모양이 다른 항목은 건너뛰고 추측하지 않는다). 가격은 목록에 있을 때만 보이고 없으면 "목록에 없음". 목록 응답의 **정확한 필드**(특히 음성·이미지의 가격 위치, 음악 필터)는 실제 키로 확인하지 못했다 — 2단계 전에 관리자가 실제 목록을 한 번 열어 본다.

## 3. 키
- 관리자 키(암호화 저장) → `.env` `OPENROUTER_API_KEY` 순서, 요청마다 결정(`OpenRouterKeys`). 음성 전사 외부 대체도 같은 결정을 쓴다 — 키를 두 곳에서 따로 관리하지 않게.
- 저장 전 `/api/v1/key` 확인, 화면에는 끝 4자리와 남은 한도만. Cloudflare Access 토큰 등록(#36)과 같은 방식(호출 뒤 저장 직전 관리자 재확인, 쓰기는 한 번에 하나).

## 4. 비용과 사용량
- `usage_records` purpose `media`(텍스트 enum이라 마이그레이션 없음), runtime `openrouter`, `auth_type = api_key`, `priced_cost_micros` = OpenRouter가 알려 준 비용(가격표 없음). 그래서 기존 합계·오늘 비용 알림·월 예상에 그대로 들어간다. 생성마다 한 행(`<runId>#media:<callId>`), 같은 생성을 다시 쓰면 덮어쓴다.
- 하루 예산 `MediaBudget.remaining/allows`는 그 사람의 그날(서비스 시간대) `media` 행만 센다. 비용을 모르는 생성은 합에 넣지 않고 따로 센다 — 2단계에서 생성 직후 `/api/v1/generation?id=`로 비용을 채운다.

## 5. 청소년 계정과 요청 정책
- 숨기지 않는다(사용자 결정). 대신 모델이 moderation 값을 내놓으면 청소년 계정은 가장 엄격한 값을 보낸다(`moderationFor`). 값이 없으면 제공자 기본값. 정책은 고정(관리자 스위치 없음).
- 모든 요청에 `provider.data_collection: "deny"`(덮어쓸 수 없음), 나가는 글은 `carriesSecret` 검사. 영상은 ZDR이 지원되지 않아 `data_collection: deny`만 가능하다(이슈 본문).
