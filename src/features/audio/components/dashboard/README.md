# dashboard

## 1. 도메인 설명

파일 재생·차트·서랍(Workspace/Records/Calibration)을 한 화면으로 합치는 최상위 조립 지점입니다. 오디오 파일 선택부터 실시간 분석 세션 진행, 저장, 새로고침 후 캐시 복원까지 대시보드 전체의 상태 흐름을 여기서 관리합니다.

## 2. 프로젝트 전반에서의 역할

`src/app/page.tsx`가 그대로 렌더하는 실질적인 앱 루트입니다. `player/`·`chart/`·`channel/`·`workspace/`·`calibration/` 다섯 도메인을 한 화면에 배치하고 그 사이를 잇는 상태(오디오 파일, 재생 상태, 차트 표시 데이터, 서랍 활성 상태)를 이 도메인이 소유합니다. 하위 컴포넌트와 훅은 그 상태를 직접 갖지 않고 `DashboardClient`가 refs/props로 주입합니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `DashboardClient.tsx` | 최상위 페이지 컴포넌트(`DashboardPage`) — 레이아웃, 오디오 파일/재생 상태, `ChartStore` 소유, 출력 큐 배치 렌더링, Workspace 저장 트리거 |
| `ActiveDrawerContext.tsx` | Workspace/Records/Calibration 세 서랍 중 하나만 열리게 관리하는 전역 컨텍스트(`DrawerKey`) |
| `SelectedFilePanel.tsx` | 파일을 아직 선택하지 않았을 때 Workspace를 열도록 안내하는 카드 |
| `hooks/useFrameCachePersistence.ts` | sessionStorage(프레임 캐시)와 IndexedDB(오디오 Blob) 복원·저장 |
| `hooks/useWorkspaceSave.ts` | 저장 시 피크 온도·변위와 세션 상태(normal/warning/danger)를 계산해 `WorkspaceContext.saveCurrent`를 호출 |

## 4. 의존성 및 흐름

- **가져오는 것**: `shared/components/Sidebar`, `player/`의 `DuplexFilePlayer`+타입, `chart/`의 `TemperatureChart`/`ExcursionChart`/`ChartDetailOverlay`, `channel/`의 `ProtectedComparePanel`, `workspace/`의 `WorkspaceDrawer`/`RecordsDrawer`/`WorkspaceContext`, `calibration/`의 `CalibrationDrawer`/`CalibrationContext`, `features/audio/types`, `lib/cache/{frame,audio-blob}`, `lib/render/{coalesce,chart-store,detect-events,types}`, `shared/hooks/useCtrlBToggle`.
- `ActiveDrawerProvider`는 `src/app/layout.tsx`에 마운트됩니다 — `app/` 도메인과의 유일한 접점입니다.
- **외부에 노출하는 것**: `DashboardPage({ useQueue })` 하나뿐이며 `app/page.tsx`가 그대로 렌더합니다.

```
app/page.tsx → DashboardPage({ useQueue })
  파일 선택 → handleFileSelected → 분석 상태 리셋 + putAudio()(IndexedDB)
  재생 시작 → DuplexFilePlayer(onFrameReceived)
    → (useQueue) outputQueueRef 적재
    → (!useQueue) 즉시 chartStore.push()/flush()
  useQueue 모드 → rAF drain() → detectEvents+coalesceFrames → chartStore.push()/flush()
  "저장" 클릭 → handleSaveToWorkspace → useWorkspaceSave → WorkspaceContext.saveCurrent()(IndexedDB)
  일시정지/새로고침 전 → useFrameCachePersistence → sessionStorage/IndexedDB에 표시 데이터 캐시
```

## 5. 주요 인터페이스 / 진입점

- **`DashboardPage({ useQueue: boolean })`** — 이 도메인의 유일한 export. `useQueue`가 true면 출력 큐+rAF 배치 렌더링, false면 프레임 도착 즉시 렌더링으로 동작합니다.
- **`ActiveDrawerProvider`** / **`useActiveDrawer(): { active: DrawerKey | null, openDrawer, closeDrawer }`** — `DrawerKey`는 `"workspace" | "records" | "calibration"`.
- **`useFrameCachePersistence(deps): { persistCache }`** — `DashboardClient`가 소유한 상태(refs)를 `deps`로 주입받아 재생 일시정지·`pagehide`·`visibilitychange` 시점에 캐시를 저장하고 마운트 시 캐시와 오디오 Blob을 복원합니다.
- **`useWorkspaceSave(options): (request) => Promise<void>`** — 프레임 배열에서 피크 온도·변위·세션 상태를 계산한 뒤 저장을 위임합니다.
- **`SelectedFilePanel`** — props 없음. 클릭하면 `WorkspaceContext`의 `setOpen(true)`만 호출합니다.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — 현재 코드 기준. 차트 표시 데이터를 `streamingFrames` 배열이 아니라 `ChartStore`(압축 스토어)로 관리하게 바뀐 점, `RecordsDrawer`와 `ActiveDrawerContext`(서랍 단일 활성 관리)를 새로 둔 점을 반영했습니다(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
