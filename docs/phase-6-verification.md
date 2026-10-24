# Phase 6 검증 기록

2026-10-08 KST. 현재 워크스페이스의 소스와 Docker 개발 환경에 적용했다.

## 결과

- **백엔드 143개 통과**. PostgreSQL/Redis는 개발 데이터와 분리된 임시 테스트 컨테이너를 사용했다. Ruff 통과.
- 신규 검증: 한글 텍스트·제목 구조 diff, 문단/단어 근거, 긴 문서·표시 제한, 변경 부분만 모델에 전송, 구조화 JSON·근거 ID 검증, 잘못된 벡터 거부, 모델별 임베딩 비교 제한, 동일 workspace/current version 후보 필터, 다른 workspace 데이터 격리, VIEWER 쓰기 차단, 명시적 후보 연결과 원본/current 보존.
- 작업 검증: 자동 프로필/변경 요약 생성, 동시 요청 중복 방지, 중복 전달, 오래된 워커 결과 차단, Redis 장애 후 재전송, 임대 만료 복구/최대 시도, 늦은 이전 버전 처리, AI 미설정에도 diff/READY 유지와 재시도. **실제 Redis를 통한 Celery 분석 작업 3개 완료**를 별도 테스트했다.
- migration 전체 upgrade/downgrade 및 ORM 일치 검사 통과.
- **브라우저 66개 통과**: Phase 6 분석·기존 버전 관리 18개, 문서/캔버스 38개, 텍스트/도형 편집 10개. 데스크톱과 모바일 Chrome으로 변경 강조·근거 이동·미설정/부분 결과 안내·실패 후 재요청·후보 수동 연결·VIEWER 제한 및 기존 화면을 확인했다.
- ESLint, TypeScript, Next.js production build 통과.
- 기존 Starlette/AnyIO deprecation warning 1건이 있다. 테스트 실패는 없다.

브라우저의 실패→재시도 검사 fixture가 처음에는 한 응답만 실패시켜 개발 모드의 중복 요청에 먼저 소진되는 문제가 있었다. 복구 시점까지 실패를 유지하도록 fixture를 수정한 후 데스크톱/모바일 모두 통과했다.

## 개발 환경

- `0007_version_intelligence (head)` 적용, `alembic check`에서 변경 없음.
- backend/worker/dispatcher를 새 Compose 환경으로 재생성했다. 기존 PostgreSQL/Redis와 파일은 유지했다.
- Celery ping `pong`, 1 node online.
- API `/health` 200, 프런트엔드 `/login` 200.
- 실제 개발 DB에서 기존 READY 문서의 분석 작업 **5개 COMPLETED** 확인. 이는 키 없이 가능한 텍스트 프로필·결정적 분석과 AI 미설정 경고 저장의 완료다. 외부 AI 호출 성공을 뜻하지 않는다.
- 개발 환경의 요약 모델 `gpt-5.6-luna`, 임베딩 모델 `text-embedding-3-small`, AI 키 미설정 확인. 키나 환경 파일 내용을 출력하지 않았다.

## 검증 한계

Mindlogic의 공개 공식 문서에서 Chat Completions·Embeddings 계약을 확인했고 제공자 응답 fixture로 성공/실패·출력 검증을 시험했다. 실제 키가 없어 **실제 Gateway 응답, 계정의 모델 접근 권한, 의미 유사도 품질 및 AI 요약 품질은 검증하지 않았다**. 키 설정 후 화면에서 미설정 분석을 다시 요청해야 한다. 설정과 제한은 [사용 가이드](phase-6-intelligence.md)에 있다.

브라우저 검사는 테스트 전용 인증/API/S3 응답을 사용한다. 백엔드 S3 통합은 Moto HTTP 서버다. 실제 Google OAuth와 실 AWS 파일 업로드 전체 흐름은 이번 단계에서 다시 실행하지 않았다. 런타임 인증 우회는 추가하지 않았다.

## 재현

```bash
docker compose --env-file .env.development -f docker-compose.yml -f docker-compose.test.yml --profile test run --build --rm backend-test
cd frontend
npm run test:intelligence
npm run test:phase4
npm run test:elements
npm run lint
npm run build
npm run typecheck
```

이번 실행에서는 동일 의존성의 기존 backend-test 이미지에 최신 backend 소스를 bind mount했다. 위 `--build`는 새 환경용 재현 명령이다.

## 테스트 화면

모든 화면 데이터와 AI 문구는 검증용 fixture다.

- [데스크톱 AI 요약](images/phase-6-summary-desktop.png)
- [모바일 AI 요약](images/phase-6-summary-mobile.png)
- [데스크톱 변경 근거](images/phase-6-diff-desktop.png)
- [모바일 변경 근거](images/phase-6-diff-mobile.png)
- [데스크톱 후보](images/phase-6-candidates-desktop.png)
- [모바일 후보](images/phase-6-candidates-mobile.png)
