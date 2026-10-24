# ConText — AI 문서 작성

팀 문서의 버전·변경 맥락·provenance를 관리하고 자료를 바탕으로 문서를 작성하는 서비스다. 전체 방향은 [PROJECT_GOAL.md](PROJECT_GOAL.md), AI 작성 기능의 사용법은 [구현 가이드](docs/phase-9-writing.md)에 있다.

**AI 문서 작성:** 왼쪽 **AI 문서 작성**에서 요청을 입력하면 현재 워크스페이스의 문서·메모·최근 대화·기존 초안을 자동으로 찾아 ChatKHU가 초안을 만든다. Editor.js로 본문·제목·목록·표를 편집하고 문단별 출처를 확인한다. AI 수정안은 적용 전 비교할 수 있고, 저장·되돌리기·DOCX/HWPX 다운로드를 지원한다. [사용법과 구현 범위](docs/phase-9-writing.md)를 참고한다.

**Phase 8:** 문서 미리보기의 **내보내기** 탭에서 PDF·DOCX·TXT·Markdown으로 변환하고 다운로드한다. 과거 버전·진행 상태·실패 재시도·결과 재사용을 지원한다. 텍스트와 정규화 구조 중심이며 원본 이미지와 정밀한 배치는 재현하지 않는다. [사용법과 구조](docs/phase-8-conversion.md), [검증 기록](docs/phase-8-verification.md)을 참고한다.

**Phase 7:** pgvector 문서 색인·현재/과거/기준일 검색·출처를 포함한 워크스페이스 공유 AI 채팅을 추가했다. 왼쪽 **AI 채팅** 아이콘이나 오른쪽 **AI** 탭에서 채팅 패널을 펼친다. 패널을 접어도 대화와 작성 중인 질문이 유지된다. 왼쪽 메뉴는 아이콘 중심의 압축 모드로 접을 수 있다. [사용법과 구조](docs/phase-7-rag.md), [검증 기록](docs/phase-7-verification.md)을 참고한다.

**Phase 6:** 문단·단어 차이 표시, AI 변경 요약과 근거 링크, 유사도 기반 버전 후보 추천을 추가했다. [사용법·AI 설정](docs/phase-6-intelligence.md)과 [검증 기록](docs/phase-6-verification.md)을 참고한다. AI 요약·의미 유사도는 서버의 Mindlogic 키 설정이 필요하다. 일반 diff와 텍스트 유사도 추천은 키 없이 동작한다.

인증·private S3 저장·캔버스 위에 **PDF/DOCX/HWPX/TXT/Markdown 비동기 파싱, 공통 문서 구조, 본문 읽기와 재처리**를 구현했다. UI는 한국어·React Icons·화면 전체 격자·왼쪽 메뉴/실제 팀원·아이콘/드롭다운/드래그 업로드로 개편했다. 파일별 색상·아이콘, 중앙 텍스트 미리보기 모달, 참조 표시 숨기기, 소유자의 이메일 기반 팀원 추가를 지원한다. 페이지 스크롤은 없고 패널 내부만 스크롤한다. [Phase 4 사용·처리 구조](docs/phase-4-processing.md)를 참고한다. 기존 문서의 새 버전 업로드·수동 연결·버전 이력·현재 버전 지정·중복 탐지·본문 비교를 추가했다. [Phase 5 사용·구조 가이드](docs/phase-5-version-management.md)를 참고한다.

상단 연필 아이콘으로 캔버스 수정 모드에 들어가 크기 조절이 가능한 텍스트와 사각형·타원·삼각형 배경을 추가할 수 있다. 색상·글자 크기·위치가 자동 저장된다. 연결선은 수정 모드에서 눌러 바로 삭제하며 별도 문서 연결 메뉴는 사용하지 않는다. [캔버스 편집 가이드](docs/canvas-elements.md)를 참고한다.

AWS 설정과 API 계약은 [Phase 2 저장소 가이드](docs/phase-2-storage.md)를 참고한다. AWS 미설정 시 목록과 로그인은 사용 가능하며 업로드 요청은 503 안내를 반환한다.

## ConText 디자인

파랑 `#5B6CFF`과 보라 `#7C4DFF`를 중심으로 밝은 배경을 사용한다. [디자인 가이드](design/ConText-design-guide.md), [색상표·UI 샘플](design/ConText-palette.html), [실제 CSS 토큰](frontend/design/tokens.css)에 팔레트와 적용 규칙을 저장했다. 새 UI는 역할별 CSS 변수를 사용한다.

## 빠른 시작

웹 첫 화면(`/`)은 ConText 소개와 웹·데스크톱 시작 경로를 안내한다. **웹에서 시작하기**는 기존 로그인/워크스페이스 흐름으로 연결된다. 데스크톱 설치 파일은 현재 **배포 준비 중**으로 표시한다. [소개 페이지 구성과 다운로드 연결](docs/landing-page.md)을 참고한다.

필수: 실행 중인 Docker Desktop 또는 Docker Engine + Compose v2 이상.

```bash
cp .env.development.example .env.development
openssl rand -hex 24
```

출력값을 `.env.development`의 `POSTGRES_PASSWORD`에 넣는다. 현재 작업 환경에는 기존 개발 설정과 DB 비밀번호를 옮긴 `.env.development`가 이미 있다. 위 복사 명령은 새 환경에서만 실행하고 기존 파일은 덮어쓰지 않는다. 비밀번호를 hex로 만들면 DB URL에 별도 인코딩이 필요 없다.

```bash
docker compose --env-file .env.development up --build
```

이후에는 `docker compose --env-file .env.development up`으로 실행한다. PostgreSQL healthcheck → Alembic migration → FastAPI healthcheck 후 Next.js가 시작된다. Redis가 준비되면 worker와 dispatcher도 시작된다.

- 프런트엔드: http://localhost:3000
- API 문서: http://localhost:8000/docs
- DB 연결 확인: http://localhost:8000/health

Supabase 설정 전에도 개발 서비스와 로그인 페이지는 실행된다. Google 버튼은 비활성화되고 설정 안내를 표시한다. 실제 로그인에는 아래 외부 설정이 필요하다.

```bash
docker compose --env-file .env.development ps
docker compose --env-file .env.development logs -f backend frontend
docker compose --env-file .env.development down
```

DB는 named volume에 보존된다. `docker compose --env-file .env.development down -v`는 데이터를 삭제하므로 초기화할 때만 사용한다. 이 Compose는 localhost에만 포트를 노출하는 개발용 구성이다.

## 외부 설정 — 사용자가 해야 하는 작업

### 1. Supabase 프로젝트

1. 사용할 Supabase 프로젝트를 만들거나 선택한다. 애플리케이션 테이블은 Compose의 PostgreSQL에 생성되며 Supabase에는 만들지 않는다.
2. Project URL과 공개 publishable key 또는 legacy anon key를 확인한다. 공개 키를 아래 `NEXT_PUBLIC_SUPABASE_ANON_KEY` 변수에 넣는다. service_role/secret key는 사용하지 않는다.
3. Authentication → URL Configuration:
   - Site URL: `http://localhost:3000`
   - Redirect URLs: `http://localhost:3000/auth/callback`
4. Authentication → Providers에서 Google을 활성화한다. Email/Password와 Anonymous 로그인은 이번 서비스에서 사용하지 않는다.

### 2. Google OAuth

1. Google Cloud 프로젝트에서 OAuth 동의 화면을 설정한다. 테스트 모드라면 로그인할 계정을 테스트 사용자에 추가한다.
2. OAuth Client를 **Web application** 유형으로 만든다.
3. Authorized JavaScript origins에 `http://localhost:3000`을 추가한다.
4. Authorized redirect URI에는 Supabase Google Provider 화면의 callback URL을 넣는다. 일반적으로 `https://<project-ref>.supabase.co/auth/v1/callback`이다. 앱의 `/auth/callback`과 구분한다.
5. Google Client ID와 Client Secret을 **Supabase Google Provider 설정**에 저장한다. 앱 코드나 `NEXT_PUBLIC_*`에 Google Secret을 넣지 않는다.

[Supabase Google 로그인 공식 가이드](https://supabase.com/docs/guides/auth/social-login/auth-google), [Redirect URL 가이드](https://supabase.com/docs/guides/auth/redirect-urls).

### 3. 로컬 환경 변수 입력

아래 값은 루트 `.env.development`에 입력한다. 운영 값은 Vercel/Railway 환경 변수로 각각 관리한다. [배포 가이드](docs/production-deployment.md)를 참고한다.

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<public-publishable-or-anon-key>
SUPABASE_URL=https://<project-ref>.supabase.co
```

두 URL은 반드시 같은 프로젝트를 가리켜야 한다. ES256/RS256 signing key 프로젝트는 공개 JWKS로 검증하므로 `SUPABASE_JWT_SECRET`을 비워 둔다. 레거시 HS256 프로젝트만 해당 프로젝트 JWT secret을 백엔드의 `SUPABASE_JWT_SECRET`에 입력한다. 공개 anon key와 JWT secret은 다르다.

```bash
docker compose --env-file .env.development up -d --force-recreate backend frontend
```

로그인 페이지에서 Google 로그인 → 빈 목록 → Workspace 생성 → 상세 화면의 `OWNER` 표시를 확인한다. Supabase 공개 키·Google provider 활성화·JWKS 연결은 확인했다. 실제 사용자 계정의 Google 동의·로그인 완료는 별도 확인이 필요하다.

### 4. AWS S3 (Phase 2)

백엔드 환경에는 AWS_REGION, AWS_S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, S3_PRESIGNED_URL_TTL, MAX_UPLOAD_BYTES 항목을 사용한다. 개발 AWS 값은 입력됐고 실제 업로드·다운로드·CORS·익명 접근 차단 검사를 통과했다. 운영 환경은 별도로 설정한다. [버킷·IAM·CORS 설정 방법](docs/phase-2-storage.md#aws-설정--사용자가-해야-할-일)과 `infra/s3/`의 JSON 샘플을 사용한다.

## Architecture

```text
frontend/app/                 Next.js App Router, 서버 로그인 검사, OAuth callback
frontend/features/auth/       Google 로그인 / 로그아웃
frontend/features/workspace/  목록 / 생성 / 상세
frontend/features/documents/  업로드 / 본문 / 버전 이력·등록·비교 / 다운로드
frontend/features/canvas/     React Flow 문서 카드 / 좌표 자동 저장 / 관계 편집
frontend/lib/                 Supabase SSR·브라우저 클라이언트, Bearer API 호출
backend/app/api/              HTTP 계약
backend/app/auth/             JWT 인증과 멤버십·역할 dependency
backend/app/services/         사용자 provisioning, Workspace / Document transaction
backend/app/storage/          boto3 presigned PUT·GET 및 HEAD 검증
backend/app/models/           SQLAlchemy 모델
backend/app/schemas/          Pydantic 입력·응답
backend/app/db/               PostgreSQL session
backend/app/core/             환경 설정
backend/migrations/           Alembic migration
backend/tests/                PostgreSQL 통합 테스트 및 JWT 검증
```

Next.js 16 / React 19 / TypeScript, Python 3.12 / FastAPI / SQLAlchemy 2 / psycopg 3 / Alembic, PostgreSQL 17을 사용한다. 프런트엔드는 `package-lock.json`, Python은 직접 의존성 파일과 검증된 전이 버전 `requirements*.lock`을 함께 사용한다.

인증 흐름은 Google → Supabase → PKCE callback의 code 교환 → 쿠키 세션 → 브라우저 Bearer 요청 → FastAPI JWT 검증 → Application User 순서다. `proxy.ts`는 세션을 갱신하고 서버 layout은 `getUser()`로 로그인 상태를 검증한다. 브라우저의 `getSession()`은 토큰 전달에만 사용한다. 최종 데이터 접근 권한은 백엔드가 결정한다. [Supabase SSR 가이드](https://supabase.com/docs/guides/auth/server-side/creating-a-client).

JWT의 서명, 허용 알고리즘(ES256/RS256 또는 설정된 HS256), issuer, audience, exp, iat, UUID sub, authenticated role을 확인한다. 익명 토큰과 service_role 토큰은 거부한다. JWKS는 프로젝트 고정 URL에서 가져오며 캐시와 새 kid 조회를 지원한다. JWT 검증은 로컬 서명 방식이므로 이미 발급된 access token은 로그아웃 후에도 만료까지 유효할 수 있다. Supabase access-token lifetime 설정을 따른다.

첫 호출은 `auth_user_id` UNIQUE + PostgreSQL `ON CONFLICT DO NOTHING`으로 사용자를 생성한다. 동시에 `/me`와 목록을 요청해도 사용자 행은 하나다. 이메일은 식별키로 사용하지 않는다. 프로필 자동 동기화 및 편집은 이번 범위 밖이다.

## Database

Migration: `0001_foundation.py` → `0002_document_storage.py` → `0003_canvas_workspace.py` → `0004_document_processing.py` → `0005_version_management.py` → `0006_canvas_elements.py` → `0007_version_intelligence.py` (`backend/migrations/versions/`).

| 테이블 | 주요 필드 / 제약 |
|---|---|
| users | UUID id, UNIQUE auth_user_id, email, display_name, created_at, updated_at |
| teams | id, name, created_by → users, created_at, updated_at |
| team_members | id, team_id, user_id, role, created_at; UNIQUE(team_id, user_id) |
| workspaces | id, team_id, name, created_by, created_at, updated_at |
| workspace_members | id, workspace_id, user_id, role, created_at; UNIQUE(workspace_id, user_id) |
| documents | Workspace, 제목, 생성자, current_version_id, 멱등성 request ID |
| document_versions | 문서, 버전 번호, S3 bucket/key, 원본 파일명, MIME, size, SHA-256, 생성자·시간, status, upload_request_id, source_version_id, change_note |
| document_processing | 버전별 처리 상태, 실행 토큰, 재시도·리스, 정규화 산출물 |
| canvas_elements | Workspace, 텍스트/기본 도형, 위치·크기·색상·글자 크기, 작성·수정자 |
| document_positions | document_id, x/y, 최종 수정자·시간 |
| document_relations | Workspace, 출발/도착 문서, 관계 유형, 생성자·시간; 소속 복합 FK |

`member_role`은 PostgreSQL ENUM `OWNER / EDITOR / VIEWER`다. FK 및 사용자별 목록 조회 인덱스를 포함한다. `updated_at`은 SQLAlchemy 변경 시 갱신한다.

- `team_id`를 생략한 생성 요청은 새 Team과 Workspace, 두 OWNER 멤버십을 하나의 transaction으로 만든다.
- 기존 `team_id`를 지정하면 그 Team의 OWNER/EDITOR만 생성할 수 있다. VIEWER는 403, 비멤버/없는 Team은 404다.
- Team 멤버라는 이유만으로 Workspace 접근을 허용하지 않는다. WorkspaceMember가 직접 있어야 한다.
- OWNER는 이메일로 기존 가입자를 Workspace에 추가할 수 있다(VIEWER/EDITOR). 초대 메일은 발송하지 않는다. 새 Workspace 생성 시 새 Team을 만들며 기존 Team 사용은 API로 지원한다.
- 접근 불가 Workspace와 존재하지 않는 Workspace는 동일한 404를 반환한다.

```bash
docker compose --env-file .env.development exec backend alembic current
docker compose --env-file .env.development exec backend alembic check
docker compose --env-file .env.development exec backend alembic revision --autogenerate -m "describe change"
docker compose --env-file .env.development exec backend alembic upgrade head
```

마이그레이션은 모델의 `create_all()`로 대체하지 않는다.

## API

모든 `/api/*`는 `Authorization: Bearer <Supabase access token>`이 필요하다. `/health`와 OpenAPI 문서는 공개다.

| Method | Path | 동작 |
|---|---|---|
| GET | /api/me | 현재 Application User 조회 / 최초 provisioning |
| GET | /api/workspaces | 직접 가입된 Workspace와 역할 목록 |
| POST | /api/workspaces | Workspace 생성, 생성자 OWNER 등록 |
| GET | /api/workspaces/{workspace_id} | 멤버만 상세 조회 |
| GET | /api/workspaces/{workspace_id}/documents | 멤버의 문서 목록 |
| POST | /api/workspaces/{workspace_id}/documents/upload-url | OWNER/EDITOR의 새 문서/V1 업로드 발급 |
| GET | /api/documents/{document_id} | 문서 및 버전 metadata |
| POST | /api/documents/{id}/versions/upload-url | 기존 문서에 새 버전 업로드 발급 |
| POST | /api/documents/{id}/versions/link | 다른 문서의 검증된 버전 수동 연결 |
| PATCH | /api/documents/{id}/current-version | 현재 버전 지정 |
| GET | /api/workspaces/{id}/duplicates | SHA-256·크기로 동일 파일 조회 |
| GET | /api/documents/{id}/compare | 두 버전 메타데이터 비교 |
| POST | /api/versions/{version_id}/upload-url | 미완료 버전 업로드 재발급 |
| POST | /api/documents/upload-complete | S3 HEAD 검증 후 UPLOADED |
| POST | /api/versions/{version_id}/download-url | 멤버의 다운로드 발급 |
| GET | /api/versions/{id}/conversions | 버전별 변환 기록 |
| POST | /api/versions/{id}/conversions/{format} | PDF·DOCX·TXT·MD 변환 요청/재시도 |
| POST | /api/versions/{id}/conversions/{format}/download-url | 변환 파일 다운로드 발급 |
| GET | /api/workspaces/{id}/canvas | 문서·위치·관계 snapshot |
| PATCH | /api/workspaces/{id}/canvas/positions | OWNER/EDITOR의 문서 위치 부분 저장 |
| POST | /api/workspaces/{id}/relations | OWNER/EDITOR의 문서 관계 생성 |
| DELETE | /api/workspaces/{id}/relations/{relation_id} | OWNER/EDITOR의 관계 삭제 |

생성 body:

```json
{ "name": "Product team" }
```

기존 Team을 사용하려면 `team_id` UUID를 추가한다. 이름은 공백을 제거한 뒤 1~120자여야 한다. API가 임의의 `role` 등 추가 입력을 거부한다. 생성 응답은 201이고 `id`, `team_id`, `name`, `created_by`, `created_at`, `updated_at`, `role`을 반환한다.

오류: 인증 실패 401, 권한 부족 403, 접근 불가/없는 리소스 404, 입력 오류 422, 인증 미설정 또는 JWKS 장애 503. CORS는 `CORS_ORIGINS`의 정확한 origin만 허용한다.

## Frontend

- `/login`: Google 로그인, 미설정 및 실패 안내.
- `/auth/callback`: PKCE code 교환 후 `/workspaces` 이동. 실패 시 로그인 페이지. 외부 `next` URL을 사용하지 않는다.
- `/workspaces`: 현재 사용자, 목록, 빈 상태, Workspace 생성, 오류/재시도.
- `/workspaces/[workspaceId]`: 문서 캔버스·격자·드래그·키보드 이동·위치 저장·관계선·줌/팬. 문서 선택과 원본 다운로드, 기존 업로드·목록·재시도 패널. VIEWER는 원본을 편집할 수 없으며 읽기·AI 채팅·변환 내보내기를 사용할 수 있다.
- 공통 로그아웃과 서버 로그인 검사. 세션 변경 시 전체 탐색으로 기존 페이지 캐시를 비운다.

## Tests

최신 문서 변환 검증은 [Phase 8 검증 기록](docs/phase-8-verification.md)에 있다. 버전 관리 검증은 [Phase 5 검증 기록](docs/phase-5-verification.md), 후속 텍스트·도형 편집 검증은 [캔버스 편집 가이드](docs/canvas-elements.md)에 기록했다. [Phase 4 검증 기록](docs/phase-4-verification.md)도 보존했다. [Phase 3 기록](docs/phase-3-verification.md)도 보존했다. [Phase 2 및 실제 S3 검증](docs/phase-2-verification.md)도 확인할 수 있다. [Phase 1 기록](docs/phase-1-verification.md)도 보존했다.

실제 PostgreSQL의 **분리된 임시 DB**로 테스트한다. Supabase나 Google 계정 없이 실행할 수 있다. 테스트 토큰은 테스트 프로세스에서 매번 생성한 키로 서명하며 런타임 인증 우회는 없다.

```bash
docker compose --env-file .env.development -f docker-compose.yml -f docker-compose.test.yml --profile test run --build --rm backend-test
```

검증 범위: 모든 보호 API 미인증 차단, 잘못된 JWT/issuer/audience/만료/서명/role, ES256·RS256 JWKS와 키 회전·장애, 반복·동시 최초 로그인, 생성 및 두 OWNER 멤버십, 사용자 간 격리, Team/Workspace 역할, 이름 검증, transaction rollback, CORS, migration upgrade/downgrade 및 모델 일치.

브라우저 검사(호스트 Node.js 24와 Chrome 필요):

```bash
cd frontend
npm ci
npm run typecheck
npm run lint
npm run build
npm run test:e2e
npm run test:documents
npm run test:canvas
npm run test:phase4
npm run test:intelligence
npm run test:rag
npm run test:conversion
npm run test:elements
```

Playwright는 별도 포트 3100에서 인증 설정을 비운 Next.js 테스트 서버를 자동 실행한다. 데스크톱·모바일에서 로그인 안내, 경로 보호, 실패 callback을 검증한다. 실제 Google 동의 화면을 자동화하지 않는다. `test:documents`는 테스트 전용 인증 서버와 API/S3 응답으로 업로드·완료 재확인·파일 재시도·VIEWER UI·다운로드를 데스크톱/모바일에서 검증한다. `test:canvas`는 위치 저장/복원·실패 재시도·관계 CRUD·키보드/핸들 연결·VIEWER 제한을 검증한다. `test:versions`는 버전 이력·현재 버전 전환·새 업로드·재시도·수동 연결·비교·중복 경고를 검증한다. 모든 브라우저 테스트 명령은 3100 포트를 사용하므로 순서대로 실행한다.

테스트용 컨테이너 정리(개발 DB는 유지):

```bash
docker compose --env-file .env.development -f docker-compose.yml -f docker-compose.test.yml --profile test rm -sf test-postgres test-redis
```

## Docker 없이 개발

Python **3.12**와 Node.js **24**, PostgreSQL **17** + **pgvector 0.8.7**, Redis **7.4**를 사용한다. worker/dispatcher 로컬 실행은 [Phase 4 가이드](docs/phase-4-processing.md#실행과-설정)를 참고한다. 시스템 Python 3.9는 지원하지 않는다.

```bash
cd backend
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt -c requirements-dev.lock
```

`backend/.env`에 localhost용 `DATABASE_URL`, `SUPABASE_URL`, 필요 시 JWT secret 및 `CORS_ORIGINS`를 설정한다. 기존 PostgreSQL 컨테이너를 쓸 수 있다.

```bash
alembic upgrade head
uvicorn app.main:app --reload
```

`frontend/.env.local`에 `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_URL`을 설정하고 `npm ci && npm run dev`를 실행한다. 루트의 환경별 `.env.*` 파일은 Compose 입력이며 각 앱의 Docker 없는 로컬 실행에는 자동 전달되지 않는다.

로컬 pytest는 직접 준비한 비어 있는 DB에 `TEST_DATABASE_URL`을 설정한다. 이름이 `_test`로 끝나는 DB만 허용하며 테스트가 모든 앱 테이블 데이터를 지운다. 개발 DB URL을 사용하지 않는다.

## Environment 참고

웹 운영 배포는 **Vercel 프론트엔드 + Railway 백엔드**로 분리한다. 설정 순서와 변수 목록은 [운영 배포 가이드](docs/production-deployment.md)에 있다.

| 파일 | 용도 |
|---|---|
| `.env.development` | 기존 통합 개발 Compose 설정 |
| `.env.frontend.production.example` | 프론트 운영 이미지 검증용 템플릿. Vercel 변수 설정 참고 |
| `.env.backend.production.example` | 백엔드 운영 이미지 검증용 템플릿. Railway 변수 설정 참고 |
| `.env.frontend.production` / `.env.backend.production` | 두 운영 이미지를 로컬에서 개별 검증할 때 사용. Git 제외 |

실제 환경 파일은 Git에 포함하지 않는다. 기존 `.env.production`은 보존하며 새 분리 구성에서 자동으로 읽지 않는다. 필요한 값을 프론트/백엔드 파일이나 각 플랫폼 환경 변수로 옮긴다. OS 환경 변수는 env 파일보다 우선한다.

```bash
# 기존 통합 개발 환경
docker compose --env-file .env.development up -d

# 분리 구성 문법 확인: 값을 채운 환경 파일 사용
docker compose --env-file .env.frontend.production -f docker-compose.frontend.prod.yml config --quiet
docker compose --env-file .env.backend.production -f docker-compose.backend.prod.yml config --quiet
```

`docker-compose.frontend.prod.yml`에는 프론트엔드만 있고, `docker-compose.backend.prod.yml`에는 API·worker·dispatcher·migrate·PostgreSQL·Redis만 있다. 두 파일은 독립적으로 실행하며 개발 Compose와 합치지 않는다. Vercel에는 `frontend/`를 직접 배포하고, Railway에는 `/backend`를 소스로 서비스별 역할을 지정한다. 기존 단일 서버용 운영 Compose와 Caddy 설정은 이 구성으로 대체했다.

로컬 백엔드 Compose에서 `DATABASE_URL`을 비우면 `POSTGRES_*`로 내부 DB URL을 만든다. Railway에서는 DB 서비스의 내부 URL을 명시한다. 기존 DB volume의 비밀번호는 환경 파일만 바꿔도 자동 변경되지 않는다. `NEXT_PUBLIC_*`는 production build에 포함되므로 변경하면 프론트 재빌드/재배포가 필요하다.

## Remaining

Phase 8 문서 변환과 개발 환경 적용을 완료했다. 다음 계획은 Phase 9 AI-Native Workspace(워크스페이스 요약·문서 관계 제안·자동 정리·AI 문서 생성/편집·Knowledge Graph)다. 변환 품질 범위와 운영 한계는 Phase 8 사용 가이드에 정리했다.

## 별도 데스크톱 앱

기존 웹과 함께 사용할 수 있는 로컬 전용 ConText Desktop을 `apps/desktop`에 추가했다. 폴더 연결, 하위 파일·이미지 캔버스, 파일 이름 검색, 변경 감지, 미리보기, 원본 열기, SQLite 배치 저장과 재실행 복원을 지원한다.

```bash
cd apps/desktop
npm ci
npm run dev
```

웹과 독립적으로 실행하며 Docker나 로그인이 필요 없다. 원본 파일은 그대로 두고 배치만 저장한다. 데스크톱 AI 작성·문서 본문 파싱·클라우드 동기화는 후속 단계다. 실행 파일·사용법은 [데스크톱 안내](apps/desktop/README.md), 개발 범위와 후속 계획은 [데스크톱 목표](docs/desktop-plan.md)를 참고한다.
