# perf-e2e

## 1. 도메인 설명

실시간 분석 파이프라인을 N1~N12 노드로 잘게 쪼갠 뒤 캡처 하드웨어부터 화면 페인트까지 구간별 지연을 재는 실험 하네스입니다. `lib/perf/`의 기존 5단계 하네스가 뭉뚱그리던 스레드/프로세스 경계, 큐잉 지연, React 커밋 구간을 따로 잡아내므로 어느 구간이 느린지 짚어낼 수 있습니다.

## 2. 프로젝트 전반에서의 역할

`lib/perf/`와는 아예 독립된 수집기입니다. 두 하네스를 동시에 켜도 서로 간섭하지 않습니다. 기본값은 비활성이고, 켜지 않으면 코드 경로에 아무 영향도 없습니다(각 기록 메서드가 맨 앞에서 `active`가 아니면 즉시 반환). 계측 지점은 캡처 훅·워커 소켓·엔진 호출부·차트 커밋 지점처럼 파이프라인 곳곳에 인라인으로 박혀 있습니다. `perf-e2e`는 그 값을 받아 모으는 싱글턴 창구일 뿐입니다. 노드별 정의와 실행 방법은 `docs/e2e-latency-experiment.md`에 자세히 적어 두었습니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `types.ts` | N1~N12 노드 ID·라벨·설명(`E2E_NODES`)과 샘플/세션 메타/내보내기 타입 정의 |
| `collector.ts` | 싱글턴 수집기(`e2e`) 구현 — 활성화 상태 관리, 노드별 샘플 기록, 요약·다운로드. `window.__ironE2E`로 전역 노출 |

## 4. 의존성 및 흐름

- **가져오는 것**: `../perf/statistics`의 `summarizeStats`/`StatBlock`을 그대로 재사용하므로 통계 집계 로직을 중복 구현하지 않습니다. 결과를 JSON 파일로 저장할 때는 `@/shared/lib/utils`의 `downloadJsonArtifact`/`round3`를 씁니다.
- **호출하는 쪽**: 파이프라인 여러 지점이 `e2e.sample()`/`e2e.time()`/`e2e.markCommit()`을 직접 불러 자기 구간의 소요 시간을 남깁니다 — `useNativeCapture.ts`·`useCaptureSession.ts`(N5/N6/N8, 세션 시작/종료), `engine/protocol/worker-socket.ts`·`engine/worker/dsp-worker.ts`(N3/N4/N7, 워커 스레드 경계), `engine/core.ts`, `dashboard/hooks(useMetricChartRuntime.ts)`·`DashboardClient.tsx`(N9~N11, 출력 큐/커밋 구간)가 각자 위치에서 이 싱글턴을 가져다 씁니다.
- **활성화/제어**: 브라우저 콘솔에서 `window.__ironE2E.enable()`을 부르거나 URL에 `?e2e=1`을 붙이면 켜집니다. 상태는 `sessionStorage`에 저장돼 새로고침 후에도 남습니다. 세션 시작/종료(`startSession`/`endSession`)는 캡처 세션의 생명주기가 소유합니다.

```
캡처/워커/엔진/차트 각 지점 → e2e.sample()/e2e.time()/e2e.markCommit()
    → collector 내부 samples 누적 → summary()/report()/export()/download()
```

## 5. 주요 인터페이스 / 진입점

- **`e2e`** (싱글턴, `collector.ts`) — 아래 메서드를 제공하는 계측 수집기 인스턴스. `window.__ironE2E`로도 같은 인스턴스에 접근합니다.
  - `isEnabled()`/`enable()`/`disable()` — 활성화 상태 조회·전환(`sessionStorage` 연동)
  - `startSession(meta: E2ESessionMeta)`/`endSession()` — 측정 세션 시작·종료(비활성이면 `startSession`은 아무것도 기록하지 않음)
  - `isActive()` — 현재 세션 진행 중인지
  - `sample(node: E2ENodeId, ms: number, tag?: string)` — 노드 하나에 측정값 1건 기록
  - `time<T>(node, fn: () => T, tag?: string): T` — 동기 함수를 감싸 실행 시간을 자동 기록(비활성이면 계측 없이 `fn()`만 실행)
  - `markCommit()`/`sampleSinceCommit(node, tag?)` — 기준 시각을 찍어두고 그 뒤 흐른 시간을 기록(N11 전용)
  - `summary()`/`report()` — 노드별 통계 집계, `report()`는 `console.table`로 바로 출력
  - `export()`/`download(filename?)` — 전체 결과(메타+요약+원시 샘플)를 객체 또는 JSON 파일로 반환
  - `reset()` — 누적된 샘플을 초기화
- **`E2E_NODES: Record<E2ENodeId, E2ENodeMeta>`** — N1~N12 각각의 라벨과 설명. 새 노드는 여기에만 등록합니다.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — 현재 코드 기준(N1 설명은 Tauri 네이티브 캡처에 맞춰 갱신된 상태, 커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
