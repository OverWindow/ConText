# 단일 워크스페이스 설계 대조 기록

2026-10-27. 대상은 `unified-workspace-architecture.md`의 개발 환경 전환과 macOS arm64 앱이다. 기존 작업 트리와 로컬 원본은 보존하고, public DB의 과거 웹 데이터도 삭제하지 않은 채 새 `unified` schema로 편집 경로를 전환했다.

## 패키지·산출물 경계 추가 검증

`packages/*`를 실제 npm workspace로 연결했고 앱은 공개 @context export와 선언한 file 의존성으로 소비한다. desktop→frontend 내부 상대 참조와 임시 UI alias는 제거했다. 디자인 토큰과 native 브랜드 입력도 공통 패키지에 있다. check:architecture가 167개 앱 소스와 5개 패키지의 경계를 검사한다. Docker의 새 npm ci와 로컬 production standalone 실행을 확인했다.

빌드 입력 140개를 컴파일 전후 대조해 기록하고, 현재 입력·런타임 40개·frozen parser 301개·ZIP 속 ASAR를 대조한다. 소스 drift와 오래된 ZIP을 거절하는 음성 검증을 수행했다. 실제 왕복 fixture에서는 PC-A/PC-B SQLite의 전체 canonical state를 같은 cursor의 PostgreSQL snapshot과 비교한다.

## 계약과 저장 경계

| 설계 항목 | 구현과 증거 |
|---|---|
| 하나의 편집 규칙 | `packages/domain`을 native SQLite와 Node PostgreSQL 양쪽에서 실행. 혼합 출처·head·초안·채팅·트리·CAS·삭제·충돌의 같은 fixture를 검증한다. |
| 하나의 캔버스/편집 UI | `packages/workspace-ui`가 native 기준 캔버스와 공유 문서·버전·초안·채팅·충돌/복구 UI를 제공한다. `frontend/shared`는 재수출 호환 경로다. native의 계정·OS 동작은 shell에 남는다. |
| 논리 ID와 기기 상태 분리 | Entry/Document/Version UUID, content/reference head를 공통 상태에 보관하고 observed version/hash, 절대 root, inode, viewport, token은 기기 저장소에 남긴다. |
| 네 종류 출처 | document/note/chat/draft 참조와 인용 당시 본문을 보존한다. 삭제·연결 해제 뒤에도 snapshot 인용을 읽고 원본 열기 불가 상태를 표시한다. |
| native 변경/outbox 원자성 | `unified-store.mjs`, native mutation bridge가 같은 SQLite transaction 안에서 로컬 자료와 명령을 보관한다. v10 migration 전 일관된 백업을 만들며 기존 native 자료는 read model로 남긴다. |
| Python 처리 계약 | `packages/contracts/schema/worker-v2.json`에서 TS 타입·검증과 Pydantic `worker_generated.py`를 생성한다. `npm run contracts:check`는 생성물과 공유 fixture의 drift를 거절한다. 실제 parse/convert/export가 이 경계를 사용한다. 기존 계정별 AI 서비스는 request-ID 멱등성과 canonical 완료 명령을 통해 재사용한다. |

## 동기화와 복구

| 설계 항목 | 구현과 증거 |
|---|---|
| 원본 게시 전 검증 | 불변 blob의 MIME·크기·SHA256과 서명된 PUT 조건을 검증한 뒤 명령의 버전/파생 결과 참조를 허용한다. JWT는 S3로 보내지 않는다. |
| 서버 transaction/순서 | workspace 잠금 아래 도메인 결과·receipt·단조 cursor 변경 로그를 함께 저장한다. operation ID 재시도는 같은 결과를 반환한다. |
| 원자적 수신/echo | native base 상태·cursor·outbox echo ACK를 같은 transaction으로 반영한다. POST ACK cursor로 다른 사용자의 앞선 변경을 건너뛰지 않는다. |
| bootstrap과 outbox | 첫 연결/명시적 bootstrap 후 기존 pending 명령을 새 base 위에 재평가한다. 오래된 삭제 epoch로 게시하거나 삭제 공간을 자동 재생성하지 않는다. |
| 알림과 재접속 | 공통 SSE parser는 힌트를 받으면 durable cursor pull을 깨운다. frame 제한·재연결·계정 전환·membership 회수·삭제 종료·server shutdown을 검사한다. native 60초/웹 2.5초 조회도 유지한다. 실제 브라우저 테스트는 SSE를 버퍼링 프록시 없이 직접 구독한다. |
| 버전/본문 충돌 | 양쪽 파일 버전과 초안/메모 후보를 보존한다. 서로 독립인 변경은 계속 수용한다. UI가 검토한 CAS read set을 해결 명령에 전달해 검토 후 추가 변경을 덮어쓰지 않는다. 폴더 삭제 해결에는 전체 하위 read set이 필요하다. |
| 거절된 명령 | native blocked outbox와 웹 계정별 recovery 저장소에 입력과 receipt를 보존한다. 웹 저장 용량이 부족하면 pending을 제거하지 않는다. 복구 화면에서 내용·오류를 확인하고 JSON을 내보낸다. 파일 변경은 원본도 따로 저장할 수 있다. 관계없는 후속 편집은 계속 전송한다. |
| 미게시 원본 접근 | `/v2/workspaces/:id/blobs/:blobId/recovery`는 검증된 same-workspace blob을 업로더 또는 OWNER에게만 제공한다. 다른 editor·비멤버·다른 workspace 접근을 검증한다. 권한을 잃으면 브라우저의 JSON 기록은 남지만 서버 원본 다운로드는 현재 권한에 따른다. native 원본 복구는 서버 권한 없이 로컬 보관 자료에서 가능하다. |
| 실제 파일 적용 | 마지막 observed hash와 현재 디스크를 대조하고 verified bytes를 staging/journal로 적용한다. 외부 편집·Unicode/대소문자 별칭·unknown occupant·symlink·교체된 root는 덮어쓰지 않는다. |
| 이름 교환/중단 | 파일·폴더·부모/자식 이름 교환은 기기 전용 staging과 inode journal로 복구한다. staging 이름은 공통 Entry나 서버 변경 로그에 게시하지 않는다. 물리 이동 직후 mapping 갱신 전 종료와 재시작도 검증한다. |
| 삭제 경쟁 | pull로 받은 새 content head를 디스크가 관측하기 전에 파일이 사라지면 명시적 삭제 충돌로 보존한다. 사용자가 공유 내용 사용을 선택한 때만 원본 복원을 허용한다. 초기 관측 전 삭제도 live empty file로 게시하지 않는다. |
| Workspace 삭제 | tombstone/epoch로 후속 게시를 막으며 원본 폴더와 로컬 이력을 유지한다. 중단된 이동의 staging을 원래 위치로 복구한다. 원래 위치가 점유됐거나 staging이 없어졌으면 기록과 남은 원본을 보존하고 복구 화면에 표시한다. |
| 기기 연결 해제 | 해당 기기의 자동 동기화만 멈춘다. 다른 기기·cloud 공간과 원본 폴더를 삭제하지 않는다. 별도 local folder 연결 해제는 UI가 명시한 앱 자료 범위만 정리한다. |

## 대량 자료와 전환

- 실제 25,001개 폴더 스캔, native import, PostgreSQL import, 2,001개 이상 형제 전체 pagination과 검색을 검증한다. 500개 새 폴더의 incremental 반영은 명령/지속 저장 한 번으로 묶는다.
- 250,000개 보호 한도 또는 접근 오류에서는 불완전 상태로 중단한다. 부분 목록을 원격 삭제나 전체 완료로 처리하지 않는다. 웹 캔버스 200개 표시는 데이터 한도가 아니며 목록/검색에서 전부 접근한다.
- Python artifact와 AI 완료는 공통 명령을 통해 change log에 게시한다. 파싱/변환 작업은 lease·재시도·fingerprint와 불변 결과를 사용하고, AI는 기존 요청 ID의 과금/결과 멱등성을 유지한다.
- `docker-compose.unified.yml`은 Node workspace API와 기존 Python 연산/인증 서비스를 연결한다. 구 Python workspace API는 410이며 예전 snapshot API로 새 저장소를 수정할 수 없다.
- 원본/출처/충돌/tombstone의 영구 GC는 실행하지 않는다. 파일 50 MiB·기본 공간 2 GiB, 웹 온라인 편집, 미서명 macOS 개발 앱 범위다. 브라우저 최초 업로드의 완전한 오프라인 보관, Windows 실기기 패키지, 서명/공증과 운영 배포는 별도다.
- 두 PC 검사는 한 Mac의 독립된 두 폴더/SQLite 저장소를 이용한다. 실제 PostgreSQL/Python과 Moto HTTP S3 및 synthetic AI를 사용한다. 실제 AWS·유료 모델·물리적으로 다른 OS/컴퓨터까지 검증했다고 해석하지 않는다.

최종 수치·실행 로그·ASAR/ZIP 해시는 `unified-workspace-progress.md`와 `apps/desktop/release/unified-build.json`에 기록한다. 실행과 복구 절차는 `unified-workspace-runbook.md`를 따른다.
