# 운영 배포 설정 준비 기록 — 2026-10-27

현재 통합 아키텍처에 맞춰 Vercel 웹과 Railway Node/Python 서비스의 배포 설정을 준비했다. 실제 서비스 생성·운영 DB 배포·실제 AWS 쓰기는 수행하지 않았다. 사용자는 운영 API 도메인이 아직 없다고 확인했다.

## 반영 내용

- 운영 Compose에 Node 동기화 서버를 추가하고 Python의 구 workspace API를 차단했다. 두 서버의 private token, desktop discovery URL, DB/S3/CORS 설정을 연결했다. Node가 처리하는 큐에 맞춰 예전 Celery worker/dispatcher를 운영 기본 구성에서 제외했다.
- Node는 플랫폼 PORT를 우선하고 일반 사용자로 실행한다. 운영 모드에서 필수 설정 누락·짧은 내부 토큰·잘못된 origin·fixture 모드를 거절한다. 개발 Compose는 development stage를 명시해 개발의 설정 방식을 유지한다.
- 공개 `/ready`는 PostgreSQL·S3 HeadBucket·인증된 Python private health를 확인한다. 동시 검사를 공유하고 결과는 10초간 캐시하며, 각 검사는 최대 6초 후 실패로 판정한다. 오류 응답에 내부 주소·비밀값을 노출하지 않는다. 처리 루프의 예기치 않은 실패는 비밀값 없이 기록한다.
- Vercel과 운영 웹 이미지 빌드는 누락된 동기화 서버 주소·localhost·잘못된 공개 키를 거절한다. S3 운영 CORS 예시에 새 blob-id 업로드 헤더를 포함했다.
- init/check/smoke 명령을 제공한다. init은 없는 환경 파일만 만들고 키를 교체하지 않는다. check는 웹·Python·Node 설정의 일치를 확인한다. smoke는 읽기 전용으로 실제 배포의 일곱 경로를 확인한다.
- `.env.backend.production`을 0600으로 생성해 새 내부 토큰·Fernet key·독립 DB 비밀번호를 보관했다. 기존 frontend 파일의 값은 보존하고 새 동기화 URL 항목을 추가했다. 비밀값은 기록하거나 출력하지 않았다.

## 검증

- Node 서버 회귀 **14개 통과**, skip 없음. 실제 PostgreSQL, Moto S3 HTTP, 실제 Python 분석·변환·export, 준비 상태 확인, 멈춘 의존성 타임아웃 포함.
- Python private readiness와 구 API 차단 회귀 **6개 통과**, Ruff 통과.
- 배포 환경/실패 빌드/읽기 전용 smoke CLI **3개 통과**. 의존성 준비 실패 시 CLI가 0으로 종료하지 않음을 확인했다.
- Node·Python·Next production 이미지 **3개 빌드 성공**. 이미지 기동 검사는 서로 다른 PORT, 비root UID(1000/10001/1000), 실제 Python/Node 마이그레이션, desktop discovery, 구 API 410, 새 API 401, CORS, 웹 로그인 200, 필수 설정 누락 시 기동 실패를 확인했다. 별도 `_test` DB와 합성 설정을 사용했으며 종료 시 DB와 검사 컨테이너를 정리했다.
- 운영 Compose 두 파일의 문법/필수값 검사, 완전한 합성 환경 사전 검사, 웹 ESLint/TypeScript, 서버 TypeScript, 패키지 경계·worker 계약 drift·diff 공백 검사 통과.
- 기존 desktop ASAR/ZIP 및 현재 공통 UI 소스 일치 재검사 통과. 데스크톱 소스와 배포 파일은 변경하지 않았다. macOS 서명·공증 상태도 기존과 같다.

S3는 테스트 저장소, AI는 합성 provider를 사용했다. 실제 AWS 권한·CORS·Supabase 로그인·유료 모델·별도 물리 기기의 최종 왕복 검사는 운영 환경 생성 후 필요하다. 운영 DB 백업/PITR·복원 리허설·지속 감시 알림은 계정에서 활성화할 항목이며 코드 수정만으로 활성화되지 않는다.

## 남은 운영 입력

- Python 공개 HTTPS origin과 Node 공개 HTTPS origin.
- 운영 PostgreSQL 연결 URL과 Redis private URL.
- 실제 비공개 S3 bucket·server credentials 또는 명시적 역할 공급자.
- 배포 플랫폼에 환경 변수 전달, Supabase callback·S3 CORS·모니터와 백업 설정.

실제 환경 사전 검사는 누락된 주소/DB/S3 항목으로 의도대로 실패한다. 이를 배포 성공으로 기록하지 않았다. [배포 순서와 변수](production-deployment.md)를 따라 값을 입력한 뒤 `node scripts/deploy/check.mjs`, 배포 후 `node scripts/deploy/smoke.mjs`를 실행한다.

변경 전 코드·기존 frontend 환경 파일·검증 로그는 `.backups/production-ready-2026-10-27/`에 비공개로 보관한다.
