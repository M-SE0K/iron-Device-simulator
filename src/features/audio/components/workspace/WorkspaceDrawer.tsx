"use client";

import { memo } from "react";
import { useWorkspace } from "./WorkspaceContext";
import WorkspaceFolderSection from "./WorkspaceFolderSection";
import { useEscapeKey } from "@/shared/hooks/useEscapeKey";
import SideDrawer from "@/shared/components/overlay/SideDrawer";

function WorkspaceDrawer() {
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

// props 없는 드로어 — 갱신은 자체 Context 구독으로만 일어나면 되므로, 캡처 중 대시보드의
// 실시간 프레임 리렌더에 딸려 다시 그려지지 않게 memo로 차단한다.
export default memo(WorkspaceDrawer);
