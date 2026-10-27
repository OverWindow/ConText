# 선택적 데스크톱 → 웹 동기화

2026-10-26. 승인한 첫 범위는 사용자가 선택한 로컬 작업 공간을 수동으로 클라우드에 게시하고, 동일 계정의 웹에서 폴더·원본·문서 이력·배치·메모·초안을 여는 것이다. 웹에서 동기화 원본을 수정하는 양방향 처리는 후속 범위다.

구현 후 확인한 스키마·출처·대용량 조회의 불일치와 삭제 기능은 [웹·데스크톱 동기화 점검](web-desktop-sync-audit.md)에 정리했다. 이 문서의 최초 검증 수치와 구분하여 최신 결과를 해당 문서에 기록한다.

## 구현 원칙

- 기존 미커밋 변경을 보존한다. 시작 tracked diff는 `/private/tmp/context-cloud-sync-before.patch`에 저장했다.
- 여섯 서버 테이블: sync_bindings, workspace_entries, canvas_scopes, sync_sessions, sync_session_items, sync_operations.
- 스냅샷 manifest를 페이지별로 준비하고 파일은 불변 S3 키에 직접 업로드한다. 검증 후 한 DB 트랜잭션으로 게시한다.
- 계정·서버·연결 generation을 고정한다. 재시도는 같은 요청 ID를 사용하고 ACK를 받기 전에는 로컬 완료 cursor를 이동하지 않는다.
- 파일·버전 UUID를 보존한다. 파일명과 폴더 계층만 전송하고 로컬 절대 경로·키·토큰·뷰포트는 전송하지 않는다.
- 원본 누락·외장 드라이브 분리는 원격 삭제로 처리하지 않는다. 일반 파일과 빈 파일도 보관하며 파싱 지원 여부와 저장 여부를 분리한다.
- 기존 사용자·권한·S3·파서·worker를 재사용한다. 동기화 작업 공간의 웹 원본 수정은 서버에서도 제한한다.
- 임시 업로드·만료 세션 정리는 참조 여부와 세션 상태를 잠근 뒤 처리한다.

## 검증 목표

분리된 PostgreSQL/S3 테스트에서 최초 전송, 중첩·빈 폴더, 일반·빈 파일, 버전/출처, 재전송, 중간 실패, 응답 유실, 계정 격리, revision 충돌, 원본 누락, 취소·계정 변경을 확인한다. 웹·데스크톱 타입/빌드와 UI 검사를 수행한다. 실제 개발 DB 적용 전 백업한다.

## 진행

- 현재 구조와 인증·업로드·캔버스 계약을 확인했다. Docker 테스트 환경 사용 가능.
- 서버 모델·마이그레이션 → 전송 API/서비스 → 로컬 내보내기/전송 → 웹 복원 → 통합 검증 순으로 진행한다.

## 구현 결과와 계약

위 여섯 서버 테이블과 migration `0013_cloud_sync`, SQLite 9의 `local_cloud_states`, Electron main의 전송 엔진과 IPC, 웹 동기화 작업 공간 화면을 추가했다. 기존 `document_positions`는 웹 전용 작업 공간과의 호환성을 위해 유지하고, 동기화 파일·물리 폴더의 위치는 `workspace_entries.x/y/area_positioned`에서 관리한다. 중첩 폴더의 투영·축소 계산과 폴더 노드 UI는 웹·데스크톱 공통 코드로 이동했다.

- 파일 노드 ID는 logical document UUID, 폴더 노드와 scope ID는 기존 logical scope UUID다. 서버 workspace UUID와 local workspace UUID는 binding으로 연결한다.
- 문서 원본과 모든 보관 버전, 실제 파일 head와 고정한 검색 head를 각각 유지한다. 일반 파일·빈 파일은 저장하며 파싱 가능한 비어 있지 않은 버전만 기존 처리 큐에 넣는다.
- 파일 원본은 `teams/{team}/workspaces/{workspace}/sync-uploads/{session}/versions/{version}`에 불변 업로드한다. 기존 `teams/*` 읽기·쓰기 IAM 범위를 재사용한다.
- 첫 버전은 전체 metadata 스냅샷을 게시한다. 이미 검증된 version UUID의 바이트는 다시 보내지 않는다. `sync_operations`는 작업 단위 재생 로그가 아닌 commit receipt이며 request UUID·서버 revision·확인한 device sequence·manifest hash를 보관한다.
- 원본을 읽는 동안 inode·크기·mtime·ctime을 확인하고, 업로드 전에 보관 바이트의 해시를 다시 확인한다. 파일이 사라지면 기존 보관 이력을 `available=false`로 유지한다. 연결 폴더가 읽히지 않으면 게시를 시작하지 않는다.
- `request_id`와 manifest는 재시작 후에도 고정한다. 서버 반영 후 응답 유실 시 같은 세션의 완료 결과로 ACK한다. 준비 이후 변경은 다음 동기화로 남긴다. 사용자가 최신 내용으로 다시 준비하면 미완료 세션을 취소하고 새 스냅샷을 만든다.
- 세션 생성·업로드 준비·검증·commit은 계정과 binding generation을 재확인한다. 같은 출처의 이전 device sequence와 다른 workspace revision은 거부한다. 처음부터 다른 계정·서버로 자동 이전하지 않는다.
- parent/document/scope의 작업 공간 경계를 복합 FK와 graph 검증으로 확인한다. 파일 버전 UUID·번호·원본 metadata는 변경할 수 없다. 웹의 원본·배치·초안 쓰기는 기존 writer 권한 검사에서도 거부한다.
- 기본 파일 50MiB, 원본·이력을 포함한 workspace 2GiB, metadata 64MiB, 최대 tree entry 25,001개(루트 포함), metadata 요청 4MiB와 페이지 content 2MB 제한을 적용한다. 클라이언트는 최대 50개·약 1.5MB 단위로 보낸다.

## API

| API | 동작 |
|---|---|
| DELETE `/api/workspaces/{id}` | 소유자만 논리 삭제, 멤버 접근·전송·자동 재연결 차단, 로컬 원본 보존 |
| POST `/api/sync/bindings` | 사용자·기기·local workspace 기준 멱등 연결/재연결과 cloud workspace 생성 |
| GET/DELETE `/api/sync/bindings/{id}` | 연결 상태 / 클라우드 자료를 보존하는 연결 해제 |
| POST `/api/workspaces/{id}/sync-sessions` | request ID, generation, base revision, cutoff sequence, item count, manifest hash 고정 |
| PUT `/api/sync-sessions/{id}/items` | 순번별 strict payload 등록·재시도, 누락된 원본의 presigned PUT 발급 |
| POST `/api/sync-sessions/{id}/uploads/complete` | 원본 크기·MIME·SHA-256·version metadata·암호화 검증 |
| POST `/api/sync-sessions/{id}/commit` | 완전한 manifest·참조·권한·revision 검증 후 한 트랜잭션 게시 |
| GET/DELETE `/api/sync-sessions/{id}` | 진행·완료 결과 조회 / 미완료 세션 취소 |
| GET `/api/workspaces/{id}/entries` 또는 `/sync-view` | scope별 페이지 조회와 일관된 revision |
| GET `/api/workspaces/{id}/sync-scene` | 조상 우선의 제한된 중첩 캔버스 inventory와 scope별 메모·관계 |

원본 상세·다운로드·본문·비교·변환·초안 읽기·검색·새 AI 채팅은 기존 API를 사용한다. 웹의 파일명 검색은 현재 표시한 inventory에 적용하며 더 큰 범위는 폴더 탐색과 본문 검색을 사용한다.

## 설정과 실행

`WEB_BASE_URL`은 공개 웹 프런트 HTTPS origin이며 비우면 첫 CORS origin을 쓴다. `SYNC_MAX_WORKSPACE_BYTES` 기본 2147483648, `SYNC_SESSION_HOURS` 기본 24다. 기존 Supabase·S3·Redis 설정을 유지한다. Compose와 환경 변수 예제에 추가했다.

실제 개발 DB는 `/private/tmp/context-cloud-before-0013.sql`에 mode 600으로 백업한 후 `0013_cloud_sync`로 올렸다. 기존 데이터·볼륨을 초기화하지 않았다. 개발 DB의 `alembic check`는 모델 차이가 없음을 확인했다. 실행 중인 작업이 없음을 확인한 뒤 worker·dispatcher를 재시작했다. 운영 웹/API 배포는 수행하지 않았다.

현재 AWS 자격 증명으로 무작위 미존재 키의 삭제 권한을 확인한 결과 `AccessDenied`다. **일반 동기화의 읽기·쓰기는 기존 권한을 사용하고, 만료 업로드 정리는 추가 설정이 필요하다.** 기존 IAM 정책에 [별도 추가 정책](../infra/s3/sync-cleanup-policy.example.json)의 버킷 이름을 맞춰 연결한다. 이 파일은 신규 동기화 경로의 DeleteObject만 허용한다. 실제 클라우드 IAM 정책은 변경하지 않았다. 권한이 없으면 정리 작업은 `CLEANUP_BLOCKED`로 하루 뒤 재시도하며 게시된 버전이나 기존 문서 경로는 삭제하지 않는다.

## 검증

- 새 임시 PostgreSQL DB에서 전체 백엔드 221개 회귀와 migration upgrade/downgrade·model 일치를 검증했다. 실제 개발 DB의 자료·볼륨은 초기화하지 않았다. 초기 검증에 사용한 기존 전용 테스트 DB도 최종 모델과 맞춰 표준 테스트 명령의 호환성을 유지했다.
- 실제 파일 → 데스크톱 엔진 → HTTP → PostgreSQL/Moto S3 → 웹 API 경로에서 빈·중첩 폴더, 일반·빈 파일, 수정 이력·고정 head·출처·초안, 변경 없는 원본 재사용, 앱 재시작·응답 유실·최신 내용으로 다시 준비를 확인했다.
- 로그인은 실제 Electron PKCE·IPC·OS 보안 저장소를 사용하고 외부 인증 제공자·계정·S3는 격리된 합성 fixture를 사용했다. 실제 사용자 Google 동의나 실제 사용자 폴더 업로드는 자동 수행하지 않았다.
- 웹 desktop/mobile 4개, 패키징 macOS 앱 기존 20개와 신규 동기화 1개 E2E를 통과했다. 웹 타입·린트·프로덕션 빌드, 앱 타입·빌드·패키징을 확인했다.
- 화면: [데스크톱](images/cloud-sync-desktop.png), [웹](images/cloud-sync-web-desktop.png), [모바일](images/cloud-sync-web-mobile.png).
- 세부 로그는 `/private/tmp/context-cloud-*.log`, 실행 앱은 `apps/desktop/release/mac-arm64/ConText Desktop.app`이다. 재패키징하면 `release/cloud-sync-build.json`과 실행 앱의 검증 결과를 다시 갱신한다.

## 후속 범위

양방향 원본/초안/배치 편집과 기기별 충돌 병합, 다른 계정·서버로 명시적 복제, 기존 AI 대화 이전, 자동 동기화, Windows 실기기 검증은 포함하지 않는다. 현재 수동 transport는 기존 outbox를 삭제하지 않으며 장기 outbox/commit metadata 보존 정책은 후속 운영 범위다.
