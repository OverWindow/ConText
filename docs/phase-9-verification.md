# AI 문서 작성 검증

검증일: 2026-10-19 (Asia/Seoul).

- Docker 격리 환경 전체 백엔드: **204 passed**. PostgreSQL/pgvector·Redis·PDF용 한글 글꼴을 포함한다. 기존 Starlette/AnyIO deprecation warning 1개가 있다.
- 새 작성 기능: 초안 생성·서버 저장·메모/대화 자동 탐색·다른 워크스페이스 차단·중복 요청·잘못된 출처 거절·수정안 적용/폐기·저장 내용 되돌리기·동시 저장 충돌·VIEWER 권한을 검사했다.
- HWPX/DOCX: 제목·소제목·한글 본문·목록·표를 파일로 만든 뒤 다시 파싱해 내용을 확인했다. HWPX는 python-hwpx 스키마 검사도 통과했다.
- 실제 ChatKHU: 합성 시연 메모 한 개로 6개 블록의 소개서를 생성했다. 제공한 출처 ID를 사용하는지 검사하고 DOCX/HWPX 출력 및 재파싱에 성공했다. 실제 사용자 자료를 이 호출에 사용하지 않았다.
- 브라우저: **18 passed** — 새 작성 화면 6개, 기존 RAG/채팅 12개. 데스크톱·모바일에서 실제 Editor.js를 사용했다. 인증과 API는 fixture를 사용한다. 한글 직접 편집·원문 표시·수정안 비교·파일 다운로드·재시도 ID 유지·미저장 변경 확인·읽기 전용을 검사했다.
- `ruff check .`, 프런트엔드 `npm run typecheck`, `npm run lint`, `npm run build` 통과.
- `docs/images/phase-9-writing-desktop.png`, `phase-9-writing-mobile.png`는 검증용 합성 데이터 화면이다. 위험해 보이는 마크업도 실행되지 않고 문자로 표시되는 것을 포함한다.

최초 호스트 실행에서는 Redis 호스트와 Linux의 PDF 글꼴 경로가 없어 기존 회귀 테스트 일부가 실패했다. 필요한 환경이 포함된 격리 Docker 실행에서 전체 204개가 통과했다. 테스트 컨테이너와 임시 호스트 PostgreSQL 인스턴스는 정리했다.

개발 DB 변경 전에 `.backups/before-ai-writing-20261019.dump`를 권한 600으로 생성했다. 백업 크기는 288,341 bytes이며 `pg_restore --list`로 읽기를 확인했다. 별도 DB로 전체 복원 검사를 수행한 것은 아니다. 기존 문서와 버전은 그대로 유지하며 `0011_ai_writing`으로 작성용 테이블을 추가했다. 개발 DB의 `alembic current`는 `0011_ai_writing (head)`, `alembic check`는 `No new upgrade operations detected`를 반환했다.

개발 서비스 frontend·backend·postgres·redis·worker·dispatcher를 새 의존성과 함께 실행했다. 백엔드 health는 `ok`, 프런트엔드 로그인 페이지는 HTTP 200을 확인했다. 접속 주소는 `http://localhost:3000`이다.

한컴오피스와 Microsoft Word의 실제 페이지 렌더링, 원본 양식과의 배치 일치는 이 검증에 포함하지 않는다. [사용법 및 지원 범위](phase-9-writing.md)를 참고한다.

## 문서 삭제 추가 검증

- 작성 기능 백엔드 **8 passed**: 기존 5개와 OWNER/EDITOR 삭제, 권한·워크스페이스 격리 검사를 포함한다. 오래된 revision의 삭제는 409로 차단하며, 삭제 후 본문·내보내기·되돌리기 접근이 404인지 확인했다. 원문 메모와 대화는 보존된다.
- 작성 화면 브라우저 **10 passed**: 데스크톱·모바일의 삭제 확인, Escape 취소, 취소 버튼 초기 포커스, 미저장 편집 폐기, 삭제 충돌 시 편집 내용 보존, VIEWER 삭제 버튼 미노출을 포함한다.
- 변경 파일 Ruff, 프런트엔드 타입 검사·린트·프로덕션 빌드 통과. 전체 백엔드 204개 기록은 삭제 기능 추가 전 결과이며 이번 변경에서는 작성 기능에 집중해 검사했다.
- 실행 중인 개발 API의 OpenAPI에서 DELETE 경로와 프런트엔드 HTTP 200을 확인했다. DB 마이그레이션이나 추가 의존성은 필요하지 않다.
