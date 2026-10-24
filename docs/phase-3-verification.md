# Phase 3 검증 기록

2026-10-07, 로컬 소스 구현과 개발 Docker 서비스 반영을 완료했다.

| 검사 | 결과 |
|---|---|
| 실제 AWS S3 PUT/HEAD/GET | 성공, checksum·원본 바이트·attachment 확인 |
| 실제 S3 CORS / 익명 접근 / 덮어쓰기 | OPTIONS 200 / 익명 GET 403 / 재업로드 412 |
| PostgreSQL 기반 backend pytest | **82 passed**, 5.35초 |
| Ruff format / check | 통과 |
| ESLint / TypeScript | 통과 |
| 캔버스 Playwright desktop/mobile | **10 passed**, 18.3초 |
| 기존 문서 Playwright desktop/mobile | **8 passed**, 8.3초 |
| 기존 인증 Playwright desktop/mobile | **6 passed**, 7.2초 |
| Next.js production build | 통과 |
| 개발 DB migration | `0003_canvas_workspace (head)` |
| Alembic check | 모델과 migration 일치 |
| 프런트엔드 /login | HTTP 200 |
| npm audit --omit=dev | 보고된 런타임 취약점 0 |

## Backend

기존 Phase 1/2 회귀를 포함한다. Phase 3에서는 snapshot 문서 소속, 부분 위치 갱신과 복원, 최종 수정자, OWNER/EDITOR/VIEWER, 비멤버·미인증 차단, 배치 중 다른 Workspace 문서가 포함된 경우 거부, 중간 DB 오류 시 전체 transaction rollback, 좌표 유효성, 관계 동시 생성의 중복 방지, 자기 연결 거부, VERSION 유형 거부, 관계 삭제의 문서 보존, DB 복합 FK의 Workspace 격리, PATCH/DELETE CORS를 확인했다. Migration downgrade/upgrade는 `_test` 임시 DB에서만 수행했다.

## Browser

실제 Chrome의 데스크톱과 모바일 viewport에서 드래그 위치 저장, 새로고침 복원, 줌/팬, 저장 실패 후 재시도, 관계 폼 생성·새로고침 복원·삭제, VIEWER 쓰기 UI 제한, 키보드 Enter 선택 후 방향키 이동, 핸들 드래그 연결을 확인했다. 새 캔버스를 포함한 화면에서도 기존 업로드·다운로드·재시도 및 인증 경로 검사가 통과했다. 가로 넘침 검사를 통과하고 저장한 스크린샷을 육안 확인했다.

브라우저 테스트는 테스트 전용 인증 서버와 API 응답을 사용한다. 실제 DB 검증은 backend 통합 테스트로, 실버킷 검증은 앱의 storage 모듈을 직접 호출해 수행했다. 실제 사용자 Google 동의 → JWT → 캔버스 → S3를 하나의 브라우저 세션에서 연결한 E2E는 자동화하지 않았다. 모바일 검사는 Chrome viewport 에뮬레이션이며 실제 iOS Safari 기기 검사는 아니다.

## 재실행

```bash
docker compose --env-file .env.development -f docker-compose.yml -f docker-compose.test.yml --profile test run --build --rm backend-test
cd frontend
npm run lint
npm run typecheck
npm run test:canvas
npm run test:documents
npm run test:e2e
npm run build
```

브라우저 테스트는 모두 3100 포트를 사용하므로 순서대로 실행한다. 테스트 전용 인증 서버는 3101, route mock 대상 API는 3102를 사용한다. 실사용 3000/8000과 분리한다. 앱 런타임에 인증 우회 경로는 추가하지 않았다.

## 남은 사항

- 새로운 외부 설정은 없다. 실제 S3 권한과 CORS는 재검사를 통과했다.
- 실버킷의 64바이트 검증 객체 하나는 DeleteObject 권한이 없어 남았다. [정확한 삭제 대상](phase-2-verification.md#aws-재검사-통과--2026-10-07-2227-kst)을 기록했다. 이 객체를 앱 문서로 등록하지 않았다.
- 위치 동시 편집은 마지막 commit이 이기는 방식이며 실시간 협업은 범위 밖이다. 최대 1,000개 문서 snapshot 제한을 둔다. 줌/팬 상태는 영구 저장하지 않는다.
- Starlette/AnyIO deprecation 및 테스트 서버 색상 환경 변수 경고가 있지만 테스트는 통과했다. 기존 개발 도구의 npm high 경고 5건은 남아 있고 production 의존성 audit 결과는 0건이다.
- 다음 단계는 Phase 4 Document Processing이다. 이번 작업에서 parser, worker, AI, 버전 연결을 구현하지 않았다.
