# workspace

## 1. 도메인 설명
분석 세션(오디오 원본 + 분석 프레임)을 브라우저에 영구 보존하고 다시 꺼내 쓰는 문제를 해결한다. 개발자는 이 도메인 하나로 세션 저장 목록 관리(이름 변경/삭제/JSON·CSV·오디오 내보내기), 폴더 단위 음원 탐색(Electron 로컬 폴더 감시 + 웹 `webkitdirectory` 업로드), 저장된 N채널 WAV의 채널별 파형 확인까지 처리한다. UI는 우측 슬라이딩 드로어 두 개로 나뉜다 — `WorkspaceDrawer`는 폴더에서 음원을 고르는 **파일 브라우저**, `RecordsDrawer`는 저장된 측정 세션을 파일별로 관리하는 **측정 기록** 드로어다. 상태의 단일 소스는 `WorkspaceContext`이고, 영속화 계층(IndexedDB)은 `lib/cache/workspace.ts`에 위임한다.

## 2. 프로젝트 전반에서의 역할
- `app/layout.tsx`가 `WorkspaceProvider`로 앱 전체를 감싸 어디서든 `useWorkspace()`로 같은 목록을 읽는다.
- `dashboard/DashboardClient.tsx`가 `WorkspaceDrawer`와 `RecordsDrawer`를 직접 마운트한다. 드로어를 여닫는 트리거 버튼은 `shared/components/Sidebar.tsx`에 있고, 어느 드로어가 열려 있는지는 `dashboard/ActiveDrawerContext`(배타 전환)가 관리한다. `WorkspaceContext`의 `open`/`setOpen`은 그 위의 파생값이다.
- `dashboard/DashboardClient.tsx`가 저장 버튼에서 `saveCurrent()`를 호출해 세션을 추가하고, 폴더에서 고른 파일은 `pendingLocalFile`로 받아 기존 `handleFileSelected(File)` 업로드 파이프라인에 그대로 흘려보낸 뒤 `clearPendingLocalFile()`로 소비 완료를 알린다. 저장이 끝나면 파일 브라우저가 아니라 방금 저장된 항목이 보이는 "측정 기록" 드로어가 자동으로 열린다.
- `dashboard/SelectedFilePanel.tsx`는 `setOpen(true)`만 호출해 Workspace 드로어를 여는 진입점 역할을 한다.
- 빌드별 분기: Electron 빌드는 `window.localFolder` 브리지로 네이티브 폴더 감시를 쓰고 브리지가 없는 웹/모바일 빌드는 `<input webkitdirectory>` 폴더 업로드로 같은 UX를 제공한다. 분기 기준은 런타임의 `window.localFolder` 존재 여부다.

## 3. 파일별 역할
| 파일 | 역할 |
|------|------|
| `WorkspaceContext.tsx` | 앱 전역 Context. hooks/ 3개(`useWorkspaceItems`·`useLocalFolderConnection`·`useBrowserFolderUpload`)를 조합해 `WorkspaceCtx` 값으로 노출한다. `open`/`setOpen`은 `ActiveDrawerContext`의 `active === "workspace"`에서 파생하고, 저장 성공 콜백은 "측정 기록"(`records`) 드로어를 연다. 두 폴더 소스가 공유하는 다리 상태(`pendingLocalFile`, `activeFileName`)를 직접 소유한다. `useWorkspace()` 훅 제공. |
| `WorkspaceDrawer.tsx` | 우측 슬라이딩 드로어("Workspace" 내비) — 연결된 폴더의 오디오 파일을 "폴더 → 파일" 트리로 보여주는 **파일 브라우저**다. ESC로 닫히고, 폴더 UI는 `WorkspaceFolderSection`에 위임한다. 헤더 배지는 현재 폴더의 파일 수. 트리거 버튼은 `Sidebar`가 담당한다. |
| `RecordsDrawer.tsx` | 우측 슬라이딩 드로어("측정 기록" 내비) — 저장된 측정 세션의 관리 지점. `WorkspaceContext.items`를 원본 파일명으로 그룹핑해 "파일 → 측정 기록" 접이식 트리로 보여준다. 내부 `RecordRow`가 기록 한 줄(이름 변경/삭제 + JSON/CSV/오디오/채널 내보내기)을 그리고, "채널" 버튼으로 `ChannelViewerOverlay`를 연다. (기존 `WorkspaceItemRow`의 CRUD/export가 이곳으로 이전됐다.) |
| `WorkspaceFolderSection.tsx` | Workspace 드로어의 "폴더" 섹션. `window.localFolder` 존재 여부로 Electron(폴더 연결)/브라우저(`webkitdirectory` 업로드) UI를 분기한다. 내부 `FolderFileList`가 두 소스 공용 파일 목록을 그리며 `activeFileName`과 이름이 같은 항목을 선택 표시한다. |
| `ChannelViewerOverlay.tsx` | 저장 세션의 채널별 파형 전체 화면 오버레이. 셸과 진입/이탈 전환은 공용 `shared/components/overlay/FullscreenOverlay` + `hooks/useOverlayTransition`(ChartDetailOverlay와 같은 부품)에 위임한다. IndexedDB 페이로드의 `audioBlob`을 `decodeAudioChannels()`로 디코딩해 채널마다 `components/channel`의 `ChannelWaveformCanvas`(LTTB 단일 선) + `ChannelRowHeader`(peak/RMS)를 그린다. 채널 라벨/색(ch0=V, ch1=I, ch2 이후 확장)은 `lib/render/channel-meta.ts`에서 받아 넘긴다. |
| `hooks/useWorkspaceItems.ts` | 저장 목록 상태 + CRUD/내보내기 액션. `lib/cache/workspace.ts`의 IndexedDB 함수를 감싸고 매 변경 후 `refresh()`로 목록을 다시 읽는다. 저장 성공 시 `onSaved()` 콜백(Context에서는 "측정 기록" 드로어 열기)을 호출한다. |
| `hooks/useLocalFolderConnection.ts` | Electron 전용 로컬 폴더 연결 상태. `window.localFolder.select/unwatch/onChanged`를 감싸고 파일 로드는 `readLocalAudioFile()`(IPC 읽기)로 `File`을 만들어 `onFileLoad(file, name)`에 넘긴다. |
| `hooks/useBrowserFolderUpload.ts` | 웹/모바일 폴더 업로드 상태. `FileList`에서 `webkitRelativePath` 최상위 폴더명을 뽑고 MIME `audio/*` 또는 확장자 `wav/mp3/flac/aac/m4a/ogg`만 걸러 보관한다. `File`을 이미 들고 있어 로드 시 IPC 없이 바로 `onFileLoad`로 전달한다. |

## 4. 의존성 및 흐름
이 도메인이 가져다 쓰는 모듈 (workspace → 외부):
- `dashboard/ActiveDrawerContext.tsx` — `useActiveDrawer()`로 우측 드로어 배타 전환 상태(`active`/`openDrawer`/`closeDrawer`)를 읽는다. `WorkspaceContext`(open/setOpen 파생, 저장 후 records 열기)와 `RecordsDrawer`(open 판정)가 쓴다.
- `lib/cache/workspace.ts` — IndexedDB(`irondevice-workspace` DB, `meta`/`payload` 2스토어) 영속화. 프레임은 `slim()`으로 `time/temperature/excursion`만 저장한다. `framesToCsv()`(헤더 `time,temperature_L,temperature_R,excursion_L,excursion_R`), `sanitizeFileName()`도 여기서 온다.
- `lib/local-folder.ts` — `readLocalAudioFile(entry)`: `window.localFolder.readFile(path)` IPC 결과를 `File`로 감싼다. 브리지가 없으면 throw.
- `lib/wav-decoder.ts` — `decodeAudioChannels(blob)`: RIFF 청크를 직접 파싱해 int16/int32/float32 PCM WAV를 채널별 평면 `Float32Array`([-1,1] 정규화)로 변환하고 WAV가 아니면(원본 mp3 저장 등) `decodeAudioData`로 폴백한다. `wav-encoder.ts`가 만든 N채널 int32 PCM WAV를 되읽는 것이 1차 목적이다(디코더 소스에 명시).
- `components/channel/*` — `ChannelViewerOverlay`가 채널별 렌더에 `ChannelWaveformCanvas`/`channelStats`/`ChannelRowHeader`를 쓴다(실시간 상세 뷰와 공유하는 부품).
- `shared/components/overlay/*`·`shared/hooks/*` — 드로어 셸(`SideDrawer`)·전체화면 오버레이 셸(`FullscreenOverlay`)·ESC 닫기(`useEscapeKey`)·오버레이 전환(`useOverlayTransition`)을 공용 부품으로 쓴다. `WorkspaceDrawer`/`RecordsDrawer`는 `SideDrawer` + `useEscapeKey`, `ChannelViewerOverlay`는 `FullscreenOverlay` + `useOverlayTransition`.
- `features/audio/types.ts`의 `AnalysisFrame`(캐시 모듈 경유), `shared/lib/utils.ts`의 `cn/formatTime/formatFileSize/downloadBlob`, `shared/types/electron-bridge.d.ts`의 `window.localFolder` 타입.

이 도메인을 가져다 쓰는 모듈 (외부 → workspace):
- `app/layout.tsx` → `WorkspaceProvider`
- `dashboard/DashboardClient.tsx` → `WorkspaceDrawer`·`RecordsDrawer` 마운트 + `useWorkspace()`의 `saveCurrent`/`pendingLocalFile`/`clearPendingLocalFile`
- `dashboard/SelectedFilePanel.tsx` → `useWorkspace()`의 `setOpen`
- `shared/components/Sidebar.tsx` → `ActiveDrawerContext`로 두 드로어를 여닫는 트리거

주요 흐름:
```
[저장]  DashboardClient(저장 버튼) → saveCurrent(SaveWorkspaceInput)
        → saveWorkspaceItem(IndexedDB) → refresh() → openDrawer("records") (측정 기록 자동 열림)

[폴더 로드]  WorkspaceDrawer → WorkspaceFolderSection 파일 클릭
        Electron: loadLocalFile → readLocalAudioFile(IPC) → File ┐
        웹:       loadBrowserFile → 보관 중인 File 그대로       ┴→ onFileLoad
        → pendingLocalFile/activeFileName 갱신
        → DashboardClient useEffect가 소비 → handleFileSelected(File) → clearPendingLocalFile()

[채널 뷰]  RecordsDrawer RecordRow "채널" → ChannelViewerOverlay
        → getWorkspacePayload(item.id) → payload.audioBlob
        → decodeAudioChannels() → 채널별 Float32Array → ChannelWaveformCanvas(LTTB) + peak/RMS
```

## 5. 주요 인터페이스 / 진입점
- `WorkspaceProvider({ children })` — Context 공급자. `app/layout.tsx`에서 1회 마운트한다. 이 바깥에서 `useWorkspace()`를 부르면 throw.
- `useWorkspace(): WorkspaceCtx` — 도메인 밖에서 쓰는 유일한 훅. 주요 필드:
  - `saveCurrent(input: SaveWorkspaceInput): Promise<void>` — 세션 저장. 프레임은 저장 시 차트 렌더 필드만 남긴다(캐시는 표시용이라는 프로젝트 규칙과 동일). 저장 후 "측정 기록" 드로어가 자동으로 열린다.
  - `rename(id, name)` / `remove(id)` — 항목 이름 변경/삭제(meta+payload 동시 삭제).
  - `exportJson(meta)` / `exportCsv(meta)` / `downloadAudio(meta)` — 브라우저 다운로드 트리거. `downloadAudio`는 `payload.audioBlob`이 없으면 아무 것도 하지 않는다.
  - `open: boolean` + `setOpen(v)` — `ActiveDrawerContext`의 `active === "workspace"`에서 파생. `setOpen(true)`는 `openDrawer("workspace")`, `setOpen(false)`는 `closeDrawer()`로 위임한다.
  - `pendingLocalFile: File | null` + `clearPendingLocalFile()` — 폴더에서 고른 파일을 대시보드로 넘기는 다리. 소비자(DashboardClient)가 반드시 clear를 호출해야 재선택이 다음 렌더에 반영된다.
  - `connectLocalFolder()` / `disconnectLocalFolder()` / `loadLocalFile(entry)` — Electron 전용. `window.localFolder`가 없으면 no-op(로드만 에러 메시지 상태로 남는다).
  - `selectBrowserFolder(files)` / `disconnectBrowserFolder()` / `loadBrowserFile(file)` — 웹/모바일 폴더 업로드 경로.
  - `activeFileName: string | null` — 마지막 로드 파일 이름. 폴더 목록의 선택 하이라이트는 파일 이름 문자열 일치로 판정한다.
- `WorkspaceDrawer()` — 폴더 파일 브라우저 드로어. `DashboardClient`에서 마운트, 트리거는 `Sidebar`.
- `RecordsDrawer()` — 저장된 측정 세션의 파일별 트리 + CRUD/export 드로어. `DashboardClient`에서 마운트, 트리거는 `Sidebar`. `open` 판정은 `ActiveDrawerContext.active === "records"`.
- `ChannelViewerOverlay({ item: WorkspaceItemMeta, onClose }: Props)` — 채널별 파형 오버레이. `RecordsDrawer`의 `RecordRow` "채널" 버튼에서 연다. 이탈 시 250ms 전환 후 `onClose()`를 호출하고, 저장된 `audioBlob`이 없으면 "이 세션에는 저장된 오디오가 없습니다."를 표시한다.
- `WorkspaceItemMeta` / `SaveWorkspaceInput` — 타입의 원 정의는 `lib/cache/workspace.ts`이며 이 도메인은 재노출 없이 그대로 import한다.

## 6. 변경 이력(요약)
- 2026-07-09: 최초 작성 (기준 커밋: 1fbbf44, 커밋되지 않은 워크트리 변경 반영)
- 2026-07-09: 드로어 이원화 반영 — 저장 세션 CRUD/export를 `WorkspaceItemRow`(삭제)에서 신규 `RecordsDrawer`(파일별 그룹 트리 + `RecordRow`)로 이전, `WorkspaceDrawer`는 폴더 파일 브라우저 전용으로 축소. `Header` 삭제에 따라 드로어 마운트는 `DashboardClient`, 여닫는 트리거는 `Sidebar`+`ActiveDrawerContext`로 이동, 저장 완료 시 "측정 기록" 드로어가 열리도록 변경. 섹션 1·2·3·4·5 갱신 (커밋 범위: e0add14..HEAD, 워크트리 포함)
- 2026-07-09: `MeasurementRecordsDrawer` → `RecordsDrawer` 리네임 반영 — 파일도 `MeasurementRecordsDrawer.tsx`에서 `RecordsDrawer.tsx`로 이동. `dashboard/hooks/useMeasurementCapture.ts`·`MeasurementExport`(성능 측정 하네스)와 이름이 겹쳐 혼동을 주던 문제를 없애기 위한 순수 리네임으로 동작 변화는 없음. 섹션 1·2·3·4·5의 관련 언급 갱신 (커밋 범위: 9242fd2..HEAD, 워크트리 포함)
- 2026-07-10: 공용 부품 위임 반영 — `WorkspaceDrawer`/`RecordsDrawer`가 드로어 셸을 `shared/components/overlay/SideDrawer`로, ESC 닫기를 `hooks/useEscapeKey`로 위임. `ChannelViewerOverlay`는 셸을 `FullscreenOverlay` + `useOverlayTransition`으로 바꾸고, 채널 렌더 부품을 `components/chart`에서 신설 `components/channel`(`ChannelWaveformCanvas`/`channelStats`/`ChannelRowHeader`)로 이동한 경로로 참조. 렌더는 min/max 엔벨로프가 아니라 LTTB 단일 선(주석 정정 반영). 섹션 3·4 부분 갱신 (커밋 범위: 537099f..HEAD, 워크트리 포함)
