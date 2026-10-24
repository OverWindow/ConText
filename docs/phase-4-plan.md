# Phase 4 — Document Processing / 한국어 전체 화면 UI

## 현재 구조와 범위

Phase 3의 Supabase 인증, Workspace 권한, S3 원본·버전, React Flow와 좌표/관계 저장을 유지한다. 이번에는 PDF/DOCX/HWPX/TXT/Markdown 파싱과 공통 문서 구조를 비동기로 생성하고, 전체 UI를 한국어로 바꾼다. 버전 비교·AI/RAG·OCR·문서 변환은 구현하지 않는다.

## 처리 구조

- Redis + Celery worker, DB 작업 레코드를 주기적으로 전달하는 dispatcher. 업로드 완료와 작업 생성은 같은 DB transaction으로 처리해 Redis 장애에도 작업을 잃지 않는다.
- DocumentVersion에 원본 검증 시각, 별도 processing 테이블에 상태/시도 횟수/실행 토큰/오류/산출물 메타데이터를 저장한다.
- worker는 원본 크기·SHA-256을 다시 확인하고 제한된 입력을 파싱한다. 파일 유형별 parser가 NormalizedDocument(heading/paragraph/list_item/table/code와 원본 위치)를 만든다.
- normalized.json과 extracted.txt는 private S3의 해당 버전 하위에 저장한다. DB에 성공한 산출물 key를 기록하고 READY로 전환한다. 중복 실행은 행 잠금·실행 토큰으로 차단한다.
- UTF-8/UTF-16 및 한국어 CP949 텍스트, PDF 페이지, DOCX 문단/표, HWPX 본문 XML, Markdown 구조를 지원한다. 이미지 PDF는 OCR 필요 상태를 명확히 표시한다. ZIP/XML 크기·파일 수/페이지/출력 크기·처리 시간을 제한한다.
- 실패 시 한국어 사유와 재처리 기능. 파싱 실패해도 검증된 원본 다운로드는 가능하다. 멤버만 결과 조회, OWNER/EDITOR만 재처리한다.

## 화면 방향

- 100dvh 전체 화면 격자 캔버스, html/body 스크롤 금지. 캔버스는 배경 끝까지 채우고 메뉴/도구는 위에 떠 있는 패널로 배치한다.
- 왼쪽 탐색 메뉴(캔버스/문서/관계/팀원), 실제 WorkspaceMember 목록·역할, 상단 워크스페이스 제목·검색·업로드 메뉴.
- React Icons의 Lucide 아이콘, 밝은 회색 격자·흰 카드·보라색 강조, 파일 형식별 카드 아이콘과 처리 상태.
- 아이콘/드롭다운의 파일 선택과 캔버스 파일 드래그 앤 드롭. 업로드·문서 상세·관계 편집은 고정 패널/모달에서 처리한다. 긴 목록·추출 본문만 해당 패널 내부에서 스크롤한다.
- 모바일에서는 메뉴와 상세를 접고 화면 안에서 열도록 한다. 모든 버튼/상태/오류/aria 라벨은 한국어로 제공한다. 팀원은 실제 데이터를 조회하며 초대 기능을 허위로 표시하지 않는다.

## 검증

실제 PostgreSQL + Redis + worker 및 S3 에뮬레이터에서 업로드→작업→정규화·READY, 실패·재시도·중복/오래된 작업 회복, parser 샘플 5종, 권한과 기존 기능을 검증한다. 데스크톱/모바일 브라우저에서 전체 화면·페이지 스크롤 없음·아이콘 업로드/드롭·처리 상태/본문·팀원·캔버스 회귀를 확인하고 스크린샷으로 UI를 검토한다. 실제 S3 추가 권한은 기존 GetObject/PutObject 범위로 충분하도록 유지한다.
