# Phase 1 검증 결과

검증일: 2026-10-07 (Asia/Seoul).

| 검사 | 결과 |
|---|---|
| Docker Compose 실제 빌드/기동 | frontend, backend, postgres 기동; backend/postgres healthy |
| HTTP | `/login` 200, `/workspaces` 307 → `/login`, `/health` 200 |
| Backend pytest | PostgreSQL 17에서 39개 통과 |
| Migration | upgrade → downgrade(base) → upgrade(head), `alembic check` 통과 |
| Python Ruff | 정적 검사 및 format 통과 |
| Frontend TypeScript | `tsc --noEmit` 통과 |
| Frontend ESLint | 경고/오류 없이 통과 |
| Frontend production build | Next.js 16.4 build 통과 |
| Playwright | Chrome desktop / mobile viewport, 총 6개 통과 |

백엔드 테스트는 실제 PostgreSQL을 사용한다. JWT는 테스트 전용으로 생성한 키로 서명하고 ES256/RS256 JWKS fetch만 테스트에서 대체한다. 테스트용 DB는 개발 DB와 분리되어 있다. Docker의 runtime에는 테스트 토큰이나 인증 우회 코드가 설정되지 않는다.

Playwright 테스트는 Supabase가 미설정된 별도 프런트엔드 서버에서 로그인 안내, 루트·목록·상세의 비로그인 차단, 실패 callback 및 외부 redirect 무시, 모바일 가로 넘침을 검증한다. 로그인 후 Workspace UI 전체 흐름이나 Google OAuth 성공을 자동 검증한 것은 아니다. 실제 프로젝트 자격 증명과 계정 동의가 필요한 Google 로그인 성공 확인은 README 외부 설정 이후 수행해야 한다.

## 의존성 검토

`npm audit --omit=dev` 결과 런타임 의존성 취약점 0개다.

`npm audit`에서 개발용 `eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch → braces` 경로의 advisory 한 건이 관련 패키지 5개에 high로 집계되었다. 설치 당시 최신 braces 3.0.3까지 영향 범위에 포함되고 호환 가능한 수정 릴리스가 없었다. Next.js를 과거 major로 강제 내리는 자동 수정은 적용하지 않았다. 외부에서 제공한 glob 패턴을 lint 도구에 전달하지 않으며, 이후 upstream 패치가 나오면 개발 의존성을 갱신해야 한다.

테스트에는 Starlette TestClient의 AnyIO API deprecation warning 1개가 남는다. 모든 검증은 성공했다.

## Supabase / Google OAuth 설정 점검 — 2026-10-07

개발 환경에 입력한 실제 설정으로 다음을 확인했다. 자격 증명 값은 기록하지 않는다.

- 프런트엔드와 백엔드 Supabase URL 일치.
- 공개 anon 키가 Supabase Auth settings API에서 정상 수락됨.
- Google Provider 활성화 확인.
- OAuth authorize 요청이 Google 계정 로그인으로 302 이동함.
- Google OAuth callback이 해당 Supabase `/auth/v1/callback`과 일치.
- 브라우저의 `Continue with Google` 클릭으로 실제 Google 로그인 화면 표시.
- backend/frontend 컨테이너를 새 환경 값으로 재생성함.
- 실행 중인 백엔드에서 ES256 JWKS 조회 성공.

사용자의 실제 Google 계정 로그인 및 동의 완료 이후 앱 callback, Application User 등록, Workspace 조회 검증은 아직 진행하지 않았다. 이전 테스트 기록의 실제 로그인 미검증 상태는 이 마지막 단계에 해당한다.

현재 개발 실행 명령은 `docker compose --env-file .env.development up -d`를 사용한다.
