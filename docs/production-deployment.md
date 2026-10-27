# Vercel + Railway 배포

프론트엔드는 Vercel, 백엔드는 Railway에 독립적으로 배포한다. 브라우저가 Railway의 공개 API 주소를 직접 호출하며, TLS와 도메인은 각 플랫폼에서 관리한다.

| 대상 | 플랫폼 | 소스 Root Directory | 실행 |
|---|---|---|---|
| Next.js 프론트엔드 | Vercel | `frontend` | Next.js 빌드/호스팅 |
| FastAPI API | Railway | `/backend` | Dockerfile 기본 명령 |
| Celery worker | Railway | `/backend` | 아래 worker 명령 |
| dispatcher | Railway | `/backend` | `python -m app.processing.dispatcher` |
| PostgreSQL + pgvector | Railway | DB 템플릿 또는 `/infra/postgres` | 영속 DB |
| Redis | Railway | Redis 서비스 | 작업 큐 |

`docker-compose.frontend.prod.yml`과 `docker-compose.backend.prod.yml`은 각각 운영 이미지의 로컬 검증용이다. Railway는 Compose 서비스 가져오기도 지원하지만, 이 가이드는 API의 배포 전 마이그레이션과 worker 역할을 명확하게 지정하는 서비스별 설정을 기준으로 한다. 두 파일을 합치거나 기존 개발용 Compose와 섞지 않는다. 단일 서버용 Caddy 구성은 제거했다.

## 1. Railway 백엔드

같은 저장소에서 API, worker, dispatcher 서비스 세 개를 만든다. 세 서비스 모두 Root Directory를 `/backend`로 지정하고 Dockerfile 빌드를 사용한다. `backend/Dockerfile`의 마지막 단계는 `production`이므로 일반 사용자로 실행하며 hot reload를 사용하지 않는다. 기존 개발 Compose는 `development` 단계를 명시적으로 선택하므로 그대로 사용할 수 있다.

서비스별 Settings는 다음과 같이 설정한다.

| 설정 | API | worker | dispatcher |
|---|---|---|---|
| Root Directory | `/backend` | `/backend` | `/backend` |
| Dockerfile | `Dockerfile` | `Dockerfile` | `Dockerfile` |
| Start Command | 비워 두기: 이미지 CMD 사용 | `celery -A app.processing.worker:celery worker --loglevel=INFO --concurrency=1` | `python -m app.processing.dispatcher` |
| Pre-deploy Command | `alembic upgrade head` | 없음 | 없음 |
| Healthcheck Path | `/health` | 없음 | 없음 |
| Public Domain | 생성 | 불필요 | 불필요 |
| Replicas | 우선 1 | 우선 1 | 1 |

API는 Railway가 주입하는 `PORT`에서 수신한다. Pre-deploy가 실패하면 API 배포가 진행되지 않는다. 최초 배포에서는 DB·Redis 준비 → API 마이그레이션과 healthcheck 확인 → worker·dispatcher 시작 순서로 진행한다. API만 배포하면 문서 파싱·색인·일부 AI/변환 작업이 처리되지 않는다. worker에는 기존 로컬 구성과 같이 최소 1GB 수준의 메모리를 배정하고 실제 문서 처리량에 맞춰 조정한다.

최근 Railway 문서에서 기존 `railway.json`/`railway.toml` Config as Code는 폐기 예정으로 안내되므로 새로 추가하지 않았다. 위 값을 Railway 서비스 Settings에서 지정한다. [모노레포 설정](https://docs.railway.com/deployments/monorepo), [Dockerfile 빌드](https://docs.railway.com/builds/dockerfiles), [배포 전 명령](https://docs.railway.com/deployments/pre-deploy-command).

### DB·Redis와 환경 변수

PostgreSQL에는 `vector` 확장이 있어야 한다. pgvector를 포함하는 DB 템플릿을 사용하거나 기존 `/infra/postgres` Dockerfile로 DB 서비스를 빌드한다. 직접 빌드한다면 `/var/lib/postgresql/data`에 Railway Volume을 연결하고 `POSTGRES_USER`, `POSTGRES_DB`, `POSTGRES_PASSWORD` 및 내부 연결용 `DATABASE_URL`을 설정한다. 앱 마이그레이션이 `vector` 확장을 생성하므로 해당 권한도 필요하다. DB 비밀번호를 hex로 만들면 연결 URL에 별도 인코딩 없이 사용할 수 있다.

Redis는 같은 프로젝트의 Redis 서비스를 사용한다. API·worker·dispatcher 세 서비스에 아래 환경 변수를 동일하게 연결한다. 서비스 이름이 `Postgres`, `Redis`일 때 참조 예시는 다음과 같다.

```dotenv
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_JWT_AUDIENCE=authenticated
CORS_ORIGINS=["https://<your-app>.vercel.app","https://<your-custom-domain>"]
WEB_BASE_URL=https://<your-app>.vercel.app
SYNC_MAX_WORKSPACE_BYTES=2147483648
SYNC_SESSION_HOURS=24
```

실제 운영 origin만 CORS 배열에 넣고 사용하지 않는 예시 도메인은 지운다. `DATABASE_URL`/`REDIS_URL`은 Railway 내부 네트워크 연결 주소를 사용한다. `postgres`/`redis`라는 Compose 서비스 이름이나 `localhost`는 Railway 설정에 쓰지 않는다. DB의 기본 `postgresql://` URL은 앱에서 psycopg 드라이버 URL로 정규화한다.

레거시 HS256 Supabase 프로젝트에서만 `SUPABASE_JWT_SECRET`을 넣는다. ES256/RS256 프로젝트는 공개 JWKS를 사용한다. 나머지 `AWS_*`, `MINDLOGIC_*`, AI 모델·처리 옵션은 `.env.backend.production.example`의 항목을 참고해 실제 사용하는 값만 설정한다. 서버 비밀값은 Vercel 프론트엔드에 전달하지 않는다.

## 2. Vercel 프론트엔드

저장소를 가져오고 Root Directory를 `frontend`, Framework Preset을 `Next.js`로 선택한다. `frontend/vercel.json`에 `npm ci`와 `npm run build`를 지정했다. Output Directory는 Next.js 기본값을 사용한다. Vercel에서는 프론트 Dockerfile이나 Compose 실행 명령을 설정하지 않는다. [Next.js 배포](https://vercel.com/docs/frameworks/full-stack/nextjs), [모노레포 Root Directory](https://vercel.com/docs/monorepos).

Vercel Environment Variables에 아래 값을 설정한다.

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<public-publishable-or-anon-key>
NEXT_PUBLIC_API_URL=https://<api-service>.up.railway.app
APP_ORIGIN=https://<your-app>.vercel.app
DESKTOP_MAC_DOWNLOAD_URL=
DESKTOP_WINDOWS_DOWNLOAD_URL=
```

`NEXT_PUBLIC_API_URL`은 API origin까지만 넣는다. 프론트가 `/api`를 붙이므로 `/api` 경로와 마지막 `/`를 넣지 않는다. `APP_ORIGIN`은 로그인 후 돌아올 프론트 주소이며, 커스텀 도메인을 사용하면 해당 주소로 설정한다. Supabase URL은 Railway의 `SUPABASE_URL`과 같은 프로젝트여야 한다. 설치 파일 주소가 없으면 데스크톱은 배포 준비 중으로 표시한다.

`NEXT_PUBLIC_*`는 빌드에 포함되므로 변경 후 재배포한다. 다운로드 주소 같은 서버 환경 변수도 Vercel에서는 변경을 적용할 새 배포가 필요하다. [Vercel 환경 변수](https://vercel.com/docs/environment-variables).

Preview 배포를 쓰면 운영과 별도 변수 범위를 사용한다. `APP_ORIGIN`을 운영 주소로 공유하면 Preview OAuth 콜백도 운영으로 돌아가므로 Preview에서는 해당 주소를 설정하거나 값을 생략해 요청 origin을 사용한다. Preview에서 사용하는 origin은 별도 백엔드 CORS와 Supabase Redirect URL에도 등록한다.

## 3. 인증·업로드 도메인 연결

- Supabase Site URL: 실제 Vercel/커스텀 프론트 주소.
- Supabase Redirect URLs: 해당 프론트 주소의 `/auth/callback`.
- Railway `CORS_ORIGINS`: 해당 프론트 origin의 JSON 배열.
- S3 버킷 CORS: 실제 프론트 origin 허용. 업로드/다운로드는 기존 presigned URL 흐름을 사용한다.
- Google OAuth의 redirect URI: 기존과 같이 Supabase Provider의 callback URL.

API 도메인과 프론트 도메인이 다르므로 CORS 설정이 필요하다. Caddy나 Vercel rewrite 없이 브라우저가 Railway API를 직접 호출하는 구성을 사용한다.

## 로컬에서 두 운영 이미지 검증

새 환경에서만 예시 파일을 복사하고 실제 값은 필요한 항목만 입력한다. 기존 실제 환경 파일은 덮어쓰지 않는다. 이전에 사용한 `.env.production`은 자동으로 읽지 않으므로 필요한 값을 새 파일 또는 플랫폼 Variables로 옮긴다.

```bash
cp .env.backend.production.example .env.backend.production
cp .env.frontend.production.example .env.frontend.production

# 백엔드: DB·Redis → 마이그레이션 → API·worker·dispatcher
# POSTGRES_PASSWORD, SUPABASE_URL 등을 입력한 뒤 실행
# API는 http://localhost:8000, 프론트 origin은 기본 http://localhost:3000

docker compose --env-file .env.backend.production -f docker-compose.backend.prod.yml up -d --build

# 프론트: Supabase 공개 값과 브라우저에서 접근할 API 주소 입력

docker compose --env-file .env.frontend.production -f docker-compose.frontend.prod.yml up -d --build
```

프론트 Compose에는 백엔드 서비스나 `depends_on`이 없다. API는 브라우저에서 접근하는 공개 주소로 연결한다. 로컬 API 포트를 바꾸면 프론트 `NEXT_PUBLIC_API_URL`도 바꾸고 프론트를 다시 빌드한다. 프론트 origin을 바꾸면 프론트 `APP_ORIGIN`과 백엔드 `CORS_ORIGINS`를 맞춘다.

개발용 `docker-compose.yml`과 동시에 실행하려면 `FRONTEND_PORT`, `BACKEND_PORT`를 다른 값으로 설정한다. 두 운영 검증 파일은 서로 다른 프로젝트 이름과 볼륨을 사용한다. 백엔드 종료 시 `down -v`는 DB·Redis 데이터를 지우므로 운영 데이터에는 사용하지 않는다. 마이그레이션 전에 DB를 백업하며 이미지 롤백만으로 DB 스키마가 되돌아가지는 않는다.
