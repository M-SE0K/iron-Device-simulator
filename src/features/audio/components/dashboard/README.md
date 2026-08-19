# dashboard

## 1. 도메인 설명

파일 재생·차트 그리드·서랍 4종(View/Workspace/Records/Calibration)을 한 화면으로 합치는 최상위 조립 지점입니다. 오디오 파일 선택부터 실시간 분석 세션 진행, 저장, 새로고침 후 캐시 복원까지 대시보드 전체의 상태 흐름을 여기서 관리합니다. 어떤 차트를 그리드에 올릴지는 좌측 Sidebar의 View 탭에서 고릅니다. 그 선택은 sessionStorage에 남아 F5 뒤에도 유지됩니다.

## 2. 프로젝트 전반에서의 역할

`src/app/page.tsx`가 그대로 렌더하는 실질적인 앱 루트입니다. `player/`·`chart/`·`channel/`·`workspace/`·`calibration/` 다섯 도메인을 한 화면에 배치하고 그 사이를 잇는 상태(오디오 파일, 재생 상태, 차트 표시 데이터, View 선택 집합)를 이 도메인이 소유합니다. 하위 컴포넌트와 훅은 그 상태를 직접 갖지 않고 `DashboardClient`가 refs/props로 주입합니다. 좌측 내비게이션(`Sidebar`)도 이 도메인 소속입니다 — 탭 4개가 여는 서랍 중 View(`ViewDrawer`)만 여기서 직접 소유하고 나머지 셋은 각 도메인의 서랍 컴포넌트를 마운트만 합니다. "지금 열린 서랍" 상태 자체는 피처 루트의 `components/ActiveDrawerContext.tsx`가 관리합니다(과거 이 도메인 소속이었다가 이동 — `components/README.md` 참조).

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `DashboardClient.tsx` | 최상위 페이지 컴포넌트(`DashboardPage`) — 레이아웃, 오디오 파일/재생 상태, `ChartStore`(차트 표시 데이터)·`FrameLog`(전체 프레임 로그) 소유, rAF 출력 큐 드레인, Workspace 저장 트리거 |
| `Sidebar.tsx` | 좌측 고정 내비게이션 — View/Workspace/Records/Calibration 4개 탭이 `onOpenDrawer(key)`로 서랍을 연다. 모바일에서는 백드롭 오버레이로 슬라이드, 데스크톱에서는 ⌘/Ctrl+B로 접기(접힘 상태는 `DashboardClient`가 소유). `shared/components`에서 이 도메인으로 이동 |
| `SelectedFilePanel.tsx` | 파일을 아직 선택하지 않았을 때 Workspace를 열도록 안내하는 카드 |
| `DashboardViewGrid.tsx` | View 탭에서 체크된 항목만 고정 정렬(Protection → Excursion → Temperature → 채널 오름차순)로 최대 2열에 배치. Protection(전/후 비교)은 항상 전체 폭, 1칸짜리 항목이 행에 혼자 남으면 전체 폭으로 확장 |
| `ChannelChartCard.tsx` | 캡처 채널 카드 — 메트릭 카드와 같은 카드 셸에 `channel/`의 `ChannelWaveformCanvas`를 담는다. `getCaptureSnapshot`을 `raw` 소스로 넘겨 충분히 확대하면 엔벨로프 대신 원본 샘플을 그린다. 점 잇기(`useDrawMode`)는 메트릭 카드와 동일 패턴 |
| `ViewDrawer.tsx` | View 탭 드로어 — 목록 UI는 `channel/ChannelSelectDrawer`를 재사용하고 `layer="content"`로 연다 |
| `hooks/useDashboardView.ts` | View 선택 집합 소유(기본값: Protection+Excursion+Temperature와 Protection 하위 시리즈 4개). sessionStorage 키 `iron-device-dashboard-view-v1`에 저장, 항목 id 상수(`VIEW_*`, `PROTECTED_*`)와 채널 id 헬퍼(`viewChannelId`/`parseViewChannelId`)도 여기서 export |
| `hooks/useFrameCachePersistence.ts` | sessionStorage(프레임 캐시)와 IndexedDB(오디오 Blob) 복원·저장 — 일시정지/`pagehide`/`visibilitychange` 시점에 `ChartStore` 내용을 저장 |
| `hooks/useWorkspaceSave.ts` | 저장 시 `FrameLog`에서 피크 온도·변위와 세션 상태(normal/warning/danger)를 계산해 `WorkspaceContext.saveCurrent`를 호출 |

`ActiveDrawerContext.tsx`는 이 도메인에서 `../ActiveDrawerContext.tsx`(components 루트)로 이동했습니다 — 상세는 `components/README.md`에 있습니다.

## 4. 의존성 및 흐름

- **가져오는 것**: `player/`의 `DuplexFilePlayer`+`capture/types`, `chart/`의 `TemperatureChart`/`ExcursionChart`/`ChartDrawControls`/`hooks(useDrawMode)`, `channel/`의 `ChannelSelectDrawer`(+`DrawerEntry`)/`ProtectedComparePanel`(+`COLOR_*`)/`ChannelWaveformCanvas`/`hooks/useChannelWaveStreams`, `workspace/`의 `WorkspaceDrawer`/`RecordsDrawer`/`WorkspaceContext`, `calibration/`의 `CalibrationDrawer`/`CalibrationContext`, 피처 루트의 `components/ActiveDrawerContext`, `features/audio/types`, `lib/frame-log`, `lib/cache/{frame,audio-blob,session-json}`, `lib/render/{coalesce,chart-store,detect-events,channel-meta,annotation-store}`, `lib/codec/playback-decode`(타입), `shared/lib/iron-perf`(`recordPerfSample`), `shared/hooks/useGlobalKey`(`useCtrlBToggle`), `shared/lib/utils`.
- `ActiveDrawerProvider`는 `src/app/layout.tsx`에 마운트되며 이 도메인은 `useActiveDrawer()`/`useDrawerState()` 소비자입니다.
- **외부에 노출하는 것**: `DashboardPage()` 하나뿐이며 `app/page.tsx`가 그대로 렌더합니다.

```
app/page.tsx → DashboardPage()
  파일 선택(업로드 또는 Workspace 로컬 파일) → handleFileSelected
      → 분석 상태 리셋 + clearFrameCache() + putAudio()(IndexedDB)
  재생 시작 → DuplexFilePlayer(onFrameReceived)
      → frameLog.push() + outputQueueRef 적재
  재생 중 → requestAnimationFrame 루프 drain()
      → detectEvents()+coalesceFrames() → chartStore.push()/flush()
      → recordPerfSample("render_drain", 드레인 소요 ms)
  "저장" 클릭 → handleSaveToWorkspace → useWorkspaceSave → WorkspaceContext.saveCurrent()(IndexedDB)
  일시정지/새로고침 전 → useFrameCachePersistence → sessionStorage/IndexedDB에 표시 데이터 캐시
```

렌더 경로는 rAF 드레인 하나뿐입니다 — 과거 `USE_QUEUE`가 고르던 "프레임 도착 즉시 렌더" 분기는 제거됐습니다. 브라우저의 실제 표시 기회(rAF)마다 큐를 한 번 비워 커밋 주기를 맞춥니다. `FrameLog`는 드레인·코얼레싱과 무관하게 엔진이 계산한 프레임 전부를 보관하는 저장/CSV·JSON export 전용 로그입니다.

## 5. 주요 인터페이스 / 진입점

- **`DashboardPage()`** — 이 도메인의 유일한 진입점(default export), props 없음. 과거의 `useQueue` prop은 렌더 경로 단일화로 제거됐습니다.
- **`Sidebar({ activeDrawer, onOpenDrawer, mobileOpen?, onMobileClose?, collapsed? })`** — 좌측 내비게이션(default export, memo). `activeDrawer`와 같은 key의 탭이 활성으로 표시됩니다.
- **`ViewDrawer({ entries, selected, onToggle })`** — View 탭 드로어(default export, memo). 열림 상태는 `useDrawerState("view")`에서 파생합니다.
- **`DashboardViewGrid(props)`** — 선택 집합·`ChartStore`·게터류(`getChannelsSnapshot`/`getDecodedPlayback`/`getProtectedBlob`/`getWaveStore`/`getAnnotationStore` 등)를 받아 그리드 셀을 계산·렌더합니다(default export).
- **`ChannelChartCard({ ch, header, store, annotations, canAnnotate, getCaptureSnapshot? })`** — 캡처 채널 카드(default export). `header`가 null이면 빈 상태를 그립니다.
- **`useDashboardView(): { selected: Set<string>, toggle(id) }`** — View 선택 상태. `VIEW_PROTECTED`/`VIEW_EXCURSION`/`VIEW_TEMPERATURE`, Protection 하위 시리즈 id 4종(`PROTECTED_*`, `PROTECTED_SERIES_IDS`), `viewChannelId(ch)`/`parseViewChannelId(id)`를 함께 export합니다.
- **`useFrameCachePersistence(deps): void`** — `DashboardClient`가 소유한 상태(refs)를 `deps`로 주입받아 마운트 시 복원하고 일시정지·`pagehide`·`visibilitychange` 시점에 저장합니다. 반환값은 없습니다.
- **`useWorkspaceSave({ frameLog, thresholds, getProtectedBlob, saveCurrent }): (request) => Promise<void>`** — `FrameLog` 전체에서 피크 온도·변위·세션 상태를 계산한 뒤 저장을 위임합니다.
- **`SelectedFilePanel`** — props 없음. 클릭하면 `useWorkspace()`의 `setOpen(true)`만 호출합니다.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — 현재 코드 기준. 차트 표시 데이터를 `streamingFrames` 배열이 아니라 `ChartStore`(압축 스토어)로 관리하게 바뀐 점, `RecordsDrawer`와 `ActiveDrawerContext`(서랍 단일 활성 관리)를 새로 둔 점을 반영했습니다(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
- 2026-08-19: 렌더 경로를 rAF 드레인 하나로 단일화(`useQueue` prop·즉시 렌더 분기 제거, `DashboardPage()`는 props 없음), 전체 프레임 보관을 `allFramesRef` 배열에서 `lib/frame-log`의 `FrameLog`로 교체, 드레인 소요를 `shared/lib/iron-perf`의 `recordPerfSample("render_drain")`로 계측. `Sidebar`가 `shared/components`에서 이 도메인으로 이동(View 탭 포함 4탭), `ActiveDrawerContext`는 `components/` 루트로 이동. View 그리드에 `getChannelsSnapshot`/`getDecodedPlayback` 게터가 추가돼 채널 카드의 확대 시 원본 샘플 렌더와 비교 패널의 디코드 재사용이 배선됐고, `useFrameCachePersistence`는 반환값 없는 훅이 됐습니다. 전 섹션 갱신 (커밋 범위: a465514..24d1daa)
