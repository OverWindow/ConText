# 데스크톱·웹 동기화 연결 진단 — 2026-10-28

## 원인

운영 Python 계정 서버의 `GET /api/desktop/auth/config`가 동기화 API로
`https://unified-server.vercel.app`을 반환한다. 해당 주소의 `/v2/me`는
HTTP 404, `text/plain`, `DEPLOYMENT_NOT_FOUND`를 반환한다.

`apps/desktop/electron/unified-transfer.mjs`의 `request()`는 응답을 JSON으로
파싱하므로 이 응답에서 `INVALID_RESPONSE`와
“워크스페이스 서버 응답을 읽지 못했습니다.”를 표시한다.
로그인 성공 여부와 별개인 동기화 서버 주소 설정 오류다.

## 읽기 전용 운영 검증

| 요청 | 결과 |
|---|---|
| `https://backend-production-5697.up.railway.app/api/desktop/auth/config` | 200, 잘못된 Vercel 동기화 주소 반환 |
| `https://unified-server.vercel.app/v2/me` | 404, JSON이 아닌 `DEPLOYMENT_NOT_FOUND` |
| `https://context-production-7ffd.up.railway.app/health` | 200, protocol 2 |
| `https://context-production-7ffd.up.railway.app/ready` | 200, DB·storage·processor 모두 `ok` |
| `https://context-production-7ffd.up.railway.app/v2/me` (인증 없음) | 401, 정상 JSON `AUTHENTICATION_REQUIRED` |
| 정상 API `/v2/workspaces` OPTIONS, 운영 웹 Origin | 204, `Access-Control-Allow-Origin`이 운영 웹과 일치 |
| `https://context-five-theta.vercel.app/login` | 200 |

로컬 `.env.frontend.production`의 `NEXT_PUBLIC_WORKSPACE_API_URL`은 정상
Railway 주소와 일치한다. 이번 비인증 확인으로 실제 배포된 웹의 로그인 후
API 주소나 사용자 데이터 왕복 동기화를 검증한 것은 아니다.

## 준비한 변경과 운영 적용

로컬 `.env.railway.backend`의 `UNIFIED_API_URL` 한 항목만 정상 공개 주소로
수정했다. 기존 값은 데스크톱에서 접근할 수 없는 Railway 내부 HTTP 주소였다.
비밀값과 다른 환경 항목은 변경하지 않았다.

운영 Railway **backend (Python)** 서비스의 Variables에서 다음 값을 적용하고
해당 서비스를 재배포해야 한다.

```dotenv
UNIFIED_API_URL=https://context-production-7ffd.up.railway.app
```

적용 후 `/api/desktop/auth/config`가 이 주소를 반환하는지 확인한다.
데스크톱은 로그인 시 이 값을 암호화된 계정 연결에 저장하고, 현재 구현은
동기화마다 설정을 다시 가져오지 않는다. 따라서 서버 수정 뒤 데스크톱에서
로그아웃하고 새로 로그인한 다음 동기화를 다시 시작한다.

운영 설정 변경·재배포, 사용자 계정 토큰을 사용한 요청, 워크스페이스나
파일 변경은 수행하지 않았다. 실제 동기화 복구는 운영 설정 반영 후 확인해야 한다.

## 후속 복구 완료 — 2026-10-29

사용자가 운영 주소를 수정한 뒤 “다른 서버 또는 계정에 연결된 폴더입니다”가
표시됐다. 실제 로컬 DB의 `하루랩_스타트업`은 운영 주소가 아니라
`http://localhost:8001`에 연결되어 있었고, 이전 서버의 cursor 90과 전송 대기
4개를 보유했다. 이는 서버 주소의 단순 오기가 아니라 개발 서버에서 운영
서버로 이동하는 상황이므로 기존 cursor를 재사용하면 안 된다.

사용자가 **백업 후 운영 계정으로 전환**을 명시적으로 승인했다. 다음과 같이 복구했다.

- SQLite 전체 온라인 백업과 앱 종료 후의 최신 백업을 만들고 무결성을 검사했다.
- 로컬에 없던 분석 산출물 28개를 기존 개발 S3에서 읽기 전용으로 회수했다.
  원본·산출물 69개 전체의 크기와 SHA-256을 확인했다.
- 백업 사본에서 기존 canonical 상태의 모든 컬렉션, native 테이블 23개,
  다른 워크스페이스가 보존되는지 검증했다.
- 기존 대기 변경 4개의 명령과 연결 정보는 감사 기록과 DB 백업에 보존했다.
  변경이 반영된 전체 상태를 정식 `ImportWorkspace` 명령 하나로 준비하고,
  이전 cursor·연결·기기 식별자를 신규 연결 상태로 전환했다.
- 앱을 종료한 상태에서 최신 백업과 실제 DB가 같은지 다시 확인한 뒤 검증한
  사본을 적용했다. 로그인 자격 증명과 원본 폴더는 변경하지 않았다.
- 기존 앱을 재실행하고 승인된 현재 운영 계정으로 동기화했다.

앱은 **서버 반영됨**, 서버 반영 대기 0개, 파일 적용 대기 0개를 표시했다.
실제 DB에서도 운영 Railway 연결, 서버 확인 cursor 1, 전송 대기·거절 기록·
미완료 파일 적용 모두 0개를 확인했다. 원래 원본/이력 41개의 바이트는 백업과
일치했다. 초안 2개, 참조 관계 5개, 대화 및 분석 산출물도 이전 상태에 포함됐다.

백업·검증·복구 스크립트는 Git에서 제외된
`.backups/desktop-server-migration-2026-10-29/`에 보존했다.
`workspace-before-apply.sqlite`가 적용 직전 백업이며, `verification.json`과
`completion.json`에 검증 결과가 있다. 앱 코드의 서버·계정 보호 검사는
완화하거나 제거하지 않았다.

앱의 “웹에서 열기”를 실행했지만 Google Chrome의 Computer Use 접근 권한이
없어 웹 화면 자체는 확인하지 못했다. 운영 서버의 동기화 완료와 웹 화면의
실제 표시 검증을 구분한다.
