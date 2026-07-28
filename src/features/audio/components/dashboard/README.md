# dashboard

## 1. 도메인 설명

이 도메인은 분석 프레임(온도·익스커션)이 초당 약 100개씩 쏟아져도 차트가 밀리지 않게, "프레임 수신 → 코얼레싱/이벤트 보존 → 차트 갱신" 렌더 파이프라인을 한곳에서 통제한다. 개발자는 이 폴더만 보면 대시보드의 상태 소유권(프레임 버퍼, 캐시, 측정 refs)이 어디에 있고 어떤 훅이 그 상태를 빌려 쓰는지 파악할 수 있다.

`DashboardClient.tsx`가 최상위 클라이언트 컴포넌트로서 실시간 프레임 버퍼, 출력 큐 스케줄러, sessionStorage/IndexedDB 캐시, Workspace 저장, 측정 하네스 토글을 전부 조율한다. 입력은 업로드 파일 한 갈래뿐이다. 분석 경로도 실시간 스트림 하나, 프레임 버퍼도 `streamingFrames` 하나다. `hooks/`의 세 훅은 상태를 소유하지 않고 `DashboardClient`가 주입한 refs/state를 읽고 쓰는 로직만 제공한다 — 파일 선택·리셋 같은 다른 라이프사이클 경로가 같은 refs를 직접 건드리기 때문에 소유권을 훅으로 옮기지 않았다.

## 2. 프로젝트 전반에서의 역할

`src/app/page.tsx`가 유일하게 `DashboardPage`(기본 export)를 렌더링하는 진입점이다. `page.tsx`는 `process.env.USE_QUEUE !== "false"`를 읽어 `useQueue` prop으로 넘기고 이 값이 렌더 경로(출력 큐+스케줄러 vs. FIFO append)를 가른다.

대시보드는 프로젝트의 나머지 조각을 모두 조립하는 허브다: 플레이어(`player/`)가 만든 `AnalysisFrame`을 받아 렌더 경로를 태우고 차트(`chart/`)에 공급하고, 캘리브레이션(`calibration/CalibrationContext`)에서 엔진 파라미터·온도 임계값을 읽고 워크스페이스(`workspace/WorkspaceContext`)에 분석 결과를 저장한다. 우측 드로어 3종(Workspace·측정 기록·Calibration)도 `DashboardClient`가 직접 렌더한다.

이 도메인은 우측 드로어 배타 전환 컨텍스트 `ActiveDrawerContext`도 정의한다. Provider는 `src/app/layout.tsx`가 트리 최상단에서 감싸고, `Sidebar`·`WorkspaceContext`·`RecordsDrawer`·`CalibrationDrawer`가 이 값을 소비한다. 즉 드로어 4개(내비 항목) 중 하나만 열리도록 하는 앱 전역 단일 소스가 이 도메인에 있다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `DashboardClient.tsx` | 최상위 클라이언트 컴포넌트(기본 export `DashboardPage`). 실시간 상태(`realtimeStatus`)와 단일 프레임 버퍼(`streamingFrames`), 모든 측정용 refs를 소유한다. `handleFrameReceived`로 프레임을 받아 `useQueue`에 따라 `outputQueueRef`에 push하거나 즉시 state append한다. `RENDER_INTERVAL`(5ms) `setInterval` 스케줄러가 큐를 drain해 `detectEvents()`+`coalesceFrames()`를 거친 프레임만 렌더하고, 스케줄러 해제 시 남은 큐를 한 번 더 drain해 비운다. 버퍼(`streamingFrames`)는 윈도우·slice 상한 없이 세션 동안 계속 누적된다. Workspace 저장은 `handleSaveToWorkspace` 한 갈래다. 실제 저장 로직은 `hooks/useWorkspaceSave.ts`가 맡는다. 파일 플레이어 구현은 마운트 시점의 `window.audioCapture` 유무로 갈린다(Electron이면 `DuplexFilePlayer`, 웹이면 `WaveformPlayer` — 두 컴포넌트가 같은 Props/`WaveformPlayerHandle` 계약을 지키므로 나머지 배선은 공유한다). `ChartDetailOverlay`에는 그 플레이어 핸들(`realtimeWaveRef`)에서 뽑은 `getChannelsBlob`(전 채널 WAV 스냅샷)·`subscribeChannelStream`(캡처 청크 실시간 구독)을 넘겨 채널 뷰를 잇는다. 데스크톱(lg 이상)에서는 Ctrl/Cmd+B(또는 헤더 버튼)로 Sidebar를 접는 `sidebarCollapsed`도 소유한다. 우측 드로어 3종(`WorkspaceDrawer`/`RecordsDrawer`/`CalibrationDrawer`)과 플로팅 플레이어 독도 여기서 렌더한다. |
| `ActiveDrawerContext.tsx` | 우측 드로어 배타 전환 컨텍스트(앱 전역 단일 소스). `active: DrawerKey \| null`과 `openDrawer`/`closeDrawer`를 노출한다. `DrawerKey`는 `"workspace" \| "records" \| "calibration"`. Provider 밖에서 `useActiveDrawer()`를 호출하면 예외를 던진다. |
| `SelectedFilePanel.tsx` | "파일 없음" 안내 전용 컴포넌트. 클릭하면 좌측 Workspace 드로어를 여는 진입점 버튼 하나만 렌더한다(prop 없음). 파일 선택 자체는 Workspace 드로어의 "폴더" 섹션이 맡고, 선택 뒤의 미리보기/저장 버튼은 플로팅 플레이어 독(`WaveformPlayer`)으로 옮겼다. |
| `hooks/useFrameCachePersistence.ts` | sessionStorage 프레임 캐시(`lib/cache/frame.ts`) 저장/복원 + IndexedDB 오디오 blob(`lib/cache/audio-blob.ts`) 복원. 마운트 시 캐시를 복원하고 재생 정지(`paused`/`ready`)와 `pagehide`/`visibilitychange`(hidden) 시점에 `persistCache()`를 호출한다. F5 새로고침·탭 전환 후에도 파형/차트가 유지되는 이유가 이 훅이다. 저장/복원 대상은 실시간 버퍼(`streamingFrames`) 하나다. |
| `hooks/useWorkspaceSave.ts` | Workspace 저장 훅. 저장 직전 `computeMeasurementSummary()`로 버퍼에서 Peak 온도/진폭과 상태(`normal`/`warning`/`danger`, 임계값 기준)를 계산한다. 저장 대상은 세션이 캡처한 WAV를 우선하며 캡처된 적이 없으면 업로드 원본 파일로 대체한다. 이렇게 고른 대상을 보호 감쇠 PCM(`getProtectedBlob`)과 함께 `saveCurrent`로 넘긴다. 프레임 버퍼는 `framesRef`로 주입받는다(상태 소유는 여전히 `DashboardClient`). |
| perf telemetry | 렌더/차트 성능 수집은 `lib/perf/collector.ts`와 각 차트의 `perfTrack` 인스턴스가 담당한다. |

## 4. 의존성 및 흐름

이 도메인의 export를 import하는 외부 파일은 다음과 같다.

- `src/app/page.tsx` → `DashboardClient.tsx` (`DashboardPage` 렌더, `useQueue` 주입)
- `src/app/layout.tsx` → `ActiveDrawerContext.tsx` (`ActiveDrawerProvider`로 트리 감쌈)
- `src/shared/components/Sidebar.tsx` → `ActiveDrawerContext.tsx` (`useActiveDrawer()`로 내비 항목이 드로어를 열고 닫음)
- `components/workspace/{WorkspaceContext,RecordsDrawer}.tsx`, `components/calibration/CalibrationDrawer.tsx` → `ActiveDrawerContext.tsx` (각 드로어의 open 여부를 이 컨텍스트에서 파생)

이 도메인이 의존하는 모듈(방향: dashboard → 대상):

- `components/player/` — `WaveformPlayer`(웹)/`DuplexFilePlayer`(Electron). 둘 다 파일 재생 + 캡처 분석이고 `WaveformPlayerHandle` ref 계약을 공유한다. 프레임은 반대 방향(player → dashboard)으로 `onFrameReceived` 콜백을 타고 들어온다.
- `components/chart/` — `TemperatureChart`·`ExcursionChart`·`ChartDetailOverlay`에 `streamingFrames`를 공급한다. `perfTrack`은 메인 차트 두 인스턴스에만 켠다(렌더 계측은 콜백으로 돌아오지 않고 차트 쪽이 `lib/perf` 수집기에 직접 기록한다). `ChartDetailOverlay`에는 플레이어 핸들 기반 `getChannelsBlob`/`subscribeChannelStream`(채널 뷰용 WAV 스냅샷·캡처 청크 스트림)과 `getProtectedBlob`/`sourceFile`(보호 감쇠 비교 뷰용)도 함께 넘긴다.
- `components/workspace/` — `WorkspaceDrawer`·`RecordsDrawer`를 직접 렌더하고, `useWorkspace()`의 `saveCurrent`로 세션을 저장한다. `pendingLocalFile`로 로컬 폴더에서 고른 파일을 수신(수신 즉시 `handleFileSelected`로 흘려보내고 `clearPendingLocalFile` 호출).
- `components/calibration/` — `CalibrationDrawer`를 직접 렌더하고, `useCalibration()`으로 `ampOutputPower`/`speakerModel`/`ambientTemp`(엔진 파라미터)와 `tempWarn`/`tempDanger`(임계값, 파싱 실패 시 65/75°C fallback)를 읽는다.
- `lib/render/` — `coalesceFrames`(버킷 병합), `detectEvents`+`DEFAULT_TEMP_WARN`(65)/`DEFAULT_TEMP_DANGER`(75)(임계값 이벤트 감지), `QueuedFrame` 타입.
- `lib/cache/` — `frame.ts`(sessionStorage), `audio-blob.ts`(IndexedDB `putAudio`/`clearAudio`/`getCachedAudio`), `workspace.ts`(`SessionStatus` 타입).
- `types.ts` — `AnalysisFrame`, `AppStatus`, `InputParameterValues`.
- `shared/` — `Sidebar`, `SegmentedControl`, `formatTime()`.

실시간 렌더 경로(useQueue=true 기준):

```
WaveformPlayer / DuplexFilePlayer
  → onFrameReceived(frame)
  → outputQueueRef.push({frame, recvAt})
  → [RENDER_INTERVAL=5ms 스케줄러] detectEvents(bucket) + coalesceFrames(bucket)
  → setStreamingFrames (윈도우 없이 세션 동안 누적)
  → streamingFrames → TemperatureChart / ExcursionChart / ChartDetailOverlay
```

useQueue=false(FIFO baseline)에서는 스케줄러 없이 수신 즉시 append한다. 새 파일을 고르거나(`handleFileSelected`) 리셋하면(`handleReset`) 버퍼·캐시를 비우고 상태를 초기화한다.

Workspace 저장 시에는 원본 업로드 파일이 아니라 플레이어의 `exportRecordedAudio()`가 반환하는 "실제 분석 엔진에 보낸 신호(V/I)" 구간의 WAV를 저장하고, 그게 null이면 원본 파일로 대체한다. 저장 시 `analysisMode` 필드에는 항상 `"realtime"`을 싣는다(워크스페이스 스키마에 남아 있는 필드).

참고: `handleRealtimeStatus`의 오류 문구는 "WebSocket 연결에 실패했습니다. 서버가 실행 중인지 확인해주세요."인데, 실제 분석 경로는 서버 없는 in-process WASM(WebAssembly) 소켓 스탠드인(`LocalWasmSocket`)이다. 문구가 구 아키텍처(WS 서버) 시절 그대로 남아 있다.

## 5. 주요 인터페이스 / 진입점

- `DashboardPage` (기본 export, `DashboardClient.tsx`) → `({ useQueue }: { useQueue: boolean }) => JSX` → 대시보드 전체를 렌더하는 유일한 페이지 컴포넌트. `useQueue`가 렌더 경로(큐+100ms 스케줄러 vs. FIFO)를 결정하며, 정적 export에서는 빌드 시점 값으로 고정된다.
- `ActiveDrawerProvider` (`ActiveDrawerContext.tsx`) → `({ children }) => JSX` → 우측 드로어 배타 전환 상태를 트리에 제공. `layout.tsx`가 최상단에서 감싼다.
- `useActiveDrawer` (`ActiveDrawerContext.tsx`) → `() => { active: DrawerKey \| null; openDrawer: (key: DrawerKey) => void; closeDrawer: () => void }` → 현재 열린 드로어를 읽고 열고 닫는다. Provider 밖에서 호출하면 예외를 던진다.
- `DrawerKey` (`ActiveDrawerContext.tsx`) → `"workspace" \| "records" \| "calibration"` → 배타 전환 대상 드로어 키.
- `SelectedFilePanel` (기본 export) → `() => JSX` → "파일 없음" 안내 패널. prop 없이 `useWorkspace()`로 드로어를 여는 진입점만 렌더한다.
- `useFrameCachePersistence` (`hooks/`) → `(deps: FrameCachePersistenceDeps) => { persistCache: () => void }` → 캐시 저장/복원. refs와 setter를 전부 부모에게서 주입받는다. 캐시는 표시용 필드만 담으므로 분석 ground-truth로 쓰면 안 된다. (`hooks/`에는 현재 이 훅 하나만 있다.)

## 6. 변경 이력(요약)
- 2026-07-09: 최초 작성 (기준 커밋: 1fbbf44, 커밋되지 않은 워크트리 변경 반영)
- 2026-07-09: realtime/batch 분석 모드 제거 반영 — `AnalysisModeContext` 삭제(입력 소스는 `DashboardClient` 로컬 state로 흡수), `ActiveDrawerContext`(우측 드로어 배타 전환) 신규 추가, `batchStatus`/`batchFrames`/`handleRunBatch`/Reference JSON 서술 삭제, `SelectedFilePanel` 무-prop 축소, `useFrameCachePersistence` batch deps 제거. 섹션 1·2·3·4·5 갱신 (커밋 범위: e0add14..9242fd2, 워크트리 포함)
- 2026-07-09: workspace 도메인 리네임 반영 — `MeasurementRecordsDrawer` → `RecordsDrawer`, `lib/cache/workspace.ts`의 `MeasurementStatus` → `SessionStatus`. 이 도메인의 `useMeasurementCapture`/`MeasurementExport`(성능 측정 하네스)와 이름이 겹쳐 혼동을 주던 문제를 없애기 위한 순수 리네임. 섹션 1·3·4의 관련 언급 갱신 (커밋 범위: 9242fd2..HEAD, 워크트리 포함)
- 2026-07-13: `DashboardClient` 배선 갱신 반영 — `ChartDetailOverlay` 채널 뷰에 `getChannelsBlob`/`subscribeChannelStream`(활성 플레이어 핸들의 전 채널 WAV 스냅샷·캡처 청크 스트림)을 연결, 데스크톱 Sidebar 접기(`sidebarCollapsed`, Ctrl/Cmd+B) 추가, 16ms 스케줄러 해제 시 잔여 큐 flush. `SelectedFilePanel`은 `CalibrationSummary` 제거로 무-배지 진입점만 남음(섹션 3·4 관련 언급 정정). 섹션 3·4 부분 갱신 (커밋 범위: 14742c6..HEAD, 워크트리 포함)
- 2026-07-27: 미반영분 일괄 정리 — `hooks/useWorkspaceSave.ts` 추출 반영(공용 저장 로직 + `computeMeasurementSummary`), `components/chart/` 쪽 렌더 계측 배선 서술 정정(`onReactRender`/`onEchartsRender` 콜백은 삭제된 지 오래 — 현재는 `perfTrack` prop만 내려주고 차트가 `lib/perf`에 직접 기록), ECharts → uPlot 이관으로 `lttb` prop 체인 삭제. 섹션 3·4 부분 갱신 (커밋 범위: f9ad37e..HEAD, 워크트리 포함)
- 2026-07-28: 마이크 패널 제거 + 비스트리밍 창 경로 제거 반영 — `DashboardClient`에서 입력 모드 상태(`inputMode`)와 File/Microphone `SegmentedControl`, `micWaveRef`, `handleSaveMicRecording`, `handleInputModeChange`가 사라져 입력이 업로드 파일 한 갈래가 됐다. `getProtectedBlob`/`getChannelsBlob`/`subscribeChannelStream`의 파일·마이크 분기도 함께 없어졌다. `useWorkspaceSave`의 소스 타입은 `mode: "file" | "mic"` 유니온에서 단일 객체로 줄었다. 차트로 내려보내던 `currentTime`/`streaming` prop과 그 원천인 `currentTime` state·`handleRealtimeTime`도 제거했다. `RENDER_INTERVAL` 표기를 실제 값 5 ms로 정정(문서가 10 ms로 남아 있었음). 섹션 1·3·4 부분 갱신 (커밋 범위: 3124dd9..HEAD)
