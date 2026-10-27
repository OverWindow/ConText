# Login 음수 성능 측정 오류 — 2026-10-27

## 원인

`Failed to execute measure on Performance: Login cannot have a negative time stamp`는 로그인 서버 컴포넌트가 리디렉션으로 종료되거나 렌더링이 중단된 뒤 React 개발용 RSC 성능 측정이 음수 종료 시간을 브라우저에 전달해 발생했다. 설치된 Next.js 번들에서 해당 분기에 정상 렌더링과 같은 시간 검사가 빠져 있는 것을 확인했다. React 이슈 https://github.com/react/react/issues/37561 과 Next의 제안 https://github.com/vercel/next.js/pull/88688 에도 같은 경로가 설명돼 있다.

실행 중인 Docker 개발 컨테이너는 저장소의 Next.js 16.4.3과 달리 이전 node_modules 볼륨의 16.4.0을 사용하고 있었다. 해당 컨테이너 로그에서 실제 Login 음수 측정 예외를 확인했다.

## 수정

`frontend/scripts/patch-next-rsc-timing.mjs`가 Next.js 16.4.3에 포함된 RSC 브라우저 개발 클라이언트 네 종류(Turbopack/Webpack, 일반/experimental)의 오류·중단 측정에만 비음수 종료 시간 검사를 적용한다. 정상 측정, 리디렉션, 실제 오류 상태는 유지한다. 전역 performance API를 바꾸거나 브라우저 오류를 숨기지 않는다. 프로덕션 런타임 파일과 로그인 코드는 변경하지 않았다.

`npm run dev`의 predev에서 자동 검증·적용한다. 여러 번 실행해도 중복 수정하지 않으며, 번들 모양이 예상과 다르면 시작 전에 명확한 오류로 알린다. Next 버전을 올릴 때는 이 우회 수정의 필요 여부와 코드를 다시 검토해야 한다. 실제 수정이 있는 경우에만 개발 번들 캐시를 정리한다.

Docker 개발 컨테이너의 의존성을 기존 lockfile로 다시 설치해 16.4.3으로 맞추고 프런트엔드만 재시작했다. 현재 컨테이너에서 네 클라이언트 수정 적용과 정상 기동을 확인했다. 사용자 DB·문서·로그인 세션은 초기화하지 않았다.

## 검증

- 수정 전 실제 설치된 RSC 성능 함수에서 음수/음의 무한대 종료 시간 실패 16건을 재현했다.
- 수정 후 회귀 검사 28개 통과: 잘못된 측정 건너뛰기, 정상 측정 유지, 원래 리디렉션/오류 상태 유지, 재적용 안전성.
- PC/모바일 Playwright 8개 통과: 실제 브라우저 Performance API로 재현 조건 검증, 비로그인 보호 경로, 로그인된 사용자의 Login → 워크스페이스 이동, 실제 OAuth 실패 안내 유지.
- ESLint 및 Next.js 프로덕션 빌드/TypeScript 통과.
- 현재 localhost:3000에서 로그인 200, 비로그인 워크스페이스 → 로그인 이동, 브라우저 오류 없음 확인. 재시작 이후 관찰한 로그에도 같은 오류가 없었다.

재현 명령: `npm --prefix frontend run test:rsc-timing`, `frontend`에서 `npx playwright test --config playwright.login.config.ts`, `npm run build`.

변경 전 파일 및 검증 로그: `.backups/login-performance-2026-10-27/`.

사용 중인 브라우저는 강력 새로고침(macOS: Cmd+Shift+R)해 이전 개발 번들을 교체하면 된다.
