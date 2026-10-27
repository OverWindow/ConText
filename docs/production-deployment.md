# 통합 워크스페이스 운영 배포 — Vercel + Railway

2026-10-27. 웹과 데스크톱의 변경은 **Node `/v2` API 하나**로 들어간다. PostgreSQL에는 공통 상태와 작업 큐를, S3에는 비공개 원본과 변환 파일을 저장한다. Python은 계정·AI 연결과 인증된 문서 처리를 맡는다.

이 문서는 배포 가능한 소스·이미지·환경 설정을 설명한다. 실제 Railway/Vercel 프로젝트 생성, 운영 도메인 연결, 운영 DB 마이그레이션, 실제 AWS 파일 쓰기는 아직 수행하지 않았다. 실제 입력이 비어 있으면 검증기가 실패하므로 성공으로 오인하지 않는다.

## 1. 비공개 환경 파일 준비

Node 24 이상을 사용한다. 저장소 루트에서 실행한다.

```sh
node scripts/deploy/init.mjs
node scripts/deploy/check.mjs
```

init은 **없는 파일만** 만들며 기존 환경 파일과 암호화 키를 교체하지 않는다. 새 backend 파일에는 독립 DB 비밀번호·Node/Python 내부 토큰·Fernet 암호화 키를 생성하고, 기존 frontend 파일의 공개 Supabase 설정과 웹 origin을 가져온다. 파일 권한은 0600이고 Git에서 제외한다. 키를 잃거나 바꾸면 기존 개인 AI 키를 복호화하지 못하므로 별도로 안전하게 보관한다.

기본 파일은 `.env.backend.production`과 `.env.frontend.production`이다. 다른 파일을 검사하려면 두 경로를 순서대로 전달한다. checker는 누락된 **항목 이름만** 출력하며 비밀값은 출력하지 않는다. `${{Service.VARIABLE}}` 참조는 Railway Variables에서 사용하고, 로컬 검증 파일에는 해석된 연결 값을 넣는다. 운영 파일을 커밋하거나 채팅에 붙이지 않는다.

## 2. Railway 서비스

같은 프로젝트·환경에 PostgreSQL+pgvector, Redis, `backend`(Python), `unified-server`(Node)를 만든다. 처음에는 각 앱 서비스 1 replica로 시작한다. Node가 durable parse/convert 작업을 처리하므로 통합 구성에 예전 Celery worker/dispatcher를 별도로 배포하지 않는다.

| Settings | backend (Python) | unified-server (Node) |
|---|---|---|
| Source Root Directory | `/backend` | `/` 또는 비워 두기 |
| Builder | Dockerfile | Dockerfile |
| Dockerfile Path | `Dockerfile` | `apps/server/Dockerfile` |
| Pre-deploy Command | `alembic upgrade head` | `node --import tsx src/migrate.ts` |
| Start Command | 비워 두기: production 이미지 CMD | 비워 두기: 이미지 CMD |
| Healthcheck Path | `/health` | `/ready` |
| Healthcheck Timeout | 300초 | 300초 |
| Restart Policy | On Failure, 최대 10회 | On Failure, 최대 10회 |
| Public Domain | 필요: 계정·AI API | 필요: 웹·데스크톱 동기화 API |

PostgreSQL은 pgvector가 포함된 이미지/템플릿을 사용한다. 저장소의 `infra/postgres` Dockerfile도 사용할 수 있으며 직접 운영하면 `/var/lib/postgresql/data`에 영속 볼륨을 연결한다. Python 마이그레이션 계정에는 `vector` 확장을 생성할 권한이 필요하다.

Node는 공통 `packages/contracts`, `packages/domain`을 복사하므로 **Root Directory를 `/apps/server`로 지정하면 안 된다.** `RAILWAY_DOCKERFILE_PATH=apps/server/Dockerfile`로 Dockerfile 경로를 지정할 수도 있다. Python은 마지막 production stage를 사용한다. 두 이미지 모두 일반 사용자로 실행하고 `PORT`를 사용한다. Node에서 `PORT`가 있으면 `UNIFIED_PORT`보다 우선한다.

Railway의 신규 서비스는 옛 `railway.json`/`railway.toml` 설정에 참여할 수 없으므로 이 저장소는 위 Dashboard 값을 기준으로 한다. 추후 프로젝트 전체 자동화가 필요하면 `.railway/railway.ts` IaC를 사용한다. [현재 Config as Code 안내](https://docs.railway.com/config-as-code), [Dockerfile 경로](https://docs.railway.com/builds/dockerfiles), [공통 코드를 쓰는 모노레포](https://docs.railway.com/deployments/monorepo).

### 두 서비스가 공유할 값

| 변수 | 설정 |
|---|---|
| `DATABASE_URL` | 같은 PostgreSQL의 private URL. 예: `${{Postgres.DATABASE_URL}}` |
| `SUPABASE_URL` | 웹과 같은 Supabase 프로젝트의 HTTPS origin |
| `SUPABASE_JWT_AUDIENCE` | `authenticated` |
| `SUPABASE_JWT_SECRET` | 레거시 HS256 프로젝트에만 필요. ES256/RS256은 JWKS 사용 |
| `CORS_ORIGINS` | 실제 웹 origin의 JSON 배열. 예: `["https://your-web.vercel.app"]` |
| `AWS_REGION`, `AWS_S3_BUCKET` | 실제 비공개 버킷과 리전 |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, 필요시 `AWS_SESSION_TOKEN` | 최소 권한 서버 자격 증명. AWS SDK의 역할 기반 자격 증명을 사용하는 경우 그 공급자를 별도 설정 |
| `MAX_UPLOAD_BYTES` | 기본 `52428800` (파일 50 MiB) |
| `SYNC_MAX_WORKSPACE_BYTES` | 기본 `2147483648` (공간 2 GiB) |
| `S3_PRESIGNED_URL_TTL` | 기본 `600` |
| `INTERNAL_WORKER_TOKEN` | init이 생성한 **동일한 비밀값**. Node와 Python 양쪽에 넣음 |

Python 전용 값:

```dotenv
REDIS_URL=${{Redis.REDIS_URL}}
SUPABASE_PUBLISHABLE_KEY=<웹의 공개 publishable/anon key>
WEB_BASE_URL=https://<실제 웹 도메인>
UNIFIED_API_URL=https://<실제 Node 공개 도메인>
LEGACY_WORKSPACE_API_ENABLED=false
INTERNAL_WORKER_ALLOWED_HOSTS=[]
AI_CREDENTIALS_KEY=<init이 생성한 Fernet key>
AI_DAILY_REQUEST_LIMIT=100
MINDLOGIC_API_KEY=<관리형 AI를 제공할 경우 실제 키>
MINDLOGIC_BASE_URL=https://factchat-cloud.mindlogic.ai/v1/gateway
```

개인 AI 키를 쓰는 경우에도 `AI_CREDENTIALS_KEY`를 유지한다. 관리형 AI를 제공하지 않으면 MINDLOGIC 키는 비워 둘 수 있지만, 실제 사용할 제공자 연결은 베타 전에 확인한다.

Node 전용 값:

```dotenv
NODE_ENV=production
UNIFIED_HOST=0.0.0.0
UNIFIED_PYTHON_URL=http://backend.railway.internal:8000
```

private URL의 서비스명과 포트는 실제 Python 서비스와 맞춘다. 예시 private URL을 사용할 때 Python `PORT=8000`을 명시한다. Node에는 플랫폼이 주입한 `PORT`를 사용한다. 기본 AWS 호스트 허용 목록은 Python이 버킷/리전으로 구성하므로 임의 외부 호스트를 허용하지 않는다. DB·Redis·Python 간 연결은 private network를 사용한다.

Python `/api/desktop/auth/config`는 공개 Supabase 키·웹 주소·Node 주소만 데스크톱에 전달한다. 내부 토큰, AWS 키, DB URL, 개인 AI 암호화 키는 포함하지 않는다. 기존 desktop 앱에서 Python 공개 주소를 계정 서버로 선택하면 이 정보로 Node에 연결한다.

## 3. Vercel 웹

Root Directory `frontend`, Framework `Next.js`, Node 24를 선택한다. **Include source files outside of the Root Directory in the Build Step**를 켜 공통 `packages/*`를 포함한다. `frontend/vercel.json`의 설치·빌드 명령을 사용한다. [Vercel 모노레포 설정](https://vercel.com/docs/monorepos/monorepo-faq).

```dotenv
APP_ORIGIN=https://<실제 웹 도메인>
NEXT_PUBLIC_SUPABASE_URL=https://<프로젝트>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<공개 publishable/anon key>
NEXT_PUBLIC_API_URL=https://<실제 Python 공개 도메인>
NEXT_PUBLIC_WORKSPACE_API_URL=https://<실제 Node 공개 도메인>
DESKTOP_MAC_DOWNLOAD_URL=<배포 가능한 macOS 설치 파일 HTTPS 주소>
DESKTOP_WINDOWS_DOWNLOAD_URL=
```

API 주소에는 `/api`나 `/v2`를 붙이지 않는다. 공개 키에 service-role/secret 키를 넣으면 빌드를 거절한다. 웹·API 주소 누락, localhost, 경로가 붙은 origin도 Vercel 빌드를 거절한다. `NEXT_PUBLIC_*`는 빌드에 고정되므로 변경 후 웹을 재배포한다. Preview는 운영과 별도 Variables 범위·CORS·Supabase redirect를 맞춘다.

## 4. Supabase와 S3

- Supabase Site URL을 `APP_ORIGIN`, Redirect URLs를 해당 웹의 `/auth/callback`으로 설정한다.
- Google OAuth provider callback은 Supabase가 제공하는 callback URI를 사용한다.
- S3에 `infra/s3/public-access-block.json`, `encryption.json`, `ownership.json`과 최소 IAM 정책 `iam-policy.example.json`을 버킷명에 맞춰 적용한다.
- `infra/s3/cors.production.example.json`의 origin을 실제 웹으로 바꿔 적용한다. 새 동기화 업로드에 필요한 **`x-amz-meta-blob-id`**, checksum, encryption, `if-none-match` 헤더를 포함한다. 옛 version-id 헤더만 허용한 CORS를 그대로 쓰면 브라우저 업로드가 실패한다.
- Node `/ready`의 `HeadBucket`에는 버킷 수준 `s3:ListBucket`이 필요하다. 기존 예시 IAM 정책에 포함되어 있다. 객체 접근은 `teams/*` 범위만 허용한다.
- 삭제/충돌/이력은 복구를 위해 논리적으로 보존한다. 버킷 전체에 임의 만료 Lifecycle을 걸어 참조 중인 원본을 삭제하지 않는다. 완전 삭제/보관 기간은 사용자 안내와 별도로 정한다.

## 5. 배포 순서와 확인

1. DB·Redis와 private S3, 양쪽 서비스의 공개 도메인을 만든다. 주소를 확정한 뒤 Variables를 연결한다.
2. Python을 배포한다. Alembic 성공과 `/health`를 확인한다.
3. Node를 배포한다. unified DDL 성공과 `/ready` 200을 확인한다.
4. Vercel을 배포하고 공개 주소·인증 콜백·S3 CORS를 맞춘다.
5. 로컬 환경 파일에도 실제 값을 기록하고 실행한다.

```sh
node scripts/deploy/check.mjs
node scripts/deploy/smoke.mjs
```

smoke는 읽기 전용으로 웹 로그인 화면, Python DB 상태, Node의 DB/S3/Python 준비 상태, 데스크톱 주소 전달, 구 workspace API 410, 새 API 비인증 401, 브라우저 CORS를 확인한다. 사용자 파일이나 워크스페이스를 생성·삭제하지 않는다. 이 검사는 실제 로그인·S3 PUT/GET·AI 모델 호출을 대체하지 않는다. 테스트 계정과 작은 파일로 첫 동기화, 웹 수정, 다른 실제 기기 수신, 변환, 네트워크 단절·재시작, 충돌, 삭제 후 로컬 원본 보존까지 마지막으로 확인한다.

`/health`는 DB 기반 기본 상태, `/ready`는 DB·S3 HeadBucket·인증된 Python `/internal/v2/health`를 확인한다. ready 결과는 10초간 공유·캐시하고 응답에 비밀값이나 내부 URL을 담지 않는다. Python private health는 내부 토큰과 구 API 차단·데스크톱 공개 설정을 확인한다. 토큰이 잘못되거나 의존성이 끊기면 Node는 503을 반환한다.

Railway 배포 healthcheck는 배포 전환용이며 지속 장애 감시는 별도다. 외부 모니터에서 Node `/ready`와 Python `/health`를 주기적으로 확인하고 알림을 연결한다. [Railway healthcheck 범위](https://docs.railway.com/deployments/healthchecks).

## 6. 백업과 되돌리기

운영 PostgreSQL의 자동 백업/PITR을 활성화하고 첫 공개 전에 **별도의 DB로 복원**해 `public` 및 `unified` schema와 파일 참조를 확인한다. S3 원본 보관도 DB 백업 시점과 맞춰 유지한다. 볼륨은 백업을 대신하지 않는다. 백업 설정과 알림 연결은 해당 운영 계정에서 적용해야 하며 코드 수정만으로 활성화되지 않는다.

실패한 배포는 이전 웹·Python·Node 이미지/배포로 복귀한다. 이미지 롤백만으로 DB schema가 되돌아가지는 않는다. 파괴적 DDL이나 `down -v`로 운영 DB를 초기화하지 않는다. 현재 Node DDL은 추가 방식이며 Python 마이그레이션을 먼저 완료한다.

## 7. 운영 이미지의 로컬 확인

개발용 Compose와 섞지 않는다. 실제 값이 준비된 후 별도 프로젝트와 포트로 실행한다.

```sh
docker compose --env-file .env.backend.production -f docker-compose.backend.prod.yml up -d --build
docker compose --env-file .env.frontend.production -f docker-compose.frontend.prod.yml up -d --build
```

같은 컴퓨터의 개발 서비스를 유지하려면 BACKEND_PORT/UNIFIED_PORT/FRONTEND_PORT를 다르게 정하고 브라우저용 URL을 그 포트에 맞춘다. localhost 이미지 검증에만 frontend의 `CONTEXT_DEPLOYMENT_MODE=local`을 명시한다. 클라우드 배포에서는 HTTPS origin을 사용한다. 기존 `.env.production`은 자동으로 읽거나 덮어쓰지 않는다.
