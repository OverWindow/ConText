# ConText 소개 페이지

`/`은 로그인 여부와 관계없이 열리는 공개 소개 페이지다. [제품 방향](product-direction.md)에 따라 **내 PC에서 시작하는 AI 문서 작업 공간**을 소개한다. 첫 화면의 대표 문구는 **“내 문서와 AI가 함께 일하는 공간.”**이며, 평소 쓰던 폴더의 자료 탐색·AI 질문·문서 작성과 편집을 이어가는 로컬 문서 환경을 강조한다. 경희대 ChatKHU는 AI 연결 기반으로, 설치·폴더 선택은 손쉬운 시작 경험으로 설명한다. 문서 작업 예시 → ChatKHU 활용 3단계 → 핵심 기능 → 데스크톱·웹 시작 방법 → FAQ 순서로 구성한다. 기존 브랜드 이미지와 색상 토큰을 사용하고 모바일에서도 같은 선택 경로를 제공한다.

첫 화면은 내 자료 → AI 질문 → 문서 작성·수정의 흐름과 회의록 정리·문장 다듬기·체크리스트 만들기의 세 가지 예시를 제공한다. 수정안의 전후 비교와 적용 결과 예시를 전환할 수 있다. **채팅에서 원본에 적용하는 개발 방향을 보여주는 예시**로 표시하며 실제 AI 호출·사용자 파일 읽기·수정은 하지 않는다. 현재 가능한 TXT·Markdown 원본 편집, 다른 형식의 초안·내보내기, 외부 AI 연결 범위는 기능 설명과 FAQ에 구분해 둔다.

CapCut 소스도 같은 대표 문구와 자료 탐색 → AI 질문 → 초안 작성·수정의 흐름으로 구성한다. [편집 구성안](../artifacts/context-capcut-local-chatbot-2026-10-28/CapCut-구성안.md)에 카드·라벨의 용도, 내레이션, 현재 기능의 시연 범위를 정리했다. 기존 CapCut 프로젝트의 이미지 연결을 유지하기 위해 소스 폴더와 PNG 파일명은 보존한다.

- **웹에서 시작하기** → `/workspaces`. 로그인하지 않았다면 기존 인증 흐름이 `/login`으로 이동시킨다. 이미 로그인했다면 워크스페이스로 들어간다.
- **데스크톱 다운로드** → 같은 페이지의 시작 방법 영역. macOS Apple Silicon·Windows 설치 파일 링크가 없으면 `배포 준비 중`으로 표시한다.
- **로그인** → 기존 `/login`. 보호된 워크스페이스의 인증 요구는 유지한다.

데스크톱 다운로드를 주 행동으로, 웹 시작을 보조 경로로 둔다. 데스크톱의 기본 파일 작업은 로그인 없이 사용할 수 있다. AI 답변은 인터넷과 AI 연결이 필요하고 필요한 발췌문이 외부 서비스로 전송된다. 클라우드 파일 동기화는 사용자가 선택해 시작한다. 이번 변경은 소개 화면과 제품 방향 문서에 한정되며 데스크톱·인증·동기화 동작은 변경하지 않는다.

기존 `design/ConText-landing-*.png`는 개편 전 캔버스 중심 화면의 기록이다. 개편 후 화면은 `frontend/tests/auth.spec.ts`에서 데스크톱·모바일로 검증하고 `/tmp/context-landing-*.png`에 저장한다.

## 다운로드 배포 연결

공개 설치 파일을 준비한 뒤 루트 환경 파일에 HTTPS URL을 설정한다. 현재 값은 비워 두는 것이 정상이다.

```dotenv
DESKTOP_MAC_DOWNLOAD_URL=https://downloads.example.com/ConText-arm64.dmg
DESKTOP_WINDOWS_DOWNLOAD_URL=https://downloads.example.com/ConText-Setup.exe
```

개발 Compose와 프론트 전용 운영 Compose 모두 프론트 서버에 이 변수를 전달한다. 공개 첫 페이지는 요청 시 렌더링하므로 이미지 재빌드 없이 프론트 컨테이너를 재생성하면 링크가 반영된다. 서버에서 HTTPS URL만 다운로드 링크로 사용하며, 비어 있거나 잘못된 값은 준비 중으로 표시한다. 실제 파일의 업로드·서명·공증·대상 OS 설치 검증은 별도 배포 작업이다.

```bash
# 개발 환경
docker compose --env-file .env.development up -d --no-deps --force-recreate frontend

# 프론트 운영 이미지 로컬 검증: URL만 변경할 때
docker compose --env-file .env.frontend.production -f docker-compose.frontend.prod.yml up -d --no-deps --force-recreate frontend
```

소개 페이지의 스크롤은 페이지 컨테이너 안에서 처리한다. 기존 캔버스 앱의 전역 스크롤 설정은 변경하지 않는다.

Vercel 운영 배포에서는 해당 Environment Variables를 설정한 뒤 재배포한다. 플랫폼 설정은 [운영 배포 가이드](production-deployment.md)를 참고한다.
