# Phase 2 — Document Storage 계획

## 현재 상태

Phase 1의 Next.js/TypeScript, FastAPI/SQLAlchemy/Alembic, PostgreSQL, Supabase JWT 및 WorkspaceMember 권한 검사를 확장한다. 현재 경로에 소스를 작성하며 기존 데이터와 인증 설정을 보존한다. Git 저장소는 아직 없다.

## 구현 범위

- Document와 DocumentVersion 테이블, status enum, FK/unique/check 제약 및 명시적 migration.
- 새 문서마다 V1 생성. 버전 연결/추가/비교는 Phase 5 범위다.
- 서버가 UUID 기반 object key, 파일 MIME, 크기, SHA-256, SSE-S3, If-None-Match 조건을 서명한 PUT URL 발급.
- 브라우저에서 S3에 직접 업로드. 완료 시 HEAD로 크기/MIME/checksum 확인 후 UPLOADED와 current_version_id를 transaction으로 갱신. 파싱/처리 완료를 의미하는 READY로 표시하지 않는다.
- 멤버만 목록/메타데이터/다운로드. 업로드 발급/완료는 OWNER/EDITOR만 허용. VIEWER는 읽기만 가능.
- request_id 기반 생성 멱등성, 미완료 V1의 URL 재발급, 완료 요청 멱등성. 저장 오류를 명확한 상태 코드로 반환.
- Workspace 상세에 문서 목록/업로드 진행/실패 재시도/완료 재확인/다운로드 UI.
- boto3는 storage 모듈에 격리. AWS 설정은 backend에만 전달하고 개발/운영 env 및 예제에 추가.
- S3 CORS/IAM/bucket 설정 샘플과 운영 지침 제공. 실제 AWS 계정 설정 및 버킷 생성은 자격 증명과 대상이 제공된 경우에만 진행.

## 검증

실제 PostgreSQL에 기존 migration부터 적용 및 downgrade/upgrade, 기존 인증 회귀, 역할/워크스페이스 격리, S3 HTTP PUT/HEAD/GET, 중복 요청, 크기/checksum 불일치, 저장소 장애 및 덮어쓰기 차단. 프런트엔드 타입/lint/build와 기존 브라우저 테스트.

## 범위 밖

Canvas, 파싱, 악성코드 검사, 문서 변환, worker/Redis, AI, RAG, 중복/자동 버전 분석. 업로드한 파일은 attachment로 다운로드하며 서버에서 실행하거나 HTML로 렌더링하지 않는다.
