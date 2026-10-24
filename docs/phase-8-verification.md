# Phase 8 검증 기록

검증일: 2026-10-17 (Asia/Seoul).

## 자동 검증

- 전체 백엔드 회귀: **187 passed**. 인증·멤버십·문서·버전·캔버스·분석·RAG·변환·마이그레이션을 포함한다.
- 이후 TXT의 표 셀 보존을 강화하고 테스트 1개를 추가한 최종 변환 검사: **35 passed** (`tests/test_conversion.py`). 전체 스위트는 이 추가 후 다시 돌리지 않았다. 기존 Starlette/AnyIO deprecation warning 1개가 있다.
- 5개 입력(PDF·DOCX·HWPX·TXT·MD) × 4개 출력(PDF·DOCX·TXT·MD) 20개 조합의 본문을 다시 읽었다. DOCX 표, 한글 PDF 추출, 긴 표의 페이지 분할, 위험해 보이는 마크업의 문자 처리, PDF 미지원 글리프/넓은 표 경고, 입력 구조 검증도 포함한다.
- 변환 API의 중복 요청, 재사용, 미완료 409, 미인증 401, 다른 사용자 404, VIEWER 접근과 멤버십 철회, 형식 제한 422, 원본 유지, 과거 버전 격리, SHA-256·AES256·다운로드 파일명 검증을 수행했다.
- 저장소 일시 장애, 브로커 전달 실패, 재전달, backoff, 실행 lease 만료·최대 시도 횟수, 오래된 worker 결과 차단, 버전 삭제 cascade, 실제 테스트 Redis/Celery 전달을 확인했다.
- `ruff check .` 통과.
- 브라우저: **26 passed** — 내보내기 8개, 버전 관리 10개, RAG/패널 접기 8개. 데스크톱·모바일에서 완료 다운로드, 창 재열기, 실패 재시도, 네트워크 오류, VIEWER 과거 버전 내보내기, 처리 전 비활성화를 확인했다. 브라우저 검사는 인증/API/S3 fixture를 사용한다.
- 프런트엔드 `npm run lint`, `npm run typecheck`, `npm run build` 통과.

## 출력물과 화면 확인

`backend/scripts/verify_conversion_outputs.py`로 합성 HWPX에서 한글 본문·표를 정규화하고 제목·목록·코드·35행 표를 추가한 QA 자료를 4종으로 출력했다. PDF 39,521 bytes / DOCX 37,600 bytes / TXT 6,678 bytes / MD 7,058 bytes. PDF 3페이지 모두 Poppler로 렌더링해 직접 확인했다. 글자 깨짐·표 잘림 없이 표 머리글 반복과 마지막 문단, 코드 들여쓰기가 보존됐다.

- `docs/images/phase-8-pdf-page-1.png` ~ `phase-8-pdf-page-3.png`: PDF 시각 검증.
- `docs/images/phase-8-export-desktop.png`, `phase-8-export-mobile.png`: 실제 브라우저 렌더링. 내보내기 내용은 패널 내부에서 스크롤한다.
- QA 출력 파일은 `/tmp/context-phase8-qa`에 있으며 스크립트로 재생성할 수 있다.

## 개발 환경 적용과 실제 저장소

- 적용 전 `.backups/before-phase8-20261017.dump`에 기존 DB를 pg_dump custom archive로 백업했다. 파일 권한은 600이며 `pg_restore --list`로 읽기 확인했다. 별도 DB로 전체 복원 테스트를 수행한 것은 아니다.
- `0009_format_conversion`을 개발 DB에 적용했고 `alembic check`는 `No new upgrade operations detected`를 반환했다.
- 실제 개발 DB의 기존 READY TXT 버전 하나에 대해 멤버십 검사 경로를 포함하는 변환 요청 함수를 호출했다. 브라우저 로그인 토큰을 생성하거나 런타임 인증 코드를 변경하지 않았다. HTTP 인증 검증은 격리 API 테스트에서 수행했다.
- 실제 dispatcher → Redis → Celery worker → S3 저장까지 4개 작업 모두 1회 시도로 완료됐다.
- 발급된 실제 S3 URL로 다운로드하여 크기·SHA-256·attachment 헤더를 확인하고 PDF·DOCX를 다시 열었다. 결과 크기: PDF 17,651 / DOCX 36,806 / TXT 124 / MD 158 bytes.
- 이 4개 결과는 해당 기존 버전의 내보내기 기록으로 남겨 재사용한다. 원본·현재 버전·이력은 수정하지 않았다. 실제 파일 본문·자격 증명·서명 URL을 로그에 출력하지 않았다.
- backend·postgres·redis는 healthy, frontend·worker·dispatcher는 running 상태다. 테스트용 PostgreSQL/Redis 컨테이너는 검사 후 제거했다.

## 남은 범위

원본 이미지와 정밀한 레이아웃 보존, OCR, HWP/HWPX 출력, Word 렌더러별 동일한 페이지 배치, 미참조 S3 파생 파일 자동 정리는 구현 범위 밖이다. 한도와 경고, URL 유효기간, 재시도 정책은 [사용 가이드](phase-8-conversion.md)를 참고한다.
