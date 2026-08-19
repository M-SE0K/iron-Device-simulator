# workspace

## 1. 도메인 설명

저장된 분석 세션(Records)과 로컬 폴더 파일 브라우징(Workspace)을 관리하는 도메인입니다. Dashboard의 "저장" 버튼이 만든 결과를 목록으로 보여줍니다. 각 항목은 JSON/CSV/오디오 WAV(V/I 캡처본, 보호 처리본)로 내보낼 수 있습니다.

## 2. 프로젝트 전반에서의 역할

이름과 달리 지금은 서랍이 둘로 나뉘어 있습니다 — `WorkspaceDrawer`(로컬 폴더 파일 열기)와 `RecordsDrawer`(저장된 세션 목록, 파일별 그룹핑 + 이름변경/삭제/내보내기). 두 서랍 모두 열림 상태를 피처 루트 `components/ActiveDrawerContext`의 `useDrawerState()`에서 파생하므로(단일 활성 서랍 원칙) 따로 두지 않습니다. 이 도메인의 상태 소스는 `WorkspaceContext` 하나뿐입니다. 저장 항목 목록과 로컬 폴더 연결 상태를 여기에 모아 둡니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `WorkspaceContext.tsx` | 전역 컨텍스트. 저장 항목 목록과 로컬 폴더 상태를 묶고 `open`/`setOpen`은 `components/ActiveDrawerContext`의 `useDrawerState("workspace")`에서 파생 |
| `WorkspaceDrawer.tsx` | 로컬 폴더 파일 브라우저 서랍(`SideDrawer` 셸 + `WorkspaceFolderSection`) |
| `WorkspaceFolderSection.tsx` | 로컬 폴더 연결 버튼과 파일 트리 UI |
| `RecordsDrawer.tsx` | 저장된 세션 목록 서랍(`useDrawerState("records")`). 파일명으로 그룹핑하고 각 항목(`RecordRow`)에 이름변경(더블클릭/연필)·삭제·내보내기(JSON/CSV/V-I WAV/Protected WAV) 액션 제공 |
| `hooks/useWorkspaceItems.ts` | IndexedDB CRUD와 내보내기(JSON/CSV/오디오/Protected 오디오) 액션 |
| `hooks/useLocalFolderConnection.ts` | `window.localFolder`(Tauri) 연결, 파일 목록 갱신, 파일 로드 |

저장 WAV를 채널별 파형으로 다시 열어보던 `ChannelViewerOverlay.tsx`는 삭제됐습니다 — 항목별 채널 뷰 액션은 더 이상 없고 채널 파형은 대시보드 View 그리드의 실시간 채널 카드에서만 봅니다.

## 4. 의존성 및 흐름

- **가져오는 것**: `lib/cache/workspace`(IndexedDB CRUD), `lib/export/csv`(`framesToCsv`), `lib/local-folder`(`readLocalAudioFile`), `lib/units`(`formatMm`), `shared/lib/utils`(`downloadBlob`/`sanitizeFileName`/`splitFileName`/`cn`/`formatTime`), `shared/lib/ipc-error`, `shared/components/error-popup`, `shared/components/overlay/SideDrawer`, `shared/components/ui/CountBadge`, `shared/hooks/useGlobalKey`(`useEscapeKey`).
- **피처 루트와의 접점**: `WorkspaceContext`·`RecordsDrawer` 둘 다 자체 열림 상태 대신 `components/ActiveDrawerContext`의 `useDrawerState()`를 가져다 씁니다. 저장이 성공하면 `useActiveDrawer().openDrawer("records")`로 Records 서랍을 엽니다.
- **Tauri 네이티브 브리지**: `window.localFolder`.
- **소비하는 도메인**: `dashboard/`가 `WorkspaceDrawer`와 `RecordsDrawer`를 마운트하고 `useWorkspace()`의 `saveCurrent`/`pendingLocalFile`/`clearPendingLocalFile`을 가져다 씁니다. `SelectedFilePanel`은 `setOpen(true)`로 Workspace 서랍을 엽니다.

```
components/ActiveDrawerContext(피처 루트) → useDrawerState("workspace") / useDrawerState("records") (단일 활성)

로컬 폴더 연결 → window.localFolder.select() → useLocalFolderConnection → WorkspaceFolderSection 트리 렌더
파일 클릭 → loadLocalFile() → onFileLoad → WorkspaceContext.pendingLocalFile → dashboard가 소비해 재생 시작

Dashboard "저장" 클릭 → WorkspaceContext.saveCurrent() → useWorkspaceItems
    → lib/cache/workspace(IndexedDB) 저장 → onSaved() → RecordsDrawer 자동으로 열림

RecordsDrawer 항목 액션 → exportJson/exportCsv/downloadAudio(V/I WAV)/downloadProtectedAudio(Protected WAV) → downloadBlob()
```

## 5. 주요 인터페이스 / 진입점

- **`WorkspaceProvider`** / **`useWorkspace(): WorkspaceCtx`** — `items`, `open`/`setOpen`, `saveCurrent`, `rename`, `remove`, `exportJson`/`exportCsv`/`downloadAudio`/`downloadProtectedAudio`, 로컬 폴더 상태·함수(`localFolderPath`/`localFolderFiles`/`localFolderError`/`localFolderConnecting`/`connectLocalFolder`/`disconnectLocalFolder`/`loadLocalFile`), `activeFileName`, `pendingLocalFile`/`clearPendingLocalFile`.
- **`WorkspaceDrawer`** / **`RecordsDrawer`** — props 없음(둘 다 `memo`). `WorkspaceDrawer`는 `useWorkspace()`의 `open`/`setOpen`을, `RecordsDrawer`는 `useDrawerState("records")`를 직접 구독합니다.
- **`useWorkspaceItems(onSaved: () => void)`** — `WorkspaceCtx`의 `items`부터 `downloadProtectedAudio`까지를 구현합니다. 저장이 성공하면 `onSaved()`를 호출합니다. 호출자는 이걸로 `RecordsDrawer`를 엽니다.
- **`useLocalFolderConnection(onFileLoad: (file, name) => void)`** — `WorkspaceCtx`의 로컬 폴더 쪽을 담당합니다.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — 현재 코드 기준. 저장 항목 목록 UI가 `WorkspaceItemRow`에서 `RecordsDrawer.tsx`(`RecordRow`)로 옮겨가 별도의 "Records" 서랍으로 분리됐고 `ActiveDrawerContext` 도입으로 열림 상태가 `dashboard/`에서 파생되는 지금 구조를 반영했습니다(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
- 2026-08-19: `ChannelViewerOverlay.tsx` 삭제 반영 — 저장 항목의 채널 뷰 액션이 사라지고 내보내기 4종(JSON/CSV/V-I WAV/Protected WAV)만 남았습니다(채널 파형 확인은 대시보드 View 그리드로 일원화). 그에 따라 `lib/codec/wav-decoder`·`lib/render/{wave-store,waveform,channel-meta}` 의존이 소멸했습니다. 열림 상태 파생은 `useDrawerState()` 헬퍼로 정리됐고 참조 경로가 `dashboard/ActiveDrawerContext`에서 피처 루트 `components/ActiveDrawerContext`로 바뀌었으며, `setOpen`이 `WorkspaceCtx` 컨텍스트 값에 실제로 포함됐습니다(이전엔 타입에만 있고 값에서 빠져 있었음). `useEscapeKey`는 `shared/hooks/useGlobalKey` 소속이 됐습니다. 섹션 1·2·3·4·5 갱신 (커밋 범위: 4d86f32..24d1daa)
