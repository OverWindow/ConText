# Phase 5 — Version Management

한 문서 안에서 여러 원본 버전을 관리한다. Phase 4의 S3 검증, 비동기 파싱, 한국어 중앙 미리보기, 전체 화면 캔버스를 그대로 사용한다. 추가 패키지나 환경 변수는 없다.

## 사용 방법

1. 캔버스 카드나 문서 목록의 제목을 누르면 중앙 모달이 열린다.
2. **새 버전 → 파일 업로드**에서 PDF/DOCX/HWPX/TXT/MD 파일과 선택적인 등록 메모를 넣는다. 다른 파일 형식도 같은 문서의 버전이 될 수 있다.
3. **새 버전 → 기존 버전 연결**에서 같은 워크스페이스의 다른 문서와 검증된 버전을 선택한다. 원래 문서는 남고, 대상 문서에 새 버전이 생긴다.
4. **버전 이력**에서 버전 번호, 등록자, 등록 시각(KST), 메모, 연결 여부, 처리 상태, 현재 버전을 확인한다. 버전을 누르면 해당 버전의 본문을 읽을 수 있고 원본도 내려받을 수 있다.
5. **현재 버전으로 지정**을 누르면 캔버스가 대표하는 버전이 바뀐다. 과거 버전으로 돌아갈 수도 있다.
6. **버전 비교**에서 같은 문서의 서로 다른 두 버전을 선택한다. 파일명·등록자·시각·크기·SHA-256·처리 상태와 추출 본문을 비교한다. 데스크톱은 좌우, 작은 화면은 세로로 배치한다. 본문은 모달 안에서 스크롤한다.

OWNER/EDITOR는 등록·연결·현재 버전 전환이 가능하다. VIEWER는 이력·본문·비교·다운로드를 사용할 수 있다. API에서도 같은 권한을 검사한다.

## 현재 버전과 재시도

최초로 원본 검증이 완료된 버전만 현재 버전으로 자동 지정한다. 이후 등록되는 버전은 명시적으로 선택해야 한다. 늦게 끝난 이전 업로드가 사용자가 고른 현재 버전을 덮어쓰지 않는다. 원본 검증 전에는 현재 버전으로 지정할 수 없다. 파싱이 실패했어도 원본 검증이 끝났다면 현재 버전 지정과 원본 다운로드가 가능하다.

업로드 완료 응답을 받지 못했다면 이력의 **업로드 완료 확인**을 사용한다. 파일 자체를 보내지 못했다면 새 버전 화면의 **등록 방식 → 버전 N 재시도**에서 동일한 이름·크기·SHA-256의 원본을 선택한다. 재시도는 기존 버전 번호를 사용한다.

## 중복 탐지

새 문서 업로드 전에 SHA-256과 크기로 해당 워크스페이스의 검증된 버전을 찾는다. 일치하면 기존 문서 열기를 제안하고 업로드를 멈춘다. 사용자가 별도 문서 등록에 체크하면 계속할 수 있다. 이 경고는 UI의 사전 조회이므로 동시에 생성되는 별도 문서까지 원자적으로 차단하는 정책은 아니다.

같은 문서에 같은 파일을 새 버전으로 등록하거나 연결하는 것은 서버에서 409로 거부한다. 처리 실패라도 검증된 원본은 중복으로 간주한다. 업로드 중인 동일 파일은 기존 버전에서 재시도해야 한다. 검증 전에 FAILED가 된 버전은 새 등록을 허용한다. 파일명이 달라도 내용이 같으면 중복이다. 유사 문서·의미 기반 중복 판단은 하지 않는다.

조회 결과는 최근 20건까지다. 문서당 최대 버전 수는 500개이며 등록 메모는 최대 500자다. 업로드 크기 제한은 기존 MAX_UPLOAD_BYTES 설정을 따른다(기본 50 MiB, UI도 50 MiB 제한).

## API

모든 경로는 Supabase Bearer 인증과 해당 워크스페이스 멤버십이 필요하다.

| Method | Path | 동작 |
|---|---|---|
| POST | `/api/documents/{id}/versions/upload-url` | OWNER/EDITOR: 새 버전 업로드 예약 |
| POST | `/api/documents/{id}/versions/link` | OWNER/EDITOR: 같은 워크스페이스 원본 수동 연결 |
| PATCH | `/api/documents/{id}/current-version` | OWNER/EDITOR: 현재 버전 지정 |
| GET | `/api/workspaces/{id}/duplicates?sha256=…&size=…` | 검증된 동일 파일 조회 |
| GET | `/api/documents/{id}/compare?left=…&right=…` | 같은 문서 두 버전의 메타데이터와 동일 파일 여부 |

업로드 예약 body: `request_id`(UUID), `filename`, `size`, `sha256`, 선택적 `change_note`. 이후 기존 S3 PUT → `/api/documents/upload-complete` 흐름을 사용한다. 연결 body: `request_id`, `source_version_id`, 선택적 `change_note`. 현재 버전 body: `version_id`.

기존 문서 조회 응답의 `versions`에 `author_name`, `source_version_id`, `change_note`가 추가된다. 원본 S3 bucket/key는 응답에 노출하지 않는다. 비교 본문은 기존 버전별 content API를 사용한다. 인증·권한·다른 문서/워크스페이스의 버전 검증은 서버에서 수행한다.

## 트랜잭션·스토리지 구조

`0005_version_management`는 document_versions에 버전별 요청 ID, 원본 연결 ID, 등록 메모를 추가한다. 최초 버전의 요청 ID는 documents의 기존 값으로 채운다. 요청 ID는 문서·등록자 내에서 유일하며, 재사용 시 입력이 다르면 409를 반환한다. 부모 Document 행 잠금으로 버전 번호 배정과 현재 버전 변경을 직렬화한다.

수동 연결은 원본 객체를 복사하거나 이동하지 않는다. 새 DocumentVersion이 이미 검증된 불변 S3 객체의 bucket/key를 공유하고 `source_version_id`로 출처를 보존한다. 따라서 storage_key의 UNIQUE 제약을 일반 인덱스로 변경했다. 연결된 버전에는 업로드 URL을 발급하지 않는다. 원본은 SHA-256·조건부 PUT·S3 HEAD 검증을 사용하는 기존 업로드 정책을 따른다.

연결된 버전마다 별도 DocumentProcessing 작업이 생긴다. 파싱 산출물은 기존 처리 구조의 고유 실행 토큰 경로로 저장하므로 원본 버전과 상태·결과가 서로 덮어써지지 않는다. 원본 출처 FK는 RESTRICT다. 문서/원본 삭제 API는 아직 없으며, 향후 삭제·GC는 같은 객체를 참조하는 모든 버전을 확인해야 한다.

공유 storage_key가 있는 상태에서 Phase 4로 downgrade하면 UNIQUE 제약 복구가 실패하고 PostgreSQL 트랜잭션이 취소된다. 사용자 버전을 지워 강제로 downgrade하지 않는다. 운영 적용 전 DB 백업과 일반적인 배포 절차를 사용한다.

## 실행과 다음 단계

현재 로컬 소스에 구현했고 Docker bind mount로 반영했다. 실행 중인 개발 DB에도 migration을 적용했다. 새 환경은 기존 명령으로 시작한다.

```bash
docker compose --env-file .env.development up --build
```

기존 환경의 코드만 갱신한 경우:

```bash
docker compose --env-file .env.development exec -T backend alembic upgrade head
docker compose --env-file .env.development restart worker dispatcher
```

Supabase·Google OAuth·S3·Redis의 추가 설정은 없다. 자동 Text/Block Diff, 의미·임베딩 유사도, 버전 후보 추천, AI 변경 요약은 Phase 6 범위다.
