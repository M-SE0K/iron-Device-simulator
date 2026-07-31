# channel

## 1. 도메인 설명

캡처된 다채널 오디오를 채널 하나하나의 파형으로 그려 보여주는 도메인이다. 개발자는 이 폴더만 읽고도 ch0(V)·ch1(I)와 확장 채널을 어떻게 개별 파형으로 그리는지, 사용자가 스택에 올릴 채널을 어떻게 고르는지를 파악한다. 실시간 상세 뷰(`chart/ChartDetailOverlay`)와 저장 세션 뷰(`workspace/ChannelViewerOverlay`)가 똑같이 쓰던 채널 파형 조각들을 한곳에 모아, 두 소비자가 같은 부품을 공유하게 떼어낸 결과다.

부품은 다섯 가지다. `ChannelWaveformCanvas`는 `ChannelWaveStore`가 들고 있는 세션 전체 min/max 엔벨로프를 단일 선 uPlot 차트에 그대로 그린다(메인 차트와 같은 source 구독 경로). `ChannelRowHeader`가 그리는 것은 채널 행 머리, 곧 색 점 + 이름 + 역할 + peak·rms 배지다. 여러 채널 패널을 드래그로 재배치하고 높이를 조절하는 세로 스택은 `ChannelStackView`가 만든다. `ChannelSelectDrawer`는 스택에 올릴 항목(메인 차트 + 채널 목록)을 체크로 고르는 우측 드로어다. `ProtectedComparePanel`은 원본 입력과 보호 감쇠 후 신호(엔진이 buf를 되쓴 결과)를 L/R 채널별 엔벨로프로 겹쳐 비교한다. 다섯 부품 모두 데이터를 소유하지 않는다. 소비자가 채널 버퍼와 선택 상태를 내려주고, 이 도메인은 그리기와 상호작용만 맡는다. 표시 텍스트는 다섯 부품 전부 `shared/lib/i18n`의 `useLocale()`에서 가져온다.

## 2. 프로젝트 전반에서의 역할

캡처 파이프라인이 만든 다채널 PCM을 사람이 눈으로 읽는 파형으로 바꾸는 표시 계층이다. 스스로 마운트되는 일은 없고, 두 상위 화면이 부품으로 조립해 쓴다.

- `chart/ChartDetailOverlay`(실시간 상세 뷰)는 부품을 이렇게 조립한다. `ChannelSelectDrawer`로 표시 항목을 고른 뒤 선택된 채널마다 `ChannelWaveformCanvas`를 `ChannelStackView` 스택에 얹고 각 패널 머리에는 `ChannelRowHeader`를 쓴다. 채널 데이터는 캡처 청크가 도착할 때마다 push되는 실시간 윈도우다.
- `workspace/ChannelViewerOverlay`(저장 세션 뷰)는 저장된 N채널 WAV를 채널별로 디코딩해 `ChannelWaveformCanvas` + `ChannelRowHeader`로 그린다. 이쪽은 실시간 push 없이 정적 버퍼를 통째로 넘긴다.
- 채널 의미(ch0=V/ch1=I/ch2 이후 확장)와 색은 이 도메인이 정하지 않는다. 단일 소스는 `lib/render/channel-meta.ts`의 `channelLabel()`/`channelColor()`이고, 소비자가 그 결과를 `ChannelRowHeader`/`ChannelWaveformCanvas`에 props로 넘긴다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `ChannelWaveformCanvas.tsx` | 한 채널을 uPlot 차트(`UPlotChart` 래퍼)에 그린다. `ChannelWaveStore`가 들고 있는 세션 전체 min/max 엔벨로프를 source 구독으로 그대로 커밋한다(메인 차트가 `ChartStore`를 구독하는 것과 같은 경로 — React 커밋 없이 rAF로 반영). 줌은 Temperature/ExcursionChart와 동일하게 기본 `zoomPlugin()`(휠/드래그/더블클릭, 전체범위 = 현재 로드된 데이터 extent)만 쓴다 — 과거에 있던 LTTB 다운샘플링과 확대 구간 원본 재디코딩(`fetchRange`)은 제거됐다. Y축 범위는 절대 피크를 기준으로 대칭으로 잡는다. peak·rms 배지(`ChannelStatsBadge`)는 `useLocale()`의 `t.channelMeta.peakRms()`로 문구를 만든다. |
| `ChannelRowHeader.tsx` | 채널 행 머리 내용(색 점 + 채널명(mono) + 역할 + peak·rms 배지)만 Fragment로 그린다. 바깥 컨테이너(div/Fragment)는 소비자마다 달라 여기서 감싸지 않는다. `stats`가 없으면 배지를 숨긴다(라이브 데이터 미도착 등). peak·rms 문구는 `useLocale()`의 `t.channelMeta.peakRms()`로 만든다(`ChannelWaveformCanvas`의 `ChannelStatsBadge`와 같은 메시지 키 공유). |
| `ChannelStackView.tsx` | 여러 채널 패널을 세로로 쌓고 드래그로 재배치·리사이즈하는 스택. 각 항목은 `StackItem`(머리·본문·기본/최소/최대 높이)이고, 재배치가 끝나면 보이는 항목들의 새 id 순서를 `onReorder`로 통째로 올려보낸다. 항목이 없으면 `emptyLabel`(기본값은 `useLocale()`의 `t.channelStackView.emptyLabel`)을 보여준다. 리사이즈/재배치 핸들의 `aria-label`/`title`도 `t.channelStackView.*`에서 가져온다. |
| `ChannelSelectDrawer.tsx` | 스택에 올릴 표시 항목을 고르는 우측 드로어(공용 `overlay/SideDrawer` 위, `layer="overlay"`). 항목을 메인 차트(`section: "metric"`)와 채널 목록(`section: "channel"`)으로 나눠 체크 방식으로 추가·제거한다. 셸(백드롭·패널·헤더)은 `SideDrawer`, 채널 개수 배지는 공용 `ui/CountBadge`에 위임한다. 제목·섹션 라벨·빈 상태/로딩/에러 문구는 전부 `useLocale()`의 `t.channelSelectDrawer.*`에서 가져온다. |
| `ProtectedComparePanel.tsx` | 원본 입력(옅은 점선)과 보호 감쇠 후 신호(진한 실선)를 L/R 채널별로 겹쳐 그리는 비교 패널. 원본은 `sourceFile`을 `decodeAudioData`로 통째 디코딩해 1000버킷 엔벨로프(`BucketEnvelope`)로, 감쇠 후 신호는 캡처 스트림의 `protected` 이벤트를 같은 버킷에 실시간 누적해 그린다(패널을 세션 도중 열면 `getProtectedBlob` WAV로 1회 백필). 네 시리즈가 같은 버킷 격자를 공유하므로 `envelopesToAligned`로 x축 하나의 aligned 데이터를 만들고 L/R/Both 토글은 `UPlotChart`의 `seriesShow`로 인스턴스 재생성 없이 반영한다. uPlot 기본 범례는 `legend: { show: false }`로 꺼두고, 대신 시리즈 라벨 자체를 클릭 가능한 커스텀 토글 버튼으로 그린다(`hiddenSeries` 상태 + `toggleSeries`) — 켜짐은 원래 색과 굵기 그대로(점선=Input, 실선=Protected) "뚜렷하게", 꺼짐은 같은 라벨을 `opacity-35`로 낮춰 "흐릿하게" 표시해 체크박스 없이도 on/off가 한눈에 드러난다. 텍스트(제목·L/R/Both·범례 라벨·안내 문구)는 `useLocale()`의 `t.protectedCompare.*`에서 가져온다. |

## 4. 의존성 및 흐름

이 도메인이 가져다 쓰는 모듈 (channel → 외부):

- `shared/components/UPlotChart.tsx` — 두 차트 부품(`ChannelWaveformCanvas`/`ProtectedComparePanel`)의 uPlot 인스턴스 생명주기·리사이즈·줌 보존 래퍼. `ChannelWaveformCanvas`는 `source`(구독 기반) 모드, `ProtectedComparePanel`은 `data`(React 상태) 모드 + `seriesShow`(시리즈 토글)를 쓴다.
- `lib/render/uplot-option.ts` — 축 빌더(`buildTimeAxis`/`buildValueAxis`)와 시간 소수점 헬퍼(`timeDecimalsForInterval`)로 메인 차트와 같은 축 규약을 따른다.
- `lib/render/uplot-plugins.ts` — `zoomPlugin`/`tooltipPlugin`(메인 차트와 같은 줌·툴팁 규약). `ProtectedComparePanel`은 `zoomPlugin`에 `getFullXRange`(세션 전체 길이를 돌려주는 안정된 getter)를 넘겨 로드된 데이터가 세션 전체보다 짧을 때도 휠 줌아웃·더블클릭 리셋이 세션 전체로 돌아가게 한다. `ChannelWaveformCanvas`는 인자 없는 기본 `zoomPlugin()`만 쓴다. 항상 세션 전체 엔벨로프를 통째로 들고 있으니 로드된 데이터 extent가 곧 세션 전체이기 때문이다.
- `lib/render/envelope.ts` — `BucketEnvelope`(버킷 min/max 누적)와 `envelopesToAligned`(엔벨로프들 → 공유 x축 aligned 데이터). `ProtectedComparePanel` 전용.
- `lib/render/wave-store.ts` — `ChannelWaveStore`(`ChannelWaveformCanvas`의 세션 파형 입력, `subscribe`/`snapshot`/`readAligned`).
- `lib/codec/wav-incremental.ts` — `ProtectedComparePanel`의 감쇠 PCM 1회 백필(`peekWavHeader`/`decodeWavRange`).
- `lib/engine/core.ts` — `INT16_SCALE`/`CHANNELS`(`ProtectedComparePanel`의 int16 → float 환산·채널 분리).
- `shared/lib/i18n/LocaleProvider.tsx` — `useLocale()`. 다섯 부품 전부가 텍스트(라벨·aria-label·placeholder·범례)를 여기서 가져온다.
- `shared/components/overlay/SideDrawer.tsx` — `ChannelSelectDrawer`의 슬라이드 드로어 셸.
- `shared/components/ui/CountBadge.tsx` — `ChannelSelectDrawer` 채널 개수 배지.
- `shared/components/ui/SegmentedControl.tsx` — `ProtectedComparePanel`의 L/R/Both 토글.
- `shared/lib/utils.ts` — `cn`(클래스 병합).
- 외부 패키지 — `uplot`(공용 래퍼 경유), `lucide-react`.

이 도메인을 가져다 쓰는 모듈 (외부 → channel):

- `chart/ChartDetailOverlay.tsx` — 부품 대부분을 쓴다(`ChannelSelectDrawer`로 선택 → `ChannelStackView`에 `ChannelWaveformCanvas`·`ProtectedComparePanel` 조립). 채널 라벨과 색은 `lib/render/channel-meta.ts`에서 받아 넘긴다.
- `workspace/ChannelViewerOverlay.tsx` — `ChannelWaveformCanvas` + `ChannelRowHeader`를 쓴다(저장 WAV 채널별 렌더, peak/rms는 `lib/render/waveform.ts`의 `channelStats`로 계산).
- `dashboard/DashboardClient.tsx` — `ProtectedComparePanel`을 대시보드 본문(`protected-compare-section`)에 직접 렌더한다.

내부 흐름은 없다. 다섯 부품은 서로를 import하지 않는 평면 구조이고, 조립은 전적으로 소비자(두 오버레이) 몫이다.

```
[실시간]  ChartDetailOverlay
   → ChannelSelectDrawer(선택) → ChannelStackView
       → 각 채널: ChannelRowHeader(머리) + ChannelWaveformCanvas(ChannelWaveStore 구독, 라이브 청크마다 커밋)

[저장]    ChannelViewerOverlay
   → decodeAudioChannels(WAV) → 각 채널: ChannelRowHeader(channelStats) + ChannelWaveformCanvas(정적 버퍼를 스토어에 담아 구독)
```

## 5. 주요 인터페이스 / 진입점

- `ChannelWaveformCanvas(props)` (named export) — `{ color: string; sampleRate: number; store: ChannelWaveStore }`. 한 채널 파형을 그린다. 세션 전체 엔벨로프와 길이를 대는 데이터 소스는 `store` 하나다(과거의 `fetchRange` 온디맨드 원본 재조회 prop은 제거됐다).
- `ChannelStatsBadge({ store })` (named export) — `store`의 peak/rms를 `useLocale()`의 `t.channelMeta.peakRms()` 문구로 그리는 배지. 샘플이 0개면 `null`.
- `ProtectedComparePanel(props)` (named export, `memo`) — `{ subscribeCaptureStream: (fn: CaptureStreamListener) => () => void; sourceFile?: File | null; getProtectedBlob?: () => Blob | null; bare?: boolean }`. 보호 감쇠 전/후 비교 패널. `sourceFile`이 없으면 안내 문구만 보여주고, `bare`가 true면 카드 셸 없이 본문만 그린다(상세 오버레이 스택용).
- `ChannelRowHeader({ color, name, role, stats? })` (default export) — 채널 행 머리 내용(Fragment). `stats`(`{ peak, rms }`)가 있을 때만 우측 배지를 그린다.
- `ChannelStackView({ items, emptyLabel?, onReorder? })` (default export) — 드래그 재배치·리사이즈 세로 스택. `onReorder(ids)`는 보이는 항목의 새 순서 전체를 넘긴다.
- `StackItem` (type) — `{ id: string; header: ReactNode; content: ReactNode; defaultHeight?; minHeight?; maxHeight? }`. 스택 한 칸의 머리·본문·높이 한도.
- `ChannelSelectDrawer({ open, onClose, entries, selected, onToggle, loading?, error? })` (default export) — 표시 항목 선택 드로어. `entries`는 `DrawerEntry[]`, `selected`는 선택된 id `Set`, `onToggle(id)`로 추가·제거한다.
- `DrawerEntry` (type) — `{ id; section: "metric" | "channel"; name; role; color; icon? }`. 드로어 한 항목(메인 차트 또는 채널).

## 6. 변경 이력(요약)
- 2026-07-10: 최초 작성 — `chart/`가 겸하던 "채널 파형 뷰" 부품 4종(`ChannelWaveformCanvas`(+`channelStats`)·`ChannelRowHeader`·`ChannelStackView`·`ChannelSelectDrawer`)을 별도 도메인 `components/channel/`으로 분리(chart·workspace가 단방향 참조). `ChannelRowHeader`는 두 오버레이의 중복 헤더를 통합해 신설, 드로어/오버레이 셸은 공용 `shared/components/overlay`·`ui`로 위임 (커밋 범위: 537099f..HEAD, 워크트리 포함)
- 2026-07-20: `ChannelWaveformCanvas`에 확대 시 포인트 심볼 표시 기능 추가 — 줌 구간 안 포인트 수가 `SYMBOL_VISIBLE_MAX` 이하면 각 샘플에 점을 찍어 간격을 보여주고 LTTB/large 샘플링을 끈다. 섹션 3·4 부분 갱신 (커밋 범위: 9f08d59..fb8e4fa)
- 2026-07-27: ECharts → uPlot 이관 + 부품 재편 반영 — `ChannelWaveformCanvas`/`ProtectedComparePanel`이 공용 `shared/components/UPlotChart` 래퍼 기반으로 교체(줌은 드래그/휠/더블클릭, 과거 구간 fetch는 `onUserZoom` 초 단위 콜백, 비교 패널의 L/R/Both는 `seriesShow` 토글). `ProtectedComparePanel`을 이 도메인 문서에 편입(§3·4·5), `channelStats`는 `lib/render/waveform.ts` 소속으로 정정. 섹션 1·3·4·5 부분 갱신 (커밋 범위: 14941b7..HEAD, 워크트리 포함)
- 2026-07-27(2): 두 컴포넌트의 드래그·휠 줌이 실제로는 항상 무효화되던 버그 수정 — `UPlotChart`의 x축 커스텀 `range()` 콜백이 xRange(고정 도메인) prop이 있을 때 사용자의 드래그/휠 줌 결과까지 그 고정 도메인으로 되돌려버렸다. `wheelZoomPlugin` → `zoomPlugin`으로 개칭하고 `getFullXRange` 옵션을 추가해 "로드된 데이터가 아니라 세션 전체로 리셋"하는 책임을 플러그인 쪽으로 옮기고, `UPlotChart`의 x축 range() 콜백 자체는 제거(uPlot 기본 동작만 사용). 섹션 3·4 부분 갱신 (커밋 범위: 워크트리, 미커밋)
- 2026-07-30: `ChannelWaveformCanvas`에서 LTTB 다운샘플링과 확대 구간 원본 재디코딩(`fetchRange` prop, `onUserZoom`, 200ms 디바운스 fetch)을 전부 제거 — 이제 `ChannelWaveStore`의 세션 전체 엔벨로프를 source 구독으로 받아 그대로 그린다. 줌은 인자 없는 기본 `zoomPlugin()`만 쓴다(Temperature/ExcursionChart와 동일 패턴). `ProtectedComparePanel`은 uPlot 기본 범례를 끄고(`legend: { show: false }`) 시리즈 라벨을 직접 클릭하는 커스텀 토글(`hiddenSeries`/`toggleSeries`)로 바꿨다. 켜짐="뚜렷하게"/꺼짐="흐릿하게"가 명확히 드러난다(과거 uPlot 기본 범례의 체크박스형 마커 UX 개선). 다섯 부품 전체가 `shared/lib/i18n`의 `useLocale()`에 새로 의존한다(하드코딩 영문 문자열 → `t.*` 메시지 키). 신설 named export `ChannelStatsBadge`를 섹션 5에 추가. 섹션 1·3·4·5 부분 갱신 (기준: 워크트리, 미커밋)
