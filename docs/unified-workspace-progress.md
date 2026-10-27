# 통합 워크스페이스 구현·검증 완료 기록

2026-10-27. 상태: **개발 환경 전환과 macOS arm64 앱 구현·검증·패키징 완료**. 설계 항목 대조는 [아키텍처 검증표](unified-workspace-audit.md), 실행과 복구는 [runbook](unified-workspace-runbook.md)를 따른다.

## 이번 목표의 추가 보완

설계 대조에서 빠져 있던 package 경계와 산출물 증거를 보완했다.

- root의 `packages/*`를 실제 npm workspace로 등록하고 웹·서버·데스크톱의 공개 `@context/*` 의존성 및 lockfile을 연결했다. desktop에서 frontend 내부 코드를 참조하는 상대 경로와 임시 alias를 제거했다. 공통 디자인 토큰과 native 브랜드 assets도 workspace-ui에 둔다.
- `npm run check:architecture`가 167개 앱 소스의 상대 경로 경계·선언되지 않은 패키지·비공개 export 접근을 검사한다. desktop renderer/core의 공통 패키지는 빌드 의존성이고, 실행 앱에는 번들 renderer와 컴파일한 공통 core가 들어간다.
- Docker의 설치 순서를 정리했다. 기존 node_modules를 복사하지 않는 Linux npm ci, 새 서버·웹 개발 이미지, 별도 production standalone 이미지 빌드와 localhost 실행을 확인했다. production 이미지는 로컬 검증만 했으며 운영 배포하지 않았다.
- desktop 빌드가 입력 소스 fingerprint를 컴파일 전후 대조해 `dist/build-inputs.json`에 기록한다. 검증기는 현재 소스·ASAR·frozen parser와 ZIP 속 ASAR까지 대조한다. 오래된 ZIP과 빌드 후 소스 변경을 실제로 거절하는 음성 검증도 통과했다.
- 실제 HTTP 왕복 fixture에서 두 독립 SQLite의 **모든 canonical 엔티티**를 같은 cursor의 PostgreSQL snapshot과 deep equality로 비교했다. 파일 수신 후 첫 배치가 pending이어도 삭제·원본 보존을 검증하도록 실제 IPC 검사를 강화했다.

## 최종 변경

- `contracts/domain/sync-client/workspace-client/workspace-ui`를 기준으로 데스크톱과 웹의 엔티티·명령·편집 규칙·캔버스/문서/초안/채팅 UI를 통합했다. Node/PostgreSQL이 같은 domain을 실행하고 기존 Python 연산/인증을 재사용한다.
- SQLite v10은 기존 UUID·원본·이력·인용문을 유지하며 확인 상태, pending overlay, outbox, 기기별 observed mapping과 file apply journal을 갖춘다. public DB를 지우지 않고 새 unified schema로 전환했다. 구 Python workspace API는 410이다.
- 파일/폴더 이름 교환과 부모/자식 이동을 기기 전용 staging으로 안전하게 적용한다. 물리 이동 직후 종료·외부 편집·대소문자/Unicode 별칭·symlink·점유한 대상·workspace 삭제 후 복구를 검증했다. 실패 기록은 복구 화면에서 확인할 수 있다.
- 새 원격 head를 실제 디스크가 관측하기 전 삭제가 발생하면 삭제 의도를 충돌로 보관한다. 사용자가 검토한 CAS read set으로만 충돌을 해결하며, 폴더 삭제는 전체 하위 read set을 검증한다.
- 웹과 native는 인증된 SSE 힌트를 구독하고 durable cursor pull로 복구한다. 알림 유실·재접속·계정 변경·membership 회수·삭제·server 종료와 수동/자동 동기화 중복 실행을 처리한다.
- 서버가 거절한 명령은 native blocked outbox와 웹 계정별 recovery 저장소에 입력·receipt를 남긴다. 저장소 quota 오류 시 pending을 먼저 지우지 않는다. 화면에서 JSON과 해당 원본을 내보낼 수 있고 다른 편집은 계속 동기화한다. 서버 미게시 원본 복구는 same-workspace의 업로더 또는 OWNER만 허용한다.
- Python parse/convert/export 입력·출력 모델을 공통 버전 schema에서 생성한다. 생성물 drift 검사와 Python/TS 공유 fixture를 추가했다.
- 새 파일의 첫 DOM 측정 전에 연결선이 사라질 수 있던 경우를 고쳤다. 카드의 명시적 연결점 좌표를 제공하고 실제 측정 갱신을 함께 유지한다.

## 최종 검증

| 검사 | 결과 | 보존 로그 |
|---|---|---|
| 공통 계약·도메인·cursor/SSE | **55/55** | core-final.log |
| Native 전체 | **139/139**, skip 없음 | 이번 native.log |
| 모든 엔티티 SQLite↔PostgreSQL 일치 | **1/1**, 같은 cursor 전체 snapshot | canonical-parity.log |
| 실제 Node/PostgreSQL/Python/S3 통합 | **9/9** | server-verified.log |
| Python 전체 + Ruff | **243/243**, 코드 검사 통과 | backend-verified.log, backend-lint.log |
| 웹 HTTP repository | **16/16** | client-final.log |
| 웹·모바일 UI | **12/12** | web-ui-verified.log |
| 실제 API·SSE 웹·모바일 | **2/2**, 비동기 route 오류 없음 | web-live-verified.log |
| 최종 패키지 Electron UI | **20/20** | packaged-ui-verified.log |
| 측정 전 요약 연결선·출처·재시작 반복 | **3/3** | summary-repeat.log |
| 최종 패키지 실제 IPC↔API 왕복 | **1/1** | packaged-IPC-verified.log |
| 타입·lint·계약 drift·diff 공백 | 통과 | frontend-types-final.log 등 |
| 개발 이미지·기동 | Node/Python/web Linux 빌드 및 기동 통과 | dev-images.log, frontend-image.log, dev-up.log |
| 패키지 소스/ASAR·비밀 자료·ZIP | 입력 **140개**, 런타임 **40개**, parser **301개** 일치, CRC 통과 | package-verify.log, zip-integrity.log |

Native 전체에는 실제 25,001개 폴더 scan/import와 두 독립 SQLite/폴더의 실제 HTTP 왕복·오프라인 충돌·응답 유실·삭제 검증이 포함된다. 서버는 25,001개 import와 2,001개 이상 형제 전체 pagination을 검증한다. 웹의 200개 canvas 장착 한도를 데이터 한도로 표시하지 않는다.

이전 로그는 `.backups/unified-continuation-2026-10-27-eRsSsw/verification/`, 이번 package 경계·native·server·UI·실제 HTTP·산출물·음성 검사 로그는 `.backups/unified-boundaries-2026-10-27/verification/`에 0600으로 보존했다. Python 처리 코드는 변경하지 않았고 기존 전체 243/243·Ruff 증거를 유지했다. 요약 연결선 3회 반복은 이전 동일 UI 구현의 증거이며, 이번 최종 앱 UI 20개에도 같은 출처·재시작 시나리오가 포함된다. 나머지 표의 검사는 현재 package 구조로 다시 통과했다. 원본 실행 로그는 `/private/tmp/context-continuation-*.log`, `/private/tmp/context-boundaries-*.log`에도 있다. 초기화 순서를 바로잡은 전용 S3 fixture에서 실제 왕복을 재검증했으며 최종 성공 로그를 위 표에 사용했다.

## 실행 산출물

- 실행 앱: `apps/desktop/release/mac-arm64/ConText Desktop.app`
- ZIP: `apps/desktop/release/ConText-Desktop-unified-mac-arm64.zip`
- 빌드/파서 fingerprint: `apps/desktop/release/unified-build.json`
- ASAR SHA-256: `d1828575f040f1dfa62c547f2d33be24ec76a2e9f277e487f1832aefb5ac17e1`
- ZIP: 182,483,898 bytes, SHA-256 `0312bcd11c146253270c5240b4cf712bb716a300706849c2e8500bed1b5d5819`
- `node scripts/verify-unified-package.mjs --zip`로 빌드 시점 입력·현재 소스·electron/core/renderer·frozen parser·ZIP의 동일성을 대조했다. .env, 사용자 SQLite, sealed account와 AWS 설정이 들어 있지 않다. 이전 ZIP도 추가 작업 백업에 보존했다.

## 실제 범위와 남은 한계

두 PC 검사는 한 Mac에서 독립된 폴더와 SQLite 저장소 두 개로 수행했다. PostgreSQL과 Python은 실제 구현이고 S3는 Moto HTTP, AI는 synthetic provider다. 실제 AWS 업로드·유료 모델·물리적으로 다른 컴퓨터나 Windows 실기기까지 검증한 것은 아니다.

미서명 macOS arm64 개발 앱이다. 서명/공증·Windows 패키징·운영 배포·브라우저 최초 업로드의 완전한 오프라인 보관·S3 영구 GC는 이번 범위 밖이다. 원본은 50 MiB, 기본 공간 합계는 2 GiB이며 보호 scan 한도와 불완전 상태는 runbook에 설명했다. 웹 복구 기록은 계정별 localStorage에 남으므로 저장소 삭제 전에 내보내야 한다. 권한 회수 뒤 서버 원본을 받는 권한까지 우회하지 않는다.

## 보존·재개 지점

기존 미커밋 변경과 로컬 원본을 보존했다. 초기 전체 소스/개발 DB 백업은 `.backups/unified-2026-10-27-IdcVOh/`, 이전 checkpoint는 `.backups/unified-continuation-2026-10-27-eRsSsw/`, 이번 변경 전 소스·manifest·lockfile과 이전 ZIP은 `.backups/unified-boundaries-2026-10-27/`에 있다. reset·커밋·푸시·운영 DB 초기화는 하지 않았다.

이 목표의 필수 구현/검증/패키징에 미완료 항목은 없다. 다음 작업은 runbook의 개발 환경을 그대로 사용하고 위 해시와 검증표를 기준으로 시작한다. 운영 출시를 하려면 실제 S3/사용자 인증·모델·별도 기기 검증, 서명/공증과 배포 설정을 별도 목표로 진행한다. 임시 합성 fixture 정리와 최종 기동 확인은 종료 기록에 남긴다.


## 종료 기록

전용 18003 API를 정상 종료해 해당 `_test` DB를 삭제하고 이번 Python/Moto fixture 컨테이너만 정리했다. 개발 backend :8000, unified-server :8001, frontend :3000과 기존 PostgreSQL/Redis/worker는 유지한다. 최신 이미지에서 `/health` 두 곳과 `/login`은 200이고 구 `/api/workspaces`는 410임을 확인했다.


이번 목표 종료 시에는 전용 API와 합성 테스트 DB, Python/Moto·standalone 검증 컨테이너를 정리했다. 갱신한 개발 웹 :3000과 Node API :8001은 기존 DB를 유지한 채 정상 실행 중이며 구 workspace API는 410이다. 전체 원본·미커밋 변경을 유지했고 운영 배포·실제 데이터 초기화는 하지 않았다.


## 2026-10-27 — 앱 화면·메뉴·동기화 안내 공통화

데스크톱을 기준으로 화면 틀·홈·메뉴·도구·계정·문서 관리·파일 생성·미리보기 탭·동기화/충돌 안내를 공통 React/CSS로 연결했다. 최종 패키지 UI 21개, 실제 IPC 1개, 웹 PC/모바일 16개, 클라이언트 18개가 통과했다. 최신 빌드 명세와 화면·차이는 [UI 공통화 기록](application-ui-unification.md)을 따른다.


## 2026-10-27 — 메뉴 없는 워크스페이스 홈

웹과 데스크톱의 워크스페이스 선택을 같은 독립 홈으로 분리했다. 작업 메뉴는 캔버스 안에서 표시한다. 화면·검증·최신 패키지는 [워크스페이스 홈 기록](workspace-home-screen.md)을 따른다.


## 2026-10-27 — 삭제 이력과 새 파일의 경로 충돌 수정

같은 경로의 삭제 이력과 새 UUID를 SQLite에 함께 반영할 때 발생하던 UNIQUE 오류를 수정했다. 원본·버전·UUID는 보존하며, 재생성된 폴더의 메모 식별자도 분리했다. 재현 검사와 실제 패키지 수신 검증, 최신 빌드 정보는 [수정 기록](sync-path-collision-fix.md)을 따른다.


## 2026-10-27 — 기본 하루랩 샘플 프리뷰

웹 공개 `/preview`와 양쪽 홈에 공통 읽기 전용 샘플을 제공한다. 현재 샘플 폴더의 40개 자료를 내장하며 개인 DB·폴더·클라우드에 샘플을 생성하지 않는다. 최종 웹 PC/모바일 UI 22개와 패키지 UI 22개, 원본 일치 검사와 프로덕션 빌드가 통과했다. 최신 패키지와 화면은 [기본 샘플 기록](sample-workspace.md)을 따른다.
