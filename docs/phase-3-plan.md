# Phase 3 — Canvas Workspace 계획

## 검토와 범위

Phase 2 실버킷 검사에서 presigned PUT/GET, HEAD checksum·MIME·크기·암호화 검증, CORS, 덮어쓰기 차단, 익명 GET 차단을 통과했다. 이를 바탕으로 기존 Next.js/FastAPI/PostgreSQL 구조를 확장한다. 인증·S3 경로를 재사용한다.

- React Flow의 문서 카드, 격자 배경, 드래그 이동, 선택, 줌/팬, 전체 보기.
- 서버에 워크스페이스 공용 문서 위치를 저장하고 새로고침 시 복원.
- 문서 간 방향 있는 REFERENCE/DERIVED_FROM/GENERATED_FROM/RELATED_TO 관계 생성·조회·삭제 및 라벨 표시. VERSION 연결은 Phase 5에서 구현한다.
- OWNER/EDITOR는 위치·관계 편집, VIEWER는 탐색·선택·다운로드만 허용.
- 기존 업로드·목록·재시도 UI를 보조 영역으로 유지하고 업로드 후 캔버스를 갱신한다.

## 데이터와 API

`document_positions`는 document_id PK, x/y, updated_by/updated_at을 저장한다. 없는 위치는 정렬된 문서를 기반으로 초기 격자에 배치한다. 위치 저장은 이동한 문서만 PATCH하며 전부 검증한 뒤 원자적으로 upsert한다. 같은 문서를 동시에 이동하면 마지막으로 commit된 좌표가 유지된다. 실시간 협업은 이번 범위 밖이다.

`document_relations`는 workspace_id, source_document_id, target_document_id, relation_type, created_by/created_at을 저장한다. 양 끝 문서가 같은 Workspace에 속하도록 복합 FK로 보장하고 자기 연결·중복 관계를 차단한다.

- GET `/api/workspaces/{id}/canvas`: 문서 metadata·위치·관계 snapshot. 최대 1,000개 문서를 지원하고 초과하면 명시적 오류를 반환한다.
- PATCH `/api/workspaces/{id}/canvas/positions`: 최대 100개 좌표의 부분 저장.
- POST `/api/workspaces/{id}/relations`: 관계 생성, 동일 관계는 재사용.
- DELETE `/api/workspaces/{id}/relations/{relation_id}`: 관계만 삭제하며 문서에는 영향 없음.

## 실패 처리와 검증

자동 저장 상태 및 실패 재시도, 미저장 변경이 있는 동안 새로고침 경고. 읽기 전용 사용자에게 편집 동작을 숨기고 API에서 재검사한다. 관계 생성은 핸들 연결과 키보드/모바일용 선택 폼을 함께 제공한다.

PostgreSQL의 migration·권한·workspace 격리·유효 좌표·배치 rollback·관계 중복/복합 FK를 테스트한다. 브라우저에서 위치 저장/복원·실패 재시도·관계 생성/삭제·VIEWER·줌/팬 및 업로드 회귀를 확인한다. 타입/lint/build를 수행한다. 파싱·파일 미리보기 생성·버전 분석·AI는 Phase 4 이후로 남긴다.
