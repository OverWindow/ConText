# 공통 워크스페이스 UI와 웹 어댑터

2026-10-27. 구현과 테스트 기록이며 운영 배포 기록은 아니다.

## 실행 경로

- `packages/workspace-ui/src/workspace-canvas.tsx`가 데스크톱 기준 캔버스의 유일한 구현이다. Electron의 `apps/desktop/src/local-canvas.tsx`는 native API와 파일 변환 슬롯을 주입하는 작은 래퍼다.
- 공통 폴더·파일 카드, 문서 이력/원본 편집, 메모/관계, DraftStudio, ChatPanel 구현은 `packages/workspace-ui`에 있다. 기존 `frontend/shared` 경로는 호환 reexport만 남긴다.
- 웹의 `WorkspaceDetail`은 `packages/workspace-ui/src/workspace.tsx`와 `HttpWorkspaceRepository`를 사용한다. 이전 웹 전용 캔버스와 읽기 전용 cloud canvas 진입점도 같은 화면으로 연결된다.
- `frontend/lib/workspace-v2.ts`가 Supabase 세션을 확인하고 Node `/v2` API를 호출한다. 세션 계정이 바뀌면 열린 repository의 후속 요청을 막는다. 공통 repository에는 토큰 저장소나 OS 파일 권한을 넣지 않는다.

## 저장과 복구

브라우저는 canonical `CommandEnvelope`만 보낸다. 변경 요청을 보낼 때 operation UUID와 전체 payload를 계정·workspace·browser device별 localStorage에 먼저 기록한다. 응답 유실 후 reload하면 동일 요청을 재전송한다. 파일 생성과 첫 immutable version은 종속 명령 전체를 먼저 기록한 후 한 batch로 보낸다. 동시에 발생한 UI 변경은 직렬화해 pending 기록이 서로 덮이지 않게 한다.

서버 명령 ACK는 로컬 엔티티를 갱신하지만 change cursor를 건너뛰지 않는다. 모든 기기의 변경은 마지막 확인 cursor 이후를 페이지 조회해 수신한다. 웹은 온라인 편집을 기준으로 하며, 연결 오류 때 이미 저장한 pending 요청을 보존한다. 오프라인에서 최초 업로드 파일 자체를 브라우저에 영구 보관하는 기능은 포함하지 않는다.

동일 메모/초안/문서 충돌은 canonical conflict에 candidate를 보관하고 공통 비교 UI에서 선택한다. 해결 전 같은 엔티티의 자동 저장 재시도는 차단한다. 현재 내용 사용 또는 candidate 적용 후 캔버스 편집 상태를 다시 불러와 오래된 pending textarea가 다시 게시되지 않게 한다.

## 원본·출처·대량 목록

원본 업로드는 private S3 presigned PUT과 checksum 검증을 거친다. 브라우저는 S3 요청에 API JWT를 보내지 않는다. 문서 content head와 reference head를 따로 표시하며, 과거 원본 복원은 무결성을 검증한 새 immutable version으로 저장한다. PDF/DOCX/HWPX는 Python parse job을 요청하고 normalized artifact를 읽는다. 변환과 초안 내보내기도 Python 처리 서비스를 사용한다.

TXT/Markdown 직접 편집은 2 MiB 이하의 원본만 스트림으로 읽고, bytes 길이와 SHA256 검증 후 엄격한 UTF-8 디코딩을 적용한다. 편집기에 로드한 version의 document revision을 저장 CAS로 유지하므로, 편집 중 새 head를 수신해도 그 내용을 덮지 않고 별도 version과 conflict를 보존한다. 원래 UTF-8 BOM과 CRLF/LF 줄바꿈을 저장할 때 복원하고, 복원한 bytes도 2 MiB 제한을 적용한다.

SourceSnapshot의 document/note/chat/draft quote를 보존한다. 기존 자료의 `metadata.legacy_id`는 화면의 citation ID에 대응시키고, 새 canonical ID를 사용한 citation도 같은 출처로 보이도록 변환한다. 원본 연결이 사라진 인용은 보존된 quote를 보여주며 열 수 없는 원본 열기 버튼을 표시하지 않는다.

폴더 목록과 전체 검색은 서버 cursor 페이지를 사용한다. 일반 캔버스는 최대 200개를 장착하고 그 한계를 명시하며, 목록/검색으로 모든 항목에 접근할 수 있다. 초기 bootstrap은 서버의 전체 canonical 상태를 읽는다. 25,001개 metadata fixture에서 마지막 항목 검색과 목록 추가 페이지를 검증했다. 파일 카드의 측정 요청은 frame별 한 번으로 묶어 수백 개의 개별 React Flow 측정 commit을 피한다.

## 검증 명령

```sh
node --experimental-transform-types --test packages/workspace-client/tests/http.test.mjs
npm --prefix frontend run typecheck
npm --prefix frontend run lint
cd frontend && npx playwright test --config=playwright.unified.config.ts
```

실제 Node/PostgreSQL/Moto S3/Python fixture를 사용하는 검사는 `frontend/playwright.unified-live.config.ts`다. 먼저 `apps/server/tests/live_fixture.ts`를 loopback 18003에서 실행한다. 이 fixture는 별도의 `_test` DB와 synthetic token을 사용한다. 기존 계정·자료를 검사에 사용하지 않는다.

검증 범위: 독립 변경 동시 요청, ACK 유실/재시작, 계정별 pending 격리, 메모 충돌 candidate 보존/해결, 데스크톱 기준 메모 화면, 폴더/원본 편집, 25,001개 inventory 페이지/검색, 혼합 출처 초안, 실제 비공개 blob bytes와 이력, 수동 초안 저장, Python AI 대화의 canonical 게시.

패키징한 Electron 앱의 실제 main/worker IPC 검사는 `apps/desktop/playwright.unified.config.ts`다. `CONTEXT_UNIFIED_TEST_URL`에 같은 loopback fixture를, `CONTEXT_DESKTOP_EXECUTABLE`에 실행 파일을 지정한다. renderer API를 대체하지 않고 OS safeStorage에 합성 계정만 암호화해 저장하며, `/api/me`용 작은 loopback proxy를 사용한다. 첫 게시, 실제 HTTP와 로컬 메모의 충돌/비교/선택, 클라우드 목록에서 빈 폴더로 내려받기, 삭제 tombstone, 원본 보존, 재시작을 확인한다. 결과 디렉터리는 기존 회귀 검사와 분리한 `test-results-unified-IPC`다.

## Docker

웹 Docker build context는 저장소 root이며 Dockerfile은 `frontend/Dockerfile`이다. `/workspace`의 공통 dependencies와 `/workspace/frontend`의 Next dependencies를 각각 설치한다. 개발 bind mount는 frontend와 packages만 덮는다. production standalone tracing root도 `/workspace`이며 시작 파일은 `/workspace/frontend/server.js`다. `NEXT_PUBLIC_WORKSPACE_API_URL`을 public API origin으로 설정한다.

개발 이미지와 production target 모두 실제 Docker build 후 임시 loopback 포트에서 기동/HTML 응답을 확인했다. production 검증 이미지는 synthetic public config를 사용했으며 배포하지 않았다.
