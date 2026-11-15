# 구독 로그인 실제 계정 확인 (#18 완료 기준)

관리자가 실제 계정으로 한 번 확인하고 결과를 적는다. 자동 시험(`pnpm test`의 `subscription.test.ts`·`codex.test.ts`·`claude.test.ts`, `pnpm e2e`)은 가짜 토큰과 재생한 app-server로 흐름·권한·암호화·원문 비노출을 확인한다. 여기에는 실제 계정이 있어야만 되는 것 — 실제 로그인 완료, 실제 응답, 실제 만료·갱신 — 만 남긴다. **토큰·1회용 코드·쿠키는 적지 않는다.** 계정은 "관리자", "엄마"처럼 적고 이메일도 적지 않는다.

**사전 조건**

- 서버는 운영 빌드로 돈다(`pnpm build`, LaunchDaemon). 개발 모드(`FAKE_RUNTIME=1`)에서는 실제 로그인이 꺼져 있다.
- 서버 Mac에서 `auth.openai.com`, `chatgpt.com`, `api.anthropic.com`에 HTTPS로 나갈 수 있다.
- 로그 확인 명령: `jq -c 'select(.msg|startswith("connection."))' /Library/Logs/agentlee/server.log`

## 기록 양식

| 날짜 | 계정 | 항목 | 결과(✅/❌) | 메모(코드·이메일·토큰 금지) |
|---|---|---|---|---|
| | | | | |

## A. 관리자 Claude 구독 (장기 토큰)

1. [ ] 관리자 맥 터미널에서 `claude setup-token` → 브라우저에서 관리자 본인 Claude(Pro/Max) 계정으로 승인 → 토큰이 한 번 나온다(어디에도 저장하지 않는다).
2. [ ] 관리자로 설정 → 내 런타임 연결 → "Claude Code · 관리자 본인 구독 (claude setup-token)" → "본인 구독만 연결하세요…"와 `claude setup-token` 안내가 보인다 → 토큰 붙여 넣기 → "연결 추가".
3. [ ] 목록에 `구독 · ••••xxxx`만 보인다(토큰 전체 없음). "테스트" → `사용 가능`, 테스트 결과 "통과".
4. [ ] 새 대화에서 Claude Code로 메시지 → 스트리밍 응답이 온다. 관리자 화면·DB의 사용량 행은 토큰만 있고 `cost_usd`가 비어 있다(`sqlite3 data/agentlee.db "select runtime, input_tokens, output_tokens, cost_usd from usage_records order by id desc limit 1"`).
5. [ ] 아내·아들 계정의 설정 화면에는 Claude 구독 항목이 없다. 그 계정의 선택기(`/api/runtimes`)에 관리자 구독 연결이 없다.
6. [ ] **만료**: claude.ai → 설정에서 그 토큰을 취소(또는 만료까지 기다림) → 관리자 대화에서 메시지 → 오류로 끝나고 "Claude 구독 토큰이 만료됐어요 — `claude setup-token`으로…" 안내, 연결 상태 "다시 로그인 필요". 로그에 `connection.expired`(id·런타임만).
7. [ ] 새 토큰을 만들어 같은 연결의 키를 바꾸거나 새로 추가 → 테스트 → 다시 응답이 온다.
8. [ ] 연결 폴더(`data/runtimes/<연결 id>/`)와 로그에 토큰 원문이 없다: `grep -rF "<토큰 앞 12자>" data/runtimes /Library/Logs/agentlee/` → 결과 없음(검색 뒤 셸 기록에서 지운다).

## B. 가족 ChatGPT 로그인 (디바이스 코드, 1명 이상)

1. [ ] 가족 계정으로 설정 → 내 런타임 연결 → "Codex · 내 ChatGPT 계정으로 로그인" → 안내("본인 구독만 연결하세요…", 코드 안내)가 보이고 토큰 입력칸이 없다 → "ChatGPT로 로그인".
2. [ ] OpenAI 로그인 페이지 링크(`https://auth.openai.com/codex/device`)와 코드가 나온다. 링크를 열어 **그 가족 본인** ChatGPT 계정으로 로그인하고 코드를 넣는다.
3. [ ] 몇 초 안에 화면이 "○○ 계정으로 로그인했어요"로 바뀌고 자동 테스트 → `사용 가능`. 목록에는 계정 **이메일만** 보인다.
4. [ ] `ls data/runtimes/logins/` → 비어 있다. `find data/runtimes -name auth.json` → 결과 없음.
5. [ ] 새 대화에서 Codex로 메시지 → 스트리밍 응답. 사용량 행은 토큰만, `cost_usd` 비어 있음.
6. [ ] 다른 가족 계정의 선택기에 이 연결이 없다. 관리자 계정에도 없다.
7. [ ] **취소·시간 초과**: 다시 "ChatGPT로 로그인" → "취소" → "로그인을 취소했어요". 한 번 더 시작하고 15분 동안 아무것도 안 함 → "시간 안에 코드를 입력하지 않아…". 둘 다 연결이 생기지 않는다.
8. [ ] **토큰 갱신**: 하루 이상 지난 뒤(액세스 토큰 만료 후) 메시지 → 응답이 온다. 로그에 `connection.refreshed`가 있고, DB의 그 연결 `credential_version`이 올라갔으며 `credential_base_version`은 그대로다(`select credential_version, credential_base_version, status from connections where id='<연결 id>'`).
9. [ ] **만료**: chatgpt.com → 설정 → 보안 → 모든 기기에서 로그아웃(또는 Codex 접근 취소) → 메시지 → 오류로 끝나고 "ChatGPT 로그인이 만료됐어요 — ‘다시 로그인’을…" 안내, 상태 "다시 로그인 필요". 로그에 `connection.refresh_failed`(`errorCode: runtime_auth`)와 `connection.expired`.
10. [ ] "다시 로그인" → 2~3번과 같이 로그인 → 같은 연결이 `사용 가능`이 되고 다시 응답이 온다.
11. [ ] (가능하면) **한도**: 플랜 한도에 걸렸을 때 메시지 → "지금 이 런타임은 한도에 걸렸어요 — 다른 런타임으로 바꿔서 이어갈 수 있어요" 안내. 연결은 `사용 가능` 그대로.
12. [ ] 로그·DB·연결 폴더에 토큰·코드·이메일 원문이 없다: `jq -c 'select(.msg|startswith("connection."))'` 출력에 id·런타임·코드만, `grep -rF "@" /Library/Logs/agentlee/server.log | grep -c connection.` → 0.
13. [ ] 연결 해제 → `data/runtimes/<연결 id>/` 폴더가 없어지고, DB의 `secret`이 비어 있다.

## 결과

- 상태: **미실시(사용자 확인 대기)** — #18 PR은 자동 시험까지만 포함한다.
