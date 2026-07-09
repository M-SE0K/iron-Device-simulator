# dashboard

## 1. 도메인 설명

이 도메인은 분석 프레임(온도·익스커션)이 초당 약 100개씩 쏟아져도 차트가 밀리지 않게, "프레임 수신 → 코얼레싱/이벤트 보존 → 차트 갱신" 렌더 파이프라인을 한곳에서 통제한다. 개발자는 이 폴더만 보면 대시보드의 상태 소유권(모드별 버퍼, 캐시, 측정 refs)이 어디에 있고 어떤 훅이 그 상태를 빌려 쓰는지 파악할 수 있다.

`DashboardClient.tsx`가 최상위 클라이언트 컴포넌트로서 입력 모드(file/mic)·분석 모드(realtime/batch) 전환, 모드별 프레임 버퍼, 출력 큐 스케줄러, sessionStorage/IndexedDB 캐시, Workspace 저장, 측정 하네스 토글을 전부 조율한다. `hooks/`의 세 훅은 상태를 소유하지 않고 `DashboardClient`가 주입한 refs/state를 읽고 쓰는 로직만 제공한다 — 파일 선택/리셋/모드 전환 같은 다른 라이프사이클 경로가 같은 refs를 직접 건드리기 때문에 소유권을 훅으로 옮기지 않았다.

## 2. 프로젝트 전반에서의 역할

`src/app/page.tsx`가 유일하게 `DashboardPage`(기본 export)를 렌더링하는 진입점이다. `page.tsx`는 `process.env.USE_QUEUE !== "false"`를 읽어 `useQueue` prop으로 넘기고 이 값이 렌더 경로(출력 큐+스케줄러 vs. FIFO append)를 가른다.

대시보드는 프로젝트의 나머지 조각을 모두 조립하는 허브다: 플레이어(`player/`)가 만든 `AnalysisFrame`을 받아 렌더 경로를 태우고 차트(`chart/`)에 공급하고, 캘리브레이션(`calibration/CalibrationContext`)에서 엔진 파라미터·온도 임계값을 읽고 워크스페이스(`workspace/WorkspaceContext`)에 분석 결과를 저장한다. 반대 방향으로는 `AnalysisModeContext`로 대시보드 밖(`CalibrationDrawer`)에서 입력/분석 모드를 토글할 수 있게 열어 준다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `DashboardClient.tsx` | 최상위 클라이언트 컴포넌트(기본 export `DashboardPage`). 모드별 상태(`realtimeStatus`/`batchStatus`, `streamingFrames`/`batchFrames`)와 모든 측정용 refs를 소유한다. `handleFrameReceived`로 프레임을 받아 `useQueue`에 따라 `outputQueueRef`에 push하거나 즉시 state append한다. 16ms(`RENDER_INTERVAL`) `setInterval` 스케줄러가 큐를 drain해 `detectEvents()`+`coalesceFrames()`를 거친 프레임만 렌더한다. 버퍼는 최근 `RENDER_WINDOW`(기본 3000, URL `?win=`으로 재정의) 프레임만 유지한다. Workspace 저장(`handleSaveToWorkspace`/`handleSaveMicRecording`), 배치 분석 실행(`handleRunBatch`), Reference JSON 다운로드(`handleExportReference`)도 담당한다. |
| `AnalysisModeContext.tsx` | 입력 소스(file/mic)·분석 모드(realtime/batch) 토글을 대시보드 밖에서 조작하기 위한 얇은 컨텍스트. 상태와 전환 부작용은 `DashboardClient`가 소유하고 여기서는 값만 하위 트리에 노출한다. Provider 부재 시 `useAnalysisMode()`는 `null`을 반환한다. |
| `SelectedFilePanel.tsx` | 선택된 파일의 미리보기(이름/크기/`CalibrationSummary` + 저장·초기화 버튼) 또는, 파일이 없으면 좌측 Workspace 드로어를 여는 안내 버튼을 렌더한다. 파일 선택 자체는 Workspace 드로어 담당이다. `status`가 `uploading`/`analyzing`이면 초기화 버튼을 숨긴다. |
| `hooks/useFrameCachePersistence.ts` | sessionStorage 프레임 캐시(`lib/cache/frame.ts`) 저장/복원 + IndexedDB 오디오 blob(`lib/cache/audio-blob.ts`) 복원. 마운트 시 캐시를 복원하고 재생 정지(`paused`/`ready`)와 `pagehide`/`visibilitychange`(hidden) 시점에 `persistCache()`를 호출한다. F5 새로고침·탭 전환 후에도 파형/차트가 유지되는 이유가 이 훅이다. |
| `hooks/useMeasurementCapture.ts` | 내부 측정 하네스(`scripts/measure.ts`) 전용 토글 `handleMeasureToggle`. 시작 시 raw/rendered 프레임·이벤트 로그 refs를 초기화하고 종료 시 RTT/렌더 지연/드롭율 요약 통계(avg/min/max/p50/p95/p99)를 계산해 `MeasurementExport` JSON을 다운로드한다. 측정 중에는 200ms 간격으로 프레임 카운트 UI를 갱신한다. |
| `hooks/useRenderTelemetry.ts` | 렌더 파이프라인 지연(RTT/react/echarts/freshness lag) 집계 핸들러 4종을 제공한다. `handleEchartsRender`가 ECharts 렌더 완료 시각 기준으로 구간별 ms를 계산하고 `METRICS_INTERVAL`(10)회마다 1회 realtime `WaveformPlayer` 소켓으로 `type:"metrics"` 메시지를 역전송한다(현재 이 메시지를 소비하는 곳은 없다). |

## 4. 의존성 및 흐름

이 도메인을 import하는 외부 파일은 두 곳이다.

- `src/app/page.tsx` → `DashboardClient.tsx` (`DashboardPage` 렌더, `useQueue` 주입)
- `src/features/audio/components/calibration/CalibrationDrawer.tsx` → `AnalysisModeContext.tsx` (`useAnalysisMode()`로 `setAnalysisMode` 호출)

이 도메인이 의존하는 모듈(방향: dashboard → 대상):

- `components/player/` — `WaveformPlayer`(파일 재생+분석, `WaveformPlayerHandle` ref)·`MicrophonePlayer`(마이크, `MicRecordingExport`). 프레임은 반대 방향(player → dashboard)으로 `onFrameReceived` 콜백을 타고 들어온다.
- `components/chart/` — `TemperatureChart`·`ExcursionChart`·`ChartDetailOverlay`에 `chartFrames`를 공급. 렌더 완료 시각은 반대 방향으로 `onReactRender`/`onEchartsRender` 콜백을 타고 돌아온다.
- `components/calibration/CalibrationContext` — `useCalibration()`으로 `ampOutputPower`/`speakerModel`/`ambientTemp`(엔진 파라미터)와 `tempWarn`/`tempDanger`(임계값, 파싱 실패 시 65/75°C fallback)를 읽는다. `SelectedFilePanel`은 `CalibrationSummary`를 렌더한다.
- `components/workspace/WorkspaceContext` — `saveCurrent`로 분석 세션 저장, `pendingLocalFile`로 로컬 폴더에서 고른 파일을 수신(수신 즉시 `handleFileSelected`로 흘려보내고 `clearPendingLocalFile` 호출).
- `lib/render/` — `coalesceFrames`(버킷 병합), `detectEvents`+`DEFAULT_TEMP_WARN`(65)/`DEFAULT_TEMP_DANGER`(75)(임계값 이벤트 감지), `QueuedFrame` 타입.
- `lib/cache/` — `frame.ts`(sessionStorage), `audio-blob.ts`(IndexedDB `putAudio`/`clearAudio`/`getCachedAudio`).
- `types.ts` / `lib/debug/types.ts` — `AnalysisFrame`, `AppStatus`, `InputParameterValues`, `StreamDebugInfo`, `DebugLogEntry`, `MeasurementExport`.
- `shared/` — `Header`, `cn()`, `formatFileSize()`.

실시간 렌더 경로(useQueue=true 기준):

```
WaveformPlayer/MicrophonePlayer
  → onFrameReceived(frame)
  → outputQueueRef.push({frame, recvAt})
  → [16ms 스케줄러] detectEvents(bucket) + coalesceFrames(bucket)
  → setStreamingFrames (최근 RENDER_WINDOW=3000 프레임 유지, ~62Hz 코얼레싱 기준 약 48초)
  → chartFrames → TemperatureChart / ExcursionChart / ChartDetailOverlay
```

useQueue=false(FIFO baseline)에서는 스케줄러 없이 수신 즉시 append한다. 배치 모드는 `handleRunBatch`가 실시간 소켓을 `stopStreaming()`으로 먼저 닫은 뒤 `runBatchAnalysis()`로 전체 곡선을 한 번에 `batchFrames`에 넣는다. 모드 전환(`handleAnalysisModeChange`)은 떠나는 플레이어를 `pause()`만 하고 버퍼를 비우지 않으므로 탭을 오가도 각 모드의 마지막 차트가 유지된다.

Workspace 저장 시 파일 모드는 원본 업로드 파일이 아니라 활성 플레이어의 `exportRecordedAudio()`가 반환하는 "실제 분석 엔진에 보낸 PCM 중 현재 재생 시점까지" 구간의 WAV를 저장하고(null이면 원본 파일 fallback), 마이크 모드는 `MicRecordingExport`의 N채널 WAV와 realtime 버퍼를 그대로 저장한다.

참고: `handleRealtimeStatus`/`handleBatchStatus`의 오류 문구는 "WebSocket 연결에 실패했습니다. 서버가 실행 중인지 확인해주세요."인데, 실제 분석 경로는 서버 없는 in-process WASM(WebAssembly) 소켓 스탠드인(`LocalWasmSocket`)이다. 문구가 구 아키텍처(WS 서버) 시절 그대로 남아 있다.

## 5. 주요 인터페이스 / 진입점

- `DashboardPage` (기본 export, `DashboardClient.tsx`) → `({ useQueue }: { useQueue: boolean }) => JSX` → 대시보드 전체를 렌더하는 유일한 페이지 컴포넌트. `useQueue`가 렌더 경로(큐+16ms 스케줄러 vs. FIFO)를 결정하며, 정적 export에서는 빌드 시점 값으로 고정된다.
- `useAnalysisMode` (`AnalysisModeContext.tsx`) → `() => AnalysisModeContextValue | null` → 대시보드 밖에서 `inputMode`/`analysisMode` 읽기와 `setInputMode`/`setAnalysisMode` 호출. Provider(=`DashboardClient` 반환 JSX) 밖에서는 `null`이므로 호출부가 널 체크해야 한다. `isAnalyzing`이 true면 배치 분석 진행 중이라 모드 토글을 잠근다.
- `AnalysisModeProvider` (`AnalysisModeContext.tsx`) → `Context.Provider` 그대로 재export → `DashboardClient`만 사용한다.
- `SelectedFilePanel` (기본 export) → `({ status, selectedFile, onReset, onSave, canSave }: Props) => JSX` → 파일 미리보기/Workspace 안내 패널. `canSave=false`면 저장 버튼 비활성.
- `useFrameCachePersistence` (`hooks/`) → `(deps: FrameCachePersistenceDeps) => { persistCache: () => void }` → 캐시 저장/복원. refs와 setter를 전부 부모에게서 주입받는다. 캐시는 표시용 필드만 담으므로 분석 ground-truth로 쓰면 안 된다.
- `useMeasurementCapture` (`hooks/`) → `(deps: MeasurementCaptureDeps) => { handleMeasureToggle: () => void }` → 측정 시작/종료 토글. 종료 시 `iron-device-measurement-<timestamp>.json` 다운로드.
- `useRenderTelemetry` (`hooks/`) → `(deps: RenderTelemetryDeps) => { handleDebugUpdate, handleReactRender, handleEchartsRender, handleDebugLog }` → 플레이어/차트 콜백에 꽂는 텔레메트리 핸들러 4종. 시각 단위는 전부 `performance.now()` 기준 ms.

## 6. 변경 이력(요약)
- 2026-07-09: 최초 작성 (기준 커밋: 1fbbf44, 커밋되지 않은 워크트리 변경 반영)
