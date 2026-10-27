# 데스크톱 기반 단일 워크스페이스 아키텍처 제안

2026-10-26. 상태: 설계 제안. 이 문서 작성으로 앱 구조나 DB를 변경하지 않았다.

2026-10-27: 이 설계를 기준으로 개발 환경 전환과 macOS 앱 구현·검증을 완료했다. 현재 상태와 범위는 [검증 기록](unified-workspace-progress.md), 항목별 대조는 [아키텍처 검증표](unified-workspace-audit.md)에 있다.

## 전제와 결정

데스크톱의 폴더·문서 이력·중첩 캔버스·메모·초안·채팅을 제품의 기준 동작으로 삼는다. 기존 웹의 문서·캔버스 데이터와 API 호환성은 유지 조건에서 제외할 수 있다. **데스크톱의 원본 파일과 로컬 이력·초안·배치는 보존한다.** 웹 데이터 포기와 로컬 자료 포기를 같은 것으로 취급하지 않는다.

권장 구조는 **같은 TypeScript 도메인과 React 워크스페이스 UI + 플랫폼별 저장 어댑터 + 변경 단위 양방향 동기화**다. 데스크톱의 오프라인 작업은 유지하고, 웹은 첫 전환에서 온라인 편집을 완성한다. 브라우저 오프라인 편집은 같은 명령 계약 위에 별도 단계로 추가한다.

편집 규칙까지 실제로 같은 코드를 실행하려면 워크스페이스 명령 API를 Node/TypeScript로 옮기는 방향을 권장한다. 기존 Python 문서 파서·변환기·검색/AI 처리 코드는 작업 서비스로 재사용한다. 인증·권한·S3 접근 검증은 새 API에서도 반드시 구현하고 회귀 검증한다. 서버를 Node로 바꾸는 것만으로 공통화가 완료되는 것은 아니다.

FastAPI를 유지하면서 공통 스키마와 계약 테스트로 맞추는 방법도 가능하지만, 그 경우 Python과 JavaScript에서 편집 규칙을 각각 구현해야 한다. 지금처럼 웹·데스크톱 의미가 계속 갈라지는 문제를 줄이려는 목표에는 공통 코어를 서버도 실행하는 구성이 더 적합하다. Node API를 별도로 추가하고 FastAPI 워크스페이스 API까지 영구 병행하는 구성은 목표로 삼지 않는다.

## 현재 코드에서 출발할 곳

| 현재 구현 | 전환 방향 |
|---|---|
| `apps/desktop/src/local-canvas.tsx` | 제품 기준 캔버스로 삼고 직접 `window.contextDesktop` 호출을 repository 주입으로 바꿔 공통 UI로 추출 |
| `frontend/shared/canvas`, `shared/ui`, `shared/writing`, `shared/chat` | 공통 패키지로 이동. 이미 공유한 편집기·레이아웃·채팅 UI를 재사용 |
| `frontend/shared/core`와 desktop/web draft·chat repositories | 공통 계약의 출발점. 현재 불완전한 Source·버전·캔버스 revision 계약은 먼저 수정 |
| `apps/desktop/electron/engine.mjs`, `local-documents.mjs`, `local-canvas.mjs` | DB/파일 I/O와 편집 규칙을 분리. 규칙은 도메인 코어, I/O는 SQLite/native 어댑터로 이동 |
| `frontend/features/canvas/workspace-canvas.tsx` | 별도 웹 전용 캔버스 구현을 공통 워크스페이스 화면으로 교체 |
| `frontend/features/workspace/cloud-workspace.tsx` | 읽기 전용 스냅샷 화면을 공통 워크스페이스 화면으로 교체 |
| `backend/app/services/sync.py`와 `sync_mode=desktop` 쓰기 차단 | 초기 import 이후 명령 push/change pull로 교체. 모든 워크스페이스에 같은 편집 규칙 적용 |
| 기존 Python parser·converter·RAG·AI 모듈 | 연산을 재사용하되 공통 artifact/source 계약과 새 작업 완료 인터페이스에 연결 |

같은 캔버스를 세 번 유지하는 현재 구조를 하나로 줄인다. 패키지는 다른 앱 내부 소스를 상대 경로로 참조하는 대신 모노레포 의존성으로 빌드·배포한다.

## 코드 배치

```text
packages/
  contracts/          버전이 있는 스키마, 명령·이벤트·오류, Python용 계약 생성물
  domain/             엔티티 규칙, 명령 검증, 변경 계산, 충돌 판단: 순수 TypeScript
  workspace-client/   공통 애플리케이션 상태, repository, pending 변경·구독 처리
  workspace-ui/       데스크톱 기반 캔버스·문서·초안·채팅·충돌 UI
  sync-client/        outbox 전송, ACK, cursor pull, 재접속·bootstrap
apps/
  desktop/            Electron shell, SQLite, OS 보안 저장소, 파일 watcher·저장 journal
  web/                Next.js shell, HTTP repository, 업로드·다운로드
  server/             Node API, 인증·권한, 공통 domain 실행, PostgreSQL/S3 어댑터
workers/
  documents-ai/       기존 Python 파싱·변환·검색·AI 처리
```

`domain`은 Electron, 브라우저, SQL, 네트워크를 import하지 않는다. 같은 명령과 같은 입력 상태에는 같은 결과를 낸다. SQLite/PostgreSQL 어댑터가 필요한 상태를 읽고 transaction 안에서 규칙을 실행한다. 서버는 클라이언트의 검증 결과를 신뢰하지 않고 권한과 규칙을 다시 검사한다.

공통 UI에는 `WorkspaceRepository`, `DocumentRepository`, `CanvasRepository`, `DraftRepository`, `ChatRepository`, `BlobRepository`, `PlatformCapabilities`를 주입한다. 폴더 탐색기 열기·OS 휴지통·로컬 폴더 연결은 native 기능이며 웹에서는 업로드·다운로드 등의 가능한 동작을 제공한다. 브라우저 파일 접근에는 사용자 허가와 브라우저별 제약이 있으므로 native 어댑터를 웹에 그대로 이식하지 않는다. [File System API 문서](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API)

## 공통 데이터 모델

SQLite와 PostgreSQL의 물리 테이블을 똑같이 만들 필요는 없다. 엔티티의 ID·필드 의미·명령·충돌 규칙은 같아야 한다.

| 엔티티 | 공통 의미와 핵심 결정 |
|---|---|
| Workspace | 웹·여러 기기가 공유하는 하나의 UUID. 로컬 root는 필드에 넣지 않음 |
| Entry | 폴더·파일 노드의 안정적인 UUID, `parent_id`, 이름, 종류, revision, 삭제 상태. 상대 경로는 트리에서 계산 |
| Document | 문서 UUID. 파일 Entry와 명시적으로 연결. 캔버스 배치는 Entry를, 문서 관계와 인용은 Document/Version을 참조 |
| DocumentVersion | 불변 UUID와 원본 blob, SHA-256, 부모 버전들. 버전 표시 번호는 정체성으로 사용하지 않음 |
| CanvasScope | 폴더 Entry UUID 기준. 폴더 이름·경로가 바뀌어도 같은 scope 유지 |
| CanvasElement / Relation | scope와 revision을 포함. UI 표시용 entry ID와 문서 관계 ID를 저장 단계마다 뒤바꾸지 않음 |
| Draft / Proposal | 본문·출처·검토 결과·저장 이력·승인 대기 제안을 공통 계약으로 관리 |
| ChatSession / ChatMessage | 공통 논리 데이터. 동기화할 대화와 기기 전용 대화를 명시적으로 구분 |
| SourceSnapshot | `document / note / chat / draft` 종류별 참조와 생성 당시 인용문을 보존. 원본이 삭제되어도 인용문은 읽을 수 있음 |
| Blob / DerivedArtifact | 원본은 불변 저장. 파싱·변환·색인은 원본 버전+처리기 fingerprint로 구분하는 파생 결과 |
| DeviceBinding | 같은 Workspace에 여러 기기 연결 허용. 기기별 cursor·권한·세대 정보 |

### 실제 파일과 논리 버전 분리

현재 desktop의 `current_version_id`와 `file_version_id`를 단순히 서버 전역 필드로 복제하면 여러 PC의 디스크 상태를 표현할 수 없다. 다음 의미로 분리한다.

- **content head**: 워크스페이스에서 선택한 최신 파일 내용. 웹 저장·데스크톱 파일 관측이 변경을 제안하는 대상.
- **reference head**: 검색·AI에서 기준으로 삼는 논리 버전과 고정 여부. 기존 데스크톱의 과거 버전 고정 기능을 보존한다.
- **observed version**: 특정 기기의 실제 파일이 현재 어떤 버전인지. 기기별 로컬 mapping에 저장한다.
- **viewed version**: 사용자가 지금 미리보기에서 선택한 버전. 기기/사용자 UI 설정이다.

웹에서 버전 B를 저장했어도 꺼져 있는 PC의 파일은 A일 수 있다. 서버 content head는 B, 그 PC observed version은 A로 표현하고, 다운로드·적용 후에만 observed version을 B로 바꾼다.

버전 UUID와 content hash를 정체성으로 사용하고, 각 기기가 독립적으로 계산한 `version_number=7`을 고유 제약으로 삼지 않는다. 두 PC의 동시 수정은 서로 다른 불변 버전으로 보관하고 공통 부모로 연결한다. 변경 계보의 부모와 다른 문서에서 가져온 출처(`source_version_id`)는 서로 다른 관계로 모델링한다.

### 기기 안에만 남기는 자료

root 절대 경로, inode, 실제 파일 이름/경로 mapping, 마지막 관측 hash, filesystem 적용 journal, OS 권한, 토큰·AI 개인 키, viewport와 창 상태는 기기 자료다. Workspace를 여러 기기에 복제해도 각 기기가 자기 폴더를 선택한다. 공통 코어에는 파일을 읽고 쓰는 권한이나 임의 절대 경로를 주지 않는다.

## 명령과 변경 동기화

UI나 파일 watcher가 DB를 직접 수정하지 않고 다음과 같은 명령을 만든다.

```text
CreateEntry / MoveEntry / TrashEntry
AppendDocumentVersion / SelectContentHead / SelectReferenceHead
SetEntryPositions / PutCanvasElement / RemoveCanvasElement / PutRelation
CreateDraft / SaveDraft / ReviewProposal
AppendChatMessage / CompleteAIRequest
DeleteWorkspace / DetachDevice
```

각 명령에는 `schema_version`, `operation_id`, `workspace_id`, actor/device, 영향받는 엔티티들의 `base_revision`, 필요한 blob 참조를 포함한다. 권한 actor는 서버에서 인증한 값으로 결정하며 클라이언트 payload의 사용자 ID를 신뢰하지 않는다.

1. **데스크톱 저장:** SQLite에서 로컬 변경과 outbox를 같은 transaction에 저장한다. 앱 재시작 후에도 미전송 변경이 남는다. 로컬 pending 상태와 서버에서 확인한 revision은 따로 보관한다.
2. **업로드 준비:** 새 blob만 presigned PUT으로 올린다. checksum/크기 검증이 끝나기 전에는 해당 원본을 가리키는 변경을 게시하지 않는다.
3. **서버 반영:** Node API가 인증·멤버십·workspace 삭제 세대를 검사한다. PostgreSQL transaction에서 base revision·참조·형제 이름·트리 구조를 검사하고 엔티티 변경, operation receipt, 서버 변경 로그를 함께 기록한다.
4. **서버 순서:** workspace별 잠금 아래 단조 증가 change sequence를 발급한다. cursor가 아직 commit되지 않은 앞선 변경을 건너뛰지 않게 한다. 같은 operation ID의 재시도에는 같은 결과를 반환한다. [PostgreSQL 잠금 문서](https://www.postgresql.org/docs/17/explicit-locking.html)
5. **변경 수신:** 기기는 `after=cursor`로 변경을 페이지 조회하고 로컬 적용과 cursor 갱신을 같은 transaction에서 처리한다. 웹의 편집·AI 작업 완료도 같은 로그로 전파한다. 자신의 operation echo는 중복 반영하지 않는다.
6. **갱신 알림:** SSE 또는 WebSocket은 ‘새 변경 있음’ 신호로 사용한다. 신호 유실·재접속 시에도 cursor pull로 복구한다.
7. **초기화·오래된 기기:** 첫 연결과 로그 보존 기간을 지난 기기만 일관된 bootstrap snapshot을 받는다. snapshot 기준 sequence 이후의 변경을 이어서 받으며, 기존 outbox는 보존하고 새 기준에 대해 충돌을 판정한다.

전체 metadata snapshot은 최초 import·bootstrap·명시적 복구에 사용한다. 작은 파일 수정 때마다 전체 버전 이력을 복사하지 않는다.

단순 서버 화면 조회와 브라우저 optimistic 갱신도 이 명령 계약을 사용한다. 브라우저가 200개만 읽었다고 같은 폴더에 다른 이름의 파일이 없다고 단정하지 않는다. 전체 정합성 검사는 충분한 read set과 DB 제약을 가진 서버에서 수행한다.

## 충돌과 실제 디스크 적용

| 상황 | 처리 원칙 |
|---|---|
| 서로 다른 문서/메모 수정 | 독립적인 엔티티 revision으로 수용 |
| 같은 파일의 서로 다른 오프라인 수정 | 양쪽 버전을 보존하고 conflict로 표시. 사용자가 선택하거나 새 병합 버전을 생성 |
| 같은 초안·메모 본문 동시 수정 | base revision 불일치를 반환하고 양쪽 내용을 보존. 첫 버전부터 실시간 글자 단위 공동 편집을 요구하지 않음 |
| 위치만 바뀌고 본문은 그대로 | 서로 다른 변경 영역으로 명확히 구분한 명령만 자동 병합 |
| 같은 이름 생성·폴더 이동 | 부모/Entry를 함께 검증하고 DB 제약과 transaction으로 처리. 순환 폴더 거절 |
| 다른 PC에서 표현할 수 없는 이름 | OS별 대소문자·Unicode·예약 이름 충돌을 표시하고 적용 보류. 원격 자료를 임의로 개명하거나 누락하지 않음 |
| 드라이브가 빠지거나 스캔이 잘림 | 접근 불가/불완전 스캔으로 기록. 원격 삭제나 완전 동기화 성공으로 취급하지 않음 |
| 삭제와 수정이 동시에 도착 | 삭제 세대와 base revision으로 차단하고 수정본은 복구 가능한 conflict로 보관 |

웹 수정이 데스크톱으로 내려오면 **현재 디스크가 마지막으로 관측한 버전과 같은지** 확인한다. 같으면 다운로드·검증·staging·파일 교체 journal을 거쳐 반영한다. 다르면 외부 편집 내용을 새 로컬 버전으로 보존하고 충돌을 알린다. SQLite commit과 파일 교체를 하나의 원자적 transaction이라고 가정하지 않으며, 적용 중 종료를 기존 journal 방식으로 복구한다. watcher는 원격 적용으로 생긴 변경을 hash/operation receipt로 식별해 무한 재업로드를 막는다.

동기화 상태는 최소 `로컬 저장 / 업로드 대기 / 서버 반영 / 다운로드 대기 / 파일 적용 대기 / 충돌 / 확인 불가`를 구분한다. 서버 게시 완료와 모든 PC의 디스크 적용 완료는 다른 사실이다.

## DB와 API의 목표

서버 논리 테이블은 다음 묶음으로 정리한다. 실제 테이블 수는 기존 처리 모델 재사용 범위에 맞춰 확정한다.

| 묶음 | 테이블 예시 |
|---|---|
| 계정·공간·기기 | `users`, `workspaces`, `workspace_members`, `device_bindings` |
| 폴더·문서·버전 | `entries`, `documents`, `document_versions`, `version_parents`, `version_sources` |
| 작업 내용 | `canvas_elements`, `canvas_relations`, `drafts`, `chat_sessions`, `chat_messages`, 출처 snapshot |
| 원본·파생 결과 | `blobs`, `blob_uploads`, `derived_artifacts`, `processing_jobs` |
| 동기화·복구 | `workspace_changes`, `command_receipts`, `sync_conflicts`, 기기 ACK cursor |

클라이언트 SQLite에는 같은 논리 엔티티 외에 `outbox`, 확인된 서버 상태/pending overlay, device mapping, file apply journal, UI 설정이 들어간다. 서버의 인증 테이블·embedding 저장 방식까지 SQLite와 일치시키지 않는다.

```text
POST   /v2/workspaces
POST   /v2/workspaces/{id}/devices
POST   /v2/workspaces/{id}/commands
GET    /v2/workspaces/{id}/changes?after=...&limit=...
GET    /v2/workspaces/{id}/bootstrap
GET    /v2/workspaces/{id}/entries?parent_id=...&cursor=...
GET    /v2/workspaces/{id}/search?q=...&cursor=...
POST   /v2/workspaces/{id}/blobs/prepare
POST   /v2/workspaces/{id}/blobs/complete
GET    /v2/workspaces/{id}/conflicts
POST   /v2/workspaces/{id}/conflicts/{conflictId}/resolve
DELETE /v2/workspaces/{id}
DELETE /v2/workspaces/{id}/devices/{deviceId}
```

`commands`는 여러 변경을 필요한 원자적 단위로 묶고, 단일 오류 때문에 관계없는 outbox 전체를 영구 중단하지 않도록 명령별 결과와 의존성을 관리한다. 업무 규칙 변경은 전용 명령으로 표현하며 임의 테이블 patch API로 만들지 않는다.

Python 작업 서비스는 같은 contracts에서 생성한 입력/출력 모델을 사용한다. 파생 artifact는 명시적인 전용 저장 경로에 게시할 수 있지만 문서 head·초안·대화 같은 공통 엔티티 변경은 완료 명령/transaction을 통해 change log에도 기록한다. 모델 실행이 재시도되어도 이미 완료한 요청을 다시 과금·게시하지 않도록 기존 request ID 멱등성을 보존한다.

## 삭제 계약

- **기기 연결 해제:** 해당 binding과 로컬 앱 자료 정리 범위를 명시한다. 다른 기기와 cloud Workspace를 삭제하지 않는다.
- **Workspace 삭제:** 소유자 명령으로 모든 기기의 후속 게시를 차단하는 tombstone과 deletion epoch를 남긴다. 로컬 원본 폴더는 유지한다.
- **파일 삭제:** 공통 논리 휴지통과 기기 원본 파일 처리를 구분한다. 원격 삭제만으로 관측 이후 수정된 디스크 파일을 지우지 않는다. OS 휴지통 적용 정책과 충돌 처리를 별도 명령으로 둔다.
- **기기에서 파일이 없어짐:** 오류·드라이브 분리·제외 설정과 구분해서 판단한다. 단일 누락 이벤트를 원격 영구 삭제로 바꾸지 않는다.
- **영구 파기:** tombstone 보존 기간과 오래된 기기의 재등록 정책을 함께 정한다. GC는 살아 있는 버전·출처·충돌 보관이 참조하는 blob을 지우지 않는다.

## 전환 단계와 완료 기준

| 단계 | 작업 | 다음 단계로 넘어갈 조건 |
|---|---|---|
| 1. 계약 확정 | Source 종류, Entry/Document ID, 버전 head, 명령·이벤트·오류 스키마와 fixture 정의 | 데스크톱에서 정상 생성하는 모든 자료가 계약 검증을 통과 |
| 2. 데스크톱 코어 추출 | domain/repository/UI 분리, SQLite와 native adapter 연결 | 기존 데스크톱 기능·파일 보존·저장 복구 회귀 통과 |
| 3. 새 서버 모델 | 새 DB/schema에 Node 명령 API·트리 페이지 조회·blob 처리·삭제 구현 | 같은 fixture 명령을 SQLite/PostgreSQL에 실행한 공통 엔티티 결과가 일치 |
| 4. 웹 교체 | 공통 워크스페이스 UI와 HTTP repository 사용, 폴더·문서·초안·채팅 편집 연결 | 데스크톱 기준 동작을 웹에서도 수행하고 서버에 정상 저장 |
| 5. 양방향 연결 | 최초 import + push/pull + 기기별 파일 적용 + 충돌 화면 | 웹 저장을 다른 PC에서 받고, 오프라인 동시 수정·응답 유실·재시작에서 양쪽 자료 보존 |
| 6. 전환·정리 | 로컬 DB migration, 새 개발 DB 연결, 구 API/중복 화면 제거, 운영 설정 갱신 | 구 클라이언트가 새 저장소를 수정하지 못하고 새 앱만 사용하여 전체 흐름 통과 |

서버 데이터는 새 개발 DB/schema로 시작할 수 있다. 기존 개발 DB를 먼저 백업한 뒤 컷오버하고, 기존 S3 자료는 별도 참조 점검/정리 대상으로 둔다. Supabase 인증 계정·개인 키·기기 원본까지 초기화하는 작업으로 확대하지 않는다.

데스크톱 SQLite는 일관된 백업 후 migration한다. 기존 workspace/document/version/메모/초안 UUID와 원본 BLOB·인용문은 보존하고, 기존 경로 기반 scope를 Entry ID에 매핑한다. 예전 cloud binding과 pending snapshot은 v2 연결 상태로 다시 수립한다. 구 snapshot 전송이 새 DB에 도착하면 protocol version/epoch 검사로 거절한다.

대규모 전환 중 기존 동작을 한 번에 제거하지 않고 위 단계별로 검증하되, 최종 구조는 공통 UI 한 벌과 명령 경로 한 벌이다. 웹 데이터의 과거 스키마 호환 레이어를 계속 유지하는 비용은 들이지 않는다.

## 필수 검증 시나리오

- 데스크톱 폴더 최초 게시 → 웹 같은 폴더·배치·원본·이력·혼합 출처·초안·선택한 대화 확인.
- 웹 이름/폴더/파일 내용 변경 → 데스크톱 같은 Entry UUID와 디스크에 안전하게 적용.
- 두 PC가 오프라인에서 같은 버전 수정 → 둘 다 보존, 충돌 UI와 해결 후 수렴.
- 서버 commit 직후 응답 유실 → 중복 버전·중복 채팅·중복 AI 실행 없이 재개.
- 디스크 교체 전후 앱 종료 → journal로 복구, watcher echo 중복 게시 없음.
- 폴더 한 개에 2,001개 이상, 전체 25,001개 이상 → 페이지 조회 또는 명시적 불완전 상태. 일부 목록을 전체 완료로 표시하지 않음.
- 출처 파일 연결 해제·삭제 → 인용문 유지, 존재하지 않는 source를 정상 열기 대상으로 표시하지 않음.
- 계정/권한 변경, workspace 삭제 뒤 오래된 기기 재접속 → 자료 유출·자동 부활 없음.
- 잘못된/다른 OS의 이름·폴더 이동·대소문자 충돌 → 원격 자료와 로컬 원본을 보존하고 적용 실패를 구체적으로 표시.

이번 제안의 구현 범위·위험은 UI 교체보다 **도메인 규칙 추출, 파일 적용 복구, 버전 충돌 계약**에 집중된다. 기존 웹 데이터 이전을 생략할 수 있어도 이 세 가지는 생략하지 않는다.
