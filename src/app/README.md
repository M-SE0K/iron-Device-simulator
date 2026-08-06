# app

## 1. 도메인 설명

Next.js App Router의 앱 엔트리 도메인이다. 라우트는 `/` 하나뿐이다. 이 폴더에서 개발자가 손대는 것은 전역 Provider 조립(`layout.tsx`), Tauri 브리지 설치 부트스트랩(`TauriBridgeInit.tsx`), 대시보드 진입점과 렌더 경로 플래그 결정(`page.tsx`), 전역 스타일(`globals.css`) 네 가지뿐이다. 실제 화면과 로직은 전부 `src/features/audio/`에 있고, 이 도메인은 그것을 감싸 부팅하는 얇은 껍데기다.

## 2. 프로젝트 전반에서의 역할

- Tauri 브리지 설치는 여기서만 일어난다. `TauriBridgeInit`은 아무것도 그리지 않는 컴포넌트인데, `layout.tsx`가 `<body>` 아래 다른 무엇보다 먼저 렌더한다. 모듈이 평가되는 시점에 `installTauriBridge()`를 동기 호출해 `window.audioDevice` 등 브리지 전역을 채운다. `children`(및 그 안의 모든 브리지 감지 `useEffect`)보다 앞에 두었으니 hydration 이후 실행되는 이펙트는 언제나 준비가 끝난 브리지를 본다.
- 앱 전역 상태가 한데 모이는 지점이다. `layout.tsx`가 `LocaleProvider`(표시 언어) → `ErrorPopupProvider`(전역 에러/성공 팝업) → `ActiveDrawerProvider`(우측 드로어 배타 전환 상태) → `CalibrationProvider`(캘리브레이션 파라미터) → `WorkspaceProvider`(저장된 작업 영역 목록) 다섯 Provider를 이 순서대로 중첩하므로, 대시보드와 좌우 드로어(Workspace/측정 기록/Calibration)가 같은 컨텍스트를 본다. 순서에는 이유가 있다. 표시 언어와 에러 피드백은 나머지 모든 Provider·컴포넌트보다 먼저 준비돼 있어야 해서 `LocaleProvider`/`ErrorPopupProvider`를 가장 바깥에 두었고, `CalibrationProvider`/`WorkspaceProvider`와 Sidebar·RecordsDrawer가 모두 "지금 열린 드로어"를 이 컨텍스트에서 끌어오므로 `ActiveDrawerProvider`가 그다음이다.
- 렌더 경로 스위치를 결정하는 곳도 여기뿐이다. `page.tsx`가 `process.env.USE_QUEUE !== "false"`를 계산해 `DashboardClient`의 `useQueue` prop으로 내려보내고 이 값이 출력 큐+스케줄러 경로와 FIFO append 경로를 가른다.
- 배포 방식이 갈리는 접점이다. `page.tsx`의 `export const dynamic = "force-dynamic"`은 런타임 서버가 있는 `next start` 배포에서 `USE_QUEUE`를 재빌드 없이 요청 시점에 반영하려고 넣었다. 정적 export와는 호환되지 않으므로, `scripts/build/build-desktop.sh`(정적 웹 빌드 `build:desktop`과 Tauri 패키징 `build:tauri*`가 공유하는 공용 코어 — Electron/모바일 빌드는 제거됨)가 빌드하는 동안만 이 줄을 `sed`로 `"force-static"` 리터럴로 치환했다가 `trap`으로 원복한다. 삼항식 같은 계산식으로는 대체할 수 없다. Next.js가 segment config를 리터럴 문자열로만 정적 분석하기 때문이다.

## 3. 파일별 역할
| 파일 | 역할 |
|------|------|
| `page.tsx` | `/` 라우트. `USE_QUEUE` 환경변수를 읽어 `DashboardClient`에 `useQueue` prop으로 전달한다. `export const dynamic = "force-dynamic"` 선언(정적 빌드 시 스크립트가 임시 치환)을 담는다. |
| `layout.tsx` | 루트 레이아웃. `globals.css` import, `metadata`(타이틀/설명), `viewport`(`viewportFit: "cover"` — 모바일 브라우저에서 노치 영역까지 그려 `env(safe-area-inset-*)`가 실제 값을 갖게 함) export, `<html lang="ko">` 아래 `TauriBridgeInit`을 가장 먼저 렌더한 뒤 `LocaleProvider` → `ErrorPopupProvider` → `ActiveDrawerProvider` → `CalibrationProvider` → `WorkspaceProvider` 중첩. |
| `TauriBridgeInit.tsx` | Tauri shim(`shared/lib/tauri-bridge`)을 모듈 평가 시점에 동기 설치하는 부트스트랩. `installTauriBridge()`를 모듈 스코프에서 바로 호출하고, 컴포넌트 자신은 `null`만 반환한다(렌더 시점엔 `window`를 건드리지 않아 정적 export의 서버 렌더링에서도 안전). |
| `globals.css` | 전역 스타일. Google Fonts(Inter, JetBrains Mono) import, Tailwind 3계층 지시자, CSS 변수 3종, 커스텀 스크롤바(6px), `@layer components`의 `.card`/`.card-header`/`.card-title`/`.badge`(blue/green/red 변형) 유틸리티를 정의한다. |

## 4. 의존성 및 흐름

이 도메인이 의존하는 방향은 `@/features/audio/`와 `@/shared/`(에러 팝업·i18n·Tauri 브리지) 둘이다.

```
layout.tsx ── TauriBridgeInit (@/shared/lib/tauri-bridge — 모듈 평가 시점 installTauriBridge() 부수효과, 트리에는 안 나타남)
          └── LocaleProvider      (@/shared/lib/i18n/LocaleProvider)
                └── ErrorPopupProvider (@/shared/components/error-popup/ErrorPopupContext)
                      └── ActiveDrawerProvider (@/features/audio/components/dashboard/ActiveDrawerContext)
                            └── CalibrationProvider  (@/features/audio/components/calibration/CalibrationContext)
                                  └── WorkspaceProvider (@/features/audio/components/workspace/WorkspaceContext)
                                        └── {children} = page.tsx
                                              └── DashboardClient (@/features/audio/components/dashboard/DashboardClient)
                                                    useQueue = (process.env.USE_QUEUE !== "false")
```

빌드 파이프라인에서는 이렇게 움직인다. `npm run build:desktop`(정적 웹) 또는 `npm run build:tauri*`(Tauri 패키징, 내부적으로 `build-desktop.sh`를 첫 단계로 호출) → `scripts/build/build-desktop.sh`가 `page.tsx`를 백업(`page.tsx.bak`) 후 `dynamic` 값을 `"force-static"`으로 치환 → `MOBILE_BUILD=1 npx next build`로 `out/` 정적 export → 종료 시 원복. 정적 export에서는 `USE_QUEUE`가 빌드 시점 값으로 고정된다(기본 `true`). `MOBILE_BUILD`라는 이름은 이미 제거된 과거 모바일(Capacitor) 빌드 시절 그대로 남아 있다.

## 5. 주요 인터페이스 / 진입점

- `page.tsx` — `export default function Page()`: `/` 라우트 진입점. `export const dynamic`: Next.js segment config로, 배포 방식에 따라 값이 갈리는 유일한 지점이다.
- `layout.tsx` — `export default function RootLayout({ children })`, `export const metadata: Metadata`, `export const viewport: Viewport`. `TauriBridgeInit`을 먼저 렌더한 뒤 `LocaleProvider` → `ErrorPopupProvider` → `ActiveDrawerProvider` → `CalibrationProvider` → `WorkspaceProvider` 순으로 앱 전역 Provider를 조립한다.
- `TauriBridgeInit.tsx` — `export default function TauriBridgeInit()`: 항상 `null`을 반환하는 부트스트랩 컴포넌트. 실제 동작은 모듈 스코프의 `installTauriBridge()` 호출(import되는 순간 1회 실행)이 맡는다. 렌더 트리가 아니라 import 시점의 부수효과가 진짜 진입점이다.
- `globals.css` — `.card*`/`.badge*` 컴포넌트 클래스: 하위 도메인 컴포넌트들이 공용으로 쓰는 전역 유틸리티.

## 6. 변경 이력(요약)
- 2026-07-09: 최초 작성 (기준 커밋: 1fbbf44, 커밋되지 않은 워크트리 변경 반영)
- 2026-07-13: Provider 트리에 `ActiveDrawerProvider`(우측 드로어 배타 전환) 추가 반영 — 세 Provider 중 가장 바깥에 위치. 섹션 2·3·4·5 부분 갱신 (커밋 범위: e0add14..HEAD, 워크트리 포함)
- 2026-07-30: Electron 제거 + Tauri 단일 셸 전환 반영. 신규 `TauriBridgeInit.tsx`(모듈 평가 시점 `installTauriBridge()` 부트스트랩)가 `layout.tsx`의 `<body>` 최상단에 추가됐다. Provider 트리 바깥쪽에는 `LocaleProvider`/`ErrorPopupProvider`가 새로 씌워져 `LocaleProvider` → `ErrorPopupProvider` → `ActiveDrawerProvider` → `CalibrationProvider` → `WorkspaceProvider` 5중첩이 됐다. `page.tsx`의 빌드 스크립트 주석이 desktop/electron/mobile에서 desktop(`build:desktop`)/Tauri(`build:tauri*`) 공유 코어로 정정됐다. 섹션 1·2·3·4·5 부분 갱신 (커밋 범위: 15eb47b..HEAD, 작업 트리의 커밋되지 않은 변경 포함)
