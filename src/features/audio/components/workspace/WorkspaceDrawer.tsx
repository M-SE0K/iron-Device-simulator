"use client";

import { useWorkspace } from "./WorkspaceContext";
import WorkspaceFolderSection from "./WorkspaceFolderSection";
import { useEscapeKey } from "@/shared/hooks/useEscapeKey";
import SideDrawer from "@/shared/components/overlay/SideDrawer";

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
