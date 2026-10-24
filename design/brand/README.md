# ConText 브랜드 파일

사용자가 제공한 로고를 바탕으로 심볼·이름을 정리해 실제 서비스에 적용했다. `Con`은 Slate, `Text`는 Indigo이며 원본의 C/T 심볼과 연결 노드를 유지한다.

## 원본과 적용 파일

- `ConText-original.png`: 전달받은 원본, 하단 팔레트 포함.
- `ConText-lockup-clean.png`: 실제 배포 파일의 기준 이미지. imagegen 내장 편집 모드로 하단 팔레트·외부 여백을 정리했다. 생성형 편집이므로 원본의 픽셀 단위 복제는 아니다.
- `ConText-lockup-master.png`: 투명 배경 편집 시안. 가장자리 품질 때문에 앱에는 사용하지 않는다.
- `../../frontend/public/brand/context-logo.png`: 전체 로고 1200×420. 로그인·워크스페이스 목록·펼친 메뉴에 사용한다.
- `../../frontend/public/brand/context-symbol.png`: 같은 전체 로고에서 추출한 심볼 512×512. 압축 메뉴에 사용한다.
- `../../frontend/app/favicon.ico`: 16·32·48·64·256px 프레임을 포함하는 브라우저 아이콘.
- `../../frontend/app/icon.png`: 512×512 아이콘.
- `../../frontend/app/apple-icon.png`: 180×180 Apple 터치 아이콘.

현재 앱의 흰 표면에 맞춰 배포 PNG와 favicon은 흰 배경을 사용한다. 투명 로고나 다크 테마용 자산으로 취급하지 않는다. Next.js의 파일 기반 메타데이터가 favicon과 터치 아이콘을 자동으로 연결한다.

## 브랜드 색

| 이름 | 색상 | 토큰 |
|---|---|---|
| Indigo / Text·C 심볼 | #6366F1 | --brand-indigo |
| Violet / 보조 노드 | #A78BFA | --brand-violet |
| Slate / Con·T 심볼 | #334155 | --brand-slate |
| Light Gray-Blue | #E5EAF6 | --brand-light |

래스터 이미지에는 가장자리와 미세한 명암 변형이 있다. 위 값은 원본에서 지정한 기준색이다. 버튼·선택·본문에는 기존 UI 팔레트를 계속 사용한다. 로고를 임의 폰트로 다시 조합하거나 가로·세로 비율을 왜곡하지 않는다.

## 재내보내기

`frontend`에서 `npm run brand:build` 실행. 기준 이미지에서 고정 영역을 잘라 Sharp로 웹 크기와 ICO 프레임을 만든다. 전체 로고와 심볼이 같은 이미지에서 나오므로 모양과 색이 일치한다. 기준 이미지의 구도가 바뀌면 `scripts/build-brand-assets.mjs`의 추출 영역도 함께 갱신한다. Sharp는 Next.js 설치에 포함된 패키지를 사용한다.

## 편집 기록

도구: imagegen 내장 편집 모드. 최종 입력: `ConText-original.png`. 최종 옵션: `transparent_background: false`. 투명 시안의 가장자리 품질을 확인한 뒤 흰 배경으로 다시 편집했다.

최종 프롬프트:

> Faithfully crop and clean up the supplied existing ConText logo for production web use. Output only the horizontal logo symbol plus exact original wordmark ConText. Remove the palette swatches and captions below and the large outer white margins. Keep entire logo shape and exact typography, colors and proportions. Use a perfectly solid pure white #FFFFFF background, no transparency, no texture, no speckles, no noise, no shadows, crisp clean antialiased vector-style edges. Preserve the original C ring and T with triangle lines and 3 circular nodes, Con in #334155 slate and Text in #6366F1 indigo, violet node #A78BFA. Keep original white gaps outlining nodes. Tightly frame logo with 2% even white padding, logo spans almost full width. This is background cleanup and cropping of the existing identity, not redesign. One horizontal logo, no additional text, no palette, no mockup. Absolutely opaque white background.
