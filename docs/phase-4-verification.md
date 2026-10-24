# Phase 4 검증 기록

2026-10-07 KST, 로컬 소스와 Docker 개발 환경에서 검증했다.

## 자동 검사

- Python Ruff 검사 통과.
- PostgreSQL 통합 테스트 **99개 통과**. migration upgrade/downgrade와 ORM 스키마 일치 포함.
- Phase 4 신규 테스트: PDF/DOCX/HWPX/TXT/Markdown 실제 형식 샘플, 한글 인코딩, 표·제목·순서·원본 위치, 암호/스캔 PDF, 손상/빈/바이너리 입력, ZIP 폭탄·DTD·경로 탈출·크기 제한.
- 업로드→처리→정규화 JSON/텍스트 저장→READY, 중복 실행, 원본 checksum 변조 거부, 실패 후 원본 다운로드, 재처리, tenant/role 격리, 실제 멤버 조회, 본문 pagination.
- Redis 장애 후 durable job 재전송, 오래된 실행 복구·최대 재시도, 오래된 실행 토큰의 결과 무시. **실제 별도 Redis와 Celery worker**를 사용하는 비동기 전달 테스트 통과.
- S3 처리 테스트에는 Moto HTTP 서버를 사용했다. PostgreSQL/Redis는 실제 별도 컨테이너이고 테스트 DB는 `_test`로 끝나도록 강제한다.
- 데스크톱·모바일 Chrome: 캔버스/업로드/본문/팀원/검색/격자 크기/HTML 한국어/페이지 overflow 검사 **26개 통과**, 로그인·인증 경로 **6개 통과**. 업로드 아이콘의 native 파일 선택기 테스트 2개도 통과하여 브라우저 검증은 총 **34개**다. 모바일 닫힌 메뉴의 그림자를 보정한 뒤 관련 3개 재검사도 통과.
- ESLint, TypeScript 검사 통과. Next.js production build도 통과했다.

## 개발 환경

- DB `0004_document_processing` 적용 완료.
- backend와 PostgreSQL/Redis healthy; frontend/worker/dispatcher 실행.
- `GET http://localhost:8000/health` → 200, `{"status":"ok"}`.
- `GET http://localhost:3000/login` → 200.
- 실행 중인 Celery worker `inspect ping` → pong, 1 node online.
- 개발 DB에 사용자 문서 버전은 0개였다. 사용자 데이터나 가짜 팀원/문서를 삽입하지 않았다.
- 실제 S3 연결 검증은 [Phase 2 기록](phase-2-verification.md)에 보존했다. 이번 문서 처리의 외부 S3 end-to-end를 사용자 계정으로 다시 실행하지 않았다. 이번 테스트는 실제 worker+DB+Redis와 S3 에뮬레이터 조합이다.
- 실제 Google 사용자 동의 화면은 자동화하지 않았다. 브라우저 회귀 테스트는 별도 인증/데이터 fixture이며 런타임 인증 우회는 없다.

## 화면 검토

아래 이미지는 브라우저 테스트 데이터로 촬영했다. 실제 서비스의 팀원은 API로 조회한다.

- [데스크톱 캔버스](images/phase-4-desktop.png)
- [모바일 캔버스](images/phase-4-mobile.png)
- [문서 본문 패널](images/phase-4-reader.png)

## 범위와 제한

OCR, HWP(바이너리), 문서 버전 연결·diff, AI/RAG는 이번에 구현하지 않았다. HWPX/DOCX/PDF의 복잡한 시각적 레이아웃을 원본처럼 재현하지 않는다. 대형/복잡 문서 처리 시간·메모리 한도와 실패 시 복구 방식은 [처리 가이드](phase-4-processing.md)에 명시했다. 실제 사용자 문서 corpus 전체에 대한 호환성 검증은 아니다.

기존 개발 도구의 npm audit high 5건은 이번 react-icons 추가 후에도 남아 있다. 이전 Phase 검증 기록의 개발 의존성 문제이며 자동 major-upgrade는 적용하지 않았다.

## 후속 UI·팀원 추가 변경 검증

2026-10-07: 파일 형식별 카드/목록/미리보기 색상·아이콘, 중앙 native dialog, 참조 라벨/연결선 표시 토글, OWNER 전용 기존 가입자 추가 API/UI를 추가했다.

- 백엔드 103개 통과: 새 멤버의 실제 워크스페이스 접근, 다른 워크스페이스 격리, OWNER만 추가 가능, 임의 소유자 권한 부여 거부, 중복·동시 추가 멱등성, 미가입/중복 이메일 오류 포함.
- 데스크톱·모바일 브라우저 34개 통과: 기존 캔버스/업로드 회귀와 5종 파일의 서로 다른 색상, 중앙 모달 좌표·Esc 닫기, 본문/실패/재처리 표시, 참조 라벨/선 숨기기 시 데이터 유지, 실제 연결 삭제, 팀원 추가·새로고침 후 목록 유지·EDITOR 버튼 제한.
- 표시 토글은 현재 화면에만 적용한다. 팀원 추가는 가입자 계정만 대상이며 초대 메일을 발송하지 않는다. 테스트 외 실제 계정의 멤버십은 변경하지 않았다.

- 파일 5개 이상일 때 왼쪽 메뉴에 가리지 않도록 초기/전체 보기 여백을 보정했으며 관련 데스크톱·모바일 테스트 8개 재검증도 통과했다.
- [파일 형식별 스타일](images/phase-4-file-colors.png), [중앙 미리보기](images/phase-4-reader.png), [모바일 중앙 미리보기](images/phase-4-preview-mobile.png).
- 최종 ESLint 및 Next.js 운영 빌드 통과. 실행 중인 localhost 프런트엔드와 API health 응답 200 확인.
