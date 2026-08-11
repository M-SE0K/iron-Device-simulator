# channel

## 1. 도메인 설명

캡처된 다채널 오디오를 채널 하나하나의 파형으로 그려 보여주는 도메인이다. 개발자는 이 폴더만 읽고도 ch0(V)·ch1(I)와 확장 채널을 어떻게 개별 파형으로 그리는지, 표시할 채널은 사용자가 어떻게 고르는지 파악한다. 대시보드 View 그리드와 저장 세션 뷰(`workspace/ChannelViewerOverlay`)가 똑같이 쓰던 채널 파형 조각들을 한곳에 모아 두 소비자가 같은 부품을 공유하게 떼어낸 결과다.

부품은 네 가지에 훅 하나다. `ChannelWaveformCanvas`는 한 채널을 uPlot 차트로 그리는데, 줌 레벨에 따라 **두 해상도를 오간다** — 축소 구간은 `ChannelWaveStore`의 세션 전체 min/max 엔벨로프를, 확대 구간은 캡처 원본 PCM을 직접 슬라이스한 개별 샘플을 그린다. `ChannelRowHeader`가 그리는 것은 채널 행 머리, 곧 색 점 + 이름 + 역할 + peak·rms 배지다. `ChannelSelectDrawer`는 표시 항목(메인 차트 + 채널 목록)을 체크로 고르는 우측 드로어다. `ProtectedComparePanel`은 원본 입력과 보호 감쇠 후 신호(엔진이 `buf`를 되쓴 결과)를 L/R 채널별 엔벨로프로 겹쳐 비교한다. 여기에 `hooks/useChannelWaveStreams`가 채널별 스토어 소유와 백필·라이브 구독을 맡는다.

부품 네 개는 데이터를 소유하지 않는다. 소비자가 채널 스토어와 선택 상태를 내려주면 이 도메인은 그리기와 상호작용만 맡는다. 표시 텍스트는 전부 컴포넌트 안에 영문으로 박혀 있다 — i18n 배선은 되돌려졌다.

## 2. 프로젝트 전반에서의 역할

캡처 파이프라인이 만든 다채널 PCM을 사람이 눈으로 읽는 파형으로 바꾸는 표시 계층이다. 스스로 마운트되는 일은 없다. 두 상위 화면이 부품으로 조립해 쓴다.

- `dashboard/`(실시간 View 그리드)가 주 소비자다. `DashboardClient`가 `useChannelWaveStreams`로 채널별 스토어를 소유한다. 표시 항목은 `ViewDrawer`가 `ChannelSelectDrawer`로 고르고 `DashboardViewGrid`가 선택된 항목을 그리드에 배치한다. 채널 카드 한 칸은 `ChannelChartCard`가 카드 셸을 만들고 그 안에 `ChannelWaveformCanvas`를 담는다. 채널 데이터는 캡처 청크가 도착할 때마다 push되는 실시간 스트림이다.
- `workspace/ChannelViewerOverlay`(저장 세션 뷰)는 저장된 N채널 WAV를 채널별로 디코딩해 `ChannelWaveformCanvas` + `ChannelRowHeader`로 그린다. 이쪽은 실시간 push도 원본 PCM 직독도 없이 정적 버퍼를 스토어에 담아 넘긴다.
- 채널 의미(ch0=V/ch1=I/ch2 이후 확장)와 색은 이 도메인이 정하지 않는다. 단일 소스는 `lib/render/channel-meta.ts`의 `channelLabel()`/`channelColor()`다. 소비자가 그 결과를 props로 넘긴다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `ChannelWaveformCanvas.tsx` | 한 채널을 uPlot 차트(`UPlotChart` 래퍼)에 그린다. 픽셀당 샘플 수가 `RAW_SAMPLES_PER_PX`(2) 이상이면 `ChannelWaveStore.readAligned()`의 세션 전체 엔벨로프를, 그보다 확대하면 `readRawWindow()`로 캡처 원본 PCM을 직접 읽어 개별 샘플을 그린다. 원본 소스(`raw`)가 없으면 조용히 엔벨로프만 쓴다. 줌아웃·더블클릭 복원 기준은 커밋 데이터의 extent가 아니라 스토어의 세션 길이(`getFullXRange`)이고, 확대 하한은 화면에 `MIN_VISIBLE_SAMPLES`(16)개가 남는 지점이다. Y축은 절대 피크 기준 대칭(`computeSymmetricYRange`)이고 y축 줌은 `yZoom`으로 켠다. 점 잇기 주석은 `annotations`/`isDrawEnabled`가 함께 넘어올 때만 `annotatePlugin`을 단다. |
| `ChannelRowHeader.tsx` | 채널 행 머리 내용(색 점 + 채널명(mono) + 역할 + 레벨 배지)만 Fragment로 그린다. 바깥 컨테이너는 소비자마다 달라 여기서 감싸지 않는다. 함께 내보내는 `ChannelLevelBadge`는 두 가지 표시 규칙을 갖는다 — 값이 `1e-4` 미만이면 지수 표기로 바꿔 살아있는 미약한 신호가 `0.0000`으로 뭉개지지 않게 하고, 피크가 **정확히** 0이면 숫자 대신 `no signal (all zeros)` 경고를 띄워 센스 배선이 빠진 채널을 아주 조용한 채널과 구분해 준다. |
| `ChannelSelectDrawer.tsx` | 표시 항목을 고르는 우측 드로어(공용 `overlay/SideDrawer` 위). 항목을 메인 차트(`section: "metric"`)와 채널 목록(`section: "channel"`)으로 나눠 체크 방식으로 추가·제거한다. `parentId`를 가진 항목은 상위 항목 바로 아래 들여쓴 하위 토글로 그려지고 상위가 꺼져 있으면 비활성이다(예: Protected 카드 아래의 Input/Protected L·R). 헤더 배지가 세는 것은 최상위 항목만이다 — 이 숫자는 "카드가 몇 개 떠 있나"를 뜻하고 하위 토글은 카드 안의 표시 항목이기 때문이다. 셸은 `SideDrawer`, 채널 개수 배지는 공용 `ui/CountBadge`에 위임하며, `title`/`layer`로 상세 뷰용·대시보드 View 탭용을 같은 부품으로 쓴다. |
| `ProtectedComparePanel.tsx` | 원본 입력(무채색)과 보호 감쇠 후 신호(유채색)를 L/R 채널별로 겹쳐 그리는 비교 패널. 두 시리즈 쌍의 데이터 경로가 다르다. Input은 `sourceFile`을 `decodeAudioData`로 통째 디코딩해 길이 기준으로 버킷 수를 한 번에 정한 정적 `BucketEnvelope`(목표 1 ms/버킷, 상한 `MAX_INPUT_BUCKETS` 50,000)로 채우고, Protected는 캡처 스트림의 `protected` 이벤트를 자기 `ChannelWaveStore`(초기 버킷 1 ms)에 실시간 누적한다. Input은 변하지 않으니 `staticSeriesLayerPlugin([1, 2])`으로 캔버스에 캐시하고, Protected는 `u.data`에 실데이터를 싣지 않고(`paths: () => null` + 빈 플레이스홀더 컬럼) `liveEnvelopeOverlayPlugin`이 스토어를 직접 읽어 그린다 — 라이브 갱신이 `setData()` 비용을 타지 않는다. 툴팁은 그 두 시리즈를 `virtualSeries`로 받아 `store.valueAt(t)`로 값을 조회한다. 패널을 세션 도중 열면 `getProtectedBlob` WAV로 1회 백필하고, 백필이 끝나기 전 도착한 라이브 프레임은 대기열에 담아 잃지 않는다. L/R/Both는 패널 자체의 `SegmentedControl`, 시리즈별 on/off는 소비자가 내려주는 `hiddenSeries`이고 둘의 논리곱이 `UPlotChart`의 `seriesShow`로 나간다. 디코딩 실패는 `useErrorPopup`으로 전역 팝업에 올린다. |
| `hooks/useChannelWaveStreams.ts` | 채널별 `ChannelWaveStore` 소유 + 백필·라이브 구독을 맡는 공용 훅. 채널을 새로 선택한 순간 `getChannelsSnapshot()`으로 세션 시작~현재를 1회 백필하고, 그 뒤로는 청크 구독으로 이어붙인다. 백필 루프는 한 번에 `SLICE_BUDGET_MS`(4 ms)까지만 메인 스레드를 붙잡고 `yieldToMain()`으로 양보한다 — 캡처 콜백 주기(48 kHz/480 samples에서 10 ms)의 절반 이하라 분석·차트 커밋이 밀리지 않는다. 백필 단위는 이펙트가 아니라 **배치**다: 다른 채널을 추가 선택해도 진행 중인 배치를 취소하지 않으므로 그 채널의 앞부분이 비는 일이 없고, 중단은 채널이 선택 해제됐거나 세션이 리셋됐을 때만 일어난다. 인터리브 데이터를 프레임 바깥·채널 안쪽으로 훑어 같은 구간을 채널 수만큼 다시 읽지 않는다. |

## 4. 의존성 및 흐름

이 도메인이 가져다 쓰는 모듈 (channel → 외부):

- `shared/components/UPlotChart.tsx` — 두 차트 부품(`ChannelWaveformCanvas`/`ProtectedComparePanel`)의 uPlot 인스턴스 생명주기·리사이즈·줌 보존 래퍼. `ChannelWaveformCanvas`는 `source`(구독 기반, 뷰포트를 인자로 받는 `read(view)`) 모드, `ProtectedComparePanel`은 `data`(React 상태) 모드 + `seriesShow`를 쓴다. 둘 다 `yZoom`을 켠다.
- `lib/render/uplot-option.ts` — 축 빌더(`buildTimeAxis`/`buildValueAxis`)로 메인 차트와 같은 축 규약을 따른다.
- `lib/render/uplot-plugins/` — `zoomPlugin`/`tooltipPlugin`/`annotatePlugin`(파형), `staticSeriesLayerPlugin`/`liveEnvelopeOverlayPlugin`(비교 패널). 두 차트 모두 `zoomPlugin`에 `getFullXRange`를 넘겨 "로드된 데이터가 아니라 세션 전체로 리셋"을 보장한다. 파형은 여기에 `minXRange`(= `16 / sampleRate`)로 확대 하한까지 준다.
- `lib/render/wave-store.ts` — `ChannelWaveStore`. 파형의 세션 엔벨로프 입력이자 비교 패널의 Protected 트레이스 저장소다(생성 시 초기 버킷 폭을 인자로 받는다).
- `lib/render/raw-window.ts` / `read-buffer.ts` — 확대 구간 원본 PCM 직독(`readRawWindow`)과 그 결과를 담는 재사용 버퍼(`createReadBuffer`). 버퍼는 캔버스가 하나 소유해 매 커밋 재사용한다.
- `lib/render/envelope.ts` — `BucketEnvelope`와 컬럼 헬퍼(`buildBucketXs`/`fillEnvelopeColumn`/`emptyEnvelopeColumn`). `ProtectedComparePanel` 전용.
- `lib/render/protected-series.ts` — 비교 패널 네 시리즈의 색상 상수.
- `lib/render/chart-window.ts` — `computeSymmetricYRange`(두 차트의 y축 대칭 범위).
- `lib/render/annotation-store.ts` — `AnnotationStore` 타입(파형이 플러그인에 넘기는 주석 스토어).
- `lib/codec/wav-incremental.ts` — `ProtectedComparePanel`의 감쇠 PCM 1회 백필(`peekWavHeader`/`decodeWavRange`).
- `lib/engine/core.ts` — `INT16_SCALE`/`BYTES_PER_SAMPLE`/`CHANNELS`(int16 → float 환산·채널 분리).
- `player/capture/types.ts` — `CaptureSnapshot`/`CaptureStreamEvent`/`CaptureStreamListener` 타입. 원본 PCM과 스트림 이벤트의 모양이 캡처 세션 소유이기 때문이다.
- `chart/hooks/useThrottledStoreSnapshot.ts` — 헤더 배지 숫자만 낮은 빈도로 읽는 리드아웃(메인 차트와 같은 주기).
- `shared/components/overlay/SideDrawer.tsx` / `ui/CountBadge.tsx` / `ui/SegmentedControl.tsx` / `shared/lib/utils.ts`(`cn`) / `shared/lib/yield-to-main.ts` / `shared/components/error-popup/ErrorPopupContext.tsx`.
- 외부 패키지 — `uplot`(공용 래퍼 경유), `lucide-react`.

이 도메인을 가져다 쓰는 모듈 (외부 → channel):

- `dashboard/DashboardClient.tsx` — `useChannelWaveStreams`로 채널 스토어를 소유하고 `ChannelSelectDrawer`의 항목 목록(`DrawerEntry[]`)을 구성한다.
- `dashboard/ViewDrawer.tsx` — `ChannelSelectDrawer`를 대시보드 View 탭 레이어(`layer="content"`)로 띄운다.
- `dashboard/DashboardViewGrid.tsx` — `ProtectedComparePanel`과 `useChannelWaveStreams`를 써서 선택된 카드를 그리드에 배치한다.
- `dashboard/ChannelChartCard.tsx` — 채널 카드 셸 + `ChannelWaveformCanvas`/`ChannelStatsBadge`. 헤더는 자체 마크업이라 `ChannelRowHeader`를 쓰지 않는다.
- `workspace/ChannelViewerOverlay.tsx` — `ChannelWaveformCanvas` + `ChannelRowHeader`(저장 WAV 채널별 렌더, peak/rms는 `lib/render/waveform.ts`의 `channelStats`로 계산).

내부 흐름은 거의 없다. 네 부품은 서로를 import하지 않는다(파형이 `ChannelRowHeader`의 `ChannelLevelBadge`를 배지로 재사용하는 것만 예외). 조립은 전적으로 소비자 몫이다.

```
[실시간]  DashboardClient (useChannelWaveStreams: 스토어 소유 + 백필/구독)
   → ViewDrawer → ChannelSelectDrawer(표시 항목 선택)
   → DashboardViewGrid → 채널 카드마다 ChannelChartCard
       → ChannelWaveformCanvas: 축소 = 스토어 엔벨로프 / 확대 = 캡처 원본 PCM 직독

[비교]    DashboardViewGrid → ProtectedComparePanel
   → Input: 파일 디코딩 → 정적 BucketEnvelope → staticSeriesLayerPlugin이 캐시
   → Protected: capture stream "protected" 이벤트 → ChannelWaveStore → liveEnvelopeOverlayPlugin이 직접 그리기

[저장]    ChannelViewerOverlay
   → WAV 채널별 디코딩 → ChannelRowHeader(channelStats) + ChannelWaveformCanvas(정적 버퍼를 스토어에 담아 구독)
```

## 5. 주요 인터페이스 / 진입점

- **`ChannelWaveformCanvas(props)`** (named export) — `{ color: string; sampleRate: number; store: ChannelWaveStore; raw?: ChannelRawSource; annotations?: AnnotationStore; isDrawEnabled?: () => boolean }`. 한 채널 파형을 그린다. `raw`를 넘기면 확대 시 개별 샘플까지 보이고, 생략하면 엔벨로프 해상도까지만 보인다. ⚠️ `isDrawEnabled`는 참조가 안정된 함수여야 한다 — 옵션에 박히므로 매 렌더 새 함수를 넘기면 인스턴스가 재생성되며 줌 상태를 잃는다.
- **`ChannelRawSource`** (type) — `{ getSnapshot: () => CaptureSnapshot | null; channel: number }`. 원본 PCM 직독 소스. 라이브 캡처 세션에만 있다.
- **`ChannelStatsBadge({ store })`** (named export) — 스토어의 **세션 누적** peak/rms 배지. 샘플이 0개면 `null`을 반환한다.
- **`ChannelRowHeader({ color, name, role, stats? })`** (default export) — 채널 행 머리 내용(Fragment). `stats`(`{ peak, rms }`)가 있을 때만 우측 배지를 그린다.
- **`ChannelLevelBadge({ peak, rms })`** (named export) — 레벨 배지 단독 사용. 파형 쪽 `ChannelStatsBadge`와 표시 규칙을 공유한다.
- **`ChannelSelectDrawer({ open, onClose, entries, selected, onToggle, loading?, error?, title?, layer?, safeAreaTop? })`** (default export) — 표시 항목 선택 드로어. `entries`는 `DrawerEntry[]`, `selected`는 선택된 id `Set`, `onToggle(id)`로 추가·제거한다. `title` 기본값은 `"Display Items"`, `layer` 기본값은 `"overlay"`(대시보드 View 탭은 `"content"`).
- **`DrawerEntry`** (type) — `{ id; section: "metric" | "channel"; name; role; color; icon?; parentId? }`. `parentId`를 주면 그 항목 아래 들여쓴 하위 토글이 된다(같은 `section` 안에서만).
- **`ProtectedComparePanel(props)`** (named export, `memo`) — `{ subscribeCaptureStream: (fn: CaptureStreamListener) => () => void; sourceFile?: File | null; getProtectedBlob?: () => Blob | null; bare?: boolean; hiddenSeries: Set<number> }`. 보호 감쇠 전/후 비교 패널. `hiddenSeries`의 인덱스는 0=Input L, 1=Input R, 2=Protected L, 3=Protected R이다. `sourceFile`이 없으면 안내 문구만 보여주고, `bare`가 true면 카드 셸 없이 본문만 그린다.
- **`useChannelWaveStreams(options)`** — `{ wantedChannels: number[]; listen: boolean; probe: boolean; getChannelsSnapshot?; subscribeChannelStream?; onSessionReset? }`를 받아 `{ header, channelError, getStore }`를 돌려준다. `wantedChannels`에서 빠진 채널은 스토어와 시드 표시가 지워지므로, 다시 선택하면 세션 전체를 처음처럼 다시 백필한다. `header`(`ChannelStreamHeader` = `{ channels, sampleRate }`)에 세션 길이는 담지 않는다 — 청크마다 늘어나는 값이라 상태로 두면 초당 100번 리렌더되고, 필요한 쪽은 스토어 스냅샷에서 직접 읽는다.

## 6. 변경 이력(요약)

- 2026-07-10: 최초 작성 — `chart/`가 겸하던 "채널 파형 뷰" 부품 4종(`ChannelWaveformCanvas`(+`channelStats`)·`ChannelRowHeader`·`ChannelStackView`·`ChannelSelectDrawer`)을 별도 도메인 `components/channel/`으로 분리(chart·workspace가 단방향 참조). `ChannelRowHeader`는 두 오버레이의 중복 헤더를 통합해 신설, 드로어/오버레이 셸은 공용 `shared/components/overlay`·`ui`로 위임 (커밋 범위: 537099f..HEAD, 워크트리 포함)
- 2026-07-20: `ChannelWaveformCanvas`에 확대 시 포인트 심볼 표시 기능 추가 — 줌 구간 안 포인트 수가 `SYMBOL_VISIBLE_MAX` 이하면 각 샘플에 점을 찍어 간격을 보여주고 LTTB/large 샘플링을 끈다. 섹션 3·4 부분 갱신 (커밋 범위: 9f08d59..fb8e4fa)
- 2026-07-27: ECharts → uPlot 이관 + 부품 재편 반영 — `ChannelWaveformCanvas`/`ProtectedComparePanel`이 공용 `shared/components/UPlotChart` 래퍼 기반으로 교체(줌은 드래그/휠/더블클릭, 과거 구간 fetch는 `onUserZoom` 초 단위 콜백, 비교 패널의 L/R/Both는 `seriesShow` 토글). `ProtectedComparePanel`을 이 도메인 문서에 편입(§3·4·5), `channelStats`는 `lib/render/waveform.ts` 소속으로 정정. 섹션 1·3·4·5 부분 갱신 (커밋 범위: 14941b7..HEAD, 워크트리 포함)
- 2026-07-27(2): 두 컴포넌트의 드래그·휠 줌이 실제로는 항상 무효화되던 버그 수정 — `UPlotChart`의 x축 커스텀 `range()` 콜백이 xRange(고정 도메인) prop이 있을 때 사용자의 드래그/휠 줌 결과까지 그 고정 도메인으로 되돌려버렸다. `wheelZoomPlugin` → `zoomPlugin`으로 개칭하고 `getFullXRange` 옵션을 추가해 "로드된 데이터가 아니라 세션 전체로 리셋"하는 책임을 플러그인 쪽으로 옮기고, `UPlotChart`의 x축 range() 콜백 자체는 제거(uPlot 기본 동작만 사용). 섹션 3·4 부분 갱신 (커밋 범위: 워크트리, 미커밋)
- 2026-07-30: `ChannelWaveformCanvas`에서 LTTB 다운샘플링과 확대 구간 원본 재디코딩(`fetchRange` prop, `onUserZoom`, 200ms 디바운스 fetch)을 전부 제거 — 이제 `ChannelWaveStore`의 세션 전체 엔벨로프를 source 구독으로 받아 그대로 그린다. 줌은 인자 없는 기본 `zoomPlugin()`만 쓴다(Temperature/ExcursionChart와 동일 패턴). `ProtectedComparePanel`은 uPlot 기본 범례를 끄고(`legend: { show: false }`) 시리즈 라벨을 직접 클릭하는 커스텀 토글(`hiddenSeries`/`toggleSeries`)로 바꿨다. 켜짐="뚜렷하게"/꺼짐="흐릿하게"가 명확히 드러난다(과거 uPlot 기본 범례의 체크박스형 마커 UX 개선). 다섯 부품 전체가 `shared/lib/i18n`의 `useLocale()`에 새로 의존한다(하드코딩 영문 문자열 → `t.*` 메시지 키). 신설 named export `ChannelStatsBadge`를 섹션 5에 추가. 섹션 1·3·4·5 부분 갱신 (기준: 워크트리, 미커밋)
- 2026-08-11: 부품 재편 + 2단 해상도 파형 반영. `ChannelStackView.tsx`가 삭제되고(소비자였던 `chart/ChartDetailOverlay`도 함께 사라졌다) 조립 책임이 대시보드 View 그리드로 넘어갔다 — 이 도메인의 소비자는 이제 `dashboard/`(DashboardClient·ViewDrawer·DashboardViewGrid·ChannelChartCard)와 `workspace/ChannelViewerOverlay`다. `hooks/useChannelWaveStreams.ts`가 신설되어 채널 스토어 소유·시간 예산 기반 백필·라이브 구독을 맡는다. `ChannelWaveformCanvas`는 확대 시 `readRawWindow()`로 캡처 원본 PCM을 직접 읽는 두 번째 해상도를 얻었다(`raw`/`annotations`/`isDrawEnabled` prop 추가). `ChannelRowHeader`는 지수 표기와 "전부 0" 경고를 담은 `ChannelLevelBadge`를 함께 내보낸다. `ChannelSelectDrawer`는 `parentId` 하위 토글과 `title`/`layer` prop을 얻었다. `ProtectedComparePanel`은 Input을 `staticSeriesLayerPlugin`으로 캐시하고 Protected를 `liveEnvelopeOverlayPlugin`으로 그리는 구조로 바뀌면서 시리즈 on/off 소유권을 `hiddenSeries` prop으로 넘겼다(`envelopesToAligned` → `buildBucketXs`/`fillEnvelopeColumn`, Input 버킷은 고정 1000개에서 1 ms 목표·상한 50,000개로). 2026-08-03 `92fbb5a`에서 i18n 배선이 되돌려져 표시 텍스트는 다시 컴포넌트 내 영문 하드코딩이다 — §1·§3·§4·§5의 `useLocale()`/`t.*` 서술을 전부 걷어냈다. 섹션 1·2·3·4·5 부분 갱신 (커밋 범위: 4d86f32..HEAD, 작업 트리 포함)
