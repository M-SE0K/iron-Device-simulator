# cache

## 1. 도메인 설명

세션 프레임·Calibration 값·업로드 오디오·Workspace 저장 항목을 새로고침이나 탭 재방문에도 잃지 않도록 브라우저 저장소(sessionStorage/IndexedDB)에 담아두는 캐시 계층입니다. 여기 저장된 값은 전부 표시용이고, 분석 결과의 원본은 아닙니다.

## 2. 프로젝트 전반에서의 역할

`dashboard/`·`calibration/`·`workspace/` 세 도메인이 각자 필요한 캐시를 읽고 쓸 때 거치는 창구입니다. 저수준 접근은 IndexedDB 쪽 `idb.ts`와 sessionStorage 쪽 `session-json.ts`가 공용 유틸로 맡고, 나머지 파일은 그 위에 도메인별 스키마만 얹었습니다. 캐시가 비어 있거나 손상돼도 앱은 정상 동작해야 하므로 모든 읽기 함수는 실패 시 `null`이나 빈 배열을 돌려주고 예외를 던지지 않습니다.

다만 "값을 못 읽었다"와 "키가 없다"는 구분해야 합니다. 값이 손상돼 파싱에 실패한 것과 애초에 저장된 적이 없는 것을 같게 다루면, 파싱이 한 번 실패했다는 이유만으로 멀쩡히 남아 있는 IndexedDB 데이터를 지워 버립니다. `hasSessionJson()`이 그 둘을 갈라 주는 몫을 합니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `idb.ts` | IndexedDB 열기·트랜잭션·요청을 Promise로 감싸는 저수준 공용 유틸 |
| `session-json.ts` | sessionStorage JSON 읽기/쓰기/삭제/존재 확인 공용 유틸(SSR 가드 + 예외 무시) |
| `frame-utils.ts` | `AnalysisFrame`에서 캐시에 필요한 최소 필드(time/temperature/excursion)만 남기는 `slimAnalysisFrames()` |
| `frame.ts` | 실시간 차트 프레임 세션 캐시(sessionStorage) — F5 새로고침 후 차트 복원용 |
| `calibration.ts` | Calibration 값과 `DeviceActualCache`(적용된 실제 SampleRate/BufferFrameSize) 세션 캐시 |
| `audio-blob.ts` | 업로드한 오디오 파일 자체를 IndexedDB에 저장하고 sessionStorage 포인터로 수명을 연결(파형 복원용) |
| `workspace.ts` | Workspace 저장 항목의 메타(IndexedDB `meta` 스토어)와 페이로드(프레임+오디오 Blob, `payload` 스토어) CRUD |

## 4. 의존성 및 흐름

- **가져오는 것**: `features/audio/types`의 `AnalysisFrame`/`CalibrationValues` 타입.
- **내부 의존**: `audio-blob.ts`·`workspace.ts`는 `idb.ts` 위에서, `frame.ts`·`calibration.ts`는 `session-json.ts` 위에서 동작합니다. `audio-blob.ts`는 IndexedDB와 sessionStorage를 모두 쓰는 유일한 파일이라 `session-json.ts`도 함께 가져옵니다. `frame.ts`와 `workspace.ts`는 `frame-utils.ts`의 `slimAnalysisFrames()`를 함께 씁니다.
- **소비하는 도메인**:
  - `dashboard/` — `hooks/useFrameCachePersistence.ts`·`DashboardClient.tsx`가 `frame.ts`/`audio-blob.ts`를, `hooks/useDashboardView.ts`가 `session-json.ts`를 직접 씁니다.
  - `calibration/` — `CalibrationContext.tsx`·`hooks/useCalibrationApply.ts`에서 `calibration.ts`를 호출합니다.
  - `workspace/` — `WorkspaceContext.tsx`·`RecordsDrawer.tsx`·`hooks/useWorkspaceItems.ts`·`ChannelViewerOverlay.tsx`, 그리고 `dashboard/hooks/useWorkspaceSave.ts`가 `workspace.ts`를 씁니다.

```
sessionStorage 계열: frame.ts / calibration.ts
    → session-json.ts(readSessionJson/writeSessionJson/removeSessionJson) → window.sessionStorage

IndexedDB 계열: audio-blob.ts / workspace.ts
    → idb.ts(openIndexedDb/runTx/requestToPromise) → window.indexedDB
```

## 5. 주요 인터페이스 / 진입점

- **`saveFrameCache(snap)`** / **`loadFrameCache(): FrameCacheSnapshot | null`** / **`clearFrameCache()`** — 차트 프레임 세션 캐시. 프레임이 0개면 `loadFrameCache()`는 `null`을 돌려줍니다.
- **`saveCalibrationCache(values)`** / **`loadCalibrationCache(): Partial<CalibrationValues> | null`** — Calibration 입력값 캐시.
- **`saveDeviceActualCache(v)`** / **`loadDeviceActualCache(): DeviceActualCache | null`** — 네이티브 `capture` 프로브가 확인한 실제 SampleRate/BufferFrameSize.
- **`putAudio(file: File)`** / **`getCachedAudio(): Promise<File | null>`** / **`clearAudio()`** — 업로드 오디오 파일의 IndexedDB 저장·복원·삭제. IndexedDB를 못 쓰는 환경에서는 아무 일도 하지 않고 조용히 넘어갑니다. ⚠️ `getCachedAudio()`는 포인터 키가 **확실히 없을 때만** 남은 IndexedDB 값을 정리합니다 — JSON이 깨졌거나 storage 접근 자체가 실패한 경우는 `null`만 돌려주고 데이터는 건드리지 않습니다.
- **`listWorkspaceItems(): Promise<WorkspaceItemMeta[]>`** — 저장 시각 내림차순으로 정렬된 메타 목록.
- **`saveWorkspaceItem(input: SaveWorkspaceInput): Promise<WorkspaceItemMeta | null>`** — 메타(`meta` 스토어)와 페이로드(`payload` 스토어)를 한 트랜잭션으로 함께 씁니다. `id`는 `crypto.randomUUID()`로 새로 발급합니다.
- **`renameWorkspaceItem(id, name)`** / **`deleteWorkspaceItem(id)`** / **`getWorkspacePayload(id): Promise<WorkspacePayload | null>`** — 항목 이름 변경·삭제·페이로드(프레임+오디오 Blob) 조회.
- **`slimAnalysisFrames(frames): AnalysisFrame[]`** — time/temperature/excursion 세 필드만 남긴 배열로 줄입니다(캐시 용량 절약).
- **`hasIndexedDb()`** / **`openIndexedDb(options)`** / **`runTx(db, storeNames, mode, run)`** / **`requestToPromise(req)`** — IndexedDB 저수준 공용 유틸.
- **`readSessionJson(key)`** / **`writeSessionJson(key, value)`** / **`removeSessionJson(key)`** — sessionStorage 저수준 공용 유틸.
- **`hasSessionJson(key): boolean | null`** — 키 존재 여부. 브라우저가 아니거나 storage 접근이 실패하면 `null`이라, 호출부는 `=== false`로 "확실히 없음"만 골라 써야 합니다.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — 현재 코드 기준. `session-json.ts`(sessionStorage 공용 헬퍼 추출)와 `workspace.ts`의 `protectedAudioBlob`(보호 감쇠 비교용 오디오) 필드를 포함해 반영(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
- 2026-08-11: `session-json.ts`에 `hasSessionJson()`이 추가되고 `audio-blob.ts`가 이를 쓰도록 바뀐 것을 반영했습니다. 포인터 키가 확실히 없을 때만 남은 IndexedDB 값을 정리하고 JSON 파손이나 storage 접근 실패는 `null` 반환에 그치도록 동작을 나눴는데, 그 내용을 §1·§5에 명시했습니다. `dashboard/hooks/useDashboardView.ts`가 `session-json.ts`를 직접 쓰는 소비처로 추가된 것도 §4에 적었습니다. 섹션 1·3·4·5 부분 갱신 (커밋 범위: 4d86f32..HEAD, 작업 트리 포함)
