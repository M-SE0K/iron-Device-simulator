# app

## 1. 도메인 설명

Next.js App Router의 앱 엔트리 도메인이다. 라우트는 `/` 하나뿐이다. 이 폴더에서 개발자가 손대는 것은 전역 Provider 조립(`layout.tsx`), Tauri 브리지 설치 부트스트랩(`TauriBridgeInit.tsx`), perf 계측 초기화 부트스트랩(`IronPerfInit.tsx`), 대시보드 진입점(`page.tsx`), 전역 스타일(`globals.css`) 다섯 가지뿐이다. 실제 화면과 로직은 전부 `src/features/audio/`에 있다. 이 도메인은 그것을 감싸 부팅하는 얇은 껍데기다.

## 2. 프로젝트 전반에서의 역할

- 부트스트랩 부수효과는 여기서만 일어난다. `TauriBridgeInit`과 `IronPerfInit`은 아무것도 그리지 않는 컴포넌트인데, `layout.tsx`가 `<body>` 아래 다른 무엇보다 먼저 이 순서로 렌더한다. 두 컴포넌트 모두 모듈이 평가되는 시점에 각각 `installTauriBridge()`/`initIronPerf()`를 동기 호출한다 — 전자는 `window.audioDevice` 등 브리지 전역 5개를, 후자는 계측 빌드(`NEXT_PUBLIC_IRON_PERF=1`)에서만 `window.__ironPerf`를 채운다. `children`(및 그 안의 모든 브리지 감지 `useEffect`)보다 앞에 두었으니 hydration 이후 실행되는 이펙트는 언제나 준비가 끝난 전역을 본다.
- 앱 전역 상태가 한데 모이는 지점이다. `layout.tsx`가 `ErrorPopupProvider`(전역 에러/성공 팝업) → `ActiveDrawerProvider`(드로어 배타 전환 상태, `@/features/audio/components/ActiveDrawerContext` — dashboard 하위에서 components 루트로 이동) → `CalibrationProvider`(캘리브레이션 파라미터) → `WorkspaceProvider`(저장된 작업 영역 목록) 네 Provider를 이 순서대로 중첩하므로, 대시보드와 좌우 드로어가 같은 컨텍스트를 본다. 에러 피드백은 나머지 모든 Provider·컴포넌트보다 먼저 준비돼 있어야 해서 `ErrorPopupProvider`가 가장 바깥이다. `CalibrationProvider`/`WorkspaceProvider`와 드로어 트리거들이 모두 "지금 열린 드로어"를 끌어오므로 `ActiveDrawerProvider`가 그다음이다. 표시 언어(i18n) 계층 `LocaleProvider`는 92fbb5a에서 배선을 되돌리며 트리에서 빠졌고 `<html>`의 `lang`도 `"en"`이다.
- 배포 방식이 갈리는 접점이다. `page.tsx`의 `export const dynamic = "force-dynamic"`은 그대로 있다. 정적 export와는 호환되지 않으므로 `scripts/build/build-desktop.sh`(Tauri 패키징 `build:tauri*`의 첫 단계이자 `build:desktop`의 본체)가 빌드하는 동안만 이 줄을 `sed`로 `"force-static"` 리터럴로 치환했다가 `trap`으로 원복한다. 삼항식 같은 계산식으로는 대체할 수 없다. Next.js가 segment config를 리터럴 문자열로만 정적 분석하기 때문이다. 다만 이 선언의 원래 동기였던 `USE_QUEUE` 런타임 스위치는 렌더 경로가 하나로 정리되면서 코드베이스에서 완전히 제거됐다(`USE_QUEUE`/`useQueue` 참조 0건). Claude의 생각은 — `next start` 배포 경로와 빌드 스크립트의 치환 절차가 이 선언을 전제하고 있어 스위치 제거 후에도 선언 자체는 그대로 둔 것으로 보인다.

## 3. 파일별 역할
| 파일 | 역할 |
|------|------|
| `page.tsx` | `/` 라우트. `DashboardClient`를 prop 없이 렌더하는 3줄짜리 진입점. `export const dynamic = "force-dynamic"` 선언(정적 빌드 시 스크립트가 임시 치환)을 담는다. |
| `layout.tsx` | 루트 레이아웃. `globals.css` import, `metadata`(타이틀/설명), `viewport`(`viewportFit: "cover"` — 노치 영역까지 그려 `env(safe-area-inset-*)`가 실제 값을 갖게 함) export, `<html lang="en">` 아래 `TauriBridgeInit` → `IronPerfInit`을 가장 먼저 렌더한 뒤 `ErrorPopupProvider` → `ActiveDrawerProvider` → `CalibrationProvider` → `WorkspaceProvider` 중첩. |
| `TauriBridgeInit.tsx` | Tauri shim(`shared/lib/tauri-bridge`)을 모듈 평가 시점에 동기 설치하는 부트스트랩. `installTauriBridge()`를 모듈 스코프에서 바로 호출하고 컴포넌트 자신은 `null`만 반환한다(렌더 시점엔 `window`를 건드리지 않아 정적 export의 서버 렌더링에서도 안전). |
| `IronPerfInit.tsx` | perf 계측(`shared/lib/iron-perf`)의 같은 패턴 부트스트랩. 모듈 스코프에서 `initIronPerf()`를 호출하고 `null`을 반환한다. `NEXT_PUBLIC_IRON_PERF=1`이 아닌 빌드에서는 `initIronPerf()`가 아무것도 하지 않는다. |
| `globals.css` | 전역 스타일. Pretendard(가변, jsdelivr CDN)·Google Fonts(Inter, JetBrains Mono) import, Tailwind 3계층 지시자, CSS 변수 3종, `html { font-size: 87.5% }`(rem 기반 유틸 전역 축소), 커스텀 스크롤바(6px), `@layer components`의 `.card`/`.card-header`/`.card-title`/`.badge`(blue/green/red 변형), `@layer utilities`의 `expand-down`(0.22s)/`slide-in-right`(0.24s) 애니메이션을 정의한다. |

## 4. 의존성 및 흐름

이 도메인이 의존하는 방향은 `@/features/audio/`와 `@/shared/`(에러 팝업·Tauri 브리지·perf 계측) 둘이다.

```
layout.tsx ── TauriBridgeInit (@/shared/lib/tauri-bridge — 모듈 평가 시점 installTauriBridge() 부수효과)
          ├── IronPerfInit    (@/shared/lib/iron-perf — 모듈 평가 시점 initIronPerf() 부수효과, 계측 빌드에서만 동작)
          └── ErrorPopupProvider (@/shared/components/error-popup/ErrorPopupContext)
                └── ActiveDrawerProvider (@/features/audio/components/ActiveDrawerContext)
                      └── CalibrationProvider  (@/features/audio/components/calibration/CalibrationContext)
                            └── WorkspaceProvider (@/features/audio/components/workspace/WorkspaceContext)
                                  └── {children} = page.tsx
                                        └── DashboardClient (@/features/audio/components/dashboard/DashboardClient, prop 없음)
```

빌드 파이프라인에서는 이렇게 움직인다. `npm run build:desktop`(정적 웹 번들) 또는 `npm run build:tauri*`(Tauri 패키징, 내부적으로 `build-desktop.sh`를 첫 단계로 호출) → `scripts/build/build-desktop.sh`가 `page.tsx`를 백업(`page.tsx.bak`) 후 `dynamic` 값을 `"force-static"`으로 치환 → `MOBILE_BUILD=1 npx next build`로 `out/` 정적 export → 종료 시 원복. `MOBILE_BUILD`라는 이름은 이미 제거된 과거 모바일(Capacitor) 빌드 시절 그대로 남아 있다. `build:tauri -- --dev`는 이 단계 전에 `NEXT_PUBLIC_IRON_PERF=1`을 export해 `IronPerfInit`의 계측을 빌드 타임 리터럴로 켠다(`next.config.ts`의 `env` 인라인).

## 5. 주요 인터페이스 / 진입점

- `page.tsx` — `export default function Page()`: `/` 라우트 진입점. `export const dynamic`: Next.js segment config로, 배포 방식에 따라 값이 갈리는 유일한 지점이다.
- `layout.tsx` — `export default function RootLayout({ children })`, `export const metadata: Metadata`, `export const viewport: Viewport`. `TauriBridgeInit` → `IronPerfInit`을 먼저 렌더한 뒤 `ErrorPopupProvider` → `ActiveDrawerProvider` → `CalibrationProvider` → `WorkspaceProvider` 순으로 앱 전역 Provider를 조립한다.
- `TauriBridgeInit.tsx` / `IronPerfInit.tsx` — 각각 `export default function`이 항상 `null`을 반환하는 부트스트랩 컴포넌트. 실제 동작은 모듈 스코프의 `installTauriBridge()`/`initIronPerf()` 호출(import되는 순간 1회 실행)이 맡는다. 렌더 트리가 아니라 import 시점의 부수효과가 진짜 진입점이다.
- `globals.css` — `.card*`/`.badge*` 컴포넌트 클래스와 `.animate-expand-down`/`.animate-slide-in-right` 유틸리티: 하위 도메인 컴포넌트들이 공용으로 쓰는 전역 클래스.

## 6. 변경 이력(요약)
- 2026-07-09: 최초 작성 (기준 커밋: 1fbbf44, 커밋되지 않은 워크트리 변경 반영)
- 2026-07-13: Provider 트리에 `ActiveDrawerProvider`(우측 드로어 배타 전환) 추가 반영 — 세 Provider 중 가장 바깥에 위치. 섹션 2·3·4·5 부분 갱신 (커밋 범위: e0add14..HEAD, 워크트리 포함)
- 2026-07-30: Electron 제거 + Tauri 단일 셸 전환 반영. 신규 `TauriBridgeInit.tsx`(모듈 평가 시점 `installTauriBridge()` 부트스트랩)가 `layout.tsx`의 `<body>` 최상단에 추가됐다. Provider 트리 바깥쪽에는 `LocaleProvider`/`ErrorPopupProvider`가 새로 씌워져 `LocaleProvider` → `ErrorPopupProvider` → `ActiveDrawerProvider` → `CalibrationProvider` → `WorkspaceProvider` 5중첩이 됐다. `page.tsx`의 빌드 스크립트 주석이 desktop/electron/mobile에서 desktop(`build:desktop`)/Tauri(`build:tauri*`) 공유 코어로 정정됐다. 섹션 1·2·3·4·5 부분 갱신 (커밋 범위: 15eb47b..HEAD, 작업 트리의 커밋되지 않은 변경 포함)
- 2026-08-19: perf 계측 부트스트랩 `IronPerfInit.tsx` 신설(모듈 평가 시점 `initIronPerf()`, `--dev` 계측 빌드에서만 동작) 반영. i18n 배선 되돌림(92fbb5a)에 따라 `LocaleProvider`가 트리에서 빠져 Provider가 4중첩이 됐고 `<html lang>`은 `"en"`이 됐다. `USE_QUEUE`/`useQueue` 렌더 경로 스위치가 코드베이스에서 완전히 제거되어 `page.tsx`는 prop 없는 진입점만 남았다(`force-dynamic` 선언 자체는 유지). `ActiveDrawerProvider` import 경로가 `@/features/audio/components/ActiveDrawerContext`로 이동한 것도 반영. 섹션 1~5 부분 갱신 (커밋 범위: 67e3aa4..24d1daa)
