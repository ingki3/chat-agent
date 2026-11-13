# 결정 기록 — 가족 공유 투영 (#29)

## 결론
공유받은 사람이 보는 것은 **함수 하나**가 정한다: `SharePolicy.project(share, viewerId)`(`apps/server/src/shares/projection.ts`). 공유받은 사람에게 무언가를 내보내는 경로는 모두 이 함수의 결과(`Projection`)만 쓴다. 저장소(`ConversationStore`·`FileStore`·`ArtifactStore`·`SourceStore`)를 직접 읽어 공유받은 사람에게 보내면 안 된다.

- `project`는 다음 경우에 `null`이다.
  - 공유가 꺼졌다.
  - 그 사람에게 닿지 않는다: 가족 전체도 아니고 고른 계정도 아님, 비활성 계정, 주인 본인.
  - **주인 계정이 비활성이다**(리뷰 #117). 공유는 해제가 아니라 멈춘 상태이므로, 계정을 다시 활성화하면 그대로 돌아온다.
- 나머지는 `project`를 조합하기만 한다.
  - `conversationView`·`artifactView`: 한 사람에게 닿는 여러 공유를 합친다.
  - `viewers`: 권한 검사(#10)의 `sharedWith`를 채운다.
  - `bundle`: 공유 화면 하나 분량의 묶음.
- 이 함수들은 투영을 새로 계산하지 않는다.
- 모양 바꾸기도 한곳에서 한다.
  - `projectPart`·`projectEvent`·`message`: `reasoning` 파트는 빼고, `tool_result`는 자리만 남기고 `output`을 지운다. 그래서 파트 번호는 주인 화면·실시간 스트림과 같다.
  - SSE `tool_end`는 `output` 없이 보낸다.

## 무엇이 들어가나 (#3 부분 공유 결정)
- **snapshot**("이 메시지까지"): 공유할 때 한 번 계산해 `share_snapshots`에 저장하고 다시 바꾸지 않는다(DB 트리거가 UPDATE를 거부한다). 목록은 다음과 같다.
  - **메시지**: 경계 메시지까지의 활성 메시지(id·revision).
  - **파일**: 그 메시지들에 붙었거나 그 메시지들이 만든 파일(`files.message_id`, id·sha256).
  - **아티팩트 버전**: 그 메시지들의 run이 쓴 버전. 버전의 `run_id`에서 run을 거쳐 답 메시지로 이어지는 것만 넣는다. 되돌리기 사본은 메시지가 만든 것이 아니므로 뺀다.
  - **인용**: 그 run들의 인용(id, 인용 구절 해시).
  - **출처**: 그 인용들이 가리키는 출처(id, 본문 해시).
- 경계 **이후** 메시지가 만든 파일·버전·출처는 공유 **전에** 있었어도 빠진다.
- 공유 **후에** 생긴 것은 목록에 없으므로 403이다. 새 업로드, 새 버전, 경계 안 메시지의 수정본(새 메시지 id)이 모두 그렇다.
- 수정으로 활성에서 빠진 원래 메시지와 그 파일은 목록에 남아 그대로 보인다.
- 답을 쓰는 중인 메시지가 목록에 들어가면 공유를 거부한다(409 `share_run_in_progress`). 끝난 뒤에 바뀔 수 있기 때문이다.
- **문서 파일**: 대화 공유도 투영에 실제로 들어간 `document` 버전이 가리키는 파일(같은 대화의 것)을 함께 연다(리뷰 #117 2차). 예를 들어 되돌리기로 만든 버전의 파일은, 그 파일을 만든 답이 잘려 나갔어도 열린다. 지나간 모든 버전의 파일을 넣지는 않는다. snapshot은 메시지 경계 규칙을 그대로 따르므로, 스냅샷에 든 버전의 파일만 열린다.
- **live**: 요청할 때마다 같은 규칙으로 계산한다. 경계가 없으므로 지금의 활성 메시지가 모두 들어가고, 새 메시지도 들어간다. 보이는 아티팩트의 되돌리기 사본도 포함한다. reasoning과 도구 원본 결과는 여기서도 빠진다.
- **아티팩트 공유**(FR-14.4)
  - 그 아티팩트만 보인다. 대화·메시지·run은 열리지 않는다.
  - live는 모든 버전, snapshot은 공유할 때 있던 버전만이다.
  - `document` 아티팩트는 보이는 버전이 가리키는 생성 파일(같은 대화의 것)만 함께 열린다(리뷰 #117). snapshot이면 스냅샷 버전의 파일만이다. 같은 대화의 다른 파일은 열리지 않는다. 파일 검사는 `fileView`로 대화 공유와 아티팩트 공유를 함께 본다.
- 출처는 공유된 메시지가 인용한 것만 보인다. 가져오기만 하고 인용하지 않은 페이지나 대화의 전체 출처 목록은 보이지 않는다.

## 경로별 연결 상태
"연결됨"은 공유받은 사람의 요청이 투영을 거친다는 뜻이다. 권한 검사 `sharedWith`는 `viewers` → `project`, 응답 자르기는 `viewOf`/`bundle` → `project`를 거친다.

| 경로 | 상태 |
|---|---|
| `GET /api/conversations/:id` (설정·알림 칩·예약 "새 결과" 표시는 빼고) | 연결됨 |
| `GET /api/conversations/:id/messages` · `…/messages/:messageId/versions` | 연결됨 |
| `GET /api/conversations/:id/active-run` · `GET /api/runs/:id` · `GET /api/runs/:id/events` (SSE, `projectEvent`) | 연결됨 |
| `GET /api/conversations/:id/files` · `GET /api/files/:id` · `GET /api/files/:id/content` (원본·다운로드·`?inline=1`) | 연결됨 |
| `GET /api/conversations/:id/artifacts` · `GET /api/artifacts/:id` · `…/versions/:version` | 연결됨 |
| `GET /a/:id` · `/a/:id/v/:version/raw` · `/download` · `/png` · `/pdf` (내보내기) | 연결됨 |
| `GET /api/conversations/:id/sources` | 연결됨 (인용된 출처만) |
| `GET /api/shares/:id/view` · `GET /api/shared-with-me?q=` (검색) | 연결됨 (`bundle`·`search`) |
| `GET /api/shares/:id/events` (해제 알림 SSE) | 연결됨 (`targets` + `watchAccess`) |
| `GET /api/artifacts/:id/access?version=n` (아티팩트 화면의 접근 SSE — `/a/:id`·패널) | 연결됨 (주인은 `owner` 후 바로 종료. 공유받은 사람은 아티팩트를 볼 수 없게 되면 `revoked`, 아티팩트는 아직 보이지만 화면의 버전이 빠지면 `scope {versions}`) |
| `GET /api/files/:id/extract` (#48 추출 글) | 연결됨 (`/content`와 같은 검사 — `p.files`의 파일만). 파일 도구(`file_list`·`file_read`·`file_cite`)는 run 안에서만 돌고 run은 주인만 만든다 — 해당 없음 |
| `GET /api/conversations/:id/references` · `…/references/download` (#26) | 연결됨 (투영의 메시지와 그 출처만 — `ReferencesView`. `.docx`는 작업자가 끝난 뒤 투영을 다시 읽어, 그사이 철회되면 403·좁아지면 다시 만든다) |
| 포크 "이어서 대화하기" (#52) | 미연결 — 다음 이슈. `bundle(share, p)`를 복사한다(메시지·파일·버전·출처 모두 투영된 것만) |
| 대화 목록 검색 `GET /api/conversations?q=` | 해당 없음 — 본인 대화만 |

## 쓰기·런타임·MCP
- 정책(`can`)은 공유받은 사람에게 `read`만 준다. 쓰기·삭제·공유 API는 모두 403이다(권한 행렬의 "shared" 열).
- `RunManager.begin`도 대화 주인이 아니면 거부한다(`NotConversationOwnerError`). 그래서 공유받은 사람에게는 run이 생기지 않고, run에만 발급되는 MCP 토큰도 생기지 않는다.

## 해제·대상 변경
- 해제(`DELETE /api/shares/:id`), 대상 변경(`PATCH`), 대화 삭제, **주인 계정의 접근 변경(비활성화 등)**은 권한 변경 이벤트를 낸다(#10 `resource-access-changed`, `scope` = 대화 id). 주인 계정의 경우 그 주인의 켜진 공유마다 하나씩 낸다.
- `watchAccess`는 같은 대화(`ResourceRef.scope`)의 모든 열린 스트림(run 이벤트, 공유 이벤트)을 다시 검사하고, 접근이 없어진 스트림을 닫는다.
- 다음 요청부터는 투영이 `null`이라 403이다.
- 이미 내려받은 파일과 포크 사본은 되돌리지 않는다. 문구 `SHARE_REVOKE_NOTICE`(공유 화면·해제 직후).

## 공유 대상
- 가족 계정만 대상이 된다(FR-14.7).
- 요청 스키마는 계정 id(UUID)만 받고 다른 키를 거부한다(strict). 이메일은 어디에서도 받지 않는다.
- 서버는 이 서버의 활성 계정인지, 주인이 아닌지 다시 확인한다(400 `invalid_share_target`).
- `GET /api/share-targets`는 id와 이름만 준다.
- 고른 계정이 0명인 `users`는 서버가 거부한다(400). 화면에서 마지막 사람의 체크를 풀어도 "가족 전체"로 바뀌지 않는다. 고르는 중인 상태로 남고 저장 버튼이 꺼진다. "가족 전체"는 직접 골랐을 때만 된다.

## 새 경로를 붙일 때
공유받은 사람에게 보내는 새 읽기 경로는 다음을 지킨다.
1. 리소스 로더의 `sharedWith`를 `sharedWith(app, conversationId, test)`로 채우고 `scope`를 둔다.
2. 핸들러에서 `viewOf(app, req, …)`로 투영을 받는다. 주인이면 `undefined`, 사라졌으면 `null`(403)이다.
3. 투영에 있는 것만, `SharePolicy`의 모양 바꾸기 함수로 내보낸다.
   - 공유된 내용을 오래 띄워 두는 화면이라면 접근 SSE를 따른다(`useAccessLost`, 공유 화면은 `/api/shares/:id/events`). 접근이 사라지면 프레임과 캐시를 지우고 `SHARE_REVOKE_NOTICE`를 보인다.
4. 권한 행렬(`apps/server/test/helpers/permission-matrix.ts`)에 행을 더한다.
5. `apps/server/test/shares.test.ts`의 "every read path matches the projection list"에 그 경로를 더한다.
