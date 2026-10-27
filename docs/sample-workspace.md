# 기본 하루랩 샘플 워크스페이스 — 2026-10-27

웹과 데스크톱의 ‘나의 워크스페이스’에 **하루랩 스타트업** 기본 샘플 카드를 추가했다. 웹 소개·로그인 화면에서도 공개 `/preview`로 들어갈 수 있다. 기존 계정과 개인 작업 공간을 유지하며, 앱 시작 시 마지막 개인 작업 공간 복원도 유지한다. 샘플을 강제로 사용자 DB에 생성하지 않는다.

## 동작

두 앱은 `@context/workspace-ui/sample-workspace`의 같은 캔버스·폴더·검색·파일 카드·읽기 전용 미리보기를 사용한다. 제품 요구사항을 먼저 보여 주고 API·데이터사전·출시 점검표의 참조 연결과 안내 메모를 함께 배치한다. 파일은 두 번 클릭하거나 문서 관리 목록에서 열 수 있다.

샘플은 읽기 전용이다. 복사·변환·AI 요청·동기화·삭제·새 파일 만들기를 제공하지 않으며, 실제 자료로 작업하려면 ‘내 워크스페이스로’ 이동한다. 개인 폴더 연결이나 계정 등록 없이 열리며 샘플 원본을 개인 DB/S3에 업로드하지 않는다. 가상 회사·고객·수치임을 안내한다.

현재 `test-data/하루랩_스타트업_샘플`의 숨김 파일 제외 **40개**를 포함한다. PDF/DOCX/HWPX/Markdown/TXT는 기존 Python 파서로 추출한 본문, PNG/SVG는 내장 이미지, CSV/XLSX는 표, JSON/EML은 정적 본문을 제공한다. PDF 등의 원래 인쇄 레이아웃 대신 본문을 보여 주며, AI·변환 기능을 실행하는 프리뷰는 아니다. 정답 JSON·테스트 안내·상위 ZIP·숨김 자료는 포함하지 않는다.

이미지와 추출 본문을 `packages/workspace-ui/assets/harulab-sample.ts`에 미리 생성해 앱과 함께 배포한다. 공개 API·S3·Python 처리 서버 없이 프리뷰를 읽을 수 있다. 웹은 별도 공개 페이지로 분리하고 데스크톱은 필요할 때 모듈을 불러온다.

## 샘플 갱신

백엔드 Python 의존성이 있는 환경에서 저장소 루트 기준으로 실행한다.

```sh
PYTHONPATH=backend python scripts/build-sample-workspace.py --source test-data/하루랩_스타트업_샘플 --output packages/workspace-ui/assets/harulab-sample.ts
node --experimental-strip-types --test packages/workspace-ui/tests/sample-data.test.mjs
```

일반 앱 빌드와 사용 시에는 Python이나 Docker가 필요하지 않다. 데이터 검사는 내장 자료의 경로·파일 수·SHA-256과 원본 이미지 바이트를 현재 샘플 폴더와 대조한다. 자료를 갱신한 뒤 앱을 다시 빌드·패키징한다.

## 검증과 결과물

- 최종 패키지 Electron UI **22개 통과**: 기존 계정·파일·변환·캔버스·작성·동기화 안내 회귀와 기본 샘플 열기, 개인 작업 공간·원본 보존 포함.
- 웹 PC·모바일 UI **22개 통과**: 무계정 공개 진입, API 요청 없이 자료 열람, 문서·이미지·HWPX·표·빈 파일, 검색, 읽기 전용, 홈 복귀와 실제 작업 공간 선택 포함. 기존 25,001개 파일 탐색·동기화 복구도 통과했다.
- 내장 자료 경로·SHA-256·이미지 원본 바이트 검사 **1개 통과**. 웹 프로덕션 빌드에서 `/preview` 정적 페이지 생성, TypeScript·ESLint·공통 패키지 경계·diff 공백 검사 통과.
- 현재 소스 **156개**, ASAR 실행 파일 **42개**, 동봉 파서 **301개**와 ZIP 속 앱의 일치 및 CRC 검사 통과. 로컬 개발 웹 `http://localhost:3000/preview`도 HTTP 200과 샘플 본문을 확인했다. 운영 웹에 게시하지 않았다.

초기 검사는 샘플 검색 모드의 viewport 전환과 모바일 계정 링크 배치를 보완했다. 전체 검사에서 대용량 fixture가 동시 빌드·여러 브라우저 실행 중 45초 한도를 초과해, 브라우저 동시 실행을 2개로 고정하고 해당 대용량 검사만 90초를 허용했다. 최종 전체 22개는 모두 통과했다. 초기 실패·최종 성공 로그를 함께 보관한다.

- 앱: `apps/desktop/release/mac-arm64/ConText Desktop.app`
- ZIP: `apps/desktop/release/ConText-Desktop-unified-mac-arm64.zip`
- 빌드 명세: `apps/desktop/release/unified-build.json`
- 변경 전 코드와 이전 ZIP, 검증 로그: `.backups/sample-workspace-2026-10-27/`

[데스크톱 홈](images/sample-home-desktop.png) · [웹 홈](images/sample-home-web.png) · [데스크톱 프리뷰](images/sample-workspace-desktop.png) · [웹 프리뷰](images/sample-workspace-web.png) · [모바일 프리뷰](images/sample-workspace-web-mobile.png)

ASAR SHA-256: `586b4892739621394fa2cb04885b064156824ee559cc46725bf4dcc37c96855c`

ZIP SHA-256: `10fd68d29ba0af99ed23db599aad4aec54d0659d8b406be22a3618cd7e7a912d`
