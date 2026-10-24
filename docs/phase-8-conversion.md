# Phase 8 — 문서 형식 변환

## 사용 방법

1. 캔버스에서 문서를 눌러 미리보기를 연다.
2. **내보내기** 탭에서 PDF, Word (DOCX), 텍스트 (TXT), Markdown 중 원하는 형식의 **변환하기**를 누른다.
3. 대기·진행 상태가 자동 갱신된다. **다운로드 준비 완료**가 되면 **다운로드**를 누른다.
4. 실패하면 메시지를 확인하고 **다시 시도**한다. 연결 문제에는 **상태 다시 확인**을 사용할 수 있다.
5. 과거 버전은 **버전 이력 → 해당 버전 미리보기 → 내보내기**에서 변환한다. 현재 버전 지정은 변경되지 않는다.

변환은 창을 닫아도 계속된다. 같은 버전·같은 형식의 결과는 공유하며 재요청해도 중복 생성하지 않는다. OWNER·EDITOR·VIEWER 모두 읽기 파생물을 만들고 다운로드할 수 있다. 원본 다운로드는 별도 버튼으로 유지한다.

## 지원 범위

입력은 기존 정규화 파이프라인의 PDF·DOCX·HWPX·TXT·MD이며, 출력은 PDF·DOCX·TXT·MD다. 입력 형식마다 개별 변환기를 연결하는 대신 `NormalizedDocument → 출력 렌더러` 구조를 사용한다.

- PDF: A4, 한글 나눔고딕 포함, 자동 줄바꿈·페이지 번호·표 머리글 반복·행 분할.
- DOCX: 제목 단계, 문단, 목록, 표, 코드 줄바꿈. 나눔고딕을 지정하되 글꼴 파일 자체는 포함하지 않으므로 편집 환경에 따라 대체 글꼴이 적용될 수 있다.
- TXT: UTF-8, 문단 순서와 코드 들여쓰기, 표의 모든 셀을 탭·줄바꿈으로 출력.
- Markdown: 제목·목록·표·코드 블록을 생성하고 일반 텍스트의 마크다운 문법을 이스케이프한다. 표 안 줄바꿈은 `<br>`로 표현한다.

텍스트와 정규화 구조 중심의 변환이다. 원본 이미지·병합 셀·머리말/꼬리말·정밀한 배치·서식은 재현하지 않는다. 번호 목록의 번호/중첩 깊이 등 정규화 단계에서 보존하지 않은 정보도 복원하지 않는다. 스캔 PDF OCR, 구형 HWP 입력, HWPX 출력은 지원하지 않는다.

PDF에서 8열을 넘는 표는 행별 텍스트로 펼치며 경고를 표시한다. 폰트에 없는 문자는 `?`로 표시하고 원문 보존용 TXT·DOCX 사용을 안내한다. 매우 큰 표·긴 머리글 등 배치가 불가능한 경우 명시적으로 실패하며 다른 형식으로 내보낼 수 있다. 원본 처리 단계의 경고도 함께 표시한다.

## 데이터와 실행

`document_conversions`의 복합 기본 키는 `(version_id, format)`이다. 변환 상태·시도 횟수·원본 정규화 키·실행 토큰·결과 키·크기·SHA-256·경고를 기록한다. API에는 저장소 키를 노출하지 않는다.

`QUEUED → RUNNING → COMPLETED / FAILED` 순서이며 DB가 durable outbox다. dispatcher가 10초마다 큐 작업을 전달하고 60초 이상 전달 확인이 갱신되지 않은 작업을 재전달한다. worker는 행 잠금으로 작업을 한 번만 취득한다. 180초 넘은 실행은 복구하며 기본 최대 3회 시도 후 실패 처리한다. 저장소 오류는 시도 횟수에 따라 30초 단위로 지연 재시도한다. 사용자 재시도는 실패 작업의 시도 횟수를 초기화한다.

실행마다 별도 토큰과 S3 키를 사용한다. 완료 시 토큰을 다시 검사하여 오래된 worker가 새 작업 결과를 덮어쓰지 못하게 한다. 문서 버전이 삭제되면 변환 메타데이터는 cascade 삭제한다. 중단된 worker가 업로드한 미참조 S3 파일은 별도 수명주기/정리 정책이 필요하며 이 단계에서 자동 삭제하지 않는다.

S3 경로는 기존 원본 키의 디렉터리 아래 `converted/{version_id}/{run_token}/document.{format}`이다. 연결된 버전이 같은 원본 키를 참조해도 version_id로 결과를 구분한다. 원본과 정규화 문서를 덮어쓰지 않는다. AES256 서버 암호화와 생성 시 `IfNoneMatch=*`를 적용한다.

결과 다운로드는 매번 워크스페이스 멤버십을 다시 확인한 뒤 만료되는 S3 URL을 발급한다. 이미 발급한 URL은 만료 전까지 유효하다. 파일명에는 원본 이름과 `-v번호`를 포함하고 attachment 및 올바른 MIME을 지정한다. 브라우저 인증 토큰은 S3에 전달하지 않는다.

## 한도와 의존성

- 정규화 JSON 읽기: 32MiB, schema_version 1 및 원본 SHA-256 일치 검증.
- 최대 문단 20,000개, 표당 최대 10,000행/100열, 문서 전체 최대 50,000셀.
- 문단 텍스트와 표 셀 텍스트 합계 최대 4,000,000자(표의 평문 표현도 합계에 포함).
- PDF 최대 500페이지, 출력 파일 최대 50MiB. Celery의 기존 100초 soft / 120초 hard 제한과 worker 메모리 제한을 따른다.
- ReportLab 5.0.1과 python-docx 1.2.0. Python 의존성은 requirements/lock 파일에 고정한다. Debian `fonts-nanum`을 이미지에 설치한다.
- 외부 URL·이미지·HTML을 로드하지 않고 정규화된 문자열만 문서에 출력한다.

## API

| 메서드 | 경로 | 기능 |
|---|---|---|
| GET | `/api/versions/{id}/conversions` | 해당 버전의 변환 기록 |
| POST | `/api/versions/{id}/conversions/{pdf\|docx\|txt\|md}` | 변환 요청 또는 실패 재시도, 202 |
| POST | `/api/versions/{id}/conversions/{format}/download-url` | 완료 파일 URL·파일명·유효기간 |

미완료 정규화 또는 미완료 다운로드는 409, 지원하지 않는 출력 형식은 422, 인증 없음은 401, 다른 워크스페이스/존재하지 않는 버전은 404다. 응답은 `Cache-Control: no-store`다.

## 재현 검증

- 백엔드: 기존 README의 격리 테스트 Compose 명령으로 `pytest -q`.
- 프런트엔드: `cd frontend && npm run test:conversion`.
- 합성 출력: backend 환경에서 `PYTHONPATH=. python scripts/verify_conversion_outputs.py /tmp/context-phase8-qa`.
- PDF 렌더링: `pdftoppm -r 90 -png /tmp/context-phase8-qa/context-conversion.pdf /tmp/context-phase8-qa/page`.

합성 예제는 실제 사용자 문서를 사용하지 않는다. 출력 PDF는 3페이지이며 [첫 페이지](images/phase-8-pdf-page-1.png), [표의 연속 페이지](images/phase-8-pdf-page-2.png), [마지막 페이지](images/phase-8-pdf-page-3.png)를 직접 확인했다.

구현 참고: [ReportLab 표 문서](https://docs.reportlab.com/reportlab/userguide/ch7_tables/), [ReportLab 공식 배포 정보](https://pypi.org/project/reportlab/).
