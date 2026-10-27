# 메뉴 없는 워크스페이스 홈 — 2026-10-27

> 최신 작업 동작과 패키지 검증은 [워크스페이스 선택·파일 클릭 동작](workspace-file-actions.md)을 따른다.

> 후속 수정과 최신 패키지: [동기화 경로 충돌 수정](sync-path-collision-fix.md).

웹 `/workspaces`와 데스크톱의 워크스페이스 목록·선택 화면을 독립 홈으로 분리했다. 사이드바, 작업 메뉴, 캔버스 도구, 하단 작업 상태 표시를 렌더링하지 않는다. 상단에는 ConText 로고와 계정만 두고 본문에는 워크스페이스 카드와 생성·폴더 연결 동작을 배치한다.

공통 `ApplicationHomeShell`과 `application-home.css`를 양쪽에서 사용한다. 카드를 열면 기존 캔버스와 작업 메뉴가 나타나며, 로고를 누르면 메뉴 없는 홈으로 돌아온다. 데스크톱의 마지막 워크스페이스 자동 열기 동작은 유지한다. 계정 로그인·관리, 웹의 생성/삭제, 데스크톱의 폴더 연결/해제·클라우드 열기를 유지한다.

- [웹 PC 화면](images/workspace-home-web-desktop.png)
- [웹 모바일 화면](images/workspace-home-web-mobile.png)
- [데스크톱 화면](images/workspace-home-desktop.png)

웹 PC·모바일 UI 14개가 통과했다. 홈에 메뉴가 없는지, 제목이 한 번만 표시되는지, 생성 입력·계정이 접근 가능한지, 가로 넘침이 없는지, 카드에서 다시 캔버스로 들어갈 수 있는지 확인했다. 최종 패키지에서는 계정·홈 이동·폴더 연결/해제 검사가 통과했다. 파일 감시 검사는 첫 실행에서 삭제 반영이 한 차례 지연되어 실패했고, 동일 실행 파일의 별도 재검사는 총 3회 연속 통과했다. 파일 감시 코드는 변경하지 않았다. 초기 결과와 재검사 로그를 함께 보관한다.

웹 ESLint·프로덕션 빌드, 데스크톱 빌드·패키징, ZIP CRC와 현재 소스/실행 파일/ZIP 일치 검사도 확인했다. DB 변경이나 데이터 초기화는 없다.

- 앱: `apps/desktop/release/mac-arm64/ConText Desktop.app`
- ZIP: `apps/desktop/release/ConText-Desktop-unified-mac-arm64.zip`
- ASAR SHA-256: `36557572216de34057d12057bd8605d9bea42420b99c55a295f9112b18c31509`
- ZIP SHA-256: `c50667a6d9a73fd0a8c53543059d74dd6222a7f54abafff857197ece850bf0ba`
- 변경 전 소스·이전 ZIP·검증 로그: `.backups/workspace-home-2026-10-27/`

앞선 전체 화면 공통화의 범위와 검증은 [공통화 기록](application-ui-unification.md)에 남아 있다.
