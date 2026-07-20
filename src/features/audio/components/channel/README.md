# channel

## 1. 도메인 설명

캡처된 다채널 오디오를 채널 하나하나의 파형으로 그려 보여주는 도메인이다. 개발자는 이 폴더만 보면 "ch0(V)·ch1(I)와 확장 채널을 어떻게 개별 파형으로 그리고, 사용자가 어떤 채널을 스택에 올릴지 어떻게 고르는가"를 파악할 수 있다. 실시간 상세 뷰(`chart/ChartDetailOverlay`)와 저장 세션 뷰(`workspace/ChannelViewerOverlay`)가 똑같이 쓰던 "채널 파형" 조각들을 한곳에 모아, 두 소비자가 같은 부품을 공유하도록 떼어낸 것이다.

네 가지 부품으로 나뉜다. `ChannelWaveformCanvas`는 한 채널을 LTTB(Largest-Triangle-Three-Buckets) 단일 선으로 줌 가능한 ECharts에 그리고 과거 구간은 온디맨드로 디코딩해 채운다. `ChannelRowHeader`는 채널 행 머리(색 점 + 이름 + 역할 + peak·rms 배지)를 그린다. `ChannelStackView`는 여러 채널 패널을 드래그로 재배치하고 높이를 조절하는 세로 스택을 만든다. `ChannelSelectDrawer`는 스택에 올릴 항목(메인 차트 + 채널 목록)을 체크로 고르는 우측 드로어다. 네 부품 모두 데이터를 소유하지 않는다 — 소비자가 채널 버퍼와 선택 상태를 내려주고, 이 도메인은 그리기와 상호작용만 맡는다.

## 2. 프로젝트 전반에서의 역할

이 도메인은 캡처 파이프라인이 만든 다채널 PCM을 사람이 눈으로 읽는 파형으로 바꾸는 표시 계층이며, 직접 마운트되지 않고 두 상위 화면에 부품으로 조립된다.

- `chart/ChartDetailOverlay`(실시간 상세 뷰)는 `ChannelSelectDrawer`로 표시 항목을 고르고, 선택된 채널마다 `ChannelWaveformCanvas`를 `ChannelStackView` 스택에 얹으며, 각 패널 머리에 `ChannelRowHeader`를 쓴다. 채널 데이터는 캡처 청크가 도착할 때마다 push되는 실시간 윈도우다.
- `workspace/ChannelViewerOverlay`(저장 세션 뷰)는 저장된 N채널 WAV를 채널별로 디코딩해 `ChannelWaveformCanvas` + `ChannelRowHeader`로 그린다. 이쪽은 실시간 push 없이 정적 버퍼를 통째로 넘긴다.
- 채널 의미(ch0=V/ch1=I/ch2 이후 확장)와 색은 이 도메인이 정하지 않는다 — `lib/render/channel-meta.ts`의 `channelLabel()`/`channelColor()`가 단일 소스이고, 소비자가 그 결과를 `ChannelRowHeader`/`ChannelWaveformCanvas`에 props로 넘긴다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `ChannelWaveformCanvas.tsx` | 한 채널을 LTTB 단일 선으로 줌 가능한 ECharts에 그린다. 실시간 윈도우(`liveWindow`)를 기본으로 그리다가, 사용자가 dataZoom으로 라이브 윈도우 밖(과거)을 확대하면 그 구간만 `fetchRange`로 온디맨드 디코딩해 채운다(라이브로 돌아오면 비운다). Y축은 원본 절대 피크 기준 대칭 범위로, LTTB가 놓칠 수 있는 전역 피크가 잘리지 않게 다운샘플 전 원본으로 계산한다. 줌 구간 안에 보이는 포인트 수가 `SYMBOL_VISIBLE_MAX`(`lib/render/chart-option.ts`) 이하로 좁혀지면 각 포인트에 점(`symbol: "circle"`)을 찍어 샘플 간격을 보여주고, 이때는 LTTB/large 샘플링을 끈다(보이는 포인트가 이미 적어 필요 없음). peak/rms를 한 번에 구하는 `channelStats()`와 실시간 윈도우 타입 `WaveformWindow`를 함께 export한다. |
| `ChannelRowHeader.tsx` | 채널 행 머리 내용(색 점 + 채널명(mono) + 역할 + peak·rms 배지)만 Fragment로 그린다. 바깥 컨테이너(div/Fragment)는 소비자마다 달라 여기서 감싸지 않는다. `stats`가 없으면 배지를 숨긴다(라이브 데이터 미도착 등). |
| `ChannelStackView.tsx` | 여러 채널 패널을 세로로 쌓고 드래그로 재배치·리사이즈하는 스택. 각 항목은 `StackItem`(머리·본문·기본/최소/최대 높이)이고, 재배치가 끝나면 보이는 항목들의 새 id 순서를 `onReorder`로 통째로 올려보낸다. 항목이 없으면 `emptyLabel`을 보여준다. |
| `ChannelSelectDrawer.tsx` | 스택에 올릴 표시 항목을 고르는 우측 드로어(공용 `overlay/SideDrawer` 위, `layer="overlay"`). 항목을 메인 차트(`section: "metric"`)와 채널 목록(`section: "channel"`)으로 나눠 체크 방식으로 추가·제거한다. 셸(백드롭·패널·헤더)은 `SideDrawer`, 채널 개수 배지는 공용 `ui/CountBadge`에 위임한다. |

## 4. 의존성 및 흐름

이 도메인이 가져다 쓰는 모듈 (channel → 외부):

- `lib/render/chart-option.ts` — `ChannelWaveformCanvas`가 `buildDataZoom`/`buildTimeAxis`/`buildValueTooltip`/`buildDynamicTimeFormatter`/`timeDecimalsForInterval`로 두 메인 차트와 같은 줌·시간축 규약을 쓰고, `SYMBOL_VISIBLE_MAX`로 포인트 심볼 표시 임계값을 공유한다.
- `shared/components/overlay/SideDrawer.tsx` — `ChannelSelectDrawer`의 슬라이드 드로어 셸.
- `shared/components/ui/CountBadge.tsx` — `ChannelSelectDrawer` 채널 개수 배지.
- `shared/lib/utils.ts` — `cn`(클래스 병합).
- 외부 패키지 — `echarts-for-react`(`next/dynamic`, `ssr: false` 지연 로드), `lucide-react`.

이 도메인을 가져다 쓰는 모듈 (외부 → channel):

- `chart/ChartDetailOverlay.tsx` — 네 부품을 모두 쓴다(`ChannelSelectDrawer`로 선택 → `ChannelStackView`에 `ChannelWaveformCanvas` + `ChannelRowHeader` 조립). 채널 라벨/색은 `lib/render/channel-meta.ts`에서 받아 넘긴다.
- `workspace/ChannelViewerOverlay.tsx` — `ChannelWaveformCanvas` + `channelStats` + `ChannelRowHeader`를 쓴다(저장 WAV 채널별 렌더).

내부 흐름은 없다 — 네 부품은 서로를 import하지 않는 평면 구조이고, 조립은 전적으로 소비자(두 오버레이) 몫이다.

```
[실시간]  ChartDetailOverlay
   → ChannelSelectDrawer(선택) → ChannelStackView
       → 각 채널: ChannelRowHeader(머리) + ChannelWaveformCanvas(liveWindow push)

[저장]    ChannelViewerOverlay
   → decodeAudioChannels(WAV) → 각 채널: ChannelRowHeader(channelStats) + ChannelWaveformCanvas(정적 버퍼)
```

## 5. 주요 인터페이스 / 진입점

- `ChannelWaveformCanvas(props)` (named export) — `{ color: string; sampleRate: number; totalDurationSec: number; liveWindow: WaveformWindow; fetchRange: (startSec, endSec) => Promise<Float32Array> }`. 한 채널 파형을 그린다. `totalDurationSec`가 x축 전체 도메인(세션 진행에 따라 증가), `liveWindow`가 최근 실시간 윈도우, `fetchRange`는 과거 구간 온디맨드 조회.
- `channelStats(data: Float32Array): { peak: number; rms: number }` (named export) — 한 채널 버퍼의 절대 피크와 RMS를 한 번에 계산.
- `WaveformWindow` (type) — `{ startSec: number; data: Float32Array }`. 첫 샘플의 세션 시작 기준 시각 + 채널 샘플.
- `ChannelRowHeader({ color, name, role, stats? })` (default export) — 채널 행 머리 내용(Fragment). `stats`(`{ peak, rms }`)가 있을 때만 우측 배지를 그린다.
- `ChannelStackView({ items, emptyLabel?, onReorder? })` (default export) — 드래그 재배치·리사이즈 세로 스택. `onReorder(ids)`는 보이는 항목의 새 순서 전체를 넘긴다.
- `StackItem` (type) — `{ id: string; header: ReactNode; content: ReactNode; defaultHeight?; minHeight?; maxHeight? }`. 스택 한 칸의 머리·본문·높이 한도.
- `ChannelSelectDrawer({ open, onClose, entries, selected, onToggle, loading?, error? })` (default export) — 표시 항목 선택 드로어. `entries`는 `DrawerEntry[]`, `selected`는 선택된 id `Set`, `onToggle(id)`로 추가·제거.
- `DrawerEntry` (type) — `{ id; section: "metric" | "channel"; name; role; color; icon? }`. 드로어 한 항목(메인 차트 또는 채널).

## 6. 변경 이력(요약)
- 2026-07-10: 최초 작성 — `chart/`가 겸하던 "채널 파형 뷰" 부품 4종(`ChannelWaveformCanvas`(+`channelStats`)·`ChannelRowHeader`·`ChannelStackView`·`ChannelSelectDrawer`)을 별도 도메인 `components/channel/`으로 분리(chart·workspace가 단방향 참조). `ChannelRowHeader`는 두 오버레이의 중복 헤더를 통합해 신설, 드로어/오버레이 셸은 공용 `shared/components/overlay`·`ui`로 위임 (커밋 범위: 537099f..HEAD, 워크트리 포함)
- 2026-07-20: `ChannelWaveformCanvas`에 확대 시 포인트 심볼 표시 기능 추가 — 줌 구간 안 포인트 수가 `SYMBOL_VISIBLE_MAX` 이하면 각 샘플에 점을 찍어 간격을 보여주고 LTTB/large 샘플링을 끈다. 섹션 3·4 부분 갱신 (커밋 범위: 9f08d59..fb8e4fa)
