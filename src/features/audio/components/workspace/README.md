# workspace

## 1. 도메인 설명

저장된 분석 세션(Records)과 로컬 폴더 파일 브라우징(Workspace)을 관리하는 도메인입니다. Dashboard의 "저장" 버튼이 만든 결과를 목록으로 보여줍니다. 각 항목은 JSON/CSV/오디오로 내보내거나 채널별 파형을 다시 열어볼 수 있습니다.

## 2. 프로젝트 전반에서의 역할

이름과 달리 지금은 서랍이 둘로 나뉘어 있습니다 — `WorkspaceDrawer`(로컬 폴더 파일 열기)와 `RecordsDrawer`(저장된 세션 목록, 파일별 그룹핑 + 이름변경/삭제/내보내기/채널뷰). 열림 상태는 두 서랍 모두 `dashboard/ActiveDrawerContext`의 `useDrawerState(key)`에서 받아 오므로(단일 활성 서랍 원칙) 따로 두지 않습니다. 이 도메인의 상태 소스는 `WorkspaceContext` 하나뿐입니다. 저장 항목 목록도, 로컬 폴더 연결 상태도 여기 한곳에 모여 있습니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `WorkspaceContext.tsx` | 전역 컨텍스트. 저장 항목 목록과 로컬 폴더 상태를 묶고 `open`/`setOpen`은 `useDrawerState("workspace")`에서 가져온다 |
| `WorkspaceDrawer.tsx` | 로컬 폴더 파일 브라우저 서랍(`SideDrawer` 셸 + `WorkspaceFolderSection`) |
| `WorkspaceFolderSection.tsx` | 로컬 폴더 연결 버튼과 파일 트리 UI |
| `RecordsDrawer.tsx` | 저장된 세션 목록 서랍. 파일명으로 그룹핑하고 각 항목(`RecordRow`)에 이름변경/삭제/내보내기(JSON/CSV/V/I WAV/Protected WAV)/채널뷰 액션 제공 |
| `ChannelViewerOverlay.tsx` | 저장된 WAV를 채널별로 디코딩해 파형과 peak/RMS를 보여주는 전체화면 오버레이 |
| `hooks/useWorkspaceItems.ts` | IndexedDB CRUD와 내보내기(JSON/CSV/오디오/Protected 오디오) 액션. 세 뮤테이션(저장·이름변경·삭제)은 `runWorkspaceMutation` 하나로 모아 실패 시 에러 팝업, 성공 시 목록 갱신을 공통 처리한다 |
| `hooks/useLocalFolderConnection.ts` | `window.localFolder`(Tauri) 연결, 파일 목록 갱신, 파일 로드 |

## 4. 의존성 및 흐름

- **가져오는 것**: `lib/cache/workspace`, `lib/export/csv`, `lib/local-folder`, `lib/units`의 `formatMm`, `lib/codec/wav-decoder`(`ChannelViewerOverlay`), `lib/render/{wave-store, waveform, channel-meta}`(`ChannelViewerOverlay`), `shared/lib/utils`, `shared/lib/download`의 `downloadBlob`, `shared/lib/ipc-error`, `shared/components/error-popup`, `shared/components/overlay/FullscreenOverlay`.
- **`dashboard/`와의 접점**: `WorkspaceContext`와 `RecordsDrawer` 둘 다 열림 상태를 직접 들지 않고 `dashboard/ActiveDrawerContext`를 씁니다. 파생은 `useDrawerState(key)`가 맡습니다. `WorkspaceProvider`는 저장에 성공하면 Records 서랍을 열어야 해서 `useActiveDrawer()`까지 함께 가져옵니다.
- **`channel/`과의 접점**: `ChannelViewerOverlay`가 `ChannelWaveformCanvas`를 그대로 재사용합니다. 저장본에는 캡처 원본 PCM 스냅샷이 없어 `raw` prop을 넘기지 않습니다. 그래서 확대해도 엔벨로프 해상도까지만 보입니다. 채널 역할 이름은 이 파일이 `CHANNEL_ROLE_LABELS` 상수로 직접 들고 있습니다.
- **Tauri 네이티브 브리지**: `window.localFolder`.
- **소비하는 도메인**: `dashboard/`가 `WorkspaceDrawer`와 `RecordsDrawer`를 마운트하고 `useWorkspace()`의 `saveCurrent`/`pendingLocalFile`/`clearPendingLocalFile`을 가져다 씁니다.

```
dashboard/ActiveDrawerContext → useDrawerState("workspace") / useDrawerState("records")로 열림 상태 파생(단일 활성)

로컬 폴더 연결 → window.localFolder.select() → useLocalFolderConnection → WorkspaceFolderSection 트리 렌더
파일 클릭 → loadLocalFile() → onFileLoad → WorkspaceContext.pendingLocalFile → dashboard가 소비해 재생 시작

Dashboard "저장" 클릭 → WorkspaceContext.saveCurrent() → useWorkspaceItems.runWorkspaceMutation
    → lib/cache/workspace(IndexedDB) 저장 → refresh() → onSaved() → RecordsDrawer 자동으로 열림

RecordsDrawer 항목 액션 → exportJson/exportCsv/downloadAudio/downloadProtectedAudio → downloadBlob()
RecordsDrawer 항목 "채널" 액션 → ChannelViewerOverlay → wav-decoder.decodeAudioChannels() → 채널별 파형
```

## 5. 주요 인터페이스 / 진입점

- **`WorkspaceProvider`** / **`useWorkspace(): WorkspaceCtx`** — `items`, `open`/`setOpen`, `saveCurrent`, `rename`, `remove`, `exportJson`/`exportCsv`/`downloadAudio`/`downloadProtectedAudio`, 로컬 폴더 상태·함수(`localFolderPath`/`localFolderFiles`/`localFolderError`/`localFolderConnecting`/`connectLocalFolder`/`disconnectLocalFolder`/`loadLocalFile`), `activeFileName`, `pendingLocalFile`/`clearPendingLocalFile`.
- **`WorkspaceDrawer`** / **`RecordsDrawer`** — props 없음. 각자 `useWorkspace()`와 `useDrawerState()`를 직접 구독합니다.
- **`useWorkspaceItems(onSaved: () => void)`** — `WorkspaceCtx`의 `items`부터 `downloadProtectedAudio`까지를 구현합니다. 저장이 성공하면 `onSaved()`를 호출합니다 — 호출자는 이걸로 `RecordsDrawer`를 엽니다. 이름변경·삭제는 성공해도 콜백 없이 목록만 갱신합니다.
- **`useLocalFolderConnection(onFileLoad: (file, name) => void)`** — `WorkspaceCtx`의 로컬 폴더 쪽을 담당합니다.
- **`ChannelViewerOverlay({ item: WorkspaceItemMeta, onClose })`** — 저장 항목 하나를 받아 채널별 파형 오버레이를 띄웁니다.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — 현재 코드 기준. 저장 항목 목록 UI가 `WorkspaceItemRow`에서 `RecordsDrawer.tsx`(`RecordRow`)로 옮겨가 별도의 "Records" 서랍으로 분리됐고 `ActiveDrawerContext` 도입으로 열림 상태가 `dashboard/`에서 파생되는 지금 구조를 반영했습니다(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
- 2026-08-11: 서랍 상태 파생과 저장본 채널 뷰 변경을 반영했습니다. `WorkspaceContext`·`RecordsDrawer`가 각자 반복하던 `useActiveDrawer()` 파생 코드는 신설 `useDrawerState(key)`로 바꿨습니다(§2·§4·§5). `useWorkspaceItems`에서는 저장·이름변경·삭제가 제각기 갖고 있던 try/catch·refresh 중복을 `runWorkspaceMutation` 하나로 합쳤습니다. `downloadBlob` import 경로는 `shared/lib/utils`에서 `shared/lib/download`로 옮겼습니다. `ChannelViewerOverlay`는 확대 시 원본을 다시 잘라 주던 `fetchRange` prop을 더 넘기지 않습니다. 저장본 파형이 엔벨로프 해상도까지만 보이는 이유입니다. `channelLabel()`이 역할 이름을 인자로 받게 되면서 `CHANNEL_ROLE_LABELS` 상수도 직접 들고 있습니다. Records의 오디오 내보내기 라벨은 `V/I`에서 `V/I WAV`로 바뀌었습니다. 섹션 2·3·4·5 부분 갱신 (커밋 범위: 4d86f32..HEAD, 작업 트리 포함)
