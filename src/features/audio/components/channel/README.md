# channel

## 1. 도메인 설명

캡처된 다채널 오디오를 채널 하나하나의 파형으로 그려 보여주는 도메인이다. 개발자는 이 폴더만 보면 "ch0(V)·ch1(I)와 확장 채널을 어떻게 개별 파형으로 그리고, 사용자가 어떤 채널을 스택에 올릴지 어떻게 고르는가"를 파악할 수 있다. 실시간 상세 뷰(`chart/ChartDetailOverlay`)와 저장 세션 뷰(`workspace/ChannelViewerOverlay`)가 똑같이 쓰던 "채널 파형" 조각들을 한곳에 모아, 두 소비자가 같은 부품을 공유하도록 떼어낸 것이다.

다섯 가지 부품으로 나뉜다. `ChannelWaveformCanvas`는 한 채널을 LTTB(Largest-Triangle-Three-Buckets) 단일 선으로 줌 가능한 uPlot 차트에 그린다. 과거 구간은 온디맨드로 디코딩해 채운다. `ChannelRowHeader`는 채널 행 머리(색 점 + 이름 + 역할 + peak·rms 배지)를 그린다. `ChannelStackView`는 여러 채널 패널을 드래그로 재배치하고 높이를 조절하는 세로 스택을 만든다. `ChannelSelectDrawer`는 스택에 올릴 항목(메인 차트 + 채널 목록)을 체크로 고르는 우측 드로어다. `ProtectedComparePanel`은 원본 입력과 보호 감쇠 후 신호(엔진이 buf를 되쓴 결과)를 L/R 채널별 엔벨로프로 겹쳐 비교한다. 다섯 부품 모두 데이터를 소유하지 않는다 — 소비자가 채널 버퍼와 선택 상태를 내려주고 이 도메인은 그리기와 상호작용만 맡는다.

## 2. 프로젝트 전반에서의 역할

이 도메인은 캡처 파이프라인이 만든 다채널 PCM을 사람이 눈으로 읽는 파형으로 바꾸는 표시 계층이며, 직접 마운트되지 않고 두 상위 화면에 부품으로 조립된다.

- `chart/ChartDetailOverlay`(실시간 상세 뷰)는 `ChannelSelectDrawer`로 표시 항목을 고르고, 선택된 채널마다 `ChannelWaveformCanvas`를 `ChannelStackView` 스택에 얹으며, 각 패널 머리에 `ChannelRowHeader`를 쓴다. 채널 데이터는 캡처 청크가 도착할 때마다 push되는 실시간 윈도우다.
- `workspace/ChannelViewerOverlay`(저장 세션 뷰)는 저장된 N채널 WAV를 채널별로 디코딩해 `ChannelWaveformCanvas` + `ChannelRowHeader`로 그린다. 이쪽은 실시간 push 없이 정적 버퍼를 통째로 넘긴다.
- 채널 의미(ch0=V/ch1=I/ch2 이후 확장)와 색은 이 도메인이 정하지 않는다 — `lib/render/channel-meta.ts`의 `channelLabel()`/`channelColor()`가 단일 소스이고, 소비자가 그 결과를 `ChannelRowHeader`/`ChannelWaveformCanvas`에 props로 넘긴다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `ChannelWaveformCanvas.tsx` | 한 채널을 LTTB 단일 선으로 줌 가능한 uPlot 차트(`UPlotChart` 래퍼)에 그린다. 실시간 윈도우(`liveWindow`)를 기본으로 그리다가 사용자가 드래그/휠 줌으로 라이브 윈도우 밖(과거)을 확대하면 그 구간만 `fetchRange`로 온디맨드 디코딩해 채운다(줌 콜백은 `UPlotChart`의 `onUserZoom` — 초 단위 min/max를 직접 받으며 스트리밍 setData가 일으키는 내부 리스케일에는 반응하지 않는다. 200ms 디바운스). Y축 범위는 원본 절대 피크를 기준으로 대칭으로 잡는다. LTTB가 놓칠 수 있는 전역 피크가 잘리지 않게 다운샘플 전 원본으로 계산한다. 확대로 포인트 간격이 벌어지면 uPlot 내장 points 동작이 점을 자동 표시한다. |
| `ChannelRowHeader.tsx` | 채널 행 머리 내용(색 점 + 채널명(mono) + 역할 + peak·rms 배지)만 Fragment로 그린다. 바깥 컨테이너(div/Fragment)는 소비자마다 달라 여기서 감싸지 않는다. `stats`가 없으면 배지를 숨긴다(라이브 데이터 미도착 등). |
| `ChannelStackView.tsx` | 여러 채널 패널을 세로로 쌓고 드래그로 재배치·리사이즈하는 스택. 각 항목은 `StackItem`(머리·본문·기본/최소/최대 높이)이고, 재배치가 끝나면 보이는 항목들의 새 id 순서를 `onReorder`로 통째로 올려보낸다. 항목이 없으면 `emptyLabel`을 보여준다. |
| `ChannelSelectDrawer.tsx` | 스택에 올릴 표시 항목을 고르는 우측 드로어(공용 `overlay/SideDrawer` 위, `layer="overlay"`). 항목을 메인 차트(`section: "metric"`)와 채널 목록(`section: "channel"`)으로 나눠 체크 방식으로 추가·제거한다. 셸(백드롭·패널·헤더)은 `SideDrawer`, 채널 개수 배지는 공용 `ui/CountBadge`에 위임한다. |
| `ProtectedComparePanel.tsx` | 원본 입력(옅은 점선)과 보호 감쇠 후 신호(진한 실선)를 L/R 채널별로 겹쳐 그리는 비교 패널. 원본은 `sourceFile`을 `decodeAudioData`로 통째 디코딩해 1000버킷 엔벨로프(`BucketEnvelope`)로, 감쇠 후 신호는 캡처 스트림의 `protected` 이벤트를 같은 버킷에 실시간 누적해 그린다(패널을 세션 도중 열면 `getProtectedBlob` WAV로 1회 백필). 네 시리즈가 같은 버킷 격자를 공유하므로 `envelopesToAligned`로 x축 하나의 aligned 데이터를 만들고 L/R/Both 토글은 `UPlotChart`의 `seriesShow`로 인스턴스 재생성 없이 반영한다. |

## 4. 의존성 및 흐름

이 도메인이 가져다 쓰는 모듈 (channel → 외부):

- `shared/components/UPlotChart.tsx` — 두 차트 부품(`ChannelWaveformCanvas`/`ProtectedComparePanel`)의 uPlot 인스턴스 생명주기·리사이즈·줌 보존 래퍼. 채널 파형은 `onUserZoom`(사용자 줌만 초 단위로 수신), 비교 패널은 `seriesShow`(시리즈 토글)를 쓴다.
- `lib/render/uplot-option.ts` — 축 빌더(`buildTimeAxis`/`buildValueAxis`)와 시간 소수점 헬퍼(`timeDecimalsForInterval`)로 메인 차트와 같은 축 규약을 따른다.
- `lib/render/uplot-plugins.ts` — `zoomPlugin`/`tooltipPlugin`(메인 차트와 같은 줌·툴팁 규약). 두 컴포넌트 모두 `zoomPlugin`에 `getFullXRange`(세션 전체 길이를 돌려주는 안정된 getter)를 넘긴다 — 로드된 데이터가 세션 전체보다 짧을 때도(예: 라이브 윈도우) 휠 줌아웃·더블클릭 리셋이 "로드된 구간"이 아니라 "세션 전체"로 돌아가게 하기 위함.
- `lib/render/envelope.ts` — `BucketEnvelope`(버킷 min/max 누적)와 `envelopesToAligned`(엔벨로프들 → 공유 x축 aligned 데이터). `ProtectedComparePanel` 전용.
- `lib/render/waveform.ts` — `WaveformWindow` 타입(`ChannelWaveformCanvas`의 실시간 윈도우 입력).
- `lib/codec/wav-incremental.ts` — `ProtectedComparePanel`의 감쇠 PCM 1회 백필(`peekWavHeader`/`decodeWavRange`).
- `lib/engine/core.ts` — `INT16_SCALE`/`CHANNELS`(`ProtectedComparePanel`의 int16 → float 환산·채널 분리).
- `shared/components/overlay/SideDrawer.tsx` — `ChannelSelectDrawer`의 슬라이드 드로어 셸.
- `shared/components/ui/CountBadge.tsx` — `ChannelSelectDrawer` 채널 개수 배지.
- `shared/components/ui/SegmentedControl.tsx` — `ProtectedComparePanel`의 L/R/Both 토글.
- `shared/lib/utils.ts` — `cn`(클래스 병합).
- 외부 패키지 — `uplot`(공용 래퍼 경유), `lucide-react`.

이 도메인을 가져다 쓰는 모듈 (외부 → channel):

- `chart/ChartDetailOverlay.tsx` — 부품 대부분을 쓴다(`ChannelSelectDrawer`로 선택 → `ChannelStackView`에 `ChannelWaveformCanvas`·`ProtectedComparePanel` 조립). 채널 라벨/색은 `lib/render/channel-meta.ts`에서 받아 넘긴다.
- `workspace/ChannelViewerOverlay.tsx` — `ChannelWaveformCanvas` + `ChannelRowHeader`를 쓴다(저장 WAV 채널별 렌더, peak/rms는 `lib/render/waveform.ts`의 `channelStats`로 계산).
- `dashboard/DashboardClient.tsx` — `ProtectedComparePanel`을 대시보드 본문(`protected-compare-section`)에 직접 렌더한다.

내부 흐름은 없다 — 네 부품은 서로를 import하지 않는 평면 구조이고, 조립은 전적으로 소비자(두 오버레이) 몫이다.

```
[실시간]  ChartDetailOverlay
   → ChannelSelectDrawer(선택) → ChannelStackView
       → 각 채널: ChannelRowHeader(머리) + ChannelWaveformCanvas(liveWindow push)

[저장]    ChannelViewerOverlay
   → decodeAudioChannels(WAV) → 각 채널: ChannelRowHeader(channelStats) + ChannelWaveformCanvas(정적 버퍼)
```

## 5. 주요 인터페이스 / 진입점

- `ChannelWaveformCanvas(props)` (named export) — `{ color: string; sampleRate: number; totalDurationSec: number; liveWindow: WaveformWindow; fetchRange: (startSec, endSec) => Promise<Float32Array> }`. 한 채널 파형을 그린다. `totalDurationSec`가 x축 전체 도메인(세션 진행에 따라 증가), `liveWindow`가 최근 실시간 윈도우, `fetchRange`가 과거 구간 온디맨드 조회다. `WaveformWindow` 타입과 `channelStats`는 이 파일이 아니라 `lib/render/waveform.ts`에서 export한다.
- `ProtectedComparePanel(props)` (named export, `memo`) — `{ subscribeCaptureStream: (fn: CaptureStreamListener) => () => void; sourceFile?: File | null; getProtectedBlob?: () => Blob | null; bare?: boolean }`. 보호 감쇠 전/후 비교 패널. `sourceFile`이 없으면 안내 문구만 보여주고 `bare`가 true면 카드 셸 없이 본문만 그린다(상세 오버레이 스택용).
- `ChannelRowHeader({ color, name, role, stats? })` (default export) — 채널 행 머리 내용(Fragment). `stats`(`{ peak, rms }`)가 있을 때만 우측 배지를 그린다.
- `ChannelStackView({ items, emptyLabel?, onReorder? })` (default export) — 드래그 재배치·리사이즈 세로 스택. `onReorder(ids)`는 보이는 항목의 새 순서 전체를 넘긴다.
- `StackItem` (type) — `{ id: string; header: ReactNode; content: ReactNode; defaultHeight?; minHeight?; maxHeight? }`. 스택 한 칸의 머리·본문·높이 한도.
- `ChannelSelectDrawer({ open, onClose, entries, selected, onToggle, loading?, error? })` (default export) — 표시 항목 선택 드로어. `entries`는 `DrawerEntry[]`, `selected`는 선택된 id `Set`, `onToggle(id)`로 추가·제거.
- `DrawerEntry` (type) — `{ id; section: "metric" | "channel"; name; role; color; icon? }`. 드로어 한 항목(메인 차트 또는 채널).

## 6. 변경 이력(요약)
- 2026-07-10: 최초 작성 — `chart/`가 겸하던 "채널 파형 뷰" 부품 4종(`ChannelWaveformCanvas`(+`channelStats`)·`ChannelRowHeader`·`ChannelStackView`·`ChannelSelectDrawer`)을 별도 도메인 `components/channel/`으로 분리(chart·workspace가 단방향 참조). `ChannelRowHeader`는 두 오버레이의 중복 헤더를 통합해 신설, 드로어/오버레이 셸은 공용 `shared/components/overlay`·`ui`로 위임 (커밋 범위: 537099f..HEAD, 워크트리 포함)
- 2026-07-20: `ChannelWaveformCanvas`에 확대 시 포인트 심볼 표시 기능 추가 — 줌 구간 안 포인트 수가 `SYMBOL_VISIBLE_MAX` 이하면 각 샘플에 점을 찍어 간격을 보여주고 LTTB/large 샘플링을 끈다. 섹션 3·4 부분 갱신 (커밋 범위: 9f08d59..fb8e4fa)
- 2026-07-27: ECharts → uPlot 이관 + 부품 재편 반영 — `ChannelWaveformCanvas`/`ProtectedComparePanel`이 공용 `shared/components/UPlotChart` 래퍼 기반으로 교체(줌은 드래그/휠/더블클릭, 과거 구간 fetch는 `onUserZoom` 초 단위 콜백, 비교 패널의 L/R/Both는 `seriesShow` 토글). `ProtectedComparePanel`을 이 도메인 문서에 편입(§3·4·5), `channelStats`/`WaveformWindow`는 `lib/render/waveform.ts` 소속으로 정정. 섹션 1·3·4·5 부분 갱신 (커밋 범위: 14941b7..HEAD, 워크트리 포함)
- 2026-07-27(2): 두 컴포넌트의 드래그·휠 줌이 실제로는 항상 무효화되던 버그 수정 — `UPlotChart`의 x축 커스텀 `range()` 콜백이 xRange(고정 도메인) prop이 있을 때 사용자의 드래그/휠 줌 결과까지 그 고정 도메인으로 되돌려버렸다. `wheelZoomPlugin` → `zoomPlugin`으로 개칭하고 `getFullXRange` 옵션을 추가해 "로드된 데이터가 아니라 세션 전체로 리셋"하는 책임을 플러그인 쪽으로 옮기고, `UPlotChart`의 x축 range() 콜백 자체는 제거(uPlot 기본 동작만 사용). 섹션 3·4 부분 갱신 (커밋 범위: 워크트리, 미커밋)
