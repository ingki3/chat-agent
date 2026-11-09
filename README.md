# Agent Lee

가족용 에이전트 채팅 서비스. 요구사항은 [`PRD.md`](PRD.md), 구현 순서는 로드맵 이슈 #60을 본다.

## 요구 사항

- Node 22.12 이상, pnpm 10 (`corepack enable`)

## 설치와 실행

```bash
pnpm install
cp .env.example .env   # 필요하면 값 수정 (HOST는 루프백 주소만 허용)
pnpm keygen            # 운영 전 1회: 인증 정보 암호화 마스터 키 생성 (docs/ops.md)

pnpm dev               # 개발: http://localhost:3000 (UI + API 한 포트, Vite HMR)
pnpm build && pnpm start   # 운영 빌드 실행: http://localhost:3000
```

외부 접속은 Cloudflare Tunnel(`https://chat.2prostream.com`)로만 한다. 서버는 `127.0.0.1`에만 바인딩하며, 루프백이 아닌 `HOST`는 시작할 때 거부된다.

## 구조

| 경로 | 내용 |
|---|---|
| `apps/server` | Fastify 서버. API·SSE와, 운영에서는 `apps/web/dist` 정적 파일 + SPA fallback, 개발에서는 Vite 미들웨어 |
| `apps/web` | React + TypeScript (Vite) SPA |
| `packages/shared` | 서버·웹이 함께 쓰는 zod 스키마와 타입 |
| `packages/mcp-tools` | 두 런타임이 함께 쓰는 공통 MCP 서버 (#43, #21) |
| `apps/server/drizzle` | SQLite 마이그레이션 (`pnpm db:generate`로 생성, 시작 시 자동 적용) |
| `docs/` | 운영(`ops.md`), 추적표, 수용 시험 규격, 결정 기록 |
| `spike/` | 스파이크 코드 (워크스페이스에 포함하지 않음) |
| `mockup/` | 클릭 가능한 UI 목업 |

## 검사

```bash
pnpm lint          # ESLint
pnpm typecheck     # tsc --noEmit (모든 패키지)
pnpm test          # Vitest
pnpm format:check  # Prettier
```

## 작업 규칙

`feature → dev → main`, PR로만 머지한다. PR 설명에는 관련 이슈와 기준 PRD 버전을 적는다.
