# Electron macOS 앱 웹 배포: 서명·공증·DMG 제작

작성일: 2026-10-28

ConText Desktop을 Mac App Store가 아닌 웹사이트에서 다운로드할 수 있도록 배포하는 절차입니다. 현재 프로젝트의 `electron-builder 26.15.3`을 기준으로 합니다.

이 문서는 작업 안내입니다. 문서를 작성하면서 프로젝트의 빌드 설정을 변경하거나, 인증서를 발급하거나, 공증·업로드를 실행하지는 않았습니다.

## 전체 순서

1. Apple Developer Program 가입
2. Team ID 확인
3. Mac에 서명·공증 도구 설치
4. 인증서 발급 요청 파일(CSR) 생성
5. Developer ID Application 인증서 발급·설치
6. 공증용 앱 암호 생성
7. 공증 인증 정보를 키체인에 저장
8. Electron 프로젝트 배포 설정 변경
9. 공증 프로필 지정 및 DMG 빌드
10. 서명·공증 및 앱 기능 검증
11. 웹사이트에 다운로드 연결

1~7단계는 최초 준비 작업입니다. 인증서·계정·빌드 Mac이 바뀌면 해당 단계를 다시 진행해야 합니다. 이후 버전 배포는 버전을 올리고 9~11단계를 반복합니다.

## 1. Apple Developer Program 가입

접속: [Apple Developer Program 가입](https://developer.apple.com/programs/enroll/)

1. 가입 시작 버튼을 누르고 Apple 계정으로 로그인합니다.
2. Apple 계정에 이중 인증을 설정합니다.
3. 가입 유형을 선택합니다.
   - 개인 명의 배포: **Individual**
   - 법인 명의 배포: **Organization**
4. 신원·주소·연락처 등 요구하는 정보를 입력합니다.
5. 약관에 동의하고 멤버십을 결제합니다.
6. 가입 승인이 완료되면 [Apple Developer 계정](https://developer.apple.com/account/)의 **Membership details**에서 활성 상태를 확인합니다.

연회비는 미화 99달러 기준이며, 실제 결제 금액은 지역별로 표시됩니다. 법인 가입에는 D-U-N-S 번호 등 추가 정보가 필요합니다.

완료 기준: 멤버십이 활성화되어 있고 **Certificates, Identifiers & Profiles**에 접근할 수 있습니다.

참고: [Apple 가입 안내](https://developer.apple.com/help/account/membership/program-enrollment/)

## 2. Team ID 확인

접속: [Apple Developer 계정](https://developer.apple.com/account/)

1. 로그인합니다.
2. 여러 팀이 있으면 배포할 팀을 선택합니다.
3. **Membership details**를 엽니다.
4. **Team ID**를 복사해 둡니다.

Team ID는 다음과 같은 10자리 문자열입니다.

```text
ABCDE12345
```

앱 이름이나 Bundle ID인 `ai.context.desktop`과는 다른 값입니다. 뒤에서 공증 인증 정보를 저장할 때 사용합니다.

참고: [Apple Team ID 안내](https://developer.apple.com/help/glossary/team-id/)

## 3. Mac에 서명·공증 도구 설치

빌드를 진행할 Mac에서 **터미널**을 열고 실행합니다.

```bash
xcode-select --install
```

설치 창이 뜨면 설치를 진행합니다. 이미 설치되어 있다는 메시지가 나오면 다음 확인 명령으로 넘어갑니다.

```bash
xcrun --find notarytool
xcrun --find stapler
```

두 명령 모두 실행 파일 경로가 나오면 됩니다.

- `notarytool`: Apple에 공증을 요청합니다.
- `stapler`: 공증 결과인 티켓을 앱 등에 첨부합니다.

Xcode가 이미 설치되어 있어도 도구를 사용할 수 있습니다.

완료 기준: 두 명령 모두 `unable to find` 오류 없이 경로를 출력합니다.

참고: [Apple 공증 도구 안내](https://developer.apple.com/documentation/technotes/tn3147-migrating-to-the-latest-notarization-tool?changes=_4_4)

## 4. 인증서 발급 요청 파일(CSR) 생성

이 단계는 웹사이트가 아니라 **빌드할 Mac의 키체인 접근 앱**에서 진행합니다.

1. `⌘ + Space`를 누릅니다.
2. **키체인 접근** 또는 **Keychain Access**를 검색해 실행합니다.
3. 화면 위쪽 메뉴에서 다음을 선택합니다.

   **Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority…**

   한국어 메뉴에서는 **키체인 접근 → 인증서 지원 → 인증 기관에서 인증서 요청…**에 해당합니다. OS 언어·버전에 따라 표기가 조금 다를 수 있습니다.

4. 입력창을 다음처럼 채웁니다.

| 항목 | 입력 내용 |
| --- | --- |
| User Email Address | Apple 개발자 계정 이메일 |
| Common Name | 알아보기 쉬운 키 이름. 예: `ConText Release Key` |
| CA Email Address | 비워두기 |
| Request is | **Saved to disk / 디스크에 저장됨** 선택 |

5. **Continue / 계속**을 누릅니다.
6. 바탕화면 등 찾기 쉬운 위치에 저장합니다.

생성되는 파일의 확장자는 `.certSigningRequest`입니다.

```text
CertificateSigningRequest.certSigningRequest
```

이 과정에서 서명에 필요한 개인 키는 Mac의 키체인에 생성됩니다. 다음 단계의 인증서도 이 Mac에 설치합니다.

완료 기준: `.certSigningRequest` 파일이 생성됩니다.

참고: [Apple CSR 생성 안내](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request)

## 5. Developer ID Application 인증서 발급·설치

접속: [Apple 인증서 관리](https://developer.apple.com/account/resources/certificates/list)

1. 개발자 프로그램에 가입한 Apple 계정으로 로그인합니다.
2. 여러 팀이 있으면 배포할 팀을 선택합니다.
3. 왼쪽 **Certificates**를 선택합니다.
4. 위쪽 **+ 버튼**을 누릅니다.
5. **Developer ID** 항목으로 진행해 **Developer ID Application**을 선택합니다.
6. **Continue**를 누릅니다.
7. CSR 업로드 화면에서 **Choose File**을 누릅니다.
8. 4단계에서 만든 `.certSigningRequest` 파일을 선택합니다.
9. **Continue → Download**를 누릅니다.
10. 다운로드한 `.cer` 파일을 더블클릭해 키체인에 설치합니다.

웹에서 다운로드하는 앱과 DMG에는 **Developer ID Application** 인증서를 사용합니다. `Developer ID Installer`는 PKG 설치 패키지용입니다.

인증서 생성에는 **Account Holder** 권한이 필요합니다. 개인으로 직접 가입했다면 본인이 Account Holder입니다.

설치 후 키체인 접근의 **로그인 → 나의 인증서**에서 다음 형태의 항목을 확인합니다.

```text
Developer ID Application: 본인 이름 또는 회사 이름 (ABCDE12345)
```

인증서 옆의 펼치기 화살표를 눌렀을 때 **개인 키가 함께 보여야** 합니다.

터미널에서도 확인합니다.

```bash
security find-identity -v -p codesigning
```

출력 예시:

```text
1) ABCDEF... "Developer ID Application: Your Name (ABCDE12345)"
   1 valid identities found
```

완료 기준: `Developer ID Application` 인증서가 유효한 서명 항목으로 출력됩니다. `0 valid identities found`라면 인증서와 개인 키가 같은 키체인에 있는지 먼저 확인합니다.

참고: [Apple Developer ID 인증서 안내](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)

## 6. 공증용 앱 암호 생성

접속: [Apple 계정 관리](https://account.apple.com/)

1. 개발자 프로그램에 가입한 Apple 계정으로 로그인합니다.
2. **Sign-In and Security / 로그인 및 보안**을 선택합니다.
3. **App-Specific Passwords / 앱 암호**를 선택합니다.
4. **Generate an app-specific password / 앱 암호 생성**을 누릅니다.
5. 이름을 `ConText Notarization` 등으로 입력합니다.
6. 본인 확인을 완료합니다.
7. 생성된 앱 암호를 복사해 둡니다.

앱 암호를 사용하려면 Apple 계정의 이중 인증이 켜져 있어야 합니다. 생성된 암호는 다음 단계의 터미널 프롬프트에 입력하며, 프로젝트 파일이나 Git 저장소에 기록하지 않습니다.

참고: [Apple 앱 암호 안내](https://support.apple.com/en-us/102654)

## 7. 공증 인증 정보를 키체인에 저장

터미널에서 실행합니다. 이메일과 Team ID를 본인 값으로 교체합니다.

```bash
xcrun notarytool store-credentials "context-notary" \
  --apple-id "본인 Apple 계정 이메일" \
  --team-id "본인 TEAM ID"
```

입력 예시:

```bash
xcrun notarytool store-credentials "context-notary" \
  --apple-id "dev@example.com" \
  --team-id "ABCDE12345"
```

앱 암호를 요청하면 **6단계에서 생성한 앱 암호**를 붙여넣고 Enter를 누릅니다. 입력 중 문자가 표시되지 않을 수 있습니다.

정상 결과 예시:

```text
Success. Credentials validated.
Credentials saved to Keychain.
```

`context-notary`는 저장된 공증 인증 정보의 프로필 이름입니다. 인증서 이름이나 Team ID와는 별개입니다.

참고: [Apple 키체인 저장 안내](https://developer.apple.com/documentation/technotes/tn3147-migrating-to-the-latest-notarization-tool?changes=_4_4)

## 8. Electron 프로젝트 배포 설정 변경

수정 파일: `apps/desktop/package.json`

기존 `"build": { ... }` 전체를 다음 내용으로 교체합니다. `scripts`, `dependencies` 등 나머지 항목은 유지합니다.

```json
"build": {
  "appId": "ai.context.desktop",
  "productName": "ConText Desktop",
  "forceCodeSigning": true,
  "directories": {
    "output": "release"
  },
  "extraResources": [
    {
      "from": "processor/dist/context-processor",
      "to": "context-processor"
    }
  ],
  "files": [
    "dist/**",
    "core/**",
    "electron/**",
    "package.json"
  ],
  "mac": {
    "category": "public.app-category.productivity",
    "target": ["dmg"],
    "hardenedRuntime": true,
    "notarize": true,
    "icon": "../../packages/workspace-ui/assets/context-symbol.png"
  },
  "dmg": {
    "sign": true
  },
  "win": {
    "target": ["nsis"],
    "icon": "../../packages/workspace-ui/assets/context-symbol.png"
  },
  "nsis": {
    "oneClick": false,
    "allowToChangeInstallationDirectory": true
  }
}
```

위 코드는 `package.json` 안에 들어가는 속성으로, 독립된 JSON 파일이 아닙니다. 앞뒤 속성과 연결하는 쉼표를 유지하세요.

| 설정 | 역할 |
| --- | --- |
| 기존 `"identity": null` 삭제 | 키체인에서 Developer ID 인증서를 자동 탐색해 서명하도록 허용 |
| `"forceCodeSigning": true` | 유효한 서명을 붙일 수 없으면 빌드 실패 |
| `"hardenedRuntime": true` | 공증에 필요한 실행 보안 설정 적용 |
| `"notarize": true` | 앱 공증 활성화 |
| `"dmg": { "sign": true }` | DMG 파일 자체에도 서명 |

설정 시 다음을 확인합니다.

- 현재 v26.15.3에서는 `identity`에 `Developer ID Application:` 접두사를 포함한 문자열을 지정하면 거부됩니다. 이 예시에서는 `identity`를 생략해 자동 탐색을 사용합니다.
- Developer ID 인증서가 여러 개라면 빌드 로그에서 대상 팀의 인증서가 선택됐는지 확인합니다.
- 설치된 v26.15.3은 기본 Electron entitlements 파일을 제공합니다. 처음에는 별도 파일을 지정하지 않고 이 설정으로 시작합니다.
- v27에서는 서명 설정 구조가 달라집니다. 버전을 올릴 때는 해당 버전의 마이그레이션 안내를 확인합니다.

참고: [v26 mac 설정](https://www.electron.build/v26/docs/mac/), [DMG 설정](https://www.electron.build/v26/docs/dmg/)

## 9. 공증 프로필 지정 및 DMG 빌드

터미널에서 프로젝트 폴더로 이동합니다.

```bash
cd "/Users/hyunjinkim/Projects/Docs"
```

저장한 공증 인증 정보를 사용하도록 지정합니다. 이 `export`는 빌드를 실행할 같은 터미널에서 실행합니다.

```bash
export APPLE_KEYCHAIN_PROFILE="context-notary"
```

인증을 확인합니다.

```bash
xcrun notarytool history \
  --keychain-profile "context-notary"
```

처음 사용하면 제출 내역이 비어 있어도 정상입니다. 인증 오류가 없는지 확인합니다.

이어서 배포 빌드를 실행합니다.

```bash
npm --prefix apps/desktop run dist:mac
```

현재 스크립트는 문서 처리 프로그램 준비 상태를 확인하고, 앱을 빌드한 다음 electron-builder를 실행합니다. 서명·공증 설정과 인증 정보가 준비되어 있으면 다음을 처리합니다.

1. 앱과 내부 실행 파일 서명
2. Apple에 앱 공증 요청
3. 앱에 공증 티켓 첨부
4. DMG 생성 및 서명

**로그에 `notarization successful`이 출력되는지 확인합니다.** 현재 버전은 인증 정보가 없으면 공증을 건너뛸 수 있습니다. DMG가 만들어졌다는 것만으로 공증 성공을 판단하면 안 됩니다.

이 절차에서 electron-builder는 **DMG 내부의 앱을 공증하고 앱에 티켓을 첨부**합니다. `dmg.sign`은 DMG 파일 자체에 서명하는 설정입니다. DMG 자체를 별도로 공증하고 티켓을 첨부하는 절차와는 구분합니다.

### 문서 처리 프로그램이 준비되지 않은 경우

먼저 실행한 뒤 `dist:mac`을 다시 실행합니다.

```bash
npm --prefix apps/desktop run processor:build
```

Python 환경도 없다면 Python 3.12를 준비한 뒤 다음 순서로 실행합니다.

```bash
python3.12 -m venv apps/desktop/processor/.venv

apps/desktop/processor/.venv/bin/python -m pip install \
  -r apps/desktop/processor/requirements.lock

npm --prefix apps/desktop run processor:build

npm --prefix apps/desktop run dist:mac
```

새 환경의 의존성 설치 절차는 [데스크톱 실행 안내](/Users/hyunjinkim/Projects/Docs/apps/desktop/README.md)도 확인합니다.

참고: [v26 공증 설정](https://www.electron.build/v26/docs/notarization/)

## 10. 서명·공증 및 앱 기능 검증

출력 폴더를 엽니다.

```bash
open "/Users/hyunjinkim/Projects/Docs/apps/desktop/release"
```

아래는 현재 프로젝트의 **Apple Silicon 빌드 경로**를 사용한 예시입니다. Intel 빌드 등 출력 경로가 다르면 실제 경로로 바꿉니다.

### 앱 서명 확인

```bash
codesign --verify --deep --strict --verbose=2 \
  "/Users/hyunjinkim/Projects/Docs/apps/desktop/release/mac-arm64/ConText Desktop.app"
```

서명 검증 오류가 없는지 확인합니다. 여기서 `--deep`은 검증용입니다.

### 앱에 첨부된 공증 티켓 확인

```bash
xcrun stapler validate \
  "/Users/hyunjinkim/Projects/Docs/apps/desktop/release/mac-arm64/ConText Desktop.app"
```

기대하는 결과:

```text
The validate action worked!
```

### Gatekeeper 평가 확인

```bash
spctl --assess --type exec --verbose=2 \
  "/Users/hyunjinkim/Projects/Docs/apps/desktop/release/mac-arm64/ConText Desktop.app"
```

기대하는 결과:

```text
accepted
source=Notarized Developer ID
```

### 공증 실패 시 상세 로그 확인

빌드 로그에 제출 ID가 있다면 다음 명령으로 Apple의 상세 로그를 가져옵니다. `SUBMISSION_ID`를 실제 값으로 교체합니다.

```bash
xcrun notarytool log "SUBMISSION_ID" \
  --keychain-profile "context-notary" \
  "/tmp/context-notarization-log.json"
```

로그의 `issues`에 기록된 파일과 원인을 확인해 수정한 뒤, 서명·공증을 포함한 빌드를 다시 실행합니다.

### 실제 앱 기능 확인

이 앱에는 Python 문서 처리 프로그램이 포함되므로, 실행 확인 외에 다음 기능을 확인합니다.

- 폴더 연결과 파일 목록 표시
- PDF·DOCX·HWPX 읽기
- 문서 편집과 각 형식으로 내보내기
- 사용하는 경우 로그인 및 클라우드 동기화

서명·공증 후 앱 내부 파일을 수동으로 바꾸지 않습니다. 수정이 필요하면 다시 빌드합니다.

참고: [electron-builder 공증 검증](https://www.electron.build/v26/docs/notarization/), [Apple 공증 워크플로](https://developer.apple.com/documentation/Security/customizing-the-notarization-workflow)

## 11. 웹사이트에 다운로드 연결

1. `apps/desktop/release`에 생성된 최종 `.dmg`를 선택합니다.
2. HTTPS로 다운로드할 수 있는 파일 저장소·CDN·GitHub Releases 등에 업로드합니다.
3. 웹사이트의 다운로드 버튼을 해당 DMG 주소에 연결합니다.
4. 다른 Mac에서 브라우저로 다운로드하고 설치·최초 실행까지 확인합니다.

다운로드 버튼 예시입니다. 주소는 실제 배포 주소로 교체합니다.

```html
<a href="https://downloads.example.com/ConText-0.1.0-arm64.dmg">
  macOS용 다운로드 · Apple Silicon
</a>
```

현재 빌드가 Apple Silicon용이면 버튼에도 이를 표시합니다. Intel도 지원하려면 Electron뿐 아니라 포함된 문서 처리 프로그램도 해당 아키텍처용으로 준비하고 검증합니다.

사용자의 설치 순서는 다음과 같습니다.

1. 웹사이트에서 DMG 다운로드
2. DMG 열기
3. 앱을 Applications 폴더로 드래그
4. Applications에서 앱 실행

개발 Mac 외에, 가능하면 앱을 처음 사용하는 다른 Mac에서 공개할 DMG를 브라우저로 다운로드해 확인합니다.

참고: [Apple 배포 패키징 및 테스트 안내](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution?changes=_7)

## 릴리스 체크리스트

- [ ] Apple Developer Program 멤버십 활성 상태 확인
- [ ] 빌드 Mac에 Developer ID Application 인증서와 개인 키 존재
- [ ] 공증용 키체인 프로필 `context-notary`로 인증 가능
- [ ] `identity: null` 삭제 및 배포 설정 적용
- [ ] `apps/desktop/package.json`의 버전을 이번 릴리스에 맞춰 변경
- [ ] 대상 OS·아키텍처에 맞는 문서 처리 프로그램 준비
- [ ] 빌드 로그에서 `notarization successful` 확인
- [ ] 앱 서명 검증 성공
- [ ] `stapler validate` 성공
- [ ] Gatekeeper 평가 `accepted` / `Notarized Developer ID` 확인
- [ ] 문서 읽기·내보내기 기능 검증
- [ ] 최종 DMG를 HTTPS 배포 주소에 업로드
- [ ] 다운로드 버튼에 대상 아키텍처 표시
- [ ] 다른 Mac에서 웹 다운로드부터 최초 실행까지 검증
