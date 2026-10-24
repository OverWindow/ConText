# ConText 소개 페이지

`/`은 로그인 여부와 관계없이 열리는 공개 소개 페이지다. 서비스 소개 → 핵심 기능 → 웹·데스크톱 시작 방법 → 자주 묻는 질문으로 구성했다. 소개와 기능·플랫폼별 설명은 한두 문장으로 제공하고, FAQ는 기존 세 가지 질문과 답변을 유지한다. 반복되는 보조 문구·영문 소제목·하단의 중복 시작 영역은 사용하지 않는다. 기존 브랜드 이미지와 색상 토큰을 사용하고 모바일에서도 같은 선택 경로를 제공한다. 캔버스 미리보기는 설명용 예시이며 실제 사용자 자료를 읽지 않는다.

- **웹에서 시작하기** → `/workspaces`. 로그인하지 않았다면 기존 인증 흐름이 `/login`으로 이동시킨다. 이미 로그인했다면 워크스페이스로 들어간다.
- **데스크톱 다운로드** → 같은 페이지의 시작 방법 영역. macOS Apple Silicon·Windows 설치 파일 링크가 없으면 `배포 준비 중`으로 표시한다.
- **로그인** → 기존 `/login`. 보호된 워크스페이스의 인증 요구는 유지한다.

현재 데스크톱은 로그인 없이 로컬 폴더를 탐색하는 앱이다. 페이지에는 `계정 연동 · 기기 간 동기화 준비 중` 한 줄만 표시한다. 데스크톱 인증·동기화 구현은 포함되지 않는다.

화면 확인: [데스크톱 첫 화면](../design/ConText-landing-desktop.png), [시작 방법 선택](../design/ConText-landing-downloads-desktop.png), [모바일 첫 화면](../design/ConText-landing-mobile.png).

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
