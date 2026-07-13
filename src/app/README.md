# app

## 1. 도메인 설명

Next.js App Router의 앱 엔트리 도메인이다. 라우트는 `/` 하나뿐이며 개발자는 이 폴더에서 전역 Provider 조립(`layout.tsx`), 대시보드 진입점과 렌더 경로 플래그 결정(`page.tsx`), 전역 스타일(`globals.css`) 세 가지만 관리한다. 실제 화면과 로직은 전부 `src/features/audio/`에 있고, 이 도메인은 그것을 감싸 부팅하는 얇은 껍데기다.

## 2. 프로젝트 전반에서의 역할

- 앱 전역 상태를 한데 모아 공유하는 지점이다. `layout.tsx`가 `ActiveDrawerProvider`(우측 드로어 배타 전환 상태) → `CalibrationProvider`(캘리브레이션 파라미터) → `WorkspaceProvider`(저장된 작업 영역 목록) 세 Provider를 이 순서대로 중첩하므로, 대시보드와 좌우 드로어(Workspace/측정 기록/Calibration)가 같은 컨텍스트를 본다. `ActiveDrawerProvider`를 가장 바깥에 둔 것은 나머지 두 Provider와 Sidebar·RecordsDrawer가 모두 "지금 열린 드로어"를 이 컨텍스트에서 끌어오기 때문이다.
- 렌더 경로 스위치의 유일한 결정 지점이다. `page.tsx`가 `process.env.USE_QUEUE !== "false"`를 계산해 `DashboardClient`의 `useQueue` prop으로 내려보내고 이 값이 출력 큐+스케줄러 경로와 FIFO append 경로를 가른다.
- 배포 방식 분기의 접점이다. `page.tsx`의 `export const dynamic = "force-dynamic"`은 런타임 서버가 있는 `next start` 배포에서 `USE_QUEUE`를 재빌드 없이 요청 시점에 반영하기 위해서다. 정적 export와는 호환되지 않으므로, `scripts/build-static-local.sh`(desktop/electron/mobile 빌드의 공용 코어)가 빌드하는 동안만 이 줄을 `sed`로 `"force-static"` 리터럴로 치환했다가 `trap`으로 원복한다. Next.js가 segment config를 리터럴 문자열로만 정적 분석하기 때문에 삼항식 같은 계산식으로는 대체할 수 없다.

## 3. 파일별 역할
| 파일 | 역할 |
|------|------|
| `page.tsx` | `/` 라우트. `USE_QUEUE` 환경변수를 읽어 `DashboardClient`에 `useQueue` prop으로 전달한다. `export const dynamic = "force-dynamic"` 선언(정적 빌드 시 스크립트가 임시 치환)을 담는다. |
| `layout.tsx` | 루트 레이아웃. `globals.css` import, `metadata`(타이틀/설명), `viewport`(`viewportFit: "cover"` — iOS/Android 노치 영역까지 웹뷰를 그려 `env(safe-area-inset-*)`가 실제 값을 갖게 함, Capacitor 패키징용) export, `<html lang="ko">` 아래 `ActiveDrawerProvider` → `CalibrationProvider` → `WorkspaceProvider` 중첩. |
| `globals.css` | 전역 스타일. Google Fonts(Inter, JetBrains Mono) import, Tailwind 3계층 지시자, CSS 변수 3종, 커스텀 스크롤바(6px), `@layer components`의 `.card`/`.card-header`/`.card-title`/`.badge`(blue/green/red 변형) 유틸리티를 정의한다. |

## 4. 의존성 및 흐름

이 도메인은 `@/features/audio/` 한 방향으로만 의존한다.

```
layout.tsx ── ActiveDrawerProvider (@/features/audio/components/dashboard/ActiveDrawerContext)
          └── CalibrationProvider  (@/features/audio/components/calibration/CalibrationContext)
                └── WorkspaceProvider (@/features/audio/components/workspace/WorkspaceContext)
                      └── {children} = page.tsx
                            └── DashboardClient (@/features/audio/components/dashboard/DashboardClient)
                                  useQueue = (process.env.USE_QUEUE !== "false")
```

빌드 파이프라인과의 관계: `npm run build:desktop|electron|mobile` → `scripts/build-static-local.sh`가 `page.tsx`를 백업(`page.tsx.bak`) 후 `dynamic` 값을 `"force-static"`으로 치환 → `MOBILE_BUILD=1 npx next build`로 `out/` 정적 export → 종료 시 원복. 정적 export에서는 `USE_QUEUE`가 빌드 시점 값으로 고정된다(기본 `true`).

## 5. 주요 인터페이스 / 진입점

- `page.tsx` — `export default function Page()`: `/` 라우트 진입점. `export const dynamic`: Next.js segment config(배포 방식에 따라 값이 갈리는 유일한 지점).
- `layout.tsx` — `export default function RootLayout({ children })`, `export const metadata: Metadata`, `export const viewport: Viewport`. `ActiveDrawerProvider` → `CalibrationProvider` → `WorkspaceProvider` 순으로 앱 전역 Provider를 조립한다.
- `globals.css` — `.card*`/`.badge*` 컴포넌트 클래스: 하위 도메인 컴포넌트들이 공용으로 쓰는 전역 유틸리티.

## 6. 변경 이력(요약)
- 2026-07-09: 최초 작성 (기준 커밋: 1fbbf44, 커밋되지 않은 워크트리 변경 반영)
- 2026-07-13: Provider 트리에 `ActiveDrawerProvider`(우측 드로어 배타 전환) 추가 반영 — 세 Provider 중 가장 바깥에 위치. 섹션 2·3·4·5 부분 갱신 (커밋 범위: e0add14..HEAD, 워크트리 포함)
