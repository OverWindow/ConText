# Phase 2 검증 기록

검증일: 2026-10-07. 현재 레포 소스에 구현하고 Docker 개발 환경에 반영했다.

## 결과

| 검사 | 결과 |
|---|---|
| Backend pytest (실제 PostgreSQL 17 + Moto 5.2.3 S3 HTTP 서버) | **62 passed**, 3.57초 |
| Python Ruff format / check | 통과 |
| Python pip check | 의존성 충돌 없음 |
| Frontend ESLint / TypeScript | 통과 |
| Next.js 16.4 production build | 통과 |
| 기존 인증 Playwright (desktop/mobile) | **6 passed** |
| 문서 Playwright (desktop/mobile) | **8 passed** |
| 개발 DB Alembic current | `0002_document_storage (head)` |
| 개발 DB Alembic check | 모델과 migration 일치, 추가 작업 없음 |
| Docker | backend와 postgres healthy, frontend 실행 |
| S3 설정 샘플 | JSON 문법 검증 통과 |
| npm audit --omit=dev | 보고된 런타임 취약점 0 |

Backend 테스트는 `_test` 전용 DB만 사용한다. 기존 개발 DB의 데이터 삭제 또는 downgrade는 수행하지 않았다. 최종 검토에서 파일명 앞 공백을 보존해 원본 재선택이 가능하도록 수정했고, 동시에 도착하는 완료 요청이 동일 결과를 반환하도록 행 잠금 후 최신 상태를 읽는다.

## 검증 범위

- Phase 1 인증, 최초 사용자 provisioning, Workspace 생성과 역할, JWT/JWKS, 사용자 격리 회귀.
- 문서 생성 → presigned PUT HTTP 전송 → HEAD 검증 → metadata 조회 → presigned GET 원본 다운로드.
- signed headers에 크기·MIME·checksum·If-None-Match 포함, 동일 key 재업로드 412.
- OWNER/EDITOR 쓰기, VIEWER 읽기, 비멤버 404, 미인증 401.
- 파일 확장자/크기/경로/제목/SHA-256 입력 오류, 실패 시 불필요한 DB 행 생성 없음.
- 같은 request_id의 동시 생성 8회가 하나의 V1을 재사용, 다른 metadata는 409.
- 동시 완료 8회의 동일 결과, 재발급 및 미완료 다운로드 차단.
- S3 크기/MIME/checksum/metadata/암호화 불일치 시 FAILED, current_version 미지정.
- 저장소 장애의 503 및 재시도, S3 미설정의 503, 서명 발급 실패 시 transaction rollback.
- 다른 Document의 버전을 current_version으로 지정할 수 없는 복합 FK.
- Alembic upgrade/downgrade/upgrade 및 모델 일치.
- 실제 Chrome 데스크톱·모바일 viewport에서 파일 선택·해시·PUT·완료·다운로드, 오류 후 완료 재확인, 같은 파일 재시도, VIEWER 읽기 전용, 화면 가로 넘침 없음.

## 재실행

레포 루트:

```bash
docker compose --env-file .env.development -f docker-compose.yml -f docker-compose.test.yml --profile test run --build --rm backend-test
cd frontend
npm run lint
npm run typecheck
npm run test:e2e
npm run test:documents
npm run build
```

테스트 코드만 바꾸는 반복 실행에서는 Docker `run`에 `-v "$PWD/backend:/app"`을 추가해 최신 소스를 사용했다. 런타임 의존성 boto3/botocore 및 테스트 Moto의 실제 설치 버전을 requirements lock 파일에 반영했다.

## 아직 확인하지 않은 부분

S3 버킷/IAM 자격 증명이 제공되지 않아 **실제 AWS S3 private bucket 업로드·다운로드, IAM 정책, 브라우저 CORS, AWS 서명·checksum 거부·URL 만료는 미검증**이다. [설정 가이드](phase-2-storage.md)에 버킷 생성·CORS·IAM 샘플과 환경 파일 입력 방법을 정리했다. Moto는 checksum/서명 검증을 AWS와 완전히 동일하게 구현하지 않는다.

문서 브라우저 테스트의 인증·API·S3 응답은 테스트 fixture이며 실제 Google 계정으로 로그인한 전체 E2E는 아니다. 기존 Supabase provider/JWKS 연결 검증 상태는 보존했다. 실제 사용자 동의 및 AWS 연결 후의 통합 흐름은 해당 설정 후 확인해야 한다.

테스트의 Starlette/AnyIO deprecated alias 경고 1건과 Next.js 테스트 서버의 NO_COLOR/FORCE_COLOR 경고가 있다. Docker npm ci에서 기존 개발 도구 의존성에 high 5건이 보고되었고, `npm audit --omit=dev`의 런타임 결과는 0건이었다. 이번 단계에서 개발 도구의 major upgrade는 수행하지 않았다.

Phase 2는 UPLOADED까지만 진행한다. Canvas/파싱/worker/추가 버전 연결/AI/RAG는 구현하지 않았다.

## 실제 AWS 재검사 — 2026-10-07

위 초기 검증 이후 AWS 환경 값이 입력되어 backend를 재생성하고 실제 연결을 검사했다. 아래 결과가 초기의 자격 증명 미제공 상태를 대체한다.

- STS 인증 성공: IAM 사용자 `docs-ai-backend`의 접근 키는 유효하다.
- 버킷 응답의 리전은 `ap-northeast-2`이며 환경 설정과 일치한다.
- 전역 S3 호스트로 생성된 PUT URL에서 307 리다이렉트를 발견했다. boto3에 `s3={"addressing_style": "virtual"}`을 지정해 리전 호스트를 사용하도록 수정하고 PUT/GET URL 회귀 테스트를 추가했다.
- 리전 호스트의 실제 PUT은 **403 AccessDenied**. AWS는 `s3:PutObject`를 허용하는 identity-based policy가 없다고 응답했다.
- 리전 호스트의 OPTIONS는 **403 AccessForbidden**: `CORSResponse: CORS is not enabled for this bucket.`
- 전역 호스트의 OPTIONS는 200이었지만, 실제 사용해야 하는 리전 호스트의 결과를 최종 판단으로 삼았다.
- 비밀 정보 없는 64바이트 테스트 본문을 사용했다. 업로드가 거부되어 S3 객체는 생성되지 않았고 앱 DB에도 테스트 데이터를 만들지 않았다.
- HeadBucket 및 버킷 보안 설정 조회도 거부되어 Public Access Block, Ownership, 기본 암호화 실값은 확인하지 못했다. 설정 조회는 런타임 업로드 권한과 별개이므로 이를 위해 관리자 권한을 줄 필요는 없다.

사용자가 적용할 파일:

1. `infra/s3/iam-policy.development.json`: 현재 환경의 버킷 이름을 반영한 정책. IAM → 사용자 → docs-ai-backend → 권한 → 인라인 정책의 JSON에 전체 내용을 적용한다.
2. `infra/s3/cors.console.development.json`: 콘솔용 배열 형식. S3 → 환경 변수의 버킷 → 권한 → CORS에 전체 내용을 적용한다.

설정 후 실제 업로드 완료·다운로드 검사가 필요하다. 생성 파일과 출력에는 access key, secret key, 서명 URL을 포함하지 않았다.

리전 URL 설정 근거: [AWS boto3 presigned URL 가이드](https://docs.aws.amazon.com/boto3/latest/guide/s3-presigned-urls.html).

## AWS 재검사 통과 — 2026-10-07 22:27 KST

권한과 CORS 적용 후 실제 리전 S3에서 OPTIONS 200, presigned PUT 200, backend HEAD 검증, 재업로드 412, presigned GET 200 및 원본 바이트 일치, attachment 응답, 익명 GET 403을 확인했다. 위 IAM/CORS 장애는 해소됐다. 앱의 JWT·Document DB 흐름은 기존 통합 테스트로 검증하며 이 AWS 검사는 storage 모듈을 직접 호출했다.

런타임 IAM에 DeleteObject 권한이 없어 비밀 정보 없는 64바이트 검증 파일 하나가 남았다. 앱 DB에는 문서로 등록하지 않았다. 필요하면 S3 콘솔에서 아래 객체만 삭제하면 된다. 이 정리를 위해 런타임에 삭제 권한을 추가하지 않았다.

```text
teams/11cf4d01-7852-4fea-8c85-06f0e99a033d/workspaces/11cf4d01-7852-4fea-8c85-06f0e99a033d/documents/11cf4d01-7852-4fea-8c85-06f0e99a033d/versions/11cf4d01-7852-4fea-8c85-06f0e99a033d/original.txt
```
