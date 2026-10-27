# Phase 2 — 문서 저장소

Phase 1 인증·Workspace 권한 위에 문서 목록, 최초 V1 업로드, 완료 검증 및 다운로드를 추가했다. 소스는 현재 레포에 있으며 Docker bind mount로 수정 사항을 반영한다. Canvas, 파싱, 추가 버전 연결, AI는 아직 구현하지 않는다.

## 모델과 업로드 흐름

`0002_document_storage` migration은 `documents`, `document_versions`, `document_version_status` enum을 추가한다. 기존 테이블과 데이터는 유지한다.

- Document: Workspace, 제목, 생성자·시간, current_version_id, upload_request_id.
- DocumentVersion: 문서, version_number, storage_bucket/key, 원본 파일명, MIME, size, SHA-256, 생성자·시간, status.
- UUID로 object key를 만든다: `teams/{team}/workspaces/{workspace}/documents/{doc}/versions/{version}/original.ext`.
- 동일 문서의 버전 번호는 유일하다. current_version_id는 같은 문서에 속한 버전만 참조할 수 있다.
- 새 업로드는 새 Document와 V1을 생성한다. SHA-256 중복 제거 및 기존 문서의 V2 생성은 Phase 5 범위다.

1. 브라우저가 파일 SHA-256을 계산하고 제목·파일명·크기·checksum·request_id를 API로 보낸다.
2. OWNER/EDITOR 권한을 확인한 뒤 DB에 UPLOADING V1을 만들고 presigned PUT을 발급한다.
3. 브라우저가 파일을 S3로 직접 PUT한다. 애플리케이션 JWT를 S3로 보내지 않는다.
4. 완료 API가 S3 HEAD의 크기, MIME, SHA-256, version-id metadata, AES256 암호화를 확인한다.
5. 일치하면 UPLOADED 및 current_version_id를 transaction으로 갱신한다. 파일 도착 전에는 409, 저장소 장애는 503이며 재시도할 수 있다. 불일치는 FAILED와 422이며 새 문서로 다시 업로드한다.

완료 요청은 버전 행을 잠그며 반복 호출에 같은 결과를 반환한다. 같은 request_id와 metadata로 생성 요청을 재시도하면 UPLOADING 버전 하나를 재사용한다. 같은 ID에 다른 metadata를 보내면 409다. 이미 완료한 생성 요청을 다시 보내도 새 문서를 만들지 않고 409를 반환하므로 목록을 확인한다.

PUT URL은 Content-Length, MIME, checksum과 알고리즘, SSE-S3, version-id, `If-None-Match: *`를 서명한다. Content-Length는 브라우저가 File body에서 설정한다. 동일 key를 덮어쓸 수 없고 412 응답이면 UI가 완료 API로 기존 파일을 재확인한다. 유효기간 기본 600초, 설정 범위 60~900초다. 발급 후 권한을 잃더라도 이미 발급된 URL은 만료까지 유효할 수 있다. URL은 로그나 메시지로 공유하지 않는다.

허용 확장자는 PDF/DOCX/HWPX/TXT/MD, 기본 최대 크기는 50 MiB다. 확장자에 따라 서버가 MIME을 정하며 파일 구조 파싱이나 악성코드 검사는 이번 범위 밖이다. 다운로드는 `attachment` 및 `application/octet-stream`으로 발급한다. 모든 다운로드 발급에 현재 WorkspaceMember를 재확인한다. VIEWER는 읽기만 허용된다.

## API

기존과 같이 모든 `/api` 호출에 Supabase Bearer 토큰이 필요하다.

| Method | Path | 역할 / 동작 |
|---|---|---|
| GET | /api/workspaces/{workspace_id}/documents | 모든 멤버, limit 1~100 및 offset 목록 |
| POST | /api/workspaces/{workspace_id}/documents/upload-url | OWNER/EDITOR, 새 Document/V1 및 PUT URL, 201 |
| GET | /api/documents/{document_id} | 모든 멤버, 버전 metadata 포함 상세 |
| POST | /api/versions/{version_id}/upload-url | OWNER/EDITOR, 미완료 V1 PUT URL 재발급 |
| POST | /api/documents/upload-complete | OWNER/EDITOR, HEAD 검증 및 완료 |
| POST | /api/versions/{version_id}/download-url | 모든 멤버, 완료된 버전 GET URL |

생성 요청:

```json
{
  "request_id": "클라이언트가 생성한 UUID",
  "title": "회의록",
  "filename": "회의록.md",
  "size": 123,
  "sha256": "파일의 SHA-256 소문자 hex 64자리"
}
```

완료 body는 `{ "version_id": "발급받은 UUID" }`다. PUT 응답의 `headers`를 모두 붙여 파일 원문을 보낸다. Multipart form-data를 보내지 않는다. API 상세 계약은 `/docs`에서 확인할 수 있다. 목록/상세에는 원본 S3 key와 bucket을 노출하지 않는다. 미인증 401, VIEWER 쓰기 403, 비멤버/없는 리소스 404, 크기 초과 413, 입력·파일 불일치 422, 저장소 미설정/장애 503이다.

## AWS 설정 — 사용자가 해야 할 일

현재 AWS 버킷과 자격 증명은 제공되지 않았다. 아래 설정을 완료해야 실제 브라우저 업로드가 동작한다. Supabase/Google 설정은 그대로 사용한다.

### 1. 전용 private S3 버킷과 설정

AWS 계정에서 **ap-northeast-2**, 범용 S3 버킷을 만든다. 개발/운영 버킷을 분리하고 전역 유일한 이름을 사용한다. Block Public Access 모두 ON, Object Ownership Bucket owner enforced, 기본 암호화 SSE-S3로 설정한다. ACL과 public-read는 사용하지 않는다.

AWS CLI가 설치되어 있고 버킷 관리 권한의 프로필이 설정되어 있다면 레포 루트에서 다음과 같이 적용할 수 있다. `DOCS_BUCKET`은 실제 생성할 버킷 이름으로 바꾼다. create-bucket은 신규 버킷에서만 실행한다.

```bash
export DOCS_BUCKET='실제-전용-버킷-이름'
aws s3api create-bucket --bucket "$DOCS_BUCKET" --region ap-northeast-2 --create-bucket-configuration LocationConstraint=ap-northeast-2
aws s3api put-public-access-block --bucket "$DOCS_BUCKET" --public-access-block-configuration file://infra/s3/public-access-block.json
aws s3api put-bucket-ownership-controls --bucket "$DOCS_BUCKET" --ownership-controls file://infra/s3/ownership.json
aws s3api put-bucket-encryption --bucket "$DOCS_BUCKET" --server-side-encryption-configuration file://infra/s3/encryption.json
aws s3api put-bucket-cors --bucket "$DOCS_BUCKET" --cors-configuration file://infra/s3/cors.development.json
```

콘솔 CORS 편집기는 `cors.development.json`의 `CORSRules` 안 배열만 붙여 넣는다. 운영은 AllowedOrigins를 정확한 HTTPS 프런트 도메인으로 바꿔 별도 버킷에 적용한다. 백엔드 CORS_ORIGINS와 S3 CORS는 서로 다른 설정이다. `x-amz-sdk-checksum-algorithm` 등 샘플의 모든 헤더를 허용해야 한다.

### 2. 런타임 IAM 권한

`infra/s3/iam-policy.example.json`의 `REPLACE_WITH_BUCKET_NAME`을 실제 이름으로 바꿔 백엔드 IAM 역할/사용자에 연결한다. 문서는 `teams/*` GetObject/PutObject와 누락된 객체 HEAD를 404로 구분하기 위한 ListBucket을 사용한다. 수동 동기화의 만료 업로드 정리는 `teams/*/workspaces/*/sync-uploads/*`에만 DeleteObject를 추가한다. 정리기는 DB에서 어느 버전도 참조하지 않는 만료 키만 지운다. 기존 문서 경로의 DeleteObject와 버킷 설정 변경 권한은 요청하지 않는다. 이 서비스의 모든 팀은 서버 역할을 공유하고 팀별 접근은 API 권한 검사와 개별 서명으로 제한한다.

로컬 Compose는 개발용 IAM access key를 backend에만 전달한다. AWS 배포에서는 IAM 역할과 임시 자격 증명을 사용하고 정적 키는 비운다. 기본 credential chain을 사용하므로 호스트에서 실행하는 백엔드는 AWS_PROFILE도 사용할 수 있지만 현재 Compose는 호스트의 ~/.aws를 mount하지 않는다.

### 3. 환경별 값 입력

`.env.development`의 아래 항목을 채운다. 운영 버킷과 자격 증명은 Railway 백엔드 Variables에 별도로 설정한다. 로컬 운영 이미지 검증에는 `.env.backend.production`을 사용한다.

```dotenv
AWS_REGION=ap-northeast-2
AWS_S3_BUCKET=실제-버킷-이름
AWS_ACCESS_KEY_ID=개발용-IAM-access-key
AWS_SECRET_ACCESS_KEY=개발용-IAM-secret-key
AWS_SESSION_TOKEN=
S3_PRESIGNED_URL_TTL=600
MAX_UPLOAD_BYTES=52428800
```

임시 STS 자격 증명이면 AWS_SESSION_TOKEN도 입력한다. IAM 역할 환경에서는 access/secret/session 값을 비운다. MAX_UPLOAD_BYTES의 서버 상한은 100 MiB이며 브라우저도 100 MiB를 초과한 파일을 거부한다. 모든 AWS 키는 backend 전용이고 `NEXT_PUBLIC_*`에 넣지 않는다.

```bash
docker compose --env-file .env.development up -d --force-recreate backend
```

Google 로그인 → Workspace → File 선택 → Upload document → Uploaded → Download 순서로 원본 파일을 확인한다. 네트워크 중단 시 Check upload로 확인하거나 Retry file에서 같은 원본을 선택한다.

## 검증과 한계

백엔드 테스트는 분리된 PostgreSQL과 Moto S3 HTTP 서버에서 실제 PUT/HEAD/GET 및 조건부 쓰기 동작을 검증한다. Moto는 AWS SigV4와 잘못된 본문 checksum을 실제 AWS처럼 검증하지 않으므로 서명 대상 헤더를 별도로 검사하고 HEAD 불일치도 테스트한다. 실제 AWS의 IAM, CORS, checksum 거부, URL 만료는 계정 설정 후 실버킷에서 확인해야 한다. 브라우저 테스트는 테스트 전용 인증 응답과 API/S3 응답을 사용하며 실제 Google 계정이나 AWS 비용을 발생시키지 않는다. 런타임 인증 우회나 로컬 S3 fallback은 추가하지 않았다.

중단된 UPLOADING 및 FAILED 문서 metadata와 S3 객체 자동 정리는 아직 없다. 원본 보존을 위해 일괄 만료 lifecycle을 적용하지 않는다. 정리 정책·문서 삭제·multipart 대용량 업로드는 후속 범위다. 처리되지 않은 업로드를 READY로 표시하지 않는다.

공식 자료: [S3 presigned URL](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html), [조건부 쓰기](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html), [CORS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/cors.html), [boto3 PutObject](https://docs.aws.amazon.com/boto3/latest/reference/services/s3/client/put_object.html).
