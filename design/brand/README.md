# ConText 브랜드 파일

2026-10-28부터 크림슨·웜 화이트·차콜 팔레트를 사용한다. 기존 C/T 심볼·연결 노드·ConText 이름을 유지한 색상 변경이다. `Con`과 T는 차콜, `Text`와 C는 크림슨, 왼쪽 아래 노드는 와인색, 연결선과 오른쪽 노드는 옅은 로즈다.

## 현재 적용 파일

- `ConText-lockup-crimson.png`: 내장 imagegen 편집 도구로 기존 로고의 색상을 바꾼 선택 원본, 2120×742. 생성형 편집이므로 픽셀 단위 동일성을 의미하지 않는다.
- `../../frontend/public/brand/context-logo.png`: 웹 전체 로고, 1200×420.
- `../../frontend/public/brand/context-symbol.png`: 웹 심볼, 512×512.
- `../../packages/workspace-ui/assets/context-logo.png`, `context-symbol.png`: 같은 출력물을 복사한 공통 웹·데스크톱 자산.
- `../../frontend/app/icon.png`, `apple-icon.png`, `favicon.ico`: 같은 심볼의 앱·브라우저 아이콘.

원래 파랑·보라 이미지 `ConText-original.png`, `ConText-lockup-clean.png`, `ConText-lockup-master.png`는 이전 원본으로 보존한다. 현재 빌드는 크림슨 원본을 사용한다. 로고 배경은 불투명한 흰색이며 투명 배경 이미지로 취급하지 않는다.

## 팔레트

| 역할 | 값 |
|---|---|
| Crimson | `#A40F16` |
| Wine | `#7C334B` |
| Charcoal | `#2A2526` |
| Muted Rose | `#C89C9D` |
| Warm White / 앱 배경 | `#FAF8F5` |
| White / 문서 표면 | `#FFFFFF` |

이 팔레트는 ConText에 적용하는 제품 디자인 값이다.

## 재내보내기

`frontend`에서 `npm run brand:build`를 실행한다. `scripts/build-brand-assets.mjs`는 선택 원본 전체를 1200×420에 맞추고, 왼쪽 700×742 영역에서 심볼을 추출한다. PNG·파비콘을 내보낸 뒤 공통 패키지에도 같은 파일을 복사한다. 원본 이미지 구도가 달라지면 추출 영역도 함께 확인한다.

## 색상 편집 기록

도구: 내장 `image_gen.imagegen` 편집 모드. 입력: 변경 전 `frontend/public/brand/context-logo.png`. 옵션: `transparent_background: false`.

최종 프롬프트:

> Use case: precise-object-edit. Edit target: the supplied existing ConText horizontal logo. Change COLORS ONLY, faithfully preserve the exact existing C ring and T symbol, the three connected nodes, wordmark typography, spacing, aspect ratio and entire composition. Recolor all blue/indigo regions including the C ring, the top node, and the exact word Text to deep crimson #A40F16. Recolor the T symbol and the exact word Con to charcoal #2A2526. Recolor the violet lower-left node to muted wine #7C334B. Recolor pale blue connecting lines and rightmost node to warm muted rose #C89C9D. Perfect opaque white #FFFFFF background. Keep the clean flat logo look and subtle original antialiasing. Exact text is ConText, case sensitive. No redesign, no additions, no slogan, no outline, no university emblem, no other text, no crop of the logo. Preserve original wide 1200:420 composition as closely as possible. This is a production replacement website logo.
