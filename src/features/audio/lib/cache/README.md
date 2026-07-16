# cache

## 1. 도메인 설명
새로고침(F5)·분석 모드 전환·앱 재방문 시 차트·파형·캘리브레이션·저장 세션이 사라지는 문제를 브라우저 저장소만으로 해결한다. 개발자는 이 도메인의 함수만 호출하면 sessionStorage/IndexedDB 선택, 직렬화, 용량 초과(QuotaExceededError) 대응, stale 데이터 정리를 신경 쓰지 않아도 된다.

데이터 성격에 따라 저장소와 수명을 나눈다.

- **탭 수명(sessionStorage)**: 차트 프레임(`frame.ts`), 캘리브레이션 값·장치 실측 런타임(`calibration.ts`). 새로고침에는 살아남고 탭을 닫으면 사라진다.
- **탭 수명(IndexedDB + sessionStorage 포인터)**: 오디오 원본 블롭(`audio-blob.ts`). 대용량 File은 IndexedDB에 두되, sessionStorage 포인터로 수명을 차트 캐시와 일치시킨다. 포인터 없는 잔여 블롭은 다음 마운트 시 정리한다.
- **영구(IndexedDB)**: 사용자가 "저장" 버튼으로 명시적으로 보존한 Workspace 세션(`workspace.ts`). 탭을 닫아도 유지된다.

**캐시는 표시 전용(display-only)이다 — 분석 ground-truth로 쓰지 않는다.** `frame.ts`와 `workspace.ts`의 `slim()`은 차트가 실제로 그리는 `time`/`temperature`/`excursion` 세 필드만 남기고 나머지 `AnalysisFrame` 필드를 버린다. 복원된 프레임은 정적 뷰를 다시 그리는 용도이며 새 파일 업로드·리셋·마이크 전환 시 호출부(`DashboardClient.tsx`)가 캐시를 비운다.

## 2. 프로젝트 전반에서의 역할
이 프로젝트는 서버·DB가 없는 브라우저 단독 대시보드라서, 세션 간 상태 보존 수단이 브라우저 저장소뿐이다. `lib/cache/`는 그 저장소 접근을 도메인별 모듈 4개로 모은 유일한 영속화 계층이다.

- **대시보드**: 재생을 멈추거나 탭이 가려질 때 `DashboardClient`의 `useFrameCachePersistence`가 단일 실시간 프레임 버퍼를 저장하고 마운트 시 복원해 차트와 파형을 F5 이후에도 유지한다.
- **캘리브레이션**: `CalibrationContext`가 "적용"으로 커밋된 파라미터를 저장/복원한다. Electron 전용으로, 캡처 probe가 확인한 실제 SampleRate/BufferFrameSize(`DeviceActualCache`)도 함께 보존한다 — BufferFrameSize는 per-client 속성(TN2321)이라 `query`로는 장치 기본값만 보이기 때문에, "적용" 시점 실측값을 캐시해야 F5 후에도 "연결된 장치" 패널이 마지막 적용값을 보여줄 수 있다.
- **Workspace**: 좌측 WorkspaceDrawer의 저장 목록(메타)과 항목별 프레임+오디오(페이로드)를 영구 보관하고 JSON/CSV/오디오 내보내기용 헬퍼를 제공한다.

## 3. 파일별 역할
| 파일 | 역할 |
|------|------|
| `frame.ts` | 차트 프레임 스냅샷(`FrameCacheSnapshot`)의 파일명·길이·단일 realtimeFrames를 sessionStorage 키 `irondevice:chart-cache:v1`에 저장/복원/삭제한다. `slim()`으로 time/temperature/excursion만 직렬화한다. |
| `audio-blob.ts` | 오디오 원본 File을 IndexedDB(`irondevice` DB, `audio` 스토어, 고정 키 `"current"`)에 저장하고 메타데이터 포인터(`irondevice:audio-ptr:v1`)를 sessionStorage에 둔다. 복원 시 name/type/lastModified를 보존해 File로 재구성하며 포인터가 없으면 stale 블롭을 정리하고 null을 반환한다. |
| `calibration.ts` | 두 캐시를 담는다. (1) `CalibrationValues` 전체를 `irondevice:calibration:v1`에 저장하고 `Partial`로 읽어 필드 추가에도 깨지지 않게 한다. (2) `DeviceActualCache`(requested/actual SampleRate·BufferFrameSize)를 `irondevice:device-actual:v1`에 저장한다. 둘 다 sessionStorage, 수명은 탭. |
| `workspace.ts` | 별도 IndexedDB(`irondevice-workspace` DB, 버전 1)에 `meta` 스토어(목록용 경량 메타)와 `payload` 스토어(slim 프레임 배열 + 오디오 Blob)를 분리 보관한다. 목록/저장/이름변경/삭제/페이로드 조회 CRUD와 `framesToCsv()`, `sanitizeFileName()` 내보내기 헬퍼를 제공한다. id는 `crypto.randomUUID()`, 목록은 `createdAt` 내림차순. |

## 4. 의존성 및 흐름
**이 도메인이 import하는 것** (안쪽 방향):

- `@/features/audio/types` → `AnalysisFrame` 타입 (`frame.ts`, `workspace.ts`)
- `@/features/audio/components/calibration/CalibrationContext` → `CalibrationValues` 타입, type-only import (`calibration.ts`)

즉 런타임 의존은 브라우저 API(sessionStorage/IndexedDB)뿐이고 앱 코드에는 타입으로만 의존한다.

**이 도메인을 import하는 것** (바깥 방향, 데이터 흐름 포함):

```
[dashboard]
DashboardClient.tsx ──────────────── clearFrameCache / putAudio / clearAudio ──▶ frame.ts, audio-blob.ts
hooks/useFrameCachePersistence.ts ── saveFrameCache ──▶ frame.ts        (pause/pagehide 시 저장)
                                  ◀─ loadFrameCache / getCachedAudio    (마운트 시 복원)

[calibration]
CalibrationContext.tsx ───────────── save/loadCalibrationCache ⇄ calibration.ts
hooks/useCalibrationApply.ts ─────── save/loadDeviceActualCache ⇄ calibration.ts

[workspace]
WorkspaceContext.tsx / RecordsDrawer.tsx ── WorkspaceItemMeta·SaveWorkspaceInput 타입만 사용
hooks/useWorkspaceItems.ts ──────── list/save/rename/delete/getWorkspacePayload,
                                    framesToCsv, sanitizeFileName ⇄ workspace.ts
ChannelViewerOverlay.tsx ◀───────── getWorkspacePayload               (저장 항목 열람)
```

내부 처리 흐름은 네 파일 모두 같은 패턴이다: `typeof window` / `window.indexedDB` 가드 → try/catch로 감싼 저장소 접근 → 실패 시 조용히 포기(throw하지 않고 null/빈 배열 반환). 캐시 실패가 분석·재생 동작을 막지 않는다.

## 5. 주요 인터페이스 / 진입점
**frame.ts** — sessionStorage, 수명은 탭.

- `saveFrameCache(snap: FrameCacheSnapshot): void` — realtime/batch 프레임 버퍼 스냅샷을 저장한다. 용량 초과 시 `batchFrames: []`로 축소 재시도, 그래도 실패하면 포기.
- `loadFrameCache(): FrameCacheSnapshot | null` — 프레임이 하나라도 있어야 스냅샷을 반환한다. 없거나 파싱 실패면 null.
- `clearFrameCache(): void` — 캐시 키를 제거한다. 새 파일/리셋/마이크 전환 시 반드시 호출한다.

**audio-blob.ts** — IndexedDB `irondevice` + sessionStorage 포인터, 수명은 탭(포인터 기준). 전부 async.

- `putAudio(file: File): Promise<void>` — File을 저장하고 포인터를 기록한다. 실패해도 throw하지 않는다(파형 복원만 포기).
- `getCachedAudio(): Promise<File | null>` — 포인터가 있으면 File로 재구성해 반환, 없으면 stale 블롭을 정리하고 null.
- `clearAudio(): Promise<void>` — 블롭과 포인터를 모두 제거한다.

**calibration.ts** — sessionStorage, 수명은 탭.

- `saveCalibrationCache(values: CalibrationValues): void` / `loadCalibrationCache(): Partial<CalibrationValues> | null` — 로드가 `Partial`인 점에 주의: 호출부(`CalibrationContext`)가 기본값과 병합해야 한다.
- `saveDeviceActualCache(v: DeviceActualCache): void` / `loadDeviceActualCache(): DeviceActualCache | null` — `{ requested, actual }` 각각 `sampleRate`(Hz)·`bufferSize`(samples/ch), actual 쪽은 `null` 허용(probe 실패). Electron 캡처 probe 경로 전용.

**workspace.ts** — IndexedDB `irondevice-workspace`, 영구 보존. 전부 async(마지막 둘 제외).

- `listWorkspaceItems(): Promise<WorkspaceItemMeta[]>` — 메타만 조회, `createdAt` 내림차순. 실패 시 빈 배열.
- `saveWorkspaceItem(input: SaveWorkspaceInput): Promise<WorkspaceItemMeta | null>` — 프레임은 `slim()` 후 저장. meta/payload를 한 트랜잭션으로 쓴다.
- `renameWorkspaceItem(id: string, name: string): Promise<void>` — 이름과 `updatedAt`만 갱신한다.
- `deleteWorkspaceItem(id: string): Promise<void>` — meta/payload를 함께 삭제한다.
- `getWorkspacePayload(id: string): Promise<WorkspacePayload | null>` — 프레임 배열 + 오디오 Blob을 지연 로드한다(목록에는 싣지 않는다).
- `framesToCsv(frames: AnalysisFrame[]): string` — 헤더 `time,temperature_L,temperature_R,excursion_L,excursion_R`의 CSV를 만든다.
- `sanitizeFileName(name: string): string` — `/\:*?"<>|`를 `_`로 치환, 공백뿐이면 `"untitled"`.

공통 주의사항: 캐시된 프레임은 `slim()`을 거친 표시 전용 데이터다. 온도 모델은 상태 누적형이므로 캐시 복원값을 분석 입력이나 ground-truth로 재사용하면 안 된다.

## 6. 변경 이력(요약)
- 2026-07-09: 최초 작성 (기준 커밋: 1fbbf44, 커밋되지 않은 워크트리 변경 반영)
- 2026-07-09: 교차참조 정정 — `WorkspaceItemMeta`/`SaveWorkspaceInput` 타입 소비처를 삭제된 `WorkspaceItemRow.tsx` → `MeasurementRecordsDrawer.tsx`로 수정(섹션 4). 이 도메인의 캐시 모듈 자체는 변경 없음
- 2026-07-09: 교차참조 재정정 — `MeasurementRecordsDrawer.tsx`가 `RecordsDrawer.tsx`로 리네임됨에 따라 섹션 4의 소비처 표기를 갱신. `workspace.ts`가 노출하는 `SessionStatus`(구 `MeasurementStatus`) 타입 자체는 이 도메인 소유라 이름만 바뀌었을 뿐 내용은 그대로(섹션 3·5는 값 불변이라 손대지 않음)
