# components

## 1. 도메인 설명

audio 피처의 UI 도메인 6개(calibration/channel/chart/dashboard/player/workspace)가 모여 있는 폴더입니다. 루트에는 그 도메인들이 공유하는 파일 하나 — `ActiveDrawerContext.tsx` — 만 둡니다. 이 컨텍스트는 "지금 열린 서랍은 최대 하나"라는 규칙을 앱 전역에서 강제합니다. 어느 도메인의 서랍이든 열림 상태를 여기서 파생하므로, 서랍을 새로 만들 때 배타 전환 로직을 다시 짤 필요가 없습니다.

## 2. 프로젝트 전반에서의 역할

`ActiveDrawerContext`는 원래 `dashboard/` 소속이었습니다. `workspace/`·`calibration/`처럼 dashboard의 형제 도메인들이 함께 쓰면서 하위 도메인 어느 쪽에도 속하지 않는 피처 루트로 올라왔습니다. `ActiveDrawerProvider`는 `src/app/layout.tsx`의 전역 Provider 트리에 마운트됩니다(`ErrorPopupProvider` 안쪽, `CalibrationProvider`/`WorkspaceProvider` 바깥쪽). 서랍 4종(`DrawerKey = "view" | "workspace" | "records" | "calibration"`)의 활성 상태를 한 값으로 관리합니다.

하위 6개 도메인은 각자 README가 있습니다.

| 폴더 | 책임 |
|------|------|
| `calibration/` | 캘리브레이션 파라미터 전역 상태와 설정 드로어(Capture Device 선택 포함) |
| `channel/` | 캡처 채널 파형·보호 전/후 비교의 표시 부품과 데이터 집계 훅 |
| `chart/` | Temperature/Excursion 메트릭 uPlot 차트와 공유 차트 훅 |
| `dashboard/` | 앱 루트 화면 조립 — Sidebar·View 그리드·저장·캐시 복원 |
| `player/` | 파일 재생 + 네이티브 하드웨어 캡처 세션(단일 IOProc 듀플렉스) |
| `workspace/` | 저장된 세션 목록(Records)과 로컬 폴더 파일 브라우징 |

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `ActiveDrawerContext.tsx` | 서랍 배타 전환 컨텍스트. `DrawerKey` 4종 중 활성 키 하나(또는 null)를 들고 `openDrawer`/`closeDrawer`/`useDrawerState`를 제공 |

## 4. 의존성 및 흐름

`ActiveDrawerContext.tsx`는 React 외에 아무것도 import하지 않는 잎(leaf) 모듈입니다. 소비자는 6파일입니다.

```
app/layout.tsx ── ActiveDrawerProvider 마운트 (전역 Provider 트리)
    │
    ├─ dashboard/Sidebar ────────── 탭 클릭 → onOpenDrawer(key) (DrawerKey 타입만 import)
    ├─ dashboard/DashboardClient ── useActiveDrawer() — 활성 키 조회 + openDrawer 전달
    ├─ dashboard/ViewDrawer ─────── useDrawerState("view")
    ├─ workspace/WorkspaceContext ── useDrawerState("workspace") + openDrawer("records")
    ├─ workspace/RecordsDrawer ──── useDrawerState("records")
    └─ calibration/CalibrationDrawer ─ useDrawerState("calibration")
```

어떤 키를 열면 이전 활성 키는 자동으로 닫힙니다(상태가 하나뿐이므로). 서랍 닫기는 어느 소비자가 호출하든 `closeDrawer()` 하나로 수렴합니다.

## 5. 주요 인터페이스 / 진입점

- **`ActiveDrawerProvider({ children })`** — 컨텍스트 Provider. `src/app/layout.tsx`에 한 번만 마운트합니다.
- **`useActiveDrawer(): { active: DrawerKey | null, openDrawer(key), closeDrawer() }`** — 활성 서랍 키를 직접 다루는 저수준 훅. Provider 밖에서 부르면 throw합니다.
- **`useDrawerState(key: DrawerKey): { open: boolean, setOpen(open) }`** — 서랍 하나의 관점으로 파생한 편의 훅. `setOpen(true)`는 `openDrawer(key)`, `setOpen(false)`는 `closeDrawer()`와 같습니다. 서랍 컴포넌트는 이쪽을 쓰면 됩니다.
- **`DrawerKey`** (type) — `"view" | "workspace" | "records" | "calibration"`.

## 6. 변경 이력(요약)

- 2026-08-19: 최초 작성 (mse0k-domain-tw) — `ActiveDrawerContext.tsx`가 `dashboard/`에서 components 루트로 이동한 시점 기준. 하위 6개 도메인 안내 표 포함 (커밋 범위: a465514..24d1daa)
