# Phase 5 검증 기록

2026-10-08 KST, 현재 경로의 소스와 Docker 개발 환경에서 검증했다.

## 자동 검사

- Python Ruff 통과.
- 백엔드 **109개 통과**. 실제 분리된 PostgreSQL 테스트 DB와 Redis를 사용한다. 기존 인증·업로드·권한·캔버스·파싱·워커·멤버 관리 회귀를 포함한다.
- 새 버전 테스트: 여러 버전 등록, 현재 버전 전환, 업로드 검증 전 전환 거부, 늦은 업로드 완료 시 현재 버전 유지, 등록자·메모 응답, 비교 입력 검증.
- 같은 요청의 동시 재시도와 서로 다른 요청의 동시 번호 배정, 변경된 요청 ID 재사용 거부, 같은 문서의 원본 중복 거부, 검증 전 실패한 파일의 새 버전 등록을 확인했다.
- 수동 연결의 멱등성·공유 원본·출처 보존·독립 파싱 READY·다운로드 바이트 일치, 연결된 버전의 업로드 URL 차단을 확인했다. 다른 문서와 워크스페이스의 버전 접근, VIEWER 쓰기 차단과 EDITOR 쓰기 허용을 확인했다.
- 전체 migration upgrade/downgrade(공유 객체 없는 테스트 DB)와 ORM 모델 일치 검사 통과. 공유 객체가 생긴 상태의 downgrade는 가이드에 명시한 UNIQUE 제약 제한이 있다.
- 데스크톱·모바일 브라우저 **44개 통과**: 기존 Phase 4 34개 + Phase 5 10개. 이력·과거 본문·현재 버전의 새로고침 유지, 업로드 완료 재시도, 수동 연결, 두 본문 비교, VIEWER 제한, 중복 파일 경고와 명시적 별도 등록을 검증했다. 전체 화면 격자·본문 모달·파일별 색상·참조 표시·팀원 추가 회귀도 통과했다.
- ESLint, Next.js production build, TypeScript 검사 통과.
- 기존 Starlette/AnyIO deprecation warning 1건이 출력됐으며 테스트 실패는 없다.

재현 명령:

```bash
docker compose --env-file .env.development -f docker-compose.yml -f docker-compose.test.yml --profile test run --build --rm backend-test
cd frontend
npm run test:phase4
npm run test:versions
npm run lint
npm run build
npm run typecheck
```

이번 백엔드 검사는 기존 동일 의존성 테스트 이미지에 최신 backend 소스를 bind mount하여 Ruff와 pytest를 실행했다. 위 `--build` 명령은 새 환경에서 최신 소스를 포함하는 재현 경로다.

## 실행 중인 개발 환경

- `0005_version_management (head)` 적용 완료.
- 실행 중인 DB에 `alembic check` → `No new upgrade operations detected.`
- backend/PostgreSQL/Redis healthy, frontend/worker/dispatcher 실행 상태 확인.
- worker와 dispatcher를 재시작해 새 코드를 반영했다. 실제 Celery `inspect ping` → `pong`, 1 node online.
- API `/health` → 200 및 `{"status":"ok"}`, 프런트엔드 `/login` → 200.
- 사용자 환경 변수와 기존 문서는 변경하지 않았다. 테스트는 별도 DB에서 실행했고 사용자 워크스페이스에 테스트 문서를 생성하지 않았다.

## 검증 범위의 한계

브라우저 검사는 테스트 전용 인증 서버와 API/S3 응답을 사용한다. 백엔드 S3 통합은 Moto HTTP 에뮬레이터이며, DB·Redis와 기존 Celery 전달 테스트는 실제 프로세스다. 실제 Google 사용자 로그인과 실제 AWS S3를 사용하는 버전 등록 전체 과정을 이번 변경에서 다시 실행하지 않았다. 기존 실 S3 검증은 [Phase 2 기록](phase-2-verification.md)에 있다. 런타임 인증 우회는 추가하지 않았다.

Phase 5 비교는 파일 메타데이터와 추출 본문을 나란히 읽는 기능이다. 자동 diff·유사도·AI 요약은 포함하지 않는다.

## 화면

테스트 데이터로 촬영했으며 데스크톱/모바일 중앙 모달과 내부 스크롤을 확인했다.

- [데스크톱 버전 이력](images/phase-5-timeline-desktop.png)
- [모바일 버전 이력](images/phase-5-timeline-mobile.png)
- [데스크톱 버전 비교](images/phase-5-compare-desktop.png)
- [모바일 버전 비교](images/phase-5-compare-mobile.png)

사용법, API, 원본 공유·다운그레이드 제한은 [Phase 5 가이드](phase-5-version-management.md)에 정리했다.
