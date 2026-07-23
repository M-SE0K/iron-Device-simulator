"use client";

import { memo } from "react";
import { useWorkspace } from "./WorkspaceContext";
import WorkspaceFolderSection from "./WorkspaceFolderSection";
import { useEscapeKey } from "@/shared/hooks/useEscapeKey";
import SideDrawer from "@/shared/components/overlay/SideDrawer";

function WorkspaceDrawer() {
  const { open, setOpen, localFolderFiles, browserFolderFiles } = useWorkspace();
  const fileCount = localFolderFiles.length + browserFolderFiles.length;

  useEscapeKey(() => setOpen(false), open);

  return (
    <SideDrawer
      open={open}
      onClose={() => setOpen(false)}
      ariaLabel="Workspace"
      title="Workspace"
      count={fileCount}
    >
      <WorkspaceFolderSection />
    </SideDrawer>
  );
}

export default memo(WorkspaceDrawer);
