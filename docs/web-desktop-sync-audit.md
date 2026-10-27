# 웹·데스크톱 동기화 점검 — 2026-10-26

현재 구현은 **한 데스크톱 폴더 → 클라우드의 수동 스냅샷 게시**다. 웹과 데스크톱이 같은 데이터를 함께 편집하는 양방향 동기화는 아직 아니다. 파일·버전·폴더·배치·메모·연결선·저장된 초안을 전송하고 웹은 이를 읽는다. 웹에서 새로 만든 AI 대화는 서버에, 기존 데스크톱 대화는 로컬에 남는다.

아래 항목은 현재 소스와 합성 fixture로 확인했다. ‘미지원’과 ‘오류’를 구분하며, 이번에 고친 항목은 별도로 적었다. 실제 사용자 자료를 삭제하거나 업로드하는 검증은 하지 않았다.

## 남은 불일치와 개선 순서

| 우선순위 | 구분 | 현재 증상과 영향 | 필요한 개선 |
|---|---|---|---|
| P1 | 스키마 오류 | 메모·대화·다른 초안을 출처로 생성한 로컬 초안은 서버가 요구하는 문서 UUID/버전 UUID/버전 번호가 없다. 한 초안 때문에 전체 스냅샷 준비 API가 422로 거절될 수 있다. | 공통 `Source`를 `document / note / chat / draft`로 구분하고 종류별 필드를 검증한다. 원문 인용 스냅샷을 보존하며 출처가 화면에서 열리는지도 함께 검사한다. |
| P1 | 조회 오류 | 웹은 최대 2,000개 inventory만 표시하고 파일명 검색도 표시분만 검색한다. 같은 폴더에 그보다 많은 파일이 있으면 폴더를 다시 선택해도 뒷부분을 볼 수 없다. 전송된 자료가 누락된 것처럼 보인다. | 기존 `/entries`의 페이지 조회를 웹 파일 목록과 연결하고 폴더 목록·검색을 서버에서 따로 페이지 처리한다. 캔버스 표시 한도와 자료 탐색 한도를 분리한다. |
| P1 | 스캔 완전성 | 로컬 스캔은 25,000개에서 잘림 경고와 `truncated=true`를 남긴다. 전송 준비는 폴더 접근 불가만 검사하고 잘림은 검사하지 않는다. 코드상 최초 연결 시 일부 목록만 게시될 가능성이 있다. | 잘린 스캔으로 전체 게시를 시작하지 않도록 사전 검사를 추가하거나 스캔 자체를 페이지 처리한다. 용량·개수·의존성 검증을 업로드 전에 함께 표시한다. |
| P1 | 의존성 처리 | 복사본 버전의 출처 파일을 연결 해제하면 `source_version_id`가 전송 목록에서 빠져 전체 게시가 중단된다. 반면 초안의 문서 출처는 graph 검증에서 존재 여부를 확인하지 않아 끊어진 인용을 게시할 수 있다. | 출처 의존성 closure를 계산하고 보관된 출처를 읽기 전용으로 포함하거나, 끊어진 출처를 명시적으로 표시한다. 초안 현재 내용과 undo 이력의 문서/버전 참조도 검증한다. |
| P1 | 미지원 | 웹에서 수정한 원본·초안·배치를 데스크톱으로 받는 경로가 없다. 현재는 서버 writer 검사와 웹 VIEWER 화면으로 쓰기를 막아 덮어쓰기를 예방한다. | 먼저 서버 변경 cursor, 클라이언트 outbox/inbox, entity별 `base_revision`을 정의한다. 그 뒤 웹 편집과 pull 적용을 함께 추가한다. |
| P1 | 미지원 | 서버 revision 불일치는 전체 작업을 중단한다. ‘연결을 복구’하라는 안내는 있지만 서버 자료를 받아 비교·복구하는 화면은 없다. 변경별 병합이나 충돌 복사본도 없다. | 충돌 엔티티·로컬/서버 revision을 반환하고 ‘서버 내용 받기 / 로컬 복사본 보존 / 다시 게시’의 구체적인 복구 흐름을 제공한다. 자동으로 최신 내용을 덮어쓰지 않는다. |
| P2 | 미지원 | binding은 한 서버·계정·기기·local workspace에 묶인다. 다른 PC에서 같은 클라우드 공간을 연결하거나 내려받는 기능이 없으며, 계정이 달라지면 연결 해제 후에도 기존 로컬 상태가 전송을 거절한다. | workspace와 device binding을 일대다로 만들고, 기기별 로컬 경로 mapping·명시적인 계정 복제·다운로드를 설계한다. 글로벌 문서/버전 UUID를 다른 workspace에 그대로 넣으면 소유권 충돌하므로 복제 ID mapping도 필요하다. |
| P2 | 갱신 지연 | 데스크톱 게시와 웹 새로고침이 모두 수동이다. 서버는 원본을 받은 후 비동기로 파싱/색인하므로 파일이 보이는 시점과 본문 검색·AI에서 사용하는 시점이 다르다. | revision 알림 또는 조건부 polling, 마지막 게시 시각, 파싱/색인 상태와 실패 재시도를 보여 준다. 그 뒤 파일 watcher의 debounce 자동 게시를 추가한다. |
| P2 | 비용·용량 | 매번 전체 metadata와 모든 보관 버전을 manifest에 넣고 로컬 staging에 원본을 물질화한다. 서버는 이미 있는 버전의 바이트 업로드를 생략하지만 작은 수정에도 로컬 읽기·복사와 metadata 저장은 커진다. 완료 세션·로컬 outbox의 장기 보존 정책도 없다. | 첫 게시 이후에는 delta를 전송하고 cursor ACK 뒤 outbox를 정리한다. 서버 receipt·staging·버전 보존 기간과 참조 기반 GC를 정한다. 현재 제한은 파일 50MiB, workspace 2GiB, metadata 64MiB다. |
| P2 | 의미 차이 | 로컬 파일이 사라져도 보관 이력이 있으면 웹에는 `available=false`로 남는다. 로컬 폴더 연결 해제도 클라우드 자료 삭제를 뜻하지 않는다. 기존 대화·변환 결과·미승인 AI 제안은 스냅샷에 포함되지 않는다. | ‘원본 없음 / 이 기기에서 제거 / 동기화 연결 해제 / 클라우드 삭제’를 구분한다. 전송 대상과 제외 항목을 동기화 전에 일관되게 안내한다. |
| P2 | 오류 안내 | 동기화가 AI 연결의 공통 fetch 함수를 사용하므로 일부 네트워크·422·세션 만료 오류가 AI 서비스 오류로 보인다. | 동기화 전용 오류 코드와 사용자 안내를 제공한다. 이번에는 workspace 삭제를 `WORKSPACE_DELETED`로 구분했으며 세션 만료를 삭제로 취급하지 않는다. |

P1은 자료에 접근하지 못하거나 정상 자료의 게시가 거절되는 항목이고, P2는 사용성·확장성·기능 범위의 차이다. 양방향 지원을 먼저 열면 현재 스키마·출처·복구 문제를 더 복잡하게 만들 수 있으므로, 위의 스키마·조회·스캔 완전성·출처 정합성 문제를 먼저 해결하는 순서를 권장한다.

### 근거와 재현

- 혼합 출처: [로컬 문맥 수집](../apps/desktop/electron/local-context.mjs)은 메모·대화·초안을 정상 출처로 수집한다. [전송 mapper](../apps/desktop/electron/cloud-snapshot.mjs)는 종류를 버리고 문서 필드만 내보내며 [서버 DraftSource](../backend/app/schemas/sync.py)는 문서/버전 UUID·번호를 필수로 요구한다. 합성 메모 출처로 `DraftPayload.model_validate()`를 실행해 세 필드의 누락 오류를 재현했다. AI가 만든 제안을 승인해 초안 sources에 저장한 경우와 초안 undo 이력도 영향을 받는다.
- 큰 폴더: [웹 조회·검색·더 보기](../frontend/features/workspace/cloud-workspace.tsx)의 `limit >= 2000`과 표시된 entries만 사용하는 검색, [서버 scene](../backend/app/services/sync.py)의 제한된 inventory를 확인했다. `/entries`에는 offset이 있지만 웹 화면에서 사용하지 않는다.
- 로컬 스캔 잘림: [engine.scanOnce](../apps/desktop/electron/engine.mjs)의 MAX_ENTRIES/health와 `cloud-snapshot.prepare()`의 상태 검사를 비교했다. 이 항목은 코드 점검 결과이며 실제 사용자 대용량 폴더 업로드로 재현하지 않았다.
- 출처 의존성: `cloud-snapshot.mjs`는 버전 출처 누락을 명시적으로 중단한다. 서버 `graph()`는 버전 출처의 존재는 검사하지만 draft sources/history의 문서·버전은 검사하지 않는다.
- 단일 출처·수동 동작·로컬 기록: [전송 엔진](../apps/desktop/electron/cloud-transfer.mjs), [로컬 상태](../apps/desktop/electron/cloud-snapshot.mjs), [서버 binding·commit](../backend/app/services/sync.py), [웹 쓰기 차단](../backend/app/auth/dependencies.py)을 확인했다.

## 이번에 고친 문제

1. 워크스페이스 삭제 경로가 없던 문제: `DELETE /api/workspaces/{id}`와 웹 목록/데스크톱 동기화 메뉴를 추가했다. 소유자만 삭제할 수 있고 웹은 이름 입력, 데스크톱은 native 확인 창을 사용한다.
2. 삭제와 늦은 전송의 경합: workspace `deleted_at`, binding `DELETED`와 generation 증가, 준비 중 세션 취소를 한 트랜잭션으로 처리한다. 전송과 같은 binding → session → workspace 잠금 순서를 사용한다. 같은 origin의 자동 재연결과 이전 snapshot commit은 410으로 거절해 공간이 되살아나지 않는다.
3. 삭제한 공간의 우회 조회: 목록과 membership 검사뿐 아니라 문서 ID·버전 ID의 직접 조회, 본문·다운로드 URL 발급에도 workspace 삭제 필터를 적용했다. 스냅샷에서 제외되어 soft delete된 문서도 직접 조회할 수 없게 했다.
4. 잘못된 ‘동기화 완료’ 표시: 기존에는 로컬 ACK/서명만 확인했다. 연결된 공간은 서버 상태를 확인하고 접근 불가·네트워크 오류는 ‘클라우드 확인 불가’, 서버 삭제는 ‘클라우드 공간 삭제됨’으로 표시한다. 삭제 상태는 재시작 후에도 유지한다.
5. 데스크톱 DELETE 응답: 공통 HTTP 처리에서 정상적인 204 응답을 JSON으로 파싱하던 문제를 고쳤다.

### 삭제의 범위

- 웹 소유자: **나의 워크스페이스 → 카드 아래 삭제 → 이름 입력 → 삭제**.
- 데스크톱: **클라우드 동기화 → 클라우드 워크스페이스 삭제**. 로컬 폴더·배치·초안·이력은 유지한다.
- 기존 ‘폴더 연결 해제’는 이 기기의 앱 자료를 제거하고 원본 폴더와 클라우드 공간을 유지한다. 확인 창에도 차이를 명시했다.
- 삭제 즉시 모든 멤버의 신규 API 접근과 이후 동기화를 막는다. 이미 발급된 S3 URL은 기존 만료 시각까지 유효할 수 있으며 이미 다운로드한 파일은 회수하지 않는다.
- **서버 자료는 tombstone과 함께 보관하는 논리 삭제다. 즉시 영구 파기나 자동 보존 기간 만료 처리는 구현하지 않았다.** 복구 UI와 삭제한 연결의 새 공간 재생성도 이번 범위에 포함하지 않는다. 기존 UUID를 잘못 재사용해 복제하는 일을 방지한다.
- 미완료 staging은 기존 정리 작업이 처리한다. 실제 AWS의 scoped `s3:DeleteObject` 권한은 여전히 별도 설정이 필요하다. 게시된 문서 원본을 지우는 GC는 별도 구현이 필요하다.

## 적용과 검증

마이그레이션 `0014_workspace_deletion`은 nullable `workspaces.deleted_at` 컬럼만 추가한다. 삭제 tombstone이 있는 DB에서 downgrade하여 자료가 다시 노출되는 일을 막는 검사도 넣었다. 개발 DB는 `/private/tmp/context-before-workspace-deletion.sql`에 백업한 뒤 적용했다. 운영 배포는 수행하지 않았다.

- 격리된 새 PostgreSQL DB의 전체 백엔드 **223개 통과**. 삭제 소유권·다른 멤버의 접근 차단·늦은 commit/재연결 거절·문서/버전 직접 조회 차단과 migration roundtrip/model 일치를 포함한다. 최종 삭제 오류 코드 변경 뒤 관련 **46개**도 다시 통과했다.
- 데스크톱 Node **82개 통과**. 삭제 시 로컬 파일·이력 보존, 웹 삭제 감지와 앱 재시작, 오프라인 완료 표시 방지, 세션 만료를 삭제와 혼동하지 않는지 확인했다.
- 웹 desktop/mobile **12개 통과**. 일반/동기화 공간 삭제, 이름 확인, 취소, 실패 후 재시도, editor 버튼 숨김, 기존 동기화 화면을 검증했다. 최종 버튼 스타일의 desktop/mobile 시각 검사도 다시 통과했다.
- 다시 패키징한 macOS 앱에서 기존 회귀 **20개**, 실제 계정 IPC→HTTP→PostgreSQL/Moto S3→동기화→삭제→재시작 **1개 통과**. 삭제 취소 시 서버 유지, 삭제 후 404, 원본 바이트·로컬 카드 보존을 검증했다. 합성 인증 fixture를 사용하며 실제 사용자 계정 동의나 자료 삭제는 수행하지 않았다.
- 웹 타입·전체 lint·프로덕션 빌드, 데스크톱 타입·빌드·패키징, 변경 백엔드 Ruff, `git diff --check` 통과. 개발 API `/health` 정상, 개발 DB `alembic check` 차이 없음.
- 화면: [웹 삭제 확인](images/workspace-delete-desktop.png), [모바일 삭제 확인](images/workspace-delete-mobile.png), [삭제 후 로컬 작업 유지](images/cloud-workspace-deleted-desktop.png).
- 실행 앱: `apps/desktop/release/mac-arm64/ConText Desktop.app`. 최신 runtime/renderer/app.asar 해시와 검증 수치는 `apps/desktop/release/cloud-sync-build.json`, 로그는 `/private/tmp/context-workspace-delete-*.log`에 기록했다. macOS 개발용 unsigned 빌드이며 Windows 실기기와 운영 배포는 수행하지 않았다. 검증용 HTTP 서버와 임시 DB는 종료·정리했다.
