# Phase 1 Foundation 구현 계획

## 시작 상태

- `PROJECT_GOAL.md`만 존재한다. 기존 코드, 의존성, 환경 변수, Docker, DB, API, 프런트엔드는 없다.
- Git 저장소는 초기화되어 있지 않다. 목표 문서는 보존한다.
- 프로젝트 전체는 문서 버전과 provenance를 중심으로 발전하지만 이번 범위는 인증 및 Workspace 기반이다.

## 구현 방향

- `frontend/`: Next.js App Router, React, TypeScript, Supabase JS/SSR. Google PKCE 로그인, 쿠키 세션 갱신, 보호된 Workspace 목록/상세 화면.
- `backend/app/`: FastAPI, SQLAlchemy 2, psycopg, Pydantic Settings, PyJWT/cryptography. API / 인증 / 권한 / 서비스 / 모델 분리.
- `backend/migrations/`: Alembic 명시적 초기 migration.
- PostgreSQL: UUID PK, timezone timestamp. users(auth_user_id UNIQUE), teams, team_members(team_id/user_id UNIQUE), workspaces, workspace_members(workspace_id/user_id UNIQUE). 역할은 OWNER/EDITOR/VIEWER enum.
- 인증: Supabase Google → PKCE callback → 세션 → Bearer JWT → 서명/issuer/audience/만료/사용자 claim 검증 → auth_user_id 기반 atomic upsert.
- 권한: WorkspaceMember를 최종 기준으로 공통 dependency에서 검사. 기존 Team에 Workspace 생성은 Team OWNER/EDITOR만 허용. team_id 생략 시 새 Team과 두 OWNER 멤버십을 하나의 transaction으로 생성.
- 연결: 브라우저에서 갱신된 Supabase access token으로 FastAPI 호출. CORS origin은 환경 변수로 명시한다. 서버 페이지에서도 로그인 검사.
- Docker: frontend/backend/postgres, DB healthcheck 이후 migration과 API 실행. 외부 인증 미설정 시 로그인은 설정 안내를 표시한다.
- 검증: 실제 PostgreSQL에서 migration 및 API/권한/JWT 테스트, TypeScript 및 production build, 가능한 Docker 및 브라우저 실행 확인.

## 주요 파일

`docker-compose.yml`, `.env.example`, `README.md`, 각 서비스 Dockerfile 및 lockfile, `backend/app/main.py`, `backend/app/auth/`, `backend/app/models/`, `backend/app/services/`, `backend/tests/`, `frontend/app/`, `frontend/features/`, `frontend/lib/`.

## 범위 제한

제공된 세부 Phase 1 지침을 우선한다. Redis/worker, S3, 문서 모델, RAG/pgvector, AI, 문서 변환, Canvas, 초대 API는 구현하지 않는다. 실제 Supabase 프로젝트와 Google OAuth 자격 증명은 외부 설정이 필요하다.
