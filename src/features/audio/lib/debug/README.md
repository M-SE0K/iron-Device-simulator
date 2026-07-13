# debug

## 1. 도메인 설명

렌더 파이프라인 지연 계측과 측정 하네스가 공유하는 **타입 정의 전용** 도메인이다. 런타임 코드 없이 `types.ts` 파일 하나로 구성되며 세 인터페이스를 export한다.

- `DebugLogEntry` — 프레임 1개 단위의 디버그 로그. 수신 절대 시각(`receivedAt`, ms), 오디오 타임라인 시각(`audioTime`, s), 왕복 지연(`rttMs`), 엔진 처리 시간(`serverProcMs`), 렌더 지연 3종(`reactRenderMs`/`echartsRenderMs`/`totalRecvRenderMs`), 최신성 지연(`freshnessLagMs`)을 담는다.
- `StreamDebugInfo` — 스트리밍 세션의 실시간 집계 스냅샷. 송수신 프레임 수, 최근 100프레임 평균 RTT(Round-Trip Time, 왕복 지연), 전송 속도(`sendRateFps`), output queue 길이, 누적 드롭 수, 렌더 갱신 빈도(Hz) 등 21개 필드.
- `MeasurementExport` — 측정 세션 JSON 내보내기 스키마. `meta`(기록 시각·파일명·측정 길이·프레임 수) + `summary`(RTT/recv→render/E2E/freshness lag 각각 avg·min·max·p50·p95·p99, 드롭 비율, 이벤트 로그) + `frames`(`DebugLogEntry[]`) + `rawFrames`/`renderedFrames`(코얼레싱 정책 적용 전후 프레임 시퀀스, 충실도 MAE 계산 기준값).

## 2. 프로젝트 전반에서의 역할

플레이어 계층(프레임 수신)과 대시보드 계층(렌더 완료·측정 export)이 지연 계측 데이터를 주고받을 때 쓰는 공용 계약이다. `useCaptureSession`이 프레임 수신 시점에 `DebugLogEntry`를 생성하고(render 지연 필드는 `null`) `useRenderTelemetry`가 ECharts 렌더 완료 시점의 값으로 이를 보강하며 `useMeasurementCapture`가 측정 종료 시 `MeasurementExport` JSON으로 집계해 내려받는다. 이 JSON을 Puppeteer 측정 하네스 `scripts/measure.ts`가 가로채 `measurements/*.json`으로 저장하고 `scripts/compare.ts`가 비교하므로, `MeasurementExport`는 **브라우저 앱과 측정 하네스 사이의 데이터 스키마**이기도 하다. 원래 `features/audio/types.ts`에 있던 타입들을 커밋 d3ccea8에서 이 폴더로 분리했고 `types.ts:64-65`에 이관 안내 주석이 남아 있다.

## 3. 파일별 역할
| 파일 | 역할 |
|------|------|
| `types.ts` | `DebugLogEntry`, `MeasurementExport`, `StreamDebugInfo` 세 인터페이스 정의. 이 도메인의 유일한 파일이며 import가 전혀 없는 leaf 모듈이다. |

## 4. 의존성 및 흐름

이 도메인은 아무것도 import하지 않는다. 소비처는 `src/` 안에서 8개 파일이다.

```
lib/debug/types.ts (leaf, 타입만)
  ├─ player/capture/useCaptureSession.ts  ← DebugLogEntry 생성(onDebugLog), Partial<StreamDebugInfo> 갱신(onDebugUpdate)
  ├─ player/capture/useNativeCapture.ts / useWebAudioWorkletCapture.ts ← onDebugUpdate: (info: Partial<StreamDebugInfo>) => void 콜백 시그니처
  ├─ player/WaveformPlayer.tsx / MicrophonePlayer.tsx ← onDebugUpdate/onDebugLog prop 타입
  ├─ dashboard/hooks/useRenderTelemetry.ts ← DebugLogEntry에 render 지연 필드 보강, StreamDebugInfo 부분 갱신 수신
  ├─ dashboard/hooks/useMeasurementCapture.ts ← MeasurementExport 조립 + JSON 다운로드
  └─ dashboard/DashboardClient.tsx ← measureLogsRef(useRef<DebugLogEntry[]>) 소유, 위 두 훅에 주입
```

데이터 흐름: `useCaptureSession`의 소켓 `onmessage`(frame 수신) → `onDebugLog(DebugLogEntry)` → `useRenderTelemetry.handleDebugLog`가 직전 렌더 사이클의 `reactRenderMs`/`echartsRenderMs`/`totalRecvRenderMs`와 `freshnessLagMs`를 첨부해 `measureLogsRef`에 누적 → 측정 종료 시 `useMeasurementCapture.handleMeasureToggle`이 avg/min/max/p50/p95/p99를 계산해 `MeasurementExport`로 다운로드한다. `DebugLogEntry`의 `temperature`/`excursion`은 스테레오 중 ch0(L) 대표값 단일 스칼라다 (`useCaptureSession.ts:169`).

`scripts/measure.ts`와 `scripts/compare.ts`는 이 모듈을 import하지 않는다. `measure.ts`는 `URL.createObjectURL`을 후킹해 다운로드 JSON을 문자열로 캡처한 뒤 `JSON.parse`로 다루고 `compare.ts`는 `summary` 구조를 미러링한 자체 `MeasData` 타입(`compare.ts:46-47`)을 쓴다. 즉 스키마 정합성은 타입 시스템이 아니라 관례로 유지된다.

## 5. 주요 인터페이스 / 진입점

- `DebugLogEntry` — 생산: `useCaptureSession`(수신 시점 필드), 보강: `useRenderTelemetry.handleDebugLog`(렌더 지연 필드). 렌더 지연 3종과 `rttMs`/`freshnessLagMs`는 `number | null`.
- `Partial<StreamDebugInfo>` — 스트림/캡처 훅들의 `onDebugUpdate` 콜백 페이로드. 전체가 아닌 변경분만 전달하는 계약이라 소비 측(`useRenderTelemetry.handleDebugUpdate`)은 `undefined` 체크 후 캐시한다.
- `MeasurementExport` — `useMeasurementCapture`가 조립하는 export 스키마. `summary.eventLog`의 `eventType`은 `"temp_warn" | "temp_danger" | "exc_peak"` 리터럴 유니온이다. 파생 타입 추출 패턴이 쓰인다: `type RawFrame = MeasurementExport["rawFrames"][number]` (`useMeasurementCapture.ts:12-13`).

DashboardClient는 `StreamDebugInfo`/`MeasurementExport`를 import하지만 현재 직접 참조하는 곳은 `measureLogsRef`의 `DebugLogEntry`뿐이다.

## 6. 변경 이력(요약)
- 2026-07-09: 최초 작성 (기준 커밋: 1fbbf44, 커밋되지 않은 워크트리 변경 반영)
- 2026-07-09: 교차참조 정정 — `DebugLogEntry` 생산자를 삭제된 `useAnalysisStream` → `useCaptureSession`으로 수정(섹션 2·4·5). 이 도메인의 `types.ts` 자체는 변경 없음 (관련 커밋: 플레이어 캡처 세션 통합 e0add14..HEAD)
