# 운영 로그인 콜백 진단 — 2026-10-28

대상 계정 API: `https://backend-production-5697.up.railway.app`.

## 후속 확인: 로그인 성공

사용자의 설정 반영 이후 운영 공개 키를 다시 확인했다. `/api/desktop/auth/config`는 HTTP 200이며 현재 공개 anon 키로 Supabase `/auth/v1/settings`가 HTTP 200·Google 활성 상태를 반환한다.

실행 중인 ConText Desktop의 실제 화면에서도 계정 이름과 **로그인됨** 표시를 확인했다. 사용자가 전달한 임시 loopback 주소는 정상적인 앱 복귀 주소이며, 전달된 일회용 인증 코드를 재접속하거나 재사용하지 않았다. 인증 코드와 사용자 이메일은 이 기록에 저장하지 않는다.

같은 화면에 남아 있는 “연결 확인 필요 / 워크스페이스 서버 응답을 읽지 못했습니다”는 워크스페이스 동기화 상태의 별도 오류다. 로그인 성공 상태와 구분한다.

## 확인된 데스크톱 실패 원인: 유효하지 않은 공개 API 키

사용자가 본 마지막 화면은 `127.0.0.1:<임시 포트>/callback/...`의 “ConText로 돌아가…” 안내였다. 콜백 주소와 수신 자체는 정상이며, 실제 연결 클래스에서도 임시 프로필·취소 콜백으로 수신 HTTP 200을 확인했다.

운영 `/api/desktop/auth/config`가 내려주는 공개 키를 사용하면 다음 두 요청이 모두 `401 Invalid API key`를 반환했다.

- `GET https://uzatwhulmmchbfkggzce.supabase.co/auth/v1/settings`
- `POST .../auth/v1/token?grant_type=pkce` — 사용자 코드 대신 존재하지 않는 진단 코드를 사용했으며, API 키 단계에서 먼저 거부됐다.

공개 키 원문은 출력하지 않았다. 현재 운영 값은 publishable 형식이며, 앞뒤 공백이나 따옴표가 붙은 문제는 아니었다. 로컬 `.env.railway.backend`의 값과 운영 응답 값이 같았다.

반면 `.env.backend.production`의 기존 공개 anon 키는 같은 Supabase 프로젝트를 가리키고 `role=anon`임을 확인했으며, 해당 키로 `/auth/v1/settings`가 HTTP 200·Google 활성 상태를 반환했다. 이 검증된 공개 키로 **로컬 `.env.railway.backend`의 `SUPABASE_PUBLISHABLE_KEY` 한 항목을 갱신**했다. 다른 환경 값은 유지했다.

운영 적용에 필요한 조치:

1. Railway 프로젝트의 `backend` 서비스 → Variables → `SUPABASE_PUBLISHABLE_KEY`.
2. 로컬 `.env.railway.backend`의 같은 항목에 준비한 검증된 공개 키를 넣는다. `SUPABASE_URL`은 현재 프로젝트 URL을 유지한다.
3. 변경 사항을 배포하고 `/api/desktop/auth/config`에 새 값이 반영되는지 확인한다.
4. 데스크톱에서 새 Google 로그인 요청을 시작한다. 이전 콜백 URL은 재사용하지 않는다.

이 채팅에서 Railway 관리 설정을 수정하거나 운영 재배포하지는 않았다. 이후 사용자의 설정 반영 뒤 위 후속 확인에서 앱의 로그인 성공 상태를 확인했다.

## 확인한 사실

- `/health`: HTTP 200. 미인증 `/api/me`: HTTP 401.
- `/api/desktop/auth/config`: HTTP 200.
- Supabase: `https://uzatwhulmmchbfkggzce.supabase.co`.
- 공개 웹 주소: `https://context-five-theta.vercel.app`.
- Google authorize의 `redirect_uri`는 해당 Supabase의 `/auth/v1/callback`이다.
- 사용자 계정·Google 동의·로그인 토큰을 사용하지 않고, Google 인증 시작 후 취소 콜백을 이용해 아래 이동을 확인했다.

| 요청한 최종 복귀 주소 | 실제 취소 후 이동 |
|---|---|
| `http://127.0.0.1:48765/callback/<48자리 경로>` | 요청한 임시 포트와 경로 유지 |
| `https://context-five-theta.vercel.app/auth/callback` | `http://localhost:3000/`로 대체 |
| 복귀 주소 미지정 | `http://localhost:3000/` |

따라서 운영 웹 콜백이 허용되지 않고 기본 복귀 주소도 localhost로 남아 있는 상황을 재현했다. 대시보드의 실제 저장 값을 읽은 것은 아니며, 외부 동작으로 확인한 결과다. 데스크톱의 loopback 복귀 주소 자체는 현재 허용된다.

현재 실행용 패키지의 `electron/ai-connections.mjs`는 작업 소스와 바이트가 같으며, loopback PKCE를 사용하고 `localhost:3000`을 하드코딩하지 않는다.

## 설정할 값

[Supabase URL Configuration](https://supabase.com/dashboard/project/uzatwhulmmchbfkggzce/auth/url-configuration)에서 다음을 설정한다.

Site URL:

```text
https://context-five-theta.vercel.app
```

Redirect URLs에 운영 웹 콜백을 추가한다.

```text
https://context-five-theta.vercel.app/auth/callback
```

데스크톱에서 실제로 쓰는 loopback 허용 항목은 유지한다.

```text
http://127.0.0.1:*/callback/*
```

Google Cloud의 Authorized redirect URI는 아래 Supabase 콜백을 사용한다. Railway API 주소를 Google 콜백으로 바꾸는 구성은 아니다.

```text
https://uzatwhulmmchbfkggzce.supabase.co/auth/v1/callback
```

위 관리 설정은 이번 읽기 전용 진단에서 변경하지 않았다. 공개 publishable key는 존재 여부만 확인했고 로그·문서에는 원문을 기록하지 않았다. 개인 프로필·저장 계정은 사용하지 않았다.

## 데스크톱에서 구분할 증상

- 최종 주소가 `localhost:3000`이면 운영 웹 콜백/기본 주소로 대체된 경로를 확인한다. 실제 사용 중인 앱 버전과 로그인 진입점도 확인해야 한다.
- `127.0.0.1:<임시 포트>/callback/...`이면 정상적인 데스크톱 복귀 주소다. 앱으로 돌아온 뒤의 코드 교환·계정 API 오류를 앱 메시지로 구분한다.
- 실제 Google 계정 선택과 성공 로그인 완료는 이번 진단에서 수행하지 않았다.

근거: [Supabase Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls), [Google 로그인 설정](https://supabase.com/docs/guides/auth/social-sign-in/auth-google).
