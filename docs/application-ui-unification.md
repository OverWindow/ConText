# 웹·데스크톱 공통 화면 — 2026-10-27

> 최신 작업 동작과 패키지 검증은 [워크스페이스 선택·파일 클릭 동작](workspace-file-actions.md)을 따른다.

> 후속 변경: 워크스페이스 목록은 메뉴 없는 독립 홈으로 분리했다. 최신 화면과 패키지는 [워크스페이스 홈 기록](workspace-home-screen.md)을 따른다.

데스크톱의 캔버스와 떠 있는 상단 도구를 기준으로 웹과 데스크톱의 화면 틀을 공통 패키지로 옮겼다. 두 앱이 `@context/workspace-ui`의 같은 React 컴포넌트와 CSS를 사용한다.

## 반영 내용

| 영역 | 공통 구현 |
| --- | --- |
| 화면 틀 | `ApplicationShell`, 같은 로고·색·서체·사이드바·상단 도구·하단 상태 표시 |
| 메뉴 | 캔버스 → 문서 관리 → AI 문서 작성 → AI 채팅 → AI 연결 설정 |
| 홈 | `ApplicationHome`, 같은 워크스페이스 카드·열기·삭제/연결 해제·빈 목록 구성 |
| 문서 관리 | `DocumentLibrary`, 파일과 폴더 검색·200개씩 더 보기·열기 |
| 파일 만들기 | `CreateEntryDialog`, 이름·TXT/Markdown 검증·저장 중 상태·실패한 입력 보존 |
| 미리보기 | `DocumentPreviewLayout`, 같은 제목·미리보기/수정 이력/수정 이력 비교/내보내기 탭·하단 도구 |
| 계정 | `AccountControl`, 같은 계정 창·로그인/로그아웃·상태 표시, 앱별 인증 어댑터 |
| 동기화 | `SyncControl`, `SyncReviewDialog`, 같은 상태 문구·대기 수·재시도·충돌·복구 창 |
| 좁은 화면 | 58px 아이콘 메뉴·단일 심벌·줄바꿈하는 도구, 버튼과 팝오버 겹침 방지 |

웹은 미리보기에서 두 수정 이력을 나란히 열어 비교할 수 있다. 데스크톱의 기존 변경 강조·AI 변경 요약·버전 연결 기능은 유지한다. 공통 미리보기의 본문과 추가 작업은 각 저장소가 제공하는 기능을 사용한다.

운영체제의 폴더 선택·탐색기·파일 직접 저장·보안 저장소는 데스크톱 어댑터에 남는다. 웹에서는 공유 공간 생성·업로드·다운로드·브라우저 인증을 사용한다. 데스크톱의 로컬 연결 해제는 원본을 보존하며, 공유 워크스페이스 삭제와 구분한다. DB 마이그레이션은 추가하지 않았다.

동기화의 **서버 반영됨**은 다른 기기의 디스크 적용 완료를 의미하지 않는다. 공통 안내에서 이를 명시한다. 웹의 **지금 동기화**는 보존된 전송을 재시도한다. 옛 전송 응답이 최신 부트스트랩 상태를 덮는 경우도 막았다.

## 검증

- 최종 macOS 패키지 UI: **21개 통과**. 홈 이동, 폴더 연결/해제, 감시, 캔버스, 문서/수정 이력, 계정, 작성, 채팅 포함.
- 최종 패키지 + 실제 Node/Postgres/테스트 S3 IPC: **1개 통과**. 업로드·충돌 해결·다른 폴더로 받기·삭제 후 원본 보존.
- 웹 PC/모바일 UI: **14개 통과**. 공통 메뉴·계정·동기화 문구·2만 5천 개 파일 탐색·응답 유실·충돌·복구 내보내기·두 수정 이력 비교.
- 웹 PC/모바일 + 실제 서버: **2개 통과**. 생성·원본 편집·초안·채팅·목록 복귀·삭제 기록과 목록 제외.
- 워크스페이스 클라이언트: **18개 통과**. 이전 응답 재전송과 수동 동기화 회귀 검사 포함.
- 웹 ESLint·프로덕션 빌드·TypeScript 및 패키지 경계 검사 통과.
- ZIP CRC, 현재 소스와 패키지/ZIP 일치 검사 통과. 소스 149개, 실행 파일 41개, 파서 파일 301개 확인.

검증에는 격리된 테스트 DB·스토리지와 합성 계정을 사용했다. 기존 데이터는 초기화하지 않았다. macOS ARM64 패키지이며 기존 배포 설정대로 코드 서명은 적용하지 않았다.

재현: `npm --prefix frontend run build`, `npm --prefix packages/workspace-client test`, `apps/desktop`에서 `npm run pack`과 Playwright, `frontend`에서 `playwright.unified.config.ts` 및 `playwright.unified-live.config.ts`. 실제 연결 검사는 기존 격리 fixture가 필요하다. 실행 명령과 fixture 준비는 [통합 실행 안내](unified-workspace-runbook.md)를 참고한다.

## 화면과 빌드

[데스크톱 화면](images/application-desktop.png) · [웹 PC 화면](images/application-web-desktop.png) · [웹 모바일 화면](images/application-web-mobile.png) · [데스크톱 홈](images/application-desktop-home.png) · [웹 홈](images/application-web-home-desktop.png)

- 앱: `apps/desktop/release/mac-arm64/ConText Desktop.app`
- ZIP: `apps/desktop/release/ConText-Desktop-unified-mac-arm64.zip`
- 빌드 명세: `apps/desktop/release/unified-build.json`
- ASAR SHA-256: `64a069dfaa2ea1d452f076f15f4cbdf85a9665de3d491e81b862981d3571040d`
- ZIP SHA-256: `3b1634c65c2cb7843cc5c71d338f6abcabfa7a8ab7c6871250d98804b80cd907`
- 검증 로그: `.backups/application-ui-2026-10-27/verification/`
- 변경 전 파일/이전 ZIP: `.backups/application-ui-2026-10-27/`
