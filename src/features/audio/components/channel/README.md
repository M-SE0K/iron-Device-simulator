# channel

## 1. 도메인 설명

캡처된 다채널 오디오를 채널 하나하나의 파형으로 그려 보여주는 도메인이다. 개발자는 이 폴더만 읽고도 ch0(V)·ch1(I)와 확장 채널을 어떻게 개별 파형으로 그리는지, 보호 전/후 신호를 어떻게 겹쳐 비교하는지 파악한다.

부품은 컴포넌트 4개와 훅 2개다. `ChannelWaveformCanvas`는 한 채널의 min/max 엔벨로프를 uPlot에 그리되 현재 뷰포트 구간만 읽고 충분히 확대하면 엔벨로프 대신 캡처 원본 샘플을 직접 그린다. `ChannelLevelBadge`는 peak·rms 배지(전 구간 0이면 "no signal" 경고)다. `ChannelSelectDrawer`는 표시 항목을 체크로 고르는 드로어로, `parentId` 계층(부모 항목 아래 하위 시리즈)을 지원한다. `ProtectedComparePanel`은 원본 입력과 보호 감쇠 후 신호를 L/R 채널별 엔벨로프로 겹쳐 비교한다. 데이터 소유는 컴포넌트가 아니라 훅 몫이다 — `useChannelWaveStreams`가 채널별 `ChannelWaveStore`를, `useProtectedCompareStreams`가 Input/Protected 4개 스토어를 소유하고 컴포넌트는 받은 스토어를 그리기만 한다.

## 2. 프로젝트 전반에서의 역할

캡처 파이프라인이 만든 다채널 PCM을 사람이 눈으로 읽는 파형으로 바꾸는 표시 계층이다. 스스로 마운트되는 일은 없고 소비 도메인은 `dashboard/` 하나다.

- `dashboard/DashboardViewGrid`가 View 탭 선택에 따라 `ProtectedComparePanel`을 그리드 셀로 배치하고 `dashboard/ChannelChartCard`가 채널마다 `ChannelWaveformCanvas`+`ChannelStatsBadge`를 카드로 감싼다. `dashboard/ViewDrawer`는 `ChannelSelectDrawer`를 View 탭 드로어로 재사용한다.
- `dashboard/DashboardClient`가 `useChannelWaveStreams`를 직접 호출해 채널 스토어·세션 헤더를 소유 지점 하나로 모으고 카드에는 스토어 게터만 내려보낸다.
- 과거 소비자였던 실시간 상세 뷰(`chart/ChartDetailOverlay`)와 저장 세션 뷰(`workspace/ChannelViewerOverlay`)는 코드에서 제거됐다 — 채널 파형은 이제 대시보드 View 그리드에서만 본다.
- 채널 의미(ch0=V/ch1=I/ch2 이후 확장)와 색은 이 도메인이 정하지 않는다. 단일 소스는 `lib/render/channel-meta.ts`의 `channelLabel()`/`channelColor()`이고 소비자가 그 결과를 props로 넘긴다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `ChannelWaveformCanvas.tsx` | 한 채널을 uPlot 차트(`UPlotChart` 래퍼, source 구독 모드)에 그린다. 세션 전체를 통째로 커밋하던 방식 대신 현재 뷰포트 구간만 `store.readRange()`로 읽는다(컬럼 수 × 2 포인트). 확대해서 1컬럼당 원본 샘플이 2개 미만이 되면(`RAW_SAMPLES_PER_PX`=2) `raw.getSnapshot()`의 캡처 원본 PCM을 `readRawWindow()`로 직접 읽어 샘플 단위로 그린다. 최소 가시 구간은 16샘플(`MIN_VISIBLE_SAMPLES`), Y축은 절대 피크 기준 대칭(`symmetricYRange`, 최소 스팬 0.01)이고 Y축 줌/팬(`yZoom`)과 점 잇기(`annotatePlugin`, 선택)를 지원한다. `ChannelStatsBadge`(100ms 스로틀 readout → `ChannelLevelBadge`)를 함께 export한다. |
| `ChannelLevelBadge.tsx` | peak·rms 모노스페이스 배지. peak가 정확히 0이면 "no signal (all zeros)" 경고(주황)로 센스 입력 미연결 가능성을 알린다. |
| `ChannelSelectDrawer.tsx` | 표시 항목을 고르는 드로어(공용 `overlay/SideDrawer` 셸). 항목을 메인 차트(`section: "metric"`)와 채널 목록(`section: "channel"`)으로 나누고 `parentId`가 있는 metric 항목은 부모 아래 들여쓴 하위 시리즈로 그린다(부모 미선택 시 disabled). `title`/`layer`(`"content"`\|`"overlay"`)/`safeAreaTop` 옵션으로 View 탭 드로어와 오버레이 양쪽에서 재사용된다. 채널 개수 배지는 공용 `ui/CountBadge`. |
| `ProtectedComparePanel.tsx` | Input L/R(반투명 가는 선)과 Protected L/R(진한 선) 4시리즈를 겹쳐 그리는 비교 카드. 데이터는 `useProtectedCompareStreams`의 4개 `ChannelWaveStore`이고 그리기는 uPlot 시리즈 paths를 비활성화(`paths: () => null`)한 채 `envelopeOverlayPlugin`이 스토어에서 직접 그린다. L/R/Both `SegmentedControl`과 View 탭의 `hiddenSeries`가 `seriesShow`로 합성돼 인스턴스 재생성 없이 토글되고 툴팁은 `virtualSeries`(스토어 `valueAt(t)`)로 만든다. 시리즈 색 상수 `COLOR_INPUT_L/R`·`COLOR_PROTECTED_L/R`을 export해 View 탭 항목과 색을 공유한다. |
| `hooks/useChannelWaveStreams.ts` | 채널별 `ChannelWaveStore` 맵과 세션 헤더(`channels`/`sampleRate`)를 소유하는 훅. 라이브 캡처 청크를 구독해 원하는 채널만 집계한다. 세션 도중 채널을 새로 체크하면 `getChannelsSnapshot()` 스냅숏을 128프레임 런(`BACKFILL_RUN_FRAMES`) 단위 × 4ms 슬라이스(`SLICE_BUDGET_MS`)로 나눠 백필한다(슬라이스 사이 `yieldToMain()`으로 메인 스레드 양보, 소요는 `envelope_backfill` perf 스테이지로 계측). `reset` 이벤트에 스토어·카운터를 전부 리셋한다. |
| `hooks/useProtectedCompareStreams.ts` | 비교 패널의 4개 스토어(inputL/R·protectedL/R)를 소유하는 훅. Input은 플레이어가 이미 디코드한 `DecodedPlayback`을 받아 채널 추출 없이 pcm-kit 커널로 바로 시딩한다(동기 실행 — 소요는 `envelope_seed` 스테이지로 계측). Protected는 캡처 스트림의 `protected` 이벤트를 실시간 누적하되 세션 도중 열리면 `getProtectedBlob()` WAV로 1회 백필한다(`wav-incremental`). 버킷 폭은 목표 1ms(`TARGET_BUCKET_SEC`)에서 시작해 스토어 상한(`MAX_WAVE_BUCKETS`의 99%) 안으로 잡는다. |

## 4. 의존성 및 흐름

이 도메인이 가져다 쓰는 모듈 (channel → 외부):

- `shared/components/UPlotChart.tsx` — 두 차트 부품의 uPlot 생명주기·리사이즈·줌 보존 래퍼. `ChannelWaveformCanvas`는 `source`(구독 기반) 모드, `ProtectedComparePanel`은 `data` 모드 + `seriesShow`(시리즈 토글)를 쓰고 둘 다 `yZoom`을 켠다.
- `lib/render/uplot-option.ts` — 축 빌더(`buildTimeAxis`/`buildValueAxis`)로 메인 차트와 같은 축 규약을 따른다.
- `lib/render/uplot-plugins/` — `zoomPlugin`/`tooltipPlugin`/`annotatePlugin`(Canvas), `envelopeOverlayPlugin`(Panel). `zoomPlugin`에는 둘 다 `getFullXRange`를 넘겨 더블클릭/줌아웃 리셋이 세션 전체로 돌아가게 한다.
- `lib/render/wave-store.ts` — `ChannelWaveStore`(두 훅의 집계 스토어), `MAX_WAVE_BUCKETS`.
- `lib/render/read-buffer.ts`·`raw-window.ts`·`chart-window.ts` — 뷰포트 읽기 버퍼(`createReadBuffer`), 원본 샘플 창 읽기(`readRawWindow`), Y 대칭 범위(`symmetricYRange`).
- `lib/render/annotation-store.ts` — 점 잇기 스토어 타입(Canvas의 `annotations` prop).
- `lib/codec/wav-incremental.ts` — Protected WAV 1회 백필(`peekWavHeader`/`decodeWavRange`).
- `lib/codec/playback-decode.ts` — `DecodedPlayback` 타입(Input 시딩 소스).
- `lib/engine/core.ts` — `CHANNELS`(스테레오 2ch 상수, 인터리브 분리 기준).
- `components/player/capture/types.ts` — `CaptureSnapshot`/`CaptureStreamEvent`/`CaptureStreamListener`.
- `components/chart/hooks/useThrottledStoreSnapshot.ts` — `ChannelStatsBadge`의 100ms(`READOUT_INTERVAL_MS`) 스로틀 readout.
- `shared/lib/iron-perf` — `recordPerfSample`/`envelopeModeSuffix`(시딩·백필 계측, pcm-kit A/B 모드 접미사).
- `shared/lib/yield-to-main.ts` — 백필 슬라이스 사이 메인 스레드 양보.
- `shared/components/overlay/SideDrawer.tsx`·`ui/CountBadge.tsx`·`ui/SegmentedControl.tsx`, `shared/lib/utils.ts`(`cn`), 외부 패키지 `uplot`·`lucide-react`.

이 도메인을 가져다 쓰는 모듈 (외부 → channel): `dashboard/` 4파일이 전부다.

- `dashboard/DashboardClient.tsx` — `useChannelWaveStreams` 호출(스토어·헤더 소유 지점), `DrawerEntry` 타입, `COLOR_*` 상수.
- `dashboard/DashboardViewGrid.tsx` — `ProtectedComparePanel` 배치, `ChannelStreamHeader` 타입.
- `dashboard/ChannelChartCard.tsx` — `ChannelWaveformCanvas`+`ChannelStatsBadge` 렌더.
- `dashboard/ViewDrawer.tsx` — `ChannelSelectDrawer` 재사용.

```
[라이브]  DuplexFilePlayer 캡처 스트림(subscribeCaptureStream)
   → useChannelWaveStreams: chunk → 원하는 채널만 ChannelWaveStore.addSamples()/flush()
   → ChannelChartCard(dashboard) → ChannelWaveformCanvas가 store 구독, 뷰포트만 readRange()
       (충분히 확대하면 CaptureSnapshot 원본 PCM을 readRawWindow()로 직접)

[백필]    세션 도중 채널을 새로 체크 → getChannelsSnapshot() 스냅숏을
   128프레임 런 × 4ms 슬라이스로 시딩 (yieldToMain으로 양보, envelope_backfill 계측)

[비교]    useProtectedCompareStreams: DecodedPlayback 시딩(Input, envelope_seed 계측)
   + protected 이벤트 실시간 누적 / WAV 1회 백필(Protected)
   → ProtectedComparePanel이 envelopeOverlayPlugin으로 4시리즈 직접 그리기
```

## 5. 주요 인터페이스 / 진입점

- `ChannelWaveformCanvas({ color, sampleRate, store, raw?, annotations?, isDrawEnabled? })` (named export) — 한 채널 파형. `raw`는 `ChannelRawSource`로, 확대 구간이 1컬럼당 원본 2샘플 미만일 때만 원본을 읽는다. 최소 가시 구간은 `16 / sampleRate` 초.
- `ChannelRawSource` (type) — `{ getSnapshot: () => CaptureSnapshot | null; channel: number }`. 확대 시 원본 샘플 공급원.
- `ChannelStatsBadge({ store })` (named export) — `store`의 peak/rms를 100ms 스로틀로 읽어 `ChannelLevelBadge`로 그린다. 샘플이 0개면 `null`.
- `ChannelLevelBadge({ peak, rms })` (named export) — peak·rms 배지. `peak === 0`이면 "no signal (all zeros)" 경고를 그린다.
- `ChannelSelectDrawer({ open, onClose, entries, selected, onToggle, title?, layer?, safeAreaTop? })` (default export) — 표시 항목 선택 드로어. `title` 기본값 "Display Items", `layer` 기본값 `"overlay"`.
- `DrawerEntry` (type) — `{ id; section: "metric" | "channel"; name; role; color; icon?; parentId? }`. `parentId`가 있으면 해당 부모 아래 하위 시리즈로 그려진다.
- `ProtectedComparePanel({ subscribeCaptureStream, sourceFile?, getDecodedPlayback?, decodeReady?, getProtectedBlob?, hiddenSeries })` (named export, `memo`) — 보호 전/후 비교 카드. `sourceFile`이 없으면 안내 문구, `decodeReady`가 true가 된 뒤에만 `getDecodedPlayback()`으로 Input을 시딩한다. `hiddenSeries`는 View 탭에서 내려오는 숨김 시리즈 인덱스(0~3) 집합.
- `COLOR_INPUT_L` / `COLOR_INPUT_R` / `COLOR_PROTECTED_L` / `COLOR_PROTECTED_R` (named 상수) — 4시리즈 색. View 탭 항목이 같은 색을 쓴다.
- `useChannelWaveStreams({ wantedChannels, listen, probe, getChannelsSnapshot?, subscribeChannelStream? })` → `{ header: ChannelStreamHeader | null, getStore(ch): ChannelWaveStore }` — 채널 스토어·헤더 소유 훅. `listen`이 true인 동안만 스트림을 구독하고 `probe`가 true면 스냅숏에서 헤더만 미리 읽는다.
- `ChannelStreamHeader` (type) — `{ channels: number; sampleRate: number }`.
- `useProtectedCompareStreams(options)` → `{ stores: PanelStores, input: InputMeta | null }` — 비교 패널 데이터 훅. `PanelStores`는 `{ inputL, inputR, protectedL, protectedR }`(각 `ChannelWaveStore`), `InputMeta`는 `{ durationSec, peakL, peakR }`.

## 6. 변경 이력(요약)
- 2026-07-10: 최초 작성 — `chart/`가 겸하던 "채널 파형 뷰" 부품 4종(`ChannelWaveformCanvas`(+`channelStats`)·`ChannelRowHeader`·`ChannelStackView`·`ChannelSelectDrawer`)을 별도 도메인 `components/channel/`으로 분리(chart·workspace가 단방향 참조). `ChannelRowHeader`는 두 오버레이의 중복 헤더를 통합해 신설, 드로어/오버레이 셸은 공용 `shared/components/overlay`·`ui`로 위임 (커밋 범위: 537099f..HEAD, 워크트리 포함)
- 2026-07-20: `ChannelWaveformCanvas`에 확대 시 포인트 심볼 표시 기능 추가 — 줌 구간 안 포인트 수가 `SYMBOL_VISIBLE_MAX` 이하면 각 샘플에 점을 찍어 간격을 보여주고 LTTB/large 샘플링을 끈다. 섹션 3·4 부분 갱신 (커밋 범위: 9f08d59..fb8e4fa)
- 2026-07-27: ECharts → uPlot 이관 + 부품 재편 반영 — `ChannelWaveformCanvas`/`ProtectedComparePanel`이 공용 `shared/components/UPlotChart` 래퍼 기반으로 교체(줌은 드래그/휠/더블클릭, 과거 구간 fetch는 `onUserZoom` 초 단위 콜백, 비교 패널의 L/R/Both는 `seriesShow` 토글). `ProtectedComparePanel`을 이 도메인 문서에 편입(§3·4·5), `channelStats`는 `lib/render/waveform.ts` 소속으로 정정. 섹션 1·3·4·5 부분 갱신 (커밋 범위: 14941b7..HEAD, 워크트리 포함)
- 2026-07-27(2): 두 컴포넌트의 드래그·휠 줌이 실제로는 항상 무효화되던 버그 수정 — `UPlotChart`의 x축 커스텀 `range()` 콜백이 xRange(고정 도메인) prop이 있을 때 사용자의 드래그/휠 줌 결과까지 그 고정 도메인으로 되돌려버렸다. `wheelZoomPlugin` → `zoomPlugin`으로 개칭하고 `getFullXRange` 옵션을 추가해 "로드된 데이터가 아니라 세션 전체로 리셋"하는 책임을 플러그인 쪽으로 옮기고, `UPlotChart`의 x축 range() 콜백 자체는 제거(uPlot 기본 동작만 사용). 섹션 3·4 부분 갱신 (커밋 범위: 워크트리, 미커밋)
- 2026-07-30: `ChannelWaveformCanvas`에서 LTTB 다운샘플링과 확대 구간 원본 재디코딩(`fetchRange` prop, `onUserZoom`, 200ms 디바운스 fetch)을 전부 제거 — 이제 `ChannelWaveStore`의 세션 전체 엔벨로프를 source 구독으로 받아 그대로 그린다. 줌은 인자 없는 기본 `zoomPlugin()`만 쓴다(Temperature/ExcursionChart와 동일 패턴). `ProtectedComparePanel`은 uPlot 기본 범례를 끄고(`legend: { show: false }`) 시리즈 라벨을 직접 클릭하는 커스텀 토글(`hiddenSeries`/`toggleSeries`)로 바꿨다. 켜짐="뚜렷하게"/꺼짐="흐릿하게"가 명확히 드러난다(과거 uPlot 기본 범례의 체크박스형 마커 UX 개선). 다섯 부품 전체가 `shared/lib/i18n`의 `useLocale()`에 새로 의존한다(하드코딩 영문 문자열 → `t.*` 메시지 키). 신설 named export `ChannelStatsBadge`를 섹션 5에 추가. 섹션 1·3·4·5 부분 갱신 (기준: 워크트리, 미커밋)
- 2026-08-19: 스택 뷰 해체 — 소비자였던 `ChartDetailOverlay`(실시간 상세 뷰)와 `ChannelViewerOverlay`(저장 세션 뷰)가 코드에서 제거되고 대시보드 View 그리드가 유일한 소비자가 되면서 `ChannelRowHeader`/`ChannelStackView`(+`StackItem`)를 삭제(행 머리는 `dashboard/ChannelChartCard`가 직접 그림). 데이터 소유를 컴포넌트 밖 훅으로 이관 — `hooks/useChannelWaveStreams`(채널별 `ChannelWaveStore` + 128프레임 런 × 4ms 슬라이스 백필 + `envelope_backfill` 계측)와 `hooks/useProtectedCompareStreams`(Input/Protected 4스토어, `DecodedPlayback` 시딩 + WAV 백필) 신설. `ChannelWaveformCanvas`는 세션 전체 커밋에서 뷰포트 `readRange()` + 확대 시 원본 샘플(`raw`) 읽기로, `ProtectedComparePanel`은 `BucketEnvelope`/`envelopesToAligned` 집계에서 `envelopeOverlayPlugin` 직접 그리기로 재편(View 탭 `hiddenSeries` 연동, `bare` prop 제거). `ChannelSelectDrawer`는 `parentId` 계층·`title`/`layer`/`safeAreaTop` prop을 얻고 `loading`/`error` prop을 잃음. `ChannelLevelBadge` 신설(전 구간 0 신호 경고). 2026-07-30 항목의 i18n(`useLocale`) 의존은 92fbb5a에서 회귀 제거돼 문구가 다시 하드코딩 영문이다. 섹션 1·2·3·4·5 갱신 (커밋 범위: 4d86f32..24d1daa)
