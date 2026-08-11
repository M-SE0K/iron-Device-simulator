# dashboard

## 1. 도메인 설명

파일 재생·차트·서랍(View/Workspace/Records/Calibration)을 한 화면으로 합치는 최상위 조립 지점입니다. 오디오 파일을 고르는 순간부터 실시간 분석 세션, 저장, 새로고침 후 캐시 복원까지 대시보드 전체의 상태 흐름을 여기서 관리합니다.

차트 배치도 이 도메인 몫입니다. 예전처럼 2행에 고정하지 않고, 사용자가 View 탭에서 체크한 항목만 정해진 순서대로 2열 그리드에 흘려 배치합니다. 기본 선택을 그대로 두면 예전 고정 배치(Protection 전체 폭 1행 + Excursion·Temperature 2행)가 그대로 나옵니다.

## 2. 프로젝트 전반에서의 역할

`src/app/page.tsx`가 그대로 렌더하는 실질적인 앱 루트입니다. `player/`·`chart/`·`channel/`·`workspace/`·`calibration/` 다섯 도메인을 한 화면에 배치합니다. 그 사이를 잇는 상태(오디오 파일, 재생 상태, 차트 표시 데이터, 채널 파형 스토어, 주석 스토어, 서랍 활성 상태, View 선택)는 이 도메인이 소유합니다. 하위 컴포넌트와 훅은 그 상태를 직접 갖지 않습니다. `DashboardClient`가 refs/props로 주입해 줍니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `DashboardClient.tsx` | 최상위 페이지 컴포넌트(`DashboardPage`) — 레이아웃, 오디오 파일/재생 상태, `ChartStore`·채널 파형 스토어·주석 스토어 소유, 출력 큐 배치 렌더링, View 항목 목록 구성, Workspace 저장 트리거 |
| `DashboardViewGrid.tsx` | 체크된 항목만 고정 정렬(Protection → Excursion → Temperature → 채널 오름차순)로 2열 그리드에 배치. Protection은 항상 전체 폭이고, 1칸짜리 항목이 행에 혼자 남으면 전체 폭으로 늘려 빈 칸을 만들지 않는다 |
| `ChannelChartCard.tsx` | 그리드의 캡처 채널 카드 — 메트릭 카드와 같은 셸에 `ChannelWaveformCanvas`를 담고, 확대 시 원본 PCM 직독에 쓸 스냅샷 getter를 넘긴다 |
| `ViewDrawer.tsx` | 좌측 Sidebar의 View 탭 드로어 — 목록 UI는 `channel/ChannelSelectDrawer`를 재사용하되 Workspace/Records와 같은 `content` 레이어로 연다 |
| `ActiveDrawerContext.tsx` | View/Workspace/Records/Calibration 네 서랍 중 하나만 열리게 관리하는 전역 컨텍스트(`DrawerKey`) |
| `SelectedFilePanel.tsx` | 파일을 아직 선택하지 않았을 때 Workspace를 열도록 안내하는 카드 |
| `hooks/useDashboardView.ts` | View 선택 집합(차트 id·채널 id·Protected 하위 시리즈 id)과 sessionStorage 영속화 |
| `hooks/useFrameCachePersistence.ts` | sessionStorage(프레임 캐시)와 IndexedDB(오디오 Blob) 복원·저장 |
| `hooks/useWorkspaceSave.ts` | 저장 시 피크 온도·변위와 세션 상태(normal/warning/danger)를 계산해 `WorkspaceContext.saveCurrent`를 호출 |

## 4. 의존성 및 흐름

- **가져오는 것**: `shared/components/Sidebar`, `shared/hooks/useCtrlBToggle`, `player/`의 `DuplexFilePlayer`+캡처 타입, `chart/`의 `TemperatureChart`/`ExcursionChart`(+`hooks/useDrawMode`·`ChartDrawControls`), `channel/`의 `ChannelSelectDrawer`/`ProtectedComparePanel`/`ChannelWaveformCanvas`/`hooks/useChannelWaveStreams`, `workspace/`의 `WorkspaceDrawer`/`RecordsDrawer`/`WorkspaceContext`, `calibration/`의 `CalibrationDrawer`/`CalibrationContext`, `features/audio/types`, `lib/cache/{frame,audio-blob,session-json}`, `lib/render/{coalesce,chart-store,wave-store,annotation-store,channel-meta,detect-events,protected-series,types}`.
- `ActiveDrawerProvider`는 `src/app/layout.tsx`에 마운트됩니다 — `app/` 도메인과 닿는 유일한 접점입니다.
- **외부에 노출하는 것**: `DashboardPage({ useQueue })` 하나뿐입니다. `app/page.tsx`가 이를 그대로 렌더합니다.
- **View 선택이 두 층으로 내려가는 구조**: 최상위 항목(Protection/Excursion/Temperature/채널)은 그리드에 카드가 생길지를 결정합니다. Protected 하위 시리즈 4개(`Input L/R`, `Protected L/R`)는 카드 개수가 아니라 그 카드 **안**의 표시 항목입니다. `DashboardViewGrid`가 선택 집합을 `ProtectedComparePanel`의 `hiddenSeries` 인덱스로 변환합니다. 인덱스 순서(0=Input L, 1=Input R, 2=Protected L, 3=Protected R)는 `PROTECTED_SERIES_IDS`와 패널 내부가 그대로 맞물립니다.

```
app/page.tsx → DashboardPage({ useQueue })
  파일 선택 → handleFileSelected → 분석 상태 리셋 + putAudio()(IndexedDB)
  재생 시작 → DuplexFilePlayer(onFrameReceived)
    → (useQueue) outputQueueRef 적재
    → (!useQueue) 즉시 chartStore.push()/flush()
  useQueue 모드 → rAF drain() → detectEvents+coalesceFrames → chartStore.push()/flush()

  View 탭 → ViewDrawer(ChannelSelectDrawer 재사용) → useDashboardView.toggle(id)
    → selected(Set) → DashboardViewGrid.computeCells() → 2열 그리드 배치
    → 채널 카드는 useChannelWaveStreams의 스토어를, Protected는 hiddenSeries로 하위 시리즈를 받음

  "저장" 클릭 → handleSaveToWorkspace → useWorkspaceSave → WorkspaceContext.saveCurrent()(IndexedDB)
  일시정지/새로고침 전 → useFrameCachePersistence → sessionStorage/IndexedDB에 표시 데이터 캐시
```

## 5. 주요 인터페이스 / 진입점

- **`DashboardPage({ useQueue: boolean })`** — 이 도메인의 유일한 default export. `useQueue`가 true면 출력 큐+rAF 배치 렌더링, false면 프레임 도착 즉시 렌더링으로 동작합니다.
- **`ActiveDrawerProvider`** / **`useActiveDrawer(): { active: DrawerKey | null, openDrawer, closeDrawer }`** — `DrawerKey`는 `"view" | "workspace" | "records" | "calibration"`. 프로바이더 밖에서 호출하면 예외를 던집니다.
- **`useDrawerState(key): { open, setOpen }`** — 서랍 하나만 보는 컴포넌트를 위한 얇은 래퍼. `open`은 `active === key`이고 `setOpen(true|false)`가 열기/닫기로 이어집니다. 각 드로어가 `useActiveDrawer()`에서 같은 파생 로직을 반복하지 않게 하려고 둔 것입니다.
- **`useDashboardView(): { selected: Set<string>, toggle(id) }`** — View 선택 집합. sessionStorage 키는 `iron-device-dashboard-view-v1`이라 F5 뒤에도 차트 캐시와 같은 수명으로 배치가 유지됩니다. ⚠️ 첫 렌더는 기본값으로 시작하고 저장된 선택은 마운트 후에 복원합니다 — 초기값에서 바로 storage를 읽으면 정적 프리렌더 HTML과 어긋나 hydration mismatch가 납니다.
- **View 항목 id 상수** — `VIEW_PROTECTED`/`VIEW_EXCURSION`/`VIEW_TEMPERATURE`, 채널은 `viewChannelId(ch)`(`"ch:<n>"`)와 `parseViewChannelId(id)`, Protected 하위 시리즈는 `PROTECTED_SERIES_IDS`(`PROTECTED_INPUT_L`/`_R`, `PROTECTED_PROTECTED_L`/`_R`). 기본 선택은 이 전부입니다.
- **`DashboardViewGrid(props)`** — `selected`/`chartStore`/`isActive`/`isPlaying`/`canAnnotateMetric`/`audioDuration`/`tempThresholds`/`audioFile`/`subscribeChannelStream`/`getChannelsSnapshot`/`getProtectedBlob`/`channelHeader`/`getWaveStore`/`getAnnotationStore`를 받습니다. 체크된 항목이 없으면 안내 문구만 그립니다.
- **`ChannelChartCard({ ch, header, store, annotations, canAnnotate, getCaptureSnapshot? })`** — `header`가 `null`이면 "캡처가 시작되면 파형이 보인다"는 빈 상태를 그리고, 그리기 컨트롤도 내보내지 않습니다(이을 데이터 포인트가 없기 때문).
- **`ViewDrawer({ entries, selected, onToggle })`** — `memo` 컴포넌트. 열림 상태는 props가 아니라 `useDrawerState("view")`에서 가져옵니다.
- **`useFrameCachePersistence(deps): { persistCache }`** — `DashboardClient`가 소유한 상태(refs)를 `deps`로 주입받아 재생 일시정지·`pagehide`·`visibilitychange` 시점에 캐시를 저장하고 마운트 시 캐시와 오디오 Blob을 복원합니다.
- **`useWorkspaceSave(options): (request) => Promise<void>`** — 프레임 배열에서 피크 온도·변위·세션 상태를 계산한 뒤 저장을 위임합니다.
- **`SelectedFilePanel`** — props 없음. 클릭하면 Workspace 서랍만 엽니다.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — 현재 코드 기준. 차트 표시 데이터를 `streamingFrames` 배열이 아니라 `ChartStore`(압축 스토어)로 관리하게 바뀐 점, `RecordsDrawer`와 `ActiveDrawerContext`(서랍 단일 활성 관리)를 새로 둔 점을 반영했습니다(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
- 2026-08-11: 사용자 구성형 View 그리드를 반영했습니다. 고정 배치와 별도 확대 오버레이(`chart/ChartDetailOverlay`, 삭제됨)가 하던 일은 `DashboardViewGrid`·`ViewDrawer`·`ChannelChartCard`·`hooks/useDashboardView`가 대신 맡습니다. 문서에 빠져 있던 이 네 파일은 §3·§5에 넣었습니다. `ActiveDrawerContext`는 `DrawerKey`에 `"view"`를 추가했고 파생 로직을 모은 `useDrawerState(key)`를 새로 내보냅니다(`calibration`·`workspace` 드로어가 이쪽으로 옮겨 갔습니다). 채널 파형 스토어와 점 잇기 주석 스토어도 이 도메인이 세션 단위로 소유하게 됐습니다. Protected 하위 시리즈 선택을 `hiddenSeries`로 옮기는 두 층 구조는 §4에 적었습니다. 섹션 1·2·3·4·5 부분 갱신 (커밋 범위: a465514..HEAD, 작업 트리 포함)
