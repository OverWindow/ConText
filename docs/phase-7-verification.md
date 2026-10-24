# Phase 7 검증 기록

검증일: 2026-10-08, macOS / Docker Desktop, PostgreSQL 17 + pgvector 0.8.7 / Redis 7.4.

## 자동 검증

- 백엔드 `ruff check app tests migrations`: 통과.
- `pytest -q`: **153 passed**. Phase 7 테스트 10개를 포함한다. 기존 Starlette/AnyIO deprecation warning 1개가 남아 있다.
- Alembic 모델 비교, base까지 downgrade 후 head upgrade, 재비교 통과. 테스트는 이름이 `_test`로 끝나는 별도 disposable Postgres에서 실행한다.
- 새 테스트는 전체 문서 chunk 범위/정확한 위치, 네이티브 pgvector 거리 검색, 현재/과거/기준일 버전, workspace 접근 차단, VIEWER 질문, 공유 기록, 동시 요청 idempotency, 무효 인용 거절, 텍스트 fallback, 모델·차원 변경, 16구간 배치 재개, stale lease 결과 차단, 접근 회수, broker 장애, 실제 Redis/Celery의 색인·답변 전달을 검증한다.
- 프런트엔드 `npm run lint`, `npm run typecheck`, `npm run build`: 통과.
- Playwright 데스크톱 Chrome·모바일 Chromium: **72 passed** — RAG 6, intelligence/versions 18, phase4 38, elements 10.
- 브라우저 검증은 테스트 인증/API 응답을 사용한다. 출처 링크에서 과거 버전과 문단을 여는 동작, 공유 대화 복원, HTML 텍스트 비실행, 기준일 payload, 불완전 색인/의미 검색 장애 안내, 응답 유실 후 UUID 재사용, 실패 답변 재시도, VIEWER 권한을 검증했다.
- `/tmp/phase7-chat-desktop.png`, `/tmp/phase7-chat-mobile.png` 화면을 직접 확인했다. 모달 내부 스크롤과 고정 입력 영역이 동작하며 페이지 가로/세로 overflow 검증을 통과했다. 검색 화면 캡처도 `/tmp/phase7-search-*.png`에 저장했다.

## 개발 환경 적용

- Docker 서비스를 다시 실행했다. API와 Postgres/Redis healthcheck가 정상이며 worker·dispatcher·frontend가 실행 중이다.
- 적용 전 `.backups/before-phase7-20261008.dump`에 기존 DB의 pg_dump custom archive를 저장했다. 디렉터리 700, 파일 600 권한이며 Git에서 제외된다. pg_restore --list로 아카이브 읽기를 확인했다. 별도 DB로 전체 복원 테스트를 수행한 것은 아니다.
- 기존 PostgreSQL 데이터 볼륨을 유지하며 확장 포함 이미지로 교체했다. DB migration `0008_workspace_rag`, pgvector `0.8.7`을 확인했다.
- 기존 READY 버전 **4개 / 12구간**이 실제 Gateway 임베딩으로 모두 `COMPLETED`가 되었고 색인 오류가 없었다.
- 실제 Mindlogic Gateway로 합성 문장의 **1536차원 임베딩**, JSON 생성, 합성 근거의 금액과 `S1` 인용을 가진 답변 생성을 확인했다.
- 기존 클라이언트 기본 요청이 403으로 거절되는 문제는 애플리케이션 User-Agent를 명시하여 해결했다. 401/403 응답은 별도 `AI_FORBIDDEN`으로 처리한다. 비밀 키와 외부 응답 본문은 로그에 출력하지 않았다.

## 범위와 한계

이번 검증은 사용자 계정의 실제 로그인부터 브라우저 질문까지 전 과정을 자동화한 것은 아니다. 브라우저 흐름은 API fixture로 검증하고, 실제 DB·Redis·S3 정규화 문서의 색인과 실제 Gateway 호출은 별도로 검증했다. 장기 부하 시험이나 한국어 질문 corpus에 대한 검색 품질 평가는 수행하지 않았다.

검색은 현재 exact pgvector 거리 검색이며 최대 8구간을 답변에 제공한다. ANN 최적화, OCR, 문서 변환, Activity 기록은 이번 Phase 7 범위에 포함하지 않는다. 인용의 존재는 검증하지만 답변의 의미적 정확성을 완전히 증명하지는 않는다. 상세 동작과 운영 한계는 [사용 가이드](phase-7-rag.md)를 참고한다.

## ConText 이름 및 접이식 패널 변경 (2026-10-08)

- AI 채팅을 모달에서 오른쪽 비모달 패널로 변경했다. 접기·펼치기 시 초안, 선택한 대화와 답변을 유지하고, 숨겨진 동안에는 주기적 조회를 멈춘다. 데스크톱에서 캔버스를 함께 조작할 수 있다.
- 왼쪽 메뉴는 아이콘·팀원 아바타를 남기는 압축 모드를 지원한다. 모바일의 기본 상태는 압축 메뉴다. 키보드 접근 이름, 버튼의 펼침 상태와 채팅을 접은 뒤 포커스 복귀를 확인했다.
- 로그인, 워크스페이스 목록, 캔버스, 브라우저 제목, API 제목을 ConText로 변경했다. 실행 중인 서비스에서도 프런트엔드 HTTP 200 / ConText title, OpenAPI title ConText를 확인했다.
- 변경 후 Playwright 62개 통과: RAG 8, phase4 38, auth 6, elements 10. lint, TypeScript, production build 통과. 모바일 도형 편집 패널이 압축 메뉴와 겹치는 문제를 수정하고 다시 검증했다.
- `/tmp/context-dock-desktop.png`, `/tmp/context-dock-mobile.png`, `/tmp/context-navigation-desktop.png`, `/tmp/context-navigation-mobile.png`를 직접 확인했다.
