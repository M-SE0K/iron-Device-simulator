# workspace

## 1. 도메인 설명

저장된 분석 세션(Records)과 로컬 폴더 파일 브라우징(Workspace)을 관리하는 도메인입니다. Dashboard의 "저장" 버튼이 만든 결과를 목록으로 보여줍니다. 각 항목은 JSON/CSV/오디오로 내보내거나 채널별 파형을 다시 열어볼 수 있습니다.

## 2. 프로젝트 전반에서의 역할

이름과 달리 지금은 서랍이 둘로 나뉘어 있습니다 — `WorkspaceDrawer`(로컬 폴더 파일 열기)와 `RecordsDrawer`(저장된 세션 목록, 파일별 그룹핑 + 이름변경/삭제/내보내기/채널뷰). 두 서랍 모두 `dashboard/`의 `ActiveDrawerContext`에서 열림 상태를 가져오므로(단일 활성 서랍 원칙) 열림 상태를 따로 두지 않습니다. 이 도메인의 상태 소스는 `WorkspaceContext` 하나뿐입니다. 저장 항목 목록과 로컬 폴더 연결 상태를 한 컨텍스트에 모아 둡니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `WorkspaceContext.tsx` | 전역 컨텍스트. 저장 항목 목록과 로컬 폴더 상태를 묶고 `open` 상태는 `dashboard/ActiveDrawerContext`에서 파생 |
| `WorkspaceDrawer.tsx` | 로컬 폴더 파일 브라우저 서랍(`SideDrawer` 셸 + `WorkspaceFolderSection`) |
| `WorkspaceFolderSection.tsx` | 로컬 폴더 연결 버튼과 파일 트리 UI |
| `RecordsDrawer.tsx` | 저장된 세션 목록 서랍. 파일명으로 그룹핑하고 각 항목(`RecordRow`)에 이름변경/삭제/내보내기(JSON/CSV/V-I WAV/Protected WAV)/채널뷰 액션 제공 |
| `ChannelViewerOverlay.tsx` | 저장된 WAV를 채널별로 디코딩해 파형과 peak/RMS를 보여주는 전체화면 오버레이 |
| `hooks/useWorkspaceItems.ts` | IndexedDB CRUD와 내보내기(JSON/CSV/오디오/Protected 오디오) 액션 |
| `hooks/useLocalFolderConnection.ts` | `window.localFolder`(Tauri) 연결, 파일 목록 갱신, 파일 로드 |

## 4. 의존성 및 흐름

- **가져오는 것**: `lib/cache/workspace`, `lib/export/csv`, `lib/local-folder`, `lib/codec/wav-decoder`(`ChannelViewerOverlay`), `lib/render/{wave-store, waveform, channel-meta}`(`ChannelViewerOverlay`), `shared/lib/utils`, `shared/lib/ipc-error`, `shared/components/error-popup`.
- **`dashboard/`와의 접점**: `WorkspaceContext`와 `RecordsDrawer` 둘 다 자체 열림 상태 대신 `dashboard/ActiveDrawerContext`의 `useActiveDrawer()`를 가져다 씁니다.
- **Tauri 네이티브 브리지**: `window.localFolder`.
- **소비하는 도메인**: `dashboard/`가 `WorkspaceDrawer`와 `RecordsDrawer`를 마운트하고 `useWorkspace()`의 `saveCurrent`/`pendingLocalFile`/`clearPendingLocalFile`을 가져다 씁니다.

```
dashboard/ActiveDrawerContext → WorkspaceContext.open("workspace") / RecordsDrawer.open("records") 파생(단일 활성)

로컬 폴더 연결 → window.localFolder.select() → useLocalFolderConnection → WorkspaceFolderSection 트리 렌더
파일 클릭 → loadLocalFile() → onFileLoad → WorkspaceContext.pendingLocalFile → dashboard가 소비해 재생 시작

Dashboard "저장" 클릭 → WorkspaceContext.saveCurrent() → useWorkspaceItems
    → lib/cache/workspace(IndexedDB) 저장 → onSaved() → RecordsDrawer 자동으로 열림

RecordsDrawer 항목 액션 → exportJson/exportCsv/downloadAudio/downloadProtectedAudio → downloadBlob()
RecordsDrawer 항목 "채널" 액션 → ChannelViewerOverlay → wav-decoder.decodeAudioChannels() → 채널별 파형
```

## 5. 주요 인터페이스 / 진입점

- **`WorkspaceProvider`** / **`useWorkspace(): WorkspaceCtx`** — `items`, `open`/`setOpen`, `saveCurrent`, `rename`, `remove`, `exportJson`/`exportCsv`/`downloadAudio`/`downloadProtectedAudio`, 로컬 폴더 상태·함수(`localFolderPath`/`localFolderFiles`/`localFolderError`/`localFolderConnecting`/`connectLocalFolder`/`disconnectLocalFolder`/`loadLocalFile`), `activeFileName`, `pendingLocalFile`/`clearPendingLocalFile`.
- **`WorkspaceDrawer`** / **`RecordsDrawer`** — props 없음. 각자 `useWorkspace()`와 `useActiveDrawer()`를 직접 구독합니다.
- **`useWorkspaceItems(onSaved: () => void)`** — `WorkspaceCtx`의 `items`부터 `downloadProtectedAudio`까지를 구현합니다. 저장이 성공하면 `onSaved()`를 호출합니다 — 호출자는 이걸로 `RecordsDrawer`를 엽니다.
- **`useLocalFolderConnection(onFileLoad: (file, name) => void)`** — `WorkspaceCtx`의 로컬 폴더 쪽을 담당합니다.
- **`ChannelViewerOverlay({ item: WorkspaceItemMeta, onClose })`** — 저장 항목 하나를 받아 채널별 파형 오버레이를 띄웁니다.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — 현재 코드 기준. 저장 항목 목록 UI가 `WorkspaceItemRow`에서 `RecordsDrawer.tsx`(`RecordRow`)로 옮겨가 별도의 "Records" 서랍으로 분리됐고 `ActiveDrawerContext` 도입으로 열림 상태가 `dashboard/`에서 파생되는 지금 구조를 반영했습니다(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
