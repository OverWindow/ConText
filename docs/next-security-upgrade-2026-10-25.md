# ConText Next.js 보안 업데이트

<!-- next-upgrade: security; path="frontend" -->

2026-10-25 완료. `frontend`에서 `next upgrade --agent=security`를 실행했고, CLI가 지정한 안전한 대상 버전 16.4.3으로 업데이트했다. CLI의 `shared.md`와 `same-major.md` 지침을 따랐다.

| 패키지 | 이전 | 적용 |
|---|---|---|
| next | 16.4.0 | 16.4.3 |
| eslint-config-next | 16.4.0 | 16.4.3 |
| zod 간접 개발 의존성 | 4.6.5 | 4.6.7 |

`package.json`과 `package-lock.json`을 갱신했다. `next.config.ts`에는 `experimental.agentUpgrade: "security"`를 저장했다. Zod는 ESLint의 기존 호환 범위 안에서 갱신했다.

## 중복 확인과 적용 위치

기존 파일에서 동등한 업그레이드 작업과 마커를 확인했으며 발견되지 않았다. `git rev-parse --show-toplevel` 결과 이 폴더는 Git 저장소가 아니었다. 따라서 로컬·원격 브랜치, 커밋, 제공자 PR 검사는 적용할 수 없었다. CLI 지침에 따라 현재 폴더에 적용했으며 커밋과 PR 생성에는 Git 저장소와 원격이 필요하다.

## 검증

- `next --version`: 16.4.3. manifest, lockfile, 설치 버전 일치.
- `npm run typecheck`, `npm run lint`, `npm run build`: 모두 통과.
- `npm run test:e2e`: 데스크톱·모바일 로그인 테스트 6개 통과.
- `npm run test:documents`: 문서 업로드·다운로드·권한 테스트 12개 통과.
- `npm run test:canvas`: 배치·연결·권한·실패 복구 테스트 40개 통과.
- `npm run test:writing`: AI 문서 편집·내보내기·삭제 UI 테스트 10개 통과.
- `npm audit`: 업데이트 전 critical 1건, high 1건에서 업데이트 후 알려진 의존성 취약점 0건.
- CLI가 요청한 업그레이드 성공 결과 보고 명령을 한 번 실행했고 종료 코드 0을 확인했다.

브라우저 검증은 테스트용 인증·API 응답을 사용했다. 운영 AI API 호출이나 실제 로그인 제공자 검증은 포함하지 않는다. Docker 서비스를 시작하지 않고 검증했다.

## 참조 보안 공지

- [Next.js 이미지 최적화 API 공지](https://github.com/advisories/GHSA-2464-fhr4-w9xw)
- [Next.js Server Actions 공지](https://github.com/advisories/GHSA-p3m5-59mp-jv5r)
- [Next.js use cache 공지](https://github.com/advisories/GHSA-673q-mjm6-r5xr)
- [Zod 컬렉션 검증 공지](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
