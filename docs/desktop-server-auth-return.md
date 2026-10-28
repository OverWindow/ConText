# HTTPS 서버 콜백에서 ConText 앱으로 복귀

2026-10-28. 데스크톱이 선택한 계정 서버가 OAuth 콜백을 받고, 앱 복귀 링크로 ConText를 연다.

## 로그인 경로

```text
ConText 앱에서 로그인 시작
→ Supabase → Google 로그인
→ Railway HTTPS /api/desktop/auth/callback/<로그인 요청 ID>
→ context-desktop://auth/callback?state=...&code=...
→ ConText 앱이 요청 ID 확인
→ PKCE 코드 교환 → Railway /api/me 확인 → 기기에 세션 저장
```

인증 코드는 서버 복귀 페이지를 거쳐 앱으로 전달하지만, PKCE verifier·access token·refresh token을 앱 복귀 링크에 넣지 않는다. 실제 토큰 교환은 로그인 요청을 시작한 앱에서 수행한다. 서버가 받은 `next`나 임의 외부 주소로 이동하지 않고, 고정한 ConText 프로토콜만 연다. 서버 복귀 페이지는 코드가 붙은 query를 브라우저 주소에서 제거하고 캐시·referrer를 차단한다. 자동 앱 열기가 차단되면 **ConText 앱 열기** 버튼으로 이어갈 수 있다.

## 운영 적용 순서

1. 새 백엔드 코드를 Railway `backend` 서비스에 배포한다. 추가 DB 마이그레이션이나 환경 변수는 필요 없다. 새 공개 설정 응답에 다음 항목이 있어야 한다.

   ```json
   { "desktop_callback_path": "/api/desktop/auth/callback" }
   ```

2. [Supabase URL Configuration](https://supabase.com/dashboard/project/uzatwhulmmchbfkggzce/auth/url-configuration)의 Redirect URLs에 다음을 추가한다.

   ```text
   https://backend-production-5697.up.railway.app/api/desktop/auth/callback/*
   ```

   기존 운영 웹 콜백과 loopback 항목은 이전 앱과의 호환성을 위해 유지한다. Google Cloud의 Authorized redirect URI는 기존 Supabase `/auth/v1/callback`을 유지한다.

3. 갱신된 ConText Desktop을 설치 또는 실행한 뒤 앱에서 새 로그인을 시작한다. macOS에서는 앱 패키지의 URL 프로토콜 등록이 필요하므로, 개발용 `electron .` 실행만으로 시스템 앱 복귀를 검증하지 않는다.

4. Google 인증 뒤 브라우저 주소가 Railway의 HTTPS 콜백을 거치고, 앱이 열려 **로그인됨** 상태가 되는지 확인한다.

서버가 아직 이 기능을 알리지 않으면 새 앱도 기존 loopback 방식을 유지한다. 서버 배포 뒤에는 새 로그인 요청부터 서버 콜백을 사용한다. 기존 세션은 로그아웃 없이 유지되며, 새 경로를 확인하려면 새 로그인을 시작해야 한다.

## 변경 파일

- `backend/app/api/desktop_auth_callback.py`: 공개 HTTPS 콜백과 복귀 페이지.
- `backend/app/api/ai.py`: 콜백 라우터 연결 및 기능 안내.
- `apps/desktop/electron/ai-connections.mjs`: HTTPS 복귀 주소 선택, state와 PKCE, 취소·만료·중복 링크 처리.
- `apps/desktop/electron/main.mjs`: macOS `open-url`, Windows/Linux `second-instance` 수신과 앱 창 활성화.
- `apps/desktop/package.json`: `context-desktop` URL 프로토콜 등록.

앱을 종료하면 진행 중인 PKCE 요청도 사라진다. 앱을 다시 켠 뒤 이전 브라우저 링크를 재사용하지 말고 로그인을 새로 시작한다. Windows 핸들러는 구현·이벤트 검증 범위이며 Windows 설치 실행 검증은 별도로 필요하다.

## 검증

- 로그인 로직 17개: 기존 loopback 호환, 서버 복귀, PKCE, 잘못된 state/주소/중복 코드, 취소·재사용 거부, 계정 보존.
- 서버 콜백 5개 통과: 고정 앱 주소, 세션 토큰·임의 목적지 미전달, 취소, 잘못된 요청, HTML 인코딩·CSP·캐시, 실제 인증 라우터의 기능 안내·연결.
- macOS 실행용 앱 UI 검사 3개 통과: 로그인·재시작·로그아웃과 로컬 자료 보존, 취소·오프라인 처리, 서버 복귀 URI의 `open-url`·`second-instance` 수신 뒤 로그인 완료. 외부 Google 계정과 응답은 합성 데이터로 대체했으며 개인 계정·프로필은 쓰지 않았다.
- 패키지 `CFBundleURLTypes`에 `context-desktop` 등록을 확인했다. 빌드 입력과 ASAR 실행 파일 42개·동봉 파서 301개를 대조했다.

갱신한 실행 경로: `apps/desktop/release/mac-arm64/ConText Desktop.app`. 이전 패키지는 `.backups/desktop-before-server-return-2026-10-28-odgCUp/release/`에 보존했다. 사용자 계정·원본 파일·프로필은 변경하지 않았다. 실행 중인 이전 앱은 사용자가 종료하고 새 앱을 열어야 한다.

운영 서비스와 Supabase 관리 설정은 이 로컬 구현 작업에서 자동 변경하지 않는다. 배포 후 실제 Google 로그인 성공은 별도 확인이 필요하다.

참고: [Electron 앱 복귀 링크](https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app), [네이티브 OAuth 표준의 loopback 방식](https://www.rfc-editor.org/rfc/rfc8252.html#section-7.3).
