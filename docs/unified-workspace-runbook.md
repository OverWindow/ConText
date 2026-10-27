# 통합 워크스페이스 실행과 복구

2026-10-27. 개발 환경 기준. 운영 배포와 실제 사용자 자료 업로드는 수행하지 않았다.

## 개발 환경

Node.js 24 이상, Docker, macOS용 Electron을 사용한다. root의 packages/*는 npm workspace이고 앱은 각 lockfile에서 file 의존성으로 이를 연결한다. root npm ci를 먼저 실행하고 frontend, apps/desktop, apps/server의 각 lockfile도 유지한다. Electron renderer의 공통 패키지는 빌드 의존성이며 실행 앱에는 컴파일한 core와 renderer가 들어간다.

```sh
npm ci
npm --prefix frontend ci
npm --prefix apps/desktop ci
npm --prefix apps/server ci
npm run check:architecture
npm run build:core
docker compose --env-file .env.development -f docker-compose.yml -f docker-compose.unified.yml up -d --build
npm --prefix apps/desktop run dev
```

`.env.development.example`의 공개 Supabase 설정과 서버 전용 DB/S3 설정을 채운다. `INTERNAL_WORKER_TOKEN`은 Node와 Python이 공유하는 비밀키이며 브라우저에 넣지 않는다. 개발 환경의 해당 키는 생성해 비공개 `.env.development`에 보관했다. Python 파서가 없거나 fingerprint가 바뀌었다면 `npm --prefix apps/desktop run processor:build` 후 다시 빌드한다.

| 주소 | 역할 |
|---|---|
| http://localhost:3000 | 공통 워크스페이스 웹 |
| http://localhost:8001/v2 | 유일한 워크스페이스 명령·변경 API |
| http://localhost:8000 | 기존 계정·AI 연결과 내부 Python 처리 |

unified Compose에서는 `LEGACY_WORKSPACE_API_ENABLED=false`로 이전 Python 워크스페이스 API를 410으로 차단한다. `/api/me`, `/api/ai`, 데스크톱 인증 설정과 `/internal/v2/process`는 유지한다. 이전 public 테이블을 삭제하지 않고 새 `unified` schema를 사용한다. Python만 쓰는 과거 회귀 환경과 새 환경을 혼동하지 않는다.

## 사용 흐름

1. 데스크톱에서 기존 폴더를 연결한다. 게스트 상태의 로컬 작업도 가능하다.
2. 계정을 연결하고 클라우드 동기화를 누른다. 기존 이력과 초안·메모·배치·대화가 같은 UUID의 공간으로 전송된다.
3. 웹에서 같은 계정으로 로그인해 수정한다. 연결된 데스크톱은 SSE 갱신 알림으로 변경을 받는다. 신호 누락이나 재접속은 cursor 조회와 1분 주기 확인으로 복구한다.
4. 다른 데스크톱은 클라우드 작업 공간 목록에서 공간을 고르고 빈 폴더를 선택한다. 원본을 모두 확인한 뒤 폴더에 적용한다.
5. 동시 수정은 비교 화면에서 현재 내용 사용 또는 후보 적용으로 해결한다. 버전과 후보는 삭제하지 않는다.

기기 연결 해제는 해당 기기의 자동 전송을 멈춘다. 명시적인 재개로만 다시 등록한다. 서버에서 취소한 기기는 일반 재시도로 자동 복구하지 않는다. 워크스페이스 삭제는 새 세대로 이전 기기의 쓰기를 차단한다. 삭제한 공간의 로컬 원본과 보존 이력은 남으며 같은 삭제 연결로 다시 게시할 수 없다.

## 보존과 파일 적용

- v9 SQLite를 v10으로 올릴 때 일관된 DB 백업을 userData/backups에 먼저 만든다. 기존 native 테이블은 공통 데이터의 표시용 투영으로 유지한다.
- 일반 편집의 native 기록과 공통 outbox는 같은 SQLite transaction에서 커밋한다. 원본 파일 적용은 별도의 durable 저장 journal을 사용한다.
- 원격 버전을 받았다는 이유로 기기의 observed version을 먼저 바꾸지 않는다. 해시 확인과 실제 파일 적용 후에만 갱신한다.
- 원격 파일 삭제는 논리 삭제다. 해당 기기의 디스크 원본을 자동 삭제하지 않는다. 외부 편집, 이름 충돌, 심볼릭 링크나 폴더 교체가 있으면 적용을 보류하고 원본과 원격 버전을 보존한다.
- 폴더 위치·inode·viewport·인증 토큰·개인 AI 키는 기기 자료다. 클라우드 상태에 넣지 않는다.

## 동기화 복구 자료

동기화 메뉴의 충돌/복구 화면에서 거절된 입력과 파일 적용 journal의 오류·상대 위치를 확인한다. JSON 복구 기록 내보내기는 보관 자료를 지우지 않는다. 거절된 파일 버전은 보존된 원본 저장으로 따로 내보낼 수 있다. native는 로컬 검증 원본을 이용하고 웹은 현재 서버 권한이 필요하다. 브라우저 저장소를 지우거나 다른 계정으로 바꾸기 전에는 필요한 복구 자료를 내보낸다. 파일 적용이 중단된 staging은 임의로 삭제하지 말고 복구 화면의 기록을 확인한다.

Python 처리 계약을 변경할 때는 `packages/contracts/schema/worker-v2.json`을 수정하고 `npm run contracts:generate`, `npm run contracts:check`를 실행한다. 생성한 TS/Pydantic 파일을 따로 수정하지 않는다.

desktop build는 컴파일 전후 입력을 대조하고 dist/build-inputs.json을 생성한다. 앱 패키징을 마친 후 `node scripts/verify-unified-package.mjs`로 그 입력과 현재 소스, electron/core/renderer, frozen parser와 ASAR의 일치 및 비밀 자료 미포함을 검사한다. 소스가 달라졌다면 다시 build/pack한다. ZIP을 새로 만든 뒤 `--zip` 옵션으로 ZIP 속 app.asar까지 같은지 검사하고 해시를 기록한다. 오래된 ZIP을 새 ASAR와 함께 완료 산출물로 기록하지 않는다.

## 한도와 검사 범위

원본은 파일당 50 MiB, 기본 워크스페이스 합계는 2 GiB다. 서버 설정으로 합계를 조정할 수 있다. 숨김·생성 폴더는 현재 표시 설정에 따라 제외하며 심볼릭 링크와 특수 파일을 원본으로 전송하지 않는다. native 스캔의 보호 한도는 250,000개이고 한도를 넘거나 읽기 실패가 있으면 전체 동기화를 중단한다. 일부 목록을 전체라고 게시하지 않는다.

웹 캔버스에는 최대 200개 카드를 장착하고 목록과 검색에서 다음 페이지를 제공한다. 데이터 자체의 2,000개 제한은 없다. 25,001개 데이터의 import·목록 전체 조회·검색과 실제 native 폴더 스캔을 검증한다. 웹은 온라인 편집을 기준으로 하고 응답 유실에 대비해 명령을 보관한다. 브라우저 최초 업로드 파일의 완전한 오프라인 영구 저장은 별도 단계다.

## 검증과 실행 앱

```sh
npm run test:core
npm --prefix apps/desktop test
npm --prefix apps/desktop run test:e2e
npm --prefix apps/desktop run pack
```

실제 PostgreSQL/Moto S3/Python 테스트 실행법은 `apps/server/README.md`, 웹 검사는 `docs/unified-web-client.md`를 따른다. 테스트는 별도 `_test` DB, 임시 폴더와 synthetic 계정만 사용한다. macOS 산출물은 `apps/desktop/release/mac-arm64/ConText Desktop.app`이며 로컬 검증용 미서명 앱이다. 최종 검증 수치와 미완료 항목은 `docs/unified-workspace-progress.md`에 기록한다.

## 작업 시작 전 백업

- 소스 전체: `/private/tmp/context-unified-before.tar.gz` (42,224,163 bytes, 0600)
- tracked binary diff: `/private/tmp/context-unified-before.patch` (0600)
- 개발 PostgreSQL: `/private/tmp/context-before-unified-schema.sql` (2,205,332 bytes, 0600)

위 세 파일은 `.backups/unified-2026-10-27-IdcVOh/`에도 0600으로 복사했다. 이 경로는 Git에서 제외하며 임시 디렉터리 정리 후에도 보관한다. 기존 작업 트리를 reset하거나 사용자 폴더를 초기화하지 않았다.

추가 package 경계 보완 전 백업과 이전 ZIP은 `.backups/unified-boundaries-2026-10-27/`, 해당 회귀·음성 검증 로그는 그 아래 `verification/`에 보존한다.
