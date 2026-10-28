# ConText 크림슨 테마 — 2026-10-28

선택한 크림슨·웜 화이트·차콜 팔레트를 실제 웹 및 공통 데스크톱 화면에 적용했다.

- 주색 `#A40F16`, 배경 `#FAF8F5`, 본문 `#2A2526`, AI 보조색 `#7C334B`.
- 공통 원본: `packages/workspace-ui/assets/tokens.css`.
- 소개·로그인·워크스페이스·캔버스·문서 카드·AI 인용·작성·변환 화면은 공통 토큰을 사용한다. 직접 지정되어 있던 차가운 배경·모달·그림자도 토큰으로 연결했다.
- 문서 형식은 로즈·따뜻한 회색·차분한 청록·와인·토프 계열로 구분한다. 상태와 변경 비교는 녹색·적갈색·황토색과 기존 문구·아이콘을 함께 사용한다.
- 도형 저장 키 `violet`·`blue`는 유지하며 화면 색 이름은 와인·크림슨으로 표시한다. 해당 이름을 선택하는 기존 테스트도 갱신했다.
- 로고·심볼·파비콘·Apple 아이콘·공통 패키지 자산을 갱신했다. 원본·내장 이미지 편집 프롬프트·재내보내기 방법은 `design/brand/README.md`에 있다.
- 기존 디자인 가이드와 `design/ConText-palette.html`, 색상표 PNG를 갱신했다.

## 확인 결과

- 프런트 타입 검사·ESLint 통과.
- 웹 production build·데스크톱 build 통과.
- 기존 소개·로그인·공개 샘플 Playwright 검사: PC·모바일 합계 16개 통과. 빌드된 로컬 웹 서버에서 실행했다.
- 소개·로그인·샘플 3개 화면을 PC·모바일 총 6개 크기로 확인했다. 새 기본 토큰, 기존 주색 잔존 여부, 수평 넘침을 확인하고 캡처를 살펴봤다.
- 주요 텍스트 대비: 흰색/크림슨 7.90:1, 본문/배경 14.24:1, 보조 텍스트/배경 5.45:1, AI 인용 7.54:1, 선택 상태 텍스트 6.70:1.
- 웹·공통 패키지의 두 로고 파일 바이트 일치, diff 공백 검사 통과.

실제 화면 캡처와 수치: `artifacts/crimson-theme/`. 변경된 모든 인증 사용자 화면의 개별 브라우저 검사를 뜻하지 않는다. 최초 색상 변경 때는 데스크톱 번들까지만 빌드했다. 아래 후속 작업에서 실행용 앱도 갱신했다. 운영 배포는 수행하지 않았다.

## 실행용 데스크톱 패키지 후속 갱신

기존 `release/mac-arm64/ConText Desktop.app`의 ASAR에는 이전 파란색이 남아 있음을 확인했다. 현재 소스로 다시 빌드하고 별도 경로에서 패키징한 뒤, 임시 프로필의 실제 패키지 UI 검사 `sample.spec.ts`를 통과했다. 샘플 열기·PDF/HWPX/표/이미지 읽기·폴더 연결과 원본 보존을 확인했다.

검증한 새 앱을 기존 실행 경로로 교체했다. 이전 `release` 전체는 `.backups/desktop-crimson-2026-10-28-DVacIB/release/`에 보존했다. 사용자 프로필·로그인·원본 폴더는 변경하지 않았다. 실행 중인 이전 앱은 완전히 종료한 뒤 새 패키지를 열어야 화면이 갱신된다.

- 앱: `apps/desktop/release/mac-arm64/ConText Desktop.app`
- ZIP: `apps/desktop/release/ConText-Desktop-unified-mac-arm64.zip`
- 검증 명세: `apps/desktop/release/unified-build.json`
- 실제 패키지 화면: `artifacts/crimson-theme/desktop-packaged.png`
- 새 CapCut 소스: `artifacts/context-capcut-crimson-2026-10-28.zip` — 1920×1080 PNG 7장, 투명 오버레이 4장 포함.
