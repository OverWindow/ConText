# Phase 4 — 문서 처리와 한국어 전체 화면 UI

## 사용하기

1. `http://localhost:3000`에서 로그인하고 워크스페이스를 연다.
2. 우측 상단 **+ 문서 추가** 아이콘을 누르거나 옆 드롭다운의 **파일에서 업로드**를 선택한다. 파일을 캔버스에 끌어 놓아도 업로드 창이 열린다. 한 번에 한 파일을 올린다.
3. 파일과 제목을 확인하고 **문서 올리기**를 누른다. 업로드 완료 후 DB에 작업이 기록된다. worker가 처리하면 카드가 **처리 대기 → 문서 분석 중 → 읽기 준비 완료**로 바뀐다.
4. 문서 카드를 클릭하면 화면 정중앙 모달에서 추출한 본문·표·원본 위치를 읽고 원본을 다운로드한다. Esc, 닫기 버튼 또는 모달 바깥을 클릭하면 닫힌다. 문서 관리의 제목을 눌러도 미리보기가 열린다. 긴 본문은 패널 내부에서 스크롤하고 100개 문단 단위로 더 불러온다.
5. 파싱 실패 사유와 **다시 처리** 버튼은 미리보기 모달에 표시된다. 검증된 원본은 파싱 실패 후에도 다운로드할 수 있다. 원본 업로드가 끝나지 않았다면 **문서 관리 → 업로드 확인 / 파일 다시 선택**을 사용한다.
6. 왼쪽 **문서 연결** 또는 상세의 접힌 문서 연결 영역에서 관계를 추가·삭제한다. 카드 연결점을 직접 드래그해도 된다. 위치 저장·키보드 이동·줌/팬은 유지된다.

HTML/body는 스크롤하지 않는다. 격자는 viewport 전체를 채운다. 페이지 스크롤 대신 캔버스 팬/줌과 패널 내부 스크롤을 사용한다. 모바일 왼쪽 메뉴는 햄버거 버튼으로 연다. 검색은 캔버스에 표시된 문서 제목을 대상으로 한다. Phase 3의 캔버스 최대 1,000개 제한은 유지하며 전체 문서 목록은 문서 관리에서 페이지 단위로 불러온다.

팀원은 `WorkspaceMember`의 실제 목록과 권한을 보여 준다. 소유자는 팀원 제목 옆 추가 아이콘을 누르고 이미 Google 로그인한 사용자의 이메일과 열람자/편집자 역할을 입력하여 해당 워크스페이스에 추가할 수 있다. 기존 멤버의 권한은 유지한다. 다른 워크스페이스/팀 전체 접근 권한은 부여하지 않는다. 미가입자는 먼저 서비스에 로그인해야 한다. 초대 이메일 발송, 가입 대기 초대, 기존 권한 변경은 제공하지 않는다. VIEWER는 문서 읽기·다운로드·탐색만 가능하며 변경 API도 별도로 권한을 검사한다.

## 파일 구분과 참조 표시

카드와 문서 목록, 미리보기 헤더에 공통 파일 스타일을 적용한다. PDF는 빨강, DOCX는 파랑, HWPX는 초록, TXT는 주황, Markdown은 보라색이다. 파일별 아이콘·형식명·한글 설명을 함께 표시하고 대문자 확장자도 처리한다.

상단 눈 아이콘으로 참조/파생 등의 연결 라벨을 숨기거나 다시 표시한다. 왼쪽 **문서 연결**의 **연결선 표시** 체크박스로 선 전체도 숨길 수 있다. 이는 현재 화면의 표시 설정으로 새로고침하면 기본 표시 상태로 돌아간다. 실제 관계 데이터는 유지된다. 관계를 삭제하려면 연결 목록에서 해당 연결의 X 버튼을 누른다(OWNER/EDITOR만 가능).

## 지원 문서

| 형식 | 추출 내용 | 주요 제한 |
|---|---|---|
| PDF | 페이지별 텍스트, 문단, 페이지 번호 | 최대 500페이지. 암호 PDF 거부. 스캔 이미지는 OCR 필요 오류 |
| DOCX | 본문 순서대로 제목·문단·목록·표 | 머리글/바닥글·그림·복잡한 도형/텍스트 상자와 원본 레이아웃 재현 제외 |
| HWPX | `Contents/sectionN.xml`의 본문·표, 구역/요소 위치 | 바이너리 HWP 미지원, 복잡한 개체와 시각적 레이아웃 제외 |
| TXT | 문단, 문단 번호 | UTF-8/BOM·UTF-16 BOM·CP949, 바이너리 거부 |
| Markdown | 제목·문단·목록·표·코드, 가능한 원본 줄 번호 | HTML 실행·외부 이미지/링크 자동 로딩 없음 |

기본 업로드/UI 한도 50 MiB. 출력 최대 2,000,000자/20,000블록. ZIP 최대 2,000항목/전체 64 MiB/개별 16 MiB/압축률 300배. XML DTD·엔티티·외부 참조와 경로 탈출을 거부한다. worker concurrency=1, soft limit=100초/hard limit=120초, 컨테이너 메모리 1 GiB. 복잡하거나 큰 PDF의 텍스트 추출은 제한에 걸릴 수 있으며 원본과 동일한 레이아웃/읽기 순서를 보장하지 않는다.

## 처리 구조

`upload-complete → PostgreSQL processing row → dispatcher → Redis → Celery worker → private S3 artifacts → READY`

- `0004_document_processing`: 검증된 원본 시각 `document_versions.uploaded_at`, 작업 상태/시도 횟수/실행 토큰/오류/요약/산출물 키를 갖는 `document_processing` 테이블 추가. 기존 UPLOADED/PROCESSING/READY 버전은 작업 대기열로 이관된다.
- 원본 검증과 작업 생성이 같은 transaction이다. Redis 장애가 업로드 완료를 막거나 작업을 유실시키지 않는다.
- dispatcher가 10초 간격으로 대기 작업을 전송한다. 60초 동안 받지 못한 작업은 재전송한다. 중복 전송은 worker의 행 잠금/상태 검사로 무시된다.
- worker가 크기와 SHA-256을 다시 검증한다. 공통 NormalizedDocument는 `schema_version`, `title`, `source_filename`, `source_sha256`, `blocks`, `page_count`, `warnings`를 포함한다. 블록은 `id/type/text/source`와 선택적 `level/rows/language`를 갖는다.
- `teams/.../documents/.../versions/{id}/processed/{run_token}/normalized.json`, `extracted.txt`를 SSE-S3 AES256으로 저장한다. 원본을 덮어쓰지 않는다. 성공한 실행 토큰의 키만 DB에 채택한다.
- 180초가 지난 RUNNING 작업은 복구한다. 저장소 일시 장애·worker 중단은 기본 3번까지 재시도한다. 파싱 오류는 바로 FAILED. OWNER/EDITOR는 수동 재시도를 할 수 있다.
- 중단된 실행의 일부 산출물은 S3에 남을 수 있다. 자동 삭제/GC는 구현하지 않았고 런타임 DeleteObject 권한을 요구하지 않는다.
- 뷰어에는 raw HTML을 삽입하지 않는다. 추출 텍스트와 표는 React 텍스트로만 렌더링한다.

## API

| API | 권한 | 동작 |
|---|---|---|
| `POST /api/workspaces/{id}/members` | OWNER | `{email, role: EDITOR 또는 VIEWER}`; 기존 가입자 추가, 중복 요청 멱등/기존 역할 보존 |
| `GET /api/workspaces/{id}/members` | 워크스페이스 멤버 | 실제 표시 이름·역할, 이메일 제외 |
| `GET /api/versions/{id}/processing` | 멤버 | 상태·시도 횟수·오류·요약, S3 키 제외 |
| `GET /api/versions/{id}/content?offset=0&limit=100` | 멤버 | READY 본문 페이지; limit 1~200, 결과 no-store |
| `POST /api/versions/{id}/process` | OWNER/EDITOR | FAILED 재처리 예약(202); 진행/완료 상태에는 멱등 반환 |

미인증 401, 비멤버/없는 리소스 404, 쓰기 권한 없음 403. 미완료 업로드/아직 처리되지 않은 본문 409. 원본 presigned 다운로드와 업로드 API는 기존 계약을 유지한다.

## 실행과 설정

현재 `/Users/hyunjinkim/Projects/Docs`의 소스를 직접 수정할 수 있다. Compose는 backend/frontend 코드를 bind mount한다. worker는 자동 reload하지 않으므로 Python 처리 코드를 수정한 뒤 `docker compose --env-file .env.development restart worker dispatcher`를 실행한다.

```bash
docker compose --env-file .env.development up -d --build
docker compose --env-file .env.development ps
docker compose --env-file .env.development exec worker celery -A app.processing.worker:celery inspect ping
```

기존 frontend 의존성 볼륨에 새 패키지를 반영할 때:

```bash
docker compose --env-file .env.development stop frontend
docker compose --env-file .env.development run --rm --no-deps frontend npm ci
docker compose --env-file .env.development up -d frontend
```

개발 환경과 백엔드 운영 이미지 검증용 템플릿은 아래 기본값을 사용한다. Railway에서는 Redis 서비스의 내부 URL을 설정한다. Redis는 호스트 포트를 열지 않는다.

```dotenv
REDIS_URL=redis://redis:6379/0
PROCESSING_MAX_ATTEMPTS=3
```

Docker 없는 로컬 실행은 별도 Redis를 실행하고 backend 환경에 `REDIS_URL=redis://127.0.0.1:6379/0`를 설정한다. API와 별도로 다음 프로세스를 실행한다.

```bash
celery -A app.processing.worker:celery worker --loglevel=INFO --concurrency=1
python -m app.processing.dispatcher
```

운영 환경에서는 실제 private Redis 주소/인증/TLS 정책에 맞춰 REDIS_URL을 지정하고 API·worker·dispatcher에 동일한 DB/S3 설정을 전달한다. Supabase/Google OAuth/CloudFront 추가 설정은 Phase 4에 필요하지 않다. 기존 S3 `teams/*` GetObject/PutObject 범위로 원본과 산출물을 처리한다. 현재 Compose는 개발용 구성이다.

설계 참고: [Celery 설정](https://docs.celeryq.dev/en/stable/userguide/configuration.html), [python-docx 문서](https://python-docx.readthedocs.io/en/latest/), [한컴 HWPX 구조](https://tech.hancom.com/hwpxformat/).
