"use client";

// 우측 슬라이딩 드로어(사이드바 "Workspace" 내비) — 연결된 폴더의 오디오 파일을
// "폴더 → 파일" 트리로 보여주는 파일 브라우저다(파일 선택 → 분석 로드). 저장된 측정
// 세션의 CRUD/export 는 "측정 기록"(RecordsDrawer)으로 이전됐다.
// 트리거는 Sidebar 가 담당(여기는 패널만).
import { useWorkspace } from "./WorkspaceContext";
import WorkspaceFolderSection from "./WorkspaceFolderSection";
import { useEscapeKey } from "@/shared/hooks/useEscapeKey";
import SideDrawer from "@/shared/components/SideDrawer";

export default function WorkspaceDrawer() {
  const { open, setOpen, localFolderFiles, browserFolderFiles } = useWorkspace();
  // 활성 폴더 소스는 빌드당 하나(Electron localFolder ↔ 브라우저 업로드)라 합계 = 현재 파일 수.
  const fileCount = localFolderFiles.length + browserFolderFiles.length;

  useEscapeKey(() => setOpen(false), open);

  return (
    <SideDrawer
      open={open}
      onClose={() => setOpen(false)}
      ariaLabel="작업 영역"
      title="Workspace"
      count={fileCount}
    >
      <WorkspaceFolderSection />
    </SideDrawer>
  );
}
