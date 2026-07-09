# workspace

## 1. 도메인 설명
분석 세션(오디오 원본 + 분석 프레임)을 브라우저에 영구 보존하고 다시 꺼내 쓰는 문제를 해결한다. 개발자는 이 도메인 하나로 세션 저장 목록 관리(이름 변경/삭제/JSON·CSV·오디오 내보내기), 폴더 단위 음원 탐색(Electron 로컬 폴더 감시 + 웹 `webkitdirectory` 업로드), 저장된 N채널 WAV의 채널별 파형 확인까지 처리한다. UI는 좌측 슬라이딩 드로어(WorkspaceDrawer)이고 상태의 단일 소스는 `WorkspaceContext`다. 영속화 계층(IndexedDB)은 `lib/cache/workspace.ts`에 위임하고 이 도메인은 그 위의 상태·액션·UI만 담당한다.

## 2. 프로젝트 전반에서의 역할
- `app/layout.tsx`가 `WorkspaceProvider`로 앱 전체를 감싸 어디서든 `useWorkspace()`로 같은 목록을 읽는다.
- `shared/components/Header.tsx`가 `WorkspaceDrawer`를 마운트한다 — 헤더의 트리거 버튼과 드로어 본체가 한 컴포넌트 안에 있다.
- `dashboard/DashboardClient.tsx`가 저장 버튼에서 `saveCurrent()`를 호출해 세션을 추가하고 폴더에서 고른 파일은 `pendingLocalFile`로 받아 기존 `handleFileSelected(File)` 업로드 파이프라인에 그대로 흘려보낸 뒤 `clearPendingLocalFile()`로 소비 완료를 알린다.
- `dashboard/SelectedFilePanel.tsx`는 `setOpen(true)`만 호출해 드로어를 여는 진입점 역할을 한다.
- 빌드별 분기: Electron 빌드는 `window.localFolder` 브리지로 네이티브 폴더 감시를 쓰고 브리지가 없는 웹/모바일 빌드는 `<input webkitdirectory>` 폴더 업로드로 같은 UX를 제공한다. 분기 기준은 런타임의 `window.localFolder` 존재 여부다.

## 3. 파일별 역할
| 파일 | 역할 |
|------|------|
| `WorkspaceContext.tsx` | 앱 전역 Context. hooks/ 3개(`useWorkspaceItems`·`useLocalFolderConnection`·`useBrowserFolderUpload`)를 조합해 `WorkspaceCtx` 값으로 노출한다. 두 폴더 소스가 공유하는 다리 상태(`pendingLocalFile`, `activeFileName`)를 직접 소유한다. `useWorkspace()` 훅 제공. |
| `WorkspaceDrawer.tsx` | 좌측 슬라이딩 드로어 + 헤더 트리거 버튼(저장 개수 배지). ESC로 닫힘. 저장 목록이 비면 안내 문구, 있으면 `WorkspaceItemRow` 목록을 렌더링한다. 폴더 UI는 `WorkspaceFolderSection`에 위임한다. |
| `WorkspaceFolderSection.tsx` | 드로어 상단의 "폴더" 섹션. `window.localFolder` 존재 여부로 Electron(폴더 연결)/브라우저(`webkitdirectory` 업로드) UI를 분기한다. 내부 `FolderFileList`가 두 소스 공용 파일 목록을 그리며 `activeFileName`과 이름이 같은 항목을 선택 표시한다. |
| `WorkspaceItemRow.tsx` | 저장 항목 한 줄. 더블클릭/연필 아이콘으로 이름 변경, 삭제, JSON·CSV 내보내기. `item.audioFileName`이 있을 때만 "오디오" 다운로드와 "채널" 액션(`ChannelViewerOverlay` 열기)을 추가한다. |
| `ChannelViewerOverlay.tsx` | 저장 세션의 채널별 파형 전체 화면 오버레이(`z-[60]`, ChartDetailOverlay와 동일한 진입/이탈 전환). IndexedDB 페이로드의 `audioBlob`을 `decodeAudioChannels()`로 디코딩해 채널마다 캔버스 min/max 엔벨로프 파형 + peak/RMS 통계를 그린다. 채널 의미는 ch0=V(전압), ch1=I(전류), ch2 이후 확장으로 라벨링한다. |
| `hooks/useWorkspaceItems.ts` | 저장 목록 상태 + CRUD/내보내기 액션. `lib/cache/workspace.ts`의 IndexedDB 함수를 감싸고 매 변경 후 `refresh()`로 목록을 다시 읽는다. 저장 성공 시 `onSaved()` 콜백(Context에서는 드로어 자동 열기)을 호출한다. |
| `hooks/useLocalFolderConnection.ts` | Electron 전용 로컬 폴더 연결 상태. `window.localFolder.select/unwatch/onChanged`를 감싸고 파일 로드는 `readLocalAudioFile()`(IPC 읽기)로 `File`을 만들어 `onFileLoad(file, name)`에 넘긴다. |
| `hooks/useBrowserFolderUpload.ts` | 웹/모바일 폴더 업로드 상태. `FileList`에서 `webkitRelativePath` 최상위 폴더명을 뽑고 MIME `audio/*` 또는 확장자 `wav/mp3/flac/aac/m4a/ogg`만 걸러 보관한다. `File`을 이미 들고 있어 로드 시 IPC 없이 바로 `onFileLoad`로 전달한다. |

## 4. 의존성 및 흐름
이 도메인이 가져다 쓰는 모듈 (workspace → 외부):
- `lib/cache/workspace.ts` — IndexedDB(`irondevice-workspace` DB, `meta`/`payload` 2스토어) 영속화. 프레임은 `slim()`으로 `time/temperature/excursion`만 저장한다. `framesToCsv()`(헤더 `time,temperature_L,temperature_R,excursion_L,excursion_R`), `sanitizeFileName()`도 여기서 온다.
- `lib/local-folder.ts` — `readLocalAudioFile(entry)`: `window.localFolder.readFile(path)` IPC 결과를 `File`로 감싼다. 브리지가 없으면 throw.
- `lib/wav-decoder.ts` — `decodeAudioChannels(blob)`: RIFF 청크를 직접 파싱해 int16/int32/float32 PCM WAV를 채널별 평면 `Float32Array`([-1,1] 정규화)로 변환하고 WAV가 아니면(원본 mp3 저장 등) `decodeAudioData`로 폴백한다. `wav-encoder.ts`가 만든 N채널 int32 PCM WAV를 되읽는 것이 1차 목적이다(디코더 소스에 명시).
- `features/audio/types.ts`의 `AnalysisFrame`(캐시 모듈 경유), `shared/lib/utils.ts`의 `cn/formatTime/formatFileSize/downloadBlob`, `shared/types/electron-bridge.d.ts`의 `window.localFolder` 타입.

이 도메인을 가져다 쓰는 모듈 (외부 → workspace):
- `app/layout.tsx` → `WorkspaceProvider`
- `shared/components/Header.tsx` → `WorkspaceDrawer`
- `dashboard/DashboardClient.tsx` → `useWorkspace()`의 `saveCurrent`/`pendingLocalFile`/`clearPendingLocalFile`
- `dashboard/SelectedFilePanel.tsx` → `useWorkspace()`의 `setOpen`

주요 흐름:
```
[저장]  DashboardClient(저장 버튼) → saveCurrent(SaveWorkspaceInput)
        → saveWorkspaceItem(IndexedDB) → refresh() → setOpen(true) (드로어 자동 열림)

[폴더 로드]  FolderFileList 클릭
        Electron: loadLocalFile → readLocalAudioFile(IPC) → File ┐
        웹:       loadBrowserFile → 보관 중인 File 그대로       ┴→ onFileLoad
        → pendingLocalFile/activeFileName 갱신
        → DashboardClient useEffect가 소비 → handleFileSelected(File) → clearPendingLocalFile()

[채널 뷰]  WorkspaceItemRow "채널" → ChannelViewerOverlay
        → getWorkspacePayload(item.id) → payload.audioBlob
        → decodeAudioChannels() → 채널별 Float32Array → 캔버스 엔벨로프 + peak/RMS
```

## 5. 주요 인터페이스 / 진입점
- `WorkspaceProvider({ children })` — Context 공급자. `app/layout.tsx`에서 1회 마운트한다. 이 바깥에서 `useWorkspace()`를 부르면 throw.
- `useWorkspace(): WorkspaceCtx` — 도메인 밖에서 쓰는 유일한 훅. 주요 필드:
  - `saveCurrent(input: SaveWorkspaceInput): Promise<void>` — 세션 저장. 프레임은 저장 시 차트 렌더 필드만 남긴다(캐시는 표시용이라는 프로젝트 규칙과 동일). 저장 후 드로어가 자동으로 열린다.
  - `rename(id, name)` / `remove(id)` — 항목 이름 변경/삭제(meta+payload 동시 삭제).
  - `exportJson(meta)` / `exportCsv(meta)` / `downloadAudio(meta)` — 브라우저 다운로드 트리거. `downloadAudio`는 `payload.audioBlob`이 없으면 아무 것도 하지 않는다.
  - `pendingLocalFile: File | null` + `clearPendingLocalFile()` — 폴더에서 고른 파일을 대시보드로 넘기는 다리. 소비자(DashboardClient)가 반드시 clear를 호출해야 재선택이 다음 렌더에 반영된다.
  - `connectLocalFolder()` / `disconnectLocalFolder()` / `loadLocalFile(entry)` — Electron 전용. `window.localFolder`가 없으면 no-op(로드만 에러 메시지 상태로 남는다).
  - `selectBrowserFolder(files)` / `disconnectBrowserFolder()` / `loadBrowserFile(file)` — 웹/모바일 폴더 업로드 경로.
  - `activeFileName: string | null` — 마지막 로드 파일 이름. 폴더 목록의 선택 하이라이트는 파일 이름 문자열 일치로 판정한다.
- `WorkspaceDrawer()` — 트리거 버튼 + 드로어 본체. Header에서 마운트.
- `ChannelViewerOverlay({ item: WorkspaceItemMeta, onClose }: Props)` — 채널별 파형 오버레이. 이탈 시 250ms 전환 후 `onClose()`를 호출한다. 저장된 `audioBlob`이 없으면 "이 세션에는 저장된 오디오가 없습니다."를 표시한다.
- `WorkspaceItemMeta` / `SaveWorkspaceInput` — 타입의 원 정의는 `lib/cache/workspace.ts`이며 이 도메인은 재노출 없이 그대로 import한다.

## 6. 변경 이력(요약)
- 2026-07-09: 최초 작성 (기준 커밋: 1fbbf44, 커밋되지 않은 워크트리 변경 반영)
