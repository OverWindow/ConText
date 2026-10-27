# 로컬 데이터의 동기화 확장 계약

사용자가 선택하는 수동 데스크톱 → 웹 transport를 구현했다. 최초 연결은 서버 작업 공간을 멱등 생성하며, 이후에는 준비·업로드·검증·commit으로 게시한다. 로그인만으로 업로드하지 않는다. AI 요청과 파일 동기화는 별개다. 상세 계약과 제한은 [구현 문서](cloud-sync-implementation.md)를 따른다.

## 식별자와 경계

- workspace UUID와 기존 entry UUID를 보존한다. entry는 기기에서 파일 경로를 찾는 식별자다.
- 모든 일반 파일에는 별도 document UUID를 부여한다. 경로·inode·해시는 document ID가 아니다.
- version UUID는 불변 원본 바이트·SHA-256·정규화 본문을 가리킨다. 다른 문서의 버전을 연결하면 새 version UUID를 만들고 source_version_id로 출처를 유지한다. 원래 ID는 계속 유효하다.
- file_version_id는 이 기기의 실제 파일에서 관측한 버전이다. current_version_id는 논리적으로 지정한 검색 기준이다. pinned 상태는 외부 파일 변경으로 덮어쓰지 않는다.
- 초안과 문서 metadata는 정수 revision으로 충돌을 검사한다. canvas 요소와 관계도 revision과 삭제 tombstone을 갖는다.
- 논리 캔버스 scope UUID와 폴더의 기기별 상대 경로를 분리한다. 안정적인 폴더 identity로 외부 이름 변경이 확인되면 같은 scope를 새 경로에 연결한다.

## 계정 연결

데스크톱 일반 로그인은 웹과 같은 Supabase 프로젝트의 Google 계정을 사용하고 ConText `/api/me`로 검증한 application user UUID를 노출한다. Supabase 토큰의 임의 claim이나 기기별 session nonce를 동기화 소유자 ID로 사용하지 않는다. 토큰·refresh token·개인 AI 키는 main process의 OS 암호화 저장소에만 보관한다. 현재 API와 UI에는 계정 상태와 검증한 프로필만 전달한다.

로컬 작업 공간과 outbox는 기기별 자료다. 로그인·계정 변경·로그아웃은 기존 자료에 소유자 ID를 붙이거나 다른 계정에 전송하지 않는다. 수동 동기화는 선택한 작업 공간에 서버 권한 확인을 거친 계정 binding을 별도로 만들고, 전송 전후 동일 계정과 연결 generation을 확인한다. 계정 변경 시 전 계정 전송을 중단한다. 첫 버전은 로컬 작업 공간당 하나의 서버·계정으로 제한한다.

일반 계정과 기본 ChatKHU는 같은 세션을 공유한다. 로그아웃은 이 기기 세션을 제거하며 원본·기기 ID·로컬 배치·초안·대화·개인 AI 키를 유지한다. 웹의 다른 브라우저 세션은 함께 종료하지 않는다. 오프라인/인증 만료는 원격 동기화나 AI의 성공으로 취급하지 않고 로컬 작업만 계속 허용한다.

## 변경 기록

local_changes의 각 항목은 operation UUID, schema_version=1, device UUID, 기기 내 단조 증가 device_sequence, workspace/entity UUID, operation, base_revision, revision, payload, created_at을 가진다. 기기 ID와 순번은 재시작 후에도 유지된다.

초안·문서 head/버전·캔버스 요소/관계/위치의 metadata 변경과 해당 변경 기록은 같은 SQLite 트랜잭션에 저장한다. 실패 시 metadata와 순번 증가도 롤백한다. 삭제는 별도 operation과 tombstone으로 나타낸다. 실제 파일 저장은 이 트랜잭션 밖의 journal로 복구한다.

절대 파일 위치, workspace root, inode, 로컬 자격 증명, save journal, native 대화상자 경로, 기기별 viewport와 마지막 진입 폴더는 payload에 넣지 않는다. 웹 복원을 위해 폴더 이름·부모 UUID·폴더 안의 저장 좌표와 명시적 영역 배치 표식을 공통 모델로 전송한다. 파일 노드는 logical document UUID, 폴더 노드는 logical scope UUID를 사용한다. source/버전 참조는 불변 UUID를 유지한다.

기존 초기 구현에서 기록한 document.version 이벤트는 마이그레이션 시 불변 version entity의 생성 이벤트로 정규화한다. 첫 transport는 로그를 그대로 재생하지 않고 전체 metadata 스냅샷과 원본 BLOB을 물질화한다. 원본 버전은 불변 키·해시로 검증하며 정규화 본문·색인은 서버에서 만든다. 바이트가 같은 raw 스냅샷을 로컬에서 색인할 때 UUID·버전 번호를 유지한다. 확인 응답의 source_sequence와 스냅샷 서명을 보관하고 이후 변경은 다음 동기화로 남긴다.

연결 해제는 해당 작업 공간의 로컬 변경 기록·문맥 캐시·scope/배치 revision을 함께 정리한다. 원본 파일·내보낸 파일·이전 DB 백업·파일 저장 복구 자료는 삭제하지 않는다. 현재 기기 identity는 다른 작업 공간과 공유하므로 유지한다. 이 동작은 아직 원격 삭제를 뜻하지 않는다.

## 후속 구현 시 정해야 할 사항

워크스페이스의 원격 삭제는 별도 `DELETE /api/workspaces/{id}`다. 소유자만 실행하며 서버 `deleted_at`과 binding `DELETED`/generation으로 늦은 전송과 자동 재생성을 차단한다. 웹 목록·데스크톱 동기화 메뉴에서 실행할 수 있다. 로컬 원본과 앱 자료는 유지하고 서버 자료는 논리 삭제 상태로 보관한다. 영구 파기·복구 UI·삭제한 연결의 새 공간 재생성은 아직 지원하지 않는다. 자세한 불일치와 후속 개선 순서는 [점검 기록](web-desktop-sync-audit.md)을 따른다.

- 작업 공간·파일·대화·초안의 동기화 선택과 사용자 동의 범위.
- operation ID 멱등 처리, 서버 revision 사전조건, 확인 응답 cursor, outbox 정리와 보존 기간.
- 기기 복제/복원 시 device ID 재발급 정책과 tombstone 수명.
- 같은 문서의 동시 편집 병합·복사본 보존 UI, 파일 시스템 journal과 서버 성공 응답 사이의 재시작 복구.
- 대상 파일을 어느 로컬 경로에 둘지 정하는 기기별 mapping. 서버가 임의 로컬 절대 경로를 지시하지 않도록 한다.
- 삭제된 원본과 읽기 실패/외장 드라이브 해제를 구분하며, 원본 누락을 자동 원격 삭제로 전파하지 않는다.
- 비밀 키·토큰·기기별 경로가 blob/관계/초안 출처에 섞이지 않는지 최종 payload 검증.

구현 근거는 electron/local-documents.mjs, local-canvas.mjs, engine.mjs와 documents/processor 테스트에 있다. 현재 로그는 로컬 확장 기반이며 서버 간 충돌 해결을 보장하지 않는다.

## 형식 변환과 실제 복사본

`local_conversions`의 변환 상태·출력 BLOB·변환기 fingerprint와 `local_copy_requests`의 요청 기록·기기별 경로·임시 파일 정보는 로컬 처리 자료이며 outbox payload에 전송하지 않는다. 변환은 기존 문서의 현재 버전을 바꾸지 않는다. 복사본은 새 파일 entry·document·version UUID를 갖고 원본 이력과 연결될 때 `source_version_id`와 `document.version.copy` 기록을 사용한다. 바이너리 파일도 별개의 logical document ID를 가지며 파싱 가능한 문서만 본문 색인과 버전 스냅샷을 만든다. 배치 undo는 디스크 복사본을 삭제하지 않는다.
